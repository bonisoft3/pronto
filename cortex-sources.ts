export type CortexChart = {
  config: {
    id: string;
    initial: string;
    meta: { host: "mecha"; entity: string; field: string; function: string; migration: string; watch: string[] };
    invoke: { src: string } | { src: string }[];
    states: Record<string, unknown>;
    [key: string]: unknown;
  };
  setup: { actors: Record<string, { via: string; select?: string; event?: string }>; guards?: Record<string, { sql: string }>; actions?: Record<string, Record<string, unknown>[]> };
};
type Entity = { table: string; server?: boolean; fields: { name: string; pk?: boolean }[] };

const ident = (name: string) => {
  if (name.length > 63 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw Error(`Cortex SQL identifier: ${name}`);
  return `"${name}"`;
};
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

function validateChart(chart: CortexChart): void {
  const c = chart.config as Record<string, any>;
  const rejectKeys = (value: Record<string, any>, allowed: string[], where: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Cortex ${where}: unsupported ${key}`);
  };
  rejectKeys(c, ["id", "initial", "description", "meta", "invoke", "states"], c.id);
  for (const [name, actions] of Object.entries(chart.setup.actions ?? {})) {
    for (const action of actions) {
      const assign = action.assign as Record<string, unknown> | undefined;
      if (assign && c.meta.field in assign) throw Error(`Cortex ${c.id}.${name}: actions cannot assign the state field`);
    }
  }
  if (!c.states[c.initial]) throw Error(`Cortex ${c.id}: unknown initial state ${c.initial}`);
  const checkTransition = (value: any, where: string, outcome = false) => {
    const choices = Array.isArray(value) ? value : [value];
    if (!choices.length) throw Error(`Cortex ${where}: unsupported transition alternatives`);
    for (const item of choices) {
      const t = typeof item === "string" ? { target: item } : item;
      if (!t || typeof t !== "object" || Array.isArray(t)) throw Error(`Cortex ${where}: invalid transition`);
      rejectKeys(t, ["target", "guard", "actions", "description"], where);
      if (outcome && t.target === undefined) throw Error(`Cortex ${where}: unsupported outcome transition`);
      if (t.target !== undefined && !c.states[t.target]) throw Error(`Cortex ${where}: unknown target ${t.target}`);
      if (t.guard !== undefined && !chart.setup.guards?.[t.guard]) throw Error(`Cortex ${where}: unknown guard ${t.guard}`);
      for (const action of t.actions === undefined ? [] : Array.isArray(t.actions) ? t.actions : [t.actions]) {
        if (!chart.setup.actions?.[action]) throw Error(`Cortex ${where}: unknown action ${action}`);
        if (!outcome) for (const implementation of chart.setup.actions[action]) {
          for (const key of Object.keys(implementation)) {
            if (key !== "assign" && key !== "effect") throw Error(`Cortex ${where}: event action ${action} cannot use ${key}`);
          }
        }
      }
    }
    if (outcome && choices.at(-1)?.guard !== undefined) throw Error(`Cortex ${where}: outcome requires an unguarded fallback`);
  };
  for (const [name, value] of Object.entries(c.states)) {
    const state = value as Record<string, any>;
    rejectKeys(state, ["type", "description", "tags", "meta", "on", "invoke"], `${c.id}.${name}`);
    if (state.type !== undefined && state.type !== "final") throw Error(`Cortex ${c.id}.${name}: unsupported state type`);
    if (state.type === "final" && (state.on || state.invoke)) throw Error(`Cortex ${c.id}.${name}: final state has transitions`);
    if (state.invoke && state.on) throw Error(`Cortex ${c.id}.${name}: invoked state cannot handle events`);
    for (const [event, value] of Object.entries(state.on ?? {})) checkTransition(value, `${c.id}.${name}.${event}`);
    if (state.invoke) {
      if (Array.isArray(state.invoke)) throw Error(`Cortex ${c.id}.${name}: unsupported invocation array`);
      rejectKeys(state.invoke, ["src", "onDone", "onError"], `${c.id}.${name}.invoke`);
      if (!state.invoke.src || state.invoke.onDone === undefined || state.invoke.onError === undefined) throw Error(`Cortex ${c.id}.${name}: invocation requires both outcomes`);
      checkTransition(state.invoke.onDone, `${c.id}.${name}.onDone`, true);
      checkTransition(state.invoke.onError, `${c.id}.${name}.onError`, true);
    }
  }
}

// The dispatcher is emitted with the row machine so its actions and effect
// invocations use the same lowering as ordinary Mecha transitions.
export function compileCortexSources(charts: CortexChart[], entities: Record<string, Entity>): string {
  if (!charts.length) throw Error("Cortex source group is empty");
  const meta = charts[0].config.meta;
  ident(meta.function);
  const names = new Set<string>();
  const watched = new Set<string>();
  const gated = new Set<string>();
  const gateKey = literal("pronto.cortex");
  const acquire = `PERFORM pg_advisory_xact_lock(hashtextextended(${gateKey}, 0));`;
  const loops: string[] = [];
  const dispatchers: string[] = [];
  for (const chart of charts) {
    validateChart(chart);
    const { config, setup } = chart;
    const m = config.meta;
    if (m.host !== "mecha" || m.function !== meta.function || m.migration !== meta.migration) throw Error("Cortex source group has inconsistent deployment");
    if (names.has(config.id)) throw Error(`Cortex chart duplicated: ${config.id}`);
    names.add(config.id);
    const entity = entities[m.entity] ?? Object.values(entities).find((e) => e.table === m.entity);
    if (!entity || entity.server === false) throw Error(`Cortex chart ${config.id} requires a server entity`);
    if (entity.fields.filter((f) => f.pk).length !== 1 || !entity.fields.some((f) => f.name === m.field)) throw Error(`Cortex chart ${config.id} requires one key and a state field`);
    for (const name of m.watch) {
      const e = entities[name] ?? Object.values(entities).find((v) => v.table === name);
      if (!e) throw Error(`Cortex watch names no entity ${name}`);
      watched.add(e.table);
      gated.add(`${ident("public")}.${ident(e.table)}`);
    }
    gated.add(`${ident("public")}.${ident(entity.table)}`);
    for (const actions of Object.values(setup.actions ?? {})) for (const action of actions) {
      const effects = action.effect === undefined ? [] : Array.isArray(action.effect) ? action.effect : [action.effect];
      for (const value of effects) {
        if (!value || typeof value !== "object") throw Error(`Cortex chart ${config.id}: invalid relational effect`);
        const effect = value as { schema?: string; table?: string };
        if (!effect.table) throw Error(`Cortex chart ${config.id}: relational effect has no table`);
        gated.add(`${ident(effect.schema ?? "public")}.${ident(effect.table)}`);
      }
    }
    const primary = entity.fields.find((f) => f.pk)!.name;
    const dispatchName = `cortex_runtime.${ident(`dispatch_${config.id}`)}`;
    dispatchers.push(`CREATE OR REPLACE FUNCTION ${dispatchName}(instance_key text, event_name text, event_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  ${acquire}
  IF instance_key IS NULL OR event_name IS NULL OR event_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex dispatch requires key, event and payload';
  END IF;
  PERFORM 1 FROM public.${ident(entity.table)} WHERE ${ident(primary)}::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO cortex_runtime.dispatch_frame (backend, xid, relation, depth, machine, row_key, event, payload)
    VALUES (pg_backend_pid(), txid_current(), ${literal(`public.${ident(entity.table)}`)}::regclass::oid, pg_trigger_depth() + 1, ${literal(config.id)}, instance_key, event_name, event_payload);
  UPDATE public.${ident(entity.table)} SET ${ident(m.field)} = ${ident(m.field)} WHERE ${ident(primary)}::text = instance_key;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND machine = ${literal(config.id)} AND row_key = instance_key) THEN
    RAISE EXCEPTION 'Cortex dispatch frame was not consumed';
  END IF;
  RETURN affected > 0;
END $$;
REVOKE ALL ON FUNCTION ${dispatchName}(text, text, jsonb) FROM PUBLIC;`);
    const invocations = Array.isArray(config.invoke) ? config.invoke : [config.invoke];
    if (!invocations.length) throw Error(`Cortex chart ${config.id} requires a root query invocation`);
    for (const [name, actor] of Object.entries(setup.actors)) {
      if (actor.via !== "query") throw Error(`Cortex chart ${config.id}: actor ${name} is not a query`);
      if (!invocations.some((invocation) => invocation?.src === name)) throw Error(`Cortex chart ${config.id}: query ${name} is not invoked`);
    }
    for (const [index, invoke] of invocations.entries()) {
      if (!invoke || Object.keys(invoke).some((k) => k !== "src" && k !== "id")) throw Error(`Cortex chart ${config.id}: unsupported root invocation`);
      const source = setup.actors[invoke.src];
      if (!source || source.via !== "query" || !source.select || !source.event) throw Error(`Cortex chart ${config.id}: root invocation ${invoke.src} is not a query`);
      const queryName = `cortex_runtime.${ident(`query_${config.id}_${index}`)}`;
      dispatchers.push(`CREATE OR REPLACE FUNCTION ${queryName}(instance_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count bigint; v_event text; v_payload jsonb;
BEGIN
  ${acquire}
  PERFORM 1 FROM public.${ident(entity.table)} WHERE ${ident(primary)}::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*), (array_agg(cortex_source.event::text))[1], (array_agg(cortex_source.payload::jsonb))[1]
    INTO v_count, v_event, v_payload
    FROM (${source.select}) AS cortex_source WHERE cortex_source.key::text = instance_key;
  IF v_count > 1 THEN RAISE EXCEPTION 'Cortex query returned duplicate instance %', instance_key; END IF;
  IF v_count = 0 THEN RETURN false; END IF;
  IF v_event IS DISTINCT FROM ${literal(source.event)} OR v_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', ${literal(`${config.id}.${invoke.src}`)};
  END IF;
  RETURN ${dispatchName}(instance_key, v_event, v_payload);
END $$;
REVOKE ALL ON FUNCTION ${queryName}(text) FROM PUBLIC;`);
      const states = Object.entries(config.states).flatMap(([name, value]) => {
        const state = value as { on?: Record<string, unknown> };
        return state.on && Object.hasOwn(state.on, source.event!) ? [literal(name)] : [];
      });
      const accepts = states.length ? `destination.${ident(m.field)} IN (${states.join(", ")})` : "false";
      loops.push(`SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = ${literal(meta.function)};
    IF v_dirty THEN v_changed := true; END IF;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = ${literal(meta.function)};
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', cortex_snapshot.key, 'event', cortex_snapshot.event, 'payload', cortex_snapshot.payload,
      'payload_is_sql_null', cortex_snapshot.payload IS NULL
    ) ORDER BY cortex_snapshot.ordinal), '[]'::jsonb) INTO v_snapshot
    FROM (SELECT cortex_input.key::text AS key, cortex_input.event::text AS event,
                 cortex_input.payload::jsonb AS payload, row_number() OVER () AS ordinal
          FROM (${source.select}) AS cortex_input) AS cortex_snapshot;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snapshot(item) GROUP BY item->>'key' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Cortex source % returned duplicate instances', ${literal(`${config.id}.${invoke.src}`)};
    END IF;
    FOR source IN SELECT item->>'key' AS key, item->>'event' AS event,
      CASE WHEN (item->>'payload_is_sql_null')::boolean THEN NULL::jsonb ELSE item->'payload' END AS payload
      FROM jsonb_array_elements(v_snapshot) WITH ORDINALITY AS snapshot(item, ordinal) ORDER BY ordinal LOOP
      IF source.key IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned a null key', ${literal(`${config.id}.${invoke.src}`)};
      END IF;
      IF source.event IS DISTINCT FROM ${literal(source.event)} OR source.payload IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', ${literal(`${config.id}.${invoke.src}`)};
      END IF;
      IF EXISTS (SELECT 1 FROM public.${ident(entity.table)} AS destination WHERE destination.${ident(primary)}::text = source.key::text AND ${accepts}) THEN
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = ${literal(meta.function)};
        IF v_dirty THEN
          IF ${queryName}(source.key::text) THEN v_changed := true; END IF;
        ELSE
          IF ${dispatchName}(source.key::text, source.event::text, source.payload::jsonb) THEN v_changed := true; END IF;
        END IF;
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = ${literal(meta.function)};
        IF v_dirty THEN v_changed := true; END IF;
      END IF;
    END LOOP;`);
    }
  }
  const guard = literal(meta.function);
  const trigger = ident(`cortex_${meta.function}`);
  const gateName = `cortex_runtime.${ident(`gate_${meta.function}`)}`;
  const gateTrigger = ident(`cortex_${meta.function}_gate`);
  const legacyGateTrigger = ident(`Cortex_${meta.function}_gate`);
  const dirtyTrigger = ident(`cortex_${meta.function}_dirty`);
  const finishTrigger = ident(`zzzz_cortex_${meta.function}`);
  return `CREATE SCHEMA IF NOT EXISTS mecha;
