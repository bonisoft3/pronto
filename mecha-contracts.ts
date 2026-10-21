import type { MechaReducerMachine } from "./mecha-reducer.ts";

/** The step's inputs an event reaches its rules with: the time always, the
 * draw where the machine declares entropy, the sender where a reader sent it,
 * and the payload's fields. */
export function carried(spec: MechaReducerMachine, event: string): Set<string> {
  const e = spec.events[event];
  const fields = e.payload.type === "object" ? Object.keys(e.payload.fields) : [];
  return new Set([
    "now",
    ...((spec.entropy ?? 0) > 0 ? ["entropy"] : []),
    ...(e.tier === "omnishell" ? ["actor"] : []),
    ...fields.map((f) => `payload.${f}`),
  ]);
}

/** Every rule a step on `event` from `phase` can run: the transition's guard
 * and action, then the guards and actions of every `always` arrow reachable
 * from where it lands, whichever of their guards hold. */
export function reached(spec: MechaReducerMachine, phase: string, event: string): string[] {
  const arrow = spec.states[phase].on[event];
  const rules = [arrow.guard, arrow.reduce];
  const seen = new Set<string>();
  const pending = [arrow.target ?? phase];
  while (pending.length) {
    const at = pending.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const next of spec.states[at].always ?? []) {
      rules.push(next.guard, next.reduce);
      pending.push(next.target);
    }
  }
  return [...new Set(rules.filter((r): r is string => r !== undefined))];
}

/** Refuses, as the machine is generated, one whose rules are not each under
 * a contract or whose contracts write what the context does not hold: the
 * runtime could not enforce them. */
export function contracted(spec: MechaReducerMachine): void {
  const fail = (message: string): never => {
    throw new Error(`${spec.name}: ${message}`);
  };
  const contracts = spec.contracts ?? {};
  const fields = spec.state.type === "object" ? spec.state.fields : {};
  const guards = new Set<string>();
  const actions = new Set<string>();
  for (const state of Object.values(spec.states)) {
    for (const arrow of [...Object.values(state.on), ...(state.always ?? [])]) {
      if (arrow.guard) guards.add(arrow.guard);
      if (arrow.reduce) actions.add(arrow.reduce);
    }
  }
  for (const rule of [...guards, ...actions]) {
    if (!contracts[rule]) fail(`${rule} states no contract in setup`);
  }
  for (const rule of guards) {
    if (contracts[rule].writes?.length) fail(`guard ${rule} writes`);
  }
  for (const rule of actions) {
    if (contracts[rule].writes === undefined) fail(`${rule} is an action, and its contract lists no writes`);
    for (const field of contracts[rule].writes!) {
      if (field === "phase") fail(`${rule} writes phase, which the chart's target decides`);
      if (!Object.hasOwn(fields, field)) fail(`${rule} writes ${field}, which the context does not hold`);
    }
  }
}

/** The reads some event reaching a rule does not carry: an action reading the
 * sender, run by an event the machine's own tier sends. The runtime refuses
 * that read when it happens; this finds it before any step does. */
export function carries(spec: MechaReducerMachine): string[] {
  const found = new Set<string>();
  for (const [phase, state] of Object.entries(spec.states)) {
    if (state.final) continue;
    for (const event of Object.keys(state.on)) {
      const inputs = carried(spec, event);
      for (const rule of reached(spec, phase, event)) {
        for (const input of spec.contracts![rule].reads) {
          if (!inputs.has(input)) found.add(`${rule} reads ${input}, which ${event} (a ${spec.events[event].tier} event) does not carry into ${phase}`);
        }
      }
    }
  }
  return [...found];
}

/** Where a machine can stop with nothing to move it on: a non-final state the
 * chart reaches with no transition to another, and a phase the ticker wakes
 * that does not take the wake's event, whose delivery would be refused on
 * every tick. */
export function moving(spec: MechaReducerMachine): string[] {
  const found: string[] = [];
  const reachable = new Set<string>();
  const pending = [spec.initial];
  while (pending.length) {
    const at = pending.pop()!;
    if (reachable.has(at)) continue;
    reachable.add(at);
    const state = spec.states[at];
    for (const arrow of Object.values(state.on)) pending.push(arrow.target ?? at);
    for (const arrow of state.always ?? []) pending.push(arrow.target);
  }
  for (const name of reachable) {
    const state = spec.states[name];
    const leaves = [...Object.values(state.on), ...(state.always ?? [])].some((arrow) => (arrow.target ?? name) !== name);
    if (!state.final && !leaves) found.push(`${name} is not final and nothing leaves it`);
  }
  const wake = spec.ports?.wake;
  for (const phase of wake?.phases ?? []) {
    if (!spec.states[phase]?.on[wake!.event]) found.push(`the ticker wakes ${phase} with ${wake!.event}, which ${phase} does not take`);
  }
  return found;
}
