import { fromIndex, toIndex } from "./board.js";

const onBoard = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;

function blocked(state, myColor, i) {
    const q = state.board[i];
    return q && q.c === myColor;
}

function canLand(state, myColor, i) {
    const q = state.board[i];
    return !q || !blocked(state, myColor, i);
}

export function knightMoves(state, i) {
    const p = state.board[i];
    if (!p || p.t !== "N") return [];

    const { r, f } = fromIndex(i);
    const deltas = [
        [-2, -1], [-2, 1],
        [-1, -2], [-1, 2],
        [1, -2], [1, 2],
        [2, -1], [2, 1]
    ];

    const moves = [];
    for (const [dr, df] of deltas) {
        const rr = r + dr, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const idx = toIndex(rr, ff);
        if (canLand(state, p.c, idx)) moves.push(idx);
    }
    return moves;
}

export function bishopMoves(state, i) {
    const p = state.board[i];
    if (!p || p.t !== "B") return [];

    const { r, f } = fromIndex(i);
    const deltas = [
        [1, 1], [1, -1],
        [-1, 1], [-1, -1]
    ];

    const moves = [];
    for (const [dr, df] of deltas) {
        for (let i = 1; i <= 7; i++) {
            const rr = r + dr * i, ff = f + df * i;
            const idx = toIndex(rr, ff);
            if (!onBoard(rr, ff) || blocked(state, p.c, idx)) break;
            if (canLand(state, p.c, idx)) {
                moves.push(idx);
                if (state.board[idx] && state.board[idx].c !== p.c) break;
            }
        }
    }
    return moves;
}

export function rookMoves(state, i) {
    const p = state.board[i];
    if (!p || p.t !== "R") return [];

    const { r, f } = fromIndex(i);
    const deltas = [
        [1, 0], [-1, 0],
        [0, 1], [0, -1]
    ];

    const moves = [];
    for (const [dr, df] of deltas) {
        for (let i = 1; i <= 7; i++) {
            const rr = r + dr * i, ff = f + df * i;
            const idx = toIndex(rr, ff);
            if (!onBoard(rr, ff) || blocked(state, p.c, idx)) break;
            if (canLand(state, p.c, idx)) {
                moves.push(idx);
                if (state.board[idx] && state.board[idx].c !== p.c) break;
            }
        }
    }
    return moves;
}

export function queenMoves(state, i) {
    const p = state.board[i];
    if (!p || p.t !== "Q") return [];

    const { r, f } = fromIndex(i);
    const deltas = [
        [1, 0], [-1, 0],
        [0, 1], [0, -1],
        [1, 1], [1, -1],
        [-1, 1], [-1, -1]
    ];

    const moves = [];
    for (const [dr, df] of deltas) {
        for (let i = 1; i <= 7; i++) {
            const rr = r + dr * i, ff = f + df * i;
            const idx = toIndex(rr, ff);
            if (!onBoard(rr, ff) || blocked(state, p.c, idx)) break;
            if (canLand(state, p.c, idx)) {
                moves.push(idx);
                if (state.board[idx] && state.board[idx].c !== p.c) break;
            }
        }
    }
    return moves;
}

export function kingMoves(state, i) {
    const p = state.board[i];
    if (!p || p.t !== "K") return [];

    const { r, f } = fromIndex(i);
    const deltas = [
        [1, 0], [-1, 0],
        [0, 1], [0, -1],
        [1, 1], [1, -1],
        [-1, 1], [-1, -1]
    ];

    const moves = [];
    for (const [dr, df] of deltas) {
        const rr = r + dr, ff = f + df;
        const idx = toIndex(rr, ff);
        if (!onBoard(rr, ff)) continue;
        if (canLand(state, p.c, idx)) moves.push(idx);
    }

    // castle
    const enemy = p.c === "w" ? "b" : "w";
    const rights = state.castleRight || "";
    const kingStart = (p.c === "w" && r === 7 && f === 4) || (p.c === "b" && r === 0 && f === 4);
    if (!kingStart) return moves;

    const e = toIndex(r, 4);
    const safe = (sq) => !isSquareAttacked(state, sq, enemy);

    if (p.c === "w") {
        // O-O: e1→g1
        if (rights.includes("K")) {
            const f1 = toIndex(7, 5), g1 = toIndex(7, 6), h1 = toIndex(7, 7);
            if (!state.board[f1] && !state.board[g1] &&
                safe(e) && safe(f1) && safe(g1) &&
                state.board[h1]?.t === "R" && state.board[h1]?.c === "w") {
                moves.push(g1);
            }
        }
        // O-O-O: e1→c1
        if (rights.includes("Q")) {
            const d1 = toIndex(7, 3), c1 = toIndex(7, 2), b1 = toIndex(7, 1), a1 = toIndex(7, 0);
            if (!state.board[d1] && !state.board[c1] && !state.board[b1] &&
                safe(e) && safe(d1) && safe(c1) &&
                state.board[a1]?.t === "R" && state.board[a1]?.c === "w") {
                moves.push(c1);
            }
        }
    } 
    else {
        // O-O: e8→g8
        if (rights.includes("k")) {
            const f8 = toIndex(0, 5), g8 = toIndex(0, 6), h8 = toIndex(0, 7);
            if (!state.board[f8] && !state.board[g8] &&
                safe(e) && safe(f8) && safe(g8) &&
                state.board[h8]?.t === "R" && state.board[h8]?.c === "b") {
                moves.push(g8);
            }
        }
        // O-O-O: e8→c8
        if (rights.includes("q")) {
            const d8 = toIndex(0, 3), c8 = toIndex(0, 2), b8 = toIndex(0, 1), a8 = toIndex(0, 0);
            if (!state.board[d8] && !state.board[c8] && !state.board[b8] &&
                safe(e) && safe(d8) && safe(c8) &&
                state.board[a8]?.t === "R" && state.board[a8]?.c === "b") {
                moves.push(c8);
            }
        }    
    }

    return moves;
}

