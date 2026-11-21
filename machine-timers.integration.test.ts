import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { cue, paymentProgram } from "./effects-fixtures.ts";
import { generateTypeSQL } from "./type-sql.ts";
import { heldClock } from "./bundle/held-clock.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const append = (value: string) => `{assign: failure: {raw: "coalesce(NEW.failure, '') || '${value}'"}}`;

function program() {
  return paymentProgram({ machine: `
    pending: {
      entry: ${append("I")}
      exit: ${append("E")}
      on: {
        cancel: "cancelled"
        arm: {target: "armed", guard: "NULLIF(NEW.total, 0) > 0"}
        finish: {target: "expired", actions: ${append("O")}}
      }
      after: {
        "0": [
          {target: "expired", guard: "OLD.total > 5 AND NEW.status = 'expired'", actions: ${append("T")}},
          {target: "pending", actions: ${append("S")}},
        ]
        "1000000": "expired"
      }
    }
    armed: after: "0": [
      {target: "expired", guard: "OLD.total < 0"},
      {target: "cancelled", guard: "NULL::boolean"},
    ]
    cancelled: on: retry: "pending"
    expired: {type: "final", entry: ${append("N")}}
  ` }).replace(/\n    effects: charge: \{[\s\S]*?\n    }\n/, "\n");
}

async function run(cmd: string, args: string[], stdin?: string) {
  const child = new Deno.Command(cmd, { args, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const result = await child.output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr) };
}

