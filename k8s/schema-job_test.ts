// The Kubernetes schema job's replay of a built database (k8s/schema/k8s.cue), asserted on the script
// the schema states: k8s/release_test.nu renders it, and this holds the one step that must stay ahead
// of the replays without touching that suite's exact replay line.
import { assert, assertStringIncludes } from "jsr:@std/assert@1.0.11";

const script = await Deno.readTextFile(new URL("./schema/k8s.cue", import.meta.url));

Deno.test("a database built before the airlock's job key gets it, idempotently, ahead of the replays", () => {
  // initdb places 013_airlock_job_key.sql on a fresh volume only; the interpreters (010) and an app's
  // migrations enqueue through airlock.job_key, which the next effect-state write needs.
  const defined = script.indexOf("jobkey() {");
  const loop = script.indexOf("for step in 005_create_tables.sql");
  assert(defined > 0 && defined < loop, "the job key's function is defined before the replays");
  assertStringIncludes(script, "ls [0-7][0-9][0-9]_airlock_job_key.sql 2>/dev/null || true");
  // An assignment, so a psql that fails stops the job under set -e rather than reading as "no".
  assertStringIncludes(script, `has_airlock=$(psql -XtAc "SELECT to_regnamespace('airlock') IS NOT NULL")\n\t\t\t\t\t  if [ "$has_airlock" = t ]; then jobkey; fi`);
  assert(script.indexOf("then jobkey; fi") < loop, "applied before the replays where the airlock's schema stands");
  // Again right after the airlock's own step, in the replay loop, for a database that had none.
  const inLoop = script.indexOf('case "$step" in *_airlock.sql) jobkey ;; esac');
  assert(inLoop > loop, "the job key follows the airlock's step inside the replays");
});

Deno.test("a token role declared after the database was built is made before the replays, idempotently", () => {
  const made = script.indexOf('CREATE ROLE "\\(r)" NOLOGIN;');
  const step = script.indexOf("\\(declaredRolesStep)");
  const repoint = script.indexOf("$repoint$;");
  assert(made > 0 && step > repoint, "after the plv8 repoint, in the already-built branch");
  assert(step < script.indexOf("for step in 005_create_tables.sql"), "before the replays");
  assertStringIncludes(script, "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '\\(r)')");
});

const gcp = await Deno.readTextFile(new URL("../gcp/schema/gcp.cue", import.meta.url));

Deno.test("no schema-job guard reads psql inside a test, where a failure would read as 'no'", () => {
  for (const [name, text] of [["k8s", script], ["gcp", gcp]] as const) {
    const bad = text.split("\n").filter((l) => /\[ "\$\(psql/.test(l) && !l.trim().startsWith("#"));
    assert(bad.length === 0, `${name}: ${bad.join(" | ")}`);
  }
});

Deno.test("the built-in roles are restated from 001_roles.sql before the grant and the replays, on a database that lacks them", () => {
  // A database built without auth, schedules, timed machines or effects has no `service`; the grant
  // that names it, and the first effect, fail without this step. 001_roles.sql guards every statement
  // (a role is made only where missing), so on a database that has the roles it changes nothing.
  for (const [name, text, grant] of [["k8s", script, "for step in 005_create_tables.sql"], ["gcp", gcp, "GRANT \\(strings.Join("]] as const) {
    const restated = text.indexOf("psql -v ON_ERROR_STOP=1 -Xq -f /docker-entrypoint-initdb.d/001_roles.sql");
    assert(restated > 0, `${name}: 001_roles.sql is run again`);
    assert(!text.includes("if [ -f /docker-entrypoint-initdb.d/001_roles.sql ]"), `${name}: a missing 001_roles.sql fails loudly`);
    assert(restated < text.indexOf("\\(declaredRolesStep)"), `${name}: before the declared roles`);
    assert(text.indexOf("\\(declaredRolesStep)") < text.indexOf(grant, text.indexOf("\\(declaredRolesStep)")), `${name}: before ${grant}`);
  }
});
