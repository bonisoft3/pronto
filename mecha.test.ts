import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { compileMechaReducer } from "./mecha-reducer.ts";
import { moving } from "./mecha-contracts.ts";
import { walk } from "../omnishell/test/mecha-battery.ts";
import { executeMecha } from "../omnishell/test/mecha-local.ts";
import { fixture, initial, nestedFixture, request, run, terminal, timerFixture } from "./mecha-fixtures.ts";

Deno.test("mecha chart dispatches internal events, validates ownership, and projects private hands", async () => {
  const { spec, compiled } = await fixture();
  const step = async (state: unknown, event: unknown, actor = "a", tier = "omnishell") => await executeMecha(compiled.source, spec.fuel, { state, event, context: { actor, tier, now: 1000 }, viewers: ["a", "b"] }) as { kind: string; reason?: string; state: ReturnType<typeof initial>; views: { value: { hand: number[] } }[] };
  const first = await step(initial(), request(0).event);
  assertEquals(first.kind, "accepted");
  assertEquals(first.state.phase, "playing");
  assertEquals(first.views[0].value.hand, [1, 2]);
  assertEquals(first.views[1].value.hand, [3, 4, 5]);
  assertEquals(Object.keys(first.views[0].value).sort(), ["deadline", "hand", "opponent_count", "phase", "plays", "turn"]);
  assertEquals((await step(first.state, request(1, "play", { card: 1 }).event)).reason, "not_your_turn");
  assertEquals((await step(first.state, request(1, "play", { card: 1 }).event, "b")).reason, "not_your_card");
  assertEquals((await step(first.state, request(1, "play", { card: 3 }).event, "b")).state.plays.length, 2);
  await assertRejects(() => step(initial(), request(0, "timeout", {}).event), Error, "another tier");
  await assertRejects(() => step(initial(), request(0, "play", { card: 0, seat: "b" }).event), Error, "undeclared field");
});

Deno.test("a guard that answers false does not take the transition, as in XState", async () => {
  // A false guard threw out of the step, so a reader's command aborted with
  // no receipt; XState reads it as the transition not being enabled.
  const { spec, rules } = await fixture();
  const compiled = await compileMechaReducer(spec, rules.replace("yourTurn: ({context: state, event}) => event._origin === state.turn,", "yourTurn: () => true,").replace("holdsCard: ({context: state, event}) =>", "holdsCard: ({context: state, event}) => event.card !== 1 &&"), terminal);
  const step = async (state: unknown, event: unknown) => await executeMecha(compiled.source, spec.fuel, { state, event, context: { actor: "a", tier: "omnishell", now: 1000 }, viewers: ["a", "b"] }) as { kind: string; reason?: string; state: ReturnType<typeof initial> };
  const first = await step(initial(), request(0).event);
  const refused = await step(first.state, request(1, "play", { card: 1 }).event);
  assertEquals([refused.kind, refused.reason], ["rejected", "not_your_card"]);
  // A guard whose declaration states no reason refuses with "refused".
  const bare = { ...spec, contracts: { ...spec.contracts, holdsCard: { reads: spec.contracts!.holdsCard.reads } } };
  const unnamed = await compileMechaReducer(bare, rules.replace("yourTurn: ({context: state, event}) => event._origin === state.turn,", "yourTurn: () => true,").replace("holdsCard: ({context: state, event}) =>", "holdsCard: ({context: state, event}) => event.card !== 1 &&"), terminal);
  const again = await executeMecha(unnamed.source, bare.fuel, { state: first.state, event: request(1, "play", { card: 1 }).event, context: { actor: "a", tier: "omnishell", now: 1000 }, viewers: ["a", "b"] }) as { kind: string; reason?: string };
  assertEquals([again.kind, again.reason], ["rejected", "refused"]);
});

