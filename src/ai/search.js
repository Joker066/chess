// src/ai/search.js — consolidated + style‑clean pass (4‑space indent, newline‑before else/catch)
// Includes: endgame‑aware pruning, repetition with contempt, 50‑move & insuff. material draws,
// known‑king "gives check" optimization, stronger shallow LMP/futility, root guard & chunking.

import { fromIndex, toIndex } from "../board.js";
import { allLegalMoves, inCheck, findKing, isSquareAttacked } from "../moves.js";
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

const YIELD_MS = 30;
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
    Array.from({ length: 64 }, () => new Int32Array(64)),
    Array.from({ length: 64 }, () => new Int32Array(64))
];

function moveKey(from, to) { return (from << 6) | to; }
function addKiller(ply, mkey) {
    if (ply < 0 || ply >= MAX_PLY) return;
    const ks = killers[ply];
    if (ks[0] !== mkey) {
        ks[1] = ks[0];
        ks[0] = mkey;
    }
}
function bumpHistory(sideIdx, from, to, depth) {
    const bonus = (depth + 1) * (depth + 1) * 32;
    const cur = history[sideIdx][from][to] | 0;
    let nxt = cur + bonus;
    if (nxt > 1_000_000) nxt = 1_000_000;
    history[sideIdx][from][to] = nxt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase / material helpers
// ─────────────────────────────────────────────────────────────────────────────
function nonPawnPieceCount(state) {
    let n = 0;
    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (!p) continue;
        const t = (p.t || "").toUpperCase();
        if (t !== "P" && t !== "K") n++;
    }
    return n;
}
function endgamePhase(state) { return nonPawnPieceCount(state) <= 4; }

