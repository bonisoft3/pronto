// A read where it runs: the interpreter emitted for a state that invokes one,
// in postgres, with Graphile's add_job a recording stand-in, and mecha's
// airlock (airlock.ts, read.ts) run under its own config over a sink this
// process serves, delivering, journaling and, in replay, answering from the
// journal. It needs Docker.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { emitFiles, readProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const AIRLOCK = new URL("../../libraries/mecha/services/airlock/", import.meta.url);

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

/** The airlock's own functions, run in a process of its own config: each
 * step a perform, a delivery or a prune, answered as JSON in order. */
const DRIVER = `
  import pg from "pg";
  import { deliverRead, performRead, pruneJournal } from "${new URL("airlock.ts", AIRLOCK).href}";
  import { parseReads, READ_JOURNAL_SQL } from "${new URL("read.ts", AIRLOCK).href}";
  const [connectionString, mesh, manifest, replay, steps] = Deno.args;
  const db = new pg.Pool({ connectionString, max: 2 });
  await db.query(READ_JOURNAL_SQL);
  const a = { db, reads: parseReads(manifest), headers: {}, mesh, replay: replay === "replay" };
  const out = [];
  for (const s of JSON.parse(steps)) {
    try {
      if (s.op === "perform") out.push({ ok: await performRead(a, s.job, s.last ?? false) ?? null });
      else if (s.op === "deliver") out.push({ ok: await deliverRead(a, s.job, s.settled) });
      else out.push({ ok: await pruneJournal(a) ?? null });
    } catch (e) {
      out.push({ error: e.constructor.name, message: e.message });
    }
  }
  await db.end();
  console.log(JSON.stringify(out));`;

Deno.test({ name: "a read enqueues with no claim, and the airlock's answer to the entry the row waits on moves it and is journaled; replay answers from the journal", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const files = await emitFiles(readProgram());
  const manifest = JSON.stringify(files["services/airlock/effects.json"].data);
  const container = `pronto-reads-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/driver.ts`, DRIVER);
  // The sink, standing where the airlock's daprd stands; its answer can change.
  let usd = 5.3;
  const asked: string[] = [];
  const sink = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const u = new URL(req.url);
    asked.push(u.pathname.replace(/^\/v1\.0\/invoke\/rate\/method/, "") + u.search);
    return Response.json({ usd });
  });
  try {
    const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=pw", POSTGRES]);
    if (!started.ok) throw new Error(started.err);
    for (let i = 0; !(await run("docker", ["exec", container, "pg_isready", "-qh", "127.0.0.1", "-U", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const port = (await run("docker", ["port", container, "5432"])).out.split("\n")[0].split(":").pop();
    const psql = (sql: string, user = "postgres") => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"], sql);
    const airlock = async (steps: unknown[], mode = "live") => {
      const r = await run(Deno.execPath(), ["run", "--config", new URL("deno.json", AIRLOCK).pathname, "--frozen", "--allow-net", "--allow-read", "--allow-env", "--allow-sys", `${dir}/driver.ts`,
        `postgres://postgres:pw@127.0.0.1:${port}/postgres`, `http://127.0.0.1:${sink.addr.port}`, manifest, mode, JSON.stringify(steps)]);
      if (!r.ok) throw new Error(r.err);
      return JSON.parse(r.out) as { ok?: unknown; error?: string; message?: string }[];
    };
    const setup = await psql(`
      CREATE ROLE anon; CREATE ROLE app_user; CREATE ROLE electric; CREATE ROLE crud LOGIN;
      CREATE SCHEMA graphile_worker;
      CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
      CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
        run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
        flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
        $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text, pricings int, lineage uuid);
      GRANT ALL ON payment TO crud, anon, app_user;
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/ticker/schedule.sql", import.meta.url))}
      ${await Deno.readTextFile(new URL("airlock.sql", AIRLOCK))}
      ${await Deno.readTextFile(new URL("job_key.sql", AIRLOCK))}
      ${files["services/database/migrations/010_machines.sql"].text}
      INSERT INTO payment VALUES ('00000000-0000-0000-0000-000000000001', 'pending', 12.50, 'USD', 7, '00000000-0000-0000-0000-00000000000a'),
                                 ('00000000-0000-0000-0000-000000000002', 'pending', 7.00, 'EUR', 7, '00000000-0000-0000-0000-00000000000a');`);
    if (!setup.ok) throw new Error(setup.err);
    const one = "00000000-0000-0000-0000-000000000001";
    const two = "00000000-0000-0000-0000-000000000002";
    const status = async (id: string) => (await psql(`SELECT status || ' ' || coalesce(failure, '') FROM payment WHERE id = '${id}'`)).out;
    const jobOf = async (id: string) => JSON.parse((await psql(`SELECT payload FROM graphile_worker.added WHERE payload->'row'->>'id' = '${id}' ORDER BY ctid DESC LIMIT 1`)).out);
    const lineage = async (id: string) => (await psql(`SELECT lineage FROM payment WHERE id = '${id}'`)).out;
    const at: Record<string, string> = {};
    const journal = async () => (await psql(`SELECT key || ' ' || n || ' ' || (outcome->>'target') || ' ' || coalesce(outcome->'data'->>'usd', '') FROM airlock.read_journal ORDER BY key`)).out;

    await t.step("entering the state counts the entry from zero and enqueues the request, claiming nothing and arming the wake", async () => {
      // Each row took an incarnation of its own at its insert, whatever it offered.
      at[one] = await lineage(one);
      at[two] = await lineage(two);
      assertEquals([at[one] !== at[two], at[one] === "00000000-0000-0000-0000-00000000000a"], [true, false]);
      const r = await psql(`UPDATE payment SET status = 'pricing' WHERE id IN ('${one}', '${two}');
        SELECT identifier || ' ' || (payload->>'n') || ' ' || (payload->>'key') || ' ' || (payload->'input')::text || ' ' || coalesce(job_key, 'none') || ' ' || max_attempts FROM graphile_worker.added ORDER BY payload->'row'->>'id';
        SELECT string_agg(pricings::text, ' ' ORDER BY id) FROM payment;
        SELECT count(*) FROM airlock.external_effect_ledger;
        SELECT last_tick_at IS NULL FROM schedule WHERE name = 'airlock';`);
      if (!r.ok) throw new Error(r.err);
      assertEquals(r.out.split("\n"), [
        `external_read 1 rate:${one}:${at[one]}:1 {"day": "2026-11-16", "currency": "USD"} none 5`,
        `external_read 1 rate:${two}:${at[two]}:1 {"day": "2026-11-16", "currency": "EUR"} none 5`,
        "1 1",
        "0",
        "t",
      ]);
    });

    await t.step("an anonymous request enters no read's state, and a row asking is not deleted", async () => {
      const three = "00000000-0000-0000-0000-000000000003";
      const anon = await psql(`INSERT INTO payment VALUES ('${three}', 'pending', 1.00, 'USD', 0, NULL);
        BEGIN; SET LOCAL ROLE anon; UPDATE payment SET status = 'pricing' WHERE id = '${three}'; COMMIT;`);
      assertStringIncludes(anon.err, "read rate is asked by a signed-in writer, and the request names none");
      const signed = await psql(`BEGIN; SET LOCAL ROLE app_user; UPDATE payment SET status = 'pricing' WHERE id = '${three}'; COMMIT;`);
      if (!signed.ok) throw new Error(signed.err);
      const deleted = await psql(`DELETE FROM payment WHERE id = '${three}';`);
      assertStringIncludes(deleted.err, "payment in pricing awaits an outcome and is not deleted");
    });

    await t.step("no writer but the airlock's session moves the row out, and none writes its count", async () => {
      const plain = await psql(`UPDATE payment SET status = 'settled' WHERE id = '${one}';`);
      assertStringIncludes(plain.err, "payment leaves pricing only by the answer of the read rate");
      const job = await jobOf(one);
      const forged = await psql(`BEGIN;
        SELECT set_config('airlock.read', '${JSON.stringify({ effect: "rate", row: { id: one }, incarnation: job.incarnation, n: job.n, target: "settled", kind: "done", data: { usd: 1 } })}', true);
        UPDATE payment SET status = 'settled' WHERE id = '${one}';
        COMMIT;`, "crud");
      assertStringIncludes(forged.err, "only by the answer of the read rate");
      const counted = await psql(`UPDATE payment SET pricings = 0 WHERE id = '${one}';`);
      assertStringIncludes(counted.err, "payment counts its entries in pricings, which only its machine writes");
      const reborn = await psql(`UPDATE payment SET lineage = gen_random_uuid() WHERE id = '${one}';`);
      assertStringIncludes(reborn.err, "payment names its incarnation in lineage, which only its machine writes");
      const held = await psql(`UPDATE payment SET failure = 'BRL' WHERE id = '${one}';`);
      assertStringIncludes(held.err, "payment in pricing keeps what its read asked until the answer of rate");
      assertEquals(await status(one), "pricing USD");
    });

    await t.step("the airlock asks the sink, moves the row and journals the answer in one commit", async () => {
      assertEquals(await airlock([{ op: "perform", job: await jobOf(one) }]), [{ ok: null }]);
      assertEquals(asked, ["/rates/USD?day=2026-11-16"]);
      assertEquals(await status(one), "settled 5.3");
      assertEquals(await journal(), `rate:${one}:${at[one]}:1 1 settled 5.3`);
    });

    await t.step("an answer to an entry the row no longer waits on moves nothing and journals nothing", async () => {
      const job = await jobOf(two);
      assertEquals(await airlock([{ op: "deliver", job: { ...job, n: 0, key: `rate:${two}:${at[two]}:0` }, settled: { target: "settled", kind: "done", data: { usd: 1 } } }]), [{ ok: false }]);
      assertEquals(await status(two), "pricing EUR");
      assertEquals(await journal(), `rate:${one}:${at[one]}:1 1 settled 5.3`);
    });

    // Replay re-runs a row's history from its start: the row as it was, its
    // transitions written again, so its entry is counted to the same n.
    const rewind = (id: string, failure: string) =>
      psql(`ALTER TABLE payment DISABLE TRIGGER USER; UPDATE payment SET status = 'pending', failure = '${failure}', pricings = 0 WHERE id = '${id}'; ALTER TABLE payment ENABLE TRIGGER USER;
        UPDATE payment SET status = 'pricing' WHERE id = '${id}';`);

    await t.step("replay reaches the same key and is answered from the journal, never the sink", async () => {
      if (!(await rewind(one, "USD")).ok) throw new Error("rewind");
      usd = 9;
      const job = await jobOf(one);
      assertEquals([job.n, job.key], [1, `rate:${one}:${at[one]}:1`]);
      assertEquals(await airlock([{ op: "perform", job }], "replay"), [{ ok: null }]);
      assertEquals(asked.length, 1, "the sink was not asked again");
      assertEquals(await status(one), "settled 5.3");
    });

    await t.step("a replay whose request differs from the recorded one under the same key stops there", async () => {
      if (!(await rewind(one, "BRL")).ok) throw new Error("rewind");
      const [r] = await airlock([{ op: "perform", job: await jobOf(one), last: true }], "replay");
      assertEquals(r.error, "ReadDiverged");
      assertEquals(await status(one), "pricing BRL");
      assertEquals(asked.length, 1);
    });

    await t.step("a deleted row's entries leave the journal at the sweep; a standing row's stay", async () => {
      assertEquals(await airlock([{ op: "perform", job: await jobOf(two) }]), [{ ok: null }]);
      assertEquals(await journal(), `rate:${one}:${at[one]}:1 1 settled 5.3\nrate:${two}:${at[two]}:1 1 settled 9`.split("\n").sort().join("\n"));
      const r = await psql(`DELETE FROM payment WHERE id = '${two}';`);
      if (!r.ok) throw new Error(r.err);
      assertEquals(await airlock([{ op: "prune" }]), [{ ok: null }]);
      assertEquals(await journal(), `rate:${one}:${at[one]}:1 1 settled 5.3`);
    });

    await t.step("a row made again under a deleted one's key is another incarnation: a stale answer misses it, and its journal keys are its own", async () => {
      const stale = await jobOf(two);
      const r = await psql(`INSERT INTO payment VALUES ('${two}', 'pending', 7.00, 'EUR', 0, NULL); UPDATE payment SET status = 'pricing' WHERE id = '${two}';`);
      if (!r.ok) throw new Error(r.err);
      const fresh = await jobOf(two);
      assertEquals([fresh.n, fresh.incarnation !== stale.incarnation, fresh.key === stale.key], [1, true, false]);
      // The first incarnation's answer, delivered again as after a crash, at the same n.
      assertEquals(await airlock([{ op: "deliver", job: stale, settled: { target: "settled", kind: "done", data: { usd: 1 } } }]), [{ ok: false }]);
      assertEquals(await status(two), "pricing EUR");
      usd = 11;
      assertEquals(await airlock([{ op: "perform", job: fresh }]), [{ ok: null }]);
      assertEquals(await status(two), "settled 11");
      assertEquals(await journal(), [`rate:${one}:${at[one]}:1 1 settled 5.3`, `rate:${two}:${fresh.incarnation}:1 1 settled 11`].sort().join("\n"));
    });
  } finally {
    await sink.shutdown();
    await run("docker", ["rm", "-f", container]);
  }
} });
