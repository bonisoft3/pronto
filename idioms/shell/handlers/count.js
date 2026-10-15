// A handler is this one arrow and nothing else: no import, no export. `from` is
// the clicked element's id; every update names its op.
(state, event) => {
  const row = state.items[0];
  if (event.type !== "click" || row === undefined) return { updates: [] };
  // Stay inside the field's CEL bound: a refused write reaches only a region
  // declaring data-on-mutation, so here it would vanish without a word.
  const n = Math.max(-99, Math.min(99, Number(row.n) + (event.from === "inc" ? 1 : -1)));
  if (n === Number(row.n)) return { updates: [] };
  return { updates: [{ op: "patch", id: row.id, row: { n } }] };
}
