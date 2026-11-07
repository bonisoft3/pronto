/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { parseHTML } from "npm:linkedom@0.18.4";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCheckInputs } from "./check-inputs.ts";
import { analyzeWorkflow, type WorkflowOptions } from "./check-workflows.ts";

type Field = { name: string; type: string; pk?: boolean };
type Entity = { table: string; fields: Field[] };
type Machine = { entity?: string; field?: string; states?: Record<string, { invoke?: { src?: string; onDone?: unknown; onError?: unknown } }> };
type Actor = { via?: string; table?: string; field?: string; event?: string; suffix?: boolean; missing?: string; match?: Record<string, string>; require?: string[]; screen?: string; lifetime?: string; charts?: Record<string, Node | Node[]> };
type Invocation = { src?: string; onDone?: unknown; onError?: unknown };
type Node = { initial?: string; states?: Record<string, Node>; on?: Record<string, unknown>; invoke?: Invocation | Invocation[]; type?: string; meta?: { host?: string; screen?: string } };
export type OutcomeInputs = {
  terminal?: boolean;
  entities: Record<string, Entity>;
  types: { types: Record<string, unknown>; aliases: Record<string, string> };
  machines?: Record<string, Machine>;
  reducers?: Record<string, unknown>;
  cortex?: Record<string, Node>;
  cortexImplementations?: Record<string, { actors?: Record<string, Actor> }>;
  effects?: Record<string, unknown>;
  actors?: Record<string, Actor>;
  mountGaps?: { path: string; index: number; reference: string; reason: string }[];
  mounts?: { path: string; table: string; chart: Node; index: number; family?: string; screen?: string; declaration?: Node | Node[] }[];
};
type Status = "satisfied" | "violation" | "unchecked";
export type OutcomeObligation = {
  id: string; path: string; property: string; status: Status; reason: string; evidence: string[];
  oracleClass: "consistency" | "completeness" | "policy" | "domain";
  coverageRoute: "default" | "derived" | "authored";
  authority: string;
  assumptions: string[];
};
export type OutcomeReport = { obligations: OutcomeObligation[]; counts: Record<Status, number> };

const list = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
const rec = (x: unknown): Record<string, unknown> | undefined => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const canonicalJson = (value: unknown): string | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.every((item) => item !== undefined) ? `[${items.join(",")}]` : undefined;
  }
  const object = rec(value);
  if (!object) return undefined;
  const entries = Object.keys(object).sort().map((key) => {
    const encoded = canonicalJson(object[key]);
    return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
  });
  return entries.every((entry) => entry !== undefined) ? `{${entries.join(",")}}` : undefined;
};
const choice = (transition: unknown): Status => {
  const alternatives = list(transition);
  if (!alternatives.length) return "unchecked";
  if (alternatives.some((v) => {
    if (typeof v === "string") return v.length > 0;
    const transition = rec(v);
    if (!transition || Object.hasOwn(transition, "guard")) return false;
    const target = transition.target;
    const actions = transition.actions;
    return (typeof target === "string" && target.length > 0) || (typeof actions === "string" && actions.length > 0) || (Array.isArray(actions) && actions.length > 0);
  })) return "satisfied";
  return "unchecked";
};

