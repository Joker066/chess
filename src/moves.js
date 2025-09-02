// Key ideas:
// 1) Keep pseudo-move generators, but cut legality checks aggressively.
// 2) Use do/undo for leavesKingInCheck (no array cloning per move).
// 3) Detect checks once; handle double/single-check fast.
// 4) **Ray-restricted pinned moves** (use pin direction, not just colinearity).
// 5) Avoid re-scanning for the king inside leavesKingInCheck by passing a known kingSq.

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

// ─────────────────────────────────────────────────────────────────────────────
// PSEUDO MOVE GENERATORS (light micro-optimizations)
// ─────────────────────────────────────────────────────────────────────────────
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
        for (let s = 1; s <= 7; s++) {
            const rr = r + dr * s, ff = f + df * s;
            if (!onBoard(rr, ff)) break;
            const idx = toIndex(rr, ff);
            if (blocked(state, p.c, idx)) break;
            moves.push(idx);
            if (state.board[idx]) break; // stop on capture
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
        for (let s = 1; s <= 7; s++) {
            const rr = r + dr * s, ff = f + df * s;
            if (!onBoard(rr, ff)) break;
            const idx = toIndex(rr, ff);
            if (blocked(state, p.c, idx)) break;
            moves.push(idx);
            if (state.board[idx]) break; // stop on capture
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
        for (let s = 1; s <= 7; s++) {
            const rr = r + dr * s, ff = f + df * s;
            if (!onBoard(rr, ff)) break;
            const idx = toIndex(rr, ff);
            if (blocked(state, p.c, idx)) break;
            moves.push(idx);
            if (state.board[idx]) break; // stop on capture
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
        if (!onBoard(rr, ff)) continue;
        const idx = toIndex(rr, ff);
        if (canLand(state, p.c, idx)) moves.push(idx); // king safety filtered later
    }

    // castling (checks are handled with attack test on current board)
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
            if (!state.board[f1] && !state.board[g1] && safe(e) && safe(f1) && safe(g1) && state.board[h1]?.t === "R" && state.board[h1]?.c === "w") {
                moves.push(g1);
            }
        }
        // O-O-O: e1→c1
        if (rights.includes("Q")) {
            const d1 = toIndex(7, 3), c1 = toIndex(7, 2), b1 = toIndex(7, 1), a1 = toIndex(7, 0);
            if (!state.board[d1] && !state.board[c1] && !state.board[b1] && safe(e) && safe(d1) && safe(c1) && state.board[a1]?.t === "R" && state.board[a1]?.c === "w") {
                moves.push(c1);
            }
        }
    }
    else {
        // O-O: e8→g8
        if (rights.includes("k")) {
            const f8 = toIndex(0, 5), g8 = toIndex(0, 6), h8 = toIndex(0, 7);
            if (!state.board[f8] && !state.board[g8] && safe(e) && safe(f8) && safe(g8) && state.board[h8]?.t === "R" && state.board[h8]?.c === "b") {
                moves.push(g8);
            }
        }
        // O-O-O: e8→c8
        if (rights.includes("q")) {
            const d8 = toIndex(0, 3), c8 = toIndex(0, 2), b8 = toIndex(0, 1), a8 = toIndex(0, 0);
            if (!state.board[d8] && !state.board[c8] && !state.board[b8] && safe(e) && safe(d8) && safe(c8) && state.board[a8]?.t === "R" && state.board[a8]?.c === "b") {
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

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK / CHECK HELPERS
// ─────────────────────────────────────────────────────────────────────────────
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

    // bishop/rook/queen rays
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
            break;
        }
    }
    // Orthogonals → R/Q
    for (const [dr, df] of dirsOrtho) {
        for (let s = 1; s <= 7; s++) {
            const rr = r + dr * s, ff = f + df * s;
            if (!onBoard(rr, ff)) break;
            const q = state.board[toIndex(rr, ff)];
            if (!q) continue;
            if (q.c !== color) break;
            if (q.t === "R" || q.t === "Q") return true;
            break;
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

// Collect attackers (indices) to a square and, if the attacker is a slider,
// also return the squares between (for block moves).
function attackersToSquare(state, sq, color) {
    const out = [];
    const betweenSets = [];
    const { r, f } = fromIndex(sq);

    // pawns
    const pdir = color === "w" ? 1 : -1;
    for (const df of [-1, 1]) {
        const rr = r + pdir, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const idx = toIndex(rr, ff);
        const q = state.board[idx];
        if (q && q.c === color && q.t === "P") {
            out.push(idx);
            betweenSets.push(null);
        }
    }

    // knights
    const kD = [[-2, -1], [-2, 1],[-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (const [dr, df] of kD) {
        const rr = r + dr, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const idx = toIndex(rr, ff);
        const q = state.board[idx];
        if (q && q.c === color && q.t === "N") {
            out.push(idx);
            betweenSets.push(null);
        }
    }

    // rays
    const dirs = [
        [1, 0, "R"], [-1, 0, "R"], [0, 1, "R"], [0, -1, "R"],
        [1, 1, "B"], [1, -1, "B"], [-1, 1, "B"], [-1, -1, "B"]
    ];
    for (const [dr, df, kind] of dirs) {
        const between = new Set();
        for (let s = 1; s <= 7; s++) {
            const rr = r + dr * s, ff = f + df * s;
            if (!onBoard(rr, ff)) break;
            const idx = toIndex(rr, ff);
            const q = state.board[idx];
            if (!q) {
                between.add(idx);
                continue;
            }
            if (q.c !== color) break;
            if ((kind === "R" && (q.t === "R" || q.t === "Q")) || (kind === "B" && (q.t === "B" || q.t === "Q"))) {
                out.push(idx);
                betweenSets.push(between);
            }
            break;
        }
    }

    // king (adjacent, no blocks)
    const kDirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    for (const [dr, df] of kDirs) {
        const rr = r + dr, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const idx = toIndex(rr, ff);
        const q = state.board[idx];
        if (q && q.c === color && q.t === "K") {
            out.push(idx);
            betweenSets.push(null);
        }
    }

    return { attackers: out, betweenSets };
}

function normalize(dr, df) {
    return [Math.sign(dr), Math.sign(df)];
}

// Compute pin map: fromIdx -> unit direction (dr, df) of the pin ray
function computePins(state, color, kingSq) {
    const pins = new Map();
    const { r: kr, f: kf } = fromIndex(kingSq);
    const dirs = [
        [1, 0, "R"], [-1, 0, "R"], [0, 1, "R"], [0, -1, "R"],
        [1, 1, "B"], [1, -1, "B"], [-1, 1, "B"], [-1, -1, "B"]
    ];
    const enemy = color === "w" ? "b" : "w";

    for (const [dr, df, kind] of dirs) {
        let allySq = -1;
        for (let s = 1; s <= 7; s++) {
            const rr = kr + dr * s, ff = kf + df * s;
            if (!onBoard(rr, ff)) break;
            const idx = toIndex(rr, ff);
            const q = state.board[idx];
            if (!q) continue;
            if (q.c === color) {
                if (allySq === -1) {
                    allySq = idx;
                }
                else {
                    break; // two allies block, no pin on this ray
                }
            }
            else {
                // first enemy behind optional single ally
                if (allySq !== -1) {
                    const t = q.t;
                    if ((kind === "R" && (t === "R" || t === "Q")) || (kind === "B" && (t === "B" || t === "Q"))) {
                        const [udr, udf] = normalize(dr, df);
                        pins.set(allySq, { dr: udr, df: udf });
                    }
                }
                break;
            }
        }
    }

    return pins;
}

function alongRay(from, to, dr, df) {
    // allow movement along +ray or -ray direction only
    const { r: fr, f: ff } = fromIndex(from);
    const { r: tr, f: tf } = fromIndex(to);
    const dR = tr - fr, dF = tf - ff;

    if (dr === 0 && df === 0) return false;

    if (dr === 0) {
        if (dR !== 0) return false;
        const sF = Math.sign(dF);
        return sF === df || sF === -df;
    }
    else if (df === 0) {
        if (dF !== 0) return false;
        const sR = Math.sign(dR);
        return sR === dr || sR === -dr;
    }
    else {
        if (Math.abs(dR) !== Math.abs(dF)) return false;
        const sR = Math.sign(dR), sF = Math.sign(dF);
        const ok = (sR === dr && sF === df) || (sR === -dr && sF === -df);
        return ok;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FAST leavesKingInCheck via do/undo (no array cloning per move)
// Optional 4th arg: knownKingSq for the mover's color to avoid scanning.
// ─────────────────────────────────────────────────────────────────────────────
export function leavesKingInCheck(state, from, to, knownKingSq = null) {
    const mover = state.board[from];
    if (!mover) return false;

    const fromRF = fromIndex(from), toRF = fromIndex(to);
    const dir = mover.c === "w" ? -1 : 1;

    // Save original pieces
    const savedFrom = mover;
    const savedTo = state.board[to];

    // en passant capture target index/piece (if any)
    let epCapIdx = -1;
    let epCapSaved = null;
    const isEP = (mover.t === "P" && to === state.ep && fromRF.f !== toRF.f && !savedTo);
    if (isEP) {
        epCapIdx = toIndex(toRF.r - dir, toRF.f);
        epCapSaved = state.board[epCapIdx];
    }

    // do move
    if (epCapIdx !== -1) state.board[epCapIdx] = null;
    state.board[to] = savedFrom;
    state.board[from] = null;

    const color = mover.c;
    const enemy = color === "w" ? "b" : "w";
    const kingSq = (mover.t === "K") ? to : (knownKingSq != null ? knownKingSq : findKing(state, color));
    const illegal = isSquareAttacked(state, kingSq, enemy);

    // undo move
    state.board[from] = savedFrom;
    state.board[to] = savedTo;
    if (epCapIdx !== -1) state.board[epCapIdx] = epCapSaved;

    return illegal;
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL LEGAL MOVES — prunes by check state and pins before do/undo filtering
// ─────────────────────────────────────────────────────────────────────────────
export function allLegalMoves(state, color) {
    const moves = [];
    const kingSq = findKing(state, color);
    if (kingSq === -1) return moves; // no king (should not happen)

    const enemy = color === "w" ? "b" : "w";
    const { attackers, betweenSets } = attackersToSquare(state, kingSq, enemy);

    // Double check → only king moves
    if (attackers.length >= 2) {
        for (let i = 0; i < 64; i++) {
            const p = state.board[i];
            if (!p || p.c !== color || p.t !== "K") continue;
            const pseudo = kingMoves(state, i);
            for (const to of pseudo) {
                if (!leavesKingInCheck(state, i, to, kingSq)) moves.push([i, to]);
            }
            break;
        }
        return moves;
    }

    // Single check → capture checker or block, or king moves
    let blockSquares = null;
    let checkerSq = -1;
    if (attackers.length === 1) {
        checkerSq = attackers[0];
        const between = betweenSets[0];
        if (between && between.size) blockSquares = between; // only sliders have blocks
    }

    // Precompute ray pins
    const pins = computePins(state, color, kingSq);

    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (!p || p.c !== color) continue;
        const pseudo = generateMoves(state, i);

        const isKing = p.t === "K";
        const pinDir = pins.get(i) || null;

        for (const to of pseudo) {
            // If in single check, non-king moves must capture checker or block
            if (attackers.length === 1 && !isKing) {
                if (to !== checkerSq && !(blockSquares && blockSquares.has(to))) continue;
            }

            // Pinned piece: restrict to the pin ray (towards/away from king)
            if (!isKing && pinDir) {
                if (!alongRay(i, to, pinDir.dr, pinDir.df)) continue;
            }

            if (!leavesKingInCheck(state, i, to, kingSq)) moves.push([i, to]);
        }
    }

    return moves;
}