Deno.test({ name: "server timers advance machines through durable ticker records", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const result = await cue(["export", "-", "-e", '{sql: out["services/database/migrations/010_machines.sql"].text, check: _cluster.state.timerCheck, timers: _cluster.state.timers, ticker: _cluster.surface.targets.ticker.compose.environment, ready: _cluster.surface.targets.crud.compose.depends_on}', "--out", "json"], program());
  if (!result.success) throw new Error(result.stderr);
  const emitted = JSON.parse(result.stdout);
  assertEquals(emitted.timers, ["PaymentMachine"]);
  assertEquals(typeof emitted.ticker.SERVICE_JWT, "string");
  assertEquals(emitted.ready["timer-check"].condition, "service_completed_successfully");
  const container = `pronto-timers-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", POSTGRES]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const sql = async (query: string) => {
    const r = await psql(query);
    if (!r.ok) throw new Error(r.err);
    return r.out;
  };
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const owner = (n: number) => `emits_values->'row'->>'id' = '${id(n)}'`;
  const insert = (n: number, total = 10) => `INSERT INTO payment VALUES ('${id(n)}', 'pending', ${total}, NULL);`;
  const tick = (n: number, table = "schedule", tickId = "gen_random_uuid()") => `
    INSERT INTO machine_timer_tick (id, schedule, tick_at, late, caller, machine, "row", state, delay)
      SELECT ${tickId}, name, due_at, false, NULL, emits_values->>'machine', emits_values->'row',
             emits_values->>'state', emits_values->>'delay'
      FROM ${table} WHERE ${owner(n)} AND emits_values->>'delay' = '0'
      ON CONFLICT (id) DO NOTHING;`;
  try {
    for (let i = 0; !(await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await sql(`
      CREATE ROLE anon; CREATE ROLE app_user;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric NOT NULL, failure text);
      ${emitted.sql}
      CREATE TABLE saved_schedule AS SELECT * FROM schedule WITH NO DATA;`);

    await t.step("entry and rollback own the schedule atomically", async () => {
      assertEquals(await sql(`BEGIN; ${insert(1)} ROLLBACK; SELECT count(*) FROM schedule;`), "0");
      assertEquals(await sql(`${insert(1)} SELECT count(*) FROM schedule WHERE ${owner(1)};`), "2");
      assertEquals(await sql(`SELECT failure FROM payment WHERE id = '${id(1)}';`), "I");
    });
    await t.step("a ticker row runs exit, timeout actions and target entry without a client write", async () => {
      await sql(`INSERT INTO saved_schedule SELECT * FROM schedule WHERE ${owner(1)};`);
      assertEquals(await sql(`${tick(1, "schedule", `'${id(100)}'`)} SELECT status || ',' || failure FROM payment WHERE id = '${id(1)}';`), "expired,IETN");
      assertEquals(await sql(`SELECT count(*) FROM schedule WHERE ${owner(1)};`), "0");
      assertEquals(await sql(`${tick(1, "saved_schedule", `'${id(100)}'`)} SELECT failure FROM payment WHERE id = '${id(1)}';`), "IETN");
    });
    await t.step("an ordinary transition to the same target chooses its own actions", async () => {
      assertEquals(await sql(`${insert(2)} UPDATE payment SET status = 'expired' WHERE id = '${id(2)}'; SELECT failure FROM payment WHERE id = '${id(2)}';`), "IEON");
    });
    await t.step("a timed self-transition runs and creates a new visit", async () => {
      await sql(`${insert(3, 0)} INSERT INTO saved_schedule SELECT * FROM schedule WHERE ${owner(3)};`);
      assertEquals(await sql(`${tick(3)} SELECT status || ',' || failure FROM payment WHERE id = '${id(3)}';`), "pending,IESI");
      assertEquals(await sql(`SELECT count(*) FROM schedule s JOIN saved_schedule old USING(name) WHERE s.${owner(3)};`), "0");
      assertEquals(await sql(`SELECT count(*) FROM schedule WHERE ${owner(3)};`), "2");
      assertEquals(await sql(`${tick(3, "saved_schedule")} SELECT failure FROM payment WHERE id = '${id(3)}';`), "IESI");
    });
    await t.step("leaving and reentering the same state cannot revive an old timeout", async () => {
      await sql(`${insert(4)} INSERT INTO saved_schedule SELECT * FROM schedule WHERE ${owner(4)};
        UPDATE payment SET status = 'cancelled' WHERE id = '${id(4)}';
        UPDATE payment SET status = 'pending' WHERE id = '${id(4)}';`);
      assertEquals(await sql(`${tick(4, "saved_schedule")} SELECT status FROM payment WHERE id = '${id(4)}';`), "pending");
      assertEquals(await sql(`${tick(4)} SELECT status FROM payment WHERE id = '${id(4)}';`), "expired");
    });
    await t.step("guards use the source state and NULL refuses a branch", async () => {
      await sql(`${insert(5)} UPDATE payment SET status = 'armed' WHERE id = '${id(5)}';`);
      const refused = await psql(`UPDATE payment SET status = 'cancelled' WHERE id = '${id(5)}';`);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "invalid transition");
      assertEquals(await sql(`${tick(5)} SELECT status FROM payment WHERE id = '${id(5)}';`), "armed");
      assertEquals(await sql(`SELECT count(*) FROM schedule WHERE ${owner(5)};`), "0");
    });
    await t.step("unrelated updates preserve deadlines and deletion cancels them", async () => {
      await sql(`${insert(6)} INSERT INTO saved_schedule SELECT * FROM schedule WHERE ${owner(6)};
        UPDATE payment SET total = 20 WHERE id = '${id(6)}';`);
      assertEquals(await sql(`SELECT count(*) FROM schedule s JOIN saved_schedule old USING(name) WHERE s.${owner(6)} AND s.due_at = old.due_at;`), "2");
      assertEquals(await sql(`DELETE FROM payment WHERE id = '${id(6)}'; SELECT count(*) FROM schedule WHERE ${owner(6)};`), "0");
      await sql(tick(6, "saved_schedule"));
    });
    await t.step("rollback keeps a due schedule retryable", async () => {
      await sql(insert(7));
      assertEquals(await sql(`BEGIN; ${tick(7)} ROLLBACK; SELECT status FROM payment WHERE id = '${id(7)}';`), "pending");
      assertEquals(await sql(`SELECT count(*) FROM schedule WHERE ${owner(7)};`), "2");
      assertEquals(await sql(`${tick(7)} SELECT status FROM payment WHERE id = '${id(7)}';`), "expired");
    });
    await t.step("retained databases must migrate the exact interpreter before serving", async () => {
      await sql(emitted.check);
      const mismatched = await psql(`BEGIN; COMMENT ON FUNCTION trg_payment_status_timer_arm() IS 'old'; ${emitted.check} COMMIT;`);
      assertEquals(mismatched.ok, false);
      assertStringIncludes(mismatched.err, "timer interpreter differs");
      await sql(emitted.check);
      const unarmed = await psql(`BEGIN; DROP FUNCTION trg_payment_status_timer_arm() CASCADE;
        ${insert(8)} ${emitted.sql} COMMIT;`);
      assertEquals(unarmed.ok, false);
      assertStringIncludes(unarmed.err, "requires explicit state-entry deadlines");
    });
    await t.step("composite keys survive a JSON round trip without rounding int64", async () => {
      const source = program().replaceAll("Payment", "Counter").replaceAll("payment", "counter")
        .replace('type: "uuid", pk: true', 'type: "int64", pk: true')
        .replace('type: "decimal", precision: 12, scale: 2', 'type: "decimal", precision: 12, scale: 2, pk: true');
      const compiled = await cue(["export", "-", "-e", 'out["services/database/migrations/010_machines.sql"].text', "--out", "text"], source);
      if (!compiled.success) throw new Error(compiled.stderr);
      await sql(`CREATE TABLE counter (id bigint, status text NOT NULL, total numeric(12,2), failure text, PRIMARY KEY(id,total));
        ${compiled.stdout}
        INSERT INTO counter VALUES (9007199254740993, 'pending', 10, NULL), (9007199254740993, 'pending', 11, NULL);
        UPDATE counter SET id = 9007199254740995 WHERE total = 11;`);
      const rows = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'schedule', name, 'tick_at', due_at, 'late', false) || emits_values)
        FROM schedule WHERE emits_values->>'machine' = 'CounterMachine' AND emits_values->>'delay' = '0';`));
      assertEquals(rows.map((r: { row: { id: string } }) => r.row.id).sort(), ["9007199254740993", "9007199254740995"]);
      const payload = JSON.stringify(rows).replaceAll("'", "''");
      assertEquals(await sql(`INSERT INTO machine_timer_tick (id, schedule, tick_at, late, machine, "row", state, delay)
        SELECT id, schedule, tick_at, late, machine, "row", state, delay
        FROM jsonb_populate_recordset(NULL::machine_timer_tick, '${payload}'::jsonb);
        SELECT count(*) FROM counter WHERE status = 'expired';`), "2");
    });
    await t.step("an unanswered ordinary guard refuses the transition", async () => {
      await sql(insert(9, 0));
      const r = await psql(`UPDATE payment SET status = 'armed' WHERE id = '${id(9)}';`);
      assertEquals(r.ok, false);
      assertStringIncludes(r.err, "guard failed");
    });
    await t.step("an earlier AFTER write cannot silently discard timer entry", async () => {
      await sql(`CREATE FUNCTION nested_payment_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE payment SET failure = failure || 'H' WHERE id = NEW.id; RETURN NEW; END $$;
        CREATE TRIGGER a_nested_write AFTER INSERT ON payment FOR EACH ROW EXECUTE FUNCTION nested_payment_write();`);
      const r = await psql(insert(10));
      assertEquals(r.ok, false);
      assertStringIncludes(r.err, "changed again in an earlier AFTER trigger");
      assertEquals(await sql(`SELECT count(*) FROM payment WHERE id = '${id(10)}';`), "0");
      await sql("DROP TRIGGER a_nested_write ON payment; DROP FUNCTION nested_payment_write();");
    });
    await t.step("the client cannot forge ticks or repoint schedules", async () => {
      for (const role of ["anon", "app_user"]) {
        for (const table of ["machine_timer_tick", "schedule"]) {
          const r = await psql(`SET ROLE ${role}; SELECT * FROM ${table};`);
          assertEquals(r.ok, false);
          assertStringIncludes(r.err, "permission denied");
        }
      }
    });
  } finally {
    const removed = await run("docker", ["rm", "-f", container]);
    if (!removed.ok) throw new Error(removed.err);
  }
} });


