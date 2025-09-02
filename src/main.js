// src/main.js  (drop-in replacement)
// Additions:
//  - Stricter logger (skips non-finite scores)
//  - minLoggedDepth control
//  - Better position quality filter
//  - Extra draw rules: 50-move & insufficient material
//  - Stores lastEvalInfo so book.js namespaces per-eval

import { makeInitialBoard, fromIndex, toIndex } from "./board.js";
import { pieceImagePath, pieceAlt } from "./pieces.js";
import { generateMoves, findKing, inCheck, leavesKingInCheck, allLegalMoves } from "./moves.js";
import { toSAN } from "./notation.js";
import { toFEN, loadFEN } from "./fen.js";
import { removeCastleRight } from "./rules.js";
import { initZobrist, computeKey } from "./ai/zobrist.js";
import { addSample, exportJSONL, clearAll, getCount } from "./ai/logger.js";
import { cloneState, applyMovePure } from "./ai/pure.js";

const state = { turn: "w", board: makeInitialBoard() };
state.selected = null;
state.targets = [];
state.history = [];
state.ep = null;
state.castleRight = "KQkq";
state.gameOver = false;
state.result = "";
state.pov = "w";
state.halfmove = 0;
state.fullmove = 1;
state.posKeys = [];

const $id = (id) => document.getElementById(id);
const viewToModel = (i) => (state.pov === "w" ? i : 63 - i);

// ---------- selection / rendering ----------

function clearSelection() {
    state.selected = null;
    state.targets = [];
    renderBoard();
}

function setSelection(i) {
    if (state.gameOver) return;
    const piece = state.board[i];
    if (!piece) { clearSelection(); return; }
    if (piece.c !== state.turn) { console.log("Not your turn"); return; }

    state.selected = i;
    const pseudo = generateMoves(state, i);
    state.targets = pseudo.filter(to => !leavesKingInCheck(state, i, to));
    renderBoard();
}

function renderTurn() {
    if (state.gameOver) {
        $id("turn").textContent = `Result: ${state.result}`;
    }
    else {
        $id("turn").textContent = state.turn === "w" ? "Turn: White" : "Turn: Black";
    }
}

const isDark = (i) => {
    const { r, f } = fromIndex(i);
    return (r + f) % 2 === 1;
};

function renderHistory() {
    const list = $id("history");
    list.innerHTML = "";
    for (let i = 0; i < state.history.length; i += 2) {
        const li = document.createElement("li");
        const w = state.history[i] || "";
        const b = state.history[i + 1] || "";
        li.textContent = b ? `${w} ${b}` : ` ${w}`;
        list.appendChild(li);
    }
    const shell = list.parentElement;
    if (shell) shell.scrollTop = shell.scrollHeight;
}

function onSquareClick(i) {
    if (state.gameOver) return;
    if (state.selected !== null && state.targets.includes(i)) {
        applyMove(i === state.selected ? state.selected : state.selected, i);
        clearSelection();
    }
    else if (state.selected === i) {
        clearSelection();
    }
    else if (state.board[i]) {
        setSelection(i);
    }
    else {
        clearSelection();
    }
}

function renderBoard() {
    const boardEl = $id("board");
    boardEl.innerHTML = "";
    const checkIdx = inCheck(state, state.turn) ? findKing(state, state.turn) : -1;

    for (let j = 0; j < 64; j++) {
        const i = viewToModel(j);
        const btn = document.createElement("button");
        const dark = isDark(i) ? "dark" : "light";
        const selected = state.selected === i;
        const targeted = state.targets.includes(i);
        const inCheckSquare = i === checkIdx;

        btn.className = `square ${dark}${selected ? " selected" : ""}${targeted ? " target" : ""}${inCheckSquare ? " in-check" : ""}`;
        btn.dataset.index = String(i);

        const piece = state.board[i];
        btn.innerHTML = piece
            ? `<span class="piece"><img class="piece-svg" src="${pieceImagePath(piece)}" alt="${pieceAlt(piece)}"></span>`
            : "";

        if (targeted && !piece) {
            const dot = document.createElement("span");
            dot.className = "hint-dot";
            btn.appendChild(dot);
        }

        btn.addEventListener("click", () => onSquareClick(i));
        boardEl.appendChild(btn);
    }
}

function renderFENBox() {
    const box = $id("fenInput");
    if (!box) return;
    box.value = toFEN(state);
}

// ---------- helpers ----------

