// The database access model a program resolves to (the emit's `access`), which 001_roles.sql
// and 002_grants.sql render: the roles, authenticator's reach, their bounds and the grants.
import { assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1.0.11";
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
