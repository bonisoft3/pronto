// A database provisioned by its owner against the access model (state.provisioning:
// "checked"): the check 001_roles.sql holds refuses what differs, with the statements
// that fix it, and passes what pronto's own generated provisioning leaves.
import assert from "node:assert/strict";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const text = new TextDecoder();

type Run = { ok: boolean; out: string; err: string };
type Execute = (user: string, sql: string) => Promise<Run>;

// BEGIN postgres harness: the only part that depends on where PostgreSQL runs.
async function docker(args: string[], sql?: string): Promise<Run> {
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

// One cluster per test: roles are the cluster's, so a test that starts from none needs its own.
async function withPostgres(body: (execute: Execute) => Promise<void>) {
  const name = `access-check-${crypto.randomUUID().slice(0, 8)}`;
  const started = await docker(["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=test", POSTGRES]);
  assert(started.ok, started.err);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if ((await docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"])).ok) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, "PostgreSQL did not become ready");
    await body((user, sql) => docker(["exec", "-i", name, "psql", "-h", "127.0.0.1", "-U", user, "-XqtA", "-v", "ON_ERROR_STOP=1"], sql));
  } finally {
    const removed = await docker(["rm", "-f", name]);
    assert(removed.ok, removed.err);
  }
}
// END postgres harness

const checked = (program: string) => program.replace("  state: {\n", `  state: {\n    provisioning: "checked"\n`);
const declaring = (program: string, roles: string) => program.replace("    effects: charge:", `    tokenRoles: ${roles}\n    effects: charge:`);
const sql = (files: Record<string, { text: string }>, n: string) => files[`services/database/migrations/${n}.sql`].text;
// The bounds are the resilience contract's, not this model's.
const unbound = (t: string) => t.replace(/ = '[^']*';/g, " = '_';");
const lines = (t: string) => t.split("\n").filter((l) => l != "");

// What the unprivileged login that migrates holds, as the check's last phase requires.
const MIGRATOR = `CREATE ROLE migrator LOGIN BYPASSRLS NOCREATEROLE NOSUPERUSER;
GRANT CREATE ON DATABASE postgres TO migrator;
GRANT USAGE, CREATE ON SCHEMA public TO migrator;`;

async function must(execute: Execute, user: string, source: string) {
  const result = await execute(user, source);
  assert(result.ok, result.err);
  return result.out;
}

// The statements the failed check names, which the error carries in DETAIL.
async function refused(execute: Execute, user: string, source: string) {
  const result = await execute(user, source);
  assert.equal(result.ok, false, "the check passed where it should have refused");
  assert.match(result.err, /the database differs from the access model this release declares/);
  assert.match(result.err, /HINT:  The database's owner runs the statements in DETAIL/);
  const detail = result.err.match(/DETAIL:  ([\s\S]*?)\nHINT:/);
  assert(detail, result.err);
  return lines(detail[1]);
}

Deno.test("an empty database is refused, and the statements in the error provision it", async () => {
  const files = await emitFiles(checked(paymentProgram()));
  const check = sql(files, "001_roles");
  const provision = files["services/database/provision.sql"].text;
  await withPostgres(async (execute) => {
    await must(execute, "postgres", MIGRATOR);
    const fixes = await refused(execute, "migrator", check);
    assert.deepEqual(fixes.map((l) => unbound(l)), [
      "CREATE ROLE anon WITH NOLOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;",
      "CREATE ROLE service WITH NOLOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS NOREPLICATION;",
      "CREATE ROLE electric WITH LOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS REPLICATION;",
      "CREATE ROLE authenticator WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;",
      "GRANT anon TO authenticator;",
      "GRANT service TO authenticator;",
      "ALTER ROLE anon SET statement_timeout = '_';",
      "ALTER ROLE anon SET lock_timeout = '_';",
      "ALTER ROLE anon SET idle_in_transaction_session_timeout = '_';",
      "ALTER ROLE service SET statement_timeout = '_';",
      "ALTER ROLE service SET lock_timeout = '_';",
      "ALTER ROLE service SET idle_in_transaction_session_timeout = '_';",
      "GRANT USAGE ON SCHEMA public TO anon;",
      "GRANT USAGE ON SCHEMA public TO service;",
      "GRANT USAGE ON SCHEMA public TO electric;",
    ]);
    assert.deepEqual(fixes, lines(provision));
    await must(execute, "postgres", fixes.join("\n"));
    await must(execute, "migrator", check);
  });
});

Deno.test("a keyword-named role is refused, quoted in its fixes, and provisioned by them", async () => {
  const files = await emitFiles(checked(declaring(paymentProgram(), `{select: {note: "x"}}`)));
  const check = sql(files, "001_roles");
  await withPostgres(async (execute) => {
    await must(execute, "postgres", MIGRATOR);
    const fixes = await refused(execute, "migrator", check);
    assert(fixes.includes(`CREATE ROLE "select" WITH NOLOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;`), fixes.join("\n"));
    assert(fixes.includes(`GRANT "select" TO authenticator;`), fixes.join("\n"));
    assert(fixes.some((l) => l.startsWith(`ALTER ROLE "select" SET statement_timeout = `)), fixes.join("\n"));
    assert.deepEqual(fixes, lines(files["services/database/provision.sql"].text));
    await must(execute, "postgres", fixes.join("\n"));
    await must(execute, "migrator", check);
  });
});

Deno.test("what pronto's generated provisioning leaves passes the check, and a drifted database is refused with the statements that fix it", async () => {
  const generated = await emitFiles(paymentProgram());
  const check = sql(await emitFiles(checked(paymentProgram())), "001_roles");
  await withPostgres(async (execute) => {
    await must(execute, "postgres", MIGRATOR);
    // The fixed point of the two renderings: a check stricter than what pronto
    // itself provisions (PUBLIC's USAGE on public, for one) fails here.
    await must(execute, "postgres", sql(generated, "001_roles") + sql(generated, "002_grants"));
    await must(execute, "migrator", check);

    await must(execute, "postgres", `ALTER ROLE electric NOBYPASSRLS; REVOKE anon FROM authenticator; ALTER ROLE service SET lock_timeout = '0';
      GRANT pg_read_all_data TO authenticator; GRANT CREATE ON SCHEMA public TO anon;
      ALTER ROLE anon IN DATABASE postgres SET statement_timeout = '0';`);
    const fixes = await refused(execute, "migrator", check);
    assert.deepEqual(fixes.map((l) => unbound(l)), [
      "ALTER ROLE electric WITH LOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS REPLICATION;",
      "GRANT anon TO authenticator;",
      "REVOKE pg_read_all_data FROM authenticator GRANTED BY postgres;",
      "ALTER ROLE service SET lock_timeout = '_';",
      "ALTER ROLE anon IN DATABASE postgres RESET statement_timeout;",
      "REVOKE CREATE ON SCHEMA public FROM anon;",
    ]);
    await must(execute, "postgres", fixes.join("\n"));
    await must(execute, "migrator", check);
  });
});

Deno.test("a CREATE on the schema that a non-owner granted is revoked as its grantor", async () => {
  const generated = await emitFiles(paymentProgram());
  const check = sql(await emitFiles(checked(paymentProgram())), "001_roles");
  await withPostgres(async (execute) => {
    await must(execute, "postgres", MIGRATOR);
    await must(execute, "postgres", sql(generated, "001_roles") + sql(generated, "002_grants"));
    await must(execute, "postgres", "GRANT CREATE ON SCHEMA public TO migrator WITH GRANT OPTION; SET ROLE migrator; GRANT CREATE ON SCHEMA public TO anon; RESET ROLE;");
    const fixes = await refused(execute, "migrator", check);
    assert.deepEqual(fixes, ["SET ROLE migrator; REVOKE CREATE ON SCHEMA public FROM anon; RESET ROLE;"]);
    await must(execute, "postgres", fixes.join("\n"));
    await must(execute, "migrator", check);
  });
});

Deno.test("the login that migrates is held to what its migrations need", async () => {
  const generated = await emitFiles(paymentProgram());
  const check = sql(await emitFiles(checked(paymentProgram())), "001_roles");
  await withPostgres(async (execute) => {
    await must(execute, "postgres", MIGRATOR);
    await must(execute, "postgres", sql(generated, "001_roles") + sql(generated, "002_grants"));
    await must(execute, "postgres", "ALTER ROLE migrator NOBYPASSRLS; REVOKE CREATE ON SCHEMA public FROM migrator;");
    const fixes = await refused(execute, "migrator", check);
    assert.deepEqual(fixes, [
      "GRANT USAGE, CREATE ON SCHEMA public TO migrator;",
      "ALTER ROLE migrator BYPASSRLS;",
    ]);
    await must(execute, "postgres", fixes.join("\n"));
    await must(execute, "migrator", check);
  });
});

Deno.test("the cluster's reconcile checks first, then lists the declared token roles it did not create", async () => {
  const program = checked(declaring(paymentProgram(), `{residual_bot: {note: "x"}}`));
  const res = await cue(["export", "-", "-e", "roles", "--out", "json"], `${program}\nroles: _cluster.state.reconcile.roles\n`);
  assert(res.success, res.stderr);
  const roles: string = JSON.parse(res.stdout);
  const provision = (await emitFiles(program))["services/database/provision.sql"].text;
  await withPostgres(async (execute) => {
    await must(execute, "postgres", MIGRATOR);
    assert((await refused(execute, "migrator", roles)).includes("CREATE ROLE \"residual_bot\" WITH NOLOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;"));
    await must(execute, "postgres", provision);
    // The unprivileged login that migrates runs it whole: it creates no role and grants none.
    await must(execute, "migrator", roles);
    assert.equal(await must(execute, "migrator", "SELECT role_name FROM mecha.token_role ORDER BY 1;"), "residual_bot");
    assert.equal(await must(execute, "migrator", "SELECT pg_has_role('authenticator', 'residual_bot', 'MEMBER');"), "t");
  });
});
