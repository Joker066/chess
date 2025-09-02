// src/ai/tt.js
// Fixed-size transposition table with depth-preferred replacement.
// Key is a BigInt Zobrist from computeKey(state).

export const TT_FLAG = { EXACT: 0, LOWER: 1, UPPER: 2 };

let _mask = (1 << 18) - 1;              // 2^18 = 262,144 slots (tweak with ttInit)
let _table = new Array(_mask + 1);

export function ttInit(sizePow2 = 18) {
    if (sizePow2 < 12) sizePow2 = 12;   // min 4096
    if (sizePow2 > 22) sizePow2 = 22;   // max ~4M
    const size = 1 << sizePow2;
    _mask = size - 1;
    _table = new Array(size);
}

function _indexFor(keyBig) {
    // mix high/low bits for distribution; result -> [0, _mask]
    const x = keyBig ^ (keyBig >> 32n) ^ (keyBig >> 53n);
    return Number(x & BigInt(_mask));
}

export function ttStore(keyBig, depth, flag, score, bestMove) {
    const i = _indexFor(keyBig);
    const e = _table[i];

    // Replace if:
    //  - slot empty
    //  - same key (update)
    //  - deeper search than existing entry
    let shouldReplace = false;
    if (!e) {
        shouldReplace = true;
    }
    else if (e.key !== keyBig) {
        if ((depth | 0) >= (e.depth | 0)) shouldReplace = true;
    }
    else {
        shouldReplace = true;
    }

    if (!shouldReplace) return;

    _table[i] = {
        key: keyBig,
        depth: depth | 0,
        flag,
        score,
        bestMove: bestMove ? [bestMove[0], bestMove[1]] : null
    };
}

export function ttProbe(keyBig, reqDepth = 0) {
    const i = _indexFor(keyBig);
    const e = _table[i];
    if (!e || e.key !== keyBig) return null;

    // If stored depth is sufficient, return full entry (bounds are valid).
    if ((e.depth | 0) >= (reqDepth | 0)) return e;

    // Otherwise, return only a move hint for ordering; no bounds.
    return { bestMove: e.bestMove };
}

export function ttClear() {
    _table.fill(undefined);
}

export function ttSize() {
    return _table.length;
}
