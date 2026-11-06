return {
  initialize: input => ({ phase: "idle", name: input.name, requested: input.revision, completed: input.revision,
    wake: 0, claimed: 0, required: [], due: 0, coalesce: input.coalesce, attempts: input.attempts }),
  project: () => ({}),
  invariant: state => state.completed <= state.requested && state.attempts > 0 &&
    (state.phase === "idle" ? state.wake === 0 && state.claimed === 0 :
      state.completed < state.wake && state.wake <= state.requested &&
      (state.claimed === 0 || state.wake <= state.claimed && state.claimed <= state.requested)),
  invalidate: state => ({ ...state, requested: state.requested + 1 }),
  pin: (state, event) => ({ ...state, required: event.payload.required }),
  pending: state => state.requested > state.completed || "no_work",
  schedule: (state, _event, context) => ({ ...state, wake: state.requested, due: context.now + state.coalesce }),
  unclaimed: state => state.claimed === 0 || "already_claimed",
  claim: state => ({ ...state, claimed: state.requested, required: [] }),
  claimed: state => state.claimed > state.completed || "no_claim",
  complete: state => ({ ...state, completed: state.claimed, claimed: 0, wake: 0, due: 0 }),
  newer: state => state.claimed > 0 && state.requested > state.claimed || "no_newer_work",
  supersede: state => ({ ...state, claimed: 0, wake: 0, due: 0 }),
};
