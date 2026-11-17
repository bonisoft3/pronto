// A machine's assign: the value `n` takes on this transition.
({ context }) => Number(context.items[0]?.n ?? 0) + 1
