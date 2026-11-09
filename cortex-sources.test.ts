import { compileCortexSql } from "./cortex-machine.ts";
import assert from "node:assert/strict";
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { pg_ivm } from "npm:@electric-sql/pglite-pg_ivm@0.0.9";
import { createActor, createMachine, initialTransition, transition } from "npm:xstate@5.32.6";
import { compileCortexSources, type CortexChart } from "./cortex-sources.ts";

const entities = { Job: { table: "job", fields: [{ name: "id", pk: true }, { name: "status" }, { name: "marker" }] } };
const chart: CortexChart = {
  config: {
    id: "job", initial: "idle",
    meta: { host: "mecha", entity: "Job", field: "status", function: "advance_jobs", migration: "019_jobs.sql", watch: ["Job"] },
    invoke: { src: "facts" }, states: { idle: {}, done: {} },
  },
  setup: { actors: { facts: { via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, jsonb_build_object('ready', true) AS payload FROM job WHERE false" } } },
};

async function machineSql(givenMachine?: unknown, givenEffects: unknown = {}, givenEntity?: { name: string; table: string; durability: string; fields: unknown[] }) {
  const defaultMachine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: {
    idle: { on: { facts: [
      { target: "done", guard: "(cortex_payload->>'first')::boolean", actions: [{ assign: { marker: "first" } }] },
      { target: "done", guard: "(cortex_payload->>'second')::boolean", actions: [{ assign: { marker: "second" } }] },
      { actions: [{ assign: { marker: "fallback" } }] },
    ], direct: "done" } }, done: {},
  } };
  const machine = givenMachine ?? defaultMachine;
  const entity = givenEntity ?? { name: "Job", table: "job", durability: "server", fields: [
    { name: "id", type: "string", pk: true }, { name: "status", type: "string" }, { name: "marker", type: "string" },
  ] };
  const expression = `(#mechaMachineSql & {machine: ${JSON.stringify(machine)}, entities: ${JSON.stringify({ [entity.name]: entity })}, effects: ${JSON.stringify(givenEffects)}})._stateMachineSql`;
  const out = await new Deno.Command("cue", { args: ["export", ".:pronto", "-e", expression], cwd: new URL(".", import.meta.url), stdout: "piped", stderr: "piped" }).output();
  assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
  return compileCortexSql(JSON.parse(new TextDecoder().decode(out.stdout)));
}

Deno.test("Cortex row state keys stay literal through XState compilation and guard diagnostics", async () => {
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "active.x", guards: {}, level: "replicated", states: Object.fromEntries([
    ["active.x", { on: { facts: "#active", direct: { target: "#active", guard: "false" } } }],
    ["#active", { on: { facts: "__proto__" } }],
    ["__proto__", { on: { facts: "active.x" } }],
  ]) };
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL)");
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([chart], entities));
    await db.exec("INSERT INTO job VALUES ('a','active.x','')");
    await assert.rejects(() => db.exec("UPDATE job SET status='#active'"), /guard failed on Cortex transition/);
    for (const expected of ["#active", "__proto__", "active.x"]) {
      await db.exec("SELECT cortex_runtime.dispatch_job('a','facts','{}')");
      assert.equal((await db.query<{ status: string }>("SELECT status FROM job")).rows[0].status, expected);
    }
  } finally { await db.close(); }
});

