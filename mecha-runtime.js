(spec, rules, Statechart) => {
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const fail = (message) => { throw new Error(`mecha ${spec.name}: ${message}`); };
  // What a caller sent that the machine does not take, told apart from a
  // failure of the machine or its rules.
  const refuse = (message) => {
    throw Object.defineProperty(new Error(`mecha ${spec.name}: ${message}`), "name", {value: "RefusedError"});
  };
  const check = (shape, value, path, fault = fail) => {
    if (shape.type === "string") {
      if (typeof value !== "string" || value.length > shape.maxLength || (shape.values && !shape.values.includes(value))) fault(`${path}: invalid string`);
    } else if (shape.type === "integer") {
      if (!Number.isSafeInteger(value) || value < shape.min || value > shape.max) fault(`${path}: invalid integer`);
    } else if (shape.type === "boolean") {
      if (typeof value !== "boolean") fault(`${path}: invalid boolean`);
    } else if (shape.type === "array") {
      if (!Array.isArray(value) || value.length > shape.maxItems) fault(`${path}: invalid array`);
      value.forEach((v, i) => check(shape.items, v, `${path}[${i}]`, fault));
    } else if (shape.type === "object") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) fault(`${path}: invalid object`);
      for (const key of Object.keys(value)) if (!own(shape.fields, key)) fault(`${path}.${key}: undeclared field`);
      for (const [key, field] of Object.entries(shape.fields)) {
        if (!own(value, key)) fault(`${path}.${key}: missing field`);
        check(field, value[key], `${path}.${key}`, fault);
      }
    } else fault(`${path}: unknown shape`);
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
  // Null is an instance nobody else sees.
  const publish = (state) => {
    if (!spec.public) return {};
    const value = rules.publish(state);
    if (value !== null) check(spec.public, value, "public");
    return { public: value };
  };
  // A rule is one argument, XState's `{context, event}`, and the event holds
  // every input the step has beside the context: its type, its payload's
  // fields, and what the runtime states, each under the underscore SCXML
  // reserves for the platform: the sender as `_origin`, the step's `_time`
  // and its `_entropy`. A rule is handed the fields its contract reads. Any
  // other is a getter that refuses, and is not enumerable, so a spread of the
  // event passes over it rather than reading it.
  const stated = {_origin: "actor", _time: "now", _entropy: "entropy"};
  const refused = (target, key, rule) => Object.defineProperty(target, key, {get: () => fail(`${rule} reads ${key} outside its contract`), enumerable: false});
  const handed = (rule, event, host) => {
    const reads = spec.contracts[rule].reads;
    const given = {type: event.kind};
    for (const [key, value] of [...Object.entries(event.payload), ...Object.entries(stated).map(([key, from]) => [key, host[from]])]) {
      if (reads.includes(key)) given[key] = value;
      else refused(given, key, rule);
    }
    return harden(given);
  };
  const kept = (rule, previous, next) => {
    const writes = spec.contracts[rule].writes;
    for (const key of Object.keys(spec.state.fields)) {
      if (key !== "phase" && !writes.includes(key) && JSON.stringify(previous[key]) !== JSON.stringify(next[key])) fail(`${rule} writes ${key} outside its contract`);
    }
  };
  // A transition's guards are XState's `and`, in order; the chart takes them as one name.
  const control = ({target, guard, reduce}) => ({target, guard: guard?.join(" "), reduce});
  const chart = {initial: spec.initial, states: Object.fromEntries(Object.entries(spec.states).map(([name, state]) => [name, {
    final: state.final, on: Object.fromEntries(Object.entries(state.on).map(([event, arrow]) => [event, control(arrow)])),
    always: (state.always ?? []).map(control),
  }]))};
  const step = Statechart(chart, {
    // A guard is XState's: it answers a boolean. The first that answers
    // false refuses the event, with the reason its contract states.
    guard: (state, names, event, automatic) => {
      for (const name of names.split(" ")) {
        const verdict = rules[name](harden({context: state, event: handed(name, event.original, event.host)}));
        if (typeof verdict !== "boolean") fail(`guard ${name} must return a boolean`);
        if (verdict) continue;
        if (automatic) return false;
        event.refusal = spec.contracts[name].reason ?? "refused";
        throw new Error(event.refusal);
      }
      return true;
    },
    reduce: (previous, transition, event) => {
      const reduced = transition.reduce ? rules[transition.reduce](harden({context: previous, event: handed(transition.reduce, event.original, event.host)})) : previous;
      if (reduced.phase !== previous.phase) fail("a reducer cannot select the target state");
      if (transition.reduce) kept(transition.reduce, previous, reduced);
      const next = {...reduced, phase: transition.target ?? previous.phase};
      validState(next);
      return next;
    },
  });
  return (input) => {
    const { state, event, context, viewers } = harden(input);
    if (input.initialize === true) {
      if (!spec.initialize) refuse("initialization is not declared");
      check(spec.initialize.input, input.payload, "input", refuse);
      // XState's context factory, `({input})`. Whoever creates an actor states
      // its input, and the runtime creates every instance: it adds the step's
      // `_time` there, as it states an event's.
      const seeded = rules[spec.initialize.reduce](harden({input: own(context, "now") ? {...input.payload, _time: context.now} : input.payload}));
      validState(seeded);
      if (seeded.phase !== spec.initial) fail("initializer must select the initial phase");
      return {state: seeded, views: project(seeded, viewers), ...publish(seeded)};
    }
    validState(state);
    if (event === null) return { state, views: project(state, viewers), ...publish(state) };
    if (!own(spec.events, event.kind)) refuse("undeclared event");
    const definition = spec.events[event.kind];
    if (definition.tier !== context.tier) refuse("event belongs to another tier");
    check(definition.payload, event.payload, "payload", refuse);
    const phase = spec.states[state.phase];
    if (phase.final || !own(phase.on, event.kind)) return { kind: "rejected", reason: "illegal_event" };
    const message = {kind: event.kind, original: event, host: context, refusal: null};
    let next;
    try {
      next = step(state, message);
    } catch (error) {
      if (message.refusal === null) throw error;
      return {kind: "rejected", reason: message.refusal};
    }
    return { kind: "accepted", state: next, views: project(next, viewers), ...publish(next) };
  };
}
