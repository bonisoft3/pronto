import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { createActor, createMachine } from "../omnishell/interpreter/vendor/xstate.js";
import { analyzeWorkflow } from "./check-workflows.ts";

const finite = () => ({ id: "job", initial: "waiting", states: {
  waiting: { on: { start: "running", cancel: "done" } },
  running: { on: { finish: "done", retry: "waiting" } },
  done: { type: "final" },
} });
const check = (chart: unknown) => analyzeWorkflow(chart, "chart");
const get = (chart: unknown, property: string, suffix: string) => check(chart).find((o) => {
  const key = suffix.slice(1);
  return o.property === property && (o.id.endsWith(suffix) || o.id.endsWith(`.${key}`) || o.id.endsWith(`:${JSON.stringify(key)}`) || o.id.endsWith(`.${key.replace(":on.", ".on.")}`));
});

Deno.test("workflow soundness permits loops with an option to complete", () => {
  const report = check(finite());
  assert(report.length > 0);
  assert(report.every((o) => o.status === "satisfied"));
  assert(report.every((o) => o.authority && o.assumptions.length && o.coverageRoute === "derived"));
});

Deno.test("a reachable sink cannot hide behind an otherwise reachable final", () => {
  const chart = finite();
  chart.states.running.on = { finish: "running", retry: "running" };
  assertEquals(get(chart, "workflow-option-to-complete", ":running")?.status, "violation");
  assertEquals(get(chart, "workflow-option-to-complete", ":waiting")?.status, "satisfied");
});

Deno.test("opaque guards do not turn a structural counterexample into a reachable bug", () => {
  const chart = { initial: "start", states: {
    start: { on: { go: { guard: "canGo", target: "stuck" }, finish: "done" } },
    stuck: {}, done: { type: "final" },
  } };
  assertEquals(get(chart, "workflow-option-to-complete", ":stuck")?.status, "unchecked");
  assertEquals(get(chart, "workflow-state-reachability", ":stuck")?.status, "unchecked");
});

Deno.test("persistent services and nested completion do not acquire invented finite scope", () => {
  assertEquals(check({ initial: "idle", states: { idle: {} } })[0].property, "workflow-applicability");
  const nested = { initial: "active", states: { active: { initial: "done", states: { done: { type: "final" } } } } };
  assertEquals(check(nested)[0].status, "unchecked");
  assertEquals(check({ ...finite(), type: "parallel" })[0].status, "unchecked");
});

Deno.test("unreachable activities and shadowed branches are structural failures", () => {
  const chart = { initial: "start", states: {
    start: { on: { go: ["done", "orphan"] } },
    orphan: { on: { go: "done" } }, done: { type: "final" },
  } };
  assertEquals(get(chart, "workflow-state-reachability", ":orphan")?.status, "violation");
  assertEquals(get(chart, "workflow-activity-reachability", ":start:on.go:1")?.status, "violation");
});

Deno.test("invoked completion is inventoried without assuming its delivery or cleanup", () => {
  const chart = { initial: "running", states: {
    running: { invoke: { src: "worker", onDone: "done", onError: "failed" } },
    done: { type: "final" }, failed: { type: "final" },
  } };
  const report = check(chart);
  assertEquals(report.filter((o) => o.status === "violation").length, 0);
  assertEquals(get(chart, "workflow-option-to-complete", ":running")?.status, "unchecked");
  assertEquals(get(chart, "workflow-proper-completion", ":$root")?.status, "unchecked");
  assert(report.some((o) => o.evidence.some((item) => item.includes("invoke.0.onDone:0"))));
});

Deno.test("root event inheritance respects explicit local ignoring", () => {
  const chart = { initial: "start", on: { finish: ".done" }, states: {
    start: { on: { go: "stuck" } }, stuck: { on: { finish: {} } }, done: { type: "final" },
  } };
  assertEquals(get(chart, "workflow-option-to-complete", ":stuck")?.status, "violation");
});

Deno.test("a rejected local guard can leave an inherited root transition enabled", () => {
  const chart = { initial: "start", on: { finish: ".done" }, states: {
    start: { on: { finish: { guard: "notNow", target: "start" } } }, done: { type: "final" },
  } };
  assertEquals(get(chart, "workflow-state-reachability", ":done")?.status, "unchecked");
  assertEquals(check(chart).filter((o) => o.status === "violation").length, 0);
});

Deno.test("reenter changes lifecycle but does not create a new control destination", () => {
  const chart = { initial: "start", states: {
    start: { on: { retry: { target: "start", reenter: true }, finish: "done" } }, done: { type: "final" },
  } };
  assertEquals(check(chart).filter((o) => o.status !== "satisfied").length, 0);
});

Deno.test("unsupported control is not silently omitted from a completion verdict", () => {
  for (const patch of [{ on: { "*": "done" } }]) {
    const chart = finite();
    Object.assign(chart.states.running, patch);
    assert(!check(chart).some((o) => o.status === "violation"));
  }
});

Deno.test("root timers and invoked outcomes enter the projected graph without assumed delivery", () => {
  for (const patch of [{ after: { 10: ".done" } }, { invoke: { src: "source", onDone: ".done" } }]) {
    const report = check({ ...finite(), ...patch });
    assert(report.some((o) => o.property === "workflow-control-completion"));
    assertEquals(report.filter((o) => o.status === "violation").length, 0);
  }
  assert(check({ ...finite(), on: [] }).some((o) => o.status === "unchecked"));
});

