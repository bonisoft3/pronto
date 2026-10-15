import type { MechaPorts, MechaPortSql } from "./mecha-ports.ts";
import { jessieFacts } from "./jessie.ts";

export type Shape =
  | { type: "string"; maxLength: number; values?: string[] }
  | { type: "integer"; min: number; max: number }
  | { type: "boolean" }
  | { type: "array"; maxItems: number; items: Shape }
  | { type: "object"; fields: Record<string, Shape> };
export type MechaReducerMachine = {
  name: string;
  version: number;
  fuel: number;
  entropy?: number;
  initial: string;
  initialize?: {reduce: string; input: Shape};
  ports?: MechaPorts;
  state: Shape;
  view: Shape;
  events: Record<string, { tier: "omnishell" | "mecha"; payload: Shape }>;
  mecha?: {ports?: MechaPortSql; locks: string; transitions: {phase: string; event: string; requires?: {sql: string; reason: string}; sql: string}[]};
  states: Record<string, { final: boolean; always?: { target: string; guard?: string; reduce: string }[]; on: Record<string, { target?: string; guard?: string; reduce: string }> }>;
};

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** `instrument` is the terminal's fuel instrumentation (omnishell's
 * instrument.ts), passed in because an installed pronto has no sibling to
 * import it from. */
