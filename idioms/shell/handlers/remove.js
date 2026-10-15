// `id` is the clicked row's key. A reduce never invents a key; it is handed one.
(state, event) =>
  event.type === "click" ? { updates: [{ op: "delete", id: event.id }] } : { updates: [] }
