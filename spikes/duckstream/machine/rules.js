const same = (state) => ({ ...state });
const matchesResult = (state, payload) => state.completed_attempt > 0 &&
  payload.attempt === state.completed_attempt && payload.revision === state.completed_revision;
const ownsAttempt = (state, event) => event.payload.attempt === state.attempt || "stale_attempt";
return {
  initialize: () => ({
    phase: "idle", requested: 0, claimed: 0, published: 0, attempt: 0,
    lease_until: 0, completed_attempt: 0, completed_revision: 0, artifact: "",
  }),
  project: same,
  same,
  invariant: (state) => state.requested >= state.claimed && state.claimed >= state.published &&
    state.completed_attempt <= state.attempt && state.completed_revision <= state.claimed &&
    (state.completed_attempt === 0 ? state.artifact === "" : state.artifact.length > 0) &&
    (state.phase === "idle" ? state.claimed === state.published : state.phase === "publishing" || state.claimed > state.published) &&
    (state.phase === "running" ? state.lease_until > 0 : state.lease_until === 0) &&
    (state.phase !== "publishing" || (state.completed_attempt === state.attempt && state.completed_revision === state.claimed)),
  invalidate: (state, event) => ({ ...state, requested: Math.max(state.requested, event.payload.revision) }),
  canClaim: (state, _event, context) => {
    if (state.requested <= state.published) return "no_work";
    if (state.attempt === Number.MAX_SAFE_INTEGER) return "attempt_exhausted";
    if (!Number.isSafeInteger(context.now) || context.now < 0 || context.now > Number.MAX_SAFE_INTEGER - 100) return "invalid_clock";
    return true;
  },
  claim: (state, _event, context) => ({
    ...state, claimed: state.phase === "idle" ? state.requested : state.claimed,
    attempt: state.attempt + 1, lease_until: context.now + 100,
  }),
  ownsAttempt,
  canExpire: (state, event, context) => {
    const owner = ownsAttempt(state, event);
    if (owner !== true) return owner;
    return context.now >= state.lease_until || "lease_active";
  },
  release: (state) => ({ ...state, lease_until: 0 }),
  canComplete: (state, event, context) => {
    const payload = event.payload;
    if (matchesResult(state, payload)) return payload.artifact === state.artifact || "conflicting_result";
    if (state.phase !== "running" || payload.attempt !== state.attempt) return "stale_attempt";
    if (payload.revision !== state.claimed) return "wrong_revision";
    if (context.now >= state.lease_until) return "lease_expired";
    return payload.artifact.length > 0 || "empty_artifact";
  },
  complete: (state, event) => matchesResult(state, event.payload) ? same(state) : ({
    ...state, completed_attempt: state.attempt,
    completed_revision: state.claimed, artifact: event.payload.artifact,
  }),
  hasResult: (state) => state.completed_attempt === state.attempt,
  canAcknowledge: (state, event) => matchesResult(state, event.payload) && event.payload.artifact === state.artifact &&
    (state.phase === "publishing" || state.completed_revision <= state.published) || "unknown_publication",
  acknowledge: (state) => ({ ...state, published: Math.max(state.published, state.completed_revision) }),
  isPublished: (state) => state.published === state.claimed,
};
