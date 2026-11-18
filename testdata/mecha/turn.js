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
  inTime: ({context: state, event}) => event._time < state.deadline,
  yourTurn: ({context: state, event}) => event._origin === state.turn,
  holdsCard: ({context: state, event}) => state[event._origin].includes(event.card),
  play: ({context: state, event}) => putCard(state, event.card, event._time),
  isDue: ({context: state, event}) => event._time >= state.deadline,
  hasCards: ({context: state}) => state[state.turn].length > 0,
  timeout: ({context: state, event}) => putCard(state, Math.min(...state[state.turn]), event._time),
  isComplete: ({context: state}) => state.a.length + state.b.length === 0,
  finish: ({context: state}) => ({ ...state }),
  project: (state, viewer) => ({
    phase: state.phase,
    turn: state.turn,
    hand: state[viewer],
    opponent_count: state[viewer === "a" ? "b" : "a"].length,
    plays: state.plays,
    deadline: state.deadline,
  }),
};
