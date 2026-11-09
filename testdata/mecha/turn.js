const putCard = (state, card, now) => ({
  ...state,
  [state.turn]: state[state.turn].filter(c => c !== card),
  plays: [...state.plays, { seat: state.turn, card }],
  turn: state.turn === "a" ? "b" : "a",
  deadline: now + 20000,
});
return {
  invariant: state => {
    const cards = [...state.a, ...state.b, ...state.plays.map(p => p.card)];
    return cards.length === 6 && new Set(cards).size === 6;
  },
  mayPlay: (state, event, context) => {
    if (context.now >= state.deadline) return "expired";
    if (context.actor !== state.turn) return "not_your_turn";
    if (!state[context.actor].includes(event.payload.card)) return "not_your_card";
    return true;
  },
  play: (state, event, context) => putCard(state, event.payload.card, context.now),
  isDue: (state, _event, context) => context.now < state.deadline ? "not_due" : state[state.turn].length > 0 ? true : "no_cards",
  timeout: (state, _event, context) => putCard(state, Math.min(...state[state.turn]), context.now),
  isComplete: state => state.a.length + state.b.length === 0 ? true : "cards_remain",
  finish: state => ({ ...state }),
  project: (state, viewer) => ({
    phase: state.phase,
    turn: state.turn,
    hand: state[viewer],
    opponent_count: state[viewer === "a" ? "b" : "a"].length,
    plays: state.plays,
    deadline: state.deadline,
  }),
};
