// Minimal IndexedDB logger (JSONL export)
// API: addSample(state, { bestMove, score_cp, depth })
//      exportJSONL() -> { url, count }
//      clearAll()
//      getCount()

import { toFEN } from "../fen.js";
import { computeKey } from "./zobrist.js";

const DB_NAME = "chess-logger";
const STORE   = "samples";

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
                // Optional: index on zkey if you want DB-side dedup later
                // db.createObjectStore(...).createIndex("zkey", "zkey", { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function addSample(state, { bestMove, score_cp, depth }) {
    // assumes you already dedup in memory — fast and simple
    const rec = {
        fen: toFEN(state),                               // position BEFORE move
        score_cp: Math.trunc(score_cp ?? 0),
        depth: depth | 0,
        from: bestMove?.from ?? null,
        to: bestMove?.to ?? null,
        zkey: "0x" + computeKey(state).toString(16),
        ts: Date.now()
    };
    const db = await openDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.objectStore(STORE).add(rec);
    });
    db.close?.();
}

export async function exportJSONL() {
    const db = await openDB();
    const rows = [];
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        tx.onerror = () => reject(tx.error);
        const st = tx.objectStore(STORE);
        const cur = st.openCursor();
        cur.onerror = () => reject(cur.error);
        cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return resolve();
            rows.push(JSON.stringify(c.value));
            c.continue();
        };
    });
    db.close?.();

    const blob = new Blob([rows.join("\n") + "\n"], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    return { url, count: rows.length };
}

export async function clearAll() {
    const db = await openDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = resolve;
        tx.objectStore(STORE).clear();
    });
    db.close?.();
}

export async function getCount() {
    const db = await openDB();
    const n = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        tx.onerror = () => reject(tx.error);
        const st = tx.objectStore(STORE);
        const req = st.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
    });
    db.close?.();
    return n;
}