Deno.test("Cortex dispatch matches XState ordered guards and targetless actions", async () => {
  const reference = createMachine({
    id: "job", initial: "idle", states: {
      idle: { on: { facts: [
        { target: "done", guard: ({ event }: any) => event.first },
        { target: "done", guard: ({ event }: any) => event.second },
        { actions: () => {} },
      ] } }, done: {},
    },
  } as any);
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service; CREATE ROLE app_user; CREATE ROLE anon;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO service, app_user, anon;
      ALTER DEFAULT PRIVILEGES GRANT USAGE, CREATE ON SCHEMAS TO service, app_user, anon;
      CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL, txid bigint DEFAULT 0);
      CREATE FUNCTION restamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.txid := OLD.txid + 1; RETURN NEW; END $$;
      CREATE TRIGGER aaa_restamp BEFORE UPDATE ON job FOR EACH ROW EXECUTE FUNCTION restamp()`);
    await db.exec(await machineSql());
    await db.exec(compileCortexSources([chart], entities));
    for (const role of ["service", "app_user", "anon"]) {
      const access = (await db.query<{ schema_access: boolean; table_access: boolean }>(
        "SELECT has_schema_privilege($1, 'cortex_runtime', 'USAGE') AS schema_access, has_table_privilege($1, 'cortex_runtime.dispatch_frame', 'INSERT') AS table_access", [role],
      )).rows[0];
      assert.equal(access.schema_access, false);
      assert.equal(access.table_access, false);
    }
    for (const [id, first, second, marker] of [["a", true, true, "first"], ["b", false, true, "second"], ["c", false, false, "fallback"]] as const) {
      await db.query("INSERT INTO job VALUES ($1, 'idle', '')", [id]);
      const [initial] = initialTransition(reference);
      const [expected] = transition(reference, initial, { type: "facts", first, second } as any);
      await db.query("SELECT cortex_runtime.dispatch_job($1, 'facts', $2::jsonb)", [id, JSON.stringify({ first, second })]);
      const row = (await db.query<{ status: string; marker: string }>("SELECT status, marker FROM job WHERE id = $1", [id])).rows[0];
      assert.equal(row.status, expected.value);
      assert.equal(row.marker, marker);
    }
    const unchanged = await db.query<{ changed: boolean }>("SELECT cortex_runtime.dispatch_job('c', 'facts', '{\"first\":false,\"second\":false}'::jsonb) AS changed");
    assert.equal(unchanged.rows[0].changed, false);
    await db.exec("INSERT INTO job VALUES ('d', 'idle', ''); UPDATE job SET status = 'done' WHERE id = 'd'");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job WHERE id = 'd'")).rows[0].status, "done");
    await db.exec("INSERT INTO job VALUES ('e', 'idle', '')");
    await assert.rejects(() => db.query("SELECT cortex_runtime.dispatch_job('e', 'facts', '{\"first\":\"invalid\"}'::jsonb)"));
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job WHERE id = 'e'")).rows[0].status, "idle");
    assert.equal((await db.query("SELECT * FROM cortex_runtime.dispatch_frame")).rows.length, 0);
  } finally { await db.close(); }
});

Deno.test("Cortex gates chart-owned and relational sink tables even when they do not wake it", () => {
  const c = structuredClone(chart);
  c.config.meta.watch = [];
  c.setup.actions = { write: [{ effect: { op: "ensure", table: "sink", values: { id: "x" } } }] };
  const sql = compileCortexSources([c], entities);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON "public"\."job"/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON "public"\."sink"/);
  assert.doesNotMatch(sql, /AFTER INSERT OR UPDATE OR DELETE ON "job"/);
});

Deno.test("Cortex query sources reject unbound actors and unknown watches", () => {
  const bad = structuredClone(chart);
  bad.setup.actors.facts.via = "observe";
  assert.throws(() => compileCortexSources([bad], entities), /not a query/);
  bad.setup.actors.facts.via = "query";
  bad.setup.actors.extra = { via: "observe" };
  assert.throws(() => compileCortexSources([bad], entities), /actor extra is not a query/);
  bad.setup.actors.extra = { via: "query", event: "extra", select: "SELECT 1" };
  assert.throws(() => compileCortexSources([bad], entities), /query extra is not invoked/);
  delete bad.setup.actors.extra;
  bad.config.meta.watch = ["missing"];
  assert.throws(() => compileCortexSources([bad], entities), /watch/);
  const unsupported = structuredClone(chart);
  unsupported.config.states.idle = { always: "done" };
  assert.throws(() => compileCortexSources([unsupported], entities), /unsupported always/);
  unsupported.config.states.idle = { on: { facts: { target: "done", actions: "setState" } } };
  unsupported.setup.actions = { setState: [{ assign: { status: "done" } }] };
  assert.throws(() => compileCortexSources([unsupported], entities), /cannot assign the state field/);
});

Deno.test("Airlock receipt chooses the chart's ordered unknown or failed outcome", async () => {
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "external", states: {
    idle: { on: { start: "pending" } },
    pending: { invoke: { src: "draw", onDone: "done", onError: [
      { target: "unknown", guard: "outcome->>'kind' = 'unknown'", actions: [{ assign: { marker: "unknown" } }] },
      { target: "failed", actions: [{ assign: { marker: "failed" } }] },
    ] } }, done: {}, unknown: {}, failed: {},
  } };
  const effects = { draw: { name: "draw", sink: { origin: "https://example.com", idempotent: true }, note: "deduplicated" } };
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      CREATE SCHEMA airlock; CREATE TABLE airlock.external_effect_ledger(key text PRIMARY KEY, outcome jsonb);`);
    await db.exec(await machineSql(machine, effects));
    await db.exec(`ALTER TABLE job DISABLE TRIGGER ALL;
      INSERT INTO job VALUES ('a', 'pending', ''), ('b', 'pending', '');
      ALTER TABLE job ENABLE TRIGGER ALL;
      INSERT INTO airlock.external_effect_ledger VALUES
        ('draw:a', '{"target":"failed","kind":"unknown"}'),
        ('draw:b', '{"target":"failed","kind":"failed"}');
      UPDATE job SET status = 'failed' WHERE id IN ('a', 'b');`);
    assert.deepEqual((await db.query("SELECT id, status, marker FROM job ORDER BY id")).rows, [
      { id: "a", status: "unknown", marker: "unknown" }, { id: "b", status: "failed", marker: "failed" },
    ]);
  } finally { await db.close(); }
});

