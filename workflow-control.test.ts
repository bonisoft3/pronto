import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { exploreWorkflowControl } from "./workflow-control.ts";
import { analyzeWorkflow } from "./check-workflows.ts";

Deno.test("hierarchical completion follows XState macrosteps through transient states", () => {
  const chart = { initial: "work", states: {
    work: { initial: "enter", states: { enter: { always: "waiting" }, waiting: { on: { finish: "complete" } }, complete: { type: "final" } }, onDone: "done" },
    done: { type: "final" },
  } };
  const graph = exploreWorkflowControl(chart);
  assertEquals(graph.complete, true);
  assertEquals(graph.configurations.map((c) => c.value), [{ work: "waiting" }, "done"]);
  assertEquals(graph.configurations.find((c) => c.done)?.trace, ["finish"]);
  const report = analyzeWorkflow(chart, "job");
  assert(report.some((o) => o.property === "workflow-option-to-complete" && o.status === "satisfied"));
  assertEquals(report.filter((o) => o.status === "violation").length, 0);
});

Deno.test("parallel completion requires both regions and explores both event orders", () => {
  const region = (event: string) => ({ initial: "pending", states: { pending: { on: { [event]: "done" } }, done: { type: "final" } } });
  const graph = exploreWorkflowControl({ type: "parallel", states: { left: region("leftDone"), right: region("rightDone") } });
  assertEquals(graph.complete, true);
  assertEquals(graph.configurations.length, 4);
  assertEquals(graph.configurations.filter((c) => c.done).length, 1);
  assert(graph.edges.some((edge) => edge.event === "leftDone"));
  assert(graph.edges.some((edge) => edge.event === "rightDone"));
});

Deno.test("effect opacity is local to an execution path, not every route in a chart", () => {
  const chart = { initial: "pending", states: {
    pending: { on: { finish: "done", compute: { target: "done", actions: "opaque" } } }, done: { type: "final" },
  } };
  const graph = exploreWorkflowControl(chart);
  assertEquals(graph.edges.find((e) => e.event === "finish")?.certain, true);
  assertEquals(graph.edges.find((e) => e.event === "compute")?.certain, false);
  assertEquals(graph.configurations.find((c) => c.done)?.certain, true);
});

Deno.test("guard alternatives preserve priority while enumerating possible control outcomes", () => {
  const chart = { initial: "pending", states: {
    pending: { on: { finish: [{ guard: "accepted", target: "done" }, { target: "failed" }, { target: "shadowed" }] } },
    done: { type: "final" }, failed: { type: "final" }, shadowed: { type: "final" },
  } };
  const graph = exploreWorkflowControl(chart);
  assertEquals(graph.configurations.map((c) => c.value).sort(), ["done", "failed", "pending"]);
  assert(!graph.visitedActivities.some((id) => id.endsWith("finish:2")));
});

Deno.test("always cycles consume a deterministic microstep budget instead of hanging lint", () => {
  const graph = exploreWorkflowControl({ initial: "a", states: { a: { always: "b" }, b: { always: "a" }, done: { type: "final" } } });
  assertEquals(graph.complete, false);
  assert(graph.gaps.some((gap) => gap.includes("microstep bound")));
});

Deno.test("persisted transient states receive their first event before eventless stabilization", () => {
  const chart = { initial: "transient", states: {
    transient: { always: "waiting", on: { cancel: "done" } }, waiting: {}, done: { type: "final" },
  } };
  const initial = exploreWorkflowControl(chart);
  assert(!initial.visitedActivities.some((id) => id.includes("on.cancel")));
  const persisted = exploreWorkflowControl(chart, { persisted: true });
  assert(persisted.visitedActivities.some((id) => id.includes("on.cancel")));
  assert(persisted.configurations.some((state) => state.value === "transient"));
});

