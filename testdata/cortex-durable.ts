import type { CortexDurable } from "../cortex-durable.ts";

const object = { type: "object" as const, fields: {} };
export const spec: CortexDurable = {
  machine: {
    name: "durable_test",
    version: 1,
    fuel: 10000,
    initial: "idle",
    state: { type: "object", fields: {
      phase: { type: "string", maxLength: 16 },
      requested: { type: "integer", min: 0, max: 100 },
      wake: { type: "integer", min: 0, max: 100 },
    } },
    view: object,
    events: {
      request: { tier: "mecha", payload: object },
      invalidate: { tier: "mecha", payload: object },
      done: { tier: "mecha", payload: object },
      failed: { tier: "mecha", payload: object },
    },
    contracts: {
      request: { reads: [], writes: ["requested", "wake"] },
      increment: { reads: [], writes: ["requested"] },
      keep: { reads: [], writes: [] },
    },
    states: {
      idle: { final: false, on: { request: { target: "active", reduce: "request" } } },
      active: { final: false, on: {
        invalidate: { reduce: "increment" },
        done: { target: "idle", reduce: "keep" },
        failed: { target: "failed", reduce: "keep" },
      } },
      failed: { final: true, on: {} },
    },
  },
  invoke: {
    active: {
      task: "durable_test",
      key: "game.id::text || ':' || (reduced->'state'->>'wake')",
      input: "jsonb_build_object('instance', game.id)",
      onDone: "done",
      onError: "failed",
      runAtSql: "clock_timestamp() + interval '1 second'",
      maxAttemptsSql: "3",
    },
  },
};
export const rules = `return {
  project: () => ({}),
  invariant: state => state.requested >= 0,
  request: state => ({...state, requested: state.requested + 1, wake: state.requested + 1}),
  increment: state => ({...state, requested: state.requested + 1}),
  keep: state => ({...state})
};`;
