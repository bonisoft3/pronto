import assert from "node:assert/strict";
import { checkBackendChart, inventory, type BackendConfig } from "./cortex-conformance.ts";

const config: BackendConfig = {
  id: "fixture", initial: "idle", meta: { host: "mecha" },
  states: {
    idle: { on: { facts: [{ target: "active", guard: "ready", actions: ["first", "second"] }, { target: "done", guard: "ready" }, { actions: "fallback" }] } },
    active: { on: { finish: "done", same: { target: "active", actions: "self" } } },
    done: { invoke: { src: "effect", onDone: "idle", onError: "idle" } },
  },
};

Deno.test("backend conformance preserves literal state keys at the XState boundary", async () => {
  const result = await checkBackendChart("literal", {
    id: "literal", initial: "active.x", states: Object.fromEntries([
      ["active.x", { on: { facts: "#active" } }],
      ["#active", { on: { facts: "__proto__" } }],
      ["__proto__", { on: { facts: "active.x" } }],
    ]),
  }, { sourceEvents: ["facts"] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unsupported, []);
  assert.equal(result.covered.length, 3);
});

Deno.test("backend conformance reports scripted branch and outcome coverage", async () => {
  const result = await checkBackendChart("fixture", config, { sourceEvents: ["facts", "finish", "same"] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.covered.length, 4);
  assert.equal(result.unvisited.length, 3);
  assert.ok(result.unvisited.some((arrow) => arrow.state === "idle" && arrow.index === 1));
  assert.equal(result.unvisited.filter((arrow) => arrow.key.startsWith("invoke.")).length, 2);
  const sourceOnly = inventory("fixture", config, ["facts"]).report;
  assert.equal(sourceOnly.unvisited.filter((arrow) => arrow.reason === "direct row transition not exercised").length, 2);
  assert.ok(inventory("fixture", config, ["facts", "missing"]).report.unvisited.some((arrow) => arrow.key === "missing" && arrow.reason === "source event has no chart transition"));
});

Deno.test("backend conformance rejects unsupported constructs and detects an emitter mutation", async () => {
  const unsupported = structuredClone(config);
  unsupported.states.idle.always = "active";
  assert.ok(inventory("unsupported", unsupported, ["facts", "finish", "same"]).report.unsupported.includes("idle.always"));
  const mutated = await checkBackendChart("fixture", config, { sourceEvents: ["facts", "finish", "same"], mutateSql: (sql) => sql.replace('NEW."status" := \'active\';', 'NEW."status" := \'idle\';') });
  assert.ok(mutated.errors.some((message) => message.includes("idle --facts[0]")));
});