Deno.test("native invocation outcomes are only scheduled while the invoking state is active", () => {
  const graph = exploreWorkflowControl({ initial: "waiting", states: {
    waiting: { invoke: { src: "work", onDone: "done" }, on: { cancel: "cancelled" } },
    done: { type: "final" }, cancelled: { type: "final" },
  } });
  const outcomes = graph.edges.filter((edge) => edge.event.startsWith("__workflow_invoke__"));
  assertEquals(outcomes.length, 1);
  assertEquals(outcomes[0].from, '"waiting"');
  assertEquals(outcomes[0].certain, false);
});

Deno.test("configuration limits never turn omitted control states into dead transitions", () => {
  const report = analyzeWorkflow({ initial: "work", states: {
    work: { initial: "one", states: { one: { on: { next: "two" } }, two: { on: { next: "done" } }, done: { type: "final" } }, onDone: "done" },
    done: { type: "final" },
  } }, "limited", { maxConfigurations: 1 });
  assert(report.some((o) => o.property === "workflow-control-coverage" && o.status === "unchecked"));
  assertEquals(report.filter((o) => o.status === "violation").length, 0);
});

Deno.test("a finite nested operation is checked even when its parent service persists", () => {
  const chart = { initial: "operation", states: {
    operation: { initial: "waiting", states: { waiting: { on: { finish: "done" } }, done: { type: "final" } }, onDone: "idle" },
    idle: { on: { again: "operation" } },
  } };
  const report = analyzeWorkflow(chart, "persistent");
  assertEquals(report.filter((o) => o.property === "workflow-control-completion").length, 0);
  assert(report.some((o) => o.property === "workflow-scope-completion" && o.status === "satisfied"));
  chart.states.operation.states.waiting.on.finish = "waiting";
  assert(analyzeWorkflow(chart, "persistent").some((o) => o.property === "workflow-scope-completion" && o.status === "violation"));
});

Deno.test("restarting a scope is not evidence that the existing operation can complete", () => {
  const chart = { initial: "operation", states: {
    operation: { id: "op", initial: "check", states: {
      check: { always: [{ guard: "fail", target: "stuck" }, { target: "done" }] },
      stuck: { on: { retry: { target: "#op", reenter: true } } }, done: { type: "final" },
    }, onDone: "idle" }, idle: {},
  } };
  const findings = analyzeWorkflow(chart, "restart").filter((o) => o.property === "workflow-scope-completion" && o.evidence.some((item) => item.includes('"stuck"')));
  assert(findings.length > 0);
  assert(findings.every((o) => o.status !== "satisfied"));
});

Deno.test("an unhandled host wake stabilizes a restored transient state", () => {
  const chart = { initial: "done", states: { pending: { always: "done" }, done: { type: "final" } } };
  const graph = exploreWorkflowControl(chart, { persisted: true });
  assert(graph.edges.some((edge) => edge.from === '"pending"' && edge.to === '"done"' && edge.event.startsWith("__workflow_wake__") && !edge.certain));
  const report = analyzeWorkflow(chart, "restored", { entry: "persisted" });
  assert(!report.some((o) => o.property === "workflow-activity-reachability" && o.id.endsWith(".pending.always:0") && o.status === "violation"));
  assertEquals(report.find((o) => o.property === "workflow-option-to-complete" && o.id.endsWith(':"pending"'))?.status, "unchecked");
});

Deno.test("certainty propagates through configurations first explored by an opaque path", () => {
  const chart = { initial: "start", states: {
    start: { on: { opaque: { target: "x", actions: "effect" }, first: "b" } },
    b: { on: { next: "x" } }, x: { on: { finish: "done" } }, done: { type: "final" },
  } };
  const graph = exploreWorkflowControl(chart);
  assert(graph.certainActivities.includes("workflow.x.on.finish:0"));
  assert(graph.certainStates.includes("workflow.done"));
  const report = analyzeWorkflow(chart, "upgrade");
  assertEquals(report.find((o) => o.property === "workflow-activity-reachability" && o.id.endsWith(".x.on.finish:0"))?.status, "satisfied");
  assertEquals(report.find((o) => o.property === "workflow-state-reachability" && o.id.endsWith(".done"))?.status, "satisfied");
});
