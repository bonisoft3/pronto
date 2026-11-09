import { compileCortexSql, cortexStateKeys } from "./cortex-machine.ts";
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { createActor, createMachine } from "npm:xstate@5.32.6";
import { compileCortexSources, type CortexChart } from "./cortex-sources.ts";
export type Arrow = { state: string; key: string; index: number; to?: string };

type Branch = { target?: string; guard?: string; actions?: string | string[]; description?: string };
type State = { type?: string; on?: Record<string, string | Branch | Branch[]>; invoke?: unknown; [key: string]: unknown };
export type BackendConfig = { id: string; initial: string; meta?: { host?: string }; states: Record<string, State>; [key: string]: unknown };
export type Unvisited = Arrow & { reason: string };
export type Conformance = { chart: string; covered: Arrow[]; unvisited: Unvisited[]; unsupported: string[]; errors: string[] };

type Case = { arrow: Arrow; guards: Record<string, boolean>; actions: string[]; marker: string };
const branches = (value: string | Branch | Branch[]): Branch[] =>
  typeof value === "string" ? [{ target: value }] : Array.isArray(value) ? value : [value];
const actionNames = (value: Branch["actions"]): string[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Each branch is addressed directly; this is a differential, not a reachability walk.
export function inventory(chart: string, config: BackendConfig, sourceEvents?: string[]) {
  const report: Conformance = { chart, covered: [], unvisited: [], unsupported: [], errors: [] };
  const cases: Case[] = [];
  const states: Record<string, State> = Object.create(null);
  const actionSet = new Set<string>();
  for (const state of Object.values(config.states)) for (const value of Object.values(state.on ?? {})) {
    for (const branch of branches(value)) if (branch && typeof branch === "object") for (const action of actionNames(branch.actions)) actionSet.add(action);
  }
  const guardSet = new Set<string>();
  for (const [key] of Object.entries(config)) {
    if (!["id", "initial", "meta", "description", "invoke", "states"].includes(key)) report.unsupported.push(`root.${key}`);
  }
  if (!Object.hasOwn(config.states, config.initial)) report.unsupported.push(`initial state ${config.initial}`);
  let serial = 0;
  for (const [stateName, state] of Object.entries(config.states)) {
    const on: Record<string, Branch[]> = Object.create(null);
    for (const key of Object.keys(state)) {
      if (!["type", "on", "invoke", "description", "tags", "meta"].includes(key)) report.unsupported.push(`${stateName}.${key}`);
    }
    if (state.type !== undefined && state.type !== "final") report.unsupported.push(`${stateName}.type=${state.type}`);
    if (state.type === "final" && (state.on !== undefined || state.invoke !== undefined)) report.unsupported.push(`${stateName}: final state has transitions`);
    if (state.invoke !== undefined && state.on !== undefined) report.unsupported.push(`${stateName}: invoking state handles events`);
    if (state.invoke !== undefined) {
      if (typeof state.invoke !== "object" || state.invoke === null || Array.isArray(state.invoke)) {
        report.unsupported.push(`${stateName}.invoke`);
      }
      const invoke = state.invoke as { src?: unknown; onDone?: unknown; onError?: unknown; [key: string]: unknown };
      if (invoke && typeof invoke === "object" && !Array.isArray(invoke)) {
        for (const key of Object.keys(invoke)) if (!["src", "onDone", "onError"].includes(key)) report.unsupported.push(`${stateName}.invoke.${key}`);
        if (typeof invoke.src !== "string" || invoke.onDone === undefined || invoke.onError === undefined) report.unsupported.push(`${stateName}.invoke: both outcomes are required`);
      }
      for (const key of ["onDone", "onError"] as const) if (invoke?.[key] !== undefined) {
        const value = invoke[key];
        const count = Array.isArray(value) ? value.length : 1;
        for (let index = 0; index < count; index++) report.unvisited.push({ state: stateName, key: `invoke.${key}`, index, reason: "external-effect outcome not exercised" });
      }
    }
    for (const [event, value] of Object.entries(state.on ?? {})) {
      const list = branches(value);
      if (list.length === 0) report.unsupported.push(`${stateName}.${event}: empty transition list`);
      const guardsBefore: string[] = [];
      let fallback = false;
      const out: Branch[] = [];
      for (const [index, candidate] of list.entries()) {
        if (!candidate || typeof candidate !== "object") { report.unsupported.push(`${stateName}.${event}[${index}]`); continue; }
        const arrow: Arrow = { state: stateName, key: event, index, ...(candidate.target === undefined ? {} : { to: candidate.target }) };
        if (candidate.target !== undefined && !Object.hasOwn(config.states, candidate.target)) report.unsupported.push(`${stateName}.${event}[${index}]: target ${candidate.target}`);
        if (candidate.guard !== undefined && typeof candidate.guard !== "string") report.unsupported.push(`${stateName}.${event}[${index}]: guard`);
        for (const key of Object.keys(candidate)) if (!["target", "guard", "actions", "description"].includes(key)) report.unsupported.push(`${stateName}.${event}[${index}].${key}`);
        const actions = actionNames(candidate.actions);
        if (actions.some((name) => typeof name !== "string")) report.unsupported.push(`${stateName}.${event}[${index}]: actions`);
        for (const name of actions) actionSet.add(name);
        if (candidate.guard !== undefined) guardSet.add(candidate.guard);
        let marker = `__cortex_check_branch_${serial++}`;
        while (actionSet.has(marker)) marker = `__cortex_check_branch_${serial++}`;
        actionSet.add(marker);
        out.push({ ...candidate, actions: [...actions, marker] });
        if (!sourceEvents?.includes(event)) {
          report.unvisited.push({ ...arrow, reason: sourceEvents ? "direct row transition not exercised" : "source event bindings not exported" });
        } else if (state.type === "final" || state.invoke !== undefined) {
          report.unvisited.push({ ...arrow, reason: state.type === "final" ? "final state cannot accept events" : "invoking state cannot accept source events" });
        } else if (fallback || (candidate.guard !== undefined && guardsBefore.includes(candidate.guard))) {
          report.unvisited.push({ ...arrow, reason: "an earlier branch always selects the same scripted guard outcomes" });
        } else {
          const guards = Object.fromEntries(guardsBefore.map((guard) => [guard, false]));
          if (candidate.guard !== undefined) guards[candidate.guard] = true;
          cases.push({ arrow, guards, actions, marker });
        }
        if (candidate.guard === undefined) fallback = true;
        else guardsBefore.push(candidate.guard);
      }
      on[event] = out;
    }
    states[stateName] = { ...(state.type === undefined ? {} : { type: state.type }), ...(state.on === undefined ? {} : { on }) };
  }
  for (const event of sourceEvents ?? []) {
    if (!Object.values(config.states).some((state) => state.on && Object.hasOwn(state.on, event))) {
      report.unvisited.push({ state: "*", key: event, index: 0, reason: "source event has no chart transition" });
    }
  }
  const eventNames = [...new Set(cases.map((c) => c.arrow.key))];
  return { report, cases, states, actionSet, guardSet, eventNames };
}

async function emittedSql(states: Record<string, State>, initial: string, eventNames: string[], guards: Record<string, { sql: string }>, actions: Record<string, unknown[]>) {
  const config = { states, initial };
  const entity = { name: "Conformance", table: "conformance_row", durability: "server", fields: [{ name: "id", type: "string", pk: true }, { name: "status", type: "string" }] };
  const expression = `({
    let chart = ${JSON.stringify(config)}
    let guardImpl = ${JSON.stringify(guards)}
    let actionImpl = ${JSON.stringify(actions)}
    result: (#mechaMachineSql & {
      machine: {
        name: "Conformance", cortex: {id: "conformance", sourceEvents: ${JSON.stringify(eventNames)}}
        entity: "Conformance", field: "status", initial: chart.initial, guards: {}, level: "replicated"
        states: {for stateName, state in chart.states {
          (stateName): {
            if state.type != _|_ {type: state.type}
            if state.on != _|_ {on: {for event, value in state.on {
              (event): [for branch in [if (value & string) != _|_ {[value]}, if (value & [...]) != _|_ {value}, [value]][0] {
                (#CortexMechaTransition & {transition: branch, guards: guardImpl, actions: actionImpl, event: true}).out
              }]
            }}}
          }
        }}
      }
      entities: {Conformance: ${JSON.stringify(entity)}}
      effects: {}
    })._stateMachineSql
  }).result`;
  const out = await new Deno.Command("cue", { args: ["export", ".:pronto", "-e", expression], cwd: new URL(".", import.meta.url), stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw Error(new TextDecoder().decode(out.stderr));
  return compileCortexSql(JSON.parse(new TextDecoder().decode(out.stdout)));
}

export async function checkBackendChart(chart: string, config: BackendConfig, options: { sourceEvents?: string[]; mutateSql?: (sql: string) => string } = {}): Promise<Conformance> {
  const { report, cases, states } = inventory(chart, config, options.sourceEvents);
  if (report.unsupported.length || cases.length === 0) return report;
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE service; CREATE SEQUENCE conformance_seq; CREATE TABLE conformance_row(id text PRIMARY KEY, status text NOT NULL); CREATE TABLE conformance_trace(id bigint, name text NOT NULL)");
    const stateNames = [...new Set(cases.map((test) => test.arrow.state))];
    let serial = 0;
    for (const stateName of stateNames) {
      const localCases = cases.filter((test) => test.arrow.state === stateName);
      const localStates = Object.fromEntries(Object.entries(states).map(([name, state]) => [name, {
        ...(state.type === undefined ? {} : { type: state.type }),
        ...(name === stateName && state.on ? { on: Object.fromEntries(Object.entries(state.on).filter(([event]) => options.sourceEvents?.includes(event))) } : {}),
      }]));
      const localGuardNames = new Set<string>();
      const localActionNames = new Set<string>();
      for (const value of Object.values(localStates[stateName].on ?? {})) for (const branch of branches(value)) {
        if (branch.guard !== undefined) localGuardNames.add(branch.guard);
        for (const action of actionNames(branch.actions)) localActionNames.add(action);
      }
      const guards = Object.fromEntries([...localGuardNames].map((name) => [name, { sql: `COALESCE((cortex_payload->'guards'->>${sqlLiteral(name)})::boolean, false)` }]));
      const actions = Object.fromEntries([...localActionNames].map((name) => [name, [{ effect: { op: "create", table: "conformance_trace", values: { id: { raw: "nextval('conformance_seq')" }, name } } }]]));
      const eventNames = Object.keys(localStates[stateName].on ?? {});
      const configForSql = { id: "conformance", initial: config.initial, meta: { host: "mecha" as const, entity: "Conformance", field: "status", function: "conformance_run", migration: "019_conformance.sql", watch: [] }, invoke: { src: "facts" }, states: localStates };
      const backend: CortexChart = { config: configForSql, setup: { guards, actions, actors: { facts: { via: "query", event: eventNames[0], select: `SELECT id AS key, ${sqlLiteral(eventNames[0])} AS event, '{}'::jsonb AS payload FROM conformance_row WHERE false` } } } };
      const entities = { Conformance: { table: "conformance_row", fields: [{ name: "id", pk: true }, { name: "status" }] } };
      const sql = await emittedSql(localStates, config.initial, eventNames, guards, actions);
      await db.exec(options.mutateSql ? options.mutateSql(sql) : sql);
      await db.exec(compileCortexSources([backend], entities));
      for (const test of localCases) {
        const seen: string[] = [];
        const implementations = {
          guards: Object.fromEntries([...localGuardNames].map((name) => [name, () => test.guards[name] ?? false])),
          actions: Object.fromEntries([...localActionNames].map((name) => [name, () => { seen.push(name); }])),
        };
        const keys = cortexStateKeys(localStates);
        const names = new Map([...keys].map(([name, key]) => [key, name]));
        const referenceStates = Object.fromEntries(Object.entries(localStates).map(([name, state]) => [keys.get(name)!, {
          ...state, id: keys.get(name),
          ...(state.on ? { on: Object.fromEntries(Object.entries(state.on).map(([event, value]) => [event, branches(value).map((branch) => ({
            ...branch, ...(branch.target === undefined ? {} : { target: `#${keys.get(branch.target)}` }),
          }))])) } : {}),
        }]));
        const reference = createMachine({ id: "conformance", initial: keys.get(test.arrow.state), states: referenceStates } as never, implementations as never);
        const actor = createActor(reference).start();
        actor.send({ type: test.arrow.key } as never);
        const expectedState = names.get(actor.getSnapshot().value as string);
        actor.stop();
        const id = String(serial++);
        await db.exec('ALTER TABLE conformance_row DISABLE TRIGGER ALL; DELETE FROM conformance_row; DELETE FROM conformance_trace;');
        await db.query("INSERT INTO conformance_row(id, status) VALUES ($1, $2)", [id, test.arrow.state]);
        await db.exec('ALTER TABLE conformance_row ENABLE TRIGGER ALL;');
        await db.query("SELECT cortex_runtime.dispatch_conformance($1, $2, $3::jsonb)", [id, test.arrow.key, JSON.stringify({ guards: test.guards })]);
        const actual = (await db.query<{ status: string }>("SELECT status FROM conformance_row WHERE id = $1", [id])).rows[0].status;
        const trace = (await db.query<{ name: string }>("SELECT name FROM conformance_trace ORDER BY id")).rows.map((row) => row.name);
        if (actual !== expectedState || JSON.stringify(trace) !== JSON.stringify(seen) || trace.at(-1) !== test.marker) {
          report.errors.push(`${test.arrow.state} --${test.arrow.key}[${test.arrow.index}]--> expected ${String(expectedState)} ${JSON.stringify(seen)}, got ${actual} ${JSON.stringify(trace)}`);
        } else report.covered.push(test.arrow);
      }
    }
  } finally { await db.close(); }
  return report;
}
