// A fold: recompute absolutely, write differentially. Its own write wakes it
// again, and only an unchanged answer writing nothing lets the chain end.
({ context, event }) => {
  if (event.type === "refused") throw new Error(`store refused ${event.entity} (${event.kind})`);
  const board = (context.rows.board ?? [])[0];
  if (board === undefined) return { updates: [] };
  const lit = (context.rows.light ?? []).filter((l) => l.on === "yes").length;
  if (Number(board.lit) === lit) return { updates: [] };
  return { updates: [{ op: "patch", entity: "board", id: board.id, row: { lit } }] };
}