GRANT USAGE ON SCHEMA mecha TO PUBLIC;
CREATE OR REPLACE FUNCTION mecha.request_write_gate() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  ${acquire}
END $$;
CREATE OR REPLACE FUNCTION ${gateName}() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(${gateKey}, 0)) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Cortex source gate is busy; retry the transaction';
  END IF;
  INSERT INTO cortex_runtime.draining (backend, xid, name, depth)
    VALUES (pg_backend_pid(), txid_current(), '@statements', 1)
    ON CONFLICT (backend, xid, name) DO UPDATE SET depth = cortex_runtime.draining.depth + 1;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ${gateName}() FROM PUBLIC;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT false;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS flushing boolean NOT NULL DEFAULT false;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS pending text[] NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION cortex_runtime.mark_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE cortex_runtime.draining SET dirty = true WHERE backend = pg_backend_pid() AND xid = txid_current() AND name <> '@statements' AND NOT dirty;
  IF TG_ARGV[1] = 'true' THEN
    UPDATE cortex_runtime.draining SET pending = array_append(pending, TG_ARGV[0])
      WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements' AND NOT TG_ARGV[0] = ANY(pending)
        AND NOT EXISTS (SELECT 1 FROM cortex_runtime.draining active WHERE active.backend = pg_backend_pid() AND active.xid = txid_current() AND active.name = TG_ARGV[0]);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime.mark_dirty() FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime.finish_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE remaining integer; busy boolean; next_group text;
