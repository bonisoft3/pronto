import assert from "node:assert/strict";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";
import { pgTest, postgres } from "../../libraries/mecha/services/compute/pg-test.ts";

pgTest("Pronto's emitted initialization and role reconciliation respect external ownership", async () => {
  await using pg = await postgres();
  const run = async (sql: string, external = false) => {
    const child = new Deno.Command("psql", {
      args: [pg.url, "-XqtA", "-v", "ON_ERROR_STOP=1"],
      env: { PGOPTIONS: `-c mecha.roles=${external ? "external" : "framework"}` },
      stdin: "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(sql));
    await writer.close();
    const out = await child.output();
    return { ok: out.success, out: new TextDecoder().decode(out.stdout), err: new TextDecoder().decode(out.stderr) };
  };
  const must = async (sql: string, external = false) => {
    const r = await run(sql, external);
    assert(r.ok, r.err);
    return r.out;
  };
  const program = paymentProgram().replace("    effects: charge:", '    tokenRoles: select: note: "a keyword token role"\n    effects: charge:');
  const files = await emitFiles(program);
  const roles = files["services/database/migrations/001_roles.sql"].text;
  await must(roles);
  const snapshot = "SELECT jsonb_agg(to_jsonb(r) ORDER BY oid) FROM pg_authid r; SELECT jsonb_agg(to_jsonb(m) ORDER BY oid) FROM pg_auth_members m; SELECT jsonb_agg(to_jsonb(s) ORDER BY setdatabase, setrole) FROM pg_db_role_setting s;";
  let before = await must(snapshot);
  await must(roles, true);
  assert.equal(await must(snapshot), before);
  await must('ALTER ROLE "select" LOGIN;');
  before = await must(snapshot);
  let r = await run(roles, true);
  assert.equal(r.ok, false);
  assert.match(r.err, /select.*rolcanlogin/);
  assert.equal(await must(snapshot), before);
  await must('ALTER ROLE "select" NOLOGIN;');
  const reconciled = await cue(["export", "-", "-e", "_cluster.state.reconcile.roles", "--out", "text"], program);
  assert(reconciled.success, reconciled.stderr);
  before = await must(snapshot);
  await must(reconciled.stdout, true);
  assert.equal(await must(snapshot), before);
  await must('ALTER ROLE "select" SET statement_timeout = \'99s\';');
  before = await must(snapshot);
  r = await run(reconciled.stdout, true);
  assert.equal(r.ok, false);
  assert.match(r.err, /select.*statement_timeout/);
  assert.equal(await must(snapshot), before);
});
