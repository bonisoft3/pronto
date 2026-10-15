import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { hybridInteraction } from "./hybrid-client.js";
import { compileHybrid } from "./hybrid.ts";
import { instrument } from "../omnishell/instrument.ts";
import { executeHybrid } from "./testdata/hybrid-local.ts";
import { fixture, initial, request } from "./testdata/hybrid-fixtures.ts";

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

Deno.test("hybrid compiler refuses incomplete protocols and ambient authority", async () => {
  const { spec, rules } = await fixture();
  await assertRejects(() => compileHybrid({ ...spec, initial: "missing" }, rules, instrument), Error, "initial state");
  const missing = structuredClone(spec);
  missing.states.playing.on.play.target = "missing";
  await assertRejects(() => compileHybrid(missing, rules, instrument), Error, "missing target");
  await assertRejects(() => compileHybrid(spec, "return {play: () => plv8.execute('SELECT 1')};", instrument), Error, "reach plv8");
  await assertRejects(() => compileHybrid(spec, "return {play: () => Date['now']()};", instrument), Error, "reach Date");
  const compiled = await compileHybrid(spec, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: () => Math['random']()"), instrument);
  await assertRejects(() => executeHybrid(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] }), Error);
});

Deno.test("a command cannot carry hidden module state or replenish exhausted fuel", async () => {
  const { spec, rules } = await fixture();
  const stateful = await compileHybrid(spec, `let count = 0;\n${rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: (state, event, context) => putCard(state, event.payload.card, ++count)")}`, instrument);
  const input = { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] };
  assertEquals(await executeHybrid(stateful.source, spec.fuel, input), await executeHybrid(stateful.source, spec.fuel, input));
  const catches = await compileHybrid(spec, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: (state) => { try { while (true) {} } catch {} return {...state}; }"), instrument);
  await assertRejects(() => executeHybrid(catches.source, spec.fuel, input), Error, "fuel limit exceeded");
  await assertRejects(() => compileHybrid(spec, "const __fuel = () => {}; " + rules, instrument), Error, "meter");
});

Deno.test("hybrid input is immutable and reducers cannot bypass chart targets", async () => {
  const { spec, rules } = await fixture();
  for (const body of ["{ state.a.pop(); return state; }", "({ ...state, phase: 'finished' })"]) {
    const compiled = await compileHybrid(spec, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", `play: (state) => ${body}`), instrument);
    await assertRejects(() => executeHybrid(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] }), Error);
  }
});

Deno.test("unknown outcomes survive reload; receipts and views may arrive in either order", () => {
  const command = { command_id: "one", request: request(0) };
  const outcome = { type: "outcome", value: { command_id: "one", kind: "accepted", revision: "1" } };
  const view = { type: "view", value: { revision: "1", value: { hand: [1, 2] } } };
  for (const events of [[outcome, view], [view, outcome]]) {
    let state = hybridInteraction({ phase: "ready", pending: null, outcome: null, view: { revision: "0", value: {} } }, { type: "submit", command });
    state = hybridInteraction(state, { type: "unknown", command_id: "one" });
    state = JSON.parse(JSON.stringify(state));
    state = hybridInteraction(state, { type: "retry" });
    assertEquals(state.pending, command);
    assertThrows(() => hybridInteraction(state, { type: "submit", command }), Error, "unresolved");
    state = hybridInteraction(state, events[0]);
    assertEquals(state.pending, command);
    state = hybridInteraction(state, events[1]);
    assertEquals(state.phase, "ready");
    assertEquals(state.pending, null);
    for (const duplicate of [outcome, view, { type: "unknown", command_id: "one" }]) assertEquals(hybridInteraction(state, duplicate), state);
    assertEquals(hybridInteraction(state, { type: "view", value: { revision: "0", value: {} } }), state);
  }
});

Deno.test("late refusal clears only its own pending intent and preserves the confirmed view", () => {
  const original = { phase: "ready", pending: null, outcome: null, view: { revision: "9007199254740993", value: {} } };
  const command = { command_id: "one", request: request("9007199254740993") };
  const state = hybridInteraction(original, { type: "submit", command });
  assertEquals(hybridInteraction(state, { type: "outcome", value: { command_id: "other", kind: "rejected", revision: "0" } }), state);
  const rejected = hybridInteraction(state, { type: "outcome", value: { command_id: "one", kind: "rejected", revision: "9007199254740993", reason: "expired" } });
  assertEquals(rejected.phase, "rejected");
  assertEquals(rejected.pending, null);
  assertEquals(rejected.view, original.view);
});

Deno.test("automatic chart transitions settle inside the command and cannot cycle indefinitely", async () => {
  const {spec, rules} = await fixture();
  if (spec.state.type !== "object" || spec.state.fields.phase.type !== "string") throw new Error("invalid fixture");
  spec.state.fields.phase.values!.push("resolving");
  spec.state.fields.phase.maxLength = 9;
  spec.states.playing.on.play.target = "resolving";
  spec.states.resolving = {final: false, on: {}, always: [{target: "playing", reduce: "same"}]};
  const source = rules.replace("return {", "return { same: state => ({...state}),");
  const input = {state: initial(), event: request(0).event, context: {actor: "a", tier: "omnishell", now: 0}, viewers: ["a"]};
  let compiled = await compileHybrid(spec, source, instrument);
  const answer = await executeHybrid(compiled.source, spec.fuel, input) as {state: ReturnType<typeof initial>};
  assertEquals(answer.state.phase, "playing");
  assertEquals(answer.state.plays.length, 1);
  spec.states.resolving.always![0].target = "resolving";
  compiled = await compileHybrid(spec, source, instrument);
  await assertRejects(() => executeHybrid(compiled.source, spec.fuel, input), Error, "did not settle");
});
