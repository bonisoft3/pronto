import type { WorkflowControl } from "./workflow-control.ts";

export type OmnishellWorkflowEngine = (chart: any, hooks: {
  guard(ref: any, run: any, context?: any): boolean;
  action(act: any, run: any, context?: any): void;
  trace?(origin: string, key: string, index: number, target: any, run: any, context?: any): void;
}) => (row: any, event: any, keys: string[], preview?: boolean) => any;
type Obj = Record<string, any>;
const list = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Explore the installed terminal adapter; its targeting and shadowing differ from raw XState. */
export function exploreOmnishellWorkflow(source: Obj, factory: OmnishellWorkflowEngine, limit = 128): WorkflowControl {
  const result: WorkflowControl = { configurations: [], edges: [], activities: [], visitedActivities: [], certainActivities: [], states: [], visitedStates: [], certainStates: [], gaps: [], complete: true };
  if (typeof source.field !== "string" || typeof source.initial !== "string") {
    result.complete = false; result.gaps.push("The terminal row-control field or initial value is unavailable"); return result;
  }
  const rootId = source.id ?? "workflow";
  const nodes = new Map<string, Obj>([["", source]]);
  const events = new Map<string, Set<string> | undefined>();
  const walk = (node: Obj, path: string) => {
    const prefix = path ? `${rootId}.${path}` : rootId;
    for (const [key, value] of Object.entries(node.on ?? {})) {
      events.set(key, undefined);
      list(value).forEach((_edge, index) => result.activities.push(`${prefix}.on.${key}:${index}`));
    }
    for (const [key, value] of Object.entries(node.after ?? {})) {
      const event = `after:${key}`;
      const owners = events.get(event) ?? new Set<string>();
      owners.add(path);
      events.set(event, owners);
      list(value).forEach((_edge, index) => result.activities.push(`${prefix}.after.${key}:${index}`));
    }
    for (const key of ["always", "onDone"]) list(node[key]).forEach((_edge, index) => result.activities.push(`${prefix}.${key}:${index}`));
    for (const [name, child] of Object.entries(node.states ?? {})) {
      const at = path ? `${path}.${name}` : name;
      nodes.set(at, child as Obj); result.states.push(`${rootId}.${at}`); walk(child as Obj, at);
    }
  };
  walk(source, "");
  let answers: boolean[] = [], cursor = 0, unresolved = false;
  let activities: string[] = [];
  const unknown = Symbol("workflow-guard");
  const engine = factory(source, {
    guard() {
      if (cursor === answers.length) { unresolved = true; throw unknown; }
      return answers[cursor++];
    },
    action() {},
    trace(origin, key, index) {
      const path = origin === "*" ? rootId : `${rootId}.${origin}`;
      const label = key === "always" || key === "onDone" ? key : key.startsWith("after:") ? `after.${key.slice(6)}` : `on.${key}`;
      activities.push(`${path}.${label}:${index}`);
    },
  });
  const configurations = new Map<string, WorkflowControl["configurations"][number]>();
  const visited = new Set<string>();
  const activeIds = (state: string) => [rootId, ...state.split(".").map((_part, index, parts) => `${rootId}.${parts.slice(0, index + 1).join(".")}`)];
  const intern = (state: string, trace: string[]) => {
    const key = JSON.stringify(state);
    if (!configurations.has(key)) {
      if (configurations.size >= limit) { result.complete = false; result.gaps.push("Terminal configuration bound reached"); return undefined; }
      configurations.set(key, { key, value: state, active: activeIds(state), done: !state.includes(".") && nodes.get(state)?.type === "final", certain: false, trace });
    }
    return key;
  };
  for (const [path, node] of nodes) if (path && node.type !== "parallel") intern(path, ["restore"]);
  intern(source.initial, ["restore"]);
  let runs = 0;
  const evaluate = (state: string, event: string, accept: (run: any, activities: string[]) => void, choices: boolean[] = []) => {
    if (++runs > 4096 || choices.length > 64) { result.complete = false; result.gaps.push("Terminal guard exploration bound reached"); return; }
    answers = choices; cursor = 0; unresolved = false; activities = [];
    let run;
    try { run = engine({ [source.field]: state }, { type: event }, [event]); }
    catch (error) {
      if (error instanceof Error && error.message === "machine eventless transitions did not settle in 10 steps") {
        result.complete = false; result.gaps.push("Terminal eventless execution exceeded its runtime cascade bound"); return;
      }
      if (!unresolved) throw error;
    }
    if (unresolved) {
      evaluate(state, event, accept, [...choices, false]);
      evaluate(state, event, accept, [...choices, true]);
      return;
    }
    // Restored rows and omitted effects do not establish an unconditional route.
    accept(run, activities);
  };
  const processed = new Set<string>();
  while (processed.size < configurations.size) {
    const current = [...configurations.values()].find((configuration) => !processed.has(configuration.key))!;
    processed.add(current.key);
    if (current.done) continue;
    for (const [event, owners] of [["always", undefined], ...events] as [string, Set<string> | undefined][]) {
      if (owners !== undefined && ![...owners].some((owner) => current.active.includes(owner ? `${rootId}.${owner}` : rootId))) continue;
      evaluate(current.value as string, event, (run, taken) => {
        taken.forEach((activity) => visited.add(activity));
        const to = intern(run.state, [...current.trace, event]);
        if (to !== undefined && run.taken) result.edges.push({ from: current.key, to, event, certain: false, activities: taken,
          entered: run.enter.map((path: string) => path ? `${rootId}.${path}` : rootId),
          exited: run.exit.map((path: string) => path ? `${rootId}.${path}` : rootId) });
      });
      if (runs > 4096) break;
    }
    if (runs > 4096) break;
  }
  result.configurations = [...configurations.values()];
  result.visitedActivities = [...visited];
  result.visitedStates = [...new Set(result.configurations.flatMap((state) => state.active))];
  result.gaps = [...new Set(result.gaps)];
  return result;
}
