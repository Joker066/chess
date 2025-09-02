# train_value.py
# Trains a tiny MLP to predict centipawns from SIDE-TO-MOVE POV.
# Feature dim: 6(piece type)*64(board) + 1(tempo) = 385

import argparse
import json
import math
import random
from pathlib import Path
from collections import defaultdict
import hashlib

import torch
import torch.nn as nn
from torch.utils.data import TensorDataset, DataLoader, Subset
import torch.nn.functional as F

# ----------------------- constants -----------------------

INPUT_DIM = 385
CLIP_CP = 1000.0  # label clip in centipawns
PIECE_VALUE = {"P": 0, "N": 1, "B": 2, "R": 3, "Q": 4, "K": 5}

# ----------------------- featurizer -----------------------
def FEN_to_tensor(fen: str) -> torch.Tensor:
    """
    FEN -> torch.FloatTensor[385], piece-major: [P 64][N 64]...[K 64][tempo]
    Values: +1 for white piece, -1 for black piece. Tempo: +1 if 'w' else -1.
    """
    placement, active, *rest = fen.split()
    squares = [[0] * 6 for _ in range(64)]  # per-square 6-dim

    ranks = placement.split("/")
    for r in range(8):
        f = 0
        for ch in ranks[r]:
            if ch.isdigit():
                n = int(ch)
                for _ in range(n):
                    squares[r * 8 + f] = [0] * 6
                    f += 1
            else:
                one = [0] * 6
                k = PIECE_VALUE.get(ch.upper(), None)
                if k is None:
                    continue
                one[k] = 1 if ch.isupper() else -1
                squares[r * 8 + f] = one
                f += 1
        assert f == 8, f"Rank {r} has {f} files (expected 8)"

    x = [0.0] * 385
    for i in range(64):
        for j in range(6):
            x[j * 64 + i] = float(squares[i][j])
    x[384] = 1.0 if active == "w" else -1.0

    return torch.tensor(x, dtype=torch.float32)

def colorswap_fen(fen: str) -> str:
    placement, active, rights, ep, half, full = fen.split()
    placement_sw = ''.join(ch.swapcase() if ch.isalpha() else ch for ch in placement)
    active_sw = 'b' if active == 'w' else 'w'
    rights_sw = rights.translate(str.maketrans('KQkq', 'kqKQ')) if rights != '-' else '-'
    ep_sw = '-'  # keep simple; EP not used in features
    return f"{placement_sw} {active_sw} {rights_sw} {ep_sw} {half} {full}"

def augment_colorswap(rows):
    aug = []
    for r in rows:
        fen_sw = colorswap_fen(r["fen"])
        aug.append({"fen": fen_sw, "score_cp": -float(r["score_cp"]), "depth": r.get("depth", 0), **({"pair_key": r.get("pair_key")} if "pair_key" in r else {})})
    return rows + aug

# ----------------------- grouping for pair-safe split -----------------------
def colorless_fen_key(fen: str) -> str:
    """
    Collapse a FEN to a color-agnostic key:
      - Uppercase every piece letter (so white/black map together)
      - Force side-to-move to '-' (ignored)
      - Normalize castling letters to uppercase; ignore EP square
    """
    parts = fen.split()
    if len(parts) < 4:
        return fen.upper()
    board, _stm, castling, _ep = parts[0], parts[1], parts[2], parts[3]
    board_up = board.upper()
    castling_norm = '-' if castling == '-' else castling.upper()
    return f"{board_up} - {castling_norm} -"

def robust_pair_key(row: dict) -> str:
    """
    Prefer explicit pair_key if present; else use colorless FEN;
    else hash a feature signature as a last resort.
    """
    if 'pair_key' in row and row['pair_key']:
        return str(row['pair_key'])
    if 'fen' in row and row['fen']:
        return colorless_fen_key(row['fen'])
    sig = json.dumps(row.get('features', []), separators=(',', ':'), ensure_ascii=False)[:512]
    return hashlib.sha1(sig.encode('utf-8')).hexdigest()

def groupwise_split(rows, val_frac=0.1, seed=42):
    """
    Split indices by grouping on robust_pair_key.
    Returns (train_idx, val_idx, n_groups).
    """
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        groups[robust_pair_key(r)].append(i)
    keys = list(groups.keys())
    rnd = random.Random(seed)
    rnd.shuffle(keys)
    cutoff = int(len(keys) * val_frac)
    val_keys = set(keys[:cutoff])
    train_idx, val_idx = [], []
    for k, idxs in groups.items():
        (val_idx if k in val_keys else train_idx).extend(idxs)
    return train_idx, val_idx, len(groups)

