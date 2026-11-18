// The database access model a program resolves to (E._access), which 001_roles.sql
// and 002_grants.sql render: the roles, authenticator's reach, their bounds and the grants.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram, readProgram } from "./effects-fixtures.ts";

async function access(program: string) {
  const res = await cue(["export", "-", "-e", "model", "--out", "json"], `${program}\nmodel: (pronto.#emit & {code: app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}).access\n`);
  if (!res.success) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

const dml = ["SELECT", "INSERT", "UPDATE", "DELETE"];

Deno.test("a served app without auth has anon and service, which authenticator reaches, and electric, which it does not", async () => {
  const a = await access(paymentProgram());
  assertEquals(a.order, ["anon", "service", "electric", "authenticator"]);
  assertEquals(a.roles.authenticator.memberOf, ["anon", "service"]);
  assertEquals(a.roles.authenticator, { ...a.roles.authenticator, login: true, inherit: false, token: false });
  assertEquals(a.roles.service.bypassrls, true);
  assertEquals(a.roles.anon.bypassrls, false);
  assertEquals(a.roles.electric, { login: true, inherit: true, bypassrls: true, replication: true, token: false, declared: false, memberOf: [], settings: {} });
  assertEquals(a.roles.anon.settings.statement_timeout !== a.roles.service.settings.statement_timeout, true);
  assertEquals(a.schemaGrants, [{ to: ["anon", "service"], privileges: ["USAGE"] }, { to: ["electric"], privileges: ["USAGE"] }]);
  assertEquals(a.tableGrants, [{ to: ["anon", "service"], privileges: dml }, { to: ["electric"], privileges: ["SELECT"] }]);
  assertEquals(a.defaultPrivileges, a.tableGrants);
});

Deno.test("auth adds app_user, and anon alone may connect without touching a table", async () => {
  const a = await access(readProgram());
  assertEquals(a.roles.authenticator.memberOf, ["anon", "app_user", "service"]);
  assertEquals(a.schemaGrants[0], { to: ["anon", "app_user", "service"], privileges: ["USAGE"] });
  assertEquals(a.tableGrants[0], { to: ["app_user", "service"], privileges: dml });
});

Deno.test("a declared token role is guarded, held to the client's bounds and reachable by authenticator", async () => {
  const program = paymentProgram().replace("    effects: charge:", `    tokenRoles: {residual_bot: {note: "x"}}\n    effects: charge:`);
  const a = await access(program);
  assertEquals(a.order, ["anon", "service", "electric", "residual_bot", "authenticator"]);
  assertEquals(a.roles.authenticator.memberOf, ["anon", "service", "residual_bot"]);
  assertEquals(a.roles.residual_bot, { ...a.roles.residual_bot, declared: true, token: true, login: false, bypassrls: false, replication: false });
  assertEquals(a.roles.residual_bot.settings, a.roles.anon.settings);
});
