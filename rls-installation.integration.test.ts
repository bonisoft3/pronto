import assert from "node:assert/strict";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const text = new TextDecoder();

async function docker(args: string[], sql?: string) {
  const child = new Deno.Command("docker", {
    args, stdin: sql === undefined ? "null" : "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  if (sql !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(sql));
    await writer.close();
  }
  const result = await child.output();
  return { ok: result.success, out: text.decode(result.stdout).trim(), err: text.decode(result.stderr) };
}

Deno.test("table creation fails closed before policies and rolls back if enabling RLS fails", async () => {
  const program = paymentProgram()
    .replace('table: "payment"', 'table: "payment"\naccess: {scope: "public", write: true}')
    .replace('{name: "total", type: "decimal", precision: 12, scale: 2}', '{name: "total", type: "int32"}')
    .replace('capabilities: {hatches:', 'capabilities: {auth: {required: false, service: "/auth"}, hatches:');
  const files = await emitFiles(program);
  const sql = (name: string) => files[`services/database/migrations/${name}.sql`].text;
  const floor = await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url));
  const name = `rls-install-${crypto.randomUUID().slice(0, 8)}`;
  const started = await docker(["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=test", POSTGRES]);
  assert(started.ok, started.err);
  // Feed psql a script: -c would implicitly transact multiple statements and
  // hide the exposure present in runners that commit statement by statement.
  const execute = (source: string) => docker(["exec", "-i", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-XqtA", "-v", "ON_ERROR_STOP=1"], source);
  const must = async (source: string) => {
    const result = await execute(source);
    assert(result.ok, result.err);
    return result.out;
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if ((await docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"])).ok) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, "PostgreSQL did not become ready");
    await must(sql("001_roles") + sql("002_grants") + floor);
    await must(`CREATE FUNCTION reject_rls() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected RLS failure'; END $$;
      CREATE EVENT TRIGGER reject_rls ON ddl_command_start WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION reject_rls();`);
    const failed = await execute(sql("005_create_tables"));
    assert.equal(failed.ok, false);
    assert.match(failed.err, /injected RLS failure/);
    assert.equal(await must("SELECT to_regclass('payment') IS NULL;"), "t");
    await must("DROP EVENT TRIGGER reject_rls; DROP FUNCTION reject_rls();");

    await must(sql("005_create_tables"));
    await must("INSERT INTO payment (id,total,failure) VALUES ('00000000-0000-0000-0000-000000000001',1,'');");
    const reader = "SET ROLE app_user; SET app.scopes = 'public:';\n";
    assert.equal(await must(reader + "SELECT count(*) FROM payment;"), "0");
    const insert = "INSERT INTO payment (id,total,failure) VALUES ('00000000-0000-0000-0000-000000000002',2,'');";
    const denied = await execute(reader + insert);
    assert.equal(denied.ok, false);
    assert.match(denied.err, /row-level security/);
    await must(reader + "UPDATE payment SET total=99; DELETE FROM payment;");
    assert.equal(await must("SELECT count(*),sum(total) FROM payment;"), "1|1");

    await must(sql("006_policies"));
    assert.equal(await must(reader + "SELECT count(*) FROM payment;"), "1");
    await must(reader + insert);
    await must(sql("005_create_tables") + sql("006_policies"));
    assert.equal(await must(reader + "SELECT count(*),sum(total) FROM payment;"), "2|3");
  } finally {
    const removed = await docker(["rm", "-f", name]);
    assert(removed.ok, removed.err);
  }
});
