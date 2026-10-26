import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { compileMechaPorts } from "./mecha-ports.ts";
import { compileMechaReducer, type MechaReducerMachine } from "./mecha-reducer.ts";
import { executeHybrid } from "./hybrid-local.ts";
import { fixture, initial, terminal } from "./testdata/hybrid-fixtures.ts";

Deno.test("initializers use the bounded input, initial-phase, invariant and projection checks", async () => {
  const {spec, rules} = await fixture();
  const initialized: MechaReducerMachine = {...spec, initialize: {reduce: "initial", input: {type: "object", fields: {}}}};
  const run = async (state = initial(), payload: unknown = {}) => {
    const compiled = await compileMechaReducer(initialized, `return {...(() => { ${rules} })(), initial: () => (${JSON.stringify(state)})};`, terminal);
    return await executeHybrid(compiled.source, spec.fuel, {initialize: true, payload, context: {tier: "mecha", now: 0}, viewers: ["a", "b"]}) as {state: unknown; views: {value: {hand: number[]}}[]};
  };
  const result = await run();
  assertEquals(result.state, initial());
  assertEquals(result.views.map(v => v.value.hand), [initial().a, initial().b]);
  await assertRejects(() => run(initial(), {undeclared: true}), Error, "undeclared field");
  await assertRejects(() => run({...initial(), phase: "finished"}), Error);
  await assertRejects(() => run({...initial(), a: [0, 0, 0]}), Error);
});

Deno.test("Mecha ports refuse unresolved composition and invalid authority before emission", async () => {
  const {spec} = await fixture();
  const compile = (machine: MechaReducerMachine) => compileMechaPorts({[machine.name]: machine});
  assertThrows(() => compile({...spec, ports: {join: {seat: "b", phases: ["playing"], event: "play"}}}), Error, "initialization");
  assertThrows(() => compile({...spec, ports: {wake: {phases: ["missing"], deadline: "deadline", event: "timeout"}}}), Error, "undeclared");
  assertThrows(() => compile({...spec, ports: {wake: {phases: ["playing"], deadline: "phase", event: "timeout"}}}), Error, "deadline");
  assertThrows(() => compile({...spec, ports: {wake: {phases: ["playing"], deadline: "deadline", event: "play"}}}), Error, "Mecha event");
  const admitted: MechaReducerMachine = {...spec, initialize: {reduce: "initial", input: {type: "object", fields: {}}},
    mecha: {...spec.mecha!, ports: {admission: {input: "'{}'::jsonb", members: "jsonb_build_object('a', current_actor)", locks: ""}}}};
  const admission = {name: "admit", params: [], id: "current_actor", checks: []};
  // A lease admits its reader as the instance, so it opens no instance by argument.
  assertThrows(() => compile({...admitted, ports: {admission: {...admission, params: [{name: "room", type: "uuid"}], id: "room"}, lease: {touch: "timeout", leave: "timeout", held: "phase"}}}), Error, "takes no arguments");
  assertThrows(() => compile({...admitted, ports: {admission: {...admission, id: "gen_random_uuid()"}, lease: {touch: "timeout", leave: "timeout", held: "phase"}}}), Error, "current_actor");
  assertThrows(() => compile({...admitted, ports: {admission, lease: {touch: "play", leave: "timeout", held: "phase"}}}), Error, "Mecha event");
  assertThrows(() => compile({...admitted, ports: {admission, lease: {touch: "timeout", leave: "timeout", held: "phase"}}}), Error, "lists the live sessions by id");
});

Deno.test("equivalent CUE field orders emit identical reducer programs without reordering transition priority", async () => {
  const {spec, rules} = await fixture();
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  const original = await compileMechaReducer(spec, rules, terminal);
  const reversed = await compileMechaReducer(reorder(spec) as MechaReducerMachine, rules, terminal);
  assertEquals(reversed, original);
});
