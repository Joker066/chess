import { fromIndex, toIndex, algebraic } from "./board.js";
import { generateMoves, inCheck } from "./moves.js";

export function toSAN(state, from, to) {
    const mover = state.board[from];
    const target = state.board[to] || null;

    const { r: fr, f: ff } = fromIndex(from);
    const { r: tr, f: tf } = fromIndex(to);
    const piece = mover.t;
    const letter = piece === "P" ? "" : piece;

    const isEP = piece === "P" && !target && state.ep === to && ff !== tf;
    const isCapture = !!target || isEP;

    if (mover.t === "K" && Math.abs(tf - ff) === 2) {
        const tmp = { ...state, board: state.board.slice() };
        tmp.board[to] = mover; 
        tmp.board[from] = null;
        const enemy = mover.c === "w" ? "b" : "w";
        const base = tf > ff ? "O-O" : "O-O-O";
        return base + (inCheck(tmp, enemy) ? "+" : "");
    }

    // disambiguation
    let disamb = "";
    if (piece !== "P") {
        const cands = [];
        for (let i = 0; i < 64; i++) {
            if (i === from) continue;
            const q = state.board[i];
            if (!q || q.c !== mover.c || q.t !== piece) continue;
            const m = generateMoves(state, i);
            if (m.includes(to)) cands.push(i);
        }
        if (cands.length > 0) {
            const clashFile = cands.some(i => fromIndex(i).f === ff);
            const clashRank = cands.some(i => fromIndex(i).r === fr);
            if (!clashFile) disamb = "abcdefgh"[ff];
            else if (!clashRank) disamb = String(8 - fr);
            else disamb = "abcdefgh"[ff] + String(8 - fr);
        }
    }

    // pawn capture requires origin file letter
    const pawnCapturePrefix = piece === "P" && isCapture ? "abcdefgh"[ff] : "";

    // promotion (auto-queen)
    const isPromotion = piece === "P" && (tr === 0 || tr === 7);
    const promo = isPromotion ? "=Q" : "";

    // check
    const tmp = { ...state, board: state.board.slice() };
    if (isEP) {
        const dir = mover.c === "w" ? -1 : 1;
        const capIdx = toIndex(tr - dir, tf);
        tmp.board[capIdx] = null;
    }
    tmp.board[to] = mover;
    tmp.board[from] = null;
    if (isPromotion) tmp.board[to] = { ...mover, t: "Q" };

    const enemy = mover.c === "w" ? "b" : "w";
    const plus = inCheck(tmp, enemy) ? "+" : "";

    return `${letter}${disamb}${pawnCapturePrefix}${isCapture ? "x" : ""}${algebraic(to)}${promo}${plus}`;
}
