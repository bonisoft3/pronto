import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { compileCortexDurable, type CortexDurable } from "./cortex-durable.ts";
import { terminal } from "./mecha-fixtures.ts";
import { executeMecha } from "../omnishell/test/mecha-local.ts";

import { spec, rules } from "./testdata/cortex-durable.ts";

Deno.test("durable Cortex uses the bounded Mecha reducer and keeps invalidation inside its invocation", async () => {
  const compiled = await compileCortexDurable(spec, rules, terminal);
  const step = (state: unknown, kind: string) => executeMecha(compiled.source, spec.machine.fuel, {
    state, event: { kind, payload: {} }, context: { tier: "mecha", now: 0 }, viewers: [],
  }) as Promise<{ kind: string; state: { phase: string; requested: number; wake: number } }>;
  const first = await step({ phase: "idle", requested: 0, wake: 0 }, "request");
  assertEquals(first.state, { phase: "active", requested: 1, wake: 1 });
  const pending = await step(first.state, "invalidate");
  assertEquals(pending.state, { phase: "active", requested: 2, wake: 1 });
  assertEquals((await step(pending.state, "done")).state, { phase: "idle", requested: 2, wake: 1 });
  assertEquals((await step(pending.state, "failed")).state.phase, "failed");
  assertEquals((await step(first.state, "request")).kind, "rejected");
  assertStringIncludes(compiled.sql, "PERFORM durex.enqueue_work('durable_test'");
  assertStringIncludes(compiled.sql, "game.state->>'phase' IS DISTINCT FROM 'active'");
  assertStringIncludes(compiled.sql, "(clock_timestamp() + interval '1 second')::timestamptz, (3)::integer");
  assert(compiled.sql.indexOf("UPDATE hybrid_durable_test.instance i SET state") < compiled.sql.indexOf("PERFORM durex.enqueue_work"));
  assert(!compiled.sql.includes("CREATE FUNCTION public."));
  assert(!compiled.sql.includes("TO app_user"));
  assert(!compiled.sql.includes("public.durable_test_seat"));
  assert(!compiled.sql.includes(".settle("));
  assertStringIncludes(compiled.sql, "PERFORM hybrid_durable_test.serial()");
  assert(!compiled.sql.includes("ALTER ROLE"));
});

Deno.test("durable Cortex refuses invoking graphs that bypass or cannot receive outcomes", async () => {
  const refuse = async (change: (draft: CortexDurable) => void, message: string) => {
    const draft = structuredClone(spec);
    change(draft);
    await assertRejects(() => compileCortexDurable(draft, rules, terminal), Error, message);
  };
  await refuse(d => { d.machine.events.done.tier = "omnishell"; }, "belong to Mecha");
  await refuse(d => { d.machine.ports = {}; }, "browser ports");
  await refuse(d => { d.machine.public = { type: "object", fields: {} }; }, "public projection");
  await refuse(d => { d.invoke.active.onDone = "missing"; }, "must leave");
  await refuse(d => { d.machine.states.active.on.done.target = "active"; }, "must leave");
  await refuse(d => { d.machine.states.active.on.invalidate.target = "idle"; }, "only Cortex outcomes");
  await refuse(d => { d.machine.states.active.always = [{ target: "idle", reduce: "keep" }]; }, "stable");
  await refuse(d => { d.machine.states.idle.always = [{ target: "active", reduce: "keep" }]; }, "stable target");
  await refuse(d => { d.machine.initial = "active"; }, "entry transition");
  await refuse(d => { d.invoke.active.task = "bad-task"; }, "invalid Cortex task");
  await refuse(d => { d.invoke.active.input = " "; }, "key and input SQL");
  await refuse(d => { d.invoke.active.runAtSql = ""; }, "SQL expressions");
  await refuse(d => { d.invoke = {}; }, "requires an invocation");
});