Deno.test("server timers refuse incomplete state and deployment contracts", async () => {
  for (const [source, error] of [
    [program().replace('"1000000": "expired"', '"-1": "expired"'), "after"],
    [program().replace('"1000000": "expired"', '"1000000": "missing"'), "targets missing state"],
    [program().replace('durability: "server"', 'durability: "device"'), "requires a server-held entity"],
    [program().replace('type: "uuid", pk: true', 'type: "uuid"'), "_readKey.Payment"],
    [program().replace('type: "final", entry:', 'type: "final", after: {"1": "pending"}, entry:'), "cannot declare after"],
    [program().replace('targets: []', 'targets: ["pages"]'), "server timers require a declared clock for pages"],
    [program().replace('targets: []', 'targets: ["aws"]'), "server timers require a declared clock"],
  ]) {
    const r = await cue(["export", "-", "-e", "out"], source);
    assertEquals(r.success, false, error);
    assertStringIncludes(r.stderr, error);
  }
});

// A delay named by the machine's delays: milliseconds, or the duration the
// entered row holds.
function delayed(delays: string) {
  return paymentProgram({ machine: `
    pending: {
      on: cancel: "cancelled"
      after: {review: "expired", quick: "cancelled"}
    }
    cancelled: on: retry: "pending"
    expired: type: "final"
  ` }).replace(/\n    effects: charge: \{[\s\S]*?\n    }\n/, "\n")
    .replace(`{name: "failure", type: "string"},`, `{name: "failure", type: "string"},
          {name: "window", type: "duration", required: false},
          {name: "due_on", type: "timestamp", required: false},`)
    .replace(`initial: "pending"`, `initial: "pending"\n      ${delays}`);
}

