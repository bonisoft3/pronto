import type { MechaReducerMachine } from "./mecha-reducer.ts";

type Param = {name: string; type: "uuid" | "text" | "jsonb" | "bigint"; default?: string | null};
type Admission = {name: string; params: Param[]; id: string; checks: {sql: string; reason: string; mode: "reject" | "error"}[]};
export type MechaPorts = {
  admission?: Admission;
  join?: {seat?: string; seats?: string; membersPayload?: string; phases: string[]; event: string};
  wake?: {phases: string[]; deadline: string; event: string};
  reads?: Record<string, {params: Param[]; returns: "boolean" | "jsonb"; sql: string}>;
  lease?: {touch: string; leave: string; held: string};
};
export type MechaPortSql = {
  admission?: {input: string; members: string; locks: string};
};
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(s)) throw new Error(`invalid Mecha identifier: ${s}`);
  return s;
};
const schema = (s: string) => `hybrid_${ident(s)}`;
const auth = "IF current_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;";

function fn(name: string, params: Param[], result: string, body: string, declarations = "", language = "plpgsql") {
  const names = params.map(p => ident(p.name));
  if (new Set(names).size !== names.length) throw new Error(`duplicate parameters: ${name}`);
  for (const p of params) if (!["uuid", "text", "jsonb", "bigint"].includes(p.type)) throw new Error("unsupported Mecha parameter type");
  const args = params.map(p => `${ident(p.name)} ${p.type}${p.default === null ? " DEFAULT NULL" : p.default !== undefined ? ` DEFAULT ${lit(p.default)}` : ""}`).join(", ");
  const signature = `${name}(${params.map(p => p.type).join(", ")})`;
  let tag = "$mecha_port$";
  while (body.includes(tag) || declarations.includes(tag)) tag = tag.slice(0, -1) + "_$";
  return `CREATE FUNCTION ${name}(${args}) RETURNS ${result}
LANGUAGE ${language} SECURITY DEFINER SET search_path = pg_catalog
AS ${tag}
${language === "plpgsql" ? `DECLARE ${declarations}\nBEGIN\n${body}\nEND;` : body}
${tag};
REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`;
}
const roomParam: Param[] = [{name: "instance_id", type: "uuid"}];
// A row's insert is its whole request; nothing but the machine stamps it after.
const stamp = (table: string, answer: string) => `UPDATE public.${table} o SET outcome = ${answer}->>'kind', reason = coalesce(${answer}->>'reason', '') WHERE o.id = NEW.id;`;

/** Whether a machine is opened by `<name>_open` rows: an admission a reader
 * calls with arguments, or a join. A leased machine is opened by its lease. */
export const opens = (m: MechaReducerMachine) => Boolean(m.ports?.join || (m.ports?.admission && !m.ports.lease));

