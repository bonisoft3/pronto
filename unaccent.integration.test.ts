// A generated search column over immutable_unaccent, as pronto emits it
// (testdata/emit/unaccent.cue), finds accented titles from unaccented words in
// each database a release runs: the cluster's PostgreSQL image, the PGlite a
// page or pgdata.ts boots (mecha-browser's createDatabase), and the edge
// object's PGlite built for workerd, which links unaccent in rather than
// loading it. Needs Docker and libraries/mecha/packages/pglite-workerd/dist.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { DATABASE, ROOT, run } from "./mecha-fixtures.ts";
import { startWorker } from "../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts";
import { load } from "../../libraries/mecha/packages/pglite-workerd/load.ts";
import { PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE } from "./bundle/cloudflare-runtime.ts";

const root = new URL(ROOT).pathname;
const mecha = `${root}libraries/mecha`;

async function schema(): Promise<string> {
  const out = await run("cue", ["export", "./plugins/pronto/testdata/emit", "-e", "unaccentSchema", "--out", "text"]);
  if (!out.ok) throw new Error(out.err);
  return out.out;
}

// Rows written under an empty search_path too: the generated column must not
// resolve the wrapper or its dictionary through the writer's session.
const CHECK = `
INSERT INTO public.note (id, title) VALUES ('00000000-0000-0000-0000-000000000001', 'Reunião de equipe'), ('00000000-0000-0000-0000-000000000002', 'Almoço com cliente');
SET search_path = '';
INSERT INTO public.note (id, title) VALUES ('00000000-0000-0000-0000-000000000003', 'Ação');
RESET search_path;
SELECT json_build_object(
  'reuniao', (SELECT json_agg(title) FROM note WHERE search @@ plainto_tsquery('simple', immutable_unaccent('Reuniao'))),
  'almoco', (SELECT json_agg(title) FROM note WHERE search @@ plainto_tsquery('simple', immutable_unaccent('ALMOCO'))),
  'acao', (SELECT json_agg(title) FROM note WHERE search @@ plainto_tsquery('simple', immutable_unaccent('acao'))),
  'volatility', (SELECT provolatile FROM pg_proc WHERE oid = 'public.immutable_unaccent(text)'::regprocedure)
)::text AS found;`;

const FOUND = { reuniao: ["Reunião de equipe"], almoco: ["Almoço com cliente"], acao: ["Ação"], volatility: "i" };

Deno.test({ name: "the cluster's PostgreSQL finds accented text from unaccented words", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const sql = await schema();
  const container = `pronto-unaccent-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=proof", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  try {
    for (let i = 0; ; i++) {
      if ((await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok) break;
      if (i >= 120) throw new Error("PostgreSQL did not start");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const applied = await run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], `${sql}\n${CHECK}`);
    if (!applied.ok) throw new Error(applied.err);
    assertEquals(JSON.parse(applied.out), FOUND);
  } finally {
    await run("docker", ["stop", container]);
  }
} });

Deno.test({ name: "the PGlite a page or pgdata.ts boots finds accented text from unaccented words", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const sql = await schema();
  const out = await run("env", ["DENO_NO_PACKAGE_JSON=1", "deno", "run", "-A", "--no-config", "--import-map", `${mecha}/packages/mecha-browser/cluster.deno.json`, "--lock", `${mecha}/packages/mecha-browser/deno.lock`, "--frozen", "-"], `
    import { createDatabase } from "${mecha}/packages/mecha-browser/src/database.ts";
    const db = await createDatabase({});
    await db.exec(${JSON.stringify(sql)});
    const results = await db.exec(${JSON.stringify(CHECK)});
    console.log(results.at(-1).rows[0].found);
    await db.close();`);
  if (!out.ok) throw new Error(out.err);
  assertEquals(JSON.parse(out.out), FOUND);
} });

Deno.test({ name: "the edge object's PGlite, unaccent linked in, finds accented text from unaccented words", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const dist = `${mecha}/packages/pglite-workerd/dist`;
  Deno.statSync(`${dist}/pglite.wasm`);
  const sql = await schema();
  const tmp = await Deno.makeTempDir({ prefix: "pronto-unaccent-edge-" });
  // The directory as pgdata.ts builds it: npm's PGlite, through createDatabase.
  const seeded = await run("env", ["DENO_NO_PACKAGE_JSON=1", "deno", "run", "-A", "--no-config", "--import-map", `${mecha}/packages/mecha-browser/cluster.deno.json`, "--lock", `${mecha}/packages/mecha-browser/deno.lock`, "--frozen", "-", `${tmp}/pgdata`], `
    import { createDatabase } from "${mecha}/packages/mecha-browser/src/database.ts";
    const db = await createDatabase({ dataDir: Deno.args[0] });
    await db.exec(${JSON.stringify(sql)});
    await db.exec("CHECKPOINT");
    await db.close();`);
  if (!seeded.ok) throw new Error(seeded.err);

  await Deno.mkdir(`${tmp}/worker`);
  const edge = `${mecha}/packages/mecha-edge/src`;
  await Deno.writeTextFile(`${tmp}/worker/worker.ts`, `
    import { edgeObject } from '${edge}/object.ts'
    import { edgeWorker } from '${edge}/worker.ts'
    import pgliteWasm from '${dist}/pglite.wasm'
    import initdbWasm from '${dist}/initdb.wasm'
    import pgliteData from '${dist}/pglite.data'
    import icu from '${dist}/icu-root.tgz'
    const Base = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: [] })
    export class Cluster extends Base {
      override async fetch(req) {
        if (new URL(req.url).pathname === '/test/sql') {
          const db = await this.booted()
          const { sql } = await req.json()
          try {
            const results = await db.exec(sql)
            return Response.json(results.filter((r) => r.fields.length).at(-1)?.rows ?? [])
          } catch (e) {
            return Response.json({ error: e.message }, { status: 500 })
          }
        }
        return super.fetch(req)
      }
    }
    export default {
      fetch(req, env, ctx) {
        if (new URL(req.url).pathname.startsWith('/test/')) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
        return edgeWorker.fetch(req, env, ctx)
      },
    }`);
  await Deno.writeTextFile(`${tmp}/worker/wrangler.jsonc`, JSON.stringify({
    name: "pronto-unaccent-edge-test",
    main: "worker.ts",
    compatibility_date: PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "CLUSTER", class_name: "Cluster" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Cluster"] }],
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: { JWT_SECRET: "test-secret", IMPORT_TOKEN: "test-import" },
    rules: [
      { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false },
      { type: "Data", globs: ["**/*.data", "**/*.tgz"], fallthrough: false },
    ],
    // As bundle/edge.ts configures a release.
    alias: {
      typescript: `${edge}/typescript-absent.js`,
      "@electric-sql/pglite": `${dist}/index.js`,
      "@electric-sql/pglite/basefs": `${dist}/fs/base.js`,
      "@mecha/postgrest-js": `${mecha}/packages/postgrest-js/src/index.ts`,
    },
  }));

  const worker = await startWorker(new URL(`file://${tmp}/worker/wrangler.jsonc`), `${tmp}/state`);
  const at = (path: string) => `${worker.origin}${path}`;
  try {
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: "Bearer test-import" } }), { log: () => {} });
    const res = await fetch(at("/test/sql"), { method: "POST", body: JSON.stringify({ sql: CHECK }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    assertEquals(JSON.parse(body[0].found), FOUND);
  } finally {
    await worker.stop();
  }
} });
