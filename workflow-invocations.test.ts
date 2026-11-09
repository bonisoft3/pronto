import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { analyzeWorkflow } from "./check-workflows.ts";

Deno.test("a callback source cannot satisfy an invocation-completion wait", () => {
  const chart = { initial: "waiting", states: { waiting: { invoke: { src: "facts", onDone: "done" } }, done: { type: "final" } } };
  const result = analyzeWorkflow(chart, "workflow", { actors: { facts: { via: "observe", lifetime: "attachment" } } });
  const issue = result.find((o) => o.property === "workflow-outcome-producer");
  assertEquals(issue?.status, "violation");
  assert(issue?.reason.includes("does not publish"));
  assert(result.some((o) => o.property === "workflow-control-completion" && o.status === "violation"));
});

Deno.test("finite navigation belongs to its invoking state without making the shell finite", () => {
  const chart = { initial: "loading", states: {
    loading: { invoke: { src: "navigation", onDone: "ready", onError: "failed" } }, ready: {}, failed: {},
  } };
  const result = analyzeWorkflow(chart, "shell", { actors: { navigation: { via: "navigation" } } });
  assertEquals(result.filter((o) => o.property === "workflow-outcome-producer" && o.status === "satisfied").length, 2);
  assertEquals(result.find((o) => o.property === "workflow-applicability")?.status, "unchecked");
});

Deno.test("Snapcards generation effects have finite outcome producers within persistent row machines", async () => {
  const input = JSON.parse(await Deno.readTextFile(new URL("../../apps/snapcards/.pronto/check-inputs.json", import.meta.url)));
  const chart = input.cortex.GenerationMachine;
  const options = { actors: input.cortexImplementations.GenerationMachine.actors, effects: input.effects, entry: "persisted" as const };
  const result = analyzeWorkflow(chart, "GenerationMachine", options);
  assertEquals(result.filter((o) => o.property === "workflow-outcome-producer" && o.status === "satisfied").length, 4);
  assertEquals(result.filter((o) => o.status === "violation").length, 0);
  chart.states.drafting.invoke.src = "candidates";
  const mutation = analyzeWorkflow(chart, "GenerationMachine", options);
  assertEquals(mutation.filter((o) => o.property === "workflow-outcome-producer" && o.status === "violation").length, 1);
});

Deno.test("unknown invocation adapters do not acquire inferred cleanup or delivery", () => {
  const result = analyzeWorkflow({ initial: "waiting", states: { waiting: { invoke: { src: "custom", onDone: "done" } }, done: { type: "final" } } }, "custom", { actors: { custom: { via: "custom" } } });
  assertEquals(result.find((o) => o.property === "workflow-invocation-lifetime")?.status, "unchecked");
  assert(!result.some((o) => o.property === "workflow-outcome-producer" && o.status === "satisfied"));
});

Deno.test("Mecha source/effect name collisions resolve by the actual invocation namespace", () => {
  const result = analyzeWorkflow({ initial: "waiting", invoke: { src: "shared" }, states: { waiting: { invoke: { src: "shared", onDone: "done", onError: "done" } }, done: { type: "final" } } }, "emitted", {
    host: "mecha", actors: { shared: { via: "query", event: "facts" } }, effects: { shared: { sink: {} } },
  });
  assert(result.some((o) => o.property === "workflow-invocation-lifetime" && o.id.endsWith("$root:0") && o.reason.includes("query source")));
  assertEquals(result.filter((o) => o.property === "workflow-outcome-producer" && o.status === "satisfied").length, 2);
});

Deno.test("known attachment lifetime discharges cleanup when parallel control completes", () => {
  const region = { initial: "waiting", states: { waiting: { on: { finish: "done" } }, done: { type: "final" } } };
  const chart = { type: "parallel", invoke: { src: "rows" }, states: { first: region, second: region } };
  const report = analyzeWorkflow(chart, "parallel", { actors: { rows: { via: "rows", lifetime: "attachment" } } });
  assertEquals(report.find((o) => o.property === "workflow-proper-completion")?.status, "satisfied");
  const opaque = analyzeWorkflow(chart, "parallel", { actors: { rows: { via: "custom" } } });
  assertEquals(opaque.find((o) => o.property === "workflow-proper-completion")?.status, "unchecked");
});