Deno.test({ name: "a delay is milliseconds or the entered row's duration, timed by the machine's clock", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const result = await cue(["export", "-", "-e", 'out["services/database/migrations/010_machines.sql"].text', "--out", "text"], delayed(`delays: {review: "window", quick: 90000}`));
  if (!result.success) throw new Error(result.stderr);
  const container = `pronto-delays-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", POSTGRES]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const sql = async (query: string) => {
    const r = await psql(query);
    if (!r.ok) throw new Error(r.err);
    return r.out;
  };
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const due = (n: number, delay: string) => `SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM schedule
    WHERE emits_values->'row'->>'id' = '${id(n)}' AND emits_values->>'delay' = '${delay}';`;
  try {
    for (let i = 0; !(await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await sql(`
      CREATE ROLE anon; CREATE ROLE app_user;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric NOT NULL, failure text, "window" interval, due_on timestamptz);
      ${result.stdout}
      -- A test database moves time by replacing the machine's clock.
      CREATE OR REPLACE FUNCTION machine_clock() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT timestamptz '2030-01-01 00:00:00Z' $$;`);

    await t.step("entering arms each delay from the machine's clock", async () => {
      await sql(`INSERT INTO payment VALUES ('${id(1)}', 'pending', 1, NULL, interval '36 hours', NULL);`);
      assertEquals(await sql(due(1, "review")), "2030-01-02 12:00:00");
      assertEquals(await sql(due(1, "quick")), "2030-01-01 00:01:30");
    });
    await t.step("a duration the row changes later does not move the visit's timer", async () => {
      await sql(`UPDATE payment SET "window" = interval '1 hour' WHERE id = '${id(1)}';`);
      assertEquals(await sql(due(1, "review")), "2030-01-02 12:00:00");
    });
    await t.step("re-entering reads the duration again", async () => {
      await sql(`UPDATE payment SET status = 'cancelled' WHERE id = '${id(1)}'; UPDATE payment SET status = 'pending' WHERE id = '${id(1)}';`);
      assertEquals(await sql(due(1, "review")), "2030-01-01 01:00:00");
    });
    await t.step("a duration finer than a millisecond is due at the next one, an instant a tick names", async () => {
      await sql(`INSERT INTO payment VALUES ('${id(3)}', 'pending', 1, NULL, interval '0.0015 seconds', NULL);`);
      assertEquals(await sql(`SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') FROM schedule
        WHERE emits_values->'row'->>'id' = '${id(3)}' AND emits_values->>'delay' = 'review';`), "2030-01-01 00:00:00.002000");
    });
    await t.step("a null duration refuses the entry", async () => {
      const r = await psql(`INSERT INTO payment VALUES ('${id(2)}', 'pending', 1, NULL, NULL, NULL);`);
      assertEquals(r.ok, false);
      assertStringIncludes(r.err, "waits after review, whose duration window is null");
    });
    await t.step("a tick fires at the instant the ticker found due, whatever the database's clock", async () => {
      // Due in 2030: no wall clock stands between the tick and the transition.
      assertEquals(await sql(`INSERT INTO machine_timer_tick (id, schedule, tick_at, late, caller, machine, "row", state, delay)
          SELECT gen_random_uuid(), name, due_at, false, NULL, emits_values->>'machine', emits_values->'row', emits_values->>'state', emits_values->>'delay'
          FROM schedule WHERE emits_values->'row'->>'id' = '${id(1)}' AND emits_values->>'delay' = 'review';
        SELECT status FROM payment WHERE id = '${id(1)}';`), "expired");
      assertEquals(await sql(`SELECT count(*) FROM schedule WHERE emits_values->'row'->>'id' = '${id(1)}';`), "0");
    });
  } finally {
    const removed = await run("docker", ["rm", "-f", container]);
    if (!removed.ok) throw new Error(removed.err);
  }
} });

Deno.test("a delay the machine does not name, or one held as a date, is refused", async () => {
  for (const [delays, error] of [
    [`delays: {review: "window"}`, "waits after quick, which its delays does not name"],
    [`delays: {review: "due_on", quick: 1}`, "delay review reads due_on, a timestamp: a delay is a duration field, never a date"],
    [`delays: {review: "nothing", quick: 1}`, "delay review reads nothing, which Payment does not declare"],
  ]) {
    const r = await cue(["export", "-", "-e", "out"], delayed(delays));
    assertEquals(r.success, false, error);
    assertStringIncludes(r.stderr, error);
  }
});

// A page is a target with no ticker service: its one-user cluster sweeps the
// same schedule table on its own clock while it is open (mecha-browser's
// clock.ts). Timers were refused on pages before that clock existed; this is
// what lets them through.
Deno.test({ name: "a page's own clock fires a machine's deadline while it is open", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const source = program().replace('targets: []', 'targets: ["pages"]').replace('clocks: []', 'clocks: ["pages"]');
  const emitted = await cue(["export", "-", "-e", "{files: out, migrations: _cluster.state.migrations}", "--out", "json"], source);
  if (!emitted.success) throw new Error(emitted.stderr);
  const { files, migrations } = JSON.parse(emitted.stdout) as { files: Record<string, { text?: string; format: string; data: unknown }>; migrations: string[] };
  // As write.ts renders each.
  const text = (m: string) => files[m].text ?? (files[m].format === "type-sql" ? generateTypeSQL(files[m].data as { precision: number; scale: number }[]) : null) ?? (() => { throw new Error(`${m} has no text`); })();
  const repo = path.resolve(import.meta.dirname!, "../..");
  const browser = path.join(repo, "libraries/mecha/packages/mecha-browser");
  const dir = await Deno.makeTempDir({ prefix: "page-timers-" });
  try {
    // The page's scripts as the bundler orders them: mecha's tenancy floor,
    // then the app's migrations by name (bundle/edge-scripts.ts).
    const sql = [
      await Deno.readTextFile(path.join(repo, "libraries/mecha/services/database/rls/rls.sql")),
      // The one user the cluster mints at boot, which an app with auth declares.
      "CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);",
      ...[...migrations].sort((a, b) => path.basename(a) < path.basename(b) ? -1 : 1).map(text),
      // A row the page held when it was closed, its deadline already due.
      "INSERT INTO payment (id, status, total) VALUES ('00000000-0000-4000-8000-000000000001', 'pending', 10);",
    ];
    await Deno.writeTextFile(path.join(dir, "sql.json"), JSON.stringify(sql));
    await Deno.writeTextFile(path.join(dir, "page.ts"), `
      import { PGlite } from '@electric-sql/pglite'
      import { createCluster } from ${JSON.stringify(String(pathToFileURL(path.join(browser, "cluster.ts"))))}
      const db = await PGlite.create()
      const cluster = await createCluster({
        db, sql: JSON.parse(await Deno.readTextFile(Deno.args[0])), tables: ['payment'],
        log: console.error, fail: (e) => { throw e },
      })
      const row = async () => (await db.query("SELECT status || ',' || failure AS s FROM payment")).rows[0].s
      const deadline = Date.now() + 15000
      while ((await row()).startsWith('pending') && Date.now() < deadline) {
        await cluster.swept()
        await new Promise((r) => setTimeout(r, 100))
      }
      const ticks = (await db.query('SELECT caller, state, delay FROM public.machine_timer_tick')).rows
      const left = (await db.query("SELECT count(*)::int AS n FROM public.schedule WHERE emits_entity = 'machine_timer_tick'")).rows[0].n
      console.log(JSON.stringify({ row: await row(), ticks, left }))
      await cluster.stop()
      await db.close()
    `);
    const ran = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-config", "--import-map", path.join(browser, "cluster.deno.json"), "--lock", path.join(browser, "deno.lock"), "--frozen", path.join(dir, "page.ts"), path.join(dir, "sql.json")],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    assertEquals(ran.success, true, "the page did not boot");
    const seen = JSON.parse(new TextDecoder().decode(ran.stdout));
    assertEquals(seen.row, "expired,IETN");
    assertEquals(seen.ticks, [{ caller: "page", state: "pending", delay: "0" }]);
    // Leaving the state cancelled the other deadline the visit armed.
    assertEquals(seen.left, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
} });

// Under ?clock=manual the page's cluster runs on the terminal's held clock
// (bundle/page.ts), and its PGlite reads the held instant through the
// machine's clock (bundle/held-clock.ts): a deadline arms and fires on time
// the driver advances, and no real time passes between the steps.
Deno.test({ name: "a page under a held clock moves a machine's deadline only when the clock passes it", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const source = paymentProgram({ machine: `
    pending: after: "5000": "expired"
    expired: type: "final"
  ` }).replace(/\n    effects: charge: \{[\s\S]*?\n    }\n/, "\n").replace('targets: []', 'targets: ["pages"]').replace('clocks: []', 'clocks: ["pages"]');
  const emitted = await cue(["export", "-", "-e", "{files: out, migrations: _cluster.state.migrations}", "--out", "json"], source);
  if (!emitted.success) throw new Error(emitted.stderr);
  const { files, migrations } = JSON.parse(emitted.stdout) as { files: Record<string, { text?: string; format: string; data: unknown }>; migrations: string[] };
  const text = (m: string) => files[m].text ?? (files[m].format === "type-sql" ? generateTypeSQL(files[m].data as { precision: number; scale: number }[]) : null) ?? (() => { throw new Error(`${m} has no text`); })();
  const repo = path.resolve(import.meta.dirname!, "../..");
  const browser = path.join(repo, "libraries/mecha/packages/mecha-browser");
  const dir = await Deno.makeTempDir({ prefix: "page-held-timers-" });
  try {
    const sql = heldClock([
      await Deno.readTextFile(path.join(repo, "libraries/mecha/services/database/rls/rls.sql")),
      "CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);",
      ...[...migrations].sort((a, b) => path.basename(a) < path.basename(b) ? -1 : 1).map(text),
      // A row entering the timed state as the page boots, at the held epoch.
      "INSERT INTO payment (id, status, total, failure) VALUES ('00000000-0000-4000-8000-000000000001', 'pending', 10, '');",
    ]);
    await Deno.writeTextFile(path.join(dir, "sql.json"), JSON.stringify(sql));
    await Deno.writeTextFile(path.join(dir, "page.ts"), `
      import { PGlite } from '@electric-sql/pglite'
      import { createCluster } from ${JSON.stringify(String(pathToFileURL(path.join(browser, "cluster.ts"))))}
      // The terminal's held clock as the page hands it over, at ?epoch.
      let now = Date.parse('2026-01-01T00:00:00Z')
      const waits = new Set()
      const time = {
        now: () => now,
        after: (ms, fire) => { const w = { at: now + ms, fire }; waits.add(w); return () => waits.delete(w) },
      }
      const advance = (ms) => { now += ms; for (const w of [...waits]) if (w.at <= now) { waits.delete(w); w.fire() } }
      const db = await PGlite.create()
      const cluster = await createCluster({
        db, sql: JSON.parse(await Deno.readTextFile(Deno.args[0])), tables: ['payment'], time,
        log: console.error, fail: (e) => { throw e },
      })
      const status = async () => (await db.query('SELECT status FROM payment')).rows[0].status
      const due = async () => (await db.query("SELECT due_at FROM public.schedule WHERE emits_entity = 'machine_timer_tick'")).rows.map((r) => r.due_at.toISOString())
      await cluster.swept()
      const seen = { armed: await due(), boot: await status() }
      advance(4999)
      await cluster.swept()
      seen.before = await status()
      advance(1)
      await cluster.swept()
      seen.after = await status()
      seen.ticks = (await db.query('SELECT tick_at FROM public.machine_timer_tick')).rows.map((r) => r.tick_at.toISOString())
      console.log(JSON.stringify(seen))
      await cluster.stop()
      await db.close()
    `);
    const ran = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-config", "--import-map", path.join(browser, "cluster.deno.json"), "--lock", path.join(browser, "deno.lock"), "--frozen", path.join(dir, "page.ts"), path.join(dir, "sql.json")],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    assertEquals(ran.success, true, "the page did not boot");
    assertEquals(JSON.parse(new TextDecoder().decode(ran.stdout)), {
      armed: ["2026-01-01T00:00:05.000Z"],
      boot: "pending",
      before: "pending",
      after: "expired",
      ticks: ["2026-01-01T00:00:05.000Z"],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
} });
