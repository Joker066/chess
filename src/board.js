export const files = "abcdefgh";

export const toIndex = (r, f) => r * 8 + f;
export const fromIndex = (i) => ({ r: Math.floor(i / 8), f: i % 8 })
export const algebraic = (i) => {
    const { r, f } = fromIndex(i);
    return files[f] + (8 - r);
}

const backRank = ["R","N","B","Q","K","B","N","R"]; 
export function makeInitialBoard() {
    const board = Array(64).fill(null);
    for (let f = 0; f < 8; f++) {
        board[toIndex(0, f)] = { c: "b", t: backRank[f] };
        board[toIndex(1, f)] = { c: "b", t: "P" };
        board[toIndex(6, f)] = { c: "w", t: "P" };
        board[toIndex(7, f)] = { c: "w", t: backRank[f] };
    }
    return board;
}