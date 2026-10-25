import { HYBRID_NAME } from "./hybrid-spec.ts";
import type { MechaPorts, MechaPortSql } from "./mecha-ports.ts";
import { jessieFacts } from "./jessie.ts";
import { partsOf } from "./mecha-surface.ts";
import { contracted } from "./mecha-contracts.ts";
// Read as text, so it loads wherever this module does (an app's tests take it
// by URL); deno.lock records the module import of the same file, not the text.
import "./hybrid-runtime.js";
import runtime from "./hybrid-runtime.js" with { type: "text" };

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
  public?: Shape;
  contracts?: Record<string, { reads: string[]; writes?: string[] }>;
  events: Record<string, { tier: "omnishell" | "mecha"; payload: Shape }>;
  mecha?: {ports?: MechaPortSql; locks: string; transitions: {phase: string; event: string; requires?: {sql: string; reason: string}; sql: string}[]};
  states: Record<string, { final: boolean; always?: { target: string; guard?: string; reduce?: string }[]; on: Record<string, { target?: string; guard?: string; reduce?: string; requires?: { sql: string; reason: string } }> }>;
};

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The columns a machine's surface entities declare past the protocol's own,
 * each filled from the projection's field of the same name. */
export type Surface = { seat: string[]; public?: string[] };

/** The terminal's fuel instrumentation (omnishell's instrument.ts) and the
 * SES the rules are hardened under (omnishell's vendored ses.umd.min.js),
 * passed in because an installed pronto has no sibling tree to read them
 * from: the caller reads them where mise puts the interpreter. */
export interface Terminal {
  instrument: (source: string) => string;
  ses: string;
}

