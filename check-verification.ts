import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadOutcomeInputs, evaluateOutcomes, type OutcomeObligation } from "./check-outcomes.ts";

type Status = OutcomeObligation["status"];
type Evidence = Pick<OutcomeObligation, "id" | "path" | "property" | "status" | "reason" | "evidence"> &
  Partial<Pick<OutcomeObligation, "oracleClass" | "coverageRoute" | "authority" | "assumptions">>;
export type InventoryObligation = OutcomeObligation & { checker: "presentation" | "outcomes" };
export type Inventory = {
  obligations: InventoryObligation[];
  counts: Record<Status, number>;
  byProperty: Record<string, Record<Status, number>>;
  byRoute: Record<string, Record<Status, number>>;
  declarations?: ReturnType<typeof declarationInventory>;
  coverage: { obligations: number; unchecked: number; claim: string };
};
const emptyCounts = (): Record<Status, number> => ({ satisfied: 0, violation: 0, unchecked: 0 });

export function inventory(presentation: Evidence[], outcomes: OutcomeObligation[]): Inventory {
  const obligations: InventoryObligation[] = [
    ...presentation.map((item): InventoryObligation => ({
      ...item, checker: "presentation",
      oracleClass: item.oracleClass ?? "completeness",
      coverageRoute: item.coverageRoute ?? "derived",
      authority: item.authority ?? "Pronto declared presentation and interaction contracts",
      assumptions: item.assumptions ?? [],
    })),
    ...outcomes.map((item): InventoryObligation => ({ ...item, checker: "outcomes" })),
  ];
  obligations.sort((a, b) => `${a.checker}:${a.id}`.localeCompare(`${b.checker}:${b.id}`));
  const counts = emptyCounts();
  const byProperty: Inventory["byProperty"] = {};
  const byRoute: Inventory["byRoute"] = {};
  for (const item of obligations) {
    counts[item.status]++;
    (byProperty[item.property] ??= emptyCounts())[item.status]++;
    (byRoute[item.coverageRoute] ??= emptyCounts())[item.status]++;
  }
  return { obligations, counts, byProperty, byRoute,
    coverage: { obligations: obligations.length, unchecked: counts.unchecked,
      claim: "Inventory of supported declarations and explicit gaps; not execution coverage or whole-application correctness" } };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function declarationInventory(inputs: unknown) {
  const data = record(inputs);
  const machines: { path: string; host: string; states: number; finals: string[]; invocations: number; statesInventory: { path: string; type: unknown; events: string[]; timers: string[]; automatic: boolean }[]; events: unknown; contracts: unknown; identity: unknown }[] = [];
  const connections: { path: string; source: unknown; contract: unknown; outcomes: string[]; input: unknown; invocation: unknown; contractPath: string | null; contractCandidates: { path: string; declaration: unknown }[] }[] = [];
  const collect = (chart: Record<string, unknown>, path: string, host: string, actors: Record<string, unknown>, namespace: string, identity: unknown, stateEffects = false) => {
    const item = { path, host, states: 0, finals: [] as string[], invocations: 0,
      statesInventory: [] as { path: string; type: unknown; events: string[]; timers: string[]; automatic: boolean }[],
      events: chart.events ?? null, contracts: chart.contracts ?? null, identity };
    const visit = (node: Record<string, unknown>, location: string) => {
      if (node.type === "final" || node.final === true) item.finals.push(location);
      item.statesInventory.push({ path: location, type: node.type ?? (node.final === true ? "final" : null),
        events: Object.keys(record(node.on)), timers: Object.keys(record(node.after)), automatic: node.always !== undefined });
      const invokes = node.invoke === undefined ? [] : Array.isArray(node.invoke) ? node.invoke : [node.invoke];
      for (const rawInvoke of invokes) {
        const invoke = record(rawInvoke);
        item.invocations++;
        const candidates: { path: string; declaration: unknown }[] = [];
        const bindings = stateEffects && location !== path ? record(data.effects) : actors;
        const bindingNamespace = stateEffects && location !== path ? ".pronto/check-inputs.json#effects" : namespace;
        if (typeof invoke.src === "string" && Object.hasOwn(bindings, invoke.src)) {
          candidates.push({ path: `${bindingNamespace}.${invoke.src}`, declaration: bindings[invoke.src] });
        }
        connections.push({ path: location, source: invoke.src ?? null,
          contract: candidates.length === 1 ? candidates[0].declaration : null,
          contractPath: candidates.length === 1 ? candidates[0].path : null, contractCandidates: candidates,
          outcomes: ["onDone", "onError"].filter((key) => Object.hasOwn(invoke, key)),
          input: invoke.input ?? null, invocation: invoke.id ?? null });
      }
      for (const [state, child] of Object.entries(record(node.states))) {
        item.states++;
        visit(record(child), `${location}.states.${state}`);
      }
    };
    visit(chart, path);
    machines.push(item);
  };
  for (const family of ["cortex", "machines", "reducers"]) {
    for (const [name, raw] of Object.entries(record(data[family]))) {
      const chart = record(raw);
      collect(chart, `.pronto/check-inputs.json#${family}.${name}`, String(record(chart.meta).host ?? (family === "cortex" ? "omnishell" : "mecha")),
        family === "machines" ? record(data.effects) : family === "cortex" ? record(record(record(data.cortexImplementations)[name]).actors) : {},
        family === "machines" ? ".pronto/check-inputs.json#effects" : `.pronto/check-inputs.json#cortexImplementations.${name}.actors`,
        { entity: chart.entity ?? null, field: chart.field ?? null, name }, family === "cortex" && record(chart.meta).host === "mecha");
    }
  }
  for (const raw of Array.isArray(data.mounts) ? data.mounts : []) {
    const mount = record(raw);
    collect(record(mount.chart), `${mount.path}#machine:${mount.index}`, "omnishell", record(data.actors), "shell/shell.json#actors",
      { table: mount.table, family: mount.family ?? null, screen: mount.screen ?? null });
  }
  const effects = Object.entries(record(data.effects)).map(([name, raw]) => {
    const effect = record(raw);
    return { name, path: `.pronto/check-inputs.json#effects.${name}`, key: effect.key ?? null,
      sink: effect.sink ?? null, input: effect.input ?? null, attempts: effect.attempts ?? null, reentry: effect.reentry ?? null };
  });
  return { machines, connections, effects, terminal: data.mounts === undefined ? "absent" : "present",
    gaps: Array.isArray(data.mountGaps) ? data.mountGaps : [],
    boundary: "Declarations across hosts, including expanded DOM mounts; repeated host projections retain distinct paths. Opaque expressions are inventoried, not interpreted." };
}

export async function checkVerification(appDir: string, omnishellRoot: string): Promise<Inventory> {
  const app = pathToFileURL(`${resolve(appDir)}/`);
  const root = resolve(omnishellRoot);
  const [presentation, templates, engine, markup] = await Promise.all([
    import(pathToFileURL(resolve(root, "check-presentation.ts")).href),
    import(pathToFileURL(resolve(root, "expand-templates.ts")).href),
    import(pathToFileURL(resolve(root, "interpreter/machine-engine.js")).href),
    import(pathToFileURL(resolve(root, "interpreter/lint.ts")).href),
  ]);
  const inputs = await loadOutcomeInputs(resolve(appDir), { expandTemplates: templates.expandTemplates, resolveMachineMarkup: markup.resolveMachineMarkup });
  // A backend-only program has no terminal routes; loader preserves that distinction.
  const ui: { obligations: Evidence[] } = inputs.mounts === undefined
    ? { obligations: [] }
    : await presentation.checkApp(app);
  return { ...inventory(ui.obligations, evaluateOutcomes(inputs, { omnishellEngine: engine.machineEngine }).obligations),
    declarations: declarationInventory(inputs) };
}

if (import.meta.main) {
  if (Deno.args.length !== 3 || Deno.args[1] !== "--omnishell") {
    throw new Error("usage: check-verification.ts <appDir> --omnishell <root>");
  }
  const report = await checkVerification(Deno.args[0], Deno.args[2]);
  console.log(JSON.stringify(report, null, 2));
  Deno.exitCode = report.counts.violation ? 1 : 0;
}
