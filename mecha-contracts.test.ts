import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { carries, contracted, moving } from "./mecha-contracts.ts";
import { compileMechaReducer, type MechaReducerMachine } from "./mecha-reducer.ts";
import { executeHybrid } from "./hybrid-local.ts";
import { fixture, initial, terminal } from "./testdata/hybrid-fixtures.ts";

const contract = (spec: MechaReducerMachine, rule: string, reads: string[], writes?: string[]): MechaReducerMachine =>
  ({...spec, contracts: {...spec.contracts, [rule]: writes ? {reads, writes} : {reads}}});

// Truco's timeout ran the envido refusal with the wake's context, which carries
// no sender, and paid the side of a seat that was null. An action reading the
// sender is a finding where an event of the machine's own tier reaches it.
Deno.test("an input a rule reads must be carried by every event that reaches it", async () => {
  const {spec} = await fixture();
  assertEquals(carries(spec), []);
  assertEquals(carries(contract(spec, "timeout", ["now", "actor"], spec.contracts!.timeout.writes)),
    ["timeout reads actor, which timeout (a mecha event) does not carry into playing"]);
  // The guard runs before the action on both events, and each is a finding.
  assertEquals(carries(contract(spec, "isDue", ["now", "payload.card"])), ["isDue reads payload.card, which timeout (a mecha event) does not carry into playing"]);
  assertEquals(carries(contract(spec, "finish", ["entropy"], [])), ["finish reads entropy, which finish (a mecha event) does not carry into playing"]);
});

Deno.test("the rules an event reaches include every automatic transition after it", async () => {
  const {spec} = await fixture();
  const chained: MechaReducerMachine = {...spec, states: {...spec.states,
    playing: {...spec.states.playing, on: {...spec.states.playing.on, timeout: {guard: "isDue", reduce: "timeout", target: "settling"}}},
    settling: {final: false, on: {}, always: [{guard: "mayPlay", target: "playing"}]}}};
  assertEquals(carries(chained), [
    "mayPlay reads actor, which timeout (a mecha event) does not carry into playing",
    "mayPlay reads payload.card, which timeout (a mecha event) does not carry into playing",
  ]);
});

Deno.test("every rule states a contract, and an action writes only what the context holds", async () => {
  const {spec} = await fixture();
  const {isDue: _, ...rest} = spec.contracts!;
  assertThrows(() => contracted({...spec, contracts: rest}), Error, "isDue states no contract");
  assertThrows(() => contracted(contract(spec, "finish", [], ["score"])), Error, "finish writes score, which the context does not hold");
  assertThrows(() => contracted(contract(spec, "finish", [], ["phase"])), Error, "finish writes phase");
  assertThrows(() => contracted(contract(spec, "isDue", ["now"], ["turn"])), Error, "guard isDue writes");
  // A contract stated as a guard's, for a rule the chart runs as an action,
  // crashed its first step on the writes it never listed.
  assertThrows(() => contracted(contract(spec, "finish", [])), Error, "finish is an action, and its contract lists no writes");
});

Deno.test("a rule is handed only the inputs it reads, and refused a write it did not declare", async () => {
  const {spec, rules} = await fixture();
  const step = async (machine: MechaReducerMachine, source = rules) => {
    const compiled = await compileMechaReducer(machine, source, terminal);
    return await executeHybrid(compiled.source, machine.fuel, {state: initial(), event: {kind: "play", payload: {card: 0}},
      context: {actor: "a", tier: "omnishell", now: 0}, viewers: ["a", "b"]}) as {kind: string; state: {turn: string}};
  };
  assertEquals((await step(spec)).state.turn, "b");
  // The action reads the sender its contract leaves out.
  await assertRejects(() => step(contract(spec, "play", ["payload.card"], spec.contracts!.play.writes)), Error, "play reads now outside its contract");
  await assertRejects(() => step(contract(spec, "mayPlay", ["now", "actor"])), Error, "mayPlay reads payload.card outside its contract");
  // A spread of the context passes over what the rule was not handed.
  const spread = rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now),",
    "play: (state, event, context) => putCard(state, event.payload.card, ({...context}).now),");
  assertEquals((await step(spec, spread)).state.turn, "b");
  await assertRejects(() => step(contract(spec, "play", ["now", "payload.card"], ["a", "b", "plays", "deadline"])), Error, "play writes turn outside its contract");
});

// A wake phase that did not take the wake's event had its delivery refused on
// every tick, and a waiting state with no way out held its instance for good.
Deno.test("a machine cannot stop where nothing moves it on", async () => {
  const {spec} = await fixture();
  assertEquals(moving(spec), []);
  const stuck: MechaReducerMachine = {...spec, states: {...spec.states,
    playing: {...spec.states.playing, on: {...spec.states.playing.on, finish: {...spec.states.playing.on.finish, target: "parked"}}},
    parked: {final: false, on: {}}}};
  assertEquals(moving(stuck), ["parked is not final and nothing leaves it"]);
  // A transition back into itself moves nothing on.
  assertEquals(moving({...stuck, states: {...stuck.states, parked: {final: false, on: {timeout: {guard: "isDue", reduce: "timeout"}}}}}), ["parked is not final and nothing leaves it"]);
  // Unreachable, it holds nothing.
  assertEquals(moving({...spec, states: {...spec.states, parked: {final: false, on: {}}}}), []);
  assertEquals(moving({...spec, ports: {wake: {phases: ["playing"], deadline: "deadline", event: "expire"}}}),
    ["the ticker wakes playing with expire, which playing does not take"]);
  assertEquals(moving({...spec, ports: {wake: {phases: ["playing"], deadline: "deadline", event: "timeout"}}}), []);
});
