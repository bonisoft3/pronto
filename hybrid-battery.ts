// The runtime holds under any input a step can be given.
//
// A machine is walked from a fresh instance by seeded draws: every event,
// from either tier, from any seat or none, with payloads drawn inside their
// declared shapes and some outside them, at a clock that only moves on. Each
// step answers accepted or rejected, or the runtime refuses what it was sent
// (a RefusedError: another tier's event, a payload outside its shape); any
// other throw is the machine failing, and is what this finds: a rule reading
// what is not there, a state outside its shape or invariant, a write outside
// a contract, a step out of fuel. The walk follows every accepted
// step, so it reaches the phases a real instance does, and starts again from
// where it began whenever it lands in a final one, which takes no event. It
// reports the phases it stood in, so a walk that never left its first is seen
// to have proved nothing.

import type { MechaReducerMachine, Shape } from "./mecha-reducer.ts";
import { executeHybrid } from "./hybrid-local.ts";

type Draw = (n: number) => number;

function draws(seed: number): Draw {
  let s = seed >>> 0 || 1;
  return (n) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
}

/** A value inside `shape`, drawn. */
export function inside(shape: Shape, draw: Draw): unknown {
  switch (shape.type) {
    case "string":
      // At its full length as often as not: an identity is a string of one.
      if (shape.values) return shape.values[draw(shape.values.length)];
      return "x".repeat(draw(2) === 0 ? shape.maxLength : draw(Math.min(shape.maxLength, 8) + 1));
    case "integer": {
      const span = Math.min(shape.max - shape.min, 1000);
      return shape.min + draw(span + 1);
    }
    case "boolean":
      return draw(2) === 0;
    case "array":
      return Array.from({ length: draw(Math.min(shape.maxItems, 3) + 1) }, () => inside(shape.items, draw));
    case "object":
      return Object.fromEntries(Object.entries(shape.fields).map(([k, v]) => [k, inside(v, draw)]));
  }
}

/** A runtime failure the walk found: the input that crashed it, and how. */
export type Crash = { input: unknown; error: string };

/** What a walk met: every crash, and every phase it stood in. */
export type Walked = { crashes: Crash[]; visited: string[] };

/** Walks `spec` from `start` for `steps` draws. */
export async function walk(
  spec: MechaReducerMachine,
  source: string,
  start: unknown,
  seats: string[],
  seed: number,
  steps: number,
): Promise<Walked> {
  const draw = draws(seed);
  const events = Object.keys(spec.events);
  const hex = (n: number) => Array.from({ length: n * 2 }, () => "0123456789abcdef"[draw(16)]).join("");
  const crashes: Crash[] = [];
  const visited = new Set<string>();
  const phase = (s: unknown) => (s as { phase: string }).phase;
  let state = start;
  visited.add(phase(state));
  let now = 1000;
  for (let i = 0; i < steps; i++) {
    const kind = events[draw(events.length)];
    const declared = spec.events[kind];
    // Mostly the declared tier and a payload inside its shape; sometimes not.
    const tier = draw(8) === 0 ? (declared.tier === "mecha" ? "omnishell" : "mecha") : declared.tier;
    const payload = draw(8) === 0 ? { stray: true } : inside(declared.payload, draw);
    now += draw(3) === 0 ? draw(60000) : draw(100);
    const context: Record<string, unknown> = { tier, now };
    if (tier === "omnishell") context.actor = seats[draw(seats.length)];
    if ((spec.entropy ?? 0) > 0) context.entropy = hex(spec.entropy!);
    const input = { state, event: { kind, payload }, context, viewers: seats };
    try {
      const answer = await executeHybrid(source, spec.fuel, input) as { kind: string; state?: unknown };
      if (answer.kind === "accepted") {
        visited.add(phase(answer.state));
        state = spec.states[phase(answer.state)].final ? start : answer.state;
      }
    } catch (err) {
      const { name, message } = err as Error;
      if (name !== "RefusedError") crashes.push({ input, error: `${name}: ${message}` });
    }
  }
  return { crashes, visited: [...visited].sort() };
}
