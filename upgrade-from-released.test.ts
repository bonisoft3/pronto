// integrate@local's upgrade from the last release (upgrade-from-released.ts).
import { assertEquals, assertStringIncludes, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { databaseProcess, databaseSteps, lastReleased, localJob, migrations, migrationsOf, shellWords, upgradeScript } from "./upgrade-from-released.ts";

const sha = (c: string) => c.repeat(40);
const rec = (o: Record<string, unknown>) => JSON.stringify({ outcome: "live", preview: "", dirty: false, started: "t", commit: sha("a"), ...o });

Deno.test("the commit production runs is the last release that went live from a clean checkout", () => {
  const log = [rec({ commit: sha("1") }), rec({ commit: sha("2"), outcome: "failed" }), rec({ commit: sha("3"), preview: "rc" }), rec({ commit: sha("4"), dirty: true })].join("\n");
  assertEquals(lastReleased(log), { commit: sha("1") });
});

Deno.test("no live release, or none from a clean checkout, is a skip that says why", () => {
  assertEquals("skip" in lastReleased(rec({ outcome: "failed" })), true);
  assertEquals("skip" in lastReleased(rec({ dirty: true })), true);
  assertEquals("skip" in lastReleased(""), true);
});

Deno.test("the entrypoints' words keep a single-quoted path whole", () => {
  assertEquals(shellWords("a 'b c' d"), ["a", "b c", "d"]);
});

const script = (s: string) => ({ entrypoint: ["mise", "x", "--", "sh", "-c", s] });
const mecha = `exec bash "$$(mise where github:bonisoft3/mecha)"/services`;

Deno.test("the database's steps are the files its host.sh builds, in the order named", () => {
  const p = script(`${mecha}/database/host.sh 000_a.sql 'm/000.sql' 003_rls.sql '{mecha}/rls.sql+x.sql' 899.sh '{mecha}/p.sh' -- -c wal_level=logical`);
  assertEquals(databaseSteps(p), { "000_a.sql": "m/000.sql", "003_rls.sql": "{mecha}/rls.sql+x.sql", "899.sh": "{mecha}/p.sh" });
});

// mecha 0.22's database process (a nu script, `$$` being process-compose's escape for `$`).
const nuDb = script([
  "if ('/docker-entrypoint-initdb.d' | path exists) { exec docker-entrypoint.sh postgres -c wal_level=logical }",
  "let mecha = (if (($$env.PRONTO_INITDB_SRC_DIR? | default '') != '') { $$env.PRONTO_INITDB_SRC_DIR } else { (^mise where github:bonisoft3/mecha | str trim) })",
  "let initdb = (($$env.BAYT_LOCAL_WORK_DIR? | default $$nu.temp-dir) | path join 'initdb.d')",
  "cp -f ($$mecha | path join 'services/database/rls/rls.sql') ($$initdb | path join '003_rls.sql')",
  "cp -f ($$mecha | path join 'services/database/role_passwords.sh') ($$initdb | path join '899_role_passwords.sh')",
  "open .bayt/bayt.database.json | get dockerfile.copy.0.srcs | each {|s| cp -f $$s ($$initdb | path join ($$s | path basename)) } | ignore",
  "exec nu ($$mecha | path join 'services/database/entrypoint.nu') $$initdb postgres -c wal_level=logical -c fsync=off",
].join("\n"));

Deno.test("mecha 0.22's database process: mecha's two steps, the app's from its database json, and the postgres arguments", () => {
  const srcs = ["services/database/migrations/000_a.sql", "services/database/migrations/950_fixture.sql"];
  assertEquals(databaseProcess(nuDb, srcs), {
    steps: {
      "003_rls.sql": "{mecha}/services/database/rls/rls.sql",
      "899_role_passwords.sh": "{mecha}/services/database/role_passwords.sh",
      "000_a.sql": srcs[0],
      "950_fixture.sql": srcs[1],
    },
    args: ["-c", "wal_level=logical", "-c", "fsync=off"],
  });
  assertEquals(databaseProcess(script(`${mecha}/database/host.sh 000_a.sql 'm/000.sql' -- -c wal_level=logical`)).args, ["-c", "wal_level=logical"]);
});

Deno.test("a database process of neither form is refused", () => {
  assertThrows(() => databaseProcess(script("exec postgres")), Error, "neither");
});

Deno.test("the migrate step's baseline and its migrations, decoded", () => {
  const p = script(`${mecha}/migrate/host.sh 00_initdb 16_x ${btoa('{"a":1}')}`);
  assertEquals(migrations(p), { baseline: "00_initdb", files: { "16_x": '{"a":1}' } });
});

Deno.test("mecha 0.22's migrate process: the app's migration files and the baseline its nu script is handed", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${dir}/.bayt`)
    await Deno.mkdir(`${dir}/services/database/pgroll`, { recursive: true })
    await Deno.writeTextFile(`${dir}/services/database/pgroll/16_x.json`, '{"a":1}')
    await Deno.writeTextFile(`${dir}/.bayt/bayt.migrate.json`, JSON.stringify({ dockerfile: {
      copy: [{ srcs: ["services/database/pgroll/16_x.json"], dst: "/pgroll/16_x.json" }],
      epilogue: [`COPY <<'PGROLL' /pgroll/17_y.json\n{"b":2}\nPGROLL`, `COPY <<'PGROLL' /tmp/18_z.json.parts\n${btoa('{"c":3}')}\nPGROLL`],
    } }))
    const p = { entrypoint: ["mise", "x", "--", "nu", "-c", "let d = 1; let script = 'services/migrate/migrate.nu'; open .bayt/bayt.migrate.json; ^nu $$script $$dir 00_initdb"] }
    assertEquals(await migrationsOf(p, dir), { baseline: "00_initdb", files: { "16_x": '{"a":1}', "17_y": '{"b":2}', "18_z": '{"c":3}' } })
    // The old form is still read, for the released commit's own process.
    assertEquals(await migrationsOf(script(`${mecha}/migrate/host.sh 00_initdb 16_x ${btoa('{"a":1}')}`), dir), { baseline: "00_initdb", files: { "16_x": '{"a":1}' } })
    await Deno.writeTextFile(`${dir}/.bayt/bayt.migrate.json`, "{}")
    await assertRejects(() => migrationsOf({ entrypoint: ["sh", "-c", "true"] }, dir), Error, "neither")
  } finally { await Deno.remove(dir, { recursive: true }) }
})

const job = (s: string) =>
  `spec:\n  template:\n    spec:\n      template:\n        spec:\n          containers:\n          - command: [bash, -c, ${JSON.stringify(s)}]\n            env:\n            - {name: PGHOST, value: /cloudsql/x}\n            - {name: REQUIRED_TABLES, value: a}\n            - {name: PGPASSWORD, valueFrom: {secretKeyRef: {name: s}}}\n`;
const where = { stepsDir: "/s", migrateSh: "/m/migrate.sh", migrationsDir: "/p", hasMigrate: true };

Deno.test("the schema job runs here over this tree's steps and migrations, with its own settings and not the cluster's connection", () => {
  const r = localJob(job(`replay /docker-entrypoint-initdb.d/005.sql\nexec "/migrate.sh" "/pgroll" "00_initdb"\n`), where);
  assertEquals(r, `replay /s/005.sql\nexec bash "/m/migrate.sh" "/p" "00_initdb"\n`);
});

Deno.test("a schema job this cannot place is refused, not run as something else", () => {
  assertThrows(() => localJob(job(`replay /docker-entrypoint-initdb.d/005.sql\nexec other\n`), where), Error, "no longer runs");
  assertThrows(() => localJob(job(`echo`), where), Error, "replays no");
});

Deno.test("the upgrade carries the released commit's migrations, marks the database as the cluster's initdb finds it, then runs the job", () => {
  const s = upgradeScript({ oldDir: "/old", oldBaseline: "00_initdb", oldMigrationsDir: "/om", jobFile: "/j.sh", mecha: "/mecha" });
  const at = (x: string) => s.indexOf(x);
  assertStringIncludes(s, "'/om' '00_initdb'");
  assertEquals(at("migrate.sh") < at("pronto initdb") && at("pronto initdb") < at("bash '/j.sh'"), true);
  // The job's replays add no inferred migration to pgroll's ledger: counted on either side of it.
  assertEquals(at("before=$(inferred)") < at("bash '/j.sh'") && at("bash '/j.sh'") < at("after=$(inferred)"), true);
});

Deno.test("a test database holds this tree's fixture, applied after the job, before PostgREST reloads", () => {
  const s = upgradeScript({ oldDir: "/old", oldBaseline: "", oldMigrationsDir: undefined, jobFile: "/j.sh", mecha: "/mecha", fixtureFile: "/steps/950_fixture.sql" })
  const at = (x: string) => s.indexOf(x)
  assertStringIncludes(s, "psql -X -v ON_ERROR_STOP=1 -q -f '/steps/950_fixture.sql'")
  assertEquals(at("bash '/j.sh'") < at("-f '/steps/950_fixture.sql'") && at("-f '/steps/950_fixture.sql'") < at("NOTIFY pgrst"), true)
  // No fixture, no step: a released database never gains test rows.
  assertEquals(upgradeScript({ oldDir: "/old", oldBaseline: "", oldMigrationsDir: undefined, jobFile: "/j.sh", mecha: "/mecha" }).includes("950_fixture"), false)
})
