import { createEmptyActor, createMachine } from "npm:xstate@5.32.6";

type Obj = Record<string, any>;
const obj = (value: unknown): Obj | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : undefined;
const list = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
export type WorkflowControl = {
  configurations: { key: string; value: unknown; active: string[]; done: boolean; certain: boolean; trace: string[] }[];
  edges: { from: string; to: string; event: string; certain: boolean; activities: string[]; entered: string[]; exited: string[] }[];
  activities: string[];
  visitedActivities: string[];
  certainActivities: string[];
  states: string[];
  visitedStates: string[];
  certainStates: string[];
  gaps: string[];
  complete: boolean;
};

/** Project opaque data effects to unknown success, while XState owns control semantics. */
export function exploreWorkflowControl(source: unknown, options: { persisted?: boolean; maxConfigurations?: number; invocationOutcome?: (src: string, isRoot: boolean) => boolean | undefined } = {}): WorkflowControl {
  const result: WorkflowControl = { configurations: [], edges: [], activities: [], visitedActivities: [], certainActivities: [], states: [], visitedStates: [], certainStates: [], gaps: [], complete: true };
  const root = obj(source);
  if (!root?.states) { result.gaps.push("No chart states"); result.complete = false; return result; }
  const limit = options.maxConfigurations ?? 128;
  const events = new Map<string, { owner?: string; uncertain: boolean }>();
  let answers: boolean[] = [], cursor = 0, unresolved = false, steps = 0, uncertain = false;
  let taken: string[] = [], entered: string[] = [], exited: string[] = [];
  const stop = Symbol("workflow-bound");
  const unknown = Symbol("workflow-guard");
  const mark = (id: string, opaque = false) => () => {
    if (++steps > 256) throw stop;
    taken.push(id);
    uncertain ||= opaque;
  };
  const guard = () => {
    if (++steps > 256) throw stop;
    uncertain = true;
    if (cursor === answers.length) { unresolved = true; throw unknown; }
    return answers[cursor++];
  };
  const transitions = (raw: unknown, path: string): unknown => {
    if (raw === undefined) return undefined;
    return list(raw).map((value, index) => {
      const spec = typeof value === "string" ? { target: value } : obj(value);
      if (!spec) throw Error(`Invalid workflow transition ${path}`);
      const id = `${path}:${index}`;
      result.activities.push(id);
      const rowOperations = [spec, ...list(spec.actions).map(obj).filter((action): action is Obj => !!action)].some((action: Obj) => ["assign", "effect", "raise"].some((key) => action[key] !== undefined));
      if (typeof root.field === "string" && rowOperations) result.gaps.push(`${path}: row operations require host semantics`);
      const opaque = ["actions", "assign", "effect", "raise", "reduce", "sql"].some((key) => spec[key] !== undefined && (!Array.isArray(spec[key]) || spec[key].length));
      return { ...(spec.target === undefined ? {} : { target: spec.target }), ...(spec.reenter === undefined ? {} : { reenter: spec.reenter }),
        ...(spec.guard === undefined && !spec.requires?.length ? {} : { guard }), actions: mark(id, opaque) };
    });
  };
  const map = (node: Obj, path: string): Obj => {
    if (node.type === "history") result.gaps.push(`History restoration at ${path} is not modeled`);
    for (const key of ["on", "after", "states"]) if (node[key] !== undefined && !obj(node[key])) result.gaps.push(`Malformed ${key} at ${path}`);
    const id = node.id ?? path;
    if (node !== root) result.states.push(id);
    const mapped: Obj = { id };
    for (const key of ["initial", "history"]) if (node[key] !== undefined) mapped[key] = node[key];
    if (node.type !== undefined) mapped.type = node.type;
    if (node.final === true) mapped.type = "final";
    for (const key of ["entry", "exit"]) mapped[key] = [() => {
      if (++steps > 256) throw stop;
      (key === "entry" ? entered : exited).push(id);
    }, ...(node[key] === undefined ? [] : [mark(`${path}.${key}`, true)])];
    mapped.on = Object.fromEntries(Object.entries(node.on ?? {}).map(([event, value]) => {
      if (event.includes("*")) {
        const witness = event === "*" ? "__workflow_other__" : event.replace(/\*$/, "__workflow_other__");
        events.set(witness, { uncertain: true });
      } else events.set(event, { uncertain: false });
      return [event, transitions(value, `${path}.on.${event}`)];
    }));
    for (const key of ["always", "onDone"]) if (node[key] !== undefined) mapped[key] = transitions(node[key], `${path}.${key}`);
    for (const [delay, value] of Object.entries(node.after ?? {})) {
      const event = `__workflow_after__:${path}:${delay}`;
      events.set(event, { owner: id, uncertain: true });
      mapped.on[event] = transitions(value, `${path}.after.${delay}`);
    }
    list(node.invoke).forEach((invoke, index) => {
      if (options.invocationOutcome?.(invoke.src, node === root) === false) return;
      for (const outcome of ["onDone", "onError"]) if (invoke[outcome] !== undefined) {
        const event = `__workflow_invoke__:${path}:${index}:${outcome}`;
        events.set(event, { owner: id, uncertain: true });
        mapped.on[event] = transitions(invoke[outcome], `${path}.invoke.${index}.${outcome}`);
      }
    });
    if (node.states) mapped.states = Object.fromEntries(Object.entries(node.states).map(([name, child]) => [name, map(obj(child)!, `${path}.${name}`)]));
    return mapped;
  };
  const config = map(root, root.id ?? "workflow");
  if (result.gaps.length) { result.complete = false; return result; }
  const machine = createMachine(config);
  const self = createEmptyActor();
  const scope: any = { self, system: self.system, id: config.id, sessionId: config.id,
    logger: () => { throw Error("Unexpected logging in workflow control"); },
    defer: () => { throw Error("Unprojected scheduling in workflow control"); },
    stopChild: () => { throw Error("Unprojected child in workflow control"); },
    emit: () => { throw Error("Unprojected emission in workflow control"); },
    actionExecutor: (descriptor: any) => {
      if (!descriptor.exec) throw Error(`Unprojected workflow action ${descriptor.type}`);
      descriptor.exec(descriptor.info, descriptor.params);
    },
  };
  const snapshots = new Map<string, any>();
  const configurations = new Map<string, WorkflowControl["configurations"][number]>();
  const visited = new Set<string>(), certainActivities = new Set<string>(), visitedStates = new Set<string>(), certainStates = new Set<string>();
  let runs = 0;
  const evaluate = (operation: () => any, accept: (snapshot: any, uncertain: boolean, taken: string[]) => void, decisions: boolean[] = []) => {
    if (++runs > 4096 || decisions.length > 64) { result.complete = false; result.gaps.push("Guard exploration bound reached"); return; }
    answers = decisions; cursor = 0; unresolved = false; steps = 0; uncertain = false; taken = []; entered = []; exited = [];
    let snapshot;
    try {
      snapshot = operation();
      if (snapshot.status === "error") throw snapshot.error;
    }
    catch (error) {
      if (error === stop) { result.complete = false; result.gaps.push("An eventless execution exceeded the microstep bound"); return; }
      if (!unresolved) throw error;
    }
    if (unresolved) {
      evaluate(operation, accept, [...decisions, false]);
      evaluate(operation, accept, [...decisions, true]);
      return;
    }
    accept(snapshot, uncertain, taken);
  };
  const intern = (snapshot: any, certain: boolean, trace: string[]): string | undefined => {
    const key = JSON.stringify(snapshot.value);
    if (configurations.has(key)) {
      if (certain) configurations.get(key)!.certain = true;
      return key;
    }
    if (configurations.size >= limit) { result.complete = false; result.gaps.push("Stable configuration bound reached"); return; }
    snapshots.set(key, snapshot);
    configurations.set(key, { key, value: snapshot.value, active: snapshot._nodes.map((node: any) => node.id), done: snapshot.status === "done", certain, trace });
    return key;
  };
  const initialOpaque = root.initialize !== undefined;
  evaluate(() => machine.getInitialSnapshot(scope), (snapshot, opaque, trace) => {
    const certain = !opaque && !initialOpaque && !options.persisted;
    trace.forEach((activity) => { visited.add(activity); if (certain) certainActivities.add(activity); });
    entered.forEach((state) => { visitedStates.add(state); if (certain) certainStates.add(state); });
    intern(snapshot, certain, []);
  });
  const stateValues = (node: Obj): any[] => {
    const children = Object.entries(node.states ?? {});
    if (!children.length) return [];
    if (node.type === "parallel") {
      let product: Obj[] = [{}];
      for (const [name, raw] of children) {
        const child = obj(raw)!;
        const values = child.states ? stateValues(child) : [undefined];
        product = product.flatMap((item) => values.map((value) => ({ ...item, [name]: value ?? {} }))).slice(0, limit + 1);
      }
      return product;
    }
    return children.flatMap<any>(([name, raw]) => {
      const child = obj(raw)!;
      return child.states ? stateValues(child).map((value) => ({ [name]: value })) : [name];
    });
  };
  if (options.persisted) for (const value of stateValues(root)) {
    if (configurations.size >= limit) { result.complete = false; result.gaps.push("Persisted configuration bound reached"); break; }
    const snapshot = machine.resolveState({ value });
    intern(snapshot, false, ["restore"]);
    snapshot._nodes.forEach((node: any) => visitedStates.add(node.id));
  }
  // A restored snapshot is not stabilized until the host delivers an input.
  let wake = "__workflow_wake__";
  while (events.has(wake)) wake += "_";
  events.set(wake, { uncertain: true });
  const processed = new Set<string>();
  while (processed.size < configurations.size) {
    const current = [...configurations.values()].find((item) => !processed.has(item.key))!;
    processed.add(current.key);
    if (current.done) continue;
    for (const [event, binding] of events) {
      if (binding.owner && !current.active.includes(binding.owner)) continue;
      evaluate(() => machine.transition(snapshots.get(current.key), { type: event }, scope), (snapshot, opaque, activities) => {
        const certain = !opaque && !binding.uncertain;
        activities.forEach((activity) => { visited.add(activity); if (current.certain && certain) certainActivities.add(activity); });
        entered.forEach((state) => { visitedStates.add(state); if (current.certain && certain) certainStates.add(state); });
        const to = intern(snapshot, current.certain && certain, [...current.trace, event]);
        if (to !== undefined && activities.length) result.edges.push({ from: current.key, to, event, certain, activities, entered: [...entered], exited: [...exited] });
      });
      if (runs > 4096) break;
    }
    if (runs > 4096) break;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of result.edges) if (edge.certain && configurations.get(edge.from)?.certain) {
      edge.activities.forEach((activity) => certainActivities.add(activity));
      edge.entered.forEach((state) => certainStates.add(state));
      if (!configurations.get(edge.to)?.certain) {
        configurations.get(edge.to)!.certain = true;
        changed = true;
      }
    }
  }
  result.configurations = [...configurations.values()];
  result.visitedActivities = [...visited];
  result.certainActivities = [...certainActivities];
  result.visitedStates = [...visitedStates];
  result.certainStates = [...certainStates];
  result.gaps = [...new Set(result.gaps)];
  return result;
}
