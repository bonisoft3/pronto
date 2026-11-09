import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { machineEngine } from "../omnishell/interpreter/machine-engine.js";
import { analyzeWorkflow } from "./check-workflows.ts";
import { exploreOmnishellWorkflow } from "./workflow-omnishell-control.ts";

Deno.test("terminal nested targets use the installed host's root fallback", () => {
  const chart = { field: "status", initial: "active", states: {
    active: { initial: "waiting", states: { waiting: { on: { finish: "done" } } } }, done: { type: "final" },
  } };
  const graph = exploreOmnishellWorkflow(chart, machineEngine);
  assert(graph.edges.some((edge) => edge.from === '"active.waiting"' && edge.to === '"done"'));
  assertEquals(graph.complete, true);
  const report = analyzeWorkflow(chart, "mounted", { entry: "persisted", host: "omnishell", omnishellEngine: machineEngine });
  assertEquals(report.filter((o) => o.status === "violation").length, 0);
});

Deno.test("terminal local guarded events shadow parent handlers even when declined", () => {
  const chart = { field: "status", initial: "waiting", on: { finish: "done" }, states: {
    waiting: { on: { finish: { guard: "decline", target: "waiting" } } }, done: { type: "final" },
  } };
  const graph = exploreOmnishellWorkflow(chart, machineEngine);
  assert(!graph.edges.some((edge) => edge.from === '"waiting"' && edge.to === '"done"'));
});

Deno.test("missing terminal host is an explicit gap rather than raw-XState interpretation", () => {
  const report = analyzeWorkflow({ field: "status", initial: "waiting", states: { waiting: { on: { finish: "done" } }, done: { type: "final" } } }, "mounted", { entry: "persisted", host: "omnishell" });
  assertEquals(report.length, 1);
  assertEquals(report[0].property, "workflow-host-coverage");
  assertEquals(report[0].status, "unchecked");
});

Deno.test("terminal always cycles use the host's cascade bound", () => {
  const graph = exploreOmnishellWorkflow({ field: "status", initial: "a", states: { a: { always: "b" }, b: { always: "a" }, done: { type: "final" } } }, machineEngine);
  assertEquals(graph.complete, false);
  assert(graph.gaps.some((gap) => gap.includes("cascade bound")));
});

Deno.test("shared timer delays remain available in each owning state", () => {
  const graph = exploreOmnishellWorkflow({ field: "status", initial: "a", states: { a: { after: { 10: "done" } }, b: { after: { 10: "done" } }, done: { type: "final" } } }, machineEngine);
  assert(graph.edges.some((edge) => edge.from === '"a"' && edge.to === '"done"'));
  assert(graph.edges.some((edge) => edge.from === '"b"' && edge.to === '"done"'));
});

Deno.test("terminal restored control and transitions retain uncertain feasibility", () => {
  const chart = { field: "status", initial: "waiting", states: { waiting: { on: { finish: "done" } }, done: { type: "final" } } };
  const graph = exploreOmnishellWorkflow(chart, machineEngine);
  assert(graph.configurations.every((state) => !state.certain));
  assert(graph.edges.every((edge) => !edge.certain));
  const report = analyzeWorkflow(chart, "mounted", { host: "omnishell", omnishellEngine: machineEngine, entry: "persisted" });
  assertEquals(report.find((o) => o.property === "workflow-option-to-complete" && o.id.endsWith(':"waiting"'))?.status, "unchecked");
});
