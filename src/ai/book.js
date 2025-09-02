// src/ai/book.js
// Tiny persistent root-book using localStorage.
// Namespaced per eval kind (classic/mlp) via window.chess.lastEvalInfo.

const MAX_ENTRIES = 5000;

function nsKey() {
    try {
        const kind = (window.chess?.lastEvalInfo || "classic");
        return `book:v2:${kind}`;
    }
    catch {
        return "book:v2:classic";
    }
}

function loadMap() {
    try {
        const raw = localStorage.getItem(nsKey());
        if (!raw) return {};
        return JSON.parse(raw) || {};
    }
    catch {
        return {};
    }
}

function saveMap(map) {
    try {
        localStorage.setItem(nsKey(), JSON.stringify(map));
    }
    catch {}
}

export function bookProbe(zhex, minDepth = 0) {
    const map = loadMap();
    const rec = map[zhex];
    if (!rec) return null;
    if ((rec.depth | 0) < (minDepth | 0)) return null;
    return rec;
}

export function bookInsert(zhex, { fen, bestMove, score, depth, eval: evalName }) {
    if (!zhex) return;
    const map = loadMap();
    const prev = map[zhex];

    // keep the deeper record
    if (prev && (prev.depth | 0) >= (depth | 0)) {
        return;
    }

    map[zhex] = {
        fen,
        bestMove,
        score,
        depth: depth | 0,
        eval: evalName || (window.chess?.lastEvalInfo || "classic"),
        ts: Date.now()
    };

    // size control (simple LRU-ish purge)
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (map[a].ts | 0) - (map[b].ts | 0));
        const trim = keys.length - MAX_ENTRIES;
        for (let i = 0; i < trim; i++) delete map[keys[i]];
    }

    saveMap(map);
}