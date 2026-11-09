// Database functions in the edge object: the migration applied to a data
// directory as an edge release applies it (the plv8 engine fenced away), each
// call reaching the module edge-functions.ts renders through pgl_step, in a
// Durable Object under wrangler dev. Needs libraries/mecha/packages/pglite-workerd/dist.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { compileFunction } from "./database-functions.ts";
import { renderFunctions } from "./bundle/edge-functions.ts";
import { ROOT, quote, run, terminal } from "./mecha-fixtures.ts";
import { declared, functionApp, LOOSE, ROUND, SPIN, THROW, round, reshaped } from "./testdata/function-fixtures.ts";
import { startWorker } from "../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts";
import { load } from "../../libraries/mecha/packages/pglite-workerd/load.ts";
import { browserTier } from "../../libraries/mecha/packages/mecha-browser/fence.ts";

const root = new URL(ROOT).pathname;
const mecha = `${root}libraries/mecha`;

Deno.test({ name: "a function runs through pgl_step inside the caller's transaction, and its failure rolls that back", sanitizeOps: false, sanitizeResources: false, fn: async t => {
  Deno.statSync(`${mecha}/packages/pglite-workerd/dist/pglite.wasm`);
  const tmp = await Deno.makeTempDir({ prefix: "pronto-functions-edge-" });
  const app = await functionApp();

  const migration = [["round", ROUND], ["spin", SPIN], ["fail", THROW], ["loose", LOOSE]]
    .map(([name, source]) => compileFunction({ name, fuel: 10000 }, source, terminal)).join("\n");
  const seedSql = `CREATE ROLE anon; CREATE ROLE app_user;
    GRANT USAGE ON SCHEMA public TO anon, app_user;
    ${browserTier(migration)}
    CREATE TABLE public.observation (id integer PRIMARY KEY, parsed jsonb NOT NULL);
    GRANT SELECT, INSERT ON public.observation TO app_user;`;
  assert(!/LANGUAGE plv8|EXTENSION IF NOT EXISTS plv8/.test(seedSql), "the edge data directory runs no plv8");
  await Deno.writeTextFile(`${tmp}/seed.sql`, seedSql);
  const seeded = await run("deno", ["run", "-A", "--config", `${mecha}/packages/mecha-edge/deno.json`, "-", `${tmp}/pgdata`, `${tmp}/seed.sql`], `
    import { PGlite } from "@electric-sql/pglite";
    const [dir, sql] = Deno.args;
    Deno.mkdirSync(dir);
    const db = await PGlite.create({ dataDir: dir });
    await db.exec(await Deno.readTextFile(sql));
    await db.exec("CHECKPOINT");
    await db.close();`);
  if (!seeded.ok) throw new Error(seeded.err);

  await Deno.mkdir(`${tmp}/worker`);
  await Deno.writeTextFile(`${tmp}/worker/functions.js`, await renderFunctions("proof", app, `${root}plugins/omnishell`, declared));
  const edge = `${mecha}/packages/mecha-edge/src`;
  const dist = `${mecha}/packages/pglite-workerd/dist`;
  await Deno.writeTextFile(`${tmp}/worker/worker.ts`, `
    import { edgeObject } from '${edge}/object.ts'
    import { edgeWorker } from '${edge}/worker.ts'
    import functions from './functions.js'
    import pgliteWasm from '${dist}/pglite.wasm'
    import initdbWasm from '${dist}/initdb.wasm'
    import pgliteData from '${dist}/pglite.data'
    import icu from '${dist}/icu-root.tgz'
    const Base = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: [], functions })
    export class Cluster extends Base {
      override async fetch(req) {
        if (new URL(req.url).pathname === '/test/sql') {
          const db = await this.booted()
          const { sql } = await req.json()
          try {
            const results = await db.exec(sql)
            return Response.json(results.filter((r) => r.fields.length).at(-1)?.rows ?? [])
          } catch (e) {
            try { await db.exec('ROLLBACK') } catch { /* no transaction to roll back */ }
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
    name: "pronto-functions-edge-test",
    main: "worker.ts",
    compatibility_date: "2026-09-01",
    durable_objects: { bindings: [{ name: "CLUSTER", class_name: "Cluster" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Cluster"] }],
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: { JWT_SECRET: "test-secret", IMPORT_TOKEN: "test-import" },
    rules: [
      { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false },
      { type: "Data", globs: ["**/*.data", "**/*.tgz"], fallthrough: false },
    ],
    alias: {
      "@electric-sql/pglite": `${dist}/index.js`,
      "@electric-sql/pglite/basefs": `${dist}/fs/base.js`,
      "@mecha/postgrest-js": `${mecha}/packages/postgrest-js/src/index.ts`,
    },
  }));

  const worker = await startWorker(new URL(`file://${tmp}/worker/wrangler.jsonc`), `${tmp}/state`);
  const at = (path: string) => `${worker.origin}${path}`;
  const psql = async (source: string): Promise<{ ok: boolean; rows: Record<string, unknown>[]; err: string }> => {
    const res = await fetch(at("/test/sql"), { method: "POST", body: JSON.stringify({ sql: source }) });
    const body = await res.json();
    return res.ok ? { ok: true, rows: body, err: "" } : { ok: false, rows: [], err: body.error };
  };
  const sql = async (source: string) => {
    const result = await psql(source);
    if (!result.ok) throw new Error(result.err);
    return result.rows;
  };
  const one = async (source: string) => Object.values((await sql(source))[0])[0];
  const refused = async (source: string) => {
    const result = await psql(source);
    if (result.ok) throw new Error(`accepted: ${source}`);
    return result.err;
  };

  try {
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: "Bearer test-import" } }), { log: () => {} });

    await t.step("the object supplies the engine the migration left to the tier", async () => {
      assertEquals(await one(`SELECT (SELECT lanname FROM pg_language WHERE oid = prolang) FROM pg_proc WHERE oid = 'pronto_functions.round(jsonb)'::regprocedure;`), "sql");
    });
    await t.step("a call reshapes its argument in the commit that stores it", async () => {
      await sql(`BEGIN; SET LOCAL ROLE app_user; INSERT INTO public.observation VALUES (1, public.fn_round(${quote(round)})); COMMIT;`);
      assertEquals(await one("SELECT parsed FROM public.observation WHERE id = 1"), reshaped);
    });
    await t.step("exhausted fuel, a throw and an answer that is not JSON fail the transaction", async () => {
      for (const [call, message] of [
        ["public.fn_spin('{}')", "function spin: fuel exhausted"],
        [`public.fn_fail('{"kind": "round"}')`, "unparsable round"],
        [`public.fn_loose('{"n": 1}')`, "answer.value is not a finite number"],
      ]) {
        assertStringIncludes(await refused(`BEGIN; INSERT INTO public.observation VALUES (2, '{}'); INSERT INTO public.observation VALUES (3, ${call}); COMMIT;`), message);
        assertEquals(Number(await one("SELECT count(*) FROM public.observation WHERE id IN (2, 3)")), 0);
      }
    });
  } finally {
    await worker.stop();
  }
} });
