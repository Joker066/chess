// src/ai/search.js — clean, fast, depth-finish friendly (4-space indent, newline-before else/catch)
// Adds: root time-guard, light ordering, LMR tune, Null-Move Pruning, Futility Pruning,
// Late-Move Pruning, and guarantees finite scores for logging.

import { fromIndex, toIndex } from "../board.js";
import { allLegalMoves, inCheck } from "../moves.js";
import { cloneState, applyMovePure } from "./pure.js";
import { computeKey } from "./zobrist.js";
import { ttProbe, ttStore, TT_FLAG } from "./tt.js";
import { bookProbe, bookInsert } from "./book.js";
import { toFEN } from "../fen.js";

// ─────────────────────────────────────────────────────────────────────────────
// Timing / yielding
// ─────────────────────────────────────────────────────────────────────────────
let DEADLINE = Number.POSITIVE_INFINITY;
function timeExpired() { return Date.now() >= DEADLINE; }

const YIELD_MS = 30; // coarser to reduce scheduler overhead
let _lastYield = (typeof performance !== "undefined" ? performance.now() : Date.now());
async function maybeYield() {
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (now - _lastYield >= YIELD_MS) {
        await Promise.resolve();
        _lastYield = now;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristics state (killers + history)
// ─────────────────────────────────────────────────────────────────────────────
const MAX_PLY = 128;
const killers = Array.from({ length: MAX_PLY }, () => new Int32Array([ -1, -1 ]));
const history = [
    Array.from({ length: 64 }, () => new Int32Array(64)), // white
    Array.from({ length: 64 }, () => new Int32Array(64)), // black
];

function moveKey(from, to) { return (from << 6) | to; }
function addKiller(ply, mkey) {
    if (ply < 0 || ply >= MAX_PLY) return;
    const ks = killers[ply];
    if (ks[0] !== mkey) { ks[1] = ks[0]; ks[0] = mkey; }
}
function bumpHistory(sideIdx, from, to, depth) {
    const bonus = (depth + 1) * (depth + 1) * 32;
    const cur = history[sideIdx][from][to] | 0;
    let nxt = cur + bonus;
    if (nxt > 1_000_000) nxt = 1_000_000;
    history[sideIdx][from][to] = nxt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Move helpers (cheap)
// ─────────────────────────────────────────────────────────────────────────────
const VAL = { P:100, N:320, B:330, R:500, Q:900, K:0 };

function isEnPassantMove(state, from, to) {
    const mover = state.board[from];
    if (!mover || mover.t !== "P") return false;
    if (state.ep == null || to !== state.ep) return false;
    const { f: ff } = fromIndex(from);
    const { r: tr, f: tf } = fromIndex(to);
    if (Math.abs(tf - ff) !== 1) return false;
    const dir = (mover.c === "w") ? -1 : 1;
    const capIdx = toIndex(tr - dir, tf);
    const victim = state.board[capIdx];
    return !!(victim && victim.t === "P" && victim.c !== mover.c);
}

function isCapture(state, from, to) {
    const mover  = state.board[from];
    const target = state.board[to];
    return !!(mover && ((target && target.c !== mover.c) || isEnPassantMove(state, from, to)));
}

function isPromotionMove(state, from, to) {
    const p = state.board[from];
    if (!p || (p.t || "").toUpperCase() !== "P") return false;
    const toRank = Math.floor(to / 8);
    return (p.c === "w" && toRank === 0) || (p.c === "b" && toRank === 7);
}

function isCastleMove(state, from, to) {
    const p = state.board[from];
    if (!p || (p.t || "").toUpperCase() !== "K") return false;
    return Math.abs((to % 8) - (from % 8)) === 2;
}

function isQuietMove(state, from, to) {
    return !isCapture(state, from, to) && !isPromotionMove(state, from, to) && !isCastleMove(state, from, to);
}

function isCheckAfter(state, from, to) {
    const cs = cloneState(state);
    const before = cs.turn;
    applyMovePure(cs, from, to);
    if (cs.turn === before && typeof console !== "undefined") {
        console.warn("applyMovePure did not flip turn in isCheckAfter");
    }
    return inCheck(cs, cs.turn);
}

// Annotate moves once per node. `light` skips expensive checks.
function annotateMoves(state, moves, ttBest, sideIdx, ply, { light=false } = {}) {
    const k0 = killers[ply]?.[0] ?? -1;
    const k1 = killers[ply]?.[1] ?? -1;
    const out = [];

    for (const [from, to] of moves) {
        const mover  = state.board[from];
        const target = state.board[to];
        const mv = VAL[(mover?.t || "").toUpperCase()]  || 0;
        const epCap = isEnPassantMove(state, from, to);
        const vv = epCap ? VAL.P : (VAL[(target?.t || "").toUpperCase()] || 0);

        let os = 0;

        // Captures: MVV-LVA-ish
        const isCap = !!(target || epCap);
        if (isCap) os += 10 * vv - mv;

        const quiet = !isCap && !isPromotionMove(state, from, to) && !isCastleMove(state, from, to);

        if (!light) {
            if (quiet && isCheckAfter(state, from, to)) os += 150;
        }

        if (quiet) {
            const r = Math.floor(to / 8), f = to % 8;
            const dist = Math.abs(r - 3.5) + Math.abs(f - 3.5);
            os += (8 - dist) | 0;
        }

        if (ttBest && from === ttBest[0] && to === ttBest[1]) os += 1e9;

        const mkey = moveKey(from, to);
        if (quiet) {
            if (mkey === k0) os += 5e8;
            else if (mkey === k1) os += 5e8 - 1;
            os += (history[sideIdx][from][to] | 0);
        }

        out.push({ from, to, os, mkey, quiet });
    }

    out.sort((a, b) => b.os - a.os);
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quiescence — captures-only unless in check; ALWAYS finite
// ─────────────────────────────────────────────────────────────────────────────
async function quiescence(state, alpha, beta, evalFn) {
    const sideMax = (state.turn === "w");
    const inChk = inCheck(state, state.turn);

    const stand = evalFn(state);
    if (!inChk) {
        if (sideMax) {
            if (stand >= beta) return stand;
            if (stand > alpha) alpha = stand;
        }
        else {
            if (stand <= alpha) return stand;
            if (stand < beta) beta = stand;
        }
    }
    if (timeExpired()) return stand; // finite fallback

    let moves = allLegalMoves(state, state.turn);
    if (!inChk) {
        moves = moves.filter(([f, t]) => isCapture(state, f, t));
        if (moves.length === 0) return stand;
    }

    const sideIdx = (state.turn === "w") ? 0 : 1;
    const anns = annotateMoves(state, moves, null, sideIdx, 0, { light: true });

    if (sideMax) {
        for (const m of anns) {
            const cs = cloneState(state);
            const prevTurn = cs.turn;
            applyMovePure(cs, m.from, m.to);
            if (cs.turn === prevTurn && typeof console !== "undefined") {
                console.warn("applyMovePure did not flip turn in quiescence!");
            }
            const v = await quiescence(cs, alpha, beta, evalFn);
            if (v > alpha) alpha = v;
            if (alpha >= beta) break;
            await maybeYield();
        }
        return alpha;
    }
    else {
        for (const m of anns) {
            const cs = cloneState(state);
            const prevTurn = cs.turn;
            applyMovePure(cs, m.from, m.to);
            if (cs.turn === prevTurn && typeof console !== "undefined") {
                console.warn("applyMovePure did not flip turn in quiescence!");
            }
            const v = await quiescence(cs, alpha, beta, evalFn);
            if (v < beta) beta = v;
            if (alpha >= beta) break;
            await maybeYield();
        }
        return beta;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extra pruning helpers
// ─────────────────────────────────────────────────────────────────────────────
function hasNonPawnMaterial(state, side) {
    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (!p || p.c !== side) continue;
        const t = (p.t || "").toUpperCase();
        if (t !== "P" && t !== "K") return true;
    }
    return false;
}
function makeNullMove(state) {
    const cs = cloneState(state);
    cs.turn = (state.turn === "w" ? "b" : "w");
    cs.ep = null;
    return cs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main search with TT + killers + history + LMR + NMP + Futility + LMP
// ─────────────────────────────────────────────────────────────────────────────
const MATE = 100000;

function terminalScoreGivenMoves(state, moves, depth) {
    if (moves.length > 0) return null;
    if (inCheck(state, state.turn)) {
        const plyPenalty = (100 - depth);
        return (state.turn === "w" ? -1 : 1) * (MATE - plyPenalty);
    }
    return 0; // stalemate
}

export async function alphaBeta(state, depth, alpha, beta, evalFn, ply = 0) {
    if (timeExpired()) return await quiescence(state, alpha, beta, evalFn);
    if (depth === 0)    return await quiescence(state, alpha, beta, evalFn);

    const maximizing = (state.turn === "w");
    const key = computeKey(state);
    const alphaStart = alpha, betaStart = beta;

    const moves0 = allLegalMoves(state, state.turn);
    const term = terminalScoreGivenMoves(state, moves0, depth);
    if (term !== null) return term;

    // Null-Move Pruning (skip in check / zugzwang-ish endgames)
    if (depth >= 3 && !inCheck(state, state.turn) && hasNonPawnMaterial(state, state.turn)) {
        const stand0 = evalFn(state);
        if (stand0 >= beta) {
            const R = (depth >= 6 ? 3 : 2);
            const ns = makeNullMove(state);
            const nullScore = await alphaBeta(ns, depth - 1 - R, beta - 1, beta, evalFn, ply + 1);
            if (nullScore >= beta) return nullScore; // fail-high cutoff
        }
    }

    // TT probe
    const entry = ttProbe(key, depth);
    if (entry) {
        if (entry.flag === TT_FLAG.EXACT) return entry.score;
        if (entry.flag === TT_FLAG.LOWER) alpha = Math.max(alpha, entry.score);
        else if (entry.flag === TT_FLAG.UPPER) beta = Math.min(beta, entry.score);
        if (alpha >= beta) return entry.score;
    }

    const sideIdx = (state.turn === "w") ? 0 : 1;
    const ttBest = entry?.bestMove || null;
    const scored = annotateMoves(state, moves0, ttBest, sideIdx, ply, { light: depth <= 3 });

    // Precompute stand for Futility when needed (lazy)
    let stand = null; const getStand = () => (stand ??= evalFn(state));

    if (maximizing) {
        let best = -MATE;

        for (let idx = 0; idx < scored.length; idx++) {
            if (timeExpired()) break;
            const m = scored[idx];

            // Late-Move Pruning: skip many late quiets at shallow depth
            if (depth <= 2 && m.quiet && idx >= 12) continue;

            // Futility pruning at depth==1: quiets that cannot raise alpha
            if (depth === 1 && m.quiet && !inCheck(state, state.turn)) {
                const margin = 200;
                if (getStand() + margin <= alpha) continue;
            }

            const cs = cloneState(state);
            applyMovePure(cs, m.from, m.to);

            let val;
            // LMR
            if (depth >= 4 && m.quiet && idx >= 6 && ply < MAX_PLY - 1) {
                const R = (idx >= 10 ? 2 : 1);
                val = await alphaBeta(cs, depth - 1 - R, alpha + 1, alpha + 1, evalFn, ply + 1);
                if (val > alpha && !timeExpired()) {
                    val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1);
                }
            }
            else {
                val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1);
            }

            if (val > best) best = val;
            if (val > alpha) alpha = val;
            if (alpha >= beta) {
                if (m.quiet) { addKiller(ply, m.mkey); bumpHistory(sideIdx, m.from, m.to, depth); }
                break;
            }

            await maybeYield();
        }

        const flag = best <= alphaStart ? TT_FLAG.UPPER : best >= betaStart ? TT_FLAG.LOWER : TT_FLAG.EXACT;
        ttStore(key, depth, flag, best, scored[0] ? [scored[0].from, scored[0].to] : null);
        return best;
    }
    else {
        let best = MATE;

        for (let idx = 0; idx < scored.length; idx++) {
            if (timeExpired()) break;
            const m = scored[idx];

            if (depth <= 2 && m.quiet && idx >= 12) continue; // LMP for minimizing

            if (depth === 1 && m.quiet && !inCheck(state, state.turn)) {
                const margin = 200;
                if (getStand() - margin >= beta) continue; // symmetrical futility
            }

            const cs = cloneState(state);
            applyMovePure(cs, m.from, m.to);

            let val;
            if (depth >= 4 && m.quiet && idx >= 6 && ply < MAX_PLY - 1) {
                const R = (idx >= 10 ? 2 : 1);
                val = await alphaBeta(cs, depth - 1 - R, beta - 1, beta - 1, evalFn, ply + 1);
                if (val < beta && !timeExpired()) {
                    val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1);
                }
            }
            else {
                val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1);
            }

            if (val < best) best = val;
            if (val < beta) beta = val;
            if (alpha >= beta) {
                if (m.quiet) { addKiller(ply, m.mkey); bumpHistory(sideIdx, m.from, m.to, depth); }
                break;
            }

            await maybeYield();
        }

        const flag = best <= alphaStart ? TT_FLAG.UPPER : best >= betaStart ? TT_FLAG.LOWER : TT_FLAG.EXACT;
        ttStore(key, depth, flag, best, scored[0] ? [scored[0].from, scored[0].to] : null);
        return best;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Root driver (iterative deepening + aspiration + logging + persistent book)
// ─────────────────────────────────────────────────────────────────────────────
function finiteScore(v, fallback = 0) {
    if (Number.isFinite(v)) return Math.trunc(v);
    return Number.isFinite(fallback) ? Math.trunc(fallback) : 0;
}

export async function pickMove(
    state,
    {
        depth: maxDepth = 8,
        timeMs = null,
        evalFn
    } = {}
) {
    const hadDeadline = (typeof DEADLINE !== "undefined");
    const prevDeadline = hadDeadline ? DEADLINE : null;
    DEADLINE = (timeMs != null) ? Date.now() + Math.max(50, timeMs) : Number.POSITIVE_INFINITY;

    const player = state.turn;
    let moves = allLegalMoves(state, player);
    if (!moves.length) {
        if (hadDeadline) DEADLINE = prevDeadline ?? Number.POSITIVE_INFINITY;
        return null;
    }

    // Book hint
    const zkey = computeKey(state).toString(16);
    let bookHint = null;
    try {
        const cached = bookProbe(zkey, 4);
        if (cached && cached.bestMove) bookHint = [cached.bestMove.from, cached.bestMove.to];
    }
    catch {}

    // Root TT hint
    const rootTT = ttProbe(computeKey(state), 0);
    const ttHint = rootTT?.bestMove;

    // Root ordering (light)
    const sideIdx = (player === "w") ? 0 : 1;
    let annotated = annotateMoves(state, moves, ttHint || bookHint, sideIdx, 0, { light: true });
    moves = annotated.map(m => [m.from, m.to]);

    let bestMove = moves[0];
    let bestScore = (player === "w") ? -MATE : MATE;
    let lastScore = 0;
    let finishedDepth = 0;

    const ASP_WIDE = 200; // aspiration only for d>=4
    const GUARD_MS = 80;  // larger guard to finish a depth cleanly

    // reset killers near root
    for (let p = 0; p < Math.min(MAX_PLY, maxDepth + 4); p++) { killers[p][0] = -1; killers[p][1] = -1; }

    for (let d = 1; d <= maxDepth; d++) {
        if (timeMs != null && timeExpired()) break;

        let localBestMove = null;
        let localBestScore = (player === "w") ? -MATE : MATE;

        let alphaWin = -Infinity, betaWin = Infinity;
        if (d >= 4 && Number.isFinite(lastScore)) {
            alphaWin = lastScore - ASP_WIDE;
            betaWin  = lastScore + ASP_WIDE;
        }

        for (const [from, to] of moves) {
            if (timeMs != null && timeExpired()) break;
            if (timeMs != null && (DEADLINE - Date.now()) < GUARD_MS) break;

            const cs = cloneState(state);
            applyMovePure(cs, from, to);

            let score = await alphaBeta(cs, d - 1, alphaWin, betaWin, evalFn, 1);
            if (timeMs != null && !timeExpired() && (score <= alphaWin || score >= betaWin)) {
                score = await alphaBeta(cs, d - 1, -Infinity, Infinity, evalFn, 1);
            }

            if (player === "w") {
                if (score > localBestScore) { localBestScore = score; localBestMove = [from, to]; }
            }
            else {
                if (score < localBestScore) { localBestScore = score; localBestMove = [from, to]; }
            }

            await maybeYield();
        }

        if (timeMs != null && timeExpired()) break;

        if (localBestMove) {
            bestMove  = localBestMove;
            bestScore = localBestScore;
            lastScore = localBestScore;
            finishedDepth = d;

            // PV move to front
            moves.sort(([af, at], [bf, bt]) =>
                (af === bestMove[0] && at === bestMove[1]) ? -1 :
                (bf === bestMove[0] && bt === bestMove[1]) ?  1 : 0
            );

            if (Math.abs(bestScore) > 99000) break; // mate found
        }

        await maybeYield();
    }

    // UI-safe score
    let uiScore = bestScore;
    if (!Number.isFinite(uiScore)) {
        const q = await quiescence(state, -Infinity, Infinity, evalFn);
        uiScore = finiteScore(q, 0);
    }
    const ret = bestMove ? { from: bestMove[0], to: bestMove[1], score: uiScore } : null;

    // Dataset logging
    const minDepthForLog = (window.chess?.minLoggedDepth ?? 3);
    const loggable = (finishedDepth >= minDepthForLog);
    const logScore = Number.isFinite(bestScore) ? bestScore : uiScore;

    if (loggable) {
        const whiteCp = logScore;
        const sideToMoveCp = (player === "w") ? whiteCp : -whiteCp;
        try {
            window.chess?.logSample?.(state, {
                bestMove: ret ? { from: ret.from, to: ret.to } : null,
                score_cp: sideToMoveCp,
                depth: finishedDepth
            });
        }
        catch {}
    }
    else {
        try {
            window.chess._lastLog = { ok:false, cause: Number.isFinite(bestScore)?"too_shallow":"timeout_root", depth: finishedDepth|0 };
        }
        catch {}
    }

    // Persist to book
    try {
        const fen = toFEN(state);
        const depthStored = finishedDepth || maxDepth;
        bookInsert(zkey, {
            fen,
            bestMove: ret ? { from: ret.from, to: ret.to } : null,
            score: Number.isFinite(bestScore) ? bestScore : uiScore,
            depth: depthStored,
            eval: (window.chess?.lastEvalInfo || "classic")
        });
    }
    catch {}

    if (hadDeadline) DEADLINE = prevDeadline ?? Number.POSITIVE_INFINITY;
    return ret;
}
