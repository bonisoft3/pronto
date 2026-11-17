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
  assertStringIncludes(script, `if [ "$(psql -XtAc "SELECT to_regnamespace('airlock') IS NOT NULL")" = t ]; then jobkey; fi`);
  assert(script.indexOf("then jobkey; fi") < loop, "applied before the replays where the airlock's schema stands");
  // Again once the airlock's own step has made the schema, for a database that had none.
  const after = script.indexOf("\t\t\t\t\t  jobkey\n\t\t\t\t\t  exit 0\n");
  assert(after > loop, "and after them, for a database whose airlock the replays just made");
});