export function evaluateOutcomes(inputs: OutcomeInputs, runtime: Pick<WorkflowOptions, "omnishellEngine"> = {}): OutcomeReport {
  const obligations: OutcomeObligation[] = [];
  const add = (path: string, property: string, key: string, status: Status, reason: string, evidence: string[] = []) => {
    obligations.push({ id: `${property}:${path}:${key}`, path, property, status, reason, evidence,
      oracleClass: property === "outcome-consumer" || property === "navigation-outcome" || property === "effect-outcome" ? "completeness" : "consistency",
      coverageRoute: "derived", authority: "Pronto source/sink, portable type and invocation contracts",
      assumptions: ["Declaration linkage only; effect execution and conditional reachability are not established"],
    });
  };
  for (const gap of inputs.mountGaps ?? []) add(gap.path, "mount-coverage", String(gap.index), "unchecked",
    `${gap.reason} named template reference prevents complete mount inventory.`, [gap.reference]);
  const entity = (name: string | undefined) => Object.entries(inputs.entities).find(([key, value]) => key === name || value.table === name)?.[1];
  const canonical = (type: string) => inputs.types.aliases[type] ?? type;
  for (const [name, chart] of Object.entries(inputs.cortex ?? {})) {
    const path = `.pronto/check-inputs.json#cortex.${name}`;
    if (chart.meta?.host !== "mecha") {
      const walk = (node: Node, statePath: string[]) => {
        for (const invoke of list(node.invoke)) {
          const src = invoke.src ?? "";
          const actor = inputs.cortexImplementations?.[name]?.actors?.[src];
          if (actor?.via === "navigation") {
            for (const outcome of ["onDone", "onError"] as const) {
              const status = invoke[outcome] === undefined ? "violation" : choice(invoke[outcome]);
              add(path, "navigation-outcome", `${statePath.join(".") || "$root"}:${src}:${outcome}`, status,
                status === "violation" ? "Navigation has no declared completion or failure disposition." : status === "satisfied"
                  ? "An unguarded navigation outcome transition is declared." : "Navigation outcome disposition is conditional or unsupported.", [src, outcome]);
            }
          } else add(path, "source-contract", `${statePath.join(".") || "$root"}:${src}`, "unchecked", "The invoked Cortex actor's outcome and delivery contract is not checked.", [src, actor?.via ?? "actor metadata unavailable"]);
        }
        for (const [state, child] of Object.entries(node.states ?? {})) walk(child, [...statePath, state]);
      };
      walk(chart, []);
      continue;
    }
    for (const invocation of list(chart.invoke)) {
      const src = invocation.src ?? "";
      const actor = inputs.cortexImplementations?.[name]?.actors?.[src];
      if (actor?.via !== "query" || !actor.event) {
        add(path, "source-consumer", src, "unchecked", "Invoked source or its event metadata is unavailable.");
        continue;
      }
      const event = actor.event;
      const handlers = Object.entries(chart.states ?? {}).filter(([, state]) => Object.hasOwn(state.on ?? {}, event));
      const rootHandler = Object.hasOwn(chart.on ?? {}, event);
      const nested = Object.values(chart.states ?? {}).some((state) => state.states || state.type === "parallel");
      const wildcard = [chart, ...Object.values(chart.states ?? {})].some((state) => Object.keys(state.on ?? {}).some((key) => key === "*" || (key.endsWith(".*") && event.startsWith(key.slice(0, -1)))));
      if (!handlers.length && !rootHandler && !nested && !wildcard) add(path, "source-consumer", `${src}:${event}`, "violation", "The invoked query event has no transition in the backend chart.", [event]);
      else add(path, "source-consumer", `${src}:${event}`, "unchecked", "Query predicates, state reachability, hierarchy and guard feasibility are not established.", [...(rootHandler ? ["$root"] : []), ...handlers.map(([state]) => state)]);
    }
  }
  for (const [name, machine] of Object.entries(inputs.machines ?? {})) {
    for (const [state, node] of Object.entries(machine.states ?? {})) {
      const invoke = node.invoke;
      if (!invoke) continue;
      const path = `.pronto/check-inputs.json#machines.${name}.states.${state}.invoke`;
      for (const outcome of ["onDone", "onError"] as const) {
        const transition = invoke[outcome];
        const status = transition === undefined ? "violation" : choice(transition);
        add(path, "effect-outcome", outcome, status, status === "violation" ? "The invocation has no declared outcome transition." : status === "unchecked" ? "Guarded outcome alternatives do not establish a disposition." : "An unguarded invocation outcome transition is declared.", [String(invoke.src), outcome]);
      }
      add(path, "effect-delivery", String(invoke.src), "unchecked", "Effect implementation, outcome payloads, delivery, retry and timeout semantics are not checked.");
    }
  }
  for (const mount of inputs.mounts ?? []) {
    const path = `${mount.path}#${mount.table}[${mount.index}]`;
    if (mount.family !== undefined) {
      const family = mount.family;
      const roots = Object.entries(inputs.cortex ?? {}).filter(([name, chart]) =>
        chart.meta?.host === "omnishell" && inputs.cortexImplementations?.[name]?.actors?.[family]?.via === "rows");
      if (!family || roots.length !== 1) add(path, "row-family-binding", family, "violation",
        "The marked mount must resolve to exactly one terminal Cortex row-family declaration.", [family, ...roots.map(([name]) => name)]);
      else {
        const [rootName, root] = roots[0];
        const actor = inputs.cortexImplementations![rootName].actors![family];
        add(path, "row-family-binding", family, "satisfied", "The mount names one terminal Cortex row-family declaration; this establishes declaration linkage only.", [rootName, family]);
        const screenStatus = !mount.screen ? "unchecked" : mount.screen === actor.screen ? "satisfied" : "violation";
        add(path, "row-family-screen", family, screenStatus, screenStatus === "unchecked"
          ? "No enclosing data-screen declaration establishes the mount's screen."
          : screenStatus === "violation" ? "The mount's declared screen differs from its row family's screen."
          : "The mount and row family declare the same screen.", [mount.screen ?? "screen unavailable", actor.screen ?? "screen unavailable"]);
        add(path, "row-family-lifetime", family, actor.lifetime === "attachment" ? "satisfied" : "violation",
          actor.lifetime === "attachment" ? "The row family declares attachment lifetime." : "The row family must declare attachment lifetime.", [actor.lifetime ?? "lifetime unavailable"]);
        const payload = canonicalJson(mount.declaration ?? mount.chart);
        const declared = actor.charts && Object.values(actor.charts).map(canonicalJson);
        const payloadStatus = payload === undefined || !declared || declared.some((chart) => chart === undefined) ? "unchecked"
          : declared.includes(payload) ? "satisfied" : "violation";
        add(path, "row-family-chart", family, payloadStatus, payloadStatus === "satisfied"
          ? "The mounted declaration matches a declared family chart, including array order and grouping."
          : payloadStatus === "violation" ? "The mounted chart declaration is absent from the row family."
          : "Chart declaration equality is unavailable; runtime validation remains required.", [family]);
        const invocations: { state: string; screen?: string }[] = [];
        const walk = (node: Node, statePath: string[], inheritedScreen?: string) => {
          const screen = node.meta?.screen ?? inheritedScreen;
          if (list(node.invoke).some((invoke) => invoke.src === family)) invocations.push({ state: statePath.join(".") || "$root", screen });
          for (const [name, child] of Object.entries(node.states ?? {})) walk(child, [...statePath, name], screen);
        };
        walk(root, []);
        const linked = invocations.some((invoke) => actor.screen !== undefined && invoke.screen === actor.screen);
        const unscoped = invocations.some((invoke) => invoke.screen === undefined);
        const invocationStatus = linked ? "satisfied" : unscoped ? "unchecked" : "violation";
        add(path, "row-family-invocation", family, invocationStatus, linked
          ? "An invocation is declared under matching inherited screen metadata; this establishes declaration linkage only."
          : unscoped ? "An invocation without screen metadata cannot establish screen-scoped declaration linkage."
          : invocations.length ? "The row family is invoked only under a different screen's metadata."
          : "No invocation in the owning terminal Cortex chart names this row family.", invocations.map((invoke) => `${invoke.state}: ${invoke.screen ?? "unscoped"}`));
        if (invocations.length) add(path, "row-family-execution", family, "unchecked",
          "State reachability, invocation execution and overlap with the mounted screen are not established by declaration linkage.", [rootName, family]);
      }
    }
    const owner = entity(mount.table);
    const visit = (node: Node, statePath: string[], ancestors: Node[], complex: boolean) => {
      for (const invoke of list(node.invoke)) {
        const src = invoke.src ?? "";
        const actor = inputs.actors?.[src];
        const key = `${statePath.join(".") || "$root"}:${src}`;
        if (!actor || actor.via !== "observe") {
          add(path, "source-contract", key, "unchecked", "The invoked actor's outcome vocabulary and delivery contract are not available to this checker.", [src, actor?.via ?? "actor metadata unavailable"]);
          continue;
        }
        const source = entity(actor.table);
        for (const [from, to] of Object.entries(actor.match ?? {})) {
          const a = source?.fields.find((f) => f.name === from);
          const b = owner?.fields.find((f) => f.name === to);
          const property = "correlation-binding";
          if (!source || !owner) add(path, property, `${key}:${from}`, "unchecked", "Source or mounted entity metadata is unavailable.", [String(actor.table), mount.table]);
          else if (!a || !b) add(path, property, `${key}:${from}`, "violation", "A declared observation mapping refers to a missing field.", [`${actor.table}.${from}`, `${mount.table}.${to}`]);
          else {
            const left = canonical(a.type), right = canonical(b.type);
            const known = Object.hasOwn(inputs.types.types, left) && Object.hasOwn(inputs.types.types, right);
            const leftJson = rec(inputs.types.types[left])?.json, rightJson = rec(inputs.types.types[right])?.json;
            const disjoint = known && leftJson && rightJson && leftJson !== "value" && rightJson !== "value" && leftJson !== rightJson;
            const status = left === right && known ? "satisfied" : disjoint ? "violation" : "unchecked";
            add(path, property, `${key}:${from}`, status, status === "satisfied" ? "Mapped fields have the same portable type." : status === "violation" ? "Mapped fields have disjoint portable value carriers." : "Compatibility of the mapped portable types is not established.", [`${actor.table}.${from}: ${a.type}`, `${mount.table}.${to}: ${b.type}`]);
          }
        }
        add(path, "attempt-correlation", key, "unchecked", "The observer contract does not identify attempt keys or guarantee that attempts cannot overlap.", Object.entries(actor.match ?? {}).map(([a, b]) => `${a} -> ${b}`));
        let events: string[] = [];
        if (actor.field && actor.event) {
          const producers = Object.values(inputs.machines ?? {}).filter((m) => entity(m.entity)?.table === actor.table && m.field === actor.field && m.states);
          if (actor.suffix === false) events = [actor.event];
          else if (producers.length === 1) events = Object.keys(producers[0].states!).map((phase) => actor.event! + phase);
          else add(path, "outcome-consumer", key, "unchecked", "A unique declared producer state vocabulary is unavailable.", [String(actor.table), actor.field]);
        }
        if (actor.missing) events.push(actor.missing);
        for (const event of events) {
          const active = [node, ...ancestors.slice().reverse()];
          const exact = active.find((n) => Object.hasOwn(n.on ?? {}, event));
          const wildcard = active.some((n) => Object.keys(n.on ?? {}).some((e) => e === "*" || (e.endsWith(".*") && event.startsWith(e.slice(0, -1)))));
          let status: Status;
          let reason: string;
          if (complex || node.states || node.type === "parallel") { status = "unchecked"; reason = "Nested or parallel active-state handling is not resolved."; }
          else if (wildcard) { status = "unchecked"; reason = "A wildcard transition may consume or shadow the event."; }
          else if (exact) {
            const transition = exact.on![event];
            const ignore = list(transition).some((item) => rec(item) !== undefined && Object.keys(rec(item)!).length === 0);
            status = ignore ? "satisfied" : choice(transition);
            reason = ignore ? "An explicit empty transition intentionally ignores the event." : status === "satisfied" ? "An unguarded transition consumes the event while the source is active." : "Only guarded, inert or unsupported transitions are declared; disposition is not established.";
          }
          else { status = "violation"; reason = "The explicit-disposition policy requires a transition for this declared source event while the invocation is active."; }
          add(path, "outcome-consumer", `${key}:${event}`, status, reason, [event, src]);
        }
      }
      for (const [name, child] of Object.entries(node.states ?? {})) visit(child, [...statePath, name], [...ancestors, node], complex || node.type === "parallel" || statePath.length > 0);
    };
    visit(mount.chart, [], [], false);
  }
  for (const [family, charts] of Object.entries({ cortex: inputs.cortex, machines: inputs.machines, reducers: inputs.reducers })) {
    for (const [name, chart] of Object.entries(charts ?? {})) {
      obligations.push(...analyzeWorkflow(chart, `.pronto/check-inputs.json#${family}.${name}`, {
        ...runtime, entry: family === "cortex" && rec(rec(chart)?.meta)?.host !== "mecha" ? "declared" : "persisted",
        actors: inputs.cortexImplementations?.[name]?.actors, effects: inputs.effects,
        host: family === "cortex" && rec(rec(chart)?.meta)?.host !== "mecha" ? "omnishell" : "mecha",
      }));
    }
  }
  for (const mount of inputs.mounts ?? []) {
    obligations.push(...analyzeWorkflow(mount.chart, `${mount.path}#machine:${mount.index}`, {
      ...runtime, entry: "persisted", actors: inputs.actors, effects: inputs.effects, host: "omnishell",
    }));
  }
  obligations.sort((a, b) => a.id.localeCompare(b.id));
  const counts: OutcomeReport["counts"] = { satisfied: 0, violation: 0, unchecked: 0 };
  for (const obligation of obligations) counts[obligation.status]++;
  return { obligations, counts };
}

