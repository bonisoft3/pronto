import type { MechaReducerMachine, Shape } from "../../../mecha-reducer.ts";

const integer: Shape = {
  type: "integer",
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
};
const text: Shape = { type: "string", maxLength: 128 };
const object = (fields: Record<string, Shape>): Shape => ({
  type: "object",
  fields,
});
const identity = { revision: integer, attempt: integer, artifact: text };
const state = object({
  phase: {
    type: "string",
    maxLength: 10,
    values: ["idle", "running", "retry", "publishing"],
  },
  requested: integer,
  claimed: integer,
  published: integer,
  attempt: integer,
  lease_until: integer,
  completed_attempt: integer,
  completed_revision: integer,
  artifact: text,
});
const common = {
  invalidate: { reduce: "invalidate" },
  complete: { guard: "canComplete", reduce: "complete" },
  acknowledge: { guard: "canAcknowledge", reduce: "acknowledge" },
};

export const machine: MechaReducerMachine = {
  name: "duckstream_batch_spike",
  version: 1,
  fuel: 10_000,
  initial: "idle",
  initialize: { reduce: "initialize", input: object({}) },
  state,
  view: state,
  events: {
    invalidate: { tier: "mecha", payload: object({ revision: integer }) },
    claim: { tier: "mecha", payload: object({}) },
    complete: { tier: "mecha", payload: object(identity) },
    fail: { tier: "mecha", payload: object({ attempt: integer }) },
    expire: { tier: "mecha", payload: object({ attempt: integer }) },
    acknowledge: { tier: "mecha", payload: object(identity) },
  },
  contracts: {
    same: { reads: [], writes: [] },
    invalidate: { reads: ["payload.revision"], writes: ["requested"] },
    canClaim: { reads: ["now"] },
    claim: { reads: ["now"], writes: ["claimed", "attempt", "lease_until"] },
    ownsAttempt: { reads: ["payload.attempt"] },
    canExpire: { reads: ["payload.attempt", "now"] },
    release: { reads: [], writes: ["lease_until"] },
    canComplete: { reads: ["payload.attempt", "payload.revision", "payload.artifact", "now"] },
    complete: { reads: ["payload.attempt", "payload.revision", "payload.artifact"], writes: ["completed_attempt", "completed_revision", "artifact"] },
    hasResult: { reads: [] },
    canAcknowledge: { reads: ["payload.attempt", "payload.revision", "payload.artifact"] },
    acknowledge: { reads: [], writes: ["published"] },
    isPublished: { reads: [] },
  },
  states: {
    idle: {
      final: false,
      on: {
        ...common,
        claim: { guard: "canClaim", reduce: "claim", target: "running" },
      },
    },
    running: {
      final: false,
      on: {
        ...common,
        fail: { guard: "ownsAttempt", reduce: "release", target: "retry" },
        expire: { guard: "canExpire", reduce: "release", target: "retry" },
      },
      always: [{ guard: "hasResult", reduce: "release", target: "publishing" }],
    },
    retry: {
      final: false,
      on: {
        ...common,
        claim: { guard: "canClaim", reduce: "claim", target: "running" },
      },
    },
    publishing: {
      final: false,
      on: common,
      always: [{ guard: "isPublished", reduce: "same", target: "idle" }],
    },
  },
};