export function pawnMoves(state, i) {
    const p = state.board[i];
    if (!p || p.t !== "P") return [];

    const { r, f } = fromIndex(i);
    const dir = p.c === "w" ? -1 : 1;
    const startRank = p.c === "w" ? 6 : 1;
    const moves = [];

    const r1 = r + dir;
    if (onBoard(r1, f)) {
        const one = toIndex(r1, f);
        if (!state.board[one]) {
            moves.push(one);
            if (r === startRank) {
                const r2 = r + 2 * dir;
                const two = toIndex(r2, f);
                if (!state.board[two]) moves.push(two);
            }
        }
    }

    for (const df of [-1, 1]) {
        const rr = r + dir, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const idx = toIndex(rr, ff);
        const q = state.board[idx];
        if (q && q.c !== p.c) moves.push(idx);
    }

    if (state.ep !== null) {
    const { r: er, f: ef } = fromIndex(state.ep);
        if (er === r + dir && Math.abs(ef - f) === 1) {
            const adj = state.board[toIndex(r, ef)];
            if (adj && adj.t === "P" && adj.c !== p.c) moves.push(state.ep);
        }
    }

    return moves;
}

export function generateMoves(state, i) {
    const p = state.board[i];
    if (!p) return [];
    switch (p.t) {
        case "N": return knightMoves(state, i);
        case "B": return bishopMoves(state, i);
        case "R": return rookMoves(state, i);
        case "Q": return queenMoves(state, i);
        case "K": return kingMoves(state, i);
        case "P": return pawnMoves(state, i);
        default: return [];
    }
}

export function findKing(state, color) {
    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (p && p.c === color && p.t === "K") return i;
    }
    return -1;
}

// square 'idx' attacked by 'color'
export function isSquareAttacked(state, i, color) {
    const { r, f } = fromIndex(i);

    // pawn
    const pdir = color === "w" ? 1 : -1;
    for (const df of [-1, 1]) {
        const rr = r + pdir, ff = f + df;
        if (onBoard(rr, ff)) {
            const q = state.board[toIndex(rr, ff)];
            if (q && q.c === color && q.t === "P") return true;
        }
    }

    // knight
    const kD = [[-2, -1], [-2, 1],[-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (const [dr, df] of kD) {
        const rr = r + dr, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const q = state.board[toIndex(rr, ff)];
        if (q && q.c === color && q.t === "N") return true;
    }

    // bishop/rook/queen
    const dirsDiag = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    const dirsOrtho = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // Diagonals → B/Q
    for (const [dr, df] of dirsDiag) {
        for (let s = 1; s <= 7; s++) {
            const rr = r + dr * s, ff = f + df * s;
            if (!onBoard(rr, ff)) break;
            const q = state.board[toIndex(rr, ff)];
            if (!q) continue;
            if (q.c !== color) break;
            if (q.t === "B" || q.t === "Q") return true;
            else break;
        }
    }
    // Orthogonals → R/Q
    for (const [dr, df] of dirsOrtho) {
        for (let s = 1; s <= 7; s++) {
            const rr = r + dr*s, ff = f + df*s;
            if (!onBoard(rr, ff)) break;
            const q = state.board[toIndex(rr, ff)];
            if (!q) continue;
            if (q.c !== color) break;
            if (q.t === "R" || q.t === "Q") return true;
            else break;
        }
    }

    // King
    for (const [dr, df] of [...dirsDiag, ...dirsOrtho]) {
        const rr = r + dr, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const q = state.board[toIndex(rr, ff)];
        if (q && q.c === color && q.t === "K") return true;
    }

    return false;
}

export function inCheck(state, color) {
    const k = findKing(state, color);
    if (k === -1) return false;
    const enemy = color === "w" ? "b" : "w";
    return isSquareAttacked(state, k, enemy);
}

export function leavesKingInCheck(state, from, to) {
    const mover = state.board[from];
    if (!mover) return false;

    const tmp = { ...state, board: state.board.slice() };
    const fromRF = fromIndex(from), toRF = fromIndex(to);
    const dir = mover.c === "w" ? -1 : 1;

    // en passant 
    const isEP = (mover.t === "P" && to === state.ep && fromRF.f !== toRF.f && !state.board[to]);
    const capturedIdx = isEP ? toIndex(toRF.r - dir, toRF.f) : to;

    tmp.board[capturedIdx] = null;
    tmp.board[to] = mover;
    tmp.board[from] = null;

    return inCheck(tmp, mover.c);
}

export function allLegalMoves(state, color) {
    const moves = [];
    for (let i = 0; i < 64; i++) {
        if (!state.board[i] || state.board[i].c !== color) continue;
        const pseudo = generateMoves(state, i);
        for (let to of pseudo) {
            if (!leavesKingInCheck(state, i, to)) moves.push([i, to]);
        }
    }

    return moves;
}