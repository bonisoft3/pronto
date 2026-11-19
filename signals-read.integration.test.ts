// A signal whose event enters a state that invokes a read, through what a
// container release runs: the door's own route, the real PostgREST, the
// emitted function and interpreter in postgres, and mecha's airlock (airlock.ts,
// read.ts) run under its own config over a sink this process serves,
// delivering and journaling the answer. Graphile's add_job is a stand-in, as
// in signals.integration.test.ts. Regression rationale: the signal's function
// runs under the request's anonymous role, which a read's state refuses, so
// the move it makes must be told from an anonymous client's own write, which
// stays refused. It needs Docker.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { collidingSignalProgram, emitFiles, signalledReadProgram, twoMachineSignalProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const AIRLOCK = new URL("../../libraries/mecha/services/airlock/", import.meta.url);
const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
const pinned = (name: string) => {
  const found = cluster.match(new RegExp(`"(${name}:[^"@]+@sha256:[0-9a-f]{64})"`))?.[1];
  if (!found) throw new Error(`cluster.cue pins no ${name} image`);
  return found;
};

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

/** The airlock's own read, run in a process of its own config: each job performed, answered as JSON in order. */
const DRIVER = `
  import pg from "pg";
  import { performRead } from "${new URL("airlock.ts", AIRLOCK).href}";
  import { journalIndexes, parseReads, READ_JOURNAL_SQL } from "${new URL("read.ts", AIRLOCK).href}";
  const [connectionString, mesh, manifest, jobs] = Deno.args;
  const db = new pg.Pool({ connectionString, max: 2 });
  await db.query(READ_JOURNAL_SQL);
  await journalIndexes(db);
  const a = { db, reads: parseReads(manifest), headers: {}, mesh };
  const out = [];
  for (const job of JSON.parse(jobs)) out.push(await performRead(a, job, false) ?? null);
  await db.end();
  console.log(JSON.stringify(out));`;

