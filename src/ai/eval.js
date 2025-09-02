// src/ai/eval.js
import { allLegalMoves } from "../moves.js";

// ─────────────────────────────────────────────────────────────────────────────
// Classic eval (material + PST + simple mobility + tempo), returns WHITE-POV.
// ─────────────────────────────────────────────────────────────────────────────
const VAL = { P:100, N:320, B:330, R:500, Q:900, K:0 };

const PST_P = [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0
];
const PST_N = [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50
];
const PST_B = [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20
];
const PST_R = [
     0,  0,  0,  5,  5,  0,  0,  0,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     5, 10, 10, 10, 10, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0
];
const PST_Q = [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20
];
const PST_K = [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20
];
const PST = { P:PST_P, N:PST_N, B:PST_B, R:PST_R, Q:PST_Q, K:PST_K };

function mirrorForBlack(sq) {
    const r = Math.floor(sq / 8), f = sq % 8;
    return (7 - r) * 8 + f;
}

export function classicEval(state) {
    let score = 0, wB = 0, bB = 0;

    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (!p) continue;
        const t = (p.t || "").toUpperCase();
        const v = VAL[t] || 0;
        const idx = p.c === "w" ? i : mirrorForBlack(i);
        const pst = PST[t] ? PST[t][idx] : 0;
        const s = v + pst;
        if (p.c === "w") score += s; else score -= s;
        if (t === "B") (p.c === "w" ? wB++ : bB++);
    }

    if (wB >= 2) score += 30;
    if (bB >= 2) score -= 30;

    const wMob = allLegalMoves(state, "w").length;
    const bMob = allLegalMoves(state, "b").length;
    score += 2 * (wMob - bMob);

    score += state.turn === "w" ? 8 : -8;
    return score; // WHITE-POV
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal MLP (assumes model_pov typically "sidemove"); convert to WHITE-POV.
// Optimized: build 385-dim features directly from state (no FEN stringify).
// ─────────────────────────────────────────────────────────────────────────────
const MODEL_URL = new URL('./models/mlp_square1h.json', import.meta.url)
const PIECE_INDEX = { P:0, N:1, B:2, R:3, Q:4, K:5 };

function featuresFromState(state) {
    const x = new Float32Array(385);
    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (!p) continue;
        const t = PIECE_INDEX[(p.t || "").toUpperCase()];
        if (t == null) continue;
        x[t * 64 + i] = (p.c === "w") ? 1 : -1;
    }
    x[384] = (state.turn === "w") ? 1 : -1; // tempo
    return x;
}

function reluInPlace(v) {
    for (let i = 0; i < v.length; i++) if (v[i] < 0) v[i] = 0;
    return v;
}

function matvec(W, x, b) {
    const rows = W.length, y = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
        let s = b ? b[r] : 0;
        const Wr = W[r];
        for (let c = 0; c < x.length; c++) s += Wr[c] * x[c];
        y[r] = s;
    }
    return y;
}

function buildMlpWhitePOV(blob) {
    const layers = blob.layers || [];
    if (layers.length !== 2) {
        throw new Error("Expected layers=[L0,L1] for 1-hidden MLP");
    }

    const L0 = layers[0];
    const L1 = layers[1];
    const scale = blob.scale_cp || 1000;
    const pov = (blob.model_pov || "sidemove").toLowerCase();

    function rawCP(state) {
        const x = featuresFromState(state);
        const h = reluInPlace(matvec(L0.W, x, L0.b));
        // L1.W is 1×H; do matvec then take y[0]
        const y = matvec(L1.W, h, L1.b);
        return y[0] * scale;
    }

    const evalFn = (state) => {
        if (pov === "sidemove") {
            const stm = rawCP(state);
            return (state.turn === "w") ? stm : -stm; // STM → WHITE-POV
        }
        else {
            return rawCP(state); // already WHITE-POV
        }
    };

    return { evalFn, info: { kind: "mlp", model_pov: pov, hidden: L0.W.length, scale_cp: scale } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export async function getEval({ mode = "mlp", url } = {}) {
    if (mode === "classic") {
        return { evalFn: classicEval, info: { kind: "classic", model_pov: "white" } };
    }
    if (mode !== "mlp") {
        throw new Error("unknown mode: " + mode);
    }

    const src = url || MODEL_URL;
    let blob;
    try {
        const res = await fetch(src, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blob = await res.json();
    }
    catch (_e) {
        // graceful fallback
        return { evalFn: classicEval, info: { kind: "classic_fallback", model_pov: "white" } };
    }
    return buildMlpWhitePOV(blob);
}
