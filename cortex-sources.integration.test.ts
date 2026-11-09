import { compileCortexSql } from "./cortex-machine.ts";
import assert from "node:assert/strict";
import { compileCortexSources, type CortexChart } from "./cortex-sources.ts";

const image = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const chart: CortexChart = {
  config: { id: "job", initial: "idle", meta: { host: "mecha", entity: "Job", field: "status", function: "advance_jobs", migration: "019_jobs.sql", watch: ["Job"] }, invoke: { src: "facts" }, states: { idle: { on: { facts: {} } } } },
  setup: { actors: { facts: { via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM job ORDER BY id" } } },
};
const entities = { Job: { table: "job", fields: [{ name: "id", pk: true }, { name: "status" }, { name: "marker" }] } };

async function run(args: string[], input?: string) {
  const child = new Deno.Command("docker", { args, stdin: input === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (input !== undefined) { const writer = child.stdin.getWriter(); await writer.write(new TextEncoder().encode(input)); await writer.close(); }
  const result = await child.output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr) };
}

async function machineSql(name = "Job", table = "job", id = "job", states: unknown = { idle: { on: { facts: {} } } }, effects: Record<string, unknown> = {}, upgrade = false) {
  const machine = { name, cortex: { id, sourceEvents: ["facts"] }, entity: name, field: "status", initial: "idle", guards: {}, level: Object.keys(effects).length ? "external" : "replicated", states };
  const entity = { name, table, durability: "server", fields: [{ name: "id", type: "string", pk: true }, { name: "status", type: "string" }, { name: "marker", type: "int32" }] };
  const expression = `(#mechaMachineSql & {machine: ${JSON.stringify(machine)}, entities: {${name}: ${JSON.stringify(entity)}}, effects: ${JSON.stringify(effects)}})._stateMachineSql`;
  const result = await new Deno.Command("cue", { args: ["export", ".:pronto", "-e", expression], cwd: new URL(".", import.meta.url), stdout: "piped", stderr: "piped" }).output();
  assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
  const source = JSON.parse(new TextDecoder().decode(result.stdout));
  const quoted = (sql: string) => `E'${sql.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  return compileCortexSql(upgrade ? `DO ${quoted(`BEGIN EXECUTE ${quoted(source)}; END`)};` : source);
}

Deno.test({ name: "compiled Cortex branches and receipt outcomes execute atomically in native PostgreSQL", ignore: !Deno.env.get("CORTEX_NATIVE_PG_CONTAINER"), sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const container = Deno.env.get("CORTEX_NATIVE_PG_CONTAINER")!;
  const database = `cortex_compiled_${crypto.randomUUID().replaceAll("-", "")}`;
  const sql = (db: string, input: string) => run(["exec", "-i", container, "psql", "-XqtA", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db], input);
  const created = await sql("postgres", `CREATE DATABASE ${database}`);
  if (!created.ok) throw Error(created.err);
  let createdRole = false;
  try {
    const role = await sql("postgres", "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service')");
    if (!role.ok) throw Error(role.err);
    if (role.out === "f") {
      const added = await sql("postgres", "CREATE ROLE service");
      if (!added.ok) throw Error(added.err);
      createdRole = true;
    }
    const states = {
      idle: { on: {
        facts: [{ target: "done", guard: "(cortex_payload->>'first')::boolean", actions: [{ effect: { op: "update", table: "sink", values: { value: 1 }, rawWhere: "id = 'one'" } }] }, { actions: [{ assign: { marker: 9 } }] }],
        direct: { target: "done", guard: "EXISTS (SELECT 1 FROM sink WHERE value = 1)" },
      } },
      pending: { invoke: { src: "draw", onDone: "done", onError: [{ target: "unknown", guard: "outcome->>'kind' = 'unknown'", actions: [{ assign: { marker: 2 } }] }, { target: "failed", actions: [{ assign: { marker: 3 } }] }] } },
      done: {}, failed: {}, unknown: {},
    };
    const effects = { draw: { name: "draw", sink: { origin: "https://example.com", idempotent: true }, note: "deduplicated" } };
    const c: CortexChart = { config: { ...chart.config, id: "probe", meta: { ...chart.config.meta, entity: "Probe", function: "probe_run", watch: [] } }, setup: { actors: { facts: { via: "query", event: "facts", select: "SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM probe WHERE false" } } } };
    const emitted = await machineSql("Probe", "probe", "probe", states, effects, true);
    assert.equal(emitted.includes("@PRONTO_XSTATE"), false);
    const setup = await sql(database, `CREATE TABLE probe(id text PRIMARY KEY, status text NOT NULL, marker integer NOT NULL);
      CREATE TABLE sink(id text PRIMARY KEY, value integer NOT NULL); INSERT INTO sink VALUES ('one', 0);
      CREATE SCHEMA airlock; CREATE TABLE airlock.external_effect_ledger(key text PRIMARY KEY, outcome jsonb);
      ${emitted}
      ${compileCortexSources([c], { Probe: { table: "probe", fields: entities.Job.fields } })}
      ALTER TABLE probe DISABLE TRIGGER ALL;
      INSERT INTO probe VALUES ('a','idle',0),('b','idle',0),('c','pending',0),('d','pending',0),('e','idle',0);
      ALTER TABLE probe ENABLE TRIGGER ALL;
      INSERT INTO airlock.external_effect_ledger VALUES ('draw:c','{"target":"failed","kind":"unknown"}'),('draw:d','{"target":"failed","kind":"failed"}');
      BEGIN;
      SELECT cortex_runtime.dispatch_probe('a','facts','{"first":true}');
      UPDATE probe SET status='done' WHERE id='b';
      UPDATE probe SET status='failed' WHERE id IN ('c','d');
      SELECT id,status,marker FROM probe ORDER BY id;
      COMMIT;`);
    if (!setup.ok) throw Error(setup.err);
    assert.equal(setup.out, "t\na|done|0\nb|done|0\nc|unknown|2\nd|failed|3\ne|idle|0");
    const refused = await sql(database, `BEGIN; UPDATE sink SET value=7; SELECT cortex_runtime.dispatch_probe('e','facts','{"first":"invalid"}'); COMMIT;`);
    assert.equal(refused.ok, false);
    assert.match(refused.err, /boolean/);
    const remaining = await sql(database, "SELECT value FROM sink; SELECT status,marker FROM probe WHERE id='e'; SELECT count(*) FROM cortex_runtime.dispatch_frame;");
    if (!remaining.ok) throw Error(remaining.err);
    assert.equal(remaining.out, "1\nidle|0\n0");
  } finally {
    const removed = await sql("postgres", `DROP DATABASE ${database} WITH (FORCE)`);
    if (!removed.ok) throw Error(removed.err);
    if (createdRole) {
      const role = await sql("postgres", "DROP ROLE service");
      if (!role.ok) throw Error(role.err);
    }
  }
}});

Deno.test({ name: "Cortex gates source reconciliation before ordinary writers take row locks", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const container = `cortex-source-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", image]);
  if (!started.ok) throw Error(started.err);
  const args = ["exec", "-i", container, "psql", "-XqtA", "-v", "ON_ERROR_STOP=1", "-U", "postgres"];
  const sql = (input: string) => run(args, input);
  try {
    for (let attempt = 0; ; attempt++) {
      const logs = await run(["logs", container]);
      if ((`${logs.out}\n${logs.err}`.match(/database system is ready to accept connections/g) ?? []).length >= 2 && (await run(["exec", container, "pg_isready", "-qU", "postgres"])).ok) break;
      if (attempt >= 60) throw Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const setup = await sql(`CREATE ROLE service; CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker integer NOT NULL);
      INSERT INTO job VALUES ('a','idle',0),('b','idle',0);
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url))}
      ${await machineSql()}
      ${compileCortexSources([chart], entities)}
      CREATE FUNCTION pause_outer_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.marker IS DISTINCT FROM OLD.marker THEN PERFORM pg_sleep(0.35); END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER a_pause BEFORE UPDATE ON job FOR EACH ROW EXECUTE FUNCTION pause_outer_write();`);
    if (!setup.ok) throw Error(setup.err);
    const ordering = await sql(`CREATE FUNCTION verify_gate_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted) THEN
        RAISE EXCEPTION 'Cortex gate was not held before row triggers';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER z_verify_gate BEFORE UPDATE ON job FOR EACH ROW EXECUTE FUNCTION verify_gate_order();
    UPDATE job SET marker = marker + 1 WHERE id = 'a';`);
    if (!ordering.ok) throw Error(ordering.err);
    const renamed = await sql('ALTER TRIGGER "cortex_advance_jobs_gate" ON job RENAME TO "Cortex_advance_jobs_gate"');
    if (!renamed.ok) throw Error(renamed.err);
    const replaced = await sql(compileCortexSources([chart], entities));
    if (!replaced.ok) throw Error(replaced.err);
    const gates = await sql("SELECT tgname FROM pg_trigger WHERE tgrelid = 'job'::regclass AND tgname IN ('Cortex_advance_jobs_gate', 'cortex_advance_jobs_gate') ORDER BY tgname");
    assert.equal(gates.out, "cortex_advance_jobs_gate");
    const removeVerifier = await sql('DROP TRIGGER z_verify_gate ON job');
    if (!removeVerifier.ok) throw Error(removeVerifier.err);

    const race = async (prelock: boolean, request = false) => {
      const clients = [];
      for (const key of ["a", "b"]) {
        const process = new Deno.Command("docker", { args, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
        const writer = process.stdin.getWriter();
        const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
        await writer.write(new TextEncoder().encode(`\\set VERBOSITY verbose\nBEGIN; SET deadlock_timeout = '100ms'; SET statement_timeout = '5s';\n${prelock ? `SELECT 1 FROM job WHERE id = '${key}' FOR UPDATE;\n` : ""}SELECT 'READY';\n`));
        let ready = "";
        while (!ready.includes("READY\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw Error("database client ended before the race was ready");
          ready += chunk.value;
        }
        clients.push({ key, process, writer, reader });
      }
      await Promise.all(clients.map(async ({ key, writer }) => {
        await writer.write(new TextEncoder().encode(`${request ? "SET LOCAL request.method = 'PATCH'; SET LOCAL request.path = '/job'; SELECT app_pre_request(); " : ""}UPDATE job SET marker = marker + 1 WHERE id = '${key}'; COMMIT;\n`));
        await writer.close();
      }));
      return await Promise.all(clients.map(async ({ process, reader }) => {
        const stderr = new Response(process.stderr).text();
        while (!(await reader.read()).done) { /* drain */ }
        const status = await process.status;
        return { ok: status.success, err: await stderr };
      }));
    };
    const refreshedFloor = await sql(await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url)));
    if (!refreshedFloor.ok) throw Error(refreshedFloor.err);
    const read = await sql("BEGIN; SET LOCAL request.method='GET'; SELECT app_pre_request(); SELECT count(*) FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'; ROLLBACK;");
    if (!read.ok) throw Error(read.err);
    assert.equal(read.out.trim(), "0");
    const requested = await race(false, true);
    assert.equal(requested.every((result) => result.ok), true, requested.map((result) => result.err).join("\n"));
    const committed = await sql("SELECT sum(marker), (SELECT count(*) FROM cortex_runtime.draining) FROM job");
    assert.equal(committed.out, "3|0");
    const enabled = await race(false);
    assert.equal(enabled.filter((result) => !result.ok && result.err.includes("40001")).length, 1);
    const disabled = await sql(`ALTER TABLE job DISABLE TRIGGER "cortex_advance_jobs_gate";
      ALTER TABLE job DISABLE TRIGGER "zzzz_cortex_advance_jobs";
      CREATE FUNCTION legacy_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM advance_jobs(); RETURN NULL; END $$;
      CREATE TRIGGER cortex_legacy_wake AFTER UPDATE ON job FOR EACH STATEMENT EXECUTE FUNCTION legacy_wake();`);
    if (!disabled.ok) throw Error(disabled.err);
    const red = await race(false);
    assert.equal(red.filter((result) => !result.ok && result.err.includes("40P01")).length, 1);
    const restored = await sql(`DROP TRIGGER cortex_legacy_wake ON job;
      ALTER TABLE job ENABLE TRIGGER "cortex_advance_jobs_gate";
      ALTER TABLE job ENABLE TRIGGER "zzzz_cortex_advance_jobs";`);
    if (!restored.ok) throw Error(restored.err);
    const prelocked = await race(true);
    assert.equal(prelocked.filter((result) => !result.ok && (result.err.includes("40P01") || result.err.includes("40001"))).length, 1);

    const sharedEntities = {
      JobA: { table: "job_a", fields: entities.Job.fields },
      JobB: { table: "job_b", fields: entities.Job.fields },
    };
    const group = (id: string, entity: string, table: string): CortexChart => ({
      config: { id, initial: "idle", meta: { host: "mecha", entity, field: "status", function: `advance_${id}`, migration: `019_${id}.sql`, watch: ["JobA", "JobB"] }, invoke: { src: "facts" }, states: { idle: { on: { facts: {} } } } },
      setup: { actors: { facts: { via: "query", event: "facts", select: `WITH pause AS MATERIALIZED (SELECT pg_sleep(0.35)) SELECT id AS key, 'facts' AS event, '{}'::jsonb AS payload FROM ${table}, pause ORDER BY id` } } },
    });
    const aSql = compileCortexSources([group("alpha", "JobA", "job_a")], sharedEntities);
    const bSql = compileCortexSources([group("beta", "JobB", "job_b")], sharedEntities);
    const groups = await sql(`CREATE TABLE job_a(id text PRIMARY KEY, status text NOT NULL, marker integer NOT NULL);
      CREATE TABLE job_b(id text PRIMARY KEY, status text NOT NULL, marker integer NOT NULL);
      INSERT INTO job_a VALUES ('a', 'idle', 0); INSERT INTO job_b VALUES ('b', 'idle', 0);
      ${await machineSql("JobA", "job_a", "alpha")}
      ${await machineSql("JobB", "job_b", "beta")}
      ${aSql}
${bSql}`);
    if (!groups.ok) throw Error(groups.err);
    const runGroups = () => Promise.all(["alpha", "beta"].map((id) => sql(`\\set VERBOSITY verbose
SET deadlock_timeout = '100ms'; SET statement_timeout = '8s'; SELECT advance_${id}();`)));
    const sharedGate = await runGroups();
    assert.equal(sharedGate.every((result) => result.ok), true, sharedGate.map((result) => result.err).join("\n"));
    const splitKeys = await sql(`${aSql.replaceAll("hashtextextended('pronto.cortex', 0)", "hashtextextended('pronto.cortex.alpha', 0)")}
${bSql.replaceAll("hashtextextended('pronto.cortex', 0)", "hashtextextended('pronto.cortex.beta', 0)")}`);
    if (!splitKeys.ok) throw Error(splitKeys.err);
    const splitGate = await runGroups();
    // Independent nonblocking gates can reject both owners before either releases.
    assert.ok(splitGate.some((result) => !result.ok));
    assert.ok(splitGate.every((result) => result.ok || result.err.includes("40P01") || result.err.includes("40001")), splitGate.map((result) => result.err).join("\n"));
  } finally {
    const stopped = await run(["stop", container]);
    if (!stopped.ok) throw Error(stopped.err);
  }
}});

Deno.test({ name: "HTTP transaction admission orders IVM locks while direct SQL retains retry protection", ignore: !Deno.env.get("CORTEX_NATIVE_PG_CONTAINER"), sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const container = Deno.env.get("CORTEX_NATIVE_PG_CONTAINER")!;
  const database = `cortex_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = (input: string) => run(["exec", "-i", container, "psql", "-XqtA", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], input);
  const args = ["exec", "-i", container, "psql", "-XqtA", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database];
  const sql = (input: string) => run(args, input);
  const created = await admin(`CREATE DATABASE ${database}`);
  if (!created.ok) throw Error(created.err);
  let createdRole = false;
  try {
    const setup = await sql(`CREATE ROLE service;`);
    if (!setup.ok && !setup.err.includes("already exists")) throw Error(setup.err);
    createdRole = setup.ok;
    const init = await sql(`CREATE EXTENSION pg_ivm; CREATE SCHEMA cortex_facts;
      CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, marker integer NOT NULL);
      CREATE TABLE trace(id text PRIMARY KEY);
      INSERT INTO job VALUES ('a','idle',0),('b','idle',0);
      SELECT pgivm.create_immv('cortex_facts.counts', 'SELECT count(*) AS total, sum(marker) AS marker FROM job');
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url))}
      ${await machineSql()}
      ${compileCortexSources([chart], entities)}
      CREATE FUNCTION pause_ivm_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('application_name') = 'cortex_ivm_writer' THEN PERFORM pg_sleep(20); END IF; RETURN NULL; END $$;
      CREATE TRIGGER "IVM_zz_cortex_probe" BEFORE UPDATE ON job FOR EACH STATEMENT EXECUTE FUNCTION pause_ivm_writer();
      CREATE FUNCTION trace_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO trace VALUES (NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
      CREATE TRIGGER z_trace AFTER UPDATE ON job FOR EACH ROW EXECUTE FUNCTION trace_write();`);
    if (!init.ok) throw Error(init.err);
    const writer = sql("\\set VERBOSITY verbose\nSET application_name='cortex_ivm_writer'; UPDATE job SET marker=marker+1 WHERE id='a';");
    const until = async (query: string) => {
      for (let n = 0; n < 100; n++) {
        const value = await sql(query);
        if (!value.ok) throw Error(value.err);
        if (value.out === "t") return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw Error(`database wait condition was not reached: ${query}`);
    };
    await until("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='cortex_ivm_writer' AND wait_event='PgSleep')");
    const runner = sql("\\set VERBOSITY verbose\nSET application_name='cortex_ivm_runner'; SELECT advance_jobs();");
    await until("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='cortex_ivm_runner' AND wait_event_type='Lock')");
    const rejected = await writer;
    assert.equal(rejected.ok, false);
    assert.match(rejected.err, /40001/);
    const reconciled = await runner;
    if (!reconciled.ok) throw Error(reconciled.err);
    const retry = await sql("UPDATE job SET marker=marker+1 WHERE id='a'");
    if (!retry.ok) throw Error(retry.err);
    const result = await sql("SELECT (SELECT row(total,marker) FROM cortex_facts.counts) = (SELECT row(count(*),sum(marker)) FROM job), (SELECT count(*) FROM trace WHERE id='a'), (SELECT count(*) FROM cortex_runtime.draining)");
    assert.equal(result.out, "t|1|0");
    const admitted = sql("BEGIN; SET LOCAL application_name='cortex_ivm_writer'; SET LOCAL request.method='PATCH'; SET LOCAL request.path='/job'; SELECT app_pre_request(); UPDATE job SET marker=marker+1 WHERE id='a'; COMMIT;");
    await until("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='cortex_ivm_writer' AND wait_event='PgSleep')");
    const concurrent = sql("SET application_name='cortex_ivm_runner'; SELECT advance_jobs();");
    await until("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='cortex_ivm_runner' AND wait_event_type='Lock')");
    const outcomes = await Promise.all([admitted, concurrent]);
    assert.equal(outcomes.every((result) => result.ok), true, outcomes.map((result) => result.err).join("\n"));
    const afterAdmission = await sql("SELECT (SELECT row(total,marker) FROM cortex_facts.counts) = (SELECT row(count(*),sum(marker)) FROM job), (SELECT marker FROM job WHERE id='a'), (SELECT count(*) FROM cortex_runtime.draining)");
    assert.equal(afterAdmission.out, "t|2|0");
  } finally {
    const removed = await admin(`DROP DATABASE ${database} WITH (FORCE)`);
    if (!removed.ok) throw Error(removed.err);
    if (createdRole) {
      const role = await admin("DROP ROLE service");
      if (!role.ok) throw Error(role.err);
    }
  }
}});
