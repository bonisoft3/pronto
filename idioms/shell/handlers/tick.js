// A machine's assign: the value `n` takes on this transition.
(state) => Number(state.items[0]?.n ?? 0) + 1
