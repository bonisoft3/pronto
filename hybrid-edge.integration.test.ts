// The hybrid oracle (hybrid.integration.test.ts) against the edge object: the
// same machine, its migration applied to a data directory as an edge release
// applies it (the plv8 engine fenced away), stepping through pgl_step into
// the machines edge-machines.ts renders, in a Durable Object under wrangler
// dev. Needs libraries/mecha/packages/pglite-workerd/dist.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { compileHybrid } from "./hybrid.ts";
import { compileMechaPorts } from "./mecha-ports.ts";
import { executeHybrid } from "./hybrid-local.ts";
import { renderMachines } from "./bundle/edge-machines.ts";
import { ROOT, fixture, initial, quote, request, run, surface, terminal, uuid } from "./testdata/hybrid-fixtures.ts";
import { startWorker } from "../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts";
import { load } from "../../libraries/mecha/packages/pglite-workerd/load.ts";
import { browserTier } from "../../libraries/mecha/packages/mecha-browser/fence.ts";

const root = new URL(ROOT).pathname;
const mecha = `${root}libraries/mecha`;

Deno.test({ name: "hybrid commands step in the edge object, and its alarm wakes a deadline", sanitizeOps: false, sanitizeResources: false, fn: async t => {
  Deno.statSync(`${mecha}/packages/pglite-workerd/dist/pglite.wasm`);
  const { spec, rules, compiled } = await fixture();
  const spin = await compileHybrid({ ...spec, name: "truco_spin" }, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: () => { while (true) {} }"), terminal);
  const schema = "hybrid_truco_turn";
  const tmp = await Deno.makeTempDir({ prefix: "pronto-hybrid-edge-" });

  // The app's rules, where the release reads them.
  await Deno.mkdir(`${tmp}/app/machines`, { recursive: true });
  await Deno.copyFile(`${root}apps/truco/tests/fixtures/hybrid/turn.js`, `${tmp}/app/machines/turn.js`);
  await Deno.writeTextFile(`${tmp}/app/machines/spin.js`, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: () => { while (true) {} }"));

  // The data directory, as pgdata.ts builds one: PostgreSQL's roles and
  // tenancy floor, the ticker's tables a timed machine shares, the surface,
  // the migration with its container-tier engine fenced away, and the wake
  // port a deadline arms through.
  const timers = (await Deno.readTextFile(`${mecha}/services/ticker/schedule.sql`)) + "\n" + (await Deno.readTextFile(`${mecha}/services/ticker/machine-timers.sql`));
  const ports = compileMechaPorts({ truco_turn: { ...spec, ports: { wake: { phases: ["playing"], deadline: "deadline", event: "timeout" } } } });
  const seedSql = `CREATE ROLE anon; CREATE ROLE app_user; CREATE ROLE service NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, app_user, service;
    ${await Deno.readTextFile(`${mecha}/services/database/rls/rls.sql`)}
    ${timers}
    GRANT SELECT, INSERT, UPDATE ON public.machine_timer_tick TO service;
    ${surface("truco_turn")}
    ${surface("truco_spin")}
    ${browserTier(compiled.sql)}
    ${browserTier(spin.sql)}
    ${browserTier(ports)}`;
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

  // The Worker: the edge object over the machines the release renders, with
  // a SQL door for the oracle's statements and a hand on the alarm.
  await Deno.mkdir(`${tmp}/worker`);
  await Deno.writeTextFile(`${tmp}/worker/machines.js`, await renderMachines("proof", `${tmp}/app`, `${root}plugins/omnishell`, {
    truco_turn: { reducer: spec as unknown as Record<string, unknown> & { name: string; fuel: number }, rules: "machines/turn.js" },
    truco_spin: { reducer: { ...spec, name: "truco_spin" } as unknown as Record<string, unknown> & { name: string; fuel: number }, rules: "machines/spin.js" },
  }));
  const edge = `${mecha}/packages/mecha-edge/src`;
  const dist = `${mecha}/packages/pglite-workerd/dist`;
  await Deno.writeTextFile(`${tmp}/worker/worker.ts`, `
    import { edgeObject } from '${edge}/object.ts'
    import { edgeWorker } from '${edge}/worker.ts'
    import machines from './machines.js'
    import pgliteWasm from '${dist}/pglite.wasm'
    import initdbWasm from '${dist}/initdb.wasm'
    import pgliteData from '${dist}/pglite.data'
    import icu from '${dist}/icu-root.tgz'
    const Base = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: [], machines })
    export class Cluster extends Base {
      override async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/test/sql') {
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
        if (path === '/test/rearm') { await this.rearm(); return Response.json({ alarm: await this.ctx.storage.getAlarm() }) }
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
    name: "pronto-hybrid-edge-test",
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
  // The oracle's psql: a statement list, its last rows, or the error it died on.
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
  const seed = async (id: number, deadline = initial().deadline) => {
    const state = { ...initial(), deadline };
    await sql(`INSERT INTO ${schema}.instance VALUES ('${uuid(id)}', 1, 0, ${quote(state)});
      INSERT INTO ${schema}.member VALUES ('${uuid(id)}', '${uuid(1)}', 'a'), ('${uuid(id)}', '${uuid(2)}', 'b');`);
  };
  // As the gateway does: the role and claims last the request's transaction.
  const call = (id: number, actor: number, command: number, req = request(0), name = "truco_turn") => `
    BEGIN;
    SET LOCAL ROLE app_user;
    SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: uuid(actor) })}', true);
    INSERT INTO public.${name}_command (id, instance_id, request) VALUES ('${uuid(command)}', '${uuid(id)}', ${quote(req)}::text) ON CONFLICT DO NOTHING;
    SELECT jsonb_build_object('kind', outcome, 'reason', nullif(reason, ''), 'revision', revision::text) AS answer FROM public.${name}_command WHERE id = '${uuid(command)}';
    COMMIT;`;
  const answer = async (source: string) => (await one(source)) as { kind: string; reason?: string; revision: string };
  const snapshot = async (id: number) => (await one(`SELECT jsonb_build_object('state', state, 'revision', revision::text) FROM ${schema}.instance WHERE id = '${uuid(id)}';`)) as { state: ReturnType<typeof initial>; revision: string };

  try {
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: "Bearer test-import" } }), { log: () => {} });

    await t.step("the object supplies the engine the migration left to the tier", async () => {
      assertEquals(await one(`SELECT (SELECT lanname FROM pg_language WHERE oid = prolang) FROM pg_proc WHERE oid = '${schema}.engine(jsonb)'::regprocedure;`), "sql");
      assertEquals(await one(`SELECT (SELECT lanname FROM pg_language WHERE oid = prolang) FROM pg_proc WHERE oid = 'public.pgl_step(text, jsonb)'::regprocedure;`), "c");
      assertEquals(await one("SHOW default_transaction_isolation;"), "serializable");
    });

    await t.step("a machine's steps run serializable, and refuse to run otherwise", async () => {
      await seed(95);
      await sql("SET default_transaction_isolation TO 'read committed';");
      const refused = await psql(call(95, 1, 195));
      await sql("SET default_transaction_isolation TO 'serializable';");
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "serializable");
    });

    await t.step("one command and all player views commit together", async () => {
      await seed(10);
      const first = await answer(call(10, 1, 100));
      assertEquals(first.kind, "accepted");
      assertEquals(first.revision, "1");
      const actual = await snapshot(10);
      const now = Number(await one(`SELECT now FROM ${schema}.receipt WHERE instance_id = '${uuid(10)}' AND command_id = '${uuid(100)}';`));
      const context = { actor: "a", tier: "omnishell", now };
      const expected = await executeHybrid(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context, viewers: ["a", "b"] }) as { state: unknown; views: unknown };
      assertEquals(actual.state, expected.state);
      const views = await one(`SELECT jsonb_agg(jsonb_build_object('viewer', v.seat, 'value', v.view::jsonb) ORDER BY v.seat)
        FROM public.truco_turn_seat v WHERE instance_id = '${uuid(10)}';`);
      assertEquals(views, expected.views);
    });

    await t.step("a resent command is the row already there, and applies no second move", async () => {
      const before = await snapshot(10);
      assertEquals((await answer(call(10, 1, 100))).kind, "accepted");
      assertEquals(await snapshot(10), before);
      assertEquals((await answer(call(10, 1, 100, request(0, "play", { card: 1 })))).kind, "accepted");
      assertEquals(await snapshot(10), before);
      assertEquals(Number(await one(`SELECT count(*) FROM ${schema}.receipt WHERE instance_id = '${uuid(10)}';`)), 1);
    });

    await t.step("two tabs race at one revision and only one move commits", async () => {
      await seed(11);
      const answers = await Promise.all([answer(call(11, 1, 101)), answer(call(11, 1, 102, request(0, "play", { card: 1 })))]);
      assertEquals(answers.map(v => v.kind).sort(), ["accepted", "rejected"]);
      assertEquals(answers.find(v => v.kind === "rejected")!.reason, "stale_revision");
      const game = await snapshot(11);
      assertEquals(game.revision, "1");
      assertEquals(game.state.plays.length, 1);
    });

    await t.step("wrong turn and card refusals are durable", async () => {
      await seed(13);
      const before = await snapshot(13);
      assertEquals((await answer(call(13, 2, 104, request(0, "play", { card: 3 })))).reason, "not_your_turn");
      assertEquals((await answer(call(13, 1, 105, request(0, "play", { card: 3 })))).reason, "not_your_card");
      assertEquals(await snapshot(13), before);
      assertEquals(Number(await one(`SELECT count(*) FROM ${schema}.receipt WHERE instance_id = '${uuid(13)}';`)), 2);
    });

    await t.step("a client cannot forge a timer, seat, canonical state or another private view", async () => {
      const outsider = await psql(call(13, 3, 106));
      assertEquals(outsider.ok, false);
      assertStringIncludes(outsider.err, "not a member");
      // A step the rules refuse crosses back through pgl_step as the error
      // the command's transaction aborts on, as plv8 raises it.
      const timer = await psql(call(13, 1, 107, request(0, "timeout", {})));
      assertEquals(timer.ok, false);
      assertStringIncludes(timer.err, "another tier");
      const spoof = await psql(call(13, 1, 108, request(0, "play", { card: 0, actor: "b" })));
      assertEquals(spoof.ok, false);
      assertStringIncludes(spoof.err, "undeclared field");
      for (const query of [`SELECT * FROM ${schema}.instance`, `SELECT * FROM ${schema}.receipt`, `UPDATE ${schema}.instance SET revision=99`, `SELECT ${schema}.step('{}')`, `SELECT public.pgl_step('truco_turn', '{}')`, `UPDATE public.truco_turn_seat SET view = '{}'`]) {
        const denied = await psql(`BEGIN; SET LOCAL ROLE app_user; ${query}; COMMIT;`);
        assertEquals(denied.ok, false, query);
        assertStringIncludes(denied.err, "permission denied");
      }
      const view = await one(`SELECT view::jsonb FROM public.truco_turn_seat WHERE instance_id = '${uuid(10)}' AND actor = '${uuid(1)}';`) as { hand: number[]; b?: unknown };
      assertEquals(view.hand, [1, 2]);
      assertEquals(view.b, undefined);
    });

    await t.step("expired moves cannot beat a delayed ticker and duplicate wakes cannot affect the next turn", async () => {
      await seed(14, 0);
      assertEquals((await answer(call(14, 1, 109))).reason, "expired");
      const tick = `SELECT ${schema}.dispatch('${uuid(14)}', '${uuid(0)}', '110', ${quote(request(0, "timeout", {}))}, 'mecha');`;
      assertEquals((await answer(tick)).kind, "accepted");
      const before = await snapshot(14);
      assertEquals((await answer(tick)).kind, "accepted");
      assertEquals(await snapshot(14), before);
      assertEquals((await answer(`SELECT ${schema}.dispatch('${uuid(14)}', '${uuid(0)}', '111', ${quote(request(0, "timeout", {}))}, 'mecha');`)).reason, "stale_revision");
    });

    await t.step("rollback leaves no state, view or receipt and the same id remains retryable", async () => {
      await seed(15);
      await sql(`${call(15, 1, 112).replace(/COMMIT;\s*$/, "ROLLBACK;")}`);
      assertEquals((await snapshot(15)).revision, "0");
      assertEquals(Number(await one(`SELECT (SELECT count(*) FROM public.truco_turn_seat WHERE instance_id = '${uuid(15)}') + (SELECT count(*) FROM public.truco_turn_command WHERE instance_id = '${uuid(15)}') + (SELECT count(*) FROM ${schema}.receipt WHERE instance_id = '${uuid(15)}');`)), 0);
      assertEquals((await answer(call(15, 1, 112))).kind, "accepted");
    });

    await t.step("all six plays remain in one phase and the explicit final transition rejects later play", async () => {
      await seed(16);
      let previous = initial();
      for (const [i, card] of [0, 3, 1, 4, 2, 5].entries()) {
        assertEquals((await answer(call(16, i % 2 + 1, 120 + i, request(i, "play", { card })))).kind, "accepted");
        const game = await snapshot(16);
        const expected = await executeHybrid(compiled.source, spec.fuel, {
          state: previous, event: request(i, "play", { card }).event,
          context: { actor: i % 2 === 0 ? "a" : "b", tier: "omnishell", now: game.state.deadline - 20000 }, viewers: ["a", "b"],
        }) as { state: ReturnType<typeof initial> };
        assertEquals(game.state, expected.state);
        previous = game.state;
      }
      const finish = `SELECT ${schema}.dispatch('${uuid(16)}', '${uuid(0)}', '126', ${quote(request(6, "finish", {}))}, 'mecha');`;
      assertEquals((await answer(finish)).kind, "accepted");
      assertEquals((await answer(call(16, 1, 127, request(7)))).reason, "illegal_event");
      assertEquals((await snapshot(16)).state.phase, "finished");
    });

    await t.step("a runaway reducer is terminated by the same fuel limit, and the object answers on", async () => {
      const input = { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] };
      const start = performance.now();
      const failure = await psql(`SELECT hybrid_truco_spin.step(${quote(input)});`);
      assertEquals(failure.ok, false);
      assert(performance.now() - start < 10000, "the edge reducer did not terminate within its budget");
      assertStringIncludes(failure.err.toLowerCase(), "fuel exhausted");
      assertEquals(Number(await one("SELECT 1")), 1);
    });

    await t.step("a deadline a machine arms is the object's alarm, and the tick it fires wakes the instance", async () => {
      const deadline = Date.now() + 1500;
      await seed(17, deadline);
      await sql(`SELECT ${schema}.arm(i) FROM ${schema}.instance i WHERE i.id = '${uuid(17)}';`);
      assertEquals(Number(await one(`SELECT count(*) FROM public.schedule WHERE emits_entity = 'machine_timer_tick';`)), 1);
      const { alarm } = await (await fetch(at("/test/rearm"))).json() as { alarm: number | null };
      assert(alarm !== null && alarm >= deadline && alarm < deadline + 1000, `the alarm stands at the deadline: ${alarm} for ${deadline}`);
      let game = await snapshot(17);
      for (let i = 0; game.revision === "0" && i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        game = await snapshot(17);
      }
      assertEquals(game.revision, "1", "the alarm's tick stepped the instance");
      assertEquals(game.state.plays, [{ seat: "a", card: 0 }], "the timeout played the lowest card");
      assertEquals(Number(await one(`SELECT count(*) FROM public.schedule;`)), 0, "the fire took the schedule");
      assertEquals(Number(await one(`SELECT count(*) FROM public.machine_timer_tick WHERE caller = 'alarm';`)), 1);
    });
  } finally {
    await worker.stop();
  }
} });
