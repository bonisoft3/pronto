import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { compileHybrid } from "./hybrid.ts";
import { moving } from "./mecha-contracts.ts";
import { walk } from "./hybrid-battery.ts";
import { executeHybrid } from "./hybrid-local.ts";
import { fixture, initial, request, run, terminal } from "./testdata/hybrid-fixtures.ts";

Deno.test("hybrid chart dispatches internal events, validates ownership, and projects private hands", async () => {
  const { spec, compiled } = await fixture();
  const step = async (state: unknown, event: unknown, actor = "a", tier = "omnishell") => await executeHybrid(compiled.source, spec.fuel, { state, event, context: { actor, tier, now: 1000 }, viewers: ["a", "b"] }) as { kind: string; reason?: string; state: ReturnType<typeof initial>; views: { value: { hand: number[] } }[] };
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
  const compiled = await compileHybrid(spec, rules.replace("mayPlay: (state, event, context) => {", "mayPlay: (state, event, context) => {\n    if (event.payload.card === 1) return false;"), terminal);
  const step = async (state: unknown, event: unknown) => await executeHybrid(compiled.source, spec.fuel, { state, event, context: { actor: "a", tier: "omnishell", now: 1000 }, viewers: ["a", "b"] }) as { kind: string; reason?: string; state: ReturnType<typeof initial> };
  const first = await step(initial(), request(0).event);
  const refused = await step(first.state, request(1, "play", { card: 1 }).event);
  assertEquals([refused.kind, refused.reason], ["rejected", "refused"]);
});

Deno.test("a machine no reader commands compiles no command table's triggers", async () => {
  // The surface check asks for <m>_command only where a reader has an event,
  // and the migration still created triggers on it, failing to apply.
  const { spec, rules } = await fixture();
  const inward = structuredClone(spec);
  for (const event of Object.values(inward.events)) event.tier = "mecha";
  // Nobody sends it, so nobody is its sender.
  inward.contracts!.mayPlay = {reads: ["now", "payload.card"]};
  const compiled = await compileHybrid(inward, rules, terminal);
  assertEquals(compiled.sql.includes(`${spec.name}_command`), false);
});

Deno.test("hybrid compiler refuses incomplete protocols and ambient authority", async () => {
  const { spec, rules } = await fixture();
  await assertRejects(() => compileHybrid({ ...spec, initial: "missing" }, rules, terminal), Error, "initial state");
  const missing = structuredClone(spec);
  missing.states.playing.on.play.target = "missing";
  await assertRejects(() => compileHybrid(missing, rules, terminal), Error, "missing target");
  await assertRejects(() => compileHybrid(spec, "return {play: () => plv8.execute('SELECT 1')};", terminal), Error, "reach plv8");
  await assertRejects(() => compileHybrid(spec, "return {play: () => Date['now']()};", terminal), Error, "reach Date");
  const compiled = await compileHybrid(spec, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: () => Math['random']()"), terminal);
  await assertRejects(() => executeHybrid(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] }), Error);
});

Deno.test("a command cannot carry hidden module state or replenish exhausted fuel", async () => {
  const { spec, rules } = await fixture();
  const stateful = await compileHybrid(spec, `let count = 0;\n${rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: (state, event, context) => putCard(state, event.payload.card, ++count)")}`, terminal);
  const input = { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] };
  assertEquals(await executeHybrid(stateful.source, spec.fuel, input), await executeHybrid(stateful.source, spec.fuel, input));
  const catches = await compileHybrid(spec, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: (state) => { try { while (true) {} } catch {} return {...state}; }"), terminal);
  await assertRejects(() => executeHybrid(catches.source, spec.fuel, input), Error, "fuel limit exceeded");
  await assertRejects(() => compileHybrid(spec, "const __fuel = () => {}; " + rules, terminal), Error, "meter");
});

Deno.test("hybrid input is immutable and reducers cannot bypass chart targets", async () => {
  const { spec, rules } = await fixture();
  for (const body of ["{ state.a.pop(); return state; }", "({ ...state, phase: 'finished' })"]) {
    const compiled = await compileHybrid(spec, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", `play: (state) => ${body}`), terminal);
    await assertRejects(() => executeHybrid(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] }), Error);
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
  const source = rules.replace("return {", "return { same: state => ({...state}),");
  const input = {state: initial(), event: request(0).event, context: {actor: "a", tier: "omnishell", now: 0}, viewers: ["a"]};
  let compiled = await compileHybrid(spec, source, terminal);
  const answer = await executeHybrid(compiled.source, spec.fuel, input) as {state: ReturnType<typeof initial>};
  assertEquals(answer.state.phase, "playing");
  assertEquals(answer.state.plays.length, 1);
  // A state that only ever returns to itself: the lint finds it, and a step
  // that reaches it stops at its bound.
  spec.states.resolving.always![0].target = "resolving";
  assertEquals(moving(spec), ["resolving is not final and nothing leaves it"]);
  compiled = await compileHybrid(spec, source, terminal);
  await assertRejects(() => executeHybrid(compiled.source, spec.fuel, input), Error, "did not settle");
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
  const unchanged = rules.replace("finish: state => ({ ...state }),", "finish: state => state,");
  assertEquals(unchanged === rules, false, "the fixture's finish copies the state, which this replaces");
  for (const source of [rules, unchanged]) {
    const compiled = await compileHybrid(spec, source, terminal);
    const visited = new Set<string>();
    for (const seed of [1, 2, 3, 4]) {
      const walked = await walk(spec, compiled.source, initial(), ["a", "b"], seed, 150);
      assertEquals(walked.crashes, []);
      for (const p of walked.visited) visited.add(p);
    }
    assertEquals([...visited].sort(), ["finished", "playing"], "the walks play a hand out, where the action that hands back its state runs");
  }
});
