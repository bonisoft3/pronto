// The interpreter emitted for an invoking state, run in postgres: the claim and the
// enqueue share the transition's commit, only the ledger's outcome leaves the
// state, and a performed key is never claimed twice. Graphile's add_job is a
// recording stand-in with its parameter names, so a renamed argument fails here;
// the real queue is the airlock's to test.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";

async function run(cmd: string, args: string[], stdin?: string) {
  const child = new Deno.Command(cmd, { args, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const res = await child.output();
  return { ok: res.success, out: new TextDecoder().decode(res.stdout).trim(), err: new TextDecoder().decode(res.stderr) };
}

Deno.test({ name: "an invoking state's interpreter claims, enqueues and admits only the recorded outcome", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const files = await emitFiles(paymentProgram());
  const container = `pronto-effects-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", POSTGRES]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  try {
    for (let i = 0; !(await run("docker", ["exec", container, "pg_isready", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const setup = await psql(`
      CREATE ROLE anon; CREATE ROLE app_user; CREATE ROLE electric;
      CREATE SCHEMA graphile_worker;
      CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
      CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
        run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
        flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
        $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text);
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/ticker/schedule.sql", import.meta.url))}
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/airlock/airlock.sql", import.meta.url))}
      ${files["services/database/migrations/010_machines.sql"].text}
      INSERT INTO payment VALUES ('00000000-0000-0000-0000-000000000001', 'pending', 12.50, NULL),
                                 ('00000000-0000-0000-0000-000000000002', 'pending', 7.00, NULL);`);
    if (!setup.ok) throw new Error(setup.err);
    const one = "00000000-0000-0000-0000-000000000001";
    const two = "00000000-0000-0000-0000-000000000002";

    await t.step("a rolled-back transition claims and enqueues nothing", async () => {
      const r = await psql(`BEGIN; UPDATE payment SET status = 'charging' WHERE id = '${one}'; ROLLBACK;
        SELECT (SELECT count(*) FROM airlock.external_effect_ledger) || ',' || (SELECT count(*) FROM graphile_worker.added);`);
      assertEquals(r.out, "0,0");
    });

    await t.step("a committed transition claims the ledger, enqueues once, and arms the ticker's wake", async () => {
      // The airlock's step seeds the row ticked; a claim clears its watermark.
      assertEquals((await psql(`SELECT last_tick_at IS NOT NULL FROM schedule WHERE name = 'airlock';`)).out, "t");
      const r = await psql(`UPDATE payment SET status = 'charging' WHERE id = '${one}';
        SELECT row::text || ' ' || input::text FROM airlock.external_effect_ledger WHERE key = 'charge:${one}';
        SELECT identifier || ' ' || payload::text || ' ' || job_key || ' ' || max_attempts FROM graphile_worker.added;
        SELECT cron IS NULL AND due_at IS NOT NULL AND last_tick_at IS NULL FROM schedule WHERE name = 'airlock';`);
      assertEquals(r.out.split("\n"), [
        `{"id": "${one}"} {"amount": 12.50, "currency": "BRL"}`,
        `external_effect {"key" : "charge:${one}"} charge:${one} 30`,
        "t",
      ]);
    });

    await t.step("an outcome the ledger does not hold is refused", async () => {
      const r = await psql(`UPDATE payment SET status = 'settled' WHERE id = '${one}';`);
      assertEquals(r.ok, false);
      assertStringIncludes(r.err, `payment leaves charging only by the recorded outcome of charge:${one}`);
    });

    await t.step("the recorded outcome leaves, and its actions read it", async () => {
      const r = await psql(`BEGIN;
        UPDATE airlock.external_effect_ledger SET outcome = '{"target": "failed", "kind": "unknown"}', settled_at = now() WHERE key = 'charge:${one}';
        UPDATE payment SET status = 'failed' WHERE id = '${one}';
        COMMIT;
        SELECT status || ',' || failure FROM payment WHERE id = '${one}';`);
      if (!r.ok) throw new Error(r.err);
      assertEquals(r.out, "failed,unknown");
    });

    await t.step("entering again under a performed key is an error, never a second claim", async () => {
      const r = await psql(`UPDATE payment SET status = 'pending' WHERE id = '${one}';
        UPDATE payment SET status = 'charging' WHERE id = '${one}';`);
      assertEquals(r.ok, false);
      assertStringIncludes(r.err, `external effect charge:${one} was already performed: entering charging again needs a new key`);
      assertEquals((await psql(`SELECT count(*) FROM graphile_worker.added;`)).out, "1");
    });

    await t.step("onDone leaves to its own target", async () => {
      const r = await psql(`UPDATE payment SET status = 'charging' WHERE id = '${two}';
        BEGIN;
        UPDATE airlock.external_effect_ledger SET outcome = '{"target": "settled", "kind": "done"}' WHERE key = 'charge:${two}';
        UPDATE payment SET status = 'settled' WHERE id = '${two}';
        COMMIT;
        SELECT status FROM payment WHERE id = '${two}';`);
      if (!r.ok) throw new Error(r.err);
      assertEquals(r.out, "settled");
    });

    await t.step("a retained request ledger upgrades with its interpreters atomically and preserves pending claims", async () => {
      const exported = await cue(["export", "-", "-e", `_cluster.surface.targets["airlock-upgrade"]`, "--out", "json"], paymentProgram());
      if (!exported.success) throw new Error(exported.stderr);
      const target = JSON.parse(exported.stdout);
      assertEquals(target.dockerfile.cmd.includes("--single-transaction"), true);
      assertEquals(target.compose.depends_on.database.condition, "service_healthy");
      const heredoc = target.dockerfile.epilogue[0] as string;
      const upgrade = heredoc.slice(heredoc.indexOf("\n") + 1, heredoc.lastIndexOf("\n"));
      const three = "00000000-0000-0000-0000-000000000003";
      const four = "00000000-0000-0000-0000-000000000004";
      const old = await psql(`BEGIN;
        ALTER TABLE airlock.external_effect_ledger RENAME COLUMN input TO request;
        ${files["services/database/migrations/010_machines.sql"].text.replaceAll('"input"', '"request"')}
        INSERT INTO payment VALUES ('${three}', 'pending', 19.75, NULL);
        UPDATE payment SET status = 'charging' WHERE id = '${three}';
        COMMIT;`);
      if (!old.ok) throw new Error(old.err);
      const snapshot = (await psql(`SELECT jsonb_agg((to_jsonb(l) - 'request') || jsonb_build_object('input', request) ORDER BY key) FROM airlock.external_effect_ledger l;`)).out;
      const failed = await psql(`BEGIN; ${upgrade} SELECT missing_upgrade_column; COMMIT;`);
      assertEquals(failed.ok, false);
      assertEquals((await psql(`SELECT request->>'amount' FROM airlock.external_effect_ledger WHERE key = 'charge:${three}';`)).out, "19.75");
      for (let i = 0; i < 2; i++) {
        const applied = await psql(`BEGIN; ${upgrade} COMMIT;`);
        if (!applied.ok) throw new Error(applied.err);
        assertEquals((await psql(`SELECT jsonb_agg(to_jsonb(l) ORDER BY key) FROM airlock.external_effect_ledger l;`)).out, snapshot);
      }
      const resumed = await psql(`
        UPDATE airlock.external_effect_ledger SET outcome = '{"target":"settled","kind":"done"}' WHERE key = 'charge:${three}';
        UPDATE payment SET status = 'settled' WHERE id = '${three}';
        INSERT INTO payment VALUES ('${four}', 'pending', 23.50, NULL);
        UPDATE payment SET status = 'charging' WHERE id = '${four}';
        SELECT status FROM payment WHERE id = '${three}';
        SELECT input->>'amount' FROM airlock.external_effect_ledger WHERE key = 'charge:${four}';`);
      if (!resumed.ok) throw new Error(resumed.err);
      assertEquals(resumed.out.split("\n"), ["settled", "23.50"]);
    });

    await t.step("Airlock startup cannot adopt changed timers before their explicit migration", async () => {
      const compile = async (delay: string) => {
        const source = paymentProgram()
          .replace('pending: on: pay: "charging"', `pending: {on: pay: "charging", after: "${delay}": "failed"}`)
          .replaceAll("Payment", "TimedPayment").replaceAll("payment", "timed_payment");
        const result = await cue(["export", "-", "-e", '{sql: out["services/database/migrations/010_machines.sql"].text, check: _cluster.state.timerCheck, upgrade: _cluster.surface.targets["airlock-upgrade"].dockerfile.epilogue[0]}', "--out", "json"], source);
        if (!result.success) throw new Error(result.stderr);
        const emitted = JSON.parse(result.stdout);
        emitted.upgrade = emitted.upgrade.slice(emitted.upgrade.indexOf("\n") + 1, emitted.upgrade.lastIndexOf("\n"));
        return emitted;
      };
      const before = await compile("0");
      const after = await compile("1000000");
      const sql = async (query: string) => {
        const result = await psql(query);
        if (!result.ok) throw new Error(result.err);
        return result.out;
      };
      await sql(`CREATE TABLE timed_payment (LIKE payment INCLUDING ALL);
        ${before.sql}
        INSERT INTO timed_payment VALUES ('00000000-0000-0000-0000-000000000009', 'pending', 1, NULL);
        BEGIN; ${before.upgrade} ${before.check} COMMIT;`);
      const snapshot = () => sql(`SELECT obj_description('trg_timed_payment_status_timer_arm()'::regprocedure, 'pg_proc');
        SELECT jsonb_agg(to_jsonb(s) ORDER BY name) FROM schedule s WHERE emits_entity = 'machine_timer_tick';`);
      const retained = await snapshot();
      const refused = await psql(`BEGIN; ${after.upgrade} ${after.check} COMMIT;`);
      assertEquals(refused.ok, false, "startup must not stamp an unreconciled timer as current");
      assertStringIncludes(refused.err, "timer interpreter differs");
      assertEquals(await snapshot(), retained, "the refusal preserves both interpreter and deadlines");
      assertEquals((await psql(after.check)).ok, false);

      // This fixture knows the old deadline was the entry time: the migration
      // can preserve that visit, where startup cannot infer its elapsed time.
      await sql(`BEGIN;
        UPDATE schedule SET due_at = due_at + interval '1000000 milliseconds',
          emits_values = jsonb_set(emits_values, '{delay}', '"1000000"')
          WHERE emits_values->>'machine' = 'TimedPaymentMachine';
        ${after.sql} COMMIT;`);
      const migrated = await snapshot();
      for (let i = 0; i < 2; i++) {
        await sql(`BEGIN; ${after.upgrade} ${after.check} COMMIT;`);
        assertEquals(await snapshot(), migrated, "restart preserves the explicitly migrated visit");
      }
    });

    await t.step("the ledger is closed to the cluster's client roles", async () => {
      const r = await psql(`SET ROLE app_user; SELECT count(*) FROM airlock.external_effect_ledger;`);
      assertEquals(r.ok, false);
      assertStringIncludes(r.err, "permission denied");
    });
  } finally {
    await run("docker", ["rm", "-f", container]);
  }
} });
