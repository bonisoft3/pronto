import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { checkVerification, declarationInventory, inventory } from "./check-verification.ts";

Deno.test("verification inventory preserves oracle authority and unsupported coverage independently", () => {
  const report = inventory([
    { id: "current", path: "screen.html", property: "aria-current", status: "violation", reason: "multiple current items", evidence: [],
      oracleClass: "policy", coverageRoute: "default", authority: "WAI-ARIA", assumptions: ["related set identified"] },
    { id: "opaque", path: "screen.html", property: "presentation-coverage", status: "unchecked", reason: "opaque renderer", evidence: [] },
  ], []);
  assertEquals(report.counts, { satisfied: 0, violation: 1, unchecked: 1 });
  assertEquals(report.byRoute.default.violation, 1);
  assertEquals(report.byRoute.derived.unchecked, 1);
  assertEquals(report.obligations.find((item) => item.id === "current")?.authority, "WAI-ARIA");
  assertEquals(report.coverage.unchecked, 1);
});

Deno.test("empty verification inventory is explicitly zero coverage", () => {
  assertEquals(inventory([], []).coverage.obligations, 0);
});

Deno.test("declaration inventory preserves source contracts and nested invocation locations", () => {
  const result = declarationInventory({ cortex: { root: { meta: { host: "omnishell" }, states: {
    loading: { invoke: { src: "route", onDone: "ready" } }, ready: { type: "final" },
  } } }, cortexImplementations: { root: { actors: { route: { via: "navigation", lifetime: "attachment" } } } } });
  assertEquals(result.machines[0].invocations, 1);
  assertEquals(result.machines[0].host, "omnishell");
  assertEquals(result.connections[0].contract, { via: "navigation", lifetime: "attachment" });
  assertEquals(result.connections[0].outcomes, ["onDone"]);
  assertEquals(result.machines[0].finals, [".pronto/check-inputs.json#cortex.root.states.ready"]);
});

Deno.test("inventory covers DOM participants, source lifetimes, event schemas and sink guarantees without interpreting bodies", () => {
  const result = declarationInventory({
    mounts: [{ path: "screen.html", index: 2, table: "form", family: "forms", screen: "editor", chart: {
      initial: "idle", states: { idle: { on: { submit: "waiting" } }, waiting: { invoke: { id: "result", src: "progress", input: { id: "context.id" } }, after: { 200: "idle" } } },
    } }],
    actors: { progress: { via: "observe", lifetime: "attachment", match: { id: "id" } } },
    effects: { work: { key: ["id"], input: { raw: "opaque" }, sink: { idempotent: true }, attempts: 3 } },
    mountGaps: [{ path: "screen.html", reason: "unresolved template" }],
  });
  assertEquals(result.machines[0].host, "omnishell");
  assertEquals(result.machines[0].identity, { table: "form", family: "forms", screen: "editor" });
  assertEquals(result.machines[0].statesInventory[1].events, ["submit"]);
  assertEquals(result.connections[0].contract, { via: "observe", lifetime: "attachment", match: { id: "id" } });
  assertEquals(result.connections[0].invocation, "result");
  assertEquals(result.effects[0].sink, { idempotent: true });
  assertEquals(result.effects[0].input, { raw: "opaque" });
  assertEquals(result.gaps.length, 1);
});

Deno.test("combined gate supports backend-only programs without requiring a terminal", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.pronto`);
    await Deno.writeTextFile(`${dir}/.pronto/check-inputs.json`, JSON.stringify({
      version: 1, entities: {}, hatches: {}, reducers: {}, rawMigrations: [], duckstreams: {},
      types: { types: {}, aliases: {} },
      cortex: { job: { meta: { host: "mecha" }, initial: "start", states: { start: { on: { finish: "done" } }, done: { type: "final" } } } },
    }));
    const result = await checkVerification(dir, new URL("../omnishell/", import.meta.url).pathname);
    assertEquals(result.declarations?.terminal, "absent");
    assertEquals(result.obligations.some((item) => item.checker === "presentation"), false);
    assertEquals(result.counts.violation, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("missing declared terminal cannot turn verification into a backend-only pass", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.pronto`);
    const base = { version: 1, entities: {}, hatches: {}, reducers: {}, rawMigrations: [], duckstreams: {}, types: { types: {}, aliases: {} } };
    for (const declaration of [{ terminal: true }, { cortex: { root: { meta: { host: "omnishell" }, states: { idle: {} } } } }]) {
      await Deno.writeTextFile(`${dir}/.pronto/check-inputs.json`, JSON.stringify({ ...base, ...declaration }));
      await assertRejects(() => checkVerification(dir, new URL("../omnishell/", import.meta.url).pathname), Error, "missing declared terminal");
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("effect invocation provenance cannot collide with Cortex actor namespaces", () => {
  const result = declarationInventory({
    machines: { work: { states: { active: { invoke: { src: "send" } } } } },
    cortexImplementations: { work: { actors: { send: { via: "observe" } } } },
    effects: { send: { sink: { idempotent: false }, reentry: "unknown" } },
  });
  assertEquals(result.connections[0].contract, { sink: { idempotent: false }, reentry: "unknown" });
  assertEquals(result.connections[0].contractPath, ".pronto/check-inputs.json#effects.send");
  assertEquals(result.effects[0].reentry, "unknown");
});

Deno.test("Cortex root query and state effect resolve independent namespaces", () => {
  const result = declarationInventory({
    cortex: { work: { meta: { host: "mecha" }, invoke: { src: "same" }, states: { active: { invoke: { src: "same" } } } } },
    cortexImplementations: { work: { actors: { same: { via: "query", event: "facts" } } } },
    effects: { same: { sink: { idempotent: true } } },
  });
  assertEquals(result.connections.map((item) => item.contractPath), [
    ".pronto/check-inputs.json#cortexImplementations.work.actors.same", ".pronto/check-inputs.json#effects.same",
  ]);
});
