// The id is the datum: "r2c3" names the light. One press writes five lights and
// the move count, each update naming its entity when it is not the region's.
// Total over any rows: the battery calls every handler with generated ones.
(state, event) => {
  const lights = new Map((state.rows.light ?? []).map((l) => [l.id, l.on]));
  const board = (state.rows.board ?? [])[0];
  if (event.type !== "click" || board === undefined || !lights.has(event.id)) return { updates: [] };
  const r = Number(event.id[1]);
  const c = Number(event.id[3]);
  const flips = [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
    .map(([y, x]) => `r${y}c${x}`)
    .filter((id) => lights.has(id))
    .map((id) => ({ op: "patch", entity: "light", id, row: { on: lights.get(id) === "yes" ? "no" : "yes" } }));
  const moves = { op: "patch", entity: "board", id: board.id, row: { moves: Number(board.moves) + 1 } };
  return { updates: [...flips, moves] };
}