# ----------------------- data loading / filtering / capping -----------------------
def load_jsonl(path: str, min_depth: int = 2):
    """
    Loads JSONL rows with at least: { "fen": str, "score_cp": number, "depth": int, ... }.
    Assumes 'score_cp' is already SIDE-TO-MOVE POV in the dataset. No flipping here.
    Filters out rows with depth < min_depth and non-finite scores.
    """
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                d = json.loads(s)
            except json.JSONDecodeError:
                continue

            fen = d.get("fen")
            sc = d.get("score_cp")
            depth = int(d.get("depth", 0))

            if fen is None or sc is None:
                continue
            if depth < min_depth:
                continue

            try:
                sc = float(sc)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(sc):
                continue

            row = {"fen": fen, "score_cp": sc, "depth": depth}
            if 'pair_key' in d:
                row["pair_key"] = d["pair_key"]
            rows.append(row)

    print(f"rows: {len(rows)} (min_depth={min_depth}, pov=side-to-move)")
    return rows

def filter_rows(rows, max_abs_cp: float = 3000.0, train_min_depth: int | None = None):
    """
    Extra filtering after augmentation:
      - drop |score_cp| > max_abs_cp
      - (optional) enforce train_min_depth again (usually redundant)
    """
    out = []
    for r in rows:
        sc = float(r["score_cp"])
        if abs(sc) > max_abs_cp:
            continue
        if train_min_depth is not None and int(r.get("depth", 0)) < train_min_depth:
            continue
        out.append(r)
    return out

def cap_by_groups(rows, cap_rows: int, seed: int = 0):
    """
    Cap the dataset by sampling whole groups (pair-safe) until ~cap_rows.
    """
    if cap_rows <= 0 or len(rows) <= cap_rows:
        return rows
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        groups[robust_pair_key(r)].append(r)
    keys = list(groups.keys())
    rnd = random.Random(seed)
    rnd.shuffle(keys)
    selected = []
    for k in keys:
        g = groups[k]
        if len(selected) + len(g) > cap_rows and len(selected) > 0:
            continue
        selected.extend(g)
        if len(selected) >= cap_rows:
            break
    return selected[:cap_rows]

# ----------------------- tensors / loaders -----------------------
def build_tensors(rows):
    X_list, y_list, d_list = [], [], []
    for r in rows:
        fen = r["fen"]
        cp = float(r["score_cp"])
        cp = max(-CLIP_CP, min(CLIP_CP, cp))   # clip
        y_list.append(cp / CLIP_CP)            # scale to [-1, 1]
        X_list.append(FEN_to_tensor(fen))
        d_list.append(int(r.get("depth", 0)))

    if not X_list:
        raise ValueError("no rows after filtering")

    X = torch.stack(X_list, dim=0)                               # [N, 385]
    y = torch.tensor(y_list, dtype=torch.float32).unsqueeze(1)   # [N, 1]
    d = torch.tensor(d_list, dtype=torch.float32).unsqueeze(1)   # [N,1]
    print("X, y, d shapes:", tuple(X.shape), tuple(y.shape), tuple(d.shape))
    return X, y, d

def make_loaders(X, y, d, batch=1024, train_idx=None, val_idx=None):
    ds = TensorDataset(X, y, d)
    if train_idx is None or val_idx is None:
        idx = list(range(len(ds)))
        random.Random(0).shuffle(idx)
        k = int(len(ds) * 0.9)
        train_idx, val_idx = idx[:k], idx[k:]
    tr = DataLoader(Subset(ds, train_idx), batch_size=batch, shuffle=True)
    va = DataLoader(Subset(ds, val_idx), batch_size=batch, shuffle=False)
    return tr, va

def summarize_rows(rows, title="summary"):
    import numpy as np, collections
    ds = [float(r["score_cp"]) for r in rows]
    depths = [int(r.get("depth", 0)) for r in rows]
    print(f"{title}: N=", len(rows))
    if not ds:
        return
    arr = np.array(ds, dtype=np.float32)
    print("  score_cp mean/std:", float(arr.mean()), float(arr.std()))
    for q in [0, 10, 25, 50, 75, 90, 95, 99]:
        print(f"  p{q:02d}:", float(np.percentile(arr, q)))
    cnt = collections.Counter(depths)
    print("  depth hist (top):", cnt.most_common(10))