Deno.test("nested dispatch consumes its own frame and counts action-only relational writes", async () => {
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: {
    idle: { on: { facts: [
      { guard: "NEW.id = 'a'", actions: [{ effect: { op: "update", table: "signal", values: { value: 1 }, rawWhere: "id = 'go' AND value = 0" } }] },
      { target: "done", guard: "NEW.id = 'b'" },
    ] } }, done: {},
  } };
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); CREATE TABLE signal(id text PRIMARY KEY, value integer NOT NULL); INSERT INTO signal VALUES ('go', 0)");
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([chart], entities));
    await db.exec(`CREATE FUNCTION signal_nested() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM cortex_runtime.dispatch_job('b', 'facts', '{}'::jsonb); RETURN NEW; END $$;
      CREATE TRIGGER signal_nested AFTER UPDATE ON signal FOR EACH ROW EXECUTE FUNCTION signal_nested();
      INSERT INTO job VALUES ('a', 'idle', ''), ('b', 'idle', '');`);
    const first = await db.query<{ changed: boolean }>("SELECT cortex_runtime.dispatch_job('a', 'facts', '{}'::jsonb) AS changed");
    assert.equal(first.rows[0].changed, true);
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job WHERE id = 'b'")).rows[0].status, "done");
    const again = await db.query<{ changed: boolean }>("SELECT cortex_runtime.dispatch_job('a', 'facts', '{}'::jsonb) AS changed");
    assert.equal(again.rows[0].changed, false);
    assert.equal((await db.query("SELECT * FROM cortex_runtime.dispatch_frame")).rows.length, 0);
  } finally { await db.close(); }
});

Deno.test("Cortex executes named transition actions in XState order", async () => {
  const trace: string[] = [];
  const reference = createMachine({ id: "job", initial: "idle", states: { idle: { on: { facts: { target: "done", actions: [() => trace.push("a"), () => trace.push("b")] } } }, done: {} } } as any);
  const actor = createActor(reference).start();
  actor.send({ type: "facts" } as any);
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: {
    idle: { on: { facts: { target: "done", actions: [{ assign: { marker: { raw: "NEW.marker || 'a'" } } }, { assign: { marker: { raw: "NEW.marker || 'b'" } } }] } } }, done: {},
  } };
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL)");
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([chart], entities));
    await db.exec("INSERT INTO job VALUES ('a', 'idle', '')");
    await db.query("SELECT cortex_runtime.dispatch_job('a', 'facts', '{}'::jsonb)");
    const row = (await db.query<{ status: string; marker: string }>("SELECT status, marker FROM job WHERE id = 'a'")).rows[0];
    assert.equal(row.status, actor.getSnapshot().value);
    assert.equal(row.marker, trace.join(""));
  } finally { actor.stop(); await db.close(); }
});

