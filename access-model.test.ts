// The database access model a program resolves to (the emit's `access`), which 001_roles.sql
// and 002_grants.sql render: the roles, authenticator's reach, their bounds and the grants.
import { assertEquals, assertMatch, assertNotMatch, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram, readProgram } from "./effects-fixtures.ts";

const EMIT = "(pronto.#emit & {code: app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build})";

async function access(program: string) {
  const res = await cue(["export", "-", "-e", "model", "--out", "json"], `${program}\nmodel: ${EMIT}.access\n`);
  if (!res.success) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

// Whether the emit has an `access` field at all: asking for an absent one fails.
async function exposed(program: string): Promise<boolean> {
  const res = await cue(["export", "-", "-e", "model", "--out", "json"], `${program}\nmodel: ${EMIT}.access\n`);
  return res.success;
}

// The block of `marker`'s braces, and what follows it, removed.
function cut(p: string, marker: string): string {
  const i = p.indexOf(marker);
  let depth = 0, j = p.indexOf("{", i);
  for (; ; j++) {
    if (p[j] == "{") depth++;
    if (p[j] == "}" && --depth == 0) break;
  }
  return p.slice(0, i) + p.slice(j + 1);
}

const anonOnly = () => cut(cut(paymentProgram(), "    mecha: rows:"), "    effects: charge:");
const declaring = (roles: string) => paymentProgram().replace("    effects: charge:", `    tokenRoles: ${roles}\n    effects: charge:`);
const checked = (p: string) => p.replace("  state: {\n", `  state: {\n    provisioning: "checked"\n`);

const dml = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const attrs = { superuser: false, createrole: false, createdb: false };
const sql = (files: Record<string, { text: string }>, n: string) => files[`services/database/migrations/${n}.sql`].text;
// The bounds are the resilience contract's, not this model's.
const unbound = (t: string) => t.replace(/ = '[^']*';/g, " = '_';");

const anon = { kind: "request", login: false, inherit: true, ...attrs, bypassrls: false, replication: false, token: true, declared: false, memberOf: [] };
const electric = { kind: "sync", login: true, inherit: true, ...attrs, bypassrls: true, replication: true, token: false, declared: false, memberOf: [], settings: {} };

Deno.test("a served app without auth has anon and service, which authenticator reaches, and electric, which it does not", async () => {
  const a = await access(paymentProgram());
  assertEquals(a.order, ["anon", "service", "electric", "authenticator"]);
  assertEquals(Object.keys(a.roles).sort(), ["anon", "authenticator", "electric", "service"]);
  assertEquals({ ...a.roles.anon, settings: undefined }, { ...anon, settings: undefined });
  assertEquals({ ...a.roles.service, settings: undefined }, { ...anon, bypassrls: true, settings: undefined });
  assertEquals(a.roles.electric, electric);
  assertEquals(a.roles.authenticator, { kind: "authenticator", login: true, inherit: false, ...attrs, bypassrls: false, replication: false, token: false, declared: false, memberOf: ["anon", "service"], settings: {} });
  assertEquals(a.schemaGrants, [{ to: ["anon", "service"], privileges: ["USAGE"] }, { to: ["electric"], privileges: ["USAGE"] }]);
  assertEquals(a.tableGrants, [{ to: ["anon", "service"], privileges: dml }, { to: ["electric"], privileges: ["SELECT"] }]);
  assertEquals(a.defaultPrivileges, a.tableGrants);
});

Deno.test("with no service, anon alone stands beside electric", async () => {
  const a = await access(anonOnly());
  assertEquals(a.order, ["anon", "electric", "authenticator"]);
  assertEquals(a.roles.authenticator.memberOf, ["anon"]);
  assertEquals(a.schemaGrants, [{ to: ["anon"], privileges: ["USAGE"] }, { to: ["electric"], privileges: ["USAGE"] }]);
  assertEquals(a.tableGrants, [{ to: ["anon"], privileges: dml }, { to: ["electric"], privileges: ["SELECT"] }]);
  assertEquals(a.publishedGrants, [{ to: ["anon"], privileges: dml }]);
});

Deno.test("auth adds app_user, and anon may connect but is granted no table by 002, only by 008 once something is synced", async () => {
  const program = readProgram();
  const a = await access(program);
  assertEquals(a.order, ["anon", "app_user", "service", "electric", "authenticator"]);
  assertEquals(a.roles.authenticator.memberOf, ["anon", "app_user", "service"]);
  assertEquals(a.schemaGrants[0], { to: ["anon", "app_user", "service"], privileges: ["USAGE"] });
  assertEquals(a.tableGrants[0], { to: ["app_user", "service"], privileges: dml });
  assertEquals(a.publishedGrants, [{ to: ["anon"], privileges: dml }]);
  const files = await emitFiles(program);
  assertEquals(sql(files, "002_grants"), `GRANT USAGE ON SCHEMA public TO anon, app_user, service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, service;
`);
  assertStringIncludes(sql(files, "008_publication"), "-- tier: any\nGRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;\n");
});

Deno.test("a declared token role is guarded, held to the client's bounds and reachable by authenticator", async () => {
  const a = await access(declaring(`{residual_bot: {note: "x"}}`));
  assertEquals(a.order, ["anon", "service", "electric", "residual_bot", "authenticator"]);
  assertEquals(a.roles.authenticator.memberOf, ["anon", "service", "residual_bot"]);
  assertEquals(a.roles.residual_bot, { ...anon, declared: true, settings: a.roles.anon.settings });
});

Deno.test("a browser-only app has no database, so no model of one", async () => {
  assertEquals(await exposed(paymentProgram()), true);
  assertEquals(await exposed(anonOnly().replace('durability: "server"', 'durability: "tab"')), false);
});

Deno.test("001 and 002 state the model: a served app without auth", async () => {
  const files = await emitFiles(paymentProgram());
  assertEquals(unbound(sql(files, "001_roles")), `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service') THEN
    CREATE ROLE service NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'electric') THEN
    CREATE ROLE electric NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT;
  END IF;
END $$;

ALTER ROLE authenticator LOGIN;
GRANT anon, service TO authenticator;

ALTER ROLE service BYPASSRLS;

ALTER ROLE electric BYPASSRLS REPLICATION LOGIN;
GRANT USAGE ON SCHEMA public TO electric;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;

-- Finite machine bounds: statement, lock, and idle timeouts.
ALTER ROLE anon SET statement_timeout = '_';
ALTER ROLE anon SET lock_timeout = '_';
ALTER ROLE anon SET idle_in_transaction_session_timeout = '_';
ALTER ROLE service SET statement_timeout = '_';
ALTER ROLE service SET lock_timeout = '_';
ALTER ROLE service SET idle_in_transaction_session_timeout = '_';
`);
  assertEquals(sql(files, "002_grants"), `GRANT USAGE ON SCHEMA public TO anon, service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, service;
`);
});

Deno.test("001 and 002 state the model: anon alone", async () => {
  const files = await emitFiles(anonOnly());
  assertEquals(unbound(sql(files, "001_roles")), `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'electric') THEN
    CREATE ROLE electric NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT;
  END IF;
END $$;

ALTER ROLE authenticator LOGIN;
GRANT anon TO authenticator;

ALTER ROLE electric BYPASSRLS REPLICATION LOGIN;
GRANT USAGE ON SCHEMA public TO electric;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;

-- Finite machine bounds: statement, lock, and idle timeouts.
ALTER ROLE anon SET statement_timeout = '_';
ALTER ROLE anon SET lock_timeout = '_';
ALTER ROLE anon SET idle_in_transaction_session_timeout = '_';
`);
  assertEquals(sql(files, "002_grants"), `GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon;
`);
});

Deno.test("a role named for a keyword is quoted wherever 001 prints it", async () => {
  const files = await emitFiles(declaring(`{select: {note: "x"}}`));
  const roles = sql(files, "001_roles");
  assertStringIncludes(roles, `    CREATE ROLE "select" NOLOGIN;\n`);
  assertStringIncludes(roles, `GRANT anon, service, "select" TO authenticator;\n`);
  assertEquals(roles.match(/^ALTER ROLE "select" SET (\w+)/gm), [
    `ALTER ROLE "select" SET statement_timeout`,
    `ALTER ROLE "select" SET lock_timeout`,
    `ALTER ROLE "select" SET idle_in_transaction_session_timeout`,
  ]);
  assertMatch(roles, /ALTER ROLE service SET statement_timeout/);
});

// The check and what follows it in 001_roles.sql, which are the owner's statements and pronto's.
const END = "END $access$;\n";
const split = (t: string) => { const i = t.indexOf(END) + END.length; return { check: t.slice(0, i), rest: t.slice(i) }; };

Deno.test("checked provisioning keeps the model", async () => {
  for (const p of [paymentProgram(), anonOnly(), readProgram(), declaring(`{residual_bot: {note: "x"}}`)]) {
    assertEquals(await access(checked(p)), await access(p));
  }
});

Deno.test("checked 001 checks the database and creates no role, and 002 holds the table grants alone", async () => {
  const files = await emitFiles(checked(paymentProgram()));
  const { check, rest } = split(sql(files, "001_roles"));
  assertMatch(check, /^-- The database against its access model \(state.provisioning: "checked"\)/);
  assertStringIncludes(check, "DO $access$\nDECLARE\n");
  assertStringIncludes(check, "RAISE EXCEPTION 'the database differs from the access model this release declares'");
  // The statements that fix a difference are the check's data; none runs.
  assertNotMatch(check, /^\s*(CREATE|ALTER) ROLE|^\s*GRANT /m);
  assertStringIncludes(check, `'CREATE ROLE electric WITH LOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS REPLICATION;'`);
  assertStringIncludes(check, `'GRANT anon TO authenticator;'`);
  assertEquals(rest, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;
`);
  assertEquals(sql(files, "002_grants"), `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, service;
`);
});

Deno.test("checked provisioning emits the owner's script, and generated provisioning does not", async () => {
  const files = await emitFiles(checked(paymentProgram()));
  assertEquals(unbound(files["services/database/provision.sql"].text), `CREATE ROLE anon WITH NOLOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
CREATE ROLE service WITH NOLOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS NOREPLICATION;
CREATE ROLE electric WITH LOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS REPLICATION;
CREATE ROLE authenticator WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
GRANT anon TO authenticator;
GRANT service TO authenticator;
ALTER ROLE anon SET statement_timeout = '_';
ALTER ROLE anon SET lock_timeout = '_';
ALTER ROLE anon SET idle_in_transaction_session_timeout = '_';
ALTER ROLE service SET statement_timeout = '_';
ALTER ROLE service SET lock_timeout = '_';
ALTER ROLE service SET idle_in_transaction_session_timeout = '_';
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO service;
GRANT USAGE ON SCHEMA public TO electric;
`);
  assertEquals((await emitFiles(paymentProgram()))["services/database/provision.sql"], undefined);
});

Deno.test("a keyword-named role is quoted in the check and its fixes", async () => {
  const files = await emitFiles(checked(declaring(`{select: {note: "x"}}`)));
  const { check } = split(sql(files, "001_roles"));
  assertStringIncludes(check, `'CREATE ROLE "select" WITH NOLOGIN INHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;'`);
  assertStringIncludes(check, `'GRANT "select" TO authenticator;'`);
  assertMatch(check, /'ALTER ROLE "select" SET statement_timeout = ''\d+s'';'/);
  assertMatch(unbound(files["services/database/provision.sql"].text), /^GRANT "select" TO authenticator;$/m);
});

async function reconcileRoles(program: string): Promise<string> {
  const res = await cue(["export", "-", "-e", "roles", "--out", "json"], `${program}\nroles: _cluster.state.reconcile.roles\n`);
  assertEquals(res.success, true, res.stderr);
  return JSON.parse(res.stdout);
}

Deno.test("the cluster checks before the ledger on every release, and restates only what the owner did not provision", async () => {
  // No token role and no migration: the check alone rides the migrate step.
  const plain = await reconcileRoles(checked(anonOnly()));
  assertEquals(typeof plain, "string");
  assertEquals(plain.startsWith(split(sql(await emitFiles(checked(anonOnly())), "001_roles")).check), true);

  const declared = checked(declaring(`{residual_bot: {note: "x"}}`));
  const roles = await reconcileRoles(declared);
  const { check, rest } = split(roles);
  assertEquals(check, split(sql(await emitFiles(declared), "001_roles")).check);
  assertStringIncludes(rest, "INSERT INTO mecha.token_role VALUES ('residual_bot') ON CONFLICT DO NOTHING;");
  assertNotMatch(rest, /CREATE ROLE|TO authenticator;|ALTER ROLE|REVOKE %I FROM authenticator/);
  // Generated provisioning is untouched: it creates and grants.
  const generated = await reconcileRoles(declaring(`{residual_bot: {note: "x"}}`));
  assertStringIncludes(generated, `CREATE ROLE "residual_bot" NOLOGIN;`);
  assertStringIncludes(generated, `GRANT "residual_bot" TO authenticator;`);
});

Deno.test("checked provisioning needs a server tier", async () => {
  const whole = (program: string) => cue(["vet", "-c", "-"], `${program}\n_whole: ${EMIT}\n`);
  const tab = checked(anonOnly().replace('durability: "server"', 'durability: "tab"'));
  const refused = await whole(tab);
  assertEquals(refused.success, false);
  assertStringIncludes(refused.stderr, "provisioning: checked needs the app's database, and the app has no server tier");
  // A served app is refused for other reasons (_gated), never for this one.
  assertNotMatch((await whole(checked(anonOnly()))).stderr, /provisioning: checked/);
});
