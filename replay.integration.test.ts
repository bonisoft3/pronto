import { assertEquals } from "jsr:@std/assert@1.0.11";
import { replayDatabase, type UpgradeFixture } from "./check-replay.ts";

const DATABASE = "bonitao/mecha-database:0.9.0@sha256:eadcd8a668af9bf9f71f375f96b08965ebd49469d0c7a45d99e70b04316bcc2e";

async function docker(args: string[]) {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

Deno.test("replay follows the runtime ledger and protects retained data", async (t) => {
  const context = await Deno.realPath(await Deno.makeTempDir({ prefix: "pronto-replay-integration-" }));
  const container = `pronto-replay-test-${crypto.randomUUID().slice(0, 12)}`;
  const priorPath = Deno.env.get("PATH") ?? "";
  const projection = `DO $$ BEGIN
    IF (SELECT relkind FROM pg_class WHERE oid='read_cache'::regclass) = 'r' THEN
      DROP TABLE read_cache CASCADE;
    END IF;
  END $$;
  CREATE OR REPLACE VIEW read_cache WITH (security_invoker=true) AS SELECT id, value FROM account;`;
  try {
    const initdb = `${context}/initdb`;
    const pgroll = `${context}/pgroll`;
    const bin = `${context}/bin`;
    await Deno.mkdir(initdb);
    await Deno.mkdir(pgroll);
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${initdb}/010_account.sql`, `
      CREATE TABLE account (id integer PRIMARY KEY, value text NOT NULL);
      INSERT INTO account VALUES (1, 'bootstrap');
      CREATE TABLE read_cache (id integer PRIMARY KEY, value text NOT NULL);`);
    await Deno.writeTextFile(`${initdb}/020_projection.sql`, projection);
    for (const [name, sql] of Object.entries({
      "010_previous": "ALTER TABLE account ADD COLUMN IF NOT EXISTS visits integer NOT NULL DEFAULT 0",
      "020_projection": projection,
    })) {
      await Deno.writeTextFile(`${pgroll}/${name}.json`, JSON.stringify({ operations: [{ sql: { up: sql, onComplete: true } }] }));
    }
    for (const tool of ["pg_isready", "psql", "pg_dump"]) {
      await Deno.writeTextFile(`${bin}/${tool}`, `#!/bin/sh\nexec docker exec -i -e PGPASSWORD="\${PGPASSWORD:-}" ${container} ${tool} "$@"\n`, { mode: 0o755 });
    }
    await Deno.writeTextFile(`${bin}/migrate.sh`, `#!/bin/sh
set -eu
dir=$1
shift
tar -C "$dir" -cf - . | docker exec -i -e DATABASE_URL="$DATABASE_URL" ${container} sh -ec '
  d=$(mktemp -d)
  trap "rm -rf \\"$d\\"" EXIT
  tar -C "$d" -xf -
  /migrate.sh "$d" "$@"
' sh "$@"
`, { mode: 0o755 });
    // The broken runner changes data without changing the catalog or ledger.
    await Deno.writeTextFile(`${bin}/broken.sh`, `#!/bin/sh
set -eu
"${bin}/migrate.sh" "$@"
"${bin}/psql" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'UPDATE account SET visits=visits+1'
`, { mode: 0o755 });
    await docker([
      "run", "-d", "--name", container,
      "-e", "POSTGRES_USER=postgres",
      "-e", "POSTGRES_PASSWORD=replay",
      "-e", "POSTGRES_DB=fixture",
      "-e", "POSTGRES_INITDB_ARGS=--encoding=UTF8",
      DATABASE,
    ]);
    Deno.env.set("PATH", `${bin}:${priorPath}`);
    const options = {
      appDir: Deno.cwd(),
      published: { target: "database", initdb, pgroll: { target: "migrate", dir: pgroll, baseline: "00_initdb" } },
      env: {
        POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "replay", POSTGRES_DB: "fixture", POSTGRES_INITDB_ARGS: "--encoding=UTF8",
      },
      migrator: { entrypoint: [`${bin}/migrate.sh`], command: [pgroll, "00_initdb"] },
    };
    const fixture: UpgradeFixture = {
      name: "read-cache", omitInitdb: ["020_projection.sql"], through: "010_previous",
      seed: "INSERT INTO account VALUES (2, 'retained', 0); INSERT INTO read_cache SELECT id, value FROM account;",
      verify: "SELECT array_agg(value ORDER BY id) = ARRAY['bootstrap','retained'] FROM read_cache;",
      replacements: { read_cache: { kind: "view", note: "Computed from retained account rows." } },
    };
    if (!await t.step("non-repeatable initdb and a declared table-to-view upgrade pass", async () => {
      assertEquals(await replayDatabase({ ...options, fixtures: [fixture] }), []);
    })) return;
    await t.step("a projection declaration cannot hide failed data verification", async () => {
      const findings = await replayDatabase({ ...options, fixtures: [{ ...fixture, verify: "SELECT false;" }] });
      assertEquals(findings.map(f => f.message), ["retained-data verification must return one true boolean"]);
    });
    await t.step("an undeclared retained table replacement fails", async () => {
      const findings = await replayDatabase({ ...options, fixtures: [{ ...fixture, replacements: {} }] });
      assertEquals(findings.length, 1);
      assertEquals(findings[0].message.includes("read_cache was dropped and recreated"), true);
    });
    await t.step("a runtime entrypoint that rewrites rows on restart fails", async () => {
      const findings = await replayDatabase({ ...options, migrator: { ...options.migrator, entrypoint: [`${bin}/broken.sh`] } });
      assertEquals(findings.filter(f => f.severity === "error").map(f => f.message), ["migration runner changed the schema, stored rows or ledger on restart"]);
    });
  } finally {
    Deno.env.set("PATH", priorPath);
    await docker(["rm", "-f", "-v", container]);
    await Deno.remove(context, { recursive: true });
  }
});