function insufficientMaterial(state) {
    let pawns = 0, heavy = 0, minors = 0;
    for (let i = 0; i < 64; i++) {
        const p = state.board[i];
        if (!p) continue;
        const t = (p.t || "").toUpperCase();
        if (t === "P") pawns++;
        else if (t === "R" || t === "Q") heavy++;
        else if (t === "B" || t === "N") minors++;
    }
    if (pawns > 0) return false;
    if (heavy > 0) return false;
    return minors <= 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring helpers
// ─────────────────────────────────────────────────────────────────────────────
const VAL = { P:100, N:320, B:330, R:500, Q:900, K:0 };
const CONTEMPT = 12; // cp
function drawScore(turn) { return (turn === "w") ? -CONTEMPT : CONTEMPT; }

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

// Cheap gives-check using do/undo + known enemy king
function givesCheckAfter(state, from, to, enemyKingSq) {
    const mover = state.board[from];
    if (!mover) return false;
    const fromRF = fromIndex(from), toRF = fromIndex(to);
    const dir = mover.c === "w" ? -1 : 1;
    const savedFrom = mover;
    const savedTo = state.board[to];
    let epCapIdx = -1;
    let epCapSaved = null;
    const isEP = (mover.t === "P" && to === state.ep && fromRF.f !== toRF.f && !savedTo);
    if (isEP) {
        epCapIdx = toIndex(toRF.r - dir, toRF.f);
        epCapSaved = state.board[epCapIdx];
    }
    if (epCapIdx !== -1) state.board[epCapIdx] = null;
    state.board[to] = savedFrom;
    state.board[from] = null;
    const attackersColor = mover.c;
    const check = isSquareAttacked(state, enemyKingSq, attackersColor);
    state.board[from] = savedFrom;
    state.board[to] = savedTo;
    if (epCapIdx !== -1) state.board[epCapIdx] = epCapSaved;
    return check;
}

function annotateMoves(state, moves, ttBest, sideIdx, ply, { light=false } = {}) {
    const k0 = killers[ply]?.[0] ?? -1;
    const k1 = killers[ply]?.[1] ?? -1;
    const out = [];

    const moverColor = state.turn;
    const enemyColor = (moverColor === "w" ? "b" : "w");
    const enemyKingSq = findKing(state, enemyColor);

    for (const [from, to] of moves) {
        const mover  = state.board[from];
        const target = state.board[to];
        const mv = VAL[(mover?.t || "").toUpperCase()]  || 0;
        const epCap = isEnPassantMove(state, from, to);
        const vv = epCap ? VAL.P : (VAL[(target?.t || "").toUpperCase()] || 0);
        let os = 0;
        const isCap = !!(target || epCap);
        if (isCap) {
            os += 10 * vv - mv;
        }
        const quiet = !isCap && !isPromotionMove(state, from, to) && !isCastleMove(state, from, to);
        if (!light) {
            if (quiet && enemyKingSq !== -1 && givesCheckAfter(state, from, to, enemyKingSq)) {
                os += 150;
            }
        }
        if (quiet) {
            const r = Math.floor(to / 8), f = to % 8;
            const dist = Math.abs(r - 3.5) + Math.abs(f - 3.5);
            os += (8 - dist) | 0;
        }
        if (ttBest && from === ttBest[0] && to === ttBest[1]) {
            os += 1e9;
        }
        const mkey = moveKey(from, to);
        if (quiet) {
            if (mkey === k0) {
                os += 5e8;
            }
            else
            if (mkey === k1) {
                os += 5e8 - 1;
            }
            os += (history[sideIdx][from][to] | 0);
        }
        out.push({ from, to, os, mkey, quiet });
    }

    out.sort((a, b) => b.os - a.os);
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Draw/terminal helpers
// ─────────────────────────────────────────────────────────────────────────────
function fiftyMoveDraw(state) {
    const hm = state.halfmove ?? state.halfmoveClock ?? state.hm;
    return (hm != null && hm >= 100);
}

const MATE = 100000;

function terminalScoreGivenMoves(state, moves, depth) {
    if (moves.length > 0) return null;
    if (inCheck(state, state.turn)) {
        const plyPenalty = (100 - depth);
        return (state.turn === "w" ? -1 : 1) * (MATE - plyPenalty);
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quiescence — captures-only unless in check; ALWAYS finite
// ─────────────────────────────────────────────────────────────────────────────
async function quiescence(state, alpha, beta, evalFn) {
    if (fiftyMoveDraw(state) || insufficientMaterial(state)) return drawScore(state.turn);

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
    if (timeExpired()) return stand;

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
// AlphaBeta with TT + killers + history + LMR + NMP + Futility + LMP + Repetition
// ─────────────────────────────────────────────────────────────────────────────
export async function alphaBeta(state, depth, alpha, beta, evalFn, ply = 0, rep = null) {
    if (fiftyMoveDraw(state) || insufficientMaterial(state)) return drawScore(state.turn);

    if (!rep) rep = new Map();

    const key = computeKey(state);
    const seen = rep.get(key) | 0;
    if (seen >= 2) return drawScore(state.turn);
    rep.set(key, seen + 1);

    const endgame = endgamePhase(state);

    if (timeExpired()) {
        rep.set(key, seen);
        return await quiescence(state, alpha, beta, evalFn);
    }
    if (depth === 0) {
        rep.set(key, seen);
        return await quiescence(state, alpha, beta, evalFn);
    }

    const maximizing = (state.turn === "w");
    const alphaStart = alpha, betaStart = beta;

    const moves0 = allLegalMoves(state, state.turn);
    const term = terminalScoreGivenMoves(state, moves0, depth);
    if (term !== null) {
        rep.set(key, seen);
        return term;
    }

    if (!endgame && depth >= 3 && !inCheck(state, state.turn) && hasNonPawnMaterial(state, state.turn)) {
        const stand0 = evalFn(state);
        if (stand0 >= beta) {
            const R = (depth >= 6 ? 3 : 2);
            const ns = makeNullMove(state);
            const nullScore = await alphaBeta(ns, depth - 1 - R, beta - 1, beta, evalFn, ply + 1, rep);
            if (nullScore >= beta) {
                rep.set(key, seen);
                return nullScore;
            }
        }
    }

    const entry = ttProbe(key, depth);
    if (entry) {
        if (entry.flag === TT_FLAG.EXACT) {
            rep.set(key, seen);
            return entry.score;
        }
        if (entry.flag === TT_FLAG.LOWER) {
            alpha = Math.max(alpha, entry.score);
        }
        else
        if (entry.flag === TT_FLAG.UPPER) {
            beta = Math.min(beta, entry.score);
        }
        if (alpha >= beta) {
            rep.set(key, seen);
            return entry.score;
        }
    }

    const sideIdx = (state.turn === "w") ? 0 : 1;
    const ttBest = entry?.bestMove || null;
    const scored = annotateMoves(state, moves0, ttBest, sideIdx, ply, { light: depth <= 3 });

    let stand = null; const getStand = () => (stand ??= evalFn(state));

    if (maximizing) {
        let best = -MATE;

        for (let idx = 0; idx < scored.length; idx++) {
            if (timeExpired()) break;
            const m = scored[idx];

            if (!endgame && depth <= 3 && m.quiet && idx >= 8) continue;

            if (!endgame && depth === 1 && m.quiet && !inCheck(state, state.turn)) {
                const margin = 250;
                if (getStand() + margin <= alpha) continue;
            }

            const cs = cloneState(state);
            applyMovePure(cs, m.from, m.to);

            let val;
            if (!endgame && depth >= 4 && m.quiet && idx >= 6 && ply < MAX_PLY - 1) {
                const R = (idx >= 10 ? 2 : 1);
                val = await alphaBeta(cs, depth - 1 - R, alpha + 1, alpha + 1, evalFn, ply + 1, rep);
                if (val > alpha && !timeExpired()) {
                    val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1, rep);
                }
            }
            else {
                val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1, rep);
            }

            if (val > best) best = val;
            if (val > alpha) alpha = val;
            if (alpha >= beta) {
                if (m.quiet) {
                    addKiller(ply, m.mkey);
                    bumpHistory(sideIdx, m.from, m.to, depth);
                }
                break;
            }

            await maybeYield();
        }

        const flag = (best <= alphaStart) ? TT_FLAG.UPPER : (best >= betaStart) ? TT_FLAG.LOWER : TT_FLAG.EXACT;
        ttStore(key, depth, flag, best, scored[0] ? [scored[0].from, scored[0].to] : null);
        rep.set(key, seen);
        return best;
    }
    else {
        let best = MATE;

        for (let idx = 0; idx < scored.length; idx++) {
            if (timeExpired()) break;
            const m = scored[idx];

            if (!endgame && depth <= 3 && m.quiet && idx >= 8) continue;

            if (!endgame && depth === 1 && m.quiet && !inCheck(state, state.turn)) {
                const margin = 250;
                if (getStand() - margin >= beta) continue;
            }

            const cs = cloneState(state);
            applyMovePure(cs, m.from, m.to);

            let val;
            if (!endgame && depth >= 4 && m.quiet && idx >= 6 && ply < MAX_PLY - 1) {
                const R = (idx >= 10 ? 2 : 1);
                val = await alphaBeta(cs, depth - 1 - R, beta - 1, beta - 1, evalFn, ply + 1, rep);
                if (val < beta && !timeExpired()) {
                    val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1, rep);
                }
            }
            else {
                val = await alphaBeta(cs, depth - 1, alpha, beta, evalFn, ply + 1, rep);
            }

            if (val < best) best = val;
            if (val < beta) beta = val;
            if (alpha >= beta) {
                if (m.quiet) {
                    addKiller(ply, m.mkey);
                    bumpHistory(sideIdx, m.from, m.to, depth);
                }
                break;
            }

            await maybeYield();
        }

        const flag = (best <= alphaStart) ? TT_FLAG.UPPER : (best >= betaStart) ? TT_FLAG.LOWER : TT_FLAG.EXACT;
        ttStore(key, depth, flag, best, scored[0] ? [scored[0].from, scored[0].to] : null);
        rep.set(key, seen);
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

    const zkey = computeKey(state).toString(16);
    let bookHint = null;
    try {
        const cached = bookProbe(zkey, 4);
        if (cached && cached.bestMove) bookHint = [cached.bestMove.from, cached.bestMove.to];
    }
    catch {}

    const rootTT = ttProbe(computeKey(state), 0);
    const ttHint = rootTT?.bestMove;

    const sideIdx = (player === "w") ? 0 : 1;
    let annotated = annotateMoves(state, moves, ttHint || bookHint, sideIdx, 0, { light: true });
    moves = annotated.map(m => [m.from, m.to]);

    let bestMove = moves[0];
    let bestScore = (player === "w") ? -MATE : MATE;
    let lastScore = 0;
    let finishedDepth = 0;

    const ASP_WIDE = 200; // aspiration only at d ≥ 5
    const GUARD_MS = 140; // finish guard

    for (let p = 0; p < Math.min(MAX_PLY, maxDepth + 4); p++) {
        killers[p][0] = -1;
        killers[p][1] = -1;
    }

    const rootKey = computeKey(state);
    const repBase = new Map();
    repBase.set(rootKey, 1);

    for (let d = 1; d <= maxDepth; d++) {
        if (timeMs != null && timeExpired()) break;

        let localBestMove = null;
        let localBestScore = (player === "w") ? -MATE : MATE;

        let alphaWin = -Infinity, betaWin = Infinity;
        if (d >= 5 && Number.isFinite(lastScore)) {
            alphaWin = lastScore - ASP_WIDE;
            betaWin  = lastScore + ASP_WIDE;
        }

        const ROOT_CHUNK = 10;
        const limit = Math.min(moves.length, ROOT_CHUNK);
        for (let i = 0; i < limit; i++) {
            if (timeMs != null && timeExpired()) break;
            if (timeMs != null && (DEADLINE - Date.now()) < GUARD_MS) break;

            const [from, to] = moves[i];
            const cs = cloneState(state);
            applyMovePure(cs, from, to);

            let score = await alphaBeta(cs, d - 1, alphaWin, betaWin, evalFn, 1, repBase);
            if (timeMs != null && !timeExpired() && (score <= alphaWin || score >= betaWin)) {
                score = await alphaBeta(cs, d - 1, -Infinity, Infinity, evalFn, 1, repBase);
            }

            if (player === "w") {
                if (score > localBestScore) {
                    localBestScore = score;
                    localBestMove = [from, to];
                }
            }
            else {
                if (score < localBestScore) {
                    localBestScore = score;
                    localBestMove = [from, to];
                }
            }

            await maybeYield();
        }

        if (timeMs != null && timeExpired()) break;

        if (localBestMove) {
            bestMove  = localBestMove;
            bestScore = localBestScore;
            lastScore = localBestScore;
            finishedDepth = d;

            moves.sort(([af, at], [bf, bt]) =>
                (af === bestMove[0] && at === bestMove[1]) ? -1 :
                (bf === bestMove[0] && bt === bestMove[1]) ?  1 : 0
            );

            if (Math.abs(bestScore) > 99000) break;
        }

        await maybeYield();
    }

    let uiScore = bestScore;
    if (!Number.isFinite(uiScore)) {
        const q = await quiescence(state, -Infinity, Infinity, evalFn);
        uiScore = finiteScore(q, 0);
    }
    const ret = bestMove ? { from: bestMove[0], to: bestMove[1], score: uiScore } : null;

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
