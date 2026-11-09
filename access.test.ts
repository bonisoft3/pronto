import assert from "node:assert/strict";
import { policy } from "./access-test-fixture.ts";

Deno.test("narrowing public writes preserves the ledger digest and emits an additive restriction", async () => {
  assert.equal(await policy("update"), await policy(true));
  const sql = await policy("update", true);
  assert.match(sql, /DROP POLICY IF EXISTS filter_app_user_write/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON filter FROM app_user/);
  assert.match(sql, /REVOKE UPDATE \(id, range\)/);
  assert.match(sql, /GRANT UPDATE \(range\)/);
  assert.match(sql, /FOR UPDATE TO app_user/);
  assert.doesNotMatch(sql, /FOR ALL|GRANT UPDATE \(id/);
  assert.doesNotMatch(await policy(false), /FOR ALL TO app_user/);
});

Deno.test("public access rejects unsupported write operations", async () => {
  await assert.rejects(() => policy("delete"), /conflicting values/);
});

Deno.test("update-only access occupies a unique ordered migration slot in the cluster", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", "optional.cue", "access.cue", "-e", "updateAccessMigrations"],
    cwd: new URL("./testdata/emit", import.meta.url), stdout: "piped", stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const migrations = JSON.parse(new TextDecoder().decode(out.stdout)) as string[];
  const prefixes = migrations.map((path) => path.split("/").at(-1)!.slice(0, 3));
  assert.equal(new Set(prefixes).size, prefixes.length);
  assert.deepEqual(prefixes, prefixes.toSorted());
  assert(migrations.includes("services/database/migrations/799_write_permissions.sql"));
});

Deno.test("update-only permissions are reconciled by the migrate runner before native readers start", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", "optional.cue", "access.cue", "-e", "updateAccessCluster.surface"],
    cwd: new URL("./testdata/emit", import.meta.url), stdout: "piped", stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const surface = JSON.parse(new TextDecoder().decode(out.stdout));
  assert.equal(surface.schema.pgroll.target, "migrate");
  assert.match(surface.targets.migrate.dockerfile.epilogue[0], /public_access.sql/);
  assert.match(surface.targets.migrate.dockerfile.epilogue[0], /REVOKE INSERT, UPDATE, DELETE/);
  assert.doesNotMatch(surface.targets.migrate.dockerfile.epilogue[0], /profile/);
  for (const reader of ["crud", "electric"]) {
    assert.equal(surface.targets[reader].compose.depends_on.migrate.condition, "service_completed_successfully");
  }
});

Deno.test("public read-only entities keep their authored policies and need no reconciliation runner", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", "optional.cue", "access.cue", "-e", "readOnlyAccessNoRunner"],
    cwd: new URL("./testdata/emit", import.meta.url), stdout: "piped", stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  assert.equal(JSON.parse(new TextDecoder().decode(out.stdout)), true);
});

Deno.test("an existing pgroll runner exports through the build without depending on empty reconciliation", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", "optional.cue", "access.cue", "-e", "accessMigrationSchema"],
    cwd: new URL("./testdata/emit", import.meta.url), stdout: "piped", stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out.stdout)), { target: "migrate", dir: "/pgroll", baseline: "00_initdb" });
});
