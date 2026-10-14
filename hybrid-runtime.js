(spec, rules) => {
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const fail = (message) => { throw new Error(`hybrid ${spec.name}: ${message}`); };
  const check = (shape, value, path) => {
    if (shape.type === "string") {
      if (typeof value !== "string" || value.length > shape.maxLength || (shape.values && !shape.values.includes(value))) fail(`${path}: invalid string`);
    } else if (shape.type === "integer") {
      if (!Number.isSafeInteger(value) || value < shape.min || value > shape.max) fail(`${path}: invalid integer`);
    } else if (shape.type === "boolean") {
      if (typeof value !== "boolean") fail(`${path}: invalid boolean`);
    } else if (shape.type === "array") {
      if (!Array.isArray(value) || value.length > shape.maxItems) fail(`${path}: invalid array`);
      value.forEach((v, i) => check(shape.items, v, `${path}[${i}]`));
    } else if (shape.type === "object") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path}: invalid object`);
      for (const key of Object.keys(value)) if (!own(shape.fields, key)) fail(`${path}.${key}: undeclared field`);
      for (const [key, field] of Object.entries(shape.fields)) {
        if (!own(value, key)) fail(`${path}.${key}: missing field`);
        check(field, value[key], `${path}.${key}`);
      }
    } else fail(`${path}: unknown shape`);
  };
  const validState = (state) => {
    check(spec.state, state, "state");
    if (!own(spec.states, state.phase)) fail(`unknown phase ${state.phase}`);
    if (rules.invariant(state) !== true) fail("state invariant failed");
  };
  const project = (state, viewers) => viewers.map((viewer) => {
    const view = rules.project(state, viewer);
    check(spec.view, view, "view");
    return { viewer, value: view };
  });
  return (input) => {
    const { state, event, context, viewers } = harden(input);
    if (input.initialize === true) {
      if (!spec.initialize) fail("initialization is not declared");
      check(spec.initialize.input, input.payload, "input");
      const seeded = rules[spec.initialize.reduce](input.payload, context);
      validState(seeded);
      if (seeded.phase !== spec.initial) fail("initializer must select the initial phase");
      return {state: seeded, views: project(seeded, viewers)};
    }
    validState(state);
    if (event === null) return { state, views: project(state, viewers) };
    if (!own(spec.events, event.kind)) fail("undeclared event");
    const definition = spec.events[event.kind];
    if (definition.tier !== context.tier) fail("event belongs to another tier");
    check(definition.payload, event.payload, "payload");
    const phase = spec.states[state.phase];
    const transition = phase.on[event.kind];
    if (phase.final || !own(phase.on, event.kind)) return { kind: "rejected", reason: "illegal_event" };
    if (transition.guard) {
      const verdict = rules[transition.guard](state, event, context);
      if (typeof verdict === "string" && verdict.length > 0 && verdict.length <= 64) return { kind: "rejected", reason: verdict };
      if (verdict !== true) fail("guard must return true or a refusal code");
    }
    const apply = (previous, arrow) => {
      const next = rules[arrow.reduce](harden(previous), event, context);
      if (next.phase !== previous.phase) fail("a reducer cannot select the target state");
      next.phase = arrow.target ?? previous.phase;
      validState(next);
      return next;
    };
    let next = apply(state, transition);
    for (let steps = 0; ; steps++) {
      const arrow = (spec.states[next.phase].always ?? []).find(t => {
        if (!t.guard) return true;
        const verdict = rules[t.guard](harden(next), event, context);
        if (typeof verdict !== "boolean") fail("automatic guard must return a boolean");
        return verdict;
      });
      if (!arrow) break;
      if (steps >= 100) fail("automatic transitions did not settle");
      next = apply(next, arrow);
    }
    return { kind: "accepted", state: next, views: project(next, viewers) };
  };
}
