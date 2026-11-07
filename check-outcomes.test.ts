import { assertEquals, assert } from "jsr:@std/assert@1.0.13";
import { expandTemplates } from "../omnishell/expand-templates.ts";
import { resolveMachineMarkup } from "../omnishell/interpreter/lint.ts";
import { checkApp, evaluateOutcomes, loadOutcomeInputs, machineDeclarations, type OutcomeInputs } from "./check-outcomes.ts";

const app = new URL("../../apps/snapcards/", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, app));

Deno.test("Snapcards observed producer phases use the actual invocation and attempt mapping", async () => {
  const inputs = await loadOutcomeInputs(app.pathname, { expandTemplates, resolveMachineMarkup });
  const shell = JSON.parse(await read("shell/shell.json"));
  const mount = inputs.mounts!.find((mount) => mount.table === "generation_form")!;
  assert(mount, "the authored chart reference must contribute an outcome mount");
  const chart = mount.chart as { states: Record<string, { on: Record<string, unknown> }> };
  const input: OutcomeInputs = { ...inputs, actors: shell.actors, mounts: [mount] };
  const report = evaluateOutcomes(input);
  assertEquals(report.counts.violation, 0);
  const outcome = (r: ReturnType<typeof evaluateOutcomes>) => r.obligations.find((o) => o.id.includes("generating:generationProgress:signal:deck_progress.failed"));
  assertEquals(outcome(report)?.status, "satisfied");
  delete chart.states.generating.on["signal:deck_progress.failed"];
  assertEquals(outcome(evaluateOutcomes(input))?.status, "violation");
  chart.states.generating.on["signal:deck_progress.failed"] = { guard: "opaque", target: "failed" };
  assertEquals(outcome(evaluateOutcomes(input))?.status, "unchecked");
  delete shell.actors.generationProgress.match.run;
  const correlation = evaluateOutcomes(input).obligations.find((o) => o.property === "attempt-correlation" && o.id.includes("generating:generationProgress"));
  assertEquals(correlation?.status, "unchecked");
  assert(!correlation?.evidence.some((v) => v.startsWith("run ->")));
});

Deno.test("backend source and invocation contract inventory", () => {
  const input: OutcomeInputs = {
    entities: {}, types: { types: {}, aliases: {} },
    cortex: { work: { meta: { host: "mecha" }, invoke: { src: "query" }, states: { waiting: { on: { result: "done" } } } } },
    cortexImplementations: { work: { actors: { query: { via: "query", event: "result" } } } },
    machines: { work: { states: { waiting: { invoke: { src: "remote", onDone: "done", onError: "failed" } } } } },
  };
  const initial = evaluateOutcomes(input);
  assertEquals(initial.counts.violation, 0);
  assertEquals(initial.obligations.find((o) => o.property === "source-consumer")?.status, "unchecked");
  assertEquals(initial.obligations.find((o) => o.id.endsWith(":onError"))?.status, "satisfied");
  delete input.cortex!.work.states!.waiting.on!.result;
  delete input.machines!.work.states!.waiting.invoke!.onError;
  assertEquals(evaluateOutcomes(input).counts.violation, 2);
});

Deno.test("other applications do not acquire invented source vocabularies", async () => {
  for (const name of ["truco", "apexrun", "golaberto"]) {
    const report = await checkApp(new URL(`../../apps/${name}/`, import.meta.url).pathname, { expandTemplates, resolveMachineMarkup });
    assertEquals(report.counts.violation, 0);
    assert(!report.obligations.some((o) => o.property === "outcome-consumer" && o.status === "violation"));
  }
});

Deno.test("root query handlers and unsupported nested handling do not become violations", () => {
  const input: OutcomeInputs = {
    entities: {}, types: { types: {}, aliases: {} },
    cortex: { row: { meta: { host: "mecha" }, invoke: { src: "query" }, on: { result: "done" }, states: { waiting: {} } } },
    cortexImplementations: { row: { actors: { query: { via: "query", event: "result" } } } },
  };
  assertEquals(evaluateOutcomes(input).counts.violation, 0);
  delete input.cortex!.row.on!.result;
  input.cortex!.row.states!.waiting.states = { nested: {} };
  assertEquals(evaluateOutcomes(input).counts.violation, 0);
});