# ----------------------- model -----------------------
class TinyMLP(nn.Module):
    def __init__(self, hidden=256, dropout=0.0):
        super().__init__()
        self.l1 = nn.Linear(INPUT_DIM, hidden)
        self.drop = nn.Dropout(p=float(dropout)) if dropout and dropout > 0 else nn.Identity()
        self.act = nn.ReLU()
        self.l2 = nn.Linear(hidden, 1)
        nn.init.kaiming_uniform_(self.l1.weight, nonlinearity="relu")
        nn.init.zeros_(self.l1.bias)
        nn.init.kaiming_uniform_(self.l2.weight, nonlinearity="linear")
        nn.init.zeros_(self.l2.bias)

    def forward(self, x):
        return self.l2(self.act(self.drop(self.l1(x))))

# ----------------------- training -----------------------
def train_loop(model, tr_loader, va_loader, epochs=5, lr=1e-3, clip=1.0,
               save_path="mlp_best.pt", weight_decay=1e-3, depth_weight=0.4):
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=weight_decay)
    # Older PyTorch: no 'verbose' arg — we’ll print LR changes ourselves.
    sched = torch.optim.lr_scheduler.ReduceLROnPlateau(
        opt, mode="min", factor=0.5, patience=3, min_lr=2e-4
    )

    best = float("inf")
    no_improve = 0

    for e in range(1, epochs + 1):
        # ---- train
        model.train()
        tot = 0.0; n = 0
        for Xb, yb, db in tr_loader:
            opt.zero_grad()
            pred = model(Xb)

            # per-sample SmoothL1 (Huber) then weight by depth
            loss_each = F.smooth_l1_loss(pred, yb, beta=0.5, reduction='none')  # [B,1]
            w = (1.0 + float(depth_weight) * torch.clamp(db, 0, 5)).clamp(1.0, 3.5)  # [B,1]
            loss = (loss_each * w).mean()

            loss.backward()
            if clip:
                nn.utils.clip_grad_norm_(model.parameters(), clip)
            opt.step()
            bs = Xb.size(0); tot += loss.item() * bs; n += bs
        tr_loss = tot / max(1, n)

        # ---- val (unweighted reporting)
        model.eval()
        with torch.no_grad():
            tot = 0.0; n = 0; mae_cp_sum = 0.0
            for Xb, yb, db in va_loader:
                pred = model(Xb)
                loss = F.smooth_l1_loss(pred, yb, beta=0.5, reduction='mean')
                bs = Xb.size(0)
                tot += loss.item() * bs; n += bs
                mae_cp_sum += (pred - yb).abs().sum().item() * CLIP_CP
            va_loss = tot / max(1, n)
            mae_cp = mae_cp_sum / max(1, n)

        # step scheduler FIRST so printed LR reflects any change
        prev_lr = opt.param_groups[0]['lr']
        sched.step(va_loss)
        new_lr = opt.param_groups[0]['lr']
        lr_note = "" if new_lr == prev_lr else f"  |  lr {prev_lr:.2e} → {new_lr:.2e}"

        print(f"epoch {e:02d}  train {tr_loss:.4f}  val {va_loss:.4f}  |  mae_cp {mae_cp:.0f}{lr_note}")

        if va_loss < best:
            best = va_loss
            save_ckpt(save_path, model, hidden=model.l1.out_features)
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= 6:
                print("early stopping (no val improvement)")
                break

# ----------------------- io helpers -----------------------
def save_ckpt(path, model, hidden, scale_cp=1000):
    torch.save({
        "state_dict": model.state_dict(),
        "hidden": hidden,
        "input_dim": INPUT_DIM,
        "scale_cp": scale_cp,
        "model_pov": "sidemove",   # for reference
    }, path)
    print("saved:", path)

def load_ckpt(path):
    blob = torch.load(path, map_location="cpu")
    m = TinyMLP(hidden=blob["hidden"])
    m.load_state_dict(blob["state_dict"])
    m.eval()
    return m, blob

