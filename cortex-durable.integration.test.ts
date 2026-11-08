import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { compileCortexDurable } from "./cortex-durable.ts";
import { spec, rules } from "./testdata/cortex-durable.ts";
import { DATABASE, quote, run, terminal, uuid } from "./mecha-fixtures.ts";

Deno.test({ name: "durable Cortex invocation, publication and receipt share PostgreSQL transactions", sanitizeOps: false, sanitizeResources: false, fn: async t => {
  const declaration = structuredClone(spec);
  declaration.machine.mecha = { locks: "", transitions: [{
    phase: "active", event: "done", sql: "INSERT INTO public.published VALUES (game.id);",
  }] };
  const compiled = await compileCortexDurable(declaration, rules, terminal);
  const container = `pronto-cortex-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=proof", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (source: string) => run("docker", ["exec", "-i", "-e", "PGOPTIONS=-c default_transaction_isolation=serializable", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], source);
  const sql = async (source: string) => {
    const result = await psql(source);
    if (!result.ok) throw new Error(result.err);
    return result.out;
  };
  const deliver = (event: string) => `SELECT hybrid_durable_test.deliver('${uuid(1)}', ${quote({ kind: event, payload: {} })});`;
  const snapshot = () => sql(`SELECT jsonb_build_object('state', i.state,
    'outcomes', (SELECT count(*) FROM durex.work WHERE outcome IS NOT NULL),
    'published', (SELECT count(*) FROM public.published),
    'jobs', (SELECT count(*) FROM graphile_worker._private_jobs))
    FROM hybrid_durable_test.instance i WHERE i.id = '${uuid(1)}';`);
  try {
    for (let i = 0; ; i++) {
      if ((await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok) break;
      if (i >= 60) throw new Error("Cortex PostgreSQL did not start");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await sql(await Deno.readTextFile(new URL("../../libraries/mecha/services/durex/graphile.sql", import.meta.url)));
    await sql(await Deno.readTextFile(new URL("../../libraries/mecha/services/durex/work.sql", import.meta.url)));
    await sql(`CREATE ROLE observer;
      ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO observer;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO observer;
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO observer;
      DO $roles$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service') THEN CREATE ROLE service; END IF;
      END $roles$;
      ALTER ROLE app_user SET default_transaction_isolation = 'read committed';
      ALTER ROLE service SET default_transaction_isolation = 'read committed';
      CREATE TABLE public.published(instance uuid PRIMARY KEY);
      ${compiled.sql}
      INSERT INTO hybrid_durable_test.instance VALUES ('${uuid(1)}', 1, 0, ${quote({ phase: "idle", requested: 0, wake: 0 })});`);
    await t.step("default grants cannot expose private machine state or delivery authority", async () => {
      assertEquals(await sql("SELECT has_schema_privilege('observer', 'hybrid_durable_test', 'USAGE');"), "f");
      assertEquals(await sql(`SELECT bool_and(c.relrowsecurity AND NOT has_table_privilege('observer', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'hybrid_durable_test' AND c.relkind = 'r';`), "t");
      assertEquals(await sql(`SELECT bool_and(NOT has_function_privilege('observer', p.oid, 'EXECUTE'))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'hybrid_durable_test';`), "t");
      for (const statement of [
        "SELECT * FROM hybrid_durable_test.instance;",
        `UPDATE hybrid_durable_test.instance SET state = ${quote({ phase: "idle", requested: 99, wake: 0 })};`,
        deliver("request"),
      ]) {
        const refused = await psql(`BEGIN; GRANT USAGE ON SCHEMA hybrid_durable_test TO observer;
          SET LOCAL ROLE observer; ${statement} ROLLBACK;`);
        assertEquals(refused.ok, false);
        assertStringIncludes(refused.err, "permission denied");
      }
    });
    await t.step("installing a private machine preserves public caller isolation settings", async () => {
      assertEquals(await sql(`SELECT bool_and(rolconfig @> ARRAY['default_transaction_isolation=read committed'])
        FROM pg_roles WHERE rolname IN ('app_user', 'service');`), "t");
    });
    await t.step("a private machine refuses steps outside serializable transactions", async () => {
      const refused = await psql(`BEGIN ISOLATION LEVEL READ COMMITTED; ${deliver("request")} COMMIT;`);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "step runs serializable");
    });
    await t.step("rolled-back entry leaves no invocation or queue delivery", async () => {
      const before = await snapshot();
      await sql(`BEGIN; ${deliver("request")} ROLLBACK;`);
      assertEquals(await snapshot(), before);
      await sql(deliver("request"));
      assertEquals(JSON.parse(await snapshot()).jobs, 1);
      await sql(deliver("invalidate"));
      assertEquals(JSON.parse(await snapshot()).jobs, 1);
    });
    await t.step("an outcome event cannot forge Durex's receipt", async () => {
      const before = await snapshot();
      const forged = await psql(deliver("done"));
      assertEquals(forged.ok, false);
      assertStringIncludes(forged.err, "requires its recorded outcome");
      assertEquals(await snapshot(), before);
    });
    await t.step("publication failure rolls back both outcome and machine completion", async () => {
      await sql(`INSERT INTO public.published VALUES ('${uuid(1)}');`);
      const before = await snapshot();
      const refused = await psql(`SELECT durex.settle_work('${uuid(1)}:1', 'done');`);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "duplicate key");
      assertEquals(await snapshot(), before);
      await sql("DELETE FROM public.published;");
    });
    await t.step("settlement publishes once and old receipts cannot complete a successor", async () => {
      await sql(`SELECT durex.settle_work('${uuid(1)}:1', 'done');`);
      const completed = JSON.parse(await snapshot());
      assertEquals(completed.state.phase, "idle");
      assertEquals(completed.outcomes, 1);
      assertEquals(completed.published, 1);
      await sql(deliver("request"));
      const next = await snapshot();
      await sql(`SELECT durex.settle_work('${uuid(1)}:1', 'done');`);
      assertEquals(await snapshot(), next);
      const stale = await psql(deliver("done"));
      assertEquals(stale.ok, false);
      assertStringIncludes(stale.err, "requires its recorded outcome");
      assertEquals(await snapshot(), next);
    });
    await t.step("an invocation retains its identity and reentry requires a fresh identity", async () => {
      const broken = structuredClone(spec);
      broken.machine.name = "durable_bad_key";
      broken.machine.states.idle.on.request.reduce = "keep";
      broken.machine.states.active.on.invalidate.reduce = "request";
      const emitted = await compileCortexDurable(broken, rules, terminal);
      await sql(`${emitted.sql}
        INSERT INTO hybrid_durable_bad_key.instance VALUES ('${uuid(2)}', 1, 0, ${quote({ phase: "idle", requested: 0, wake: 0 })});
        SELECT hybrid_durable_bad_key.deliver('${uuid(2)}', ${quote({ kind: "request", payload: {} })});`);
      const changed = await psql(`SELECT hybrid_durable_bad_key.deliver('${uuid(2)}', ${quote({ kind: "invalidate", payload: {} })});`);
      assertEquals(changed.ok, false);
      assertStringIncludes(changed.err, "retains its key");
      await sql(`SELECT durex.settle_work('${uuid(2)}:0', 'done');`);
      const reused = await psql(`SELECT hybrid_durable_bad_key.deliver('${uuid(2)}', ${quote({ kind: "request", payload: {} })});`);
      assertEquals(reused.ok, false);
      assertStringIncludes(reused.err, "requires a fresh key");
      assertEquals(await sql(`SELECT state->>'phase' FROM hybrid_durable_bad_key.instance WHERE id = '${uuid(2)}';`), "idle");
    });
  } finally {
    const stopped = await run("docker", ["stop", container]);
    if (!stopped.ok) throw new Error(stopped.err);
  }
} });