Deno.test("unknown actors and inert transitions remain unchecked", () => {
  const input: OutcomeInputs = {
    entities: {}, types: { types: {}, aliases: {} },
    actors: { child: { via: "session" }, observer: { via: "observe", missing: "missing" } },
    mounts: [{ path: "screen.html", table: "form", index: 0, chart: { states: { active: { invoke: [{ src: "child" }, { src: "observer" }], on: { missing: {} } } } } }],
  };
  const get = () => evaluateOutcomes(input).obligations;
  assertEquals(get().find((o) => o.property === "source-contract")?.status, "unchecked");
  assertEquals(get().find((o) => o.property === "outcome-consumer")?.status, "satisfied");
  assert(get().find((o) => o.property === "outcome-consumer")!.reason.includes("intentionally ignores"));
  for (const value of [null, false, [], "", { actions: [] }]) {
    input.mounts![0].chart.states!.active.on!.missing = value;
    assertEquals(get().find((o) => o.property === "outcome-consumer")?.status, "unchecked");
  }
});

Deno.test("finite observation phases require explicit dispositions, including intentional ignores", () => {
  const input: OutcomeInputs = {
    entities: { Job: { table: "job", fields: [{ name: "id", type: "string" }] }, Form: { table: "form", fields: [{ name: "job_id", type: "string" }] } },
    types: { types: { string: { json: "string" } }, aliases: {} },
    machines: { Job: { entity: "Job", field: "status", states: { queued: {}, running: {}, done: {} } } },
    actors: { progress: { via: "observe", table: "job", field: "status", event: "job.", match: { id: "job_id" } } },
    mounts: [{ path: "screen.html", table: "form", index: 0, chart: { states: { waiting: { invoke: { src: "progress" }, on: { "job.done": "done" } }, done: {} } } }],
  };
  const outcomes = () => evaluateOutcomes(input).obligations.filter((o) => o.property === "outcome-consumer");
  assertEquals(outcomes().filter((o) => o.status === "violation").length, 2);
  input.mounts![0].chart.states!.waiting.on!["job.queued"] = {};
  input.mounts![0].chart.states!.waiting.on!["job.running"] = {};
  assertEquals(outcomes().filter((o) => o.status === "violation").length, 0);
  assertEquals(outcomes().filter((o) => o.reason.includes("intentionally ignores")).length, 2);
  input.actors!.progress.match!.id = "missing_field";
  assertEquals(evaluateOutcomes(input).obligations.find((o) => o.property === "correlation-binding")?.status, "violation");
});

Deno.test("outcome obligations include machines inside nested item templates", () => {
  const chart = { states: { waiting: { invoke: { src: "observer" } } } };
  const html = `<div data-live="parents"><template data-item><section data-live="children"><template data-item><div data-live="form" data-machine='${JSON.stringify([chart, chart])}'></div></template></section></template></div>`;
  const { mounts } = machineDeclarations("nested.html", html, expandTemplates);
  assertEquals(mounts.map((m) => [m.table, m.index]), [["form", 0], ["form", 1]]);
  const report = evaluateOutcomes({
    entities: {}, types: { types: {}, aliases: {} }, mounts,
    actors: { observer: { via: "observe", missing: "gone" } },
  });
  assertEquals(report.obligations.filter((o) => o.property === "outcome-consumer").map((o) => o.status), ["violation", "violation"]);
});

Deno.test("inert and renderer-owned markup does not declare mounted actors", () => {
  const machine = `<div data-live="form" data-machine='{"states":{"waiting":{"invoke":{"src":"observer"}}}}'></div>`;
  for (const html of [
    `<template>${machine}</template>`,
    `<template data-item data-name="unused">${machine}</template>`,
    `<div data-text-format="custom">${machine}</div>`,
  ]) assertEquals(machineDeclarations("screen.html", html, expandTemplates).mounts, []);
});

Deno.test("referenced template actors are inventoried per instance", () => {
  const markup = `<template data-item data-name="shared"><div data-live="form" data-machine='{"states":{"waiting":{"invoke":{"src":"unknown"}}}}'></div></template><div data-live="a" data-template="shared"></div><div data-live="b" data-template="shared"></div>`;
  const declared = machineDeclarations("screen.html", markup, expandTemplates);
  assertEquals(declared.mounts.map((m) => [m.table, m.index]), [["form", 0], ["form", 1]]);
  assertEquals(declared.gaps, []);
  const report = evaluateOutcomes({ entities: {}, types: { types: {}, aliases: {} }, mounts: declared.mounts });
  assertEquals(report.obligations.filter((o) => o.property === "source-contract").length, 2);
});

Deno.test("unknown, ambiguous and recursive template references leave explicit gaps", () => {
  const instance = `<div data-live="items" data-template="shared"></div>`;
  for (const [definition, reason] of [
    ["", "unknown"],
    [`<template data-item data-name="shared"><div></div></template>`.repeat(2), "ambiguous"],
    [`<template data-item data-name="shared">${instance}</template>`, "recursive"],
  ]) {
    const declared = machineDeclarations("screen.html", instance + definition, expandTemplates);
    assertEquals(declared.gaps.map((g) => g.reason), [reason]);
    const report = evaluateOutcomes({ entities: {}, types: { types: {}, aliases: {} }, mounts: declared.mounts, mountGaps: declared.gaps });
    assertEquals(report.obligations.map((o) => [o.property, o.status]), [["mount-coverage", "unchecked"]]);
  }
});