def export_to_json(model, path="mlp_square1h.json", scale_cp=1000):
    with torch.no_grad():
        W0 = model.l1.weight.cpu().float().tolist()
        b0 = model.l1.bias.cpu().float().tolist()
        W1 = model.l2.weight.cpu().float().tolist()
        b1 = model.l2.bias.cpu().float().tolist()
    blob = {
        "basis": "square1h",
        "activation": "relu",
        "model_pov": "sidemove",
        "layers": [
            {"W": W0, "b": b0},
            {"W": [W1[0]], "b": b1}
        ],
        "scale_cp": scale_cp
    }
    Path(path).write_text(json.dumps(blob))

# ----------------------- main -----------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jsonl", type=str, default="chess_samples.jsonl")
    ap.add_argument("--epochs", type=int, default=16)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--hidden", type=int, default=192)
    ap.add_argument("--dropout", type=float, default=0.10)
    ap.add_argument("--lr", type=float, default=8e-4)
    ap.add_argument("--min_depth", type=int, default=3, help="drop rows with depth < min_depth (pre-augment)")
    ap.add_argument("--train_min_depth", type=int, default=None, help="optional extra depth filter after augment (None=skip)")
    ap.add_argument("--max_abs_cp", type=float, default=3000.0, help="drop rows with |score_cp| > max_abs_cp after augment")
    ap.add_argument("--cap_rows", type=int, default=0, help="cap dataset to this many rows after filtering (0 = no cap)")
    ap.add_argument("--val_frac", type=float, default=0.20, help="validation fraction (groupwise)")
    ap.add_argument("--seed", type=int, default=0, help="random seed")
    ap.add_argument("--weight_decay", type=float, default=1e-3)
    ap.add_argument("--depth_weight", type=float, default=0.5, help="multiplier for depth weighting in loss")
    ap.add_argument("--out_best", type=str, default="../models/mlp_best.pt")
    ap.add_argument("--out_last", type=str, default="../models/mlp_last.pt")
    ap.add_argument("--out_json", type=str, default="../models/mlp_square1h.json")
    args = ap.parse_args()

    torch.manual_seed(args.seed); random.seed(args.seed)

    # Load (pre-filter by min_depth)
    rows = load_jsonl(args.jsonl, min_depth=args.min_depth)
    print("NOTE: rows loaded BEFORE color-aug:", len(rows))

    # Augment (color-swap)
    rows = augment_colorswap(rows)
    print("NOTE: rows AFTER color-aug:", len(rows))
    summarize_rows(rows, title="summary (post-augment, pre-filter)")

    if not rows:
        raise SystemExit("No usable rows after load/augment. Check min_depth / file contents.")

    # Post-augment filtering: drop extreme labels; optional extra depth gate
    rows = filter_rows(rows, max_abs_cp=args.max_abs_cp, train_min_depth=args.train_min_depth)
    print("NOTE: rows AFTER post-augment filters:", len(rows))

    # Optional cap (pair-safe by groups)
    if args.cap_rows and args.cap_rows > 0:
        rows = cap_by_groups(rows, cap_rows=args.cap_rows, seed=args.seed)
        print(f"NOTE: rows AFTER capping to {args.cap_rows} (by groups):", len(rows))

    summarize_rows(rows, title="summary (final train set)")

    # Pair-safe split by colorless FEN (or explicit pair_key if present)
    train_idx, val_idx, n_groups = groupwise_split(rows, val_frac=args.val_frac, seed=args.seed)
    print(f"[split] rows={len(rows)} groups={n_groups} train={len(train_idx)} "
          f"val={len(val_idx)} val_frac≈{len(val_idx)/max(1,len(rows)):.3f}")

    # Build tensors/loaders
    X, y, d = build_tensors(rows)
    tr_loader, va_loader = make_loaders(X, y, d, batch=args.batch, train_idx=train_idx, val_idx=val_idx)

    # Model + train
    model = TinyMLP(args.hidden, dropout=args.dropout)
    print("starting training…")
    train_loop(model, tr_loader, va_loader,
               epochs=args.epochs, lr=args.lr, clip=1.0,
               save_path=args.out_best, weight_decay=args.weight_decay, depth_weight=args.depth_weight)

    # also save last-epoch
    save_ckpt(args.out_last, model, hidden=args.hidden)

    # reload BEST and export JSON (side-to-move POV)
    best_model, _ = load_ckpt(args.out_best)
    export_to_json(best_model, args.out_json, scale_cp=int(CLIP_CP))

if __name__ == "__main__":
    main()