export function compileMechaPorts(machines: Record<string, MechaReducerMachine>): string {
  const output: string[] = [];
  const event = (m: MechaReducerMachine, name: string) => {
    if (m.events[name]?.tier !== "mecha") throw new Error(`${m.name}.${name} must be a Mecha event`);
  };
  for (const m of Object.values(machines)) {
    const s = schema(m.name), p = m.ports ?? {}, compiled = m.mecha?.ports;
    for (const phase of [...(p.join?.phases ?? []), ...(p.wake?.phases ?? [])]) {
      if (!m.states[phase]) throw new Error(`${m.name}: undeclared admission/wake phase ${phase}`);
    }
    if (m.initialize) {
      output.push(fn(`${s}.publish`, roomParam, "void", `
SELECT * INTO STRICT game FROM ${s}.instance i WHERE i.id = instance_id FOR UPDATE;
PERFORM ${s}.settle(game, ${s}.step(jsonb_build_object('state', game.state, 'event', NULL, 'context', '{}'::jsonb,
 'viewers', (SELECT coalesce(jsonb_agg(m.seat ORDER BY m.seat), '[]'::jsonb) FROM ${s}.member m WHERE m.instance_id = game.id))));`, `game ${s}.instance;`));
      output.push(fn(`${s}.spawn`, [...roomParam, {name: "input", type: "jsonb"}, {name: "participants", type: "jsonb"}, {name: "at", type: "bigint", default: null}], "void", `
IF instance_id IS NULL OR jsonb_typeof(participants) IS DISTINCT FROM 'object' OR participants = '{}'::jsonb THEN
 RAISE EXCEPTION 'initialization requires an identity and participants'; END IF;
seeded := ${s}.step(jsonb_build_object('initialize', true, 'payload', input,
 'context', jsonb_build_object('tier', 'mecha', 'now', coalesce(at, ${s}.clock())), 'viewers', '[]'::jsonb));
INSERT INTO ${s}.instance (id, version, state) VALUES (instance_id, ${m.version}, seeded->'state');
INSERT INTO ${s}.member (instance_id, actor, seat) SELECT instance_id, value::uuid, key FROM jsonb_each_text(participants);
PERFORM ${s}.publish(instance_id);`, "seeded jsonb;"));
    }
    if (p.admission) {
      if (!m.initialize || !compiled?.admission) throw new Error(`${m.name}: admission requires initialization and compiled expressions`);
      const a = p.admission, expressions = compiled.admission;
      if (a.params.some(param => ["current_actor", "admission_id", "request_value", "prior", "answer"].includes(param.name))) throw new Error("admission parameter shadows an execution variable");
      if (["step", "settle", "dispatch", "deliver", "publish", "spawn", "wake", "arm", "join", "command", "open", "lease", "prune", "sealed"].includes(a.name)) throw new Error("admission name shadows a Mecha primitive");
      if (p.lease && a.params.length) throw new Error(`${m.name}: a leased machine's admission takes no arguments`);
      output.push(`CREATE TABLE ${s}.admission_receipt (id uuid PRIMARY KEY, actor uuid NOT NULL, request jsonb NOT NULL, result jsonb, now bigint NOT NULL);`);
      const paramsJson = `jsonb_build_object(${a.params.flatMap(param => [lit(param.name), ident(param.name)]).join(", ")})`;
      const checks = a.checks.map(check => `IF (${check.sql}) IS NOT TRUE THEN
${check.mode === "error" ? `RAISE EXCEPTION ${lit(check.reason)};` : `answer := jsonb_build_object('kind', 'rejected', 'reason', ${lit(check.reason)}, 'command_id', admission_id);
UPDATE ${s}.admission_receipt r SET result = answer WHERE r.id = admission_id;
RETURN answer;`}
END IF;`).join("\n");
      output.push(fn(`${s}.${ident(a.name)}`, a.params, "jsonb", `
${auth}
admission_id := ${a.id};
IF admission_id IS NULL THEN RAISE EXCEPTION 'admission identity required'; END IF;
request_value := ${paramsJson};
${expressions.locks}
INSERT INTO ${s}.admission_receipt (id, actor, request, now) VALUES (admission_id, current_actor, request_value, ${s}.clock()) ON CONFLICT DO NOTHING;
SELECT * INTO STRICT prior FROM ${s}.admission_receipt r WHERE r.id = admission_id FOR UPDATE;
IF prior.actor <> current_actor OR prior.request <> request_value THEN
 RAISE EXCEPTION 'admission id reused with different input or owner' USING ERRCODE = '42501'; END IF;
IF prior.result IS NOT NULL THEN RETURN prior.result; END IF;
${checks}
PERFORM ${s}.spawn(admission_id, ${expressions.input}, ${expressions.members});
answer := jsonb_build_object('kind', 'accepted', 'command_id', admission_id);
UPDATE ${s}.admission_receipt r SET result = answer WHERE r.id = admission_id;
RETURN answer;`,
        `current_actor uuid := public.auth_uid(); admission_id uuid; request_value jsonb; prior ${s}.admission_receipt; answer jsonb;`));
    }
    if (p.join) {
      if (!m.initialize) throw new Error(`${m.name}: join requires initialization`);
      event(m, p.join.event);
      const slots = p.join.seats;
      if (slots) {
        const field = m.state.type === "object" ? m.state.fields[slots] : undefined;
        const payload = m.events[p.join.event].payload;
        const members = payload.type === "object" ? payload.fields[p.join.membersPayload ?? ""] : undefined;
        if (field?.type !== "array" || field.items.type !== "string" || members?.type !== "array" || members.items.type !== "string") throw new Error("join seats and member payload must be string arrays");
      } else if (!p.join.seat) throw new Error("join requires a fixed seat or seat field");
      const choose = slots ? `SELECT slot INTO chosen FROM jsonb_array_elements_text(game.state->${lit(slots)}) WITH ORDINALITY AS candidates(slot, position)
 WHERE (requested_seat = '' OR slot = requested_seat) AND NOT EXISTS
 (SELECT FROM ${s}.member m WHERE m.instance_id = game.id AND m.seat = slot) ORDER BY position LIMIT 1;
IF chosen IS NULL THEN RETURN jsonb_build_object('kind', 'rejected', 'reason', 'seat_unavailable'); END IF;` : `chosen := ${lit(p.join.seat!)};`;
      const payload = slots ? `jsonb_build_object(${lit(p.join.membersPayload!)}, (SELECT jsonb_agg(m.seat ORDER BY m.seat) FROM ${s}.member m WHERE m.instance_id = game.id))` : "'{}'::jsonb";
      output.push(fn(`${s}.join`, [...roomParam, {name: "requested_seat", type: "text", default: ""}], "jsonb", `
${auth}
SELECT * INTO game FROM ${s}.instance i WHERE i.id = instance_id FOR UPDATE;
IF NOT FOUND THEN RETURN jsonb_build_object('kind', 'rejected', 'reason', 'room_unavailable'); END IF;
IF EXISTS (SELECT FROM ${s}.member m WHERE m.instance_id = game.id AND m.actor = current_actor) THEN
 RETURN jsonb_build_object('kind', 'accepted'); END IF;
IF game.state->>'phase' NOT IN (${p.join.phases.map(lit).join(", ")}) THEN RETURN jsonb_build_object('kind', 'rejected', 'reason', 'room_unavailable'); END IF;
${choose}
INSERT INTO ${s}.member VALUES (instance_id, current_actor, chosen);
PERFORM ${s}.deliver(instance_id, jsonb_build_object('kind', ${lit(p.join.event)}, 'payload', ${payload}));
RETURN jsonb_build_object('kind', 'accepted');`, `current_actor uuid := public.auth_uid(); game ${s}.instance; chosen text;`));
    }
    if (opens(m)) {
      const a = p.admission;
      const args = a?.params.map(param => param.name === a.id ? "NEW.instance_id"
        : param.type === "jsonb" ? `NEW.input::jsonb->${lit(param.name)}`
        : `coalesce(NEW.input::jsonb->>${lit(param.name)}${param.default != null ? `, ${lit(param.default)}` : ""})::${param.type}`).join(", ");
      output.push(`CREATE FUNCTION ${s}.open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $open$
DECLARE answer jsonb;
BEGIN
  PERFORM ${s}.serial();
  ${a ? `IF NEW.kind = 'create' THEN answer := ${s}.${ident(a.name)}(${args});` : "IF FALSE THEN NULL;"}
  ${p.join ? `ELSIF NEW.kind = 'join' THEN answer := ${s}.join(NEW.instance_id, coalesce(NEW.input::jsonb->>'requested_seat', ''));` : ""}
  ELSE RAISE EXCEPTION 'unknown open kind %', NEW.kind USING ERRCODE = '22023';
  END IF;
  ${stamp(`${m.name}_open`, "answer")}
  RETURN NULL;
END;
$open$;
REVOKE ALL ON FUNCTION ${s}.open() FROM PUBLIC;
CREATE TRIGGER ${m.name}_open_admit AFTER INSERT ON public.${m.name}_open FOR EACH ROW EXECUTE FUNCTION ${s}.open();
CREATE TRIGGER ${m.name}_open_sealed BEFORE UPDATE OR DELETE ON public.${m.name}_open FOR EACH ROW EXECUTE FUNCTION ${s}.sealed();`);
    }
    if (p.lease) {
      const a = p.admission;
      if (!a || a.id !== "current_actor") throw new Error(`${m.name}: a lease admits the reader as the instance, so the admission's id is current_actor`);
      event(m, p.lease.touch); event(m, p.lease.leave);
      const held = m.state.type === "object" ? m.state.fields[p.lease.held] : undefined;
      if (held?.type !== "array" || held.items.type !== "object" || held.items.fields.id?.type !== "string") {
        throw new Error(`${m.name}: the lease's held field lists the live sessions by id`);
      }
      // A session the machine holds: one the state's list names.
      const heldField = lit(p.lease.held);
      const holds = (who: string, session: string) =>
        `EXISTS (SELECT 1 FROM ${s}.instance i, jsonb_array_elements(i.state->${heldField}) e WHERE i.id = ${who} AND e->>'id' = ${session})`;
      output.push(`CREATE FUNCTION ${s}.prune(who uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $prune$
BEGIN
  DELETE FROM public.${m.name}_lease l WHERE l.actor = who AND NOT ${holds("who", "l.id")};
END;
$prune$;
REVOKE ALL ON FUNCTION ${s}.prune(uuid) FROM PUBLIC;
CREATE FUNCTION ${s}.lease() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $lease$
BEGIN
  PERFORM ${s}.serial();
  IF TG_OP = 'DELETE' THEN
    -- A row the machine already let lapse leaves nothing to deliver.
    PERFORM 1 FROM ${s}.instance i WHERE i.id = OLD.actor FOR UPDATE;
    IF FOUND AND ${holds("OLD.actor", "OLD.id")} THEN PERFORM ${s}.deliver(OLD.actor, jsonb_build_object('kind', ${lit(p.lease.leave)}, 'payload', jsonb_build_object('session', OLD.id))); END IF;
    RETURN OLD;
  END IF;
  PERFORM ${s}.${ident(a.name)}();
  PERFORM ${s}.deliver(NEW.actor, jsonb_build_object('kind', ${lit(p.lease.touch)}, 'payload', jsonb_build_object('session', NEW.id)));
  PERFORM ${s}.prune(NEW.actor);
  RETURN NEW;
END;
$lease$;
REVOKE ALL ON FUNCTION ${s}.lease() FROM PUBLIC;
CREATE TRIGGER ${m.name}_lease_renew AFTER INSERT OR UPDATE OR DELETE ON public.${m.name}_lease FOR EACH ROW EXECUTE FUNCTION ${s}.lease();`);
    }
    if (p.wake) {
      event(m, p.wake.event);
      if (m.state.type !== "object" || m.state.fields[p.wake.deadline]?.type !== "integer") throw new Error(`${m.name}: unknown deadline field`);
      const owner = `jsonb_build_object('machine', ${lit(m.name)}, 'row', jsonb_build_object('id', game.id::text))`;
      // `due` is the instant the ticker found due, and meets the deadline
      // whatever the database's clock reads. The step runs when the tick was
      // decided, its transaction's clock(), and never before `due`: a late
      // tick that ran at `due` would set the next deadline in the past.
      output.push(fn(`${s}.wake`, [...roomParam, {name: "due", type: "bigint"}], "void", `
SELECT * INTO STRICT game FROM ${s}.instance i WHERE i.id = instance_id FOR UPDATE;
IF game.state->>'phase' IN (${p.wake.phases.map(lit).join(", ")}) AND (game.state->>${lit(p.wake.deadline)})::bigint > 0
 AND (game.state->>${lit(p.wake.deadline)})::bigint <= due THEN
 PERFORM ${s}.deliver(instance_id, jsonb_build_object('kind', ${lit(p.wake.event)}, 'payload', '{}'::jsonb), greatest(due, ${s}.clock()));
${p.lease ? ` PERFORM ${s}.prune(instance_id);\n` : ""}-- A tick for an earlier deadline, one since cleared, or a phase since left,
-- arms what the instance holds now: the fire that brought it took its schedule.
ELSE PERFORM ${s}.arm(game); END IF;`, `game ${s}.instance;`));
      // A deadline is the ticker's: entering a phase that holds one arms a
      // one-shot schedule named by the revision that armed it, and every
      // settle replaces it.
      output.push(`CREATE FUNCTION ${s}.arm(game ${s}.instance) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $arm$
DECLARE deadline bigint := (game.state->>${lit(p.wake.deadline)})::bigint;
BEGIN
  DELETE FROM public.schedule WHERE emits_entity = 'machine_timer_tick' AND emits_values @> ${owner};
  IF game.state->>'phase' IN (${p.wake.phases.map(lit).join(", ")}) AND deadline > 0 THEN
    INSERT INTO public.schedule (name, due_at, max_lateness_seconds, emits_entity, emits_values)
      VALUES ('machine:' || ${lit(m.name)} || ':' || game.id::text || ':' || game.revision::text, to_timestamp(deadline / 1000.0), 2147483647, 'machine_timer_tick',
        ${owner} || jsonb_build_object('state', game.state->>'phase', 'delay', deadline::text));
  END IF;
END;
$arm$;
REVOKE ALL ON FUNCTION ${s}.arm(${s}.instance) FROM PUBLIC;
CREATE FUNCTION ${s}.fire() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fire$
BEGIN
  PERFORM ${s}.serial();
  IF NEW.machine <> ${lit(m.name)} OR NEW.late THEN RETURN NEW; END IF;
  DELETE FROM public.schedule WHERE name = NEW.schedule;
  PERFORM ${s}.wake((NEW."row"->>'id')::uuid, round(extract(epoch FROM NEW.tick_at) * 1000)::bigint);
  RETURN NEW;
END;
$fire$;
REVOKE ALL ON FUNCTION ${s}.fire() FROM PUBLIC;
CREATE TRIGGER ${m.name}_timer_fire AFTER INSERT ON public.machine_timer_tick FOR EACH ROW EXECUTE FUNCTION ${s}.fire();`);
    }
    for (const [name, read] of Object.entries(p.reads ?? {})) {
      output.push(fn(`${s}.${ident(name)}`, read.params, read.returns, read.sql, "", "sql"));
    }
  }
  return output.join("\n");
}
