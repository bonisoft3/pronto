// Asking for a draw is returning `then: {seed: true}`; the terminal calls back
// with `event.seed`, a uint32 that ?seed= replays.
(state, event) => {
  const row = state.items[0];
  if (row === undefined) return { updates: [] };
  if (event.type === "click") return { updates: [], then: { type: "drawn", seed: true } };
  if (event.type === "drawn") return { updates: [{ op: "patch", id: row.id, row: { face: 1 + (event.seed % 6) } }] };
  return { updates: [] };
}