export async function compileMechaReducer(
  spec: MechaReducerMachine,
  source: string,
  terminal: Terminal,
  surface: Surface = { seat: [], public: [] },
): Promise<{ source: string; sql: string }> {
  if (!HYBRID_NAME.test(spec.name)) throw new Error("invalid hybrid name");
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
  contracted(spec);
  const facts = jessieFacts(source, "handler");
  if (facts.references.length) throw new Error(`hybrid rules reach ${facts.references.join(", ")}`);
  const script = `(() => {
    const spec = harden(${JSON.stringify(spec, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)});
    const rules = harden(${terminal.instrument(`(() => { ${source}\n })()`)});
    for (const name of ['project', 'invariant', ...(spec.public ? ['publish'] : []), ...(spec.initialize ? [spec.initialize.reduce] : []), ...Object.values(spec.states).flatMap(s => [...Object.values(s.on), ...(s.always ?? [])].flatMap(t => [...(t.reduce ? [t.reduce] : []), ...(t.guard ? [t.guard] : [])]))]) {
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
  ${terminal.ses}
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
  const seatColumns = ["id", "instance_id", "actor", "seat", "revision", "phase", "view", ...surface.seat];
  const publicColumns = ["id", ...(surface.public ?? [])];
  const upsert = (columns: string[]) => columns.filter(c => c !== "id").map(c => `"${c}" = EXCLUDED."${c}"`).join(", ");
  // The surface's parts, as the surface check reads them: a trigger on a
  // table the machine has no part in would fail the migration.
  const parts = partsOf(spec);
  const sql = `
-- tier: container
CREATE EXTENSION IF NOT EXISTS plv8;
-- tier: any
CREATE SCHEMA ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
-- A machine's steps run serializable: every interleaving of its transactions
-- is then some serial order, and the writer retries the transaction a conflict
-- aborts. The roles that drive a step default to it — app_user through the
-- gateway, service for the ticker and the pipelines — and the gateway starts
-- each request's transaction at its role's. Every other session keeps the
-- database's default, which its writers were written against and owe no
-- retry to; a step reaching one is refused, not trusted.
DO $isolation$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN ALTER ROLE app_user SET default_transaction_isolation = 'serializable'; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service') THEN ALTER ROLE service SET default_transaction_isolation = 'serializable'; END IF;
END $isolation$;
CREATE FUNCTION ${schema}.serial() RETURNS void LANGUAGE plpgsql AS $serial$
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'a ${spec.name} step runs serializable, not %', current_setting('transaction_isolation') USING ERRCODE = '25000';
  END IF;
END;
$serial$;
-- A step's time: the transaction's, the same on every read in it, so every
-- check in one step agrees on it, and no session can set it. A step a timer
-- delivers is given the tick's time instead (dispatch's at), so a deadline
-- is decided on the ticker's clock alone.
CREATE FUNCTION ${schema}.clock() RETURNS bigint LANGUAGE sql STABLE AS $clock$
SELECT floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint;
$clock$;
REVOKE ALL ON FUNCTION ${schema}.clock() FROM PUBLIC;
${entropy ? `CREATE FUNCTION ${schema}.draw() RETURNS text LANGUAGE sql AS $draw$
SELECT left(string_agg(substr(hex, 1, 12) || substr(hex, 14, 3) || substr(hex, 18), ''), ${entropy * 2})
FROM (SELECT replace(gen_random_uuid()::text, '-', '') AS hex FROM generate_series(1, ${Math.ceil(entropy * 2 / 30)})) random;
$draw$;
REVOKE ALL ON FUNCTION ${schema}.draw() FROM PUBLIC;
` : ""}CREATE TABLE ${schema}.instance (
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
  command_id text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  -- What the step was given beside its request, so it replays.
  now bigint NOT NULL,
  entropy text,
  PRIMARY KEY(instance_id, actor, command_id)
);
-- The step's engine is the tier's. PostgreSQL runs the rules in plv8, inside
-- the fence; the edge object creates ${schema}.engine over its host import
-- when it boots (mecha-edge's machines.ts); the browser tier has no engine and
-- steps nothing. plpgsql resolves the engine when a step runs, so the step is
-- declared once, on every tier, before any engine exists.
-- tier: container
CREATE FUNCTION ${schema}.engine(input jsonb) RETURNS jsonb LANGUAGE plv8 AS ${tag}${body}${tag};
REVOKE ALL ON FUNCTION ${schema}.engine(jsonb) FROM PUBLIC;
-- tier: any
CREATE FUNCTION ${schema}.step(input jsonb) RETURNS jsonb LANGUAGE plpgsql AS $step$
BEGIN RETURN ${schema}.engine(input); END;
$step$;
REVOKE ALL ON FUNCTION ${schema}.step(jsonb) FROM PUBLIC;

-- What every member and, where declared, everyone reads of the instance: its
-- seats' rows, each column of the surface filled from the view's field of
-- the same name.
CREATE FUNCTION ${schema}.settle(game ${schema}.instance, projected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${schema} AS $settle$
BEGIN
  INSERT INTO public.${spec.name}_seat AS v (${seatColumns.map(c => `"${c}"`).join(", ")})
    SELECT ${seatColumns.map(c => `r."${c}"`).join(", ")} FROM jsonb_array_elements(projected->'views') p
    JOIN ${schema}.member m ON m.instance_id = game.id AND m.seat = p->>'viewer'
    CROSS JOIN LATERAL jsonb_populate_record(NULL::public.${spec.name}_seat, (p->'value') || jsonb_build_object(
      'id', game.id::text || '/' || m.seat, 'instance_id', game.id, 'actor', m.actor, 'seat', m.seat,
      'revision', game.revision::text, 'phase', game.state->>'phase', 'view', p->'value')) r
    ON CONFLICT (id) DO UPDATE SET ${upsert(seatColumns)};
${spec.public ? `  IF projected->'public' = 'null'::jsonb THEN
    DELETE FROM public.${spec.name}_public WHERE id = game.id::text;
  ELSE
    INSERT INTO public.${spec.name}_public AS v (${publicColumns.map(c => `"${c}"`).join(", ")})
      SELECT ${publicColumns.map(c => `r."${c}"`).join(", ")}
      FROM jsonb_populate_record(NULL::public.${spec.name}_public, (projected->'public') || jsonb_build_object('id', game.id::text)) r
      ON CONFLICT (id) DO UPDATE SET ${upsert(publicColumns) || `"id" = EXCLUDED."id"`};
  END IF;
` : ""}${spec.ports?.wake ? `  PERFORM ${schema}.arm(game);
` : ""}END;
$settle$;
REVOKE ALL ON FUNCTION ${schema}.settle(${schema}.instance, jsonb) FROM PUBLIC;

CREATE FUNCTION ${schema}.dispatch(instance_id uuid, actor uuid, command_id text, request jsonb, tier text, at bigint DEFAULT NULL)
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
  drawn text;
  prepared_revision bigint;
BEGIN
  PERFORM ${schema}.serial();
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
  now_ms := coalesce(at, ${schema}.clock());
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
    ${entropy ? `drawn := ${schema}.draw();
    ` : ""}SELECT coalesce(jsonb_agg(m.seat ORDER BY m.seat), '[]'::jsonb) INTO recipients FROM ${schema}.member m WHERE m.instance_id = game.id;
    reduced := ${schema}.step(jsonb_build_object(
      'state', game.state,
      'event', request->'event',
      'context', jsonb_build_object('actor', seat, 'tier', tier, 'now', now_ms${entropy ? `, 'entropy', drawn` : ""}),
      'viewers', recipients
    ));
    IF reduced->>'kind' = 'accepted' THEN
      ${branches}
    END IF;
    IF reduced->>'kind' = 'accepted' THEN
      UPDATE ${schema}.instance i SET state = reduced->'state', revision = i.revision + 1 WHERE i.id = game.id
        RETURNING i.* INTO STRICT game;
      PERFORM ${schema}.settle(game, reduced);
      answer := jsonb_build_object('kind', 'accepted');
    ELSIF reduced->>'kind' = 'rejected' THEN
      answer := reduced;
    ELSE
      RAISE EXCEPTION 'invalid hybrid result';
    END IF;
  END IF;
  answer := answer || jsonb_build_object('command_id', command_id, 'revision', game.revision::text);
  INSERT INTO ${schema}.receipt (instance_id, actor, command_id, request, result, now, entropy)
    VALUES (game.id, actor, command_id, request, answer, now_ms, drawn);
  RETURN answer;
END;
$dispatch$;
REVOKE ALL ON FUNCTION ${schema}.dispatch(uuid, uuid, text, jsonb, text, bigint) FROM PUBLIC;

CREATE FUNCTION ${schema}.deliver(instance_id uuid, event jsonb, at bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${schema} AS $deliver$
DECLARE revision bigint; answer jsonb;
BEGIN
  -- Locked as dispatch will lock it, so the revision read is the one it checks.
  SELECT i.revision INTO STRICT revision FROM ${schema}.instance i WHERE i.id = instance_id FOR UPDATE;
  -- One delivery is accepted per revision, so the revision names it.
  answer := ${schema}.dispatch(instance_id, '00000000-0000-0000-0000-000000000000', 'mecha/' || revision::text,
    jsonb_build_object('version', ${spec.version}, 'expected_revision', revision::text, 'event', event), 'mecha', at);
  IF answer->>'kind' IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'Mecha delivery refused: %', answer USING ERRCODE = 'check_violation';
  END IF;
END;
$deliver$;
REVOKE ALL ON FUNCTION ${schema}.deliver(uuid, jsonb, bigint) FROM PUBLIC;

${parts.includes("command") ? `-- A command row is the browser's whole request: inserting it dispatches it,
-- and the receipt is stamped on the row in the same transaction.
CREATE FUNCTION ${schema}.command() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${schema} AS $command$
DECLARE answer jsonb;
BEGIN
  answer := ${schema}.dispatch(NEW.instance_id, NEW.actor, NEW.id, NEW.request::jsonb, 'omnishell');
  UPDATE public.${spec.name}_command c SET outcome = answer->>'kind', reason = coalesce(answer->>'reason', ''),
    revision = (answer->>'revision')::bigint WHERE c.id = NEW.id;
  RETURN NULL;
END;
$command$;
REVOKE ALL ON FUNCTION ${schema}.command() FROM PUBLIC;
CREATE TRIGGER ${spec.name}_command_dispatch AFTER INSERT ON public.${spec.name}_command
  FOR EACH ROW EXECUTE FUNCTION ${schema}.command();` : ""}
-- Readers write only commands; everything else on the surface is the
-- machine's, written from inside its SECURITY DEFINER functions.
CREATE FUNCTION ${schema}.sealed() RETURNS trigger LANGUAGE plpgsql AS $sealed$
BEGIN
  IF current_user::text IN ('app_user', 'anon') THEN RAISE EXCEPTION '% rows are the machine''s', TG_TABLE_NAME USING ERRCODE = '42501'; END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$sealed$;
${parts.includes("command") ? `CREATE TRIGGER ${spec.name}_command_sealed BEFORE UPDATE OR DELETE ON public.${spec.name}_command
  FOR EACH ROW EXECUTE FUNCTION ${schema}.sealed();` : ""}
${parts.includes("seat") ? `CREATE TRIGGER ${spec.name}_seat_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.${spec.name}_seat
  FOR EACH ROW EXECUTE FUNCTION ${schema}.sealed();` : ""}
${spec.public ? `CREATE TRIGGER ${spec.name}_public_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.${spec.name}_public
  FOR EACH ROW EXECUTE FUNCTION ${schema}.sealed();` : ""}
COMMENT ON SCHEMA ${schema} IS ${literal(`Hybrid ${spec.name} protocol ${spec.version}; no public canonical-state access`)};
`;
  return { source: script, sql };
}