Deno.test("a machine no reader commands compiles no command table's triggers", async () => {
  // The surface check asks for <m>_command only where a reader has an event,
  // and the migration still created triggers on it, failing to apply.
  const { spec, rules } = await fixture();
  const inward = structuredClone(spec);
  for (const event of Object.values(inward.events)) event.tier = "mecha";
  // Nobody sends it, so nobody is its sender.
  inward.contracts!.yourTurn = {reads: []};
  inward.contracts!.holdsCard = {reads: ["card"]};
  const compiled = await compileMechaReducer(inward, rules, terminal);
  assertEquals(compiled.sql.includes(`${spec.name}_command`), false);
});

Deno.test("mecha compiler refuses incomplete protocols and ambient authority", async () => {
  const { spec, rules } = await fixture();
  await assertRejects(() => compileMechaReducer({ ...spec, initial: "missing" }, rules, terminal), Error, "initial state");
  const missing = structuredClone(spec);
  missing.states.playing.on.play.target = "missing";
  await assertRejects(() => compileMechaReducer(missing, rules, terminal), Error, "missing target");
  await assertRejects(() => compileMechaReducer(spec, "return {play: () => plv8.execute('SELECT 1')};", terminal), Error, "reach plv8");
  await assertRejects(() => compileMechaReducer(spec, "return {play: () => Date['now']()};", terminal), Error, "reach Date");
  const compiled = await compileMechaReducer(spec, rules.replace("play: ({context: state, event}) => putCard(state, event.card, event._time)", "play: () => Math['random']()"), terminal);
  await assertRejects(() => executeMecha(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] }), Error);
});

Deno.test("a command cannot carry hidden module state or replenish exhausted fuel", async () => {
  const { spec, rules } = await fixture();
  const stateful = await compileMechaReducer(spec, `let count = 0;\n${rules.replace("play: ({context: state, event}) => putCard(state, event.card, event._time)", "play: ({context: state, event}) => putCard(state, event.card, ++count)")}`, terminal);
  const input = { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] };
  assertEquals(await executeMecha(stateful.source, spec.fuel, input), await executeMecha(stateful.source, spec.fuel, input));
  const catches = await compileMechaReducer(spec, rules.replace("play: ({context: state, event}) => putCard(state, event.card, event._time)", "play: ({context: state}) => { try { while (true) {} } catch {} return {...state}; }"), terminal);
  await assertRejects(() => executeMecha(catches.source, spec.fuel, input), Error, "fuel limit exceeded");
  await assertRejects(() => compileMechaReducer(spec, "const __fuel = () => {}; " + rules, terminal), Error, "meter");
});

Deno.test("mecha input is immutable and reducers cannot bypass chart targets", async () => {
  const { spec, rules } = await fixture();
  for (const body of ["{ state.a.pop(); return state; }", "({ ...state, phase: 'finished' })"]) {
    const compiled = await compileMechaReducer(spec, rules.replace("play: ({context: state, event}) => putCard(state, event.card, event._time)", `play: ({context: state}) => ${body}`), terminal);
    await assertRejects(() => executeMecha(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] }), Error);
  }
});

Deno.test("automatic chart transitions settle inside the command and cannot cycle indefinitely", async () => {
  const {spec, rules} = await fixture();
  if (spec.state.type !== "object" || spec.state.fields.phase.type !== "string") throw new Error("invalid fixture");
  spec.state.fields.phase.values!.push("resolving");
  spec.state.fields.phase.maxLength = 9;
  spec.states.playing.on.play.target = "resolving";
  spec.states.resolving = {final: false, on: {}, always: [{target: "playing", reduce: "same"}]};
  spec.contracts!.same = {reads: [], writes: []};
  const source = rules.replace("return {", "return { same: ({context: state}) => ({...state}),");
  const input = {state: initial(), event: request(0).event, context: {actor: "a", tier: "omnishell", now: 0}, viewers: ["a"]};
  let compiled = await compileMechaReducer(spec, source, terminal);
  const answer = await executeMecha(compiled.source, spec.fuel, input) as {state: ReturnType<typeof initial>};
  assertEquals(answer.state.phase, "playing");
  assertEquals(answer.state.plays.length, 1);
  // A state that only ever returns to itself: the lint finds it, and a step
  // that reaches it stops at its bound.
  spec.states.resolving.always![0].target = "resolving";
  assertEquals(moving(spec), ["resolving is not final and nothing leaves it"]);
  compiled = await compileMechaReducer(spec, source, terminal);
  await assertRejects(() => executeMecha(compiled.source, spec.fuel, input), Error, "did not settle");
});