export type TemplateExpander = (document: Document) => { reference: string; reason: string; element: Element }[];

export function machineDeclarations(path: string, html: string, expandTemplates: TemplateExpander): { mounts: NonNullable<OutcomeInputs["mounts"]>; gaps: NonNullable<OutcomeInputs["mountGaps"]> } {
  const mounts: NonNullable<OutcomeInputs["mounts"]> = [];
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const expansionGaps = expandTemplates(document);
  const gaps = expansionGaps.map((gap, index) => ({ path, index, reference: gap.reference, reason: gap.reason }));
  const declared = [...document.querySelectorAll("[data-live][data-machine]")].filter((element) =>
    !element.parentElement?.closest("[data-text-format], template") && !expansionGaps.some((gap) => gap.element === element));
  let index = 0;
  for (const element of declared.filter((el) => el.hasAttribute("data-live") && el.hasAttribute("data-machine"))) {
    const value = JSON.parse(element.getAttribute("data-machine")!);
    const family = element.getAttribute("data-cortex");
    const screen = element.closest("[data-screen]")?.getAttribute("data-screen");
    for (const chart of list(value)) mounts.push({ path, table: element.getAttribute("data-live")!, chart, index: index++,
      ...(family === null ? {} : { family, declaration: value }), ...(screen ? { screen } : {}) });
  }
  return { mounts, gaps };
}

