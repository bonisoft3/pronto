import type { MechaReducerMachine } from "./mecha-reducer.ts";

/** The prefix of what the runtime states on an event or an input, which no
 * payload or input field begins with: SCXML reserves it for the platform. */
export const STATED = "_";

/** The event fields a rule can read on `event`: the time always, the draw
 * where the machine declares entropy, the origin where a reader sent it, and
 * the payload's fields. A timer's event (XState's `xstate.after.*`) is the
 * machine's own and carries no payload. */
export function carried(spec: MechaReducerMachine, event: string): Set<string> {
  const e = Object.hasOwn(spec.events, event) ? spec.events[event] : {tier: "mecha", payload: {type: "object", fields: {}}};
  const fields = e.payload.type === "object" ? Object.keys(e.payload.fields) : [];
  return new Set([
    "type",
    "_time",
    ...((spec.entropy ?? 0) > 0 ? ["_entropy"] : []),
    ...(e.tier === "omnishell" ? ["_origin"] : []),
    ...fields,
  ]);
}

type Arrow = {target?: string; guard?: string[]; reduce?: string};

// A state named `a.b` is the child `b` of the compound state `a`; a phase is
// atomic, and takes the events and timers of the states it is a child of.
const parentOf = (name: string) => name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : undefined;
/** A state, then the states it is a child of. */
const chain = (name: string | undefined): string[] => name === undefined ? [] : [name, ...chain(parentOf(name))];
/** The atomic state an entry into `name` lands in. */
const leaf = (spec: MechaReducerMachine, name: string): string => spec.states[name].initial === undefined ? name : leaf(spec, spec.states[name].initial!);
const atomic = (spec: MechaReducerMachine) => Object.keys(spec.states).filter((name) => spec.states[name].initial === undefined);
/** Every arrow a step from `phase` can take, on any event. */
const leaving = (spec: MechaReducerMachine, phase: string): Arrow[] => chain(phase).flatMap((name) => {
  const state = spec.states[name];
  return [...Object.values(state.on), ...(state.always ?? []), ...Object.values(state.after ?? {}).flat()];
});

/** The arrows a step from `phase` can take on `event`: the transition of the
 * innermost state taking it, or for a timer's event
 * (`xstate.after.<delay>.<state>`) the delay's, tried in order. */
const arrows = (spec: MechaReducerMachine, phase: string, event: string): Arrow[] => {
  const timer = /^xstate\.after\.([^.]+)\.(.+)$/.exec(event);
  if (timer && !Object.hasOwn(spec.events, event)) return spec.states[timer[2]]?.after?.[timer[1]] ?? [];
  const taker = chain(phase).find((name) => spec.states[name].on[event]);
  return taker === undefined ? [] : [spec.states[taker].on[event]];
};

/** The events a step from `phase` takes: its own and its parents', and each
 * of their timers'. */
const taken = (spec: MechaReducerMachine, phase: string): string[] => [...new Set(chain(phase).flatMap((name) => [
  ...Object.keys(spec.states[name].on),
  ...Object.keys(spec.states[name].after ?? {}).map((delay) => `xstate.after.${delay}.${name}`),
]))];

/** Every rule a step on `event` from `phase` can run: the transition's guard
 * and action, then the guards and actions of every `always` arrow reachable
 * from where it lands, whichever of their guards hold. */
export function reached(spec: MechaReducerMachine, phase: string, event: string): string[] {
  const rules: (string | undefined)[] = [];
  const seen = new Set<string>();
  const pending: string[] = [];
  for (const arrow of arrows(spec, phase, event)) {
    rules.push(...(arrow.guard ?? []), arrow.reduce);
    pending.push(arrow.target === undefined ? phase : leaf(spec, arrow.target));
  }
  while (pending.length) {
    const at = pending.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const next of chain(at).flatMap((name) => spec.states[name].always ?? [])) {
      rules.push(...(next.guard ?? []), next.reduce);
      pending.push(leaf(spec, next.target));
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
  for (const [name, event] of Object.entries(spec.events)) {
    for (const field of event.payload.type === "object" ? Object.keys(event.payload.fields) : []) {
      if (field.startsWith(STATED)) fail(`event ${name} carries a payload field ${field}, and a name beginning ${STATED} is the runtime's to state`);
      if (field === "type") fail(`event ${name} carries a payload field type, which is the event's own name`);
    }
  }
  for (const field of spec.initialize?.input.type === "object" ? Object.keys(spec.initialize.input.fields) : []) {
    if (field.startsWith(STATED)) fail(`the input carries a field ${field}, and a name beginning ${STATED} is the runtime's to state`);
  }
  const fields = spec.state.type === "object" ? spec.state.fields : {};
  const guards = new Set<string>();
  const actions = new Set<string>();
  for (const state of Object.values(spec.states)) {
    for (const arrow of [...Object.values(state.on), ...(state.always ?? []), ...Object.values(state.after ?? {}).flat()]) {
      for (const guard of arrow.guard ?? []) guards.add(guard);
      if (arrow.reduce) actions.add(arrow.reduce);
    }
  }
  for (const rule of [...guards, ...actions]) {
    // A transition's guards reach the chart as one name, joined by a space.
    if (!/^[A-Za-z_$][\w$]*$/.test(rule)) fail(`rule ${JSON.stringify(rule)} is not a name: a letter, then letters, digits, _ or $`);
    if (!contracts[rule]) fail(`${rule} states no contract in setup`);
  }
  for (const rule of guards) {
    if (contracts[rule].writes !== undefined) fail(`guard ${rule} writes`);
  }
  for (const [rule, contract] of Object.entries(contracts)) {
    if (contract.reason !== undefined && !guards.has(rule)) fail(`${rule} states a reason, and is no transition's guard`);
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
 * origin, run by an event the machine's own tier sends. The runtime hands such
 * a read nothing, so this finds it before any step does. */
export function carries(spec: MechaReducerMachine): string[] {
  const found = new Set<string>();
  for (const phase of atomic(spec)) {
    if (spec.states[phase].final) continue;
    for (const event of taken(spec, phase)) {
      const inputs = carried(spec, event);
      const tier = Object.hasOwn(spec.events, event) ? spec.events[event].tier : "mecha";
      for (const rule of reached(spec, phase, event)) {
        for (const input of spec.contracts![rule].reads) {
          if (!inputs.has(input)) found.add(`${rule} reads ${input}, which ${event} (a ${tier} event) does not carry into ${phase}`);
        }
      }
    }
  }
  return [...found];
}

/** Where a machine can stop with nothing to move it on: a non-final state the
 * chart reaches with no transition to another. */
export function moving(spec: MechaReducerMachine): string[] {
  const found: string[] = [];
  const reachable = new Set<string>();
  const pending = [leaf(spec, spec.initial)];
  while (pending.length) {
    const at = pending.pop()!;
    if (reachable.has(at)) continue;
    reachable.add(at);
    for (const arrow of leaving(spec, at)) pending.push(arrow.target === undefined ? at : leaf(spec, arrow.target));
  }
  for (const name of reachable) {
    const leaves = leaving(spec, name).some((arrow) => arrow.target !== undefined && leaf(spec, arrow.target) !== name);
    if (!spec.states[name].final && !leaves) found.push(`${name} is not final and nothing leaves it`);
  }
  return found;
}