Deno.test("invalid item declarations cannot inventory mounts", () => {
  const machine = `<div data-live="form" data-machine='{"states":{"waiting":{"invoke":{"src":"observer"}}}}'></div>`;
  const invalid = `<div data-live="items"><template data-item>${machine}<div></div></template></div>`;
  const both = `<div data-live="items" data-template="shared"><template data-item>${machine}</template></div><template data-item data-name="shared">${machine}</template>`;
  for (const markup of [invalid, both]) {
    const declared = machineDeclarations("screen.html", markup, expandTemplates);
    assertEquals(declared.mounts, []);
    assertEquals(declared.gaps.length, 1);
    assertEquals(evaluateOutcomes({ entities: {}, types: { types: {}, aliases: {} }, mountGaps: declared.gaps }).obligations[0].status, "unchecked");
  }
});

Deno.test("terminal navigation completion and failure are app obligations", () => {
  const input: OutcomeInputs = {
    entities: {}, types: { types: {}, aliases: {} },
    cortex: { app: { meta: { host: "omnishell" }, states: { page: { states: { loading: { invoke: { src: "navigate", onDone: "ready" } } } } } } },
    cortexImplementations: { app: { actors: { navigate: { via: "navigation" } } } },
  };
  assertEquals(evaluateOutcomes(input).obligations.filter((item) => item.property === "navigation-outcome").map((item) => item.status).sort(), ["satisfied", "violation"]);
  (input.cortex!.app.states!.page.states!.loading.invoke as { onError?: string }).onError = "failed";
  assertEquals(evaluateOutcomes(input).counts.violation, 0);
});

function rowFamilyInput(): OutcomeInputs {
  const chart = { field: "phase", initial: "idle", states: { idle: {} } };
  const declared = machineDeclarations("unrelated-filename.html", `<section data-screen="workspace"><div data-live="form" data-cortex="editor" data-machine='${JSON.stringify(chart)}'></div></section>`, expandTemplates);
  return {
    entities: {}, types: { types: {}, aliases: {} }, mounts: declared.mounts,
    cortex: { terminal: { meta: { host: "omnishell" }, states: {
      page: { meta: { screen: "workspace" }, states: { ready: { invoke: { src: "editor" } } } },
    } } },
    cortexImplementations: { terminal: { actors: { editor: {
      via: "rows", screen: "workspace", lifetime: "attachment", charts: { form: chart },
    } } } },
  };
}

const familyObligation = (input: OutcomeInputs, property: string) =>
  evaluateOutcomes(input).obligations.find((obligation) => obligation.property === `row-family-${property}`)!;

Deno.test("row ownership links an enclosing screen to an inherited root invocation without claiming execution", () => {
  const input = rowFamilyInput();
  assertEquals(input.mounts![0].family, "editor");
  assertEquals(input.mounts![0].screen, "workspace");
  assertEquals(evaluateOutcomes(input).counts.violation, 0);
  for (const property of ["binding", "screen", "lifetime", "chart", "invocation"]) assertEquals(familyObligation(input, property).status, "satisfied");
  assert(familyObligation(input, "invocation").reason.includes("declaration linkage only"));
  assertEquals(familyObligation(input, "execution").status, "unchecked");
  assert(familyObligation(input, "execution").reason.includes("reachability"));
});

Deno.test("a declared row family without a root invocation cannot silently remain disabled", () => {
  const input = rowFamilyInput();
  delete input.cortex!.terminal.states!.page.states!.ready.invoke;
  assertEquals(familyObligation(input, "invocation").status, "violation");
  assert(familyObligation(input, "invocation").reason.includes("No invocation"));
});

Deno.test("row family declarations must be unique and belong to a terminal root", () => {
  const input = rowFamilyInput();
  input.mounts![0].family = "undeclared";
  assertEquals(familyObligation(input, "binding").status, "violation");
  input.mounts![0].family = "editor";
  input.cortex!.terminal.meta!.host = "mecha";
  assertEquals(familyObligation(input, "binding").status, "violation");
  input.cortex!.terminal.meta!.host = "omnishell";
  input.cortex!.other = input.cortex!.terminal;
  input.cortexImplementations!.other = input.cortexImplementations!.terminal;
  assertEquals(familyObligation(input, "binding").status, "violation");
});

