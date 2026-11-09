import { exploreOmnishellWorkflow } from "./workflow-omnishell-control.ts";
import { exploreWorkflowControl } from "./workflow-control.ts";
import { invocationObligations, invocationOutcomePossible, type WorkflowOptions } from "./workflow-invocations.ts";
export type { WorkflowOptions } from "./workflow-invocations.ts";
type Status = "satisfied" | "violation" | "unchecked";
export type WorkflowObligation = {
  id: string;
  path: string;
  property: string;
  status: Status;
  reason: string;
  evidence: string[];
  assumptions: string[];
  oracleClass: "completeness" | "policy";
  coverageRoute: "derived";
  authority: string;
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const nonempty = (value: unknown): boolean => value !== undefined && (!Array.isArray(value) || value.length > 0);

/** The engine projection shares XState's hierarchy, parallel completion and macrosteps. */
export function analyzeWorkflow(value: unknown, path: string, options: WorkflowOptions = {}): WorkflowObligation[] {
  const chart = object(value);
  if (chart?.type === "parallel" && options.host === "omnishell" && options.entry === "persisted") {
    const regions = object(chart.states);
    const fields = regions && Object.entries(regions).map(([name, value]) => object(value)?.field ?? name);
    if (!regions || !fields || fields.length === 0 || fields.some((field) => typeof field !== "string") || new Set(fields).size !== fields.length || Object.values(regions).some((region) => !object(region))) return [{
      id: `workflow-host-coverage:${path}:$root`, path, property: "workflow-host-coverage", status: "unchecked",
      reason: "The terminal parallel declaration has no analyzable row regions.", evidence: [], assumptions: [],
      oracleClass: "completeness", coverageRoute: "derived", authority: "Omnishell machine-engine host contract",
    }];
    return Object.entries(regions).flatMap(([name, raw]) => {
      const region = object(raw)!;
      return analyzeWorkflow({
        field: region.field ?? name, initial: region.initial,
        on: { ...object(chart.on), ...object(region.on) }, states: region.states ?? {},
        after: region.after, always: region.always, onDone: region.onDone,
        entry: region.entry, exit: region.exit, invoke: region.invoke,
      }, `${path}#region:${name}`, options);
    });
  }
  const invocations = invocationObligations(value, path, options);
  const hasFinal = (node: ObjectValue): boolean => {
    const children = Object.values(object(node.states) ?? {}).map(object).filter((child): child is ObjectValue => !!child);
    return node.type === "final" || node.final === true || (node.type === "parallel" ? children.length > 0 && children.every(hasFinal) : children.some((child) => child.type === "final" || child.final === true));
  };
  const scopes: { id: string; path: string }[] = [];
  const findScopes = (node: ObjectValue, at: string) => {
    if (node.states !== undefined && node.onDone !== undefined) scopes.push({ id: typeof node.id === "string" ? node.id : at, path: at });
    for (const [name, child] of Object.entries(object(node.states) ?? {})) if (object(child)) findScopes(object(child)!, `${at}.${name}`);
  };
  if (chart) findScopes(chart, typeof chart.id === "string" ? chart.id : "workflow");
  if (!chart || !hasFinal(chart) && !scopes.length) return [...invocations, {
    id: `workflow-applicability:${path}:$root`, path, property: "workflow-applicability", status: "unchecked",
    reason: "No explicit final control state establishes a finite workflow scope; persistent services are not required to terminate.",
    evidence: [], assumptions: [], oracleClass: "completeness", coverageRoute: "derived", authority: "Workflow soundness policy",
  }];
  const finiteRoot = hasFinal(chart);
  const terminalRow = options.host === "omnishell" && typeof chart.field === "string";
  if (terminalRow && !options.omnishellEngine) return [...invocations, {
    id: `workflow-host-coverage:${path}:$root`, path, property: "workflow-host-coverage", status: "unchecked",
    reason: "The terminal's actual machine engine is required for its target resolution, local event shadowing and row restoration semantics.",
    evidence: [], assumptions: [], oracleClass: "completeness", coverageRoute: "derived", authority: "Omnishell machine-engine host contract",
  }];
  const graph = terminalRow ? exploreOmnishellWorkflow(chart, options.omnishellEngine!, options.maxConfigurations) : exploreWorkflowControl(value, {
    persisted: options.entry === "persisted", maxConfigurations: options.maxConfigurations,
    invocationOutcome: (src, isRoot) => invocationOutcomePossible(value, options, src, isRoot),
  });
  const obligations: WorkflowObligation[] = [...invocations];
  const add = (property: string, key: string, status: Status, reason: string, evidence: string[]) => {
    obligations.push({ id: `${property}:${path}:${key}`, path, property, status, reason, evidence,
      assumptions: [terminalRow ? "The terminal host owns projected control semantics; opaque guards branch nondeterministically and effects are not executed." : "XState owns projected control semantics; opaque guards branch nondeterministically and effects are not executed.",
        "Ordinary declared events may be supplied. Invocation outcomes and timers remain conditional on their producers; no fairness or eventual delivery is assumed.",
        options.entry === "persisted" ? "Persisted states can be restored; initial-only reachability is not an application invariant." : "The actor begins at its declared initial state."],
      oracleClass: "policy", coverageRoute: "derived", authority: terminalRow ? "Workflow soundness policy; Omnishell host control exploration" : "Workflow soundness policy; XState control exploration" });
  };
  if (!graph.complete) add("workflow-control-coverage", "$root", "unchecked", "Exploration is incomplete; negative reachability conclusions are unavailable.", graph.gaps);
  const finish = new Set(graph.configurations.filter((state) => state.done).map((state) => state.key));
  const backward = (seeds: Set<string>, edges: typeof graph.edges) => {
    const reachable = new Set(seeds);
    const predecessors = new Map<string, string[]>();
    for (const edge of edges) {
      const from = predecessors.get(edge.to) ?? [];
      from.push(edge.from); predecessors.set(edge.to, from);
    }
    for (const target of reachable) for (const from of predecessors.get(target) ?? []) reachable.add(from);
    return reachable;
  };
  const possible = backward(finish, graph.edges), unconditional = backward(finish, graph.edges.filter((edge) => edge.certain));
  for (const state of finiteRoot ? graph.configurations : []) {
    add("workflow-control-completion", state.key, possible.has(state.key) ? "satisfied" : graph.complete && state.certain ? "violation" : "unchecked",
      possible.has(state.key) ? "A path to actor completion exists in the projected control graph; guard/effect feasibility is a separate obligation."
        : graph.complete ? "No actor-completion path exists from this configuration in the explored control graph."
        : "The bounded graph does not establish whether this configuration can complete.", [state.key, ...state.trace]);
    add("workflow-option-to-complete", state.key,
      unconditional.has(state.key) ? "satisfied" : !possible.has(state.key) && graph.complete && state.certain ? "violation" : "unchecked",
      unconditional.has(state.key) ? "An effect-free unconditional control route reaches actor completion when the declared inputs are supplied."
        : "Completion depends on opaque data/effects, producer delivery, or an unavailable control route.", [state.key, ...state.trace]);
  }
  for (const scope of scopes) {
    const active = new Set(graph.configurations.filter((configuration) => configuration.active.includes(scope.id)).map((configuration) => configuration.key));
    const finishing = new Set(graph.edges.filter((edge) => active.has(edge.from) && !edge.entered.includes(scope.id) && edge.activities.some((activity) => activity.startsWith(`${scope.path}.onDone:`))).map((edge) => edge.from));
    const completing = backward(finishing, graph.edges.filter((edge) => active.has(edge.from) && active.has(edge.to) && !edge.exited.includes(scope.id) && !edge.entered.includes(scope.id)));
    for (const configuration of graph.configurations.filter((item) => active.has(item.key))) {
      add("workflow-scope-completion", `${scope.path}:${configuration.key}`, completing.has(configuration.key) ? "satisfied" : graph.complete && configuration.certain ? "violation" : "unchecked",
        completing.has(configuration.key) ? "The invoked compound/parallel scope can reach its completion disposition without exiting and restarting the scope. Data and delivery feasibility remain separate."
          : "No scoped completion disposition is reachable without abandoning this scope.", [scope.path, configuration.key, ...configuration.trace]);
    }
  }
  if (finiteRoot) {
    for (const state of graph.states) {
      const visited = graph.visitedStates.includes(state);
      add("workflow-state-reachability", state, visited ? graph.certainStates.includes(state) ? "satisfied" : "unchecked" : graph.complete ? "violation" : "unchecked",
        visited ? "The state occurs in a projected host execution or restored configuration." : "No explored configuration or transition enters this state.", [state]);
    }
    for (const activity of graph.activities) {
      const visited = graph.visitedActivities.includes(activity);
      add("workflow-activity-reachability", activity, visited ? graph.certainActivities.includes(activity) ? "satisfied" : "unchecked" : graph.complete ? "violation" : "unchecked",
        visited ? "The transition occurs in a projected XState execution; its data and input feasibility remains separate."
          : "No explored configuration enables this transition.", [activity]);
    }
    const opaqueWork = (item: unknown): boolean => {
      if (Array.isArray(item)) return item.some(opaqueWork);
      const record = object(item);
      return !!record && (Object.entries(record).some(([key, child]) => ["actions", "entry", "exit", "assign", "effect", "raise", "reduce", "sql"].includes(key) && nonempty(child)) || Object.values(record).some(opaqueWork));
    };
    const knownLifetimes = invocations.filter((item) => item.property === "workflow-invocation-lifetime").every((item) => item.status === "satisfied");
    const proper = finish.size > 0 && knownLifetimes && !opaqueWork(value);
    add("workflow-proper-completion", "$root", proper ? "satisfied" : "unchecked",
      proper ? "XState joins the completed control regions; declared source attachments are revoked on exit. Independently hosted durable rows are not owned cleanup work."
        : "Opaque effects or unavailable lifetime contracts prevent establishing that completion leaves no owned work.", [...finish]);
  }
  return obligations;
}
