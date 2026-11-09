import { createEmptyActor, createMachine } from "npm:xstate@5.32.6";

type SqlTransition = { event: string; when?: string; unchanged?: string; target?: string; guard?: string; actions: string[] };
export type CortexSqlRecipe = {
  state: string;
  field: string;
  mode: "dispatch" | "direct";
  states: Record<string, { type?: "final"; entry: string[]; exit: string[] }>;
  transitions: SqlTransition[];
};
type Trace = { kind: "action"; sql: string } | { kind: "guard"; sql: string; value: boolean };
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
export const cortexStateKeys = (states: Record<string, unknown>): Map<string, string> =>
  new Map(Object.keys(states).map((name, index) => [name, `cortex_state_${index}`]));

// SQL stays inside the row trigger. XState compiles its finite control flow;
// each guard is evaluated where it occurs, after any preceding SQL effects.
export function compileCortexRecipe(recipe: CortexSqlRecipe): string {
  if (!Object.hasOwn(recipe.states, recipe.state) || !["dispatch", "direct"].includes(recipe.mode)) throw Error("invalid Cortex SQL recipe");
  const guards: Record<string, () => boolean> = {};
  const actionSql: Record<string, string> = {};
  const accepted: Record<string, () => void> = {};
  let trace: Trace[] = [];
  let answers: boolean[] = [];
  let cursor = 0;
  let unresolved: string | undefined;
  let taken = false;
  let unchanged = "false";
  const action = (sql: string) => {
    const name = `action_${Object.keys(actionSql).length}`;
    actionSql[name] = sql;
    return name;
  };
  const keys = cortexStateKeys(recipe.states);
  const states: Record<string, any> = Object.create(null);
  for (const [name, state] of Object.entries(recipe.states)) {
    const key = keys.get(name)!;
    states[key] = { id: key, type: state.type, entry: state.entry.map(action), exit: state.exit.map(action) };
  }
  const events = new Map<string, { when: string; branches: any[] }>();
  for (const t of recipe.transitions) {
    if (t.target !== undefined && !keys.has(t.target)) throw Error(`Cortex SQL target does not exist: ${t.target}`);
    const when = recipe.mode === "dispatch" ? `cortex_event = ${literal(t.event)}` : t.when;
    if (!when) throw Error(`Cortex SQL transition has no delivery condition: ${t.event}`);
    let group = events.get(t.event);
    if (group && group.when !== when) throw Error(`Cortex SQL event has inconsistent delivery conditions: ${t.event}`);
    if (!group) events.set(t.event, group = { when, branches: [] });
    const acceptance = `accepted_${Object.keys(accepted).length}`;
    accepted[acceptance] = () => { taken = true; unchanged = t.unchanged ?? "false"; };
    const branch: any = { actions: [acceptance, action(`NEW.${identifier(recipe.field)} := ${literal(t.target ?? recipe.state)};`), ...t.actions.map(action)] };
    if (t.target !== undefined) branch.target = `#${keys.get(t.target)}`;
    if (t.guard !== undefined) {
      const name = `guard_${Object.keys(guards).length}`;
      guards[name] = () => {
        if (cursor === answers.length) {
          unresolved = t.guard;
          throw Error("unresolved SQL guard");
        }
        const value = answers[cursor++];
        trace.push({ kind: "guard", sql: t.guard!, value });
        return value;
      };
      branch.guard = name;
    }
    group.branches.push(branch);
  }
  states[keys.get(recipe.state)!].on = Object.fromEntries([...events].map(([event, group]) => [event, group.branches]));
  const machine = createMachine({ id: "cortex_sql", initial: keys.get(recipe.state)!, states }, {
    guards,
    actions: { ...accepted, ...Object.fromEntries(Object.entries(actionSql).map(([name, sql]) => [name, () => { trace.push({ kind: "action", sql }); }])) },
  });
  const self = createEmptyActor();
  const unsupported = () => { throw Error("Cortex SQL compiler cannot schedule or invoke actors"); };
  const scope: any = {
    self, system: self.system, id: "cortex_sql", sessionId: "cortex_sql", logger: unsupported,
    defer: unsupported, stopChild: unsupported, emit: unsupported,
    actionExecutor: (descriptor: any) => {
      if (!descriptor.exec) throw Error(`Cortex SQL compiler cannot execute ${descriptor.type}`);
      descriptor.exec(descriptor.info, descriptor.params);
    },
  };
  let nodes = 0;
  const compile = (event: string, decisions: boolean[], prefix: number): string => {
    if (++nodes > 4096 || decisions.length > 128) throw Error("Cortex SQL decision graph exceeds its finite compilation bound");
    answers = decisions;
    cursor = 0;
    trace = [];
    taken = false;
    unresolved = undefined;
    try {
      machine.transition(machine.resolveState({ value: keys.get(recipe.state)! }), { type: event }, scope);
    } catch (error) {
      if (unresolved === undefined) throw error;
    }
    const emitted = trace.slice(prefix).filter((item) => item.kind === "action").map((item) => item.sql).join("\n");
    if (unresolved !== undefined) {
      const guard = unresolved;
      const next = trace.length + 1;
      return `${emitted}\nIF (${guard}) IS TRUE THEN\n${compile(event, [...decisions, true], next)}\nELSE\n${compile(event, [...decisions, false], next)}\nEND IF;`;
    }
    if (!taken) return `${emitted}\n${recipe.mode === "dispatch" ? "RETURN NULL;" : "RAISE EXCEPTION 'guard failed on Cortex transition' USING ERRCODE = 'check_violation';"}`;
    return `${emitted}\n${recipe.mode === "dispatch" ? `IF ${unchanged} AND cortex_changed = 0 THEN RETURN NULL; END IF;\n` : ""}RETURN NEW;`;
  };
  const blocks = [...events].map(([event, group]) => `IF ${group.when} THEN\n${compile(event, [], 0)}\nEND IF;`);
  if (recipe.mode === "dispatch") blocks.push("RETURN NULL;");
  return blocks.join("\n");
}

export function compileCortexSql(sql: string): string {
  // Airlock's upgrade nests the trigger inside EXECUTE and DO string literals.
  // The quote sentinel carries that escaping depth through CUE's SQL wrappers.
  const result = sql.replace(/^[\t ]*@PRONTO_XSTATE('+)([A-Za-z0-9+/=]+)\1$/gm, (_, quotes: string, payload: string) => {
    const depth = Math.log2(quotes.length);
    if (!Number.isInteger(depth)) throw Error("invalid Cortex SQL literal depth");
    let compiled = compileCortexRecipe(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))));
    for (let n = 0; n < depth; n++) compiled = compiled.replaceAll("\\", "\\\\").replaceAll("'", "''");
    return compiled;
  });
  if (result.includes("@PRONTO_XSTATE")) throw Error("malformed Cortex SQL compiler input");
  return result;
}
