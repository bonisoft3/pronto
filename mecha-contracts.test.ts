import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { carries, contracted, moving } from "./mecha-contracts.ts";
import { compileMechaReducer, type MechaReducerMachine } from "./mecha-reducer.ts";
import { executeMecha } from "../omnishell/test/mecha-local.ts";
import { fixture, initial, terminal } from "./mecha-fixtures.ts";

const contract = (spec: MechaReducerMachine, rule: string, reads: string[], writes?: string[]): MechaReducerMachine =>
  ({...spec, contracts: {...spec.contracts, [rule]: writes ? {reads, writes} : {reads}}});

// Truco's timeout ran the envido refusal with the wake's context, which carries
// no sender, and paid the side of a seat that was null. An action reading the
// sender is a finding where an event of the machine's own tier reaches it.
Deno.test("an input a rule reads must be carried by every event that reaches it", async () => {
  const {spec} = await fixture();
  assertEquals(carries(spec), []);
  assertEquals(carries(contract(spec, "timeout", ["_time", "_origin"], spec.contracts!.timeout.writes)),
    ["timeout reads _origin, which timeout (a mecha event) does not carry into playing"]);
  // The guard runs before the action on both events, and each is a finding.
  assertEquals(carries(contract(spec, "isDue", ["_time", "card"])), ["isDue reads card, which timeout (a mecha event) does not carry into playing"]);
  assertEquals(carries(contract(spec, "finish", ["_entropy"], [])), ["finish reads _entropy, which finish (a mecha event) does not carry into playing"]);
  // A timer's event is the machine's own, and carries no sender either.
  const timed: MechaReducerMachine = {...spec, states: {...spec.states, playing: {...spec.states.playing, after: {"1000": [{guard: ["yourTurn"], reduce: "finish"}]}}}};
  assertEquals(carries(timed), ["yourTurn reads _origin, which xstate.after.1000.playing (a mecha event) does not carry into playing"]);
});

Deno.test("the rules an event reaches include every automatic transition after it", async () => {
  const {spec} = await fixture();
  const chained: MechaReducerMachine = {...spec, states: {...spec.states,
    playing: {...spec.states.playing, on: {...spec.states.playing.on, timeout: {guard: ["isDue"], reduce: "timeout", target: "settling"}}},
    settling: {final: false, on: {}, always: [{guard: ["yourTurn", "holdsCard"], target: "playing"}]}}};
  assertEquals(carries(chained), [
    "yourTurn reads _origin, which timeout (a mecha event) does not carry into playing",
    "holdsCard reads _origin, which timeout (a mecha event) does not carry into playing",
    "holdsCard reads card, which timeout (a mecha event) does not carry into playing",
  ]);
});

// A payload field named `type` replaced the event's own name on the event a
// rule is handed.
Deno.test("no payload field takes the event's own name", async () => {
  const {spec} = await fixture();
  const [name, event] = Object.entries(spec.events).find(([, e]) => e.payload.type === "object")!;
  const named = {...spec, events: {...spec.events, [name]: {...event, payload: {...event.payload, fields: {...(event.payload as {fields: object}).fields, type: {type: "string"}}}}}};
  assertThrows(() => contracted(named as MechaReducerMachine), Error, `event ${name} carries a payload field type, which is the event's own name`);
});

Deno.test("every rule states a contract, and an action writes only what the context holds", async () => {
  const {spec} = await fixture();
  const {isDue: _, ...rest} = spec.contracts!;
  assertThrows(() => contracted({...spec, contracts: rest}), Error, "isDue states no contract");
  assertThrows(() => contracted(contract(spec, "finish", [], ["score"])), Error, "finish writes score, which the context does not hold");
  assertThrows(() => contracted(contract(spec, "finish", [], ["phase"])), Error, "finish writes phase");
  assertThrows(() => contracted(contract(spec, "isDue", ["_time"], ["turn"])), Error, "guard isDue writes");
  // An action that only moves the phase lists no field, and is still no guard.
  assertThrows(() => contracted(contract(spec, "isDue", ["_time"], [])), Error, "guard isDue writes");
  const spaced: MechaReducerMachine = {...spec, states: {...spec.states, playing: {...spec.states.playing, on: {...spec.states.playing.on, timeout: {...spec.states.playing.on.timeout, guard: ["is due"]}}}}};
  assertThrows(() => contracted(spaced), Error, `rule "is due" is not a name`);
  // A contract stated as a guard's, for a rule the chart runs as an action,
  // crashed its first step on the writes it never listed.
  assertThrows(() => contracted(contract(spec, "finish", [])), Error, "finish is an action, and its contract lists no writes");
});

Deno.test("a rule is handed only the inputs it reads, and refused a write it did not declare", async () => {
  const {spec, rules} = await fixture();
  const step = async (machine: MechaReducerMachine, source = rules) => {
    const compiled = await compileMechaReducer(machine, source, terminal);
    return await executeMecha(compiled.source, machine.fuel, {state: initial(), event: {kind: "play", payload: {card: 0}},
      context: {actor: "a", tier: "omnishell", now: 0}, viewers: ["a", "b"]}) as {kind: string; state: {turn: string}};
  };
  assertEquals((await step(spec)).state.turn, "b");
  // The action reads the sender its contract leaves out.
  await assertRejects(() => step(contract(spec, "play", ["card"], spec.contracts!.play.writes)), Error, "play reads _time outside its contract");
  await assertRejects(() => step(contract(spec, "holdsCard", ["_origin"])), Error, "holdsCard reads card outside its contract");
  // A spread of the context passes over what the rule was not handed.
  const spread = rules.replace("play: ({context: state, event}) => putCard(state, event.card, event._time),",
    "play: ({context: state, event}) => putCard(state, event.card, ({...event})._time),");
  assertEquals((await step(spec, spread)).state.turn, "b");
  await assertRejects(() => step(contract(spec, "play", ["_time", "card"], ["a", "b", "plays", "deadline"])), Error, "play writes turn outside its contract");
});

// A waiting state with no way out held its instance for good.
Deno.test("a machine cannot stop where nothing moves it on", async () => {
  const {spec} = await fixture();
  assertEquals(moving(spec), []);
  const stuck: MechaReducerMachine = {...spec, states: {...spec.states,
    playing: {...spec.states.playing, on: {...spec.states.playing.on, finish: {...spec.states.playing.on.finish, target: "parked"}}},
    parked: {final: false, on: {}}}};
  assertEquals(moving(stuck), ["parked is not final and nothing leaves it"]);
  // A transition back into itself moves nothing on.
  assertEquals(moving({...stuck, states: {...stuck.states, parked: {final: false, on: {timeout: {guard: ["isDue"], reduce: "timeout"}}}}}), ["parked is not final and nothing leaves it"]);
  // Unreachable, it holds nothing.
  assertEquals(moving({...spec, states: {...spec.states, parked: {final: false, on: {}}}}), []);
  // A timer that leaves it moves it on.
  assertEquals(moving({...stuck, states: {...stuck.states, parked: {final: false, on: {}, after: {"1000": [{target: "finished"}]}}}}), []);
});
