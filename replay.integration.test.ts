import { assertEquals } from "jsr:@std/assert@1.0.11";
import { replayDatabase, type UpgradeFixture } from "./check-replay.ts";

const DATABASE = "bonitao/mecha-database:0.9.0@sha256:eadcd8a668af9bf9f71f375f96b08965ebd49469d0c7a45d99e70b04316bcc2e";

async function docker(args: string[]) {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

Deno.test("replay follows the runtime ledger and protects retained data", async (t) => {
  const context = await Deno.makeTempDir({ prefix: "pronto-replay-integration-" });
  const image = `pronto-replay-test:${crypto.randomUUID()}`;
  const projection = `DO $$ BEGIN
    IF (SELECT relkind FROM pg_class WHERE oid='read_cache'::regclass) = 'r' THEN
      DROP TABLE read_cache CASCADE;
    END IF;
  END $$;
  CREATE OR REPLACE VIEW read_cache WITH (security_invoker=true) AS SELECT id, value FROM account;`;
  try {
    await Deno.writeTextFile(`${context}/010_account.sql`, `
      CREATE TABLE account (id integer PRIMARY KEY, value text NOT NULL);
      INSERT INTO account VALUES (1, 'bootstrap');
      CREATE TABLE read_cache (id integer PRIMARY KEY, value text NOT NULL);`);
    await Deno.writeTextFile(`${context}/020_projection.sql`, projection);
    for (const [name, sql] of Object.entries({
      "010_previous": "ALTER TABLE account ADD COLUMN IF NOT EXISTS visits integer NOT NULL DEFAULT 0",
      "020_projection": projection,
    })) {
      await Deno.writeTextFile(`${context}/${name}.json`, JSON.stringify({ operations: [{ sql: { up: sql, onComplete: true } }] }));
    }
    // The broken runner changes data without changing the catalog or ledger.
    await Deno.writeTextFile(`${context}/broken.sh`, `#!/bin/sh
set -eu
/migrate.sh "$@"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'UPDATE account SET visits=visits+1'
`);
    await Deno.writeTextFile(`${context}/Dockerfile`, `FROM ${DATABASE}
COPY *.sql /docker-entrypoint-initdb.d/
COPY *.json /pgroll/
COPY --chmod=755 broken.sh /broken.sh
`);
    await docker(["build", "-q", "-t", image, context]);
    const options = {
      appDir: Deno.cwd(),
      published: { target: "database", initdb: "/docker-entrypoint-initdb.d", pgroll: { target: "migrate", dir: "/pgroll", baseline: "00_initdb" } },
      service: { name: `fixture-${crypto.randomUUID()}`, image, env: {
        POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "replay", POSTGRES_DB: "fixture", POSTGRES_INITDB_ARGS: "--encoding=UTF8",
      } },
      migrator: { name: "migrate", image, env: {}, entrypoint: ["/migrate.sh"], command: ["/pgroll", "00_initdb"] },
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
      const findings = await replayDatabase({ ...options, migrator: { ...options.migrator, entrypoint: ["/broken.sh"] } });
      assertEquals(findings.filter(f => f.severity === "error").map(f => f.message), ["migration runner changed the schema, stored rows or ledger on restart"]);
    });
  } finally {
    await docker(["image", "rm", "-f", image]);
    await Deno.remove(context, { recursive: true });
  }
});
