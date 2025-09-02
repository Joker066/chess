const order = ["K", "Q", "k", "q"];

export function removeCastleRight(s, ...codes) {    
    const set = new Set((s.castleRight || "").split(""));
    for (const c of codes) set.delete(c);
    s.castleRight = order.filter(x => set.has(x)).join("");
}