export type MarkupTools = {
  expandTemplates: TemplateExpander;
  resolveMachineMarkup: (html: string, bindings?: Record<string, unknown>, screen?: string) => string;
};

export async function loadOutcomeInputs(appDir: string, terminal: MarkupTools): Promise<OutcomeInputs> {
  const inputs = await readCheckInputs(appDir) as unknown as OutcomeInputs;
  let shellText: string;
  try { shellText = await Deno.readTextFile(`${appDir}/shell/shell.json`); }
  catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    if (inputs.terminal === true || Object.values(inputs.cortex ?? {}).some((chart) => chart.meta?.host !== "mecha")) {
      throw new Error(`${appDir}/shell/shell.json: missing declared terminal input; regenerate the application`);
    }
    return inputs;
  }
  const shell = JSON.parse(shellText) as { actors?: Record<string, Actor>; cortex?: { actors?: Record<string, unknown> }; routes?: { screen: string; files?: { html?: string } }[] };
  const mounts: NonNullable<OutcomeInputs["mounts"]> = [];
  const mountGaps: NonNullable<OutcomeInputs["mountGaps"]> = [];
  const screens = new Map((shell.routes ?? []).map((route) => [route.screen, route.files?.html]));
  for (const [screen, path] of screens) {
    if (!path) throw new Error(`screen ${screen} declares no HTML file`);
    const html = terminal.resolveMachineMarkup(await Deno.readTextFile(`${appDir}/${path}`), shell.cortex?.actors, screen);
    const declared = machineDeclarations(path, html, terminal.expandTemplates);
    mounts.push(...declared.mounts);
    mountGaps.push(...declared.gaps);
  }
  return { ...inputs, actors: shell.actors, mounts, mountGaps };
}

export async function checkApp(appDir: string, terminal: MarkupTools, runtime: Pick<WorkflowOptions, "omnishellEngine"> = {}): Promise<OutcomeReport> {
  return evaluateOutcomes(await loadOutcomeInputs(appDir, terminal), runtime);
}

export async function run(args: string[]): Promise<number> {
  if (args.length !== 3 || args[1] !== "--omnishell") throw Error("usage: check-outcomes.ts <appDir> --omnishell <root>");
  const module = await import(pathToFileURL(resolve(args[2], "expand-templates.ts")).href);
  const engine = await import(pathToFileURL(resolve(args[2], "interpreter/machine-engine.js")).href);
  const markup = await import(pathToFileURL(resolve(args[2], "interpreter/lint.ts")).href);
  const report = await checkApp(args[0], { expandTemplates: module.expandTemplates, resolveMachineMarkup: markup.resolveMachineMarkup }, { omnishellEngine: engine.machineEngine });
  console.log(JSON.stringify(report, null, 2));
  return report.counts.violation ? 1 : 0;
}
if (import.meta.main) Deno.exitCode = await run(Deno.args);
