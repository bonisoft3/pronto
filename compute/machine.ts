import type { CortexDurable } from "../cortex-durable.ts";
import type { Shape } from "../mecha-reducer.ts";
const integer: Shape = { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER };
const text: Shape = { type: "string", maxLength: 128 };
const object = (fields: Record<string, Shape>): Shape => ({ type: "object", fields });
const required: Shape = { type: "array", maxItems: 1024, items: object({ name: text, revision: integer }) };
const empty = object({});
const state = object({
  phase: { type: "string", maxLength: 16, values: ["idle", "active"] },
  name: text, requested: integer, completed: integer, wake: integer, claimed: integer,
  required, due: integer, coalesce: integer, attempts: integer,
});
const common = { invalidate: { reduce: "invalidate" }, pin: { reduce: "pin" } };
export const batchMachine: CortexDurable = {
  machine: {
    name: "compute_batch", version: 1, fuel: 100000, initial: "idle",
    initialize: { reduce: "initialize", input: object({ name: text, coalesce: integer, attempts: integer, revision: integer }) },
    state, view: empty,
    events: {
      invalidate: { tier: "mecha", payload: empty },
      pin: { tier: "mecha", payload: object({ required }) },
      schedule: { tier: "mecha", payload: empty },
      claim: { tier: "mecha", payload: empty },
      complete: { tier: "mecha", payload: empty },
      supersede: { tier: "mecha", payload: empty },
    },
    contracts: {
      invalidate: { reads: [], writes: ["requested"] },
      pin: { reads: ["payload.required"], writes: ["required"] },
      pending: { reads: [] },
      schedule: { reads: ["now"], writes: ["wake", "due"] },
      unclaimed: { reads: [] },
      claim: { reads: [], writes: ["claimed", "required"] },
      claimed: { reads: [] },
      complete: { reads: [], writes: ["completed", "claimed", "wake", "due"] },
      newer: { reads: [] },
      supersede: { reads: [], writes: ["claimed", "wake", "due"] },
    },
    states: {
      idle: { final: false, on: { ...common, schedule: { guard: "pending", reduce: "schedule", target: "active" } } },
      active: { final: false, on: {
        ...common,
        claim: { guard: "unclaimed", reduce: "claim" },
        complete: { guard: "claimed", reduce: "complete", target: "idle" },
        supersede: { guard: "newer", reduce: "supersede", target: "idle" },
      } },
    },
    mecha: { locks: "", transitions: [
      { phase: "idle", event: "schedule", requires: [{ sql: "compute.ready(game.id)", reason: "prerequisite_pending" }], sql: "" },
      { phase: "active", event: "claim", requires: [{ sql: "compute.ready(game.id)", reason: "prerequisite_pending" }], sql: "" },
    ] },
  },
  invoke: { active: {
    task: "compute_batch",
    key: "'compute:' || (reduced->'state'->>'name') || ':' || (reduced->'state'->>'wake')",
    input: "jsonb_build_object('name', reduced->'state'->>'name', 'wake', reduced->'state'->>'wake')",
    onDone: "complete", onError: "supersede",
    runAtSql: "to_timestamp((reduced->'state'->>'due')::double precision / 1000)",
    maxAttemptsSql: "(reduced->'state'->>'attempts')::integer",
  } },
};
