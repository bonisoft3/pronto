import type { OmnishellWorkflowEngine } from "./workflow-omnishell-control.ts";
export type { OmnishellWorkflowEngine } from "./workflow-omnishell-control.ts";
import type { WorkflowObligation } from "./check-workflows.ts";

type Obj = Record<string, any>;
const obj = (value: unknown): Obj | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : undefined;
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
export type WorkflowOptions = {
  entry?: "declared" | "persisted";
  actors?: Record<string, unknown>;
  effects?: Record<string, unknown>;
  host?: "mecha" | "omnishell";
  maxConfigurations?: number;
  omnishellEngine?: OmnishellWorkflowEngine;
};

export function invocationObligations(value: unknown, path: string, options: WorkflowOptions): WorkflowObligation[] {
  const root = obj(value);
  const result: WorkflowObligation[] = [];
  const add = (property: string, key: string, status: WorkflowObligation["status"], reason: string, evidence: string[], assumptions: string[] = []) => {
    result.push({ id: `${property}:${path}:${key}`, path, property, status, reason, evidence, assumptions,
      oracleClass: "completeness", coverageRoute: "derived", authority: "Declared Cortex invocation adapter outcome and lifetime contracts" });
  };
  const walk = (node: Obj, location: string) => {
    list(node.invoke).forEach((raw, index) => {
      const invoke = obj(raw);
      const src = typeof invoke?.src === "string" ? invoke.src : "";
      const binding = obj(options.actors?.[src]);
      const effect = obj(options.effects?.[src]);
      const key = `${location}:${index}`;
      const via = binding?.via;
      const host = options.host ?? root?.meta?.host;
      if (effect && host === "mecha" && location !== "$root") {
        for (const outcome of ["onDone", "onError"]) {
          add("workflow-outcome-producer", `${key}:${outcome}`, invoke?.[outcome] === undefined ? "violation" : "satisfied",
            invoke?.[outcome] === undefined ? "A finite effect invocation has no declared disposition for this adapter outcome."
              : "The declared Mecha effect adapter can publish this invocation outcome; actual delivery and effect success are not proved.", [src, outcome],
            ["The effect runner's accepted outcome callback is the producer; its delivery policy remains owned by the sink."]);
        }
        add("workflow-invocation-lifetime", key, "satisfied", "The effect invocation is attached to a durable row operation; leaving a browser attachment does not imply cancellation of accepted work.", [src],
          ["Row lifetime is not an eventual-delivery guarantee or proof that a callback still matches the active attempt."]);
      } else if (host === "mecha" && location !== "$root" && options.effects !== undefined) {
        add("workflow-outcome-producer", key, "violation", "A Mecha invoking state requires a declared effect; source actors do not supply effect outcome callbacks.", [src],
          ["The existing schema's effect/source namespace rules determine the producer; this is declaration inventory, not a new CUE invariant."]);
      } else if (via === "navigation") {
        for (const outcome of ["onDone", "onError"]) add("workflow-outcome-producer", `${key}:${outcome}`, invoke?.[outcome] === undefined ? "violation" : "satisfied",
          invoke?.[outcome] === undefined ? "Navigation has no declared disposition for a possible promise outcome."
            : "The navigation promise supplies this outcome while its invocation is active.", [src, outcome],
          ["Exiting the invoking state cancels the navigation attachment; successful completion is not guaranteed."]);
        add("workflow-invocation-lifetime", key, "satisfied", "The invocation owns a cancellable navigation attachment, not a detached worker.", [src]);
      } else if (["observe", "rows", "query"].includes(via)) {
        const attachment = via === "rows" || via === "observe";
        add("workflow-invocation-lifetime", key, "satisfied", attachment
          ? "The source attachment ends when its invoking state exits; it does not own the observed durable instance."
          : "The query source is evaluated by the durable dispatcher; it publishes facts rather than child completion.", [src, via],
          ["This checks declared adapter lifetime only; disposal implementation is framework conformance."]);
        for (const outcome of ["onDone", "onError"]) if (invoke?.[outcome] !== undefined) add("workflow-outcome-producer", `${key}:${outcome}`, "violation",
          "This callback/fact source does not publish invocation completion or error events; its declared facts require ordinary event consumers.", [src, via, outcome]);
      } else {
        add("workflow-invocation-lifetime", key, "unchecked", "This invocation's outcome and lifetime semantics are not available to the workflow checker.", [src, via ?? "unknown"]);
      }
    });
    for (const [name, child] of Object.entries(node.states ?? {})) if (obj(child)) walk(obj(child)!, `${location}.${name}`);
  };
  if (root) walk(root, "$root");
  return result;
}

export function invocationOutcomePossible(root: unknown, options: WorkflowOptions, src: string, isRoot: boolean): boolean | undefined {
  const host = options.host ?? obj(root)?.meta?.host;
  if (host === "mecha" && !isRoot && options.effects !== undefined) return obj(options.effects[src]) !== undefined;
  const binding = obj(options.actors?.[src]);
  if (binding?.via === "navigation") return true;
  if (["observe", "rows", "query"].includes(binding?.via)) return false;
  return undefined;
}
