import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createRestHandler } from "../../libraries/mecha/packages/postgrest-js/src/rest-handler.ts";
import { assertGuestWrites, policy, releaseJobs, schema } from "./access-test-fixture.ts";

Deno.test("PGlite applies update-only access to fresh and previously writable preset tables", async () => {
  for (const upgrade of [false, true]) {
    const db = await PGlite.create();
    try {
      await db.exec(await schema());
      if (upgrade) await db.exec("UPDATE filter SET range = '7d' WHERE id = 'none'; GRANT UPDATE (id) ON filter TO app_user;");
      const before = (await db.query("SELECT * FROM filter ORDER BY id")).rows;
      await db.exec(await policy("update", true));
      await db.exec(await policy("update", true));
      assert.deepEqual((await db.query("SELECT * FROM filter ORDER BY id")).rows, before);
      const handler = createRestHandler(db, { role: "app_user", scopes: () => ["public:"], claims: () => ({ role: "app_user", sub: "guest" }) });
      await assertGuestWrites((path, init) => handler(new Request(`http://local/${path}`, init)));
      await db.exec("SET ROLE service; INSERT INTO filter (id, range) VALUES ('service-added', 'day'); DELETE FROM filter WHERE id = 'service-added'; RESET ROLE;");
    } finally {
      await db.close();
    }
  }
});

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const POSTGREST = "postgrest/postgrest:v16.4@sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df";

async function docker(args: string[]) {
  const run = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  assert(run.success, new TextDecoder().decode(run.stderr));
  return new TextDecoder().decode(run.stdout).trim();
}