Deno.test("Cortex reuses unchanged facts and skips rows without a handler", async () => {
  const c = structuredClone(chart);
  c.config.meta.watch = [];
  c.config.states = { idle: { on: { facts: {} } }, done: {} };
  c.setup.actors.facts.select = "WITH counted AS MATERIALIZED (SELECT nextval('source_evals')) SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job, counted ORDER BY id";
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: { idle: { on: { facts: {} } }, done: {} } };
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service; CREATE SEQUENCE source_evals; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      INSERT INTO job SELECT i::text, CASE WHEN i <= 15 THEN 'idle' ELSE 'done' END, '' FROM generate_series(1, 30) AS i;`);
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], entities));
    await db.exec("SELECT advance_jobs()");
    const count = (await db.query<{ last_value: number }>("SELECT last_value FROM source_evals")).rows[0].last_value;
    assert.equal(Number(count), 1);
  } finally { await db.close(); }
});

Deno.test("Cortex rejects malformed facts even when the row has no handler", async () => {
  const c = structuredClone(chart);
  c.config.meta.watch = [];
  c.setup.actors.facts.select = "SELECT id AS key, 'wrong' AS event, '{}'::jsonb AS payload FROM job";
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); INSERT INTO job VALUES ('a', 'idle', '')");
    await db.exec(await machineSql());
    await db.exec(compileCortexSources([c], entities));
    await assert.rejects(() => db.exec("SELECT advance_jobs()"), /unexpected event or null payload/);
  } finally { await db.close(); }
});

async function nestedFacts(visibleInitially: boolean) {
  const c = structuredClone(chart);
  c.config.meta.watch = ["Job", "Facts"];
  c.config.states = { idle: { on: { facts: [{ guard: "write", actions: "touch" }, { target: "done", guard: "ready" }] } }, done: {} };
  c.setup.actors.facts.select = `SELECT j.id AS key, 'facts' AS event, jsonb_build_object('ready', f.ready) AS payload FROM job j CROSS JOIN facts f ${visibleInitially ? "" : "WHERE j.id = 'a' OR f.ready"} ORDER BY j.id`;
  c.setup.guards = { write: { sql: "NEW.id = 'a' AND NOT (cortex_payload->>'ready')::boolean" }, ready: { sql: "NEW.id = 'b' AND (cortex_payload->>'ready')::boolean" } };
  c.setup.actions = { touch: [{ effect: { op: "update", table: "signal", values: { value: 1 }, rawWhere: "id = 'signal'" } }] };
  const effect = { op: "update", table: "signal", values: { value: 1 }, rawWhere: "id = 'signal'" };
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: {
    idle: { on: { facts: [{ guard: c.setup.guards.write.sql, actions: [{ effect }] }, { target: "done", guard: c.setup.guards.ready.sql }] } }, done: {},
  } };
  const tables = { ...entities, Facts: { table: "facts", fields: [{ name: "id", pk: true }, { name: "ready" }] }, Other: { table: "other", fields: [{ name: "id", pk: true }, { name: "status" }] } };
  const other: CortexChart = {
    config: { id: "other", initial: "idle", meta: { host: "mecha", entity: "Other", field: "status", function: "advance_other", migration: "020_other.sql", watch: ["Facts"] }, invoke: { src: "facts" }, states: { idle: {} } },
    setup: { actors: { facts: { via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM other" } } },
  };
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      CREATE TABLE facts(id text PRIMARY KEY, ready boolean NOT NULL); CREATE TABLE signal(id text PRIMARY KEY, value integer NOT NULL);
      CREATE TABLE other(id text PRIMARY KEY, status text NOT NULL);
      INSERT INTO job VALUES ('a', 'idle', ''), ('b', 'idle', ''); INSERT INTO facts VALUES ('facts', false); INSERT INTO signal VALUES ('signal', 0);
      CREATE FUNCTION nested_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE facts SET ready = true WHERE id = 'facts'; RETURN NULL; END $$;
      CREATE TRIGGER nested_fact BEFORE UPDATE ON signal FOR EACH ROW EXECUTE FUNCTION nested_fact();`);
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], tables));
    await db.exec(compileCortexSources([other], tables));
    await db.exec("SELECT advance_jobs()");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job WHERE id = 'b'")).rows[0].status, "done");
    assert.equal((await db.query<{ value: number }>("SELECT value FROM signal WHERE id = 'signal'")).rows[0].value, 0);
  } finally { await db.close(); }
}

Deno.test("nested writes invalidate facts even when the outer effect affects no rows", () => nestedFacts(true));
Deno.test("nested zero-row effects keep reconciliation running for newly visible facts", () => nestedFacts(false));

Deno.test("a settled pass does not inherit the previous pass's invalidation", async () => {
  const c = structuredClone(chart);
  c.config.meta.watch = [];
  c.config.states = { idle: { on: { facts: "done" } }, done: {} };
  c.setup.actors.facts.select = "WITH counted AS MATERIALIZED (SELECT nextval('source_evals')) SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job, counted";
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: { idle: { on: { facts: "done" } }, done: {} } };
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE SEQUENCE source_evals; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); INSERT INTO job VALUES ('a', 'idle', '')");
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], entities));
    await db.exec("SELECT advance_jobs()");
    const count = (await db.query<{ last_value: number }>("SELECT last_value FROM source_evals")).rows[0].last_value;
    assert.equal(Number(count), 2);
  } finally { await db.close(); }
});

