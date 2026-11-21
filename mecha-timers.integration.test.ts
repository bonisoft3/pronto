import { assert, assertEquals } from "jsr:@std/assert@1.0.11";
import { compileMechaPorts } from "./mecha-ports.ts";
import { type Catalog, CATALOG_SQL, unrecorded } from "./sql-recorded.ts";
import { DATABASE, nestedFixture, quote, run, surface, timerFixture, uuid } from "./mecha-fixtures.ts";

// XState v5's `after`, kept by the ticker: entering a state arms a one-shot
// schedule per delay, measured from the step's time; leaving it deletes them;
// a step that stays without re-entering moves nothing, and `reenter: true`
// arms them again. The tick delivers the delay's event at the instant the
// ticker decided it, or later, never earlier.
Deno.test({ name: "a state's after is the ticker's: armed at entry, cancelled at exit, fired at its decision time", sanitizeOps: false, sanitizeResources: false, fn: async t => {
  const { spec, compiled } = await timerFixture();
  const container = `pronto-mecha-timers-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=proof", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (source: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-U", "postgres"], source);
  const sql = async (source: string) => {
    const result = await psql(source);
    if (result.ok) return result.out;
    throw new Error(result.err);
  };
  const schema = "hybrid_proof_clock";
  const spawn = (id: number, at: number | null = null) => sql(`SELECT ${schema}.spawn('${uuid(id)}', '{"turn_ms": 20000}'::jsonb, '{"a": "${uuid(1)}"}'::jsonb, ${at ?? "NULL"});`);
  const send = async (id: number, kind: string, command: string) => {
    const revision = await sql(`SELECT revision FROM ${schema}.instance WHERE id = '${uuid(id)}';`);
    return JSON.parse(await sql(`SELECT ${schema}.dispatch('${uuid(id)}', '${uuid(1)}', '${command}', ${quote({ version: 1, expected_revision: revision, event: { kind, payload: {} } })}, 'omnishell');`));
  };
  // The instance's schedules: each one's name and the instant it is due, in ms.
  const timers = async (id: number) => JSON.parse(await sql(`SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'due', round(extract(epoch FROM due_at) * 1000)::bigint,
    'values', emits_values) ORDER BY name), '[]') FROM public.schedule WHERE emits_values @> jsonb_build_object('row', jsonb_build_object('id', '${uuid(id)}'));`)) as { name: string; due: number; values: Record<string, unknown> }[];
  const instance = async (id: number) => JSON.parse(await sql(`SELECT jsonb_build_object('state', state, 'revision', revision) FROM ${schema}.instance WHERE id = '${uuid(id)}';`)) as { state: { phase: string; count: number; expired_at: number }; revision: number };
  const stepped = async (id: number, command: string) => Number(await sql(`SELECT now FROM ${schema}.receipt WHERE instance_id = '${uuid(id)}' AND command_id = '${command}';`));
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  // What the ticker writes for an instance's schedule it found due at `at`.
  const tick = (id: number, name: string, at: string, late = false) => sql(`INSERT INTO public.machine_timer_tick (id, schedule, tick_at, late, machine, "row", state, delay)
    VALUES (gen_random_uuid(), ${literal(name)}, ${at}, ${late}, 'proof_clock', jsonb_build_object('id', '${uuid(id)}'), 'running', 'turn');`);
  try {
    for (let i = 0; ; i++) {
      if ((await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok) break;
      if (i >= 60) throw new Error("mecha PostgreSQL did not start");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const ticker = new URL("../../libraries/mecha/services/ticker/", import.meta.url);
    await sql(`CREATE ROLE app_user; CREATE ROLE anon;
      CREATE OR REPLACE FUNCTION public.auth_uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid;
      $$;
      ${await Deno.readTextFile(new URL("schedule.sql", ticker))}
      ${await Deno.readTextFile(new URL("machine-timers.sql", ticker))}
      ${surface("proof_clock")}
      ${compiled.sql}
      ${compileMechaPorts({ [spec.name]: spec })}`);

    await t.step("arming and firing read time only through the machine's clock and the tick", async () => {
      const catalog = JSON.parse(await sql(CATALOG_SQL)) as Catalog;
      assertEquals(await unrecorded(`${compiled.sql}\n${compileMechaPorts({ [spec.name]: spec })}`, catalog), []);
    });

    await t.step("creation enters the initial state, which arms its timer from the instant it was created", async () => {
      await spawn(1, 1000);
      const [armed] = await timers(1);
      assertEquals(armed.due, 21000);
      assertEquals(armed.values, { machine: "proof_clock", row: { id: uuid(1) }, state: "running", delay: "turn" });
    });

    await t.step("a step that stays without re-entering moves no timer, and reenter: true starts it again", async () => {
      const before = await timers(1);
      assertEquals((await send(1, "nudge", "n")).kind, "accepted");
      assertEquals((await send(1, "stay", "s")).kind, "accepted");
      assertEquals(await timers(1), before, "a targetless step and a target without reenter both leave the timer where it was");
      assertEquals((await send(1, "restart", "r")).kind, "accepted");
      const [restarted] = await timers(1);
      assertEquals(restarted.due, await stepped(1, "r") + 20000, "the timer runs from the step that re-entered");
      assert(restarted.name !== before[0].name, "a new entry is a new schedule");
    });

    await t.step("exit cancels the timer, and entering again arms it", async () => {
      assertEquals((await send(1, "stop", "x")).kind, "accepted");
      assertEquals(await timers(1), []);
      assertEquals((await send(1, "start", "y")).kind, "accepted");
      const [armed] = await timers(1);
      assertEquals(armed.due, await stepped(1, "y") + 20000);
    });

    await t.step("a tick for a cancelled timer delivers nothing", async () => {
      await spawn(2);
      const [first] = await timers(2);
      await send(2, "restart", "r");
      const { revision } = await instance(2);
      await tick(2, first.name, "clock_timestamp()");
      assertEquals((await instance(2)).revision, revision, "the restart cancelled the schedule the tick names");
      assertEquals((await timers(2)).length, 1);
      await tick(2, (await timers(2))[0].name, "clock_timestamp()", true);
      assertEquals((await instance(2)).revision, revision, "a tick the ticker marked late asks for nothing");
    });

    await t.step("a tick runs the delayed transition at the instant the ticker decided it, never before", async () => {
      // On time: the step is the tick's.
      await spawn(3);
      const [due] = await timers(3);
      await tick(3, due.name, `to_timestamp(${due.due} / 1000.0)`);
      const fired = await instance(3);
      assertEquals([fired.state.phase, fired.state.expired_at], ["expired", due.due], "the guard that held nothing fell through to the next arrow");
      assertEquals(await timers(3), [], "the fire took its schedule, and the final state started none");
      // Late: a minute behind, it runs when it was decided, not at the instant it was due.
      await spawn(4);
      const [late] = await timers(4);
      await sql(`UPDATE public.schedule SET due_at = due_at - interval '10 minutes' WHERE name = ${literal(late.name)};`);
      const before = Date.now();
      await tick(4, late.name, `to_timestamp(${late.due - 600000} / 1000.0)`);
      const ran = (await instance(4)).state.expired_at;
      assert(ran >= before - 1000 && ran > late.due - 600000 + 60000, `the step ran at ${ran}, when the tick was decided, not at ${late.due - 600000}`);
    });

    // XState's nested states: the compound state's timer stands while its
    // children are entered and left, and the earlier of the two decides.
    await t.step("a compound state's schedule stands across its children, and either clock's tick ends it", async () => {
      const race = await nestedFixture();
      await sql(`${surface("proof_race")}
        ${race.compiled.sql}
        ${compileMechaPorts({ [race.spec.name]: race.spec })}`);
      const races = "hybrid_proof_race";
      const steps = async (id: number, kind: string) => {
        const revision = await sql(`SELECT revision FROM ${races}.instance WHERE id = '${uuid(id)}';`);
        return JSON.parse(await sql(`SELECT ${races}.dispatch('${uuid(id)}', '${uuid(1)}', '${kind}/${revision}', ${quote({ version: 1, expected_revision: revision, event: { kind, payload: {} } })}, 'omnishell');`));
      };
      const states = async (id: number) => (await timers(id)).map((timer) => timer.values.state).sort();
      for (const [id, fired] of [[6, "racing"], [7, "racing.closing"]] as const) {
        await sql(`INSERT INTO ${races}.instance VALUES ('${uuid(id)}', 1, 0, '{"phase": "waiting", "lifts": 0, "timeouts": 0}');
          INSERT INTO ${races}.member VALUES ('${uuid(id)}', '${uuid(1)}', 'a');`);
        assertEquals((await steps(id, "start")).kind, "accepted");
        assertEquals(await states(id), ["racing"]);
        assertEquals((await steps(id, "lift")).kind, "accepted");
        assertEquals(await states(id), ["racing", "racing.closing"], "the child's timer joins the parent's, which stands");
        const schedule = (await timers(id)).find((timer) => timer.values.state === fired)!;
        await sql(`INSERT INTO public.machine_timer_tick (id, schedule, tick_at, late, machine, "row", state, delay)
          VALUES (gen_random_uuid(), ${literal(schedule.name)}, to_timestamp(${schedule.due} / 1000.0), false, 'proof_race', jsonb_build_object('id', '${uuid(id)}'), '${fired}', ${literal(String(schedule.values.delay))});`);
        assertEquals(await sql(`SELECT state->>'phase' FROM ${races}.instance WHERE id = '${uuid(id)}';`), "abandoned", `${fired}'s tick abandons the race`);
        assertEquals(await timers(id), [], "leaving the parent cancels both");
      }
    });

    await t.step("a reader cannot deliver a timer's event", async () => {
      await spawn(5);
      const forged = await psql(`SELECT ${schema}.dispatch('${uuid(5)}', '${uuid(1)}', 'f', ${quote({ version: 1, expected_revision: "0", event: { kind: "xstate.after.turn.running", payload: {} } })}, 'omnishell');`);
      assertEquals(forged.ok, false);
      assert(forged.err.includes("another tier"), forged.err);
    });
  } finally {
    const stopped = await run("docker", ["stop", container]);
    if (!stopped.ok) throw new Error(stopped.err);
  }
} });