Deno.test("emitted Mecha final control and effects retain their boundary", () => {
  const chart = { initial: "offered", states: {
    offered: { final: false, on: { accept: { target: "accepted", actions: [{ spawn: { machine: "child" } }] } } },
    accepted: { final: true, on: {} },
  } };
  assertEquals(get(chart, "workflow-option-to-complete", ":offered")?.status, "unchecked");
  assertEquals(get(chart, "workflow-proper-completion", ":$root")?.status, "unchecked");
});

Deno.test("real application workflow inventory keeps opaque semantics unchecked", async () => {
  const summaries: Record<string, { applicable: number; unchecked: number; violations: number }> = {};
  for (const app of ["snapcards", "truco", "apexrun", "golaberto"]) {
    const input = JSON.parse(await Deno.readTextFile(new URL(`../../apps/${app}/.pronto/check-inputs.json`, import.meta.url)));
    const report = Object.entries({ ...input.cortex, ...input.reducers }).flatMap(([name, chart]) => analyzeWorkflow(chart, name, { entry: "persisted" }));
    summaries[app] = {
      applicable: report.filter((o) => o.property === "workflow-option-to-complete").length,
      unchecked: report.filter((o) => o.status === "unchecked").length,
      violations: report.filter((o) => o.status === "violation").length,
    };
    assertEquals(summaries[app].violations, 0);
  }
  assert(summaries.truco.applicable > 0);
  assert(summaries.apexrun.applicable > 0);
  assert(summaries.snapcards.unchecked > 0);
});

Deno.test("the generated sink finding replays through the actual XState engine", () => {
  const chart = finite();
  chart.states.running.on = { finish: "running", retry: "running" };
  const actor = createActor(createMachine(chart)).start();
  actor.send({ type: "start" });
  assertEquals(actor.getSnapshot().value, "running");
  for (const type of ["finish", "retry", "cancel"]) {
    actor.send({ type });
    assertEquals(actor.getSnapshot().value, "running");
    assertEquals(actor.getSnapshot().status, "active");
  }
  assertEquals(get(chart, "workflow-option-to-complete", ":running")?.status, "violation");
  actor.stop();
});

Deno.test("terminal operations cannot be mistaken for an effect-free workflow", () => {
  for (const operation of [{ assign: { phase: "done" } }, { effect: { op: "delete" } }, { raise: "finish" }]) {
    for (const action of [operation, { actions: [operation] }]) {
      const chart = { field: "phase", initial: "start", states: {
        start: { on: { execute: { ...action, target: "done" } } }, done: { type: "final" },
      } };
      const coverage = check(chart).find((o) => o.property === "workflow-control-coverage");
      assertEquals(coverage?.status, "unchecked");
      assert(coverage?.evidence[0].includes("row operations"));
      assert(!check(chart).some((o) => o.property === "workflow-option-to-complete" && o.status === "satisfied"));
    }
  }
});

Deno.test("removing the real deck operation's completion edge exposes a dead declared final", async () => {
  const input = JSON.parse(await Deno.readTextFile(new URL("../../apps/snapcards/.pronto/check-inputs.json", import.meta.url)));
  const chart = input.reducers.deck_press;
  assertEquals(check(chart).filter((o) => o.status === "violation").length, 0);
  delete chart.states.active.on.finish_deck;
  assertEquals(get(chart, "workflow-state-reachability", ":completed")?.status, "violation");
  assertEquals(get(chart, "workflow-option-to-complete", ":active")?.status, "unchecked");
});

Deno.test("persisted control states do not acquire an initial-state reachability requirement", () => {
  const chart = { initial: "start", states: {
    start: { on: { finish: "done" } }, restored: { on: { finish: "done" } }, done: { type: "final" },
  } };
  assertEquals(get(chart, "workflow-state-reachability", ":restored")?.status, "violation");
  const persisted = analyzeWorkflow(chart, "mounted", { entry: "persisted" });
  assertEquals(persisted.filter((o) => o.status === "violation").length, 0);
  assertEquals(persisted.find((o) => o.property === "workflow-state-reachability" && o.id.endsWith(".restored"))?.status, "unchecked");
  assertEquals(persisted.find((o) => o.property === "workflow-option-to-complete" && o.id.endsWith(':"restored"'))?.status, "satisfied");
});

Deno.test("mounted parallel charts use independent terminal row regions with shared events", async () => {
  const { machineDeclarations, evaluateOutcomes } = await import("./check-outcomes.ts");
  const { expandTemplates } = await import("../omnishell/expand-templates.ts");
  const { machineEngine } = await import("../omnishell/interpreter/machine-engine.js");
  const chart = { type: "parallel", on: { finish: "done" }, states: {
    first: { field: "first_status", initial: "waiting", states: { waiting: {}, done: { type: "final" } } },
    second: { field: "second_status", initial: "waiting", states: { waiting: {}, done: { type: "final" } } },
  } };
  const html = `<div data-live="item" data-machine='${JSON.stringify(chart)}'></div>`;
  const mounts = machineDeclarations("parallel.html", html, expandTemplates).mounts;
  assertEquals(mounts.length, 1);
  const fields: string[] = [];
  const report = evaluateOutcomes({ entities: {}, types: { types: {}, aliases: {} }, mounts }, { omnishellEngine: (region, hooks) => {
    fields.push(region.field);
    return machineEngine(region, hooks);
  } });
  assertEquals(fields.sort(), ["first_status", "second_status"]);
  assertEquals(report.counts.violation, 0);
  for (const name of ["first", "second"]) {
    const items = report.obligations.filter((item) => item.path.endsWith(`#region:${name}`));
    assert(items.some((item) => item.property === "workflow-activity-reachability" && item.evidence.some((e) => e.includes("on.finish"))));
    assert(items.every((item) => !item.authority.includes("XState control exploration")));
  }
});