function pieceCounts(s) {
    let wp=0, bp=0, wn=0, bn=0, wb=0, bb=0, wr=0, br=0, wq=0, bq=0;
    for (let i = 0; i < 64; i++) {
        const p = s.board[i];
        if (!p) continue;
        const t = (p.t || "").toUpperCase();
        const c = p.c;
        if (t === "P") { c === "w" ? wp++ : bp++; }
        else if (t === "N") { c === "w" ? wn++ : bn++; }
        else if (t === "B") { c === "w" ? wb++ : bb++; }
        else if (t === "R") { c === "w" ? wr++ : br++; }
        else if (t === "Q") { c === "w" ? wq++ : bq++; }
    }
    return { wp,bp,wn,bn,wb,bb,wr,br,wq,bq };
}

function bishopSquareColors(s) {
    const colors = { w: [], b: [] }; // 0 = dark, 1 = light
    for (let i = 0; i < 64; i++) {
        const p = s.board[i];
        if (!p || (p.t || "").toUpperCase() !== "B") continue;
        const r = Math.floor(i / 8), f = i % 8;
        const col = (r + f) & 1;
        colors[p.c].push(col);
    }
    return colors;
}

function insufficientMaterial(s) {
    const c = pieceCounts(s);
    if (c.wp || c.bp || c.wr || c.br || c.wq || c.bq) return false;

    const totalMinors = c.wn + c.bn + c.wb + c.bb;

    // K vs K
    if (totalMinors === 0) return true;

    // K+N vs K or K+B vs K (either side)
    if (totalMinors === 1) return true;

    // K+B vs K+B with bishops on the same color squares
    if (totalMinors === 2 && c.wb <= 1 && c.bb <= 1 && c.wn === 0 && c.bn === 0) {
        const cols = bishopSquareColors(s);
        const all = cols.w.concat(cols.b);
        if (all.length === 2 && all[0] === all[1]) return true;
    }

    // Two knights cannot force mate without help: K+NN vs K is technically draw-ish,
    // but there are edge cases with pawns. We already excluded pawns above, so allow draw.
    if (c.wp === 0 && c.bp === 0 && c.wb === 0 && c.bb === 0 && c.wq === 0 && c.bq === 0 && c.wr === 0 && c.br === 0) {
        if ((c.wn === 2 && c.bn === 0) || (c.bn === 2 && c.wn === 0) || (c.wn === 1 && c.bn === 1)) return true;
    }

    return false;
}

// ---------- game rules application ----------