Deno.test("Cortex rejects duplicate source keys before dispatch", async () => {
  for (const transition of [{}, "done"]) {
    const c = structuredClone(chart);
    c.config.meta.watch = [];
    c.config.states = { idle: { on: { facts: transition } }, done: {} };
    c.setup.actors.facts.select = "SELECT j.id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job j CROSS JOIN generate_series(1, 2)";
    const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: { idle: { on: { facts: transition } }, done: {} } };
    const db = new PGlite();
    try {
      await db.exec("CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); INSERT INTO job VALUES ('a', 'idle', '')");
      await db.exec(await machineSql(machine));
      await db.exec(compileCortexSources([c], entities));
      await assert.rejects(() => db.exec("SELECT advance_jobs()"), /duplicate instances/);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM job WHERE id = 'a'")).rows[0].status, "idle");
    } finally { await db.close(); }
  }
});

Deno.test("Cortex closes source cursors before pg_ivm refreshes a private view", async () => {
  for (const threshold of [2, 1]) {
    const c = structuredClone(chart);
    c.config.states = { idle: { on: { facts: { target: "done", guard: "enough" } } }, done: {} };
    c.setup.actors.facts.select = "SELECT j.id AS key, 'facts' AS event, jsonb_build_object('count', i.n) AS payload FROM job j JOIN cortex_facts.private_counts i ON i.status = j.status ORDER BY j.id";
    c.setup.guards = { enough: { sql: `(cortex_payload->>'count')::integer >= ${threshold}` } };
    const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: {
      idle: { on: { facts: { target: "done", guard: c.setup.guards.enough.sql } } }, done: {},
    } };
    const db = await PGlite.create({ extensions: { pg_ivm } });
    try {
      await db.exec(`CREATE ROLE service; CREATE EXTENSION pg_ivm VERSION '1.13';
        CREATE SCHEMA cortex_facts; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
        INSERT INTO job VALUES ('a', 'idle', '');
        SELECT pgivm.create_immv('cortex_facts.private_counts', 'SELECT status, count(*) AS n FROM job GROUP BY status');`);
      await db.exec(await machineSql(machine));
      await db.exec(compileCortexSources([c], entities));
      const triggers = (await db.query<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgrelid = 'job'::regclass AND (tgtype & 2) = 2 AND (tgtype & 1) = 0 ORDER BY tgname")).rows.map((row) => row.tgname);
      assert.ok(triggers.some((name) => name.startsWith("IVM_")));
      assert.ok(triggers.filter((name) => name.startsWith("IVM_")).every((name) => triggers.indexOf(name) < triggers.indexOf("cortex_advance_jobs_gate")));
      await db.exec("INSERT INTO job VALUES ('b', 'idle', '')");
      const states = (await db.query<{ id: string; status: string }>("SELECT id, status FROM job ORDER BY id")).rows;
      assert.deepEqual(states, [{ id: "a", status: "done" }, { id: "b", status: threshold === 2 ? "idle" : "done" }]);
      const counts = (await db.query("SELECT status, n::integer AS n FROM cortex_facts.private_counts ORDER BY status")).rows;
      assert.deepEqual(counts, threshold === 2 ? [{ status: "done", n: 1 }, { status: "idle", n: 1 }] : [{ status: "done", n: 2 }]);
    } finally { await db.close(); }
  }
});

Deno.test("source snapshots preserve text-addressed keys and JSON null payloads", async () => {
  const c = structuredClone(chart);
  c.config.meta.watch = [];
  c.config.states = { idle: { on: { facts: { target: "done", guard: "jsonNull" } } }, done: {} };
  c.setup.actors.facts.select = "SELECT 17 AS key, 'facts' AS event, 'null'::jsonb AS payload";
  c.setup.guards = { jsonNull: { sql: "cortex_payload = 'null'::jsonb" } };
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: {
    idle: { on: { facts: { target: "done", guard: c.setup.guards.jsonNull.sql } } }, done: {},
  } };
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); INSERT INTO job VALUES ('17', 'idle', '')");
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], entities));
    await db.exec("SELECT advance_jobs()");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job WHERE id = '17'")).rows[0].status, "done");
    c.setup.actors.facts.select = "SELECT 17 AS key, 'facts' AS event, NULL::jsonb AS payload";
    await db.exec(compileCortexSources([c], entities));
    await assert.rejects(() => db.exec("SELECT advance_jobs()"), /unexpected event or null payload/);
  } finally { await db.close(); }
});

