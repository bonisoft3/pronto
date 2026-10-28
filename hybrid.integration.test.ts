import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";
import { compileHybrid } from "./hybrid.ts";
import { compileMechaPorts } from "./mecha-ports.ts";
import { type Catalog, CATALOG_SQL, unrecorded } from "./sql-recorded.ts";
import { executeHybrid } from "./hybrid-local.ts";
import { DATABASE, fixture, initial, quote, request, run, surface, terminal, uuid } from "./testdata/hybrid-fixtures.ts";

Deno.test({ name: "hybrid commands serialize, replay and preserve private projections in PostgreSQL", sanitizeOps: false, sanitizeResources: false, fn: async t => {
  const { spec, rules, compiled } = await fixture();
  const container = `pronto-hybrid-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=proof", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const stop = async () => {
    const stopped = await run("docker", ["stop", container]);
    if (!stopped.ok) throw new Error(stopped.err);
  };
  // As the gateway does: each transaction starts at the database's default,
  // read committed, and racing callers are ordered by the players they hold.
  const psql = (source: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-U", "postgres"], source);
  const sql = async (source: string) => {
    const result = await psql(source);
    if (result.ok) return result.out;
    throw new Error(result.err);
  };
  const schema = "hybrid_truco_turn";
  const seed = async (id: number, deadline = initial().deadline) => {
    const state = { ...initial(), deadline };
    await sql(`INSERT INTO ${schema}.instance VALUES ('${uuid(id)}', 1, 0, ${quote(state)});
      INSERT INTO ${schema}.member VALUES ('${uuid(id)}', '${uuid(1)}', 'a'), ('${uuid(id)}', '${uuid(2)}', 'b');`);
  };
  // A command is a row: inserting it dispatches it, and its receipt is read back off it.
  const call = (id: number, actor: number, command: number, req = request(0), name = "truco_turn") => `
    SET ROLE app_user;
    SET request.jwt.claims = '${JSON.stringify({ sub: uuid(actor) })}';
    INSERT INTO public.${name}_command (id, instance_id, request) VALUES ('${uuid(command)}', '${uuid(id)}', ${quote(req)}::text) ON CONFLICT DO NOTHING;
    SELECT jsonb_build_object('kind', outcome, 'reason', nullif(reason, ''), 'revision', revision::text) FROM public.${name}_command WHERE id = '${uuid(command)}';`;
  const snapshot = (id: number) => sql(`SELECT jsonb_build_object('state', state, 'revision', revision::text) FROM ${schema}.instance WHERE id = '${uuid(id)}';`);
  try {
    for (let i = 0; ; i++) {
      if ((await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok) break;
      if (i >= 60) throw new Error("hybrid PostgreSQL did not start");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await sql(`CREATE ROLE app_user; CREATE ROLE anon;
      CREATE OR REPLACE FUNCTION public.auth_uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid;
      $$;
      ${surface("truco_turn")}
      ${compiled.sql}`);

    await t.step("a machine's steps run read committed, and refuse to run otherwise", async () => {
      // A step holds its players before it locks a row, and reads what their
      // last step left once it has them: a snapshot taken before that wait
      // would not show it, so a step under one is refused.
      assertEquals((await sql("SELECT coalesce(array_to_string(setconfig, ','), '') FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'app_user';")).includes("default_transaction_isolation"), false);
      await seed(95);
      const refused = await psql(`SET default_transaction_isolation TO 'serializable'; ${call(95, 1, 195)}`);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "read committed");
    });

    // The clock and randomness were refused by a list of their spellings,
    // and CAST('now' AS timestamptz) was not on it. Postgres's parser reads
    // the SQL and its catalog says what each call and cast reads.
    await t.step("a step reads time and randomness only through its clock and draw, as Postgres reads its SQL", async () => {
      await sql("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
      const catalog = JSON.parse(await sql(CATALOG_SQL)) as Catalog;
      assertEquals(await unrecorded(compiled.sql, catalog), []);
      const read = async (body: string) => await unrecorded(compileMechaPorts({[spec.name]: {...spec, ports: {reads: {r: {params: [], returns: "jsonb", sql: body}}}}}), catalog);
      for (const [body, finding] of [
        ["SELECT to_jsonb(now())", "now(), the transaction's clock"],
        ["SELECT to_jsonb(statement_timestamp())", "statement_timestamp(), the transaction's clock"],
        ["SELECT to_jsonb(clock_timestamp())", "clock_timestamp(), which the catalog marks volatile"],
        ["SELECT to_jsonb(CURRENT_TIMESTAMP)", "CURRENT_TIMESTAMP, the transaction's clock"],
        ["SELECT to_jsonb(CAST('now' AS timestamptz))", "to timestamptz, whose input reads the session"],
        ["SELECT to_jsonb('today'::date)", "to date, whose input reads the session"],
        ["SELECT to_jsonb(gen_random_uuid())", "gen_random_uuid(), which the catalog marks volatile"],
        ["SELECT to_jsonb(random())", "random(), which the catalog marks volatile"],
        ["SELECT to_jsonb(pg_try_advisory_xact_lock(1))", "pg_try_advisory_xact_lock(), which the catalog marks volatile"],
        ["SELECT public.pg_advisory_xact_lock(1)", "public.pg_advisory_xact_lock(), which the catalog marks volatile"],
        ["SELECT to_jsonb(public.gen_random_bytes(4))", "public.gen_random_bytes(), which the catalog marks volatile"],
        ["SELECT to_jsonb(age(make_timestamp(2020, 1, 1, 0, 0, 0)))", "age(), the transaction's clock"],
        ["SELECT to_jsonb('now'::text::timestamptz)", "to timestamptz, whose input reads the session"],
        ["SELECT to_jsonb(timestamptz('now'))", "to timestamptz, whose input reads the session"],
        ["SELECT to_jsonb(('{\"at\":\"now\"}'::jsonb->>'at')::timestamptz)", "to timestamptz, whose input reads the session"],
      ] as const) {
        const found = await read(body);
        assertEquals(found.length, 1, `${body}: ${found.join("; ")}`);
        assertStringIncludes(found[0], finding);
      }
      const dynamic = await unrecorded("CREATE FUNCTION hybrid_truco_turn.f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'SELECT 1'; END; $f$;", catalog);
      assertEquals(dynamic.length, 1, dynamic.join("; "));
      assertStringIncludes(dynamic[0], "runs dynamic SQL");
      // What reads neither: immutable functions, and settings, which are not the clock.
      assertEquals(await read("SELECT jsonb_build_object('at', to_timestamp(1.5), 'role', current_setting('role'), 'n', abs(-1))"), []);
    });

    // The step's time was a setting any session could set, so a play long
    // past its deadline could claim a time before it and be recorded at it.
    await t.step("a session cannot set the time a step is given", async () => {
      await seed(96);
      const forged = JSON.parse(await sql(`SET mecha.now = '9007199254740991'; ${call(96, 1, 196)}`));
      assertEquals(forged.kind, "accepted", "the deadline is judged on the transaction's own time");
      const now = Number(await sql(`SELECT now FROM ${schema}.receipt WHERE instance_id = '${uuid(96)}' AND command_id = '${uuid(196)}';`));
      assert(Math.abs(now - Date.now()) < 60000, "the receipt records the transaction's time");
    });

    await t.step("one command and all player views commit together", async () => {
      await seed(10);
      const answer = JSON.parse(await sql(call(10, 1, 100)));
      assertEquals(answer.kind, "accepted");
      assertEquals(answer.revision, "1");
      const actual = JSON.parse(await snapshot(10));
      // The step replays from its receipt: the request and the time it was given.
      const now = Number(await sql(`SELECT now FROM ${schema}.receipt WHERE instance_id = '${uuid(10)}' AND command_id = '${uuid(100)}';`));
      const context = { actor: "a", tier: "omnishell", now };
      const expected = await executeHybrid(compiled.source, spec.fuel, { state: initial(), event: request(0).event, context, viewers: ["a", "b"] }) as { state: unknown; views: unknown };
      assertEquals(actual.state, expected.state);
      const views = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('viewer', v.seat, 'value', v.view::jsonb) ORDER BY v.seat)
        FROM public.truco_turn_seat v WHERE instance_id = '${uuid(10)}';`));
      assertEquals(views, expected.views);
    });

    await t.step("a resent command is the row already there, and applies no second move", async () => {
      const before = await snapshot(10);
      const answer = await sql(call(10, 1, 100));
      assertEquals(JSON.parse(answer).kind, "accepted");
      assertEquals(await snapshot(10), before);
      // The key is the command's identity: a body resent under it changes nothing.
      assertEquals(JSON.parse(await sql(call(10, 1, 100, request(0, "play", { card: 1 })))).kind, "accepted");
      assertEquals(await snapshot(10), before);
      assertEquals(await sql(`SELECT count(*) FROM ${schema}.receipt WHERE instance_id = '${uuid(10)}';`), "1");
    });

    await t.step("replacing machine code preserves instances and refuses a protocol change", async () => {
      const before = await snapshot(10);
      await sql(compiled.sql);
      assertEquals(await snapshot(10), before);
      const changed = await compileHybrid({ ...spec, version: spec.version + 1 }, rules, terminal);
      const refused = await psql(changed.sql);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "another protocol");
      assertEquals(await snapshot(10), before);
    });

    await t.step("database checks refuse in order and a passing guard applies the move", async () => {
      const checks = [0, 1].map((card) => ({
        sql: `(request->'event'->'payload'->>'card')::integer > ${card}`,
        reason: card === 0 ? "first_check" : "second_check",
      }));
      const checked = await compileHybrid({ ...spec, name: "truco_checks", mecha: {
        locks: "", transitions: [{ phase: "playing", event: "play", requires: checks, sql: "NULL;" }],
      } }, rules, terminal);
      await sql(`${surface("truco_checks")} ${checked.sql}`);
      for (const card of [0, 1, 2]) {
        const id = uuid(800 + card);
        await sql(`INSERT INTO hybrid_truco_checks.instance VALUES ('${id}', 1, 0, ${quote(initial())});
          INSERT INTO hybrid_truco_checks.member VALUES ('${id}', '${uuid(1)}', 'a'), ('${id}', '${uuid(2)}', 'b');`);
        const answer = JSON.parse(await sql(call(800 + card, 1, 900 + card, request(0, "play", { card }), "truco_checks")));
        assertEquals([answer.kind, answer.reason], card < 2 ? ["rejected", checks[card].reason] : ["accepted", null]);
        assertEquals(await sql(`SELECT revision FROM hybrid_truco_checks.instance WHERE id = '${id}';`), card < 2 ? "0" : "1");
      }
    });

    await t.step("two tabs race at one revision and only one move commits", async () => {
      await seed(11);
      const answers = await Promise.all([sql(call(11, 1, 101)), sql(call(11, 1, 102, request(0, "play", { card: 1 })))]);
      assertEquals(answers.map(v => JSON.parse(v).kind).sort(), ["accepted", "rejected"]);
      assertEquals(JSON.parse(answers.find(v => JSON.parse(v).kind === "rejected")!).reason, "stale_revision");
      const game = JSON.parse(await snapshot(11));
      assertEquals(game.revision, "1");
      assertEquals(game.state.plays.length, 1);
    });

    await t.step("simultaneous duplicate requests receive the same committed receipt", async () => {
      await seed(12);
      const answers = await Promise.all([sql(call(12, 1, 103)), sql(call(12, 1, 103))]);
      assertEquals(answers[0], answers[1]);
      assertEquals(JSON.parse(await snapshot(12)).revision, "1");
    });

    await t.step("a pooled backend can execute successive commands after SES lockdown", async () => {
      await seed(17);
      const answers = (await sql(`${call(17, 1, 130)} ${call(17, 2, 131, request(1, "play", { card: 3 }))}`)).split("\n").map(v => JSON.parse(v));
      assertEquals(answers.map(v => v.kind), ["accepted", "accepted"]);
      assertEquals(answers.map(v => v.revision), ["1", "2"]);
    });

    await t.step("wrong turn and card refusals are durable, without a hand[0] substitution", async () => {
      await seed(13);
      const before = await snapshot(13);
      assertEquals(JSON.parse(await sql(call(13, 2, 104, request(0, "play", { card: 3 })))).reason, "not_your_turn");
      assertEquals(JSON.parse(await sql(call(13, 1, 105, request(0, "play", { card: 3 })))).reason, "not_your_card");
      assertEquals(await snapshot(13), before);
      assertEquals(await sql(`SELECT count(*) FROM ${schema}.receipt WHERE instance_id = '${uuid(13)}';`), "2");
    });

    await t.step("a client cannot forge a timer, seat, canonical state or another private view", async () => {
      const outsider = await psql(call(13, 3, 106));
      assertEquals(outsider.ok, false);
      assertStringIncludes(outsider.err, "not a member");
      const timer = await psql(call(13, 1, 107, request(0, "timeout", {})));
      assertEquals(timer.ok, false);
      assertStringIncludes(timer.err, "another tier");
      const spoof = await psql(call(13, 1, 108, request(0, "play", { card: 0, actor: "b" })));
      assertEquals(spoof.ok, false);
      assertStringIncludes(spoof.err, "undeclared field");
      for (const query of [`SELECT * FROM ${schema}.instance`, `SELECT * FROM ${schema}.receipt`, `UPDATE ${schema}.instance SET revision=99`, `SELECT ${schema}.step('{}')`, `UPDATE public.truco_turn_seat SET revision = 99`]) {
        const denied = await psql(`SET ROLE app_user; ${query};`);
        assertEquals(denied.ok, false);
        assertStringIncludes(denied.err, "permission denied");
      }
      const view = JSON.parse(await sql(`SELECT view FROM public.truco_turn_seat WHERE instance_id = '${uuid(10)}' AND actor = '${uuid(1)}';`));
      assertEquals(view.hand, [1, 2]);
      assertEquals(view.b, undefined);
      assertEquals(await sql(`SELECT count(*) FROM public.truco_turn_seat WHERE instance_id = '${uuid(10)}' AND actor = '${uuid(3)}';`), "0");
    });

    await t.step("expired moves cannot beat a delayed ticker and duplicate wakes cannot affect the next turn", async () => {
      await seed(14, 0);
      assertEquals(JSON.parse(await sql(call(14, 1, 109))).reason, "expired");
      const tick = `SELECT ${schema}.dispatch('${uuid(14)}', '${uuid(0)}', '110', ${quote(request(0, "timeout", {}))}, 'mecha');`;
      assertEquals(JSON.parse(await sql(tick)).kind, "accepted");
      const before = await snapshot(14);
      assertEquals(JSON.parse(await sql(tick)).kind, "accepted");
      assertEquals(await snapshot(14), before);
      assertEquals(JSON.parse(await sql(`SELECT ${schema}.dispatch('${uuid(14)}', '${uuid(0)}', '111', ${quote(request(0, "timeout", {}))}, 'mecha');`)).reason, "stale_revision");
    });

    await t.step("a concurrent expired play and timer settle only the timeout move", async () => {
      await seed(18, 0);
      const [play, tick] = await Promise.all([
        sql(call(18, 1, 132)),
        sql(`SELECT ${schema}.dispatch('${uuid(18)}', '${uuid(0)}', '133', ${quote(request(0, "timeout", {}))}, 'mecha');`),
      ]);
      assertEquals(JSON.parse(play).kind, "rejected");
      assertEquals(JSON.parse(tick).kind, "accepted");
      const game = JSON.parse(await snapshot(18));
      assertEquals(game.revision, "1");
      assertEquals(game.state.plays, [{ seat: "a", card: 0 }]);
    });

    await t.step("rollback leaves no state, view or receipt and the same id remains retryable", async () => {
      await seed(15);
      await sql(`BEGIN; ${call(15, 1, 112)} ROLLBACK;`);
      assertEquals(JSON.parse(await snapshot(15)).revision, "0");
      assertEquals(await sql(`SELECT (SELECT count(*) FROM public.truco_turn_seat WHERE instance_id = '${uuid(15)}') + (SELECT count(*) FROM public.truco_turn_command WHERE instance_id = '${uuid(15)}') + (SELECT count(*) FROM ${schema}.receipt WHERE instance_id = '${uuid(15)}');`), "0");
      assertEquals(JSON.parse(await sql(call(15, 1, 112))).kind, "accepted");
    });

    await t.step("all six plays remain in one phase and the explicit final transition rejects later play", async () => {
      await seed(16);
      let previous = initial();
      for (const [i, card] of [0, 3, 1, 4, 2, 5].entries()) {
        assertEquals(JSON.parse(await sql(call(16, i % 2 + 1, 120 + i, request(i, "play", { card })))).kind, "accepted");
        const game = JSON.parse(await snapshot(16));
        const expected = await executeHybrid(compiled.source, spec.fuel, {
          state: previous, event: request(i, "play", { card }).event,
          context: { actor: i % 2 === 0 ? "a" : "b", tier: "omnishell", now: game.state.deadline - 20000 }, viewers: ["a", "b"],
        }) as { state: ReturnType<typeof initial> };
        assertEquals(game.state, expected.state);
        previous = game.state;
      }
      const finish = `SELECT ${schema}.dispatch('${uuid(16)}', '${uuid(0)}', '126', ${quote(request(6, "finish", {}))}, 'mecha');`;
      assertEquals(JSON.parse(await sql(finish)).kind, "accepted");
      assertEquals(JSON.parse(await sql(call(16, 1, 127, request(7)))).reason, "illegal_event");
      assertEquals(JSON.parse(await snapshot(16)).state.phase, "finished");
    });

    await t.step("PLV8 uses the same cage and refuses computed ambient authority", async () => {
      for (const [name, expression] of Object.entries({ random: "Math['random']()", database: "({}).constructor.constructor('return plv8')()" })) {
        const altered = await compileHybrid({ ...spec, name: `truco_${name}` }, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", `play: () => ${expression}`), terminal);
        await sql(`${surface(`truco_${name}`)} ${altered.sql}`);
        const input = { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] };
        const failure = await psql(`SELECT hybrid_truco_${name}.step(${quote(input)});`);
        assertEquals(failure.ok, false);
        assertStringIncludes(failure.err, "ERROR:");
      }
    });

    await t.step("bounded Mecha actions reuse native invocation and its transactional Airlock claim", async () => {
      // The fixture's transition is replaced, not unified with: a value CUE
      // cannot unify is the machine as data, read into its reducer anew.
      const base = await run("cue", ["export", "./apps/truco/tests/fixtures/hybrid", "-e", "machine"]);
      if (!base.ok) throw new Error(base.err);
      const machine = JSON.parse(base.out);
      machine.config.states.playing.on.play.actions = ["play", "charge"];
      machine.setup.actions.charge = [{effect: {
        op: "update", schema: "public", table: "payment", values: {status: "charging"}, rawWhere: "id = game.id",
      }}];
      const declaration = await run("cue", ["export", "-", "-e", "reducer"],
        `package proof\nimport pronto "bonisoft.org/plugins/pronto"\nreducer: (pronto.#Reducer & {machine: ${JSON.stringify(machine)}}).out\n`);
      if (!declaration.ok) throw new Error(declaration.err);
      const composed = await compileHybrid({...JSON.parse(declaration.out), name: "effect_turn"}, rules, terminal);
      const files = await emitFiles(paymentProgram());
      await sql(`CREATE ROLE electric;
        CREATE SCHEMA graphile_worker;
        CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
        CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
          run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
          flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
          $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
        CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text);
        ${await Deno.readTextFile(new URL("../../libraries/mecha/services/ticker/schedule.sql", import.meta.url))}
        ${await Deno.readTextFile(new URL("../../libraries/mecha/services/airlock/airlock.sql", import.meta.url))}
        ${files["services/database/migrations/010_machines.sql"].text}
        ${surface("effect_turn")}
        ${composed.sql}
        INSERT INTO payment VALUES ('${uuid(90)}', 'pending', 12.50, NULL);
        INSERT INTO hybrid_effect_turn.instance VALUES ('${uuid(90)}', 1, 0, ${quote(initial())});
        INSERT INTO hybrid_effect_turn.member VALUES ('${uuid(90)}', '${uuid(1)}', 'a'), ('${uuid(90)}', '${uuid(2)}', 'b');`);
      const invoke = call(90, 1, 190, request(0), "effect_turn");
      const counts = `SELECT (SELECT count(*) FROM airlock.external_effect_ledger) || ',' || (SELECT count(*) FROM graphile_worker.added);`;
      await sql(`BEGIN; ${invoke} ROLLBACK;`);
      assertEquals(await sql(counts), "0,0");
      assertEquals(await sql(`SELECT status FROM payment WHERE id = '${uuid(90)}';`), "pending");
      const accepted = await sql(invoke);
      assertEquals(JSON.parse(accepted).kind, "accepted");
      assertEquals(await sql(counts), "1,1");
      assertEquals(await sql(invoke), accepted);
      assertEquals(await sql(counts), "1,1");
      assertEquals(await sql(`SELECT status FROM payment WHERE id = '${uuid(90)}';`), "charging");
    });

    await t.step("runaway reducer is terminated by the shared deterministic fuel limit", async () => {
      const altered = await compileHybrid({ ...spec, name: "truco_spin" }, rules.replace("play: (state, event, context) => putCard(state, event.payload.card, context.now)", "play: () => { while (true) {} }"), terminal);
      await sql(`${surface("truco_spin")} ${altered.sql}`);
      const input = { state: initial(), event: request(0).event, context: { actor: "a", tier: "omnishell", now: 0 }, viewers: ["a"] };
      const start = performance.now();
      const failure = await psql(`SELECT hybrid_truco_spin.step(${quote(input)});`);
      assertEquals(failure.ok, false);
      assert(performance.now() - start < 10000, "PLV8 reducer did not terminate within its budget");
      assertStringIncludes(failure.err.toLowerCase(), "fuel exhausted");
      assertEquals(await sql("SELECT 1"), "1");
    });
  } finally {
    await stop();
  }
} });
