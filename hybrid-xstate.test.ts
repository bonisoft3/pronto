import assert from "node:assert/strict";
import { getQuickJS } from "npm:@tootallnate/quickjs-emscripten@0.23.0";
import { bundleHybridXState } from "./hybrid-xstate-bundle.ts";
import { compileMechaReducer, type MechaReducerMachine } from "./mecha-reducer.ts";
import { executeHybrid } from "./hybrid-local.ts";
import { run, terminal } from "./testdata/hybrid-fixtures.ts";

const row = { type: "object" as const, fields: { phase: { type: "string" as const, maxLength: 12, values: ["idle", "choose", "done"] }, count: { type: "integer" as const, min: 0, max: 1000 } } };
const spec: MechaReducerMachine = {
  name: "xstate_probe", version: 1, fuel: 10000, initial: "idle", state: row, view: row,
  events: { GO: { tier: "omnishell", payload: { type: "object", fields: {} } } },
  contracts: { admit: { reads: [] }, increment: { reads: [], writes: ["count"] }, zero: { reads: [] }, one: { reads: [] } },
  states: {
    idle: { final: false, on: { GO: { target: "choose", guard: "admit", reduce: "increment" } } },
    choose: { final: false, on: {}, always: [{ target: "idle", guard: "zero" }, { target: "done", guard: "one", reduce: "increment" }] },
    done: { final: true, on: {} },
  },
};
const rules = `return {invariant: () => true, project: state => state, admit: () => true,
  increment: state => ({...state, count: state.count + 1}), zero: state => state.count === 0, one: state => state.count === 1};`;
const input = () => ({ state: { phase: "idle", count: 0 }, event: { kind: "GO", payload: {} }, context: { tier: "omnishell", actor: "a", now: 0 }, viewers: ["a"] });

Deno.test("the hybrid XState expression reproduces the pinned bundle", async () => {
  assert.equal(await bundleHybridXState(), await Deno.readTextFile(new URL("hybrid-xstate.js", import.meta.url)));
});

Deno.test("hybrid control flow leaves relational actions and requirements with the SQL host", async () => {
  const expanded = structuredClone(spec);
  Object.assign(expanded.states.idle.on.GO, {
    requires: [{sql: "host_admission()", reason: "unavailable"}],
    actions: [{spawn: {machine: "child", id: "host-key", input: {}}}],
  });
  const compiled = await compileMechaReducer(expanded, rules, terminal);
  const answer = await executeHybrid(compiled.source, expanded.fuel, input()) as {state: unknown};
  assert.deepEqual(answer.state, {phase: "done", count: 2});
});

Deno.test("hybrid XState assigns before automatic guards in SES and QuickJS without host scheduling", async () => {
  const compiled = await compileMechaReducer(spec, rules, terminal);
  const expected = await executeHybrid(compiled.source, spec.fuel, input()) as { state: unknown };
  assert.deepEqual(expected.state, { phase: "done", count: 2 });
  const vm = (await getQuickJS()).newContext();
  const evaluate = (source: string) => {
    const result = vm.evalCode(source);
    if (result.error) {
      const message = JSON.stringify(vm.dump(result.error));
      result.error.dispose();
      throw Error(message);
    }
    const value = vm.dump(result.value);
    result.value.dispose();
    return value;
  };
  try {
    evaluate(`globalThis.harden = (value, seen = new Set()) => {
      if (value === null || !['object','function'].includes(typeof value) || seen.has(value)) return value;
      seen.add(value); Object.freeze(value);
      for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) for (const v of [d.value,d.get,d.set]) harden(v,seen);
      return value;
    };
    let spent = 0;
    globalThis.__fuel = () => { if (++spent > ${spec.fuel}) throw Error('fuel exhausted'); };
    const execute = (${compiled.source});`);
    assert.deepEqual(JSON.parse(evaluate(`execute(${JSON.stringify(JSON.stringify(input()))})`)), expected);
  } finally { vm.dispose(); }
  const refused = await compileMechaReducer(spec, rules.replace("admit: () => true", "admit: () => 'not_ready'"), terminal);
  assert.deepEqual(await executeHybrid(refused.source, spec.fuel, input()), { kind: "rejected", reason: "not_ready" });
  const broken = await compileMechaReducer(spec, rules.replace("one: state => state.count === 1", "one: () => 'not_ready'"), terminal);
  await assert.rejects(() => executeHybrid(broken.source, spec.fuel, input()), /automatic guard must return a boolean/);
});

Deno.test({ name: "the generated hybrid XState engine executes in native PLV8 and rolls back failures", ignore: !Deno.env.get("CORTEX_NATIVE_PG_CONTAINER"), fn: async () => {
  const container = Deno.env.get("CORTEX_NATIVE_PG_CONTAINER")!;
  const database = `hybrid_xstate_${crypto.randomUUID().replaceAll("-", "")}`;
  const sql = (db: string, source: string) => run("docker", ["exec", "-i", container, "psql", "-XqtA", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db], source);
  const must = async (db: string, source: string) => {
    const result = await sql(db, source);
    if (!result.ok) throw Error(result.err);
    return result.out;
  };
  const engine = (source: string) => {
    const found = source.match(/CREATE OR REPLACE FUNCTION hybrid_xstate_probe\.engine\(input jsonb\)[\s\S]*? AS (\$\w+\$)[\s\S]*?\1;/);
    if (!found) throw Error("generated hybrid engine is absent");
    return found[0];
  };
  const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  await must("postgres", `CREATE DATABASE ${database}`);
  try {
    const compiled = await compileMechaReducer(spec, rules, terminal);
    await must(database, `CREATE EXTENSION plv8; CREATE SCHEMA hybrid_xstate_probe; CREATE TABLE changes(n integer); INSERT INTO changes VALUES(0); ${engine(compiled.sql)}`);
    const expected = await executeHybrid(compiled.source, spec.fuel, input());
    assert.deepEqual(JSON.parse(await must(database, `SELECT hybrid_xstate_probe.engine(${literal(input())});`)), expected);
    const broken = await compileMechaReducer(spec, rules.replace("one: state => state.count === 1", "one: () => 'invalid'"), terminal);
    await must(database, engine(broken.sql));
    const refused = await sql(database, `BEGIN; UPDATE changes SET n=1; SELECT hybrid_xstate_probe.engine(${literal(input())}); COMMIT;`);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /automatic guard must return a boolean/);
    assert.equal(await must(database, "SELECT n FROM changes"), "0");
  } finally { await must("postgres", `DROP DATABASE ${database} WITH (FORCE)`); }
}});
