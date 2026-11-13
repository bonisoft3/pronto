return {
  initialize: ({input}) => ({ phase: "idle", name: input.name, requested: input.revision, completed: input.revision,
    wake: 0, claimed: 0, required: [], due: 0, coalesce: input.coalesce, attempts: input.attempts }),
  project: () => ({}),
  invariant: state => state.completed <= state.requested && state.attempts > 0 &&
    (state.phase === "idle" ? state.wake === 0 && state.claimed === 0 :
      state.completed < state.wake && state.wake <= state.requested &&
      (state.claimed === 0 || state.wake <= state.claimed && state.claimed <= state.requested)),
  invalidate: ({context: state}) => ({ ...state, requested: state.requested + 1 }),
  pin: ({context: state, event}) => ({ ...state, required: event.required }),
  pending: ({context: state}) => state.requested > state.completed,
  schedule: ({context: state, event}) => ({ ...state, wake: state.requested, due: event._time + state.coalesce }),
  unclaimed: ({context: state}) => state.claimed === 0,
  claim: ({context: state}) => ({ ...state, claimed: state.requested, required: [] }),
  claimed: ({context: state}) => state.claimed > state.completed,
  complete: ({context: state}) => ({ ...state, completed: state.claimed, claimed: 0, wake: 0, due: 0 }),
  newer: ({context: state}) => state.claimed > 0 && state.requested > state.claimed,
  supersede: ({context: state}) => ({ ...state, claimed: 0, wake: 0, due: 0 }),
};