Deno.test("a materialized source preserves its selected order across re-reads", async () => {
  const c = structuredClone(chart);
  c.config.meta.watch = [];
  c.config.states = { idle: { on: { facts: { target: "done", actions: "record" } } }, done: {} };
  c.setup.actors.facts.select = "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job ORDER BY id DESC";
  const effect = { op: "create", table: "order_trace", values: { id: { raw: "NEW.id" } } };
  c.setup.actions = { record: [{ effect }] };
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: {
    idle: { on: { facts: { target: "done", actions: [{ effect }] } } }, done: {},
  } };
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); CREATE TABLE order_trace(seq bigint GENERATED ALWAYS AS IDENTITY, id text); INSERT INTO job VALUES ('a', 'idle', ''), ('b', 'idle', '')");
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], entities));
    await db.exec("SELECT advance_jobs()");
    assert.deepEqual((await db.query<{ id: string }>("SELECT id FROM order_trace ORDER BY seq")).rows.map((row) => row.id), ["b", "a"]);
  } finally { await db.close(); }
});

Deno.test("nested source wake waits for the outer pg_ivm update", async () => {
  const c = structuredClone(chart);
  c.config.initial = "waiting";
  c.config.states = { waiting: { on: { facts: { target: "wrong", guard: "pending" } } }, pending: { on: { settle: "drawn" } }, drawn: {}, wrong: {} };
  c.config.meta.watch = ["Job", "Cards"];
  c.setup.actors.facts.select = "SELECT j.id AS key, 'facts' AS event, jsonb_build_object('pending', i.pending) AS payload FROM job j CROSS JOIN cortex_facts.counts i WHERE j.id = 'b'";
  c.setup.guards = { pending: { sql: "(cortex_payload->>'pending')::integer >= 2" } };
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "waiting", guards: {}, level: "replicated", states: {
    waiting: { on: { facts: { target: "wrong", guard: c.setup.guards.pending.sql } } }, pending: { on: { settle: "drawn" } }, drawn: {}, wrong: {},
  } };
  const tables = { ...entities, Cards: { table: "cards", fields: [{ name: "id", pk: true }, { name: "deck" }, { name: "back" }] } };
  const db = await PGlite.create({ extensions: { pg_ivm } });
  try {
    await db.exec(`CREATE ROLE service; CREATE EXTENSION pg_ivm VERSION '1.13'; CREATE SCHEMA cortex_facts;
      CREATE TABLE cards(id text PRIMARY KEY, deck text NOT NULL, back text NOT NULL);
      CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      INSERT INTO cards VALUES ('a', 'deck', ''), ('b', 'deck', ''); INSERT INTO job VALUES ('a', 'pending', ''), ('b', 'waiting', '');
      SELECT pgivm.create_immv('cortex_facts.counts', $q$ SELECT c.deck, count(*) AS total, sum(CASE WHEN j.status IN ('waiting','pending') THEN 1 ELSE 0 END) AS pending, sum(CASE WHEN j.status='drawn' THEN 1 ELSE 0 END) AS drawn FROM cards c JOIN job j ON j.id=c.id GROUP BY c.deck $q$);
      CREATE FUNCTION update_card() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 'a' AND NEW.status = 'drawn' THEN UPDATE cards SET back = 'updated' WHERE id = NEW.id; END IF; RETURN NEW; END $$;
      CREATE TRIGGER a_update_card BEFORE UPDATE ON job FOR EACH ROW EXECUTE FUNCTION update_card();`);
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], tables));
    await db.exec("UPDATE job SET status = 'drawn' WHERE id = 'a'");
    const actual = (await db.query("SELECT total::integer, pending::integer, drawn::integer FROM cortex_facts.counts")).rows;
    const expected = (await db.query("SELECT count(*)::integer AS total, sum(CASE WHEN j.status IN ('waiting','pending') THEN 1 ELSE 0 END)::integer AS pending, sum(CASE WHEN j.status='drawn' THEN 1 ELSE 0 END)::integer AS drawn FROM cards c JOIN job j ON j.id=c.id")).rows;
    assert.deepEqual(actual, expected);
    assert.deepEqual((await db.query("SELECT id, status FROM job ORDER BY id")).rows, [{ id: "a", status: "drawn" }, { id: "b", status: "waiting" }]);
    assert.deepEqual(actual, [{ total: 2, pending: 1, drawn: 1 }]);
  } finally { await db.close(); }
});

Deno.test("statement barriers balance upserts, rollbacks and multiple source groups", async () => {
  const job = structuredClone(chart);
  job.config.meta.watch = ["Facts"];
  job.config.states = { idle: { on: { facts: "done" } }, done: {} };
  job.setup.actors.facts.select = "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job WHERE EXISTS (SELECT 1 FROM facts WHERE ready)";
  job.setup.actions = { declareSink: [{ effect: { op: "update", table: "signal", values: { value: 1 }, rawWhere: "id = 'signal'" } }] };
  const other: CortexChart = {
    config: { id: "other", initial: "idle", meta: { host: "mecha", entity: "Other", field: "status", function: "advance_other", migration: "020_other.sql", watch: ["Facts"] }, invoke: { src: "facts" }, states: { idle: { on: { facts: "done" } }, done: {} } },
    setup: { actors: { facts: { via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM other WHERE EXISTS (SELECT 1 FROM facts WHERE ready)" } } },
  };
  const machine = (name: string, id: string) => ({ name, cortex: { id, sourceEvents: ["facts"] }, entity: name, field: "status", initial: "idle", guards: {}, level: "replicated", states: { idle: { on: { facts: "done" } }, done: {} } });
  const fields = [{ name: "id", type: "string", pk: true }, { name: "status", type: "string" }, { name: "marker", type: "string" }];
  const tables = { ...entities, Facts: { table: "facts", fields: [{ name: "id", pk: true }, { name: "ready" }] }, Other: { table: "other", fields } };
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      CREATE TABLE other(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      CREATE TABLE facts(id text PRIMARY KEY, ready boolean NOT NULL); CREATE TABLE signal(id text PRIMARY KEY, value integer NOT NULL);
      INSERT INTO job VALUES ('a', 'idle', ''); INSERT INTO other VALUES ('b', 'idle', '');
      INSERT INTO facts VALUES ('facts', false); INSERT INTO signal VALUES ('signal', 0);`);
    await db.exec(await machineSql(machine("Job", "job")));
    await db.exec(await machineSql(machine("Other", "other"), {}, { name: "Other", table: "other", durability: "server", fields }));
    await db.exec(compileCortexSources([job], tables));
    await db.exec(compileCortexSources([other], tables));
    await db.exec("UPDATE facts SET ready = true WHERE false");
    assert.equal((await db.query("SELECT * FROM cortex_runtime.draining")).rows.length, 0);
    await db.exec("BEGIN; SAVEPOINT rolled_back; UPDATE facts SET ready = true; ROLLBACK TO SAVEPOINT rolled_back; COMMIT");
    assert.equal((await db.query<{ ready: boolean }>("SELECT ready FROM facts")).rows[0].ready, false);
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job")).rows[0].status, "idle");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM other")).rows[0].status, "idle");
    assert.equal((await db.query("SELECT * FROM cortex_runtime.draining")).rows.length, 0);
    await db.exec("INSERT INTO facts VALUES ('facts', true) ON CONFLICT (id) DO UPDATE SET ready = EXCLUDED.ready");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job")).rows[0].status, "done");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM other")).rows[0].status, "done");
    assert.equal((await db.query("SELECT * FROM cortex_runtime.draining")).rows.length, 0);
    await db.exec(`ALTER TABLE job DISABLE TRIGGER ALL; UPDATE job SET status = 'idle'; ALTER TABLE job ENABLE TRIGGER ALL;
      CREATE FUNCTION ask_during_signal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM advance_jobs(); RETURN NEW; END $$;
      CREATE TRIGGER ask_during_signal BEFORE UPDATE ON signal FOR EACH ROW EXECUTE FUNCTION ask_during_signal();
      UPDATE signal SET value = 1 WHERE id = 'signal';`);
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job")).rows[0].status, "done");
    assert.equal((await db.query("SELECT * FROM cortex_runtime.draining")).rows.length, 0);
  } finally { await db.close(); }
});

Deno.test("zero-row watched effects do not keep source groups waking each other", async () => {
  const c = structuredClone(chart);
  c.config.meta.watch = ["Job", "Signal"];
  c.config.states = { idle: { on: { facts: { actions: "noop" } } } };
  c.setup.actors.facts.select = "WITH counted AS MATERIALIZED (SELECT nextval('source_evals')) SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job, counted";
  const effect = { op: "update", table: "signal", values: { value: 1 }, rawWhere: "false" };
  c.setup.actions = { noop: [{ effect }] };
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: { idle: { on: { facts: { actions: [{ effect }] } } } } };
  const tables = { ...entities, Signal: { table: "signal", fields: [{ name: "id", pk: true }, { name: "value" }] } };
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE SEQUENCE source_evals; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); CREATE TABLE signal(id text PRIMARY KEY, value integer NOT NULL); INSERT INTO job VALUES ('a', 'idle', ''); INSERT INTO signal VALUES ('signal', 0)");
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], tables));
    await db.exec("SELECT advance_jobs()");
    assert.equal(Number((await db.query<{ last_value: number }>("SELECT last_value FROM source_evals")).rows[0].last_value), 1);
    assert.equal((await db.query("SELECT * FROM cortex_runtime.draining")).rows.length, 0);
  } finally { await db.close(); }
});

Deno.test("a nested watched write wakes after an outer statement returns no row", async () => {
  const c = structuredClone(chart);
  c.config.meta.watch = ["Facts"];
  c.config.states = { idle: { on: { facts: "done" } }, done: {} };
  c.setup.actors.facts.select = "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job WHERE EXISTS (SELECT 1 FROM facts WHERE ready)";
  c.setup.actions = { declareSink: [{ effect: { op: "update", table: "signal", values: { value: 1 }, rawWhere: "false" } }] };
  const machine = { name: "Job", cortex: { id: "job", sourceEvents: ["facts"] }, entity: "Job", field: "status", initial: "idle", guards: {}, level: "replicated", states: { idle: { on: { facts: "done" } }, done: {} } };
  const tables = { ...entities, Facts: { table: "facts", fields: [{ name: "id", pk: true }, { name: "ready" }] } };
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      CREATE TABLE facts(id text PRIMARY KEY, ready boolean NOT NULL); CREATE TABLE signal(id text PRIMARY KEY, value integer NOT NULL);
      INSERT INTO job VALUES ('a', 'idle', ''); INSERT INTO facts VALUES ('facts', false); INSERT INTO signal VALUES ('signal', 0);
      CREATE FUNCTION nested_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE facts SET ready = true; RETURN NULL; END $$;
      CREATE TRIGGER nested_fact BEFORE UPDATE ON signal FOR EACH ROW EXECUTE FUNCTION nested_fact();`);
    await db.exec(await machineSql(machine));
    await db.exec(compileCortexSources([c], tables));
    await db.exec("UPDATE signal SET value = 1");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM job")).rows[0].status, "done");
    assert.equal((await db.query<{ value: number }>("SELECT value FROM signal")).rows[0].value, 0);
    assert.equal((await db.query("SELECT * FROM cortex_runtime.draining")).rows.length, 0);
  } finally { await db.close(); }
});

Deno.test("cross-group cycles fail at the shared reconciliation bound", async () => {
  const tables = { ...entities, Facts: { table: "facts", fields: [{ name: "id", pk: true }, { name: "ready" }] }, Other: { table: "other", fields: [{ name: "id", pk: true }, { name: "status" }, { name: "marker" }] } };
  const build = (name: string, table: string, expected: boolean): CortexChart => ({
    config: { id: name, initial: "idle", meta: { host: "mecha", entity: name === "job" ? "Job" : "Other", field: "status", function: `advance_${name}`, migration: `019_${name}.sql`, watch: ["Facts"] }, invoke: { src: "facts" }, states: { idle: { on: { facts: { guard: "flip", actions: "write" } } } } },
    setup: { actors: { facts: { via: "query", event: "facts", select: `SELECT id AS key, 'facts' AS event, jsonb_build_object('ready', (SELECT ready FROM facts)) AS payload FROM ${table}` } }, guards: { flip: { sql: `(cortex_payload->>'ready')::boolean = ${!expected}` } }, actions: { write: [{ effect: { op: "update", table: "facts", values: { ready: expected }, rawWhere: "id = 'facts'" } }] } },
  });
  const one = build("job", "job", true), two = build("other", "other", false);
  const machine = (name: string, id: string, expected: boolean) => ({ name, cortex: { id, sourceEvents: ["facts"] }, entity: name, field: "status", initial: "idle", guards: {}, level: "replicated", states: { idle: { on: { facts: { guard: `(cortex_payload->>'ready')::boolean = ${!expected}`, actions: [{ effect: { op: "update", table: "facts", values: { ready: expected }, rawWhere: "id = 'facts'" } }] } } } } });
  const fields = [{ name: "id", type: "string", pk: true }, { name: "status", type: "string" }, { name: "marker", type: "string" }];
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL);
      CREATE TABLE other(id text PRIMARY KEY, status text NOT NULL, marker text NOT NULL); CREATE TABLE facts(id text PRIMARY KEY, ready boolean NOT NULL);
      INSERT INTO job VALUES ('a', 'idle', ''); INSERT INTO other VALUES ('b', 'idle', ''); INSERT INTO facts VALUES ('facts', false);`);
    await db.exec(await machineSql(machine("Job", "job", true)));
    await db.exec(await machineSql(machine("Other", "other", false), {}, { name: "Other", table: "other", durability: "server", fields }));
    await db.exec(compileCortexSources([one], tables));
    await db.exec(compileCortexSources([two], tables));
    await assert.rejects(() => db.exec("UPDATE facts SET ready = false"), /pending source groups did not settle in 100 passes/);
    assert.equal((await db.query("SELECT * FROM cortex_runtime.draining")).rows.length, 0);
  } finally { await db.close(); }
});
