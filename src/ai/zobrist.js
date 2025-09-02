import { fromIndex, toIndex, files } from "../board.js";

function epFileIndexEffective(state) {
    const ep = state.ep;
    if (typeof ep !== "number") return -1;

    const { r, f } = fromIndex(ep);
    const side = state.turn;                // side to move (the only side that could EP-capture now)
    const dr = (side === "w") ? +1 : -1;    // pawn must sit one rank behind ep square
    for (const nf of [f - 1, f + 1]) {
        if (nf < 0 || nf > 7) continue;
        const sq = toIndex(r + dr, nf);
        const p = state.board[sq];
        if (p && p.c === side && p.t === "P") return f; // at least one EP capture exists
    }
    return -1; // no EP capture available → do not hash EP
}


const MASK64 = 0xFFFFFFFFFFFFFFFFn;
let ZOB = null;
export function initZobrist(random64) {
    if (typeof random64 !== "function") throw new Error("random64 must be a function");
    const first = random64();
    if (typeof first !== "bigint") throw new Error("random64 must return a BigInt");

    const next = ((seed) => {
        let used = false;
        return () => {
            if (!used) { used = true; return seed & MASK64; }
            return random64() & MASK64;
        };
    })(first);

    const pieces = Array.from({ length: 2 }, () =>
        Array.from({ length: 6 }, () =>
            Array.from({ length: 64 }, () => next())
        )
    );
    const castle   = ["K", "Q", "k", "q"].map(() => next());
    const epFile   = Array.from({ length: 8 }, () => next());
    const sideToMove = next();

    ZOB = { pieces, castle, epFile, sideToMove };
}

const TYPE_IDX = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const COLOR_IDX = { w: 0, b: 1 };

function hasCastleRight(castleRight, sym) {
    if (!castleRight) return false;
    return castleRight.includes(sym);
}

export function computeKey(state) {
    if (!ZOB) throw new Error("zobrist: call initZobrist(random64) first");

    let h = 0n;

    // Pieces on squares
    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (!p) continue;
        const ci = COLOR_IDX[p.c];     // 0 for "w", 1 for "b"
        const ti = TYPE_IDX[p.t.toLowerCase()];      // 0..5 for p,n,b,r,q,k
        // (Add checks if you want to catch mistakes early)
        h ^= ZOB.pieces[ci][ti][i];
    }

    // Side to move
    if (state.turn === "b") h ^= ZOB.sideToMove;

    // Castling rights
    if (hasCastleRight(state.castleRight, "K")) h ^= ZOB.castle[0];
    if (hasCastleRight(state.castleRight, "Q")) h ^= ZOB.castle[1];
    if (hasCastleRight(state.castleRight, "k")) h ^= ZOB.castle[2];
    if (hasCastleRight(state.castleRight, "q")) h ^= ZOB.castle[3];

    // En-passant file (only the file matters for hashing)
    const ef = epFileIndexEffective(state);
    if (ef >= 0) h ^= ZOB.epFile[ef];

    return h & MASK64;
}


export function togglePiece(hash, color, type, square) {
    const ci = COLOR_IDX[color];
    const ti = TYPE_IDX[type.toLowerCase()];
    return (hash ^ ZOB.pieces[ci][ti][square]) & MASK64;
}


export function toggleSideToMove(hash) {
    return (hash ^ ZOB.sideToMove) & MASK64;
}

export function toggleCastle(hash, sym) {
    // sym in {"K","Q","k","q"}
    const idx = sym === "K" ? 0 : sym === "Q" ? 1 : sym === "k" ? 2 : sym === "q" ? 3 : -1;
    return idx >= 0 ? (hash ^ ZOB.castle[idx]) & MASK64 : hash;
}

export function toggleEpFile(hash, file) {
    return (file >= 0 && file < 8) ? (hash ^ ZOB.epFile[file]) & MASK64 : hash;
}

// Pretty-print for debugging
export function keyHex(hash) {
    return "0x" + hash.toString(16).padStart(16, "0");
}