export async function compileMechaReducer(
  spec: MechaReducerMachine,
  source: string,
  instrument: (source: string) => string,
): Promise<{ source: string; sql: string }> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(spec.name)) throw new Error("invalid hybrid name");
  if (!Number.isSafeInteger(spec.version) || spec.version < 1) throw new Error("invalid hybrid version");
  if (!Number.isSafeInteger(spec.fuel) || spec.fuel < 1 || spec.fuel > 1000000) throw new Error("invalid hybrid fuel");
  const entropy = spec.entropy ?? 0;
  if (!Number.isInteger(entropy) || entropy < 0 || entropy > 1024) throw new Error("invalid hybrid entropy");
  if (spec.state.type !== "object" || spec.state.fields.phase?.type !== "string") throw new Error("hybrid state requires a phase string");
  if (spec.view.type !== "object") throw new Error("hybrid view requires an object");
  if (!Object.hasOwn(spec.states, spec.initial)) throw new Error("hybrid initial state is missing");
  for (const [name, state] of Object.entries(spec.states)) {
    if (state.final && (Object.keys(state.on).length || state.always?.length)) throw new Error(`hybrid final state ${name} has transitions`);
    for (const arrow of state.always ?? []) {
      if (!Object.hasOwn(spec.states, arrow.target)) throw new Error(`hybrid missing target ${arrow.target}`);
    }
    for (const [event, arrow] of Object.entries(state.on)) {
      if (!Object.hasOwn(spec.events, event)) throw new Error(`hybrid undeclared event ${event}`);
      if (arrow.target !== undefined && !Object.hasOwn(spec.states, arrow.target)) throw new Error(`hybrid missing target ${arrow.target}`);
    }
  }
  for (const event of Object.values(spec.events)) {
    if (!["omnishell", "mecha"].includes(event.tier) || event.payload.type !== "object") throw new Error("invalid hybrid event declaration");
  }
  const facts = jessieFacts(source, "handler");
  if (facts.references.length) throw new Error(`hybrid rules reach ${facts.references.join(", ")}`);
  const runtime = await Deno.readTextFile(new URL("./hybrid-runtime.js", import.meta.url));
  const ses = await Deno.readTextFile(new URL("../omnishell/interpreter/vendor/ses.umd.min.js", import.meta.url));
  const script = `(() => {
    const spec = harden(${JSON.stringify(spec, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)});
    const rules = harden(${instrument(`(() => { ${source}\n })()`)});
    for (const name of ['project', 'invariant', ...(spec.initialize ? [spec.initialize.reduce] : []), ...Object.values(spec.states).flatMap(s => [...Object.values(s.on), ...(s.always ?? [])].flatMap(t => [t.reduce, ...(t.guard ? [t.guard] : [])]))]) {
      if (!Object.prototype.hasOwnProperty.call(rules, name) || typeof rules[name] !== 'function') throw new Error('hybrid missing function ' + name);
    }
    const execute = (${runtime.trim()})(spec, rules);
    return json => {
      const answer = execute(JSON.parse(json));
      __fuel();
      return JSON.stringify(answer);
    };
  })()`;
  const schema = `hybrid_${spec.name}`;
  const body = `
if (!globalThis.__prontoHybridSES) {
  ${ses}
  lockdown({errorTaming: 'unsafe'});
  Object.defineProperty(globalThis, '__prontoHybridSES', {value: true});
}
let spent = 0;
const meter = harden(() => { if (++spent > ${spec.fuel}) throw new RangeError('hybrid fuel exhausted'); });
const cage = new Compartment();
Object.defineProperty(cage.globalThis, '__fuel', {value: meter, writable: false, configurable: false});
const run = cage.evaluate(${JSON.stringify(script)});
return JSON.parse(run(JSON.stringify(input)));
`;
  // An app's strings must never terminate either SQL function body.
  let tag = "$hybrid$";
  while (body.includes(tag)) tag = tag.slice(0, -1) + "_$";
  const mecha = spec.mecha ?? {locks: "", transitions: []};
  const branches = mecha.transitions.map(t => {
    if (!spec.states[t.phase]?.on[t.event]) throw new Error("Mecha effect names an undeclared transition");
    return `IF game.state->>'phase' = ${literal(t.phase)} AND request->'event'->>'kind' = ${literal(t.event)} THEN
      ${t.requires ? `IF (${t.requires.sql}) IS NOT TRUE THEN
        reduced := jsonb_build_object('kind', 'rejected', 'reason', ${literal(t.requires.reason)});
      ELSE
        ${t.sql}
      END IF;` : t.sql}
    END IF;`;
  }).join("\n");
  const sql = `
CREATE EXTENSION IF NOT EXISTS plv8;
${entropy ? "CREATE EXTENSION IF NOT EXISTS pgcrypto;" : ""}
CREATE SCHEMA ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
CREATE TABLE ${schema}.instance (
  id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version = ${spec.version}),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state jsonb NOT NULL
);
CREATE TABLE ${schema}.member (
  instance_id uuid NOT NULL REFERENCES ${schema}.instance,
  actor uuid NOT NULL,
  seat text NOT NULL,
  PRIMARY KEY(instance_id, actor), UNIQUE(instance_id, seat)
);
CREATE TABLE ${schema}.receipt (
  instance_id uuid NOT NULL REFERENCES ${schema}.instance,
  actor uuid NOT NULL,
  command_id uuid NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(instance_id, actor, command_id)
);
CREATE TABLE ${schema}.view (
  instance_id uuid NOT NULL REFERENCES ${schema}.instance,
  actor uuid NOT NULL,
  revision bigint NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY(instance_id, actor)
);
CREATE FUNCTION ${schema}.step(input jsonb) RETURNS jsonb LANGUAGE plv8 AS ${tag}${body}${tag};
REVOKE ALL ON FUNCTION ${schema}.step(jsonb) FROM PUBLIC;

CREATE FUNCTION ${schema}.dispatch(instance_id uuid, actor uuid, command_id uuid, request jsonb, tier text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, ${schema}
SET statement_timeout = '5s'
SET lock_timeout = '2s'
AS $dispatch$
DECLARE
  game ${schema}.instance;
  prior ${schema}.receipt;
  seat text;
  answer jsonb;
  reduced jsonb;
  recipients jsonb;
  now_ms bigint;
  prepared_revision bigint;
BEGIN
  ${mecha.locks ? `SELECT * INTO STRICT game FROM ${schema}.instance i WHERE i.id = instance_id;
  IF tier = 'omnishell' AND NOT EXISTS (SELECT FROM ${schema}.member m WHERE m.instance_id = game.id AND m.actor = dispatch.actor) THEN
    RAISE EXCEPTION 'not a member' USING ERRCODE = '42501';
  END IF;
  prepared_revision := game.revision;
  ${mecha.locks}` : ""}
  SELECT * INTO STRICT game FROM ${schema}.instance i WHERE i.id = instance_id FOR UPDATE;
  IF tier = 'omnishell' THEN
    SELECT m.seat INTO seat FROM ${schema}.member m WHERE m.instance_id = game.id AND m.actor = dispatch.actor;
    IF seat IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
  ELSIF tier <> 'mecha' THEN
    RAISE EXCEPTION 'invalid tier';
  END IF;
  SELECT * INTO prior FROM ${schema}.receipt r WHERE r.instance_id = game.id AND r.actor = dispatch.actor AND r.command_id = dispatch.command_id;
  IF FOUND THEN
    IF prior.request <> request THEN RAISE EXCEPTION 'command id reused with different input' USING ERRCODE = '22023'; END IF;
    RETURN prior.result;
  END IF;
  IF request->>'version' IS DISTINCT FROM game.version::text THEN
    answer := jsonb_build_object('kind', 'rejected', 'reason', 'protocol_version');
  ELSIF request->>'expected_revision' IS DISTINCT FROM game.revision::text THEN
    answer := jsonb_build_object('kind', 'rejected', 'reason', 'stale_revision');
  ELSE
    ${mecha.locks ? `IF prepared_revision <> game.revision THEN
      RAISE EXCEPTION 'Mecha lock inputs changed; retry the command' USING ERRCODE = '40001';
    END IF;` : ""}
    now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    SELECT coalesce(jsonb_agg(m.seat ORDER BY m.seat), '[]'::jsonb) INTO recipients FROM ${schema}.member m WHERE m.instance_id = game.id;
    reduced := ${schema}.step(jsonb_build_object(
      'state', game.state,
      'event', request->'event',
      'context', jsonb_build_object('actor', seat, 'tier', tier, 'now', now_ms${entropy ? `, 'entropy', encode(public.gen_random_bytes(${entropy}), 'hex')` : ""}),
      'viewers', recipients
    ));
    IF reduced->>'kind' = 'accepted' THEN
      ${branches}
    END IF;
    IF reduced->>'kind' = 'accepted' THEN
      game.revision := game.revision + 1;
      UPDATE ${schema}.instance i SET state = reduced->'state', revision = game.revision WHERE i.id = game.id;
      INSERT INTO ${schema}.view AS v (instance_id, actor, revision, value)
        SELECT game.id, m.actor, game.revision, p->'value'
        FROM jsonb_array_elements(reduced->'views') p
        JOIN ${schema}.member m ON m.instance_id = game.id AND m.seat = p->>'viewer'
        ON CONFLICT ON CONSTRAINT view_pkey DO UPDATE SET revision = EXCLUDED.revision, value = EXCLUDED.value;
      answer := jsonb_build_object('kind', 'accepted');
    ELSIF reduced->>'kind' = 'rejected' THEN
      answer := reduced;
    ELSE
      RAISE EXCEPTION 'invalid hybrid result';
    END IF;
  END IF;
  answer := answer || jsonb_build_object('command_id', command_id, 'revision', game.revision::text);
  INSERT INTO ${schema}.receipt VALUES (game.id, actor, command_id, request, answer);
  RETURN answer;
END;
$dispatch$;
REVOKE ALL ON FUNCTION ${schema}.dispatch(uuid, uuid, uuid, jsonb, text) FROM PUBLIC;

CREATE FUNCTION ${schema}.deliver(instance_id uuid, event jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${schema} AS $deliver$
DECLARE revision bigint; answer jsonb;
BEGIN
  SELECT i.revision INTO STRICT revision FROM ${schema}.instance i WHERE i.id = instance_id;
  answer := ${schema}.dispatch(instance_id, '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
    jsonb_build_object('version', ${spec.version}, 'expected_revision', revision::text, 'event', event), 'mecha');
  IF answer->>'kind' IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'Mecha delivery refused: %', answer USING ERRCODE = 'check_violation';
  END IF;
END;
$deliver$;
REVOKE ALL ON FUNCTION ${schema}.deliver(uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION public.${spec.name}_command(instance_id uuid, command_id uuid, request jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, ${schema}
AS $command$
  SELECT ${schema}.dispatch(instance_id, public.auth_uid(), command_id, request, 'omnishell');
$command$;
REVOKE ALL ON FUNCTION public.${spec.name}_command(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.${spec.name}_command(uuid, uuid, jsonb) TO app_user;

CREATE FUNCTION public.${spec.name}_view(instance_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, ${schema}
AS $view$
  SELECT jsonb_build_object('revision', v.revision::text, 'value', v.value)
  FROM ${schema}.view v JOIN ${schema}.member m USING(instance_id, actor)
  WHERE v.instance_id = ${spec.name}_view.instance_id AND v.actor = public.auth_uid();
$view$;
REVOKE ALL ON FUNCTION public.${spec.name}_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.${spec.name}_view(uuid) TO app_user;
COMMENT ON SCHEMA ${schema} IS ${literal(`Hybrid ${spec.name} protocol ${spec.version}; no public canonical-state access`)};
`;
  return { source: script, sql };
}