function applyMove(from, to) {
    const mover = state.board[from];
    if (!mover) return;

    const fromRF = fromIndex(from);
    const toRF = fromIndex(to);
    const dir = mover.c === "w" ? -1 : 1;

    const isCastle = (mover.t === "K" && Math.abs(toRF.f - fromRF.f) === 2);
    const isEP = (mover.t === "P" && to === state.ep && fromRF.f !== toRF.f);
    const isPromotion = (mover.t === "P" && (toRF.r === 0 || toRF.r === 7));

    const capturedIndex = isEP ? toIndex(toRF.r - dir, toRF.f) : to;
    const captured = state.board[capturedIndex] || null;

    if (mover.t === "P" || captured) state.halfmove = 0;
    else state.halfmove += 1;

    const san = toSAN(state, from, to);

    state.board[to] = mover;
    state.board[from] = null;

    if (isEP) state.board[capturedIndex] = null;
    if (isPromotion) state.board[to] = { c: mover.c, t: "Q" };

    if (isCastle) {
        if (mover.c === "w") {
            if (to === toIndex(7, 6)) {
                state.board[toIndex(7, 5)] = state.board[toIndex(7, 7)];
                state.board[toIndex(7, 7)] = null;
            }
            else {
                state.board[toIndex(7, 3)] = state.board[toIndex(7, 0)];
                state.board[toIndex(7, 0)] = null;
            }
            removeCastleRight(state, "K", "Q");
        }
        else {
            if (to === toIndex(0, 6)) {
                state.board[toIndex(0, 5)] = state.board[toIndex(0, 7)];
                state.board[toIndex(0, 7)] = null;
            }
            else {
                state.board[toIndex(0, 3)] = state.board[toIndex(0, 0)];
                state.board[toIndex(0, 0)] = null;
            }
            removeCastleRight(state, "k", "q");
        }
    }

    if (mover.t === "P" && Math.abs(toRF.r - fromRF.r) === 2) {
        state.ep = toIndex((toRF.r + fromRF.r) / 2, fromRF.f);
    }
    else {
        state.ep = null;
    }

    if (mover.t === "K") {
        if (mover.c === "w") { removeCastleRight(state, "K"); removeCastleRight(state, "Q"); }
        else { removeCastleRight(state, "k"); removeCastleRight(state, "q"); }
    }
    if (mover.t === "R") {
        if (from === toIndex(7, 0)) removeCastleRight(state, "Q");
        if (from === toIndex(7, 7)) removeCastleRight(state, "K");
        if (from === toIndex(0, 0)) removeCastleRight(state, "q");
        if (from === toIndex(0, 7)) removeCastleRight(state, "k");
    }
    if (captured && captured.t === "R") {
        if (to === toIndex(7, 0)) removeCastleRight(state, "Q");
        if (to === toIndex(7, 7)) removeCastleRight(state, "K");
        if (to === toIndex(0, 0)) removeCastleRight(state, "q");
        if (to === toIndex(0, 7)) removeCastleRight(state, "k");
    }

    state.history.push(san);
    state.turn = state.turn === "w" ? "b" : "w";
    if (state.turn === "w") state.fullmove += 1;

    const keyNow = computeKey(state);
    state.posKeys.push(keyNow);

    // automatic draw checks (before legal move gen)
    if (state.halfmove >= 100) {
        state.gameOver = true;
        state.result = "1/2-1/2";
        renderTurn(); renderHistory(); renderFENBox();
        return;
    }

    if (insufficientMaterial(state)) {
        state.gameOver = true;
        state.result = "1/2-1/2";
        renderTurn(); renderHistory(); renderFENBox();
        return;
    }

    // threefold: count same key in sliding window (halfmove rule window)
    const windowLen = state.halfmove + 1;
    let count = 0;
    for (let i = state.posKeys.length - 1; i >= Math.max(0, state.posKeys.length - windowLen); i--) {
        if (state.posKeys[i] === keyNow) count++;
    }
    if (count >= 3) {
        state.gameOver = true;
        state.result = "1/2-1/2";
        renderTurn(); renderHistory(); renderFENBox();
        return;
    }

    const legalMoves = allLegalMoves(state, state.turn);
    if (legalMoves.length === 0) {
        state.gameOver = true;
        if (inCheck(state, state.turn)) {
            const i = state.history.length - 1;
            state.history[i] = state.history[i].replace(/[+#]$/, "") + "#";
            state.result = state.turn === "w" ? "0-1" : "1-0";
        }
        else {
            state.result = "1/2-1/2";
        }
    }

    clearSelection();
    renderTurn();
    renderHistory();
    renderFENBox();
}

// ---------- self-play (visual) ----------

window.chess = { state, applyMove, toIndex };
window.chess.selfplay = { running: false };

// ensure white-POV eval for search
function wrapEvalToWhitePOV(evalFn, pov = "white") {
    if (pov === "sidemove") {
        return (s) => {
            const cpSM = evalFn(s);
            return (s.turn === "w") ? cpSM : -cpSM;
        };
    }
    return evalFn;
}

window.chess.startSelfPlay = async function startSelfPlay({
    depth = 4,
    delay = 150,
    timeMs = 1500,
    evalMode = "classic",
    evalPath = "./ai/eval.js",
    searchPath = "./ai/search.js"
} = {}) {
    if (window.chess.selfplay.running) return;
    window.chess.selfplay.running = true;

    window.chess.lastEvalInfo = evalMode;

    const { pickMove } = await import(searchPath);
    const { getEval }  = await import(evalPath);

    const { evalFn: rawEval, info } = await getEval({ mode: evalMode, targetTempo: 0 });
    const pov = (info?.model_pov || "white").toLowerCase();
    const evalFn = wrapEvalToWhitePOV(rawEval, pov);
    console.log(`[selfplay] eval=${evalMode} pov=${pov} (wrapped→white-POV)`);

    const s = window.chess.state;
    let ply = 0;

    while (window.chess.selfplay.running && !s.gameOver) {
        const choice = await pickMove(s, { depth, timeMs, evalFn });
        if (!choice) break;
        window.chess.applyMove(choice.from, choice.to);
        ply += 1;
        if (ply > 400) break;
        if (delay) await new Promise(r => setTimeout(r, delay));
    }
    window.chess.selfplay.running = false;
    console.log("self-play ended:", s.gameOver ? s.result : "(stopped)");
};

window.chess.stopSelfPlay = function stopSelfPlay() {
    window.chess.selfplay.running = false;
    console.log("self-play: stop requested");
};

// ---------- headless batch labeler ----------

window.chess.batch = { running: false };

function freshStartState() {
    const s = {
        board: Array(64).fill(null),
        turn: "w",
        ep: null,
        castleRight: "KQkq",
        halfmove: 0,
        fullmove: 1,
        history: [],
        gameOver: false,
        result: ""
    };
    loadFEN(s, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    return s;
}

function countMaterial(s) {
    let w = 0, b = 0;
    for (let i = 0; i < 64; i++) {
        const p = s.board[i];
        if (!p) continue;
        if (p.c === "w") w++; else b++;
    }
    return { w, b };
}

function randomizePosition(s, pliesMin = 12, pliesMax = 60) {
    const n = ((Math.random() * (pliesMax - pliesMin + 1)) | 0) + pliesMin;
    for (let i = 0; i < n; i++) {
        if (s.gameOver) break;
        const moves = allLegalMoves(s, s.turn);
        if (!moves.length) break;
        const [from, to] = moves[(Math.random() * moves.length) | 0];
        applyMovePure(s, from, to);
    }
}

function isUsefulForTraining(s) {
    if (s.gameOver) return false;
    const { w, b } = countMaterial(s);
    if (w < 3 || b < 3) return false;
    const mob = allLegalMoves(s, s.turn).length;
    if (mob < 8 || mob > 40) return false;
    return true;
}

// color-agnostic key for pair-safe splitting
function colorlessFenKey(fen) {
    const parts = fen.split(" ");
    if (parts.length < 4) return fen.toUpperCase();
    const board = parts[0].toUpperCase();
    const castling = parts[2] === "-" ? "-" : parts[2].toUpperCase();
    return `${board} - ${castling} -`;
}

// log hook (dedup by key, require depth ≥ minLoggedDepth)
window.chess.dataset = [];
window.chess.logEnabled = true;
window.chess.dedupKeys = new Set();
window.chess.minLoggedDepth = 3;
window.chess._lastLog = null;

window.chess.logSample = async function (s, { bestMove, score_cp, depth }) {
    if (!window.chess.logEnabled) { window.chess._lastLog = { ok:false, cause:"disabled", depth: depth|0 }; return false; }
    if (!Number.isFinite(score_cp)) { window.chess._lastLog = { ok:false, cause:"bad_score", depth: depth|0 }; return false; }
    if ((depth ?? 0) < window.chess.minLoggedDepth) { window.chess._lastLog = { ok:false, cause:"too_shallow", depth: depth|0 }; return false; }

    const zhex = computeKey(s).toString(16);
    const zkey = `0x${zhex}:d${depth}`;
    if (window.chess.dedupKeys.has(zkey)) { window.chess._lastLog = { ok:false, cause:"dup", depth: depth|0 }; return false; }
    window.chess.dedupKeys.add(zkey);
    try {
        const fenStr = toFEN(s);
        const pair_key = colorlessFenKey(fenStr);
        await addSample(s, { fen: fenStr, bestMove, score_cp, depth, pair_key });
        window.chess._lastLog = { ok:true, cause:"ok", depth: depth|0 };
        return true;
    }
    catch (e) {
        console.warn("addSample failed:", e);
        window.chess._lastLog = { ok:false, cause:"error", depth: depth|0 };
        return false;
    }
};

window.chess.startBatch = async function startBatch({
    count = 2000,
    depth = 4,
    perPosMs = 200,
    pliesMin = 16,
    pliesMax = 80,
    evalMode = "classic"
} = {}) {
    if (window.chess.batch.running) return;
    window.chess.batch.running = true;

    window.chess.lastEvalInfo = evalMode;

    const { pickMove } = await import("./ai/search.js");
    const { getEval }  = await import("./ai/eval.js");

    const { evalFn, info } = await getEval({ mode: evalMode });
    console.log(`[batch] eval=${evalMode}`, info || "");

    let startCount = 0;
    try { startCount = await getCount(); }
    catch {}
    const target = startCount + Math.max(0, count);
    let lastCount = startCount;
    let attempts = 0;

    console.log(`[batch] target +${count} rows @ depth=${depth}, perPos=${perPosMs}ms (from ${startCount} → ${target})`);

    while (window.chess.batch.running && lastCount < target) {
        const s = freshStartState();
        randomizePosition(s, pliesMin, pliesMax);

        if (!isUsefulForTraining(s)) {
            attempts++;
            continue;
        }

        let time = perPosMs;
        for (let tries = 0; tries < 5; tries++) {
            try { await pickMove(s, { depth, timeMs: time, evalFn }); }
            catch (e) { console.warn("[batch] pickMove error:", e); break; }
            const cause = window.chess._lastLog?.cause;
            if (cause === "ok" || cause === "dup") break;
            else if (cause === "too_shallow" || cause === "timeout_root") { 
                time = Math.floor(time * 2.0); 
                continue; 
            }
            else break;
        }

        attempts++;
        if (attempts % 10 === 0) {
            try { lastCount = await getCount(); }
            catch {}
            console.log(`[batch] progress: +${lastCount - startCount}/${count} (attempts:${attempts})`);
            await Promise.resolve();
        }
    }

    window.chess.batch.running = false;
    try {
        const finalCount = await getCount();
        console.log(`[batch] done: added ${finalCount - startCount} rows (target ${count})`);
    }
    catch {
        console.log("[batch] done (could not read final count)");
    }
};

// ---------- UI wiring ----------

function mount() {
    $id("reset").addEventListener("click", () => {
        try { window.chess?.stopSelfPlay?.(); }
        catch {}
        try { window.chess?.stopBatch?.(); }
        catch {}

        loadFEN(state, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        state.history = [];
        state.gameOver = false;
        state.result = "";
        state.selected = null;
        state.targets = [];
        state.posKeys = [computeKey(state)];

        renderTurn();
        renderHistory();
        renderBoard();
        renderFENBox();
    });

    $id("flip").addEventListener("click", () => {
        state.pov = state.pov === "w" ? "b" : "w";
        renderBoard();
    });

    $id("btnCopyFEN").addEventListener("click", async () => {
        const fen = toFEN(state);
        $id("fenInput").value = fen;
        try { await navigator.clipboard.writeText(fen); }
        catch {}
    });

    $id("btnLoadFEN").addEventListener("click", () => {
        const fen = $id("fenInput").value.trim();
        if (!fen) return;
        try {
            loadFEN(state, fen);
            state.posKeys = [computeKey(state)];
            renderBoard();
            renderTurn();
            renderHistory();
            renderFENBox();
        }
        catch (e) {
            alert("Invalid FEN: " + (e?.message || String(e)));
        }
    });

    $id("selfplayStart")?.addEventListener("click", () => {
        const delay = +$id("selfplayDelay").value || 150;
        const depth = +$id("selfplayDepth").value || 4;
        const timeMs = +($id("selfplayTime")?.value || 1500);
        const evalMode = ($id("selfPlayEvalMode")?.value || "classic");
        window.chess.startSelfPlay({ depth, delay, timeMs, evalMode });
    });

    $id("selfplayStop")?.addEventListener("click", () => {
        window.chess.stopSelfPlay();
    });

    $id("logToggle")?.addEventListener("change", (e) => {
        window.chess.logEnabled = !!e.target.checked;
    });

    $id("exportJSONL")?.addEventListener("click", async () => {
        try {
            const { url, count } = await exportJSONL();
            const a = document.createElement("a");
            a.href = url;
            a.download = "chess_samples.jsonl";
            a.click();
            URL.revokeObjectURL(url);
            console.log("exported", count, "rows");
        }
        catch (e) {
            console.error("export failed:", e);
        }
    });

    $id("clearDataset")?.addEventListener("click", async () => {
        await clearAll();
        window.chess.dataset = [];
        window.chess.dedupKeys.clear();
        console.log("dataset cleared");
    });

    $id("batchStart")?.addEventListener("click", () => {
        const count    = (+$id("batchCount").value)    | 0 || 2000;
        const depth    = (+$id("batchDepth").value)    | 0 || 4;
        const perPosMs = (+$id("batchPerPos").value)   | 0 || 200;
        const pliesMin = (+$id("batchPliesMin").value) | 0 || 16;
        const pliesMax = (+$id("batchPliesMax").value) | 0 || 80;
        const evalMode = ($id("batchEvalMode").value || "classic");

        window.chess.startBatch({ count, depth, perPosMs, pliesMin, pliesMax, evalMode });
    });

    $id("batchStop")?.addEventListener("click", () => {
        window.chess.stopBatch();
    });

    (async () => {
        try { console.log("samples in DB:", await getCount()); }
        catch {}
    })();

    const MASK64 = 0xFFFFFFFFFFFFFFFFn;
    let seed = 0x12345678n;
    function random64() {
        seed = (seed + 0x9E3779B97F4A7C15n) & MASK64;
        let z = seed;
        z = (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n & MASK64;
        z = (z ^ (z >> 27n)) * 0x94D049BB133111EBn & MASK64;
        return z ^ (z >> 31n);
    }

    initZobrist(random64);
    state.posKeys = [computeKey(state)];
    renderTurn();
    renderBoard();
    renderHistory();
    renderFENBox();
}

function mountSafe() {
    try { mount(); }
    catch (e) {
        console.error("mount failed:", e);
    }
}

mountSafe();
