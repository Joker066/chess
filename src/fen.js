import { files, toIndex, fromIndex, algebraic } from "./board.js";

function pieceToFenChar(p) {
    if (!p) return "";
    if (p.c === "w") return p.t;
    else return p.t.toLowerCase();
}

function algebraicToIndex(sq) {
    const r = Number(sq.slice(1));
    const f = files.indexOf(sq[0]);
    return toIndex(8 - r, f);
}

/** Build FEN string from state */
export function toFEN(state) {
    let placement = "";
    for (let r = 0; r < 8; r++) {
        let emptyCount = 0;
        for (let f = 0; f < 8; f++) {
            const i = toIndex(r, f);
            const p = state.board[i];
            if (!p) emptyCount += 1;
            else {
                if (emptyCount !== 0) {
                    placement += emptyCount;
                    emptyCount = 0;
                }
                placement += p.c === "w" ? p.t : p.t.toLowerCase();
            }
        }
        if (emptyCount) placement += emptyCount;
        placement += r === 7 ? "" : "/";
    }
    const turn = state.turn;
    const castle = (state.castleRight? state.castleRight : "-");
    const ep = (state.ep ? algebraic(state.ep) : "-");
    const half = `${state.halfmove}`;
    const full = `${state.fullmove}`;

    return `${placement} ${turn} ${castle} ${ep} ${half} ${full}`;
}

/** Load a FEN string into state (mutates) */
export function loadFEN(state, fen) {
    const [placement, active, castleRight, ep, half, full] = fen.trim().split(/\s+/);
    const ranks = placement.split("/");

    const builtBoard = Array(64).fill(null);
    for (let r = 0; r < 8; r++) {
        let f = 0;
        for (const ch of ranks[r]) {
            if (/\d/.test(ch)) {
                f += parseInt(ch, 10);
            }
            else {
                builtBoard[toIndex(r, f)] = {
                    c: (ch === ch.toUpperCase() ? "w" : "b"),
                    t: ch.toUpperCase()
                };
                f += 1;
            }
        }
    }

    state.board = builtBoard;
    state.turn = active;
    state.castleRight = castleRight === "-" ? "" : castleRight;
    state.ep = ep === "-" ? null : algebraicToIndex(ep);
    state.halfmove = Number(half) || 0;
    state.fullmove = Number(full) || 1;
    state.selected = null;
    state.targets = [];
    state.gameOver = false;
    state.result = "";
}
