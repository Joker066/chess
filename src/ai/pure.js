import { fromIndex, toIndex } from "../board.js";
import { removeCastleRight } from "../rules.js";

export function cloneState(state) {
    return {
        ...state,
        board: state.board.slice(),
        ep: state.ep,
        castleRight: state.castleRight,
        halfmove: state.halfmove,
        fullmove: state.fullmove
    };
}

/* state here is a clone state */
export function applyMovePure(state, from, to) {
    const mover = state.board[from];
    if (!mover) return;

    const fromRF = fromIndex(from);
    const toRF = fromIndex(to);
    const dir = mover.c === "w" ? -1 : 1;

    // flags
    const isCastle = (mover.t === "K" && Math.abs(toRF.f - fromRF.f) === 2);
    const isEP = (mover.t === "P" && to === state.ep && fromRF.f !== toRF.f);
    const isPromotion = (mover.t === "P" && (toRF.r === 0 || toRF.r === 7));

    // capture info
    const capturedIndex = isEP ? toIndex(toRF.r - dir, toRF.f) : to;
    const captured = state.board[capturedIndex] || null;
    
    // halfmove
    if (mover.t === "P" || captured) state.halfmove = 0;
    else state.halfmove += 1;

    // make the move
    state.board[to] = mover;
    state.board[from] = null;

    // remove the pawn if en passant
    if (isEP) {
        state.board[capturedIndex] = null;
    }

    // promotion (auto-queen)
    if (isPromotion) {
        state.board[to] = { c: mover.c, t: "Q" };
    }

    // castle
    if (isCastle) {
        if (mover.c === "w") {
            if (to === toIndex(7, 6)) { // O-O
                state.board[toIndex(7, 5)] = state.board[toIndex(7, 7)];
                state.board[toIndex(7, 7)] = null;
            }    
            else { // O-O-O
                state.board[toIndex(7, 3)] = state.board[toIndex(7, 0)];
                state.board[toIndex(7, 0)] = null;
            }
            removeCastleRight(state, "K", "Q");
        } 
        else {
            if (to === toIndex(0, 6)) { // O-O
                state.board[toIndex(0, 5)] = state.board[toIndex(0, 7)];
                state.board[toIndex(0, 7)] = null;
            } 
            else { // O-O-O
                state.board[toIndex(0, 3)] = state.board[toIndex(0, 0)];
                state.board[toIndex(0, 0)] = null;
            }
            removeCastleRight(state, "k", "q");
        }
    }

    // update EP square
    if (mover.t === "P" && Math.abs(toRF.r - fromRF.r) === 2) {
        state.ep = toIndex((toRF.r + fromRF.r) / 2, fromRF.f);
    } 
    else state.ep = null;

    // update castle right
    if (mover.t === "K") {
        if (mover.c === "w") {
            removeCastleRight(state, "K", "Q");
        }
        else {
            removeCastleRight(state, "k", "q");
        }
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

    // flip turn
    state.turn = state.turn === "w" ? "b" : "w";

    // fullmove
    if (state.turn === "w") state.fullmove += 1;

    return state;
}