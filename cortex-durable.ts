import { compileMechaReducer, type MechaReducerMachine, type Terminal } from "./mecha-reducer.ts";

export type CortexInvocation = {
  task: string;
  key: string;
  input: string;
  onDone: string;
  onError: string;
  runAtSql?: string;
  maxAttemptsSql?: string;
};

export type CortexDurable = {
  machine: MechaReducerMachine;
  invoke: Record<string, CortexInvocation>;
};

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function compileCortexDurable(
  spec: CortexDurable,
  source: string,
  terminal: Terminal,
): Promise<{ source: string; sql: string }> {
  const machine = spec.machine;
  if (machine.public) throw new Error("durable Cortex machines expose no public projection");
  if (machine.ports) throw new Error("durable Cortex machines expose no browser ports");
  for (const event of Object.values(machine.events)) {
    if (event.tier !== "mecha") throw new Error("durable Cortex events belong to Mecha");
  }
  const entries: string[] = [];
  const outcomes: string[] = [];
  for (const [phase, invocation] of Object.entries(spec.invoke).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const state = machine.states[phase];
    if (!state || state.final || state.always?.length) throw new Error(`Cortex invocation ${phase} requires a stable, nonfinal state`);
    if (phase === machine.initial) throw new Error("durable Cortex invocation requires an entry transition");
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(invocation.task)) throw new Error("invalid Cortex task");
    if (!invocation.key.trim() || !invocation.input.trim()) throw new Error("Cortex invocation requires key and input SQL");
    for (const event of [invocation.onDone, invocation.onError]) {
      const arrow = state.on[event];
      if (!arrow || !arrow.target || arrow.target === phase) throw new Error(`Cortex outcome ${event} must leave invoking state ${phase}`);
      if (machine.states[arrow.target]?.always?.length) throw new Error(`Cortex outcome ${event} requires a stable target state`);
    }
    for (const [event, arrow] of Object.entries(state.on)) {
      if (event !== invocation.onDone && event !== invocation.onError && arrow.target && arrow.target !== phase) {
        throw new Error(`only Cortex outcomes may leave invoking state ${phase}`);
      }
    }
    for (const sql of [invocation.runAtSql, invocation.maxAttemptsSql]) {
      if (sql !== undefined && !sql.trim()) throw new Error("Cortex invocation options require SQL expressions");
    }
    outcomes.push(`IF game.state->>'phase' = ${literal(phase)} THEN
        DECLARE next_reduced jsonb := reduced; invocation_key text;
        BEGIN
          reduced := jsonb_build_object('state', game.state);
          invocation_key := (${invocation.key})::text;
          reduced := next_reduced;
          IF reduced->'state'->>'phase' = ${literal(phase)} AND invocation_key IS DISTINCT FROM (${invocation.key})::text THEN
            RAISE EXCEPTION 'Cortex invocation % retains its key until settlement', ${literal(phase)} USING ERRCODE = 'check_violation';
          END IF;
          IF request->'event'->>'kind' IN (${literal(invocation.onDone)}, ${literal(invocation.onError)}) AND NOT EXISTS (
            SELECT FROM durex.work work
            WHERE work.key = invocation_key
              AND work.task = ${literal(invocation.task)}
              AND work.machine = ${literal(machine.name)}
              AND work.instance = game.id
              AND work.outcome->'payload' = request->'event'->'payload'
              AND ((work.outcome->>'kind' = 'done' AND work.done_event = request->'event'->>'kind')
                OR (work.outcome->>'kind' = 'failed' AND work.failed_event = request->'event'->>'kind'))
          ) THEN
            RAISE EXCEPTION 'Cortex invocation % requires its recorded outcome', ${literal(phase)} USING ERRCODE = 'check_violation';
          END IF;
        END;
      END IF;`);
    entries.push(`IF reduced->'state'->>'phase' = ${literal(phase)} AND game.state->>'phase' IS DISTINCT FROM ${literal(phase)} THEN
        IF EXISTS (SELECT FROM durex.work work WHERE work.key = (${invocation.key})::text) THEN
          RAISE EXCEPTION 'Cortex invocation % requires a fresh key', ${literal(phase)} USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM durex.enqueue_work(${literal(invocation.task)}, (${invocation.key})::text, (${invocation.input})::jsonb,
          ${literal(machine.name)}, game.id, ${literal(invocation.onDone)}, ${literal(invocation.onError)},
          (${invocation.runAtSql ?? "clock_timestamp()"})::timestamptz, (${invocation.maxAttemptsSql ?? "25"})::integer);
      END IF;`);
  }
  if (!entries.length) throw new Error("durable Cortex requires an invocation");
  const compiled = await compileMechaReducer(machine, source, terminal, undefined, {
    serverOnly: true,
    beforeTransitionSql: outcomes.join("\n      "),
    afterTransitionSql: entries.join("\n      "),
  });
  return { ...compiled, sql: compiled.sql.replace(/[ \t]+$/gm, "") };
}
