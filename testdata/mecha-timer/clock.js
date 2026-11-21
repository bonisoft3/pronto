return {
  initial: ({input}) => ({phase: "running", count: 0, turn_ms: input.turn_ms, expired_at: 0}),
  invariant: () => true,
  project: state => ({...state}),
  never: () => false,
  count: ({context: state}) => ({...state, count: state.count + 1}),
  expire: ({context: state, event}) => ({...state, expired_at: event._time}),
};