async function guestToken(secret: string) {
  const b64 = (value: string) => btoa(value).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  const payload = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64(JSON.stringify({ role: "app_user", sub: "guest", exp: Math.floor(Date.now() / 1000) + 300 }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + b64(String.fromCharCode(...new Uint8Array(signature)));
}

Deno.test("PostgREST guest JWT can PATCH seeded values but cannot delete, create, upsert or rename presets", async () => {
  const id = crypto.randomUUID().slice(0, 8);
  const db = `access-db-${id}`, rest = `access-rest-${id}`, network = `access-${id}`;
  const secret = "access-test-signing-secret-at-least-32-characters";
  let databaseStarted = false, restStarted = false;
  const scratch = await Deno.makeTempDir({ prefix: "access-reconcile-" });
  await docker(["network", "create", network]);
  try {
    await docker(["run", "--rm", "-d", "--name", db, "--network", network, "-e", "POSTGRES_PASSWORD=access", POSTGRES]);
    databaseStarted = true;
    let ready = false;
    for (let n = 0; n < 100; n++) {
      const probe = await new Deno.Command("docker", { args: ["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], stdout: "null", stderr: "null" }).output();
      if (probe.success) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, "Postgres did not become ready");
    await docker(["exec", db, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", await schema()]);
    await docker(["exec", db, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "COMMENT ON DATABASE postgres IS 'pronto initdb'; UPDATE filter SET range = 'day' WHERE id = 'source';"]);
    await docker(["cp", new URL("../../libraries/mecha/services/migrate/migrate.sh", import.meta.url).pathname, `${db}:/migrate.sh`]);
    await docker(["exec", db, "chmod", "+x", "/migrate.sh"]);
    await docker(["exec", db, "mkdir", "/pgroll"]);
    const images = await Deno.readTextFile(new URL("../../libraries/mecha/bayt.cue", import.meta.url));
    const pgrollImage = images.match(/_pgroll:\s+"([^"]+)"/)?.[1];
    assert(pgrollImage);
    const pgroll = await docker(["create", pgrollImage]);
    try {
      await docker(["cp", `${pgroll}:/usr/bin/pgroll`, `${scratch}/pgroll`]);
    } finally {
      await docker(["rm", pgroll]);
    }
    await docker(["cp", `${scratch}/pgroll`, `${db}:/usr/local/bin/pgroll`]);
    const execute = (query: string) => docker(["exec", db, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc", query]);
    const saved = await execute("SELECT json_agg(f ORDER BY id) FROM filter f");
    const apply = async () => {
      await Deno.writeTextFile(`${scratch}/public_access.sql`, await policy("update", true));
      await docker(["cp", `${scratch}/public_access.sql`, `${db}:/pgroll/public_access.sql`]);
      await docker(["exec", "-e", "DATABASE_URL=postgres://postgres:access@localhost:5432/postgres?sslmode=disable", db, "bash", "/migrate.sh", "/pgroll", "00_initdb"]);
    };
    await Deno.writeTextFile(`${scratch}/public_access.sql`, await policy("update", true));
    await docker(["cp", `${scratch}/public_access.sql`, `${db}:/pgroll/public_access.sql`]);
    for (const [platform, jobs] of Object.entries(await releaseJobs())) {
      await execute("GRANT INSERT, UPDATE, DELETE ON filter TO app_user; " + await policy(true));
      const initialized = await docker(["exec", "-e", "PGUSER=postgres", "-e", "PGDATABASE=postgres", "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_DB=postgres", "-e", "DATABASE_URL=postgres://postgres:access@localhost:5432/postgres?sslmode=disable", db, ...jobs.initdb.command]);
      assert.match(initialized, /initdb: already built/, platform);
      assert.match(jobs.migrate.image, platform === "gcp" ? /access-schema:/ : /access-migrate:/, platform);
      await apply();
      assert.equal(await execute("SELECT has_table_privilege('app_user', 'filter', 'INSERT') OR has_table_privilege('app_user', 'filter', 'DELETE')"), "f", platform);
      assert.equal(await execute("SELECT count(*) FROM pg_policies WHERE tablename='filter' AND policyname='filter_app_user_write'"), "0", platform);
      assert.equal(await execute("SELECT json_agg(f ORDER BY id) FROM filter f"), saved, platform);
    }
    const ledger = await execute("SELECT json_agg(m ORDER BY created_at) FROM pgroll.migrations m");
    await apply();
    assert.equal(await execute("SELECT json_agg(m ORDER BY created_at) FROM pgroll.migrations m"), ledger);
    await Deno.writeTextFile(`${scratch}/public_access.sql`, "GRANT INSERT, DELETE ON filter TO app_user;\nSELECT access_reconciliation_must_fail();");
    await docker(["cp", `${scratch}/public_access.sql`, `${db}:/pgroll/public_access.sql`]);
    const failed = await new Deno.Command("docker", {
      args: ["exec", "-e", "DATABASE_URL=postgres://postgres:access@localhost:5432/postgres?sslmode=disable", db, "bash", "/migrate.sh", "/pgroll", "00_initdb"],
      stdout: "piped", stderr: "piped",
    }).output();
    assert.equal(failed.success, false);
    assert.match(new TextDecoder().decode(failed.stderr), /access_reconciliation_must_fail/);
    assert.equal(await execute("SELECT has_table_privilege('app_user', 'filter', 'INSERT') OR has_table_privilege('app_user', 'filter', 'DELETE')"), "f");
    await apply();
    const blocker = new Deno.Command("docker", {
      args: ["exec", "-e", "PGAPPNAME=access-reconcile-blocker", db, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "BEGIN; LOCK filter IN ACCESS SHARE MODE; SELECT pg_sleep(30); COMMIT;"],
      stdout: "piped", stderr: "piped",
    }).spawn();
    try {
      let locked = false;
      for (let n = 0; n < 100; n++) {
        if (await execute("SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE a.application_name='access-reconcile-blocker' AND l.relation='filter'::regclass AND l.mode='AccessShareLock' AND l.granted)") === "t") {
          locked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(locked, "the long reader did not acquire its lock");
      const started = Date.now();
      const bounded = await new Deno.Command("docker", {
        args: ["exec", "-e", "DATABASE_URL=postgres://postgres:access@localhost:5432/postgres?sslmode=disable", db, "bash", "/migrate.sh", "/pgroll", "00_initdb"],
        stdout: "piped", stderr: "piped",
      }).output();
      assert.equal(bounded.success, false);
      assert.match(new TextDecoder().decode(bounded.stderr), /lock timeout/);
      assert(Date.now() - started < 15000, "reconciliation exceeded its lock wait budget");
    } finally {
      await execute("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='access-reconcile-blocker'");
      const stopped = await blocker.output();
      assert.equal(stopped.success, false);
      assert.match(new TextDecoder().decode(stopped.stderr), /canceling statement due to user request/);
    }
    await apply();
    assert.equal(await execute("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname=current_database()"), "pronto initdb");
    await execute("UPDATE filter SET range = '7d' WHERE id = 'source'");
    await docker(["run", "--rm", "-d", "--name", rest, "--network", network, "-p", "127.0.0.1::3000",
      "-e", `PGRST_DB_URI=postgres://postgres:access@${db}:5432/postgres`,
      "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_PRE_REQUEST=app_pre_request", "-e", `PGRST_JWT_SECRET=${secret}`, POSTGREST]);
    restStarted = true;
    const port = (await docker(["port", rest, "3000/tcp"])).match(/:(\d+)$/)?.[1];
    assert(port);
    const base = `http://127.0.0.1:${port}/`;
    const token = await guestToken(secret);
    let serving = false;
    for (let n = 0; n < 100; n++) {
      // Connection refusal is expected only while the isolated service boots.
      try {
        const response = await fetch(base + "filter", { headers: { Authorization: `Bearer ${token}` } });
        await response.body?.cancel();
        if (response.status === 200) { serving = true; break; }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(serving, "PostgREST did not become ready");
    await assertGuestWrites((path, init) => fetch(base + path, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } }));
  } finally {
    if (restStarted) await docker(["rm", "-f", rest]);
    if (databaseStarted) await docker(["rm", "-f", db]);
    await docker(["network", "rm", network]);
    await Deno.remove(scratch, { recursive: true });
  }
});
