import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";

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
    [program().replace('targets: []', 'targets: ["pages"]'), "server timers cannot target pages"],
    [program().replace('targets: []', 'targets: ["aws"]'), "server timers require a declared clock"],
  ]) {
    const r = await cue(["export", "-", "-e", "out"], source);
    assertEquals(r.success, false, error);
    assertStringIncludes(r.stderr, error);
  }
});
