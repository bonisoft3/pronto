return {
  invariant: () => true,
  project: state => ({lifts: state.lifts, timeouts: state.timeouts}),
  finishing: ({context: state}) => state.lifts > 0,
  lift: ({context: state}) => ({...state, lifts: state.lifts + 1}),
  timeout: ({context: state}) => ({...state, timeouts: state.timeouts + 1}),
};