// An event every waiting state takes was a transition copied into each of
// them. XState states it once on the machine; a state that takes the same
// event as well is #App's to refuse.
Deno.test("a transition on the machine is taken in every state", async () => {
  const machine = {
    config: {id: "r", initial: "a", on: {stop: {target: "done"}, ping: {}}, states: {a: {on: {go: {target: "b"}}}, b: {}, done: {type: "final"}}},
    setup: {version: 1, guards: {}, actions: {}, types: {context: {type: "object", fields: {}}, view: {type: "object", fields: {}}, events: {
      stop: {tier: "omnishell", payload: {type: "object", fields: {}}}, ping: {tier: "omnishell", payload: {type: "object", fields: {}}},
      go: {tier: "omnishell", payload: {type: "object", fields: {}}}}}},
  };
  const reduced = await run("cue", ["export", "-", "-e", "reducer.states"],
    `package proof\nimport pronto "bonisoft.org/plugins/pronto"\nreducer: (pronto.#Reducer & {machine: ${JSON.stringify(machine)}}).out\n`);
  if (!reduced.ok) throw new Error(reduced.err);
  assertEquals(JSON.parse(reduced.out), {
    a: {final: false, on: {go: {target: "b"}, stop: {target: "done"}, ping: {}}},
    b: {final: false, on: {stop: {target: "done"}, ping: {}}},
    done: {final: true, on: {}},
  });
});

// An action returning the state it was given crashed the step setting its
// phase on a frozen object: a TypeError, where the rules had done nothing
// wrong. Any input a step can be given answers, or fails with a named error.
Deno.test("the runtime holds under any input a step can be given", async () => {
  const {spec, rules} = await fixture();
  const unchanged = rules.replace("finish: ({context: state}) => ({ ...state }),", "finish: ({context: state}) => state,");
  assertEquals(unchanged === rules, false, "the fixture's finish copies the state, which this replaces");
  for (const source of [rules, unchanged]) {
    const compiled = await compileMechaReducer(spec, source, terminal);
    const visited = new Set<string>();
    for (const seed of [1, 2, 3, 4]) {
      const walked = await walk(spec, compiled.source, initial(), ["a", "b"], seed, 150);
      assertEquals(walked.crashes, []);
      for (const p of walked.visited) visited.add(p);
    }
    assertEquals([...visited].sort(), ["finished", "playing"], "the walks play a hand out, where the action that hands back its state runs");
  }
});