Deno.test("mount screen and invocation screen are independently checked", () => {
  const input = rowFamilyInput();
  input.mounts![0].screen = "other";
  assertEquals(familyObligation(input, "screen").status, "violation");
  input.mounts![0].screen = "workspace";
  input.cortex!.terminal.states!.page.meta!.screen = "other";
  assertEquals(familyObligation(input, "invocation").status, "violation");
  input.cortex!.terminal.states!.page.states!.ready.meta = { screen: "workspace" };
  assertEquals(familyObligation(input, "invocation").status, "satisfied");
  input.cortexImplementations!.terminal.actors!.editor.lifetime = "row";
  assertEquals(familyObligation(input, "lifetime").status, "violation");
});

Deno.test("global invocations and absent screen markup leave scope unchecked", () => {
  const input = rowFamilyInput();
  delete input.cortex!.terminal.states!.page.states!.ready.invoke;
  input.cortex!.terminal.invoke = { src: "editor" };
  assertEquals(familyObligation(input, "invocation").status, "unchecked");
  delete input.mounts![0].screen;
  assertEquals(familyObligation(input, "screen").status, "unchecked");
});

Deno.test("row declaration matching ignores object key order but preserves array order and grouping", () => {
  const input = rowFamilyInput();
  const actor = input.cortexImplementations!.terminal.actors!.editor;
  const first = { states: { idle: {} }, initial: "idle", field: "phase" };
  actor.charts = { form: first };
  assertEquals(familyObligation(input, "chart").status, "satisfied");
  const second = { states: { front: {} }, initial: "front", field: "side" };
  actor.charts = { grouped: [first, second] };
  input.mounts = machineDeclarations("different.html", `<section data-screen="workspace"><div data-live="form" data-cortex="editor" data-machine='${JSON.stringify([first, second])}'></div></section>`, expandTemplates).mounts;
  assertEquals(input.mounts.length, 2);
  assertEquals(evaluateOutcomes(input).obligations.filter((o) => o.property === "row-family-chart").map((o) => o.status), ["satisfied", "satisfied"]);
  actor.charts.grouped = [second, first];
  assertEquals(familyObligation(input, "chart").status, "violation");
  actor.charts = { first, second };
  assertEquals(familyObligation(input, "chart").status, "violation");
  delete actor.charts;
  assertEquals(familyObligation(input, "chart").status, "unchecked");
});

Deno.test("unmarked mounts do not acquire row-family ownership obligations", () => {
  const input = rowFamilyInput();
  delete input.mounts![0].family;
  const withMount = evaluateOutcomes(input);
  input.mounts = [];
  const ownership = (report: ReturnType<typeof evaluateOutcomes>) => report.obligations.filter((item) => item.property.startsWith("row-family"));
  assertEquals(ownership(withMount), ownership(evaluateOutcomes(input)));
});

Deno.test("mounted persisted states do not inherit initial-only reachability claims", () => {
  const report = evaluateOutcomes({ entities: {}, types: { types: {}, aliases: {} }, mounts: [{
    path: "restored.html", table: "record", index: 0,
    chart: { initial: "idle", states: { idle: { on: { finish: "done" } }, imported: { on: { finish: "done" } }, done: { type: "final" } } },
  }] });
  const state = report.obligations.find((item) => item.property === "workflow-state-reachability" && item.evidence.includes("workflow.imported"));
  assertEquals(state?.status, "unchecked");
  assertEquals(report.counts.violation, 0);
});

Deno.test("generated screen headers do not hide machine declarations", () => {
  const html = `<!-- generated -->
<section data-screen="archive"><div data-live="page" data-machine='{"initial":"ready","states":{"ready":{}}}'></div></section>`;
  const declared = machineDeclarations("archive.html", html, expandTemplates);
  assertEquals(declared.mounts.length, 1);
  assertEquals(declared.mounts[0].screen, "archive");
  assertEquals(declared.mounts[0].table, "page");
  assertEquals(declared.gaps, []);
});

Deno.test("fixed observation events need no producer state vocabulary", () => {
  const on: Record<string, unknown> = { result: "done" };
  const input: OutcomeInputs = {
    entities: {}, types: { types: {}, aliases: {} },
    actors: { observer: { via: "observe", table: "job", field: "run", event: "result", suffix: false } },
    mounts: [{ path: "screen.html", table: "form", index: 0, chart: { states: {
      waiting: { invoke: { src: "observer" }, on }, done: {},
    } } }],
  };
  const outcomes = () => evaluateOutcomes(input).obligations.filter((o) => o.property === "outcome-consumer");
  assertEquals(outcomes().map((o) => o.status), ["satisfied"]);
  delete on.result;
  assertEquals(outcomes().map((o) => o.status), ["violation"]);
  on.result = { guard: "valid", target: "done" };
  assertEquals(outcomes().map((o) => o.status), ["unchecked"]);
});
