# web-chess — Browser Chess Engine & Training Playground (WIP)

A lightweight chess engine and data lab that runs entirely in the browser. The project explores search heuristics, evaluation design, and a small value network trained from self-labeled positions.

> Status: work in progress. This repository currently has **no license**; please contact me before reuse.

---

## Highlights

- **In-browser engine (JavaScript)**: legal move generation, FEN/SAN, rules, and an interactive board UI.
- **Search**: Alpha–Beta with a transposition table (Zobrist), MVV–LVA capture ordering, killer/history heuristics, quiescence, and optional LMR.
- **Evaluations**
  - **classic**: material + PST + mobility + king-safety (lite);
  - **mlp**: a compact value net exported to JSON for use in the browser.
- **Data tools**: a “Batch Label” panel to create training rows using `classic` (teacher) or `mlp` (student) and export JSONL.
- **Training (Python)**: a minimal script to fit the value net on engine scores; model artifacts are stored alongside the app.

---

## Tech stack

- **Engine/UI**: Vanilla JavaScript, HTML, CSS (no framework required)
- **ML training**: Python, PyTorch
- **Artifacts**: JSONL for datasets, JSON weights for the browser model, `.pt` checkpoints for training

---

## Repository layout

```
├── README.md
├── assets
│   └── chess
│       ├── bishop-b.svg
│       ├── bishop-w.svg
│       ├── king-b.svg
│       ├── king-w.svg
│       ├── knight-b.svg
│       ├── knight-w.svg
│       ├── pawn-b.svg
│       ├── pawn-w.svg
│       ├── queen-b.svg
│       ├── queen-w.svg
│       ├── rook-b.svg
│       └── rook-w.svg
├── index.html
├── src
│   ├── ai
│   │   ├── book.js
│   │   ├── eval.js
│   │   ├── logger.js
│   │   ├── models
│   │   │   ├── mlp_best.pt
│   │   │   ├── mlp_last.pt
│   │   │   └── mlp_square1h.json
│   │   ├── pure.js
│   │   ├── search.js
│   │   ├── training
│   │   │   ├── chess_samples.jsonl
│   │   │   └── train_value.py
│   │   ├── tt.js
│   │   └── zobrist.js
│   ├── board.js
│   ├── fen.js
│   ├── main.js
│   ├── moves.js
│   ├── notation.js
│   ├── pieces.js
│   ├── rules.js
│   └── ui.js
└── styles.css
```

---

## Getting started

No server-side code is required. A tiny static server helps with loading model/data files without CORS issues.

```bash
# Python (built-in)
python3 -m http.server 8000
# then open http://localhost:8000
```

Or, with Node:

```bash
npx http-server -p 8000
```

Open the page, play vs the AI, run self-play, or open the **Batch Label** panel to generate training rows.

---

## Batch Label — baseline settings

These presets generate teacher labels quickly with good quality. Adjust counts to your target size.

### Teacher labels (`Eval = classic`)

- **Opening** — Count **10,000**, Depth **4**, per-pos **200 ms**, plies **6–20**
- **Mid (early)** — Count **15,000**, Depth **4**, per-pos **200 ms**, plies **21–40**
- **Mid (late)** — Count **15,000**, Depth **4**, per-pos **200 ms**, plies **41–70**
- **Late / endgame-ish** — Count **10,000**, Depth **4**, per-pos **250 ms**, plies **71–120**

> If timeouts appear, increase the per-position budget (+50 ms) before lowering depth.
> For a small starter set (~10–12k), scale all counts down proportionally.

### Optional self-distillation (`Eval = mlp`)

Add ~**10,000** extra positions with `Eval=mlp`, Depth **5**, per-pos **120 ms**, plies **10–80**.  
During training, mark these with `label_src=mlp` and give them lower weight.

---

## Label output format (JSONL)

Each labeled position is one line of JSON:

```json
{
  "fen": "r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "stm": "w",
  "score_cp": 34,
  "depth": 4,
  "nodes": 153214,
  "time_ms": 198,
  "ply": 10,
  "label_src": "classic",
  "eval_hash": "classic@d4"
}
```

**Post-processing (recommended):**
- Map mate scores to ±2000, then **clip** to ±1500 centipawns.
- Drop rows with missing `score_cp` (timeouts).
- (Optional) Mirror positions to side-to-move to double the data.

---

## Training the value net (Python)

From `src/ai/training/`:

```bash
python train_value.py \
  --in chess_samples.jsonl \
  --epochs 20 \
  --out ../models/mlp_last.pt
```

Export to browser JSON (example provided: `mlp_square1h.json`) and switch the UI to `mlp` to compare against `classic`.

---

## Notes & caveats

- If “Count = 100” results in ~110 rows, it’s typically augmentation, parallel overshoot, or retry leakage. Prefer to hard-cap writes after the target count.
- Endgame technique is still evolving; SEE and pawn-structure caching are on the roadmap.
- Move-generation has been optimized for pins/checks; performance in self-play is much better than early versions.

---

## Roadmap (indicative)

- Static Exchange Evaluation (SEE) for safer capture/check ordering
- Pawn hash and refined endgame heuristics (passed pawns, rook behind passer)
- Richer features/attack maps for the MLP
- PGN/EPD import and a small test suite
