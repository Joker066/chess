const MAP = {
    wK: "\u2654", wQ: "\u2655", wR: "\u2656", wB: "\u2657", wN: "\u2658", wP: "\u2659",
    bK: "\u265A", bQ: "\u265B", bR: "\u265C", bB: "\u265D", bN: "\u265E", bP: "\u265F",
};

export function pieceToChar(piece) {
    if (!piece) return "";
    return MAP[piece.c + piece.t] ?? "";
}

const NAME = { P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" };

// Returns "./assetes/chess/<name>-<w|b>.svg"
export function pieceImagePath(piece, base = "./assets/chess") {
    if (!piece) return "";
    const t = (piece.t || "").toUpperCase();
    const name = NAME[t];
    const color = piece.c === "w" ? "w" : "b";
    return `${base}/${name}-${color}.svg`;
}

export function pieceAlt(piece) {
    if (!piece) return "";
    const t = (piece.t || "").toUpperCase();
    const color = piece.c === "w" ? "White" : "Black";
    return `${color} ${NAME[t] || "piece"}`;
}