Deno.test({ name: "a signal moves a row into a read's state, whose answer is delivered and journaled; an anonymous client's own write there is refused", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const files = await emitFiles(signalledReadProgram());
  const manifest = JSON.stringify(files["services/airlock/effects.json"].data);
  const tag = crypto.randomUUID().slice(0, 8);
  const network = `signals-read-${tag}`, db = `signals-read-pg-${tag}`, rest = `signals-read-rest-${tag}`, door = `signals-read-door-${tag}`;
  const dir = await Deno.makeTempDir();
  // The door the app is given, whole: its routes in the snippet every site block imports.
  await Deno.writeTextFile(`${dir}/Caddyfile`, files["docker/Caddyfile"].text);
  await Deno.writeTextFile(`${dir}/driver.ts`, DRIVER);
  // The sink, standing where the airlock's daprd stands.
  const asked: string[] = [];
  const sink = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const u = new URL(req.url);
    asked.push(u.pathname.replace(/^\/v1\.0\/invoke\/rate\/method/, "") + u.search);
    return Response.json({ usd: 5.3 });
  });
  const psql = (sql: string) => run("docker", ["exec", "-i", db, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const must = async (r: Promise<{ ok: boolean; err: string }>) => {
    const done = await r;
    if (!done.ok) throw new Error(done.err);
  };
  try {
    await must(run("docker", ["network", "create", network]));
    await must(run("docker", ["run", "-d", "--rm", "--name", db, "--network", network, "--network-alias", "database", "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=pw", POSTGRES]));
    for (let i = 0; !(await run("docker", ["exec", db, "pg_isready", "-qh", "127.0.0.1", "-U", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const one = "00000000-0000-0000-0000-000000000001", two = "00000000-0000-0000-0000-000000000002", three = "00000000-0000-0000-0000-000000000003";
    await must(psql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE app_user; CREATE ROLE electric;
      CREATE SCHEMA graphile_worker;
      CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
      CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
        run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
        flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
        $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text, pricings int, lineage uuid, nudges int NOT NULL DEFAULT 0);
      GRANT ALL ON payment TO anon, app_user;
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/ticker/schedule.sql", import.meta.url))}
      ${await Deno.readTextFile(new URL("airlock.sql", AIRLOCK))}
      ${await Deno.readTextFile(new URL("job_key.sql", AIRLOCK))}
      ${files["services/database/migrations/010_machines.sql"].text}
      ${files["services/database/migrations/802_signals.sql"].text}
      INSERT INTO payment (id, status, total, failure) VALUES ('${one}', 'pending', 1, 'USD'), ('${two}', 'pending', 1, 'USD'), ('${three}', 'pending', 1, 'USD');`));
    await must(run("docker", ["run", "-d", "--rm", "--name", rest, "--network", network, "--network-alias", "crud",
      "-e", "PGRST_DB_URI=postgres://postgres:pw@database:5432/postgres", "-e", "PGRST_DB_ANON_ROLE=anon", pinned("postgrest/postgrest")]));
    await must(run("docker", ["run", "-d", "--rm", "--name", door, "--network", network, "-p", "127.0.0.1::8080", "-e", "ORIGIN=http://door.example", "-e", "ELECTRIC_SECRET=unused", "-v", `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
      pinned("caddy"), "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]));
    const port = (await run("docker", ["port", door, "8080"])).out.split(":").pop();
    const pgPort = (await run("docker", ["port", db, "5432"])).out.split("\n")[0].split(":").pop();
    const send = async (method: string, path: string, body: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: { "content-type": "application/json" } });
      return { status: res.status, body: await res.text() };
    };
    for (let i = 0; (await send("POST", "/signal/vendor/not-a-uuid", "{}").catch(() => ({ status: 0 }))).status !== 200; i++) {
      if (i > 120) throw new Error("the door or PostgREST did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const row = async (id: string) => (await psql(`SELECT status || ' ' || coalesce(failure, '') || ' ' || pricings || ' ' || nudges FROM payment WHERE id = '${id}'`)).out;
    const jobs = async (id: string) => (await psql(`SELECT payload FROM graphile_worker.added WHERE payload->'row'->>'id' = '${id}' ORDER BY ctid`)).out.split("\n").filter(Boolean).map((j) => JSON.parse(j));

    await t.step("a signal through the door moves the row into the read's state, which counts the entry and enqueues the request", async () => {
      assertEquals(await send("POST", `/signal/vendor/${one}`, "{}"), { status: 200, body: `{"signal" : "moved"}` });
      assertEquals(await row(one), "pricing USD 1 1");
      const [job] = await jobs(one);
      assertEquals([job.effect, job.n, job.input], ["rate", 1, { currency: "USD", day: "2026-11-16" }]);
    });

    await t.step("the airlock asks the sink, moves the row and journals the answer", async () => {
      const r = await run(Deno.execPath(), ["run", "--config", new URL("deno.json", AIRLOCK).pathname, "--frozen", "--allow-net", "--allow-read", "--allow-env", "--allow-sys", `${dir}/driver.ts`,
        `postgres://postgres:pw@127.0.0.1:${pgPort}/postgres`, `http://127.0.0.1:${sink.addr.port}`, manifest, JSON.stringify(await jobs(one))]);
      if (!r.ok) throw new Error(r.err);
      assertEquals(asked, ["/rates/USD?day=2026-11-16"]);
      assertEquals(await row(one), "settled 5.3 1 1");
      assertEquals((await psql(`SELECT n || ' ' || (outcome->>'target') || ' ' || (outcome->'data'->>'usd') FROM airlock.read_journal WHERE row->>'id' = '${one}'`)).out, "1 settled 5.3");
    });

    await t.step("an anonymous client's own write into the read's state is refused, at the door's /crud", async () => {
      const refused = await send("PATCH", `/crud/payment?id=eq.${two}`, JSON.stringify({ status: "pricing" }));
      assertEquals(refused.status, 401);
      assertStringIncludes(refused.body, "read rate is asked by a signed-in writer, and the request names none");
      // Signed in, the same write is the row's own.
      const signed = await psql(`BEGIN; SET LOCAL ROLE app_user; UPDATE payment SET status = 'pricing' WHERE id = '${two}'; SELECT status FROM payment WHERE id = '${two}'; ROLLBACK;`);
      assertEquals(signed.out, "pricing");
      assertEquals([await row(two), (await jobs(two)).length], ["pending USD 0 0", 0]);
    });

    const refusal = "read rate is asked by a signed-in writer, and the request names none";
    /** The door's call of the signal, as PostgREST makes it, in a session of psql's. */
    const signalIn = (signal: string, id: string) => `SELECT set_config('request.headers', '{"x-signal-path": "/signal/${signal}/${id}"}', true); SELECT public.signal_in('{}');`;

    await t.step("what a signal names admits its own move alone: none of another row, and none once the move is made", async () => {
      const other = await psql(`BEGIN; SET LOCAL ROLE anon; SELECT set_config('airlock.signal', jsonb_build_array('payment', 'status', '${three}', 'pricing')::text, true);
        UPDATE payment SET status = 'pricing' WHERE id = '${two}'; COMMIT;`);
      assertStringIncludes(other.err, refusal);
      // After the function's move the setting names nothing, the moved row's own state included.
      const after = await psql(`BEGIN; SET LOCAL ROLE anon; ${signalIn("vendor", three)}
        SELECT 'left:' || current_setting('airlock.signal', true) || ':' || (SELECT status FROM payment WHERE id = '${three}'); ROLLBACK;`);
      if (!after.ok) throw new Error(after.err);
      assertEquals(after.out.split("\n").pop(), "left::pricing");
      assertEquals([await row(two), await row(three)], ["pending USD 0 0", "pending USD 0 0"]);
    });

    // A second database: a text key, and a state named so that a row `a:b`
    // entering `pricing` and a row `a` entering `b:pricing` are told apart only
    // by keeping the parts apart. `pricing`'s entry writes the row `a` into
    // `b:pricing`, a read's state too, during the signal's own update.
    await t.step("a transition's write of another row into a read's state is refused during a signal, however their names run together", async () => {
      const colliding = await emitFiles(collidingSignalProgram());
      const there = (sql: string) => run("docker", ["exec", "-i", db, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "colliding"], sql);
      await must(psql("CREATE DATABASE colliding;"));
      await must(there(`
        CREATE SCHEMA graphile_worker;
        CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
        CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
          run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
          flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
          $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
        CREATE TABLE payment (id text PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text, pricings int, lineage uuid, nudges int NOT NULL DEFAULT 0);
        GRANT ALL ON payment TO anon, app_user;
        ${await Deno.readTextFile(new URL("../../libraries/mecha/services/ticker/schedule.sql", import.meta.url))}
        ${await Deno.readTextFile(new URL("airlock.sql", AIRLOCK))}
        ${await Deno.readTextFile(new URL("job_key.sql", AIRLOCK))}
        ${colliding["services/database/migrations/010_machines.sql"].text}
        ${colliding["services/database/migrations/802_signals.sql"].text}
        INSERT INTO payment (id, status, total, failure) VALUES ('a:b', 'pending', 1, 'USD'), ('a', 'pending', 1, 'USD'), ('x', 'pending', 1, 'USD');`));
      const state = async () => (await there(`SELECT string_agg(id || '=' || status, ' ' ORDER BY id) || ' jobs=' || (SELECT count(*) FROM graphile_worker.added) FROM payment`)).out;
      // Without the nested write the function moves a row there, as it does above.
      const alone = await there(`BEGIN; SET LOCAL ROLE anon; ${signalIn("other", "x")} SELECT status FROM payment WHERE id = 'x'; ROLLBACK;`);
      if (!alone.ok) throw new Error(alone.err);
      assertEquals(alone.out.split("\n").pop(), "b:pricing");
      for (const id of ["a:b", "x"]) {
        const moved = await there(`BEGIN; SET LOCAL ROLE anon; ${signalIn("vendor", id)} COMMIT;`);
        assertStringIncludes(moved.err, "read rate-other is asked by a signed-in writer, and the request names none");
      }
      assertEquals(await state(), "a=pending a:b=pending x=pending jobs=0");
    });

    // A third database: two machines on the one table, each with a read's
    // state `pricing` a signal's event enters. The first's entry assigns the
    // second's field into its own `pricing`, in the signal's very update of
    // the row, so only the machine tells the two moves apart.
    await t.step("a signal of one machine admits no read's state of another machine on the row", async () => {
      const paired = await emitFiles(twoMachineSignalProgram());
      const there = (sql: string) => run("docker", ["exec", "-i", db, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "paired"], sql);
      await must(psql("CREATE DATABASE paired;"));
      await must(there(`
        CREATE SCHEMA graphile_worker;
        CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
        CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
          run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
          flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
          $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
        CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text, pricings int, lineage uuid, nudges int NOT NULL DEFAULT 0, zstatus text NOT NULL DEFAULT 'idle', zpricings int, zlineage uuid);
        GRANT ALL ON payment TO anon, app_user;
        ${await Deno.readTextFile(new URL("../../libraries/mecha/services/ticker/schedule.sql", import.meta.url))}
        ${await Deno.readTextFile(new URL("airlock.sql", AIRLOCK))}
        ${await Deno.readTextFile(new URL("job_key.sql", AIRLOCK))}
        ${paired["services/database/migrations/010_machines.sql"].text}
        ${paired["services/database/migrations/802_signals.sql"].text}
        INSERT INTO payment (id, status, total, failure) VALUES ('${one}', 'pending', 1, 'USD');`));
      // The second machine's own signal enters its state.
      const own = await there(`BEGIN; SET LOCAL ROLE anon; ${signalIn("phase", one)} SELECT zstatus FROM payment; ROLLBACK;`);
      if (!own.ok) throw new Error(own.err);
      assertEquals(own.out.split("\n").pop(), "pricing");
      const moved = await there(`BEGIN; SET LOCAL ROLE anon; ${signalIn("vendor", one)} COMMIT;`);
      assertStringIncludes(moved.err, "read rate-other is asked by a signed-in writer, and the request names none");
      assertEquals((await there(`SELECT status || ' ' || zstatus || ' jobs=' || (SELECT count(*) FROM graphile_worker.added) FROM payment`)).out, "pending idle jobs=0");
    });

    await t.step("a signal mid-read answers 503", async () => {
      assertEquals((await send("POST", `/signal/vendor/${three}`, "{}")).status, 200);
      assertEquals((await send("POST", `/signal/vendor/${three}`, "{}")).status, 503);
      assertEquals(await row(three), "pricing USD 1 1");
    });
  } finally {
    await sink.shutdown();
    for (const name of [door, rest, db]) await run("docker", ["rm", "-f", name]);
    await run("docker", ["network", "rm", network]);
    await Deno.remove(dir, { recursive: true });
  }
} });