// XState v5's `after`: entering a state starts its timers, measured from the
// step; leaving it cancels them; a step that stays without re-entering moves
// nothing, and `reenter: true` starts them again. The step leaves them to its
// host as XState's actions.
Deno.test("a state's after starts its timers at entry and cancels them at exit", async () => {
  const { spec, compiled } = await timerFixture();
  type Answer = { kind: string; reason?: string; state: { phase: string; count: number; turn_ms: number; expired_at: number }; actions?: unknown[] };
  const step = async (state: unknown, kind: string, tier = "omnishell", now = 1000) =>
    await executeMecha(compiled.source, spec.fuel, { state, event: { kind, payload: {} }, context: { actor: "a", tier, now }, viewers: ["a"] }) as Answer;
  const raise = (ms: number) => ({ type: "xstate.raise", params: { event: { type: "xstate.after.turn.running" }, id: "xstate.after.turn.running", delay: ms } });
  const cancel = { type: "xstate.cancel", params: { sendId: "xstate.after.turn.running" } };
  const created = await executeMecha(compiled.source, spec.fuel, { initialize: true, payload: { turn_ms: 20000 }, context: { tier: "mecha", now: 0 }, viewers: [] }) as Answer;
  assertEquals(created.actions, [raise(20000)], "creation enters the initial state");
  const running = created.state;
  for (const kind of ["nudge", "stay"]) {
    const stayed = await step(running, kind);
    assertEquals([stayed.kind, stayed.state.count, stayed.actions], ["accepted", 1, undefined], `${kind} moves no timer`);
  }
  assertEquals((await step(running, "restart")).actions, [cancel, raise(20000)]);
  assertEquals((await step({ ...running, turn_ms: 5 }, "restart")).actions, [cancel, raise(5)], "the delay is read at entry");
  const idle = await step(running, "stop");
  assertEquals([idle.state.phase, idle.actions], ["idle", [cancel]]);
  assertEquals((await step(idle.state, "start")).actions, [raise(20000)]);
  // The timer's event takes the delay's first arrow whose guard holds, at the
  // time the host delivered it.
  const expired = await step(running, "xstate.after.turn.running", "mecha", 7000);
  assertEquals([expired.state.phase, expired.state.expired_at, expired.actions], ["expired", 7000, [cancel]]);
  await assertRejects(() => step(running, "xstate.after.turn.running"), Error, "another tier");
  assertEquals((await step(idle.state, "xstate.after.turn.running", "mecha")).reason, "illegal_event");
  assertEquals((await step(running, "xstate.after.other.running", "mecha")).reason, "illegal_event");
  // A named delay is a duration the context holds when the state is entered.
  await assertRejects(() => compileMechaReducer({ ...spec, delays: {} }, "", terminal), Error, "delays does not declare");
  await assertRejects(() => compileMechaReducer({ ...spec, delays: { turn: "phase" } }, "", terminal), Error, "no integer the context holds");
});

// XState's nested states: a phase is the atomic state's path, a child takes
// the events its parent does, and the parent's timer keeps running while a
// child is entered and left, so the earlier of the two decides.
Deno.test("a compound state's timer runs on across its children, and its own events reach them", async () => {
  const { spec, compiled } = await nestedFixture();
  assertEquals(moving(spec), []);
  type Answer = { kind: string; reason?: string; state: { phase: string; lifts: number; timeouts: number }; actions?: { type: string; params: { id?: string; sendId?: string } }[] };
  const step = async (state: unknown, kind: string, tier = "omnishell") =>
    await executeMecha(compiled.source, spec.fuel, { state, event: { kind, payload: {} }, context: { actor: "a", tier, now: 1000 }, viewers: ["a"] }) as Answer;
  const timers = (answer: Answer) => (answer.actions ?? []).map((a) => `${a.type === "xstate.raise" ? "raise" : "cancel"} ${a.params.id ?? a.params.sendId}`);
  const started = await step({ phase: "waiting", lifts: 0, timeouts: 0 }, "start");
  assertEquals([started.state.phase, timers(started)], ["racing.open", ["raise xstate.after.150000.racing"]], "entering the parent enters its initial child");
  const closing = await step(started.state, "lift");
  assertEquals([closing.state.phase, timers(closing)], ["racing.closing", ["raise xstate.after.15000.racing.closing"]], "the parent's event reaches the child, which moves on without the parent's timer");
  for (const timer of ["xstate.after.15000.racing.closing", "xstate.after.150000.racing"]) {
    const ended = await step(closing.state, timer, "mecha");
    assertEquals([ended.state.phase, ended.state.timeouts], ["abandoned", 1], `${timer}: either clock abandons the race`);
    assertEquals(timers(ended), ["cancel xstate.after.15000.racing.closing", "cancel xstate.after.150000.racing"]);
  }
  assertEquals((await step(started.state, "xstate.after.15000.racing.closing", "mecha")).reason, "illegal_event", "a child's timer runs only in the child");
  await assertRejects(() => step({ phase: "racing", lifts: 0, timeouts: 0 }, "lift"), Error, "state.phase: invalid string");
});