BEGIN
  UPDATE cortex_runtime.draining SET depth = depth - 1
    WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements'
    RETURNING depth, flushing INTO remaining, busy;
  IF NOT FOUND OR remaining < 0 THEN RAISE EXCEPTION 'Cortex statement barrier is unbalanced'; END IF;
  IF remaining > 0 OR busy THEN RETURN NULL; END IF;
  UPDATE cortex_runtime.draining SET flushing = true WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements';
  FOR flush_pass IN 1..100 LOOP
    SELECT pending[1] INTO next_group FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements';
    EXIT WHEN next_group IS NULL;
    UPDATE cortex_runtime.draining SET pending = array_remove(pending, next_group) WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements';
    EXECUTE format('SELECT public.%I()', next_group);
  END LOOP;
  DELETE FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements' AND depth = 0 AND cardinality(pending) = 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cortex pending source groups did not settle in 100 passes'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime.finish_statement() FROM PUBLIC;
${[...gated].sort().map((table) => {
  const isWatched = [...watched].some((name) => table === `${ident("public")}.${ident(name)}`);
  return `DROP TRIGGER IF EXISTS ${legacyGateTrigger} ON ${table};\nDROP TRIGGER IF EXISTS ${gateTrigger} ON ${table};\nCREATE TRIGGER ${gateTrigger} BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${gateName}();\nDROP TRIGGER IF EXISTS ${dirtyTrigger} ON ${table};\nCREATE TRIGGER ${dirtyTrigger} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty(${literal(meta.function)}, ${literal(String(isWatched))});\nDROP TRIGGER IF EXISTS ${finishTrigger} ON ${table};\nCREATE TRIGGER ${finishTrigger} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();`;
}).join("\n")}
${[...watched].map((table) => `DROP TRIGGER IF EXISTS ${trigger} ON ${ident(table)};`).join("\n")}
${dispatchers.join("\n")}
CREATE OR REPLACE FUNCTION ${ident(meta.function)}() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE source record; v_snapshot jsonb; v_changed boolean; v_dirty boolean;
BEGIN
  ${acquire}
  UPDATE cortex_runtime.draining SET pending = CASE WHEN ${guard} = ANY(pending) THEN pending ELSE array_append(pending, ${guard}) END
    WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements' AND depth > 0;
  IF FOUND THEN RETURN; END IF;
  INSERT INTO cortex_runtime.draining (backend, xid, name) VALUES (pg_backend_pid(), txid_current(), ${guard}) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
  FOR pass IN 1..100 LOOP
    v_changed := false;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = ${guard};
    ${loops.join("\n    ")}
    IF NOT v_changed THEN
      DELETE FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = ${guard};
      RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Cortex composition ${meta.function} did not settle in 100 passes';
END $$;
REVOKE ALL ON FUNCTION ${ident(meta.function)}() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${ident(meta.function)}() TO service;

`;
}
