import type { MechaReducerMachine } from "./mecha-reducer.ts";

type Param = {name: string; type: "uuid" | "text" | "jsonb"; default?: string};
type Admission = {name: string; public: boolean; params: Param[]; id: string; checks: {sql: string; reason: string; mode: "reject" | "error"}[]; result: "view" | "receipt"};
export type MechaPorts = {
  admission?: Admission;
  join?: {name: string; seat?: string; seats?: string; membersPayload?: string; phases: string[]; event: string};
  wake?: {phases: string[]; deadline: string; event: string};
  sync?: {name: string};
  reads?: Record<string, {params: Param[]; returns: "boolean" | "jsonb"; sql: string}>;
  session?: {
    name: string;
    leave: {name: string; event: string};
    renew: {event: string; when: string};
    routes: Record<string, {machine: string; kind: "admission" | "command"}>;
    sweep: string[];
  };
};
export type MechaPortSql = {
  admission?: {input: string; members: string; locks: string};
  session?: {payload: string; select: string; routes: Record<string, string[]>};
};
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(s)) throw new Error(`invalid Mecha identifier: ${s}`);
  return s;
};
const schema = (s: string) => `hybrid_${ident(s)}`;
const auth = "IF current_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;";
const now = "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const member = (s: string) => `IF NOT EXISTS (SELECT FROM ${s}.member m WHERE m.instance_id = $1 AND m.actor = current_actor) THEN
  RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;`;

function fn(name: string, params: Param[], result: string, body: string, exposed = false, declarations = "", language = "plpgsql", defaults: Record<string, string> = {}) {
  const names = params.map(p => ident(p.name));
  if (new Set(names).size !== names.length) throw new Error(`duplicate parameters: ${name}`);
  for (const p of params) if (!["uuid", "text", "jsonb"].includes(p.type)) throw new Error("unsupported Mecha parameter type");
  const args = params.map(p => `${ident(p.name)} ${p.type}${defaults[p.name] !== undefined ? ` DEFAULT ${defaults[p.name]}` : p.default !== undefined ? ` DEFAULT ${lit(p.default)}` : ""}`).join(", ");
  const signature = `${name}(${params.map(p => p.type).join(", ")})`;
  let tag = "$mecha_port$";
  while (body.includes(tag) || declarations.includes(tag)) tag = tag.slice(0, -1) + "_$";
  return `CREATE FUNCTION ${name}(${args}) RETURNS ${result}
LANGUAGE ${language} SECURITY DEFINER SET search_path = pg_catalog
AS ${tag}
${language === "plpgsql" ? `DECLARE ${declarations}\nBEGIN\n${body}\nEND;` : body}
${tag};
REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;
${exposed ? `GRANT EXECUTE ON FUNCTION ${signature} TO app_user;` : ""}`;
}
const roomParam: Param[] = [{name: "instance_id", type: "uuid"}];
const sessionParam: Param[] = [{name: "session_id", type: "uuid"}];

export function compileMechaPorts(machines: Record<string, MechaReducerMachine>): string {
  const output: string[] = [];
  const endpoints = new Set(Object.keys(machines).flatMap(name => [`${name}_command`, `${name}_view`]));
  const expose = (name: string) => {
    ident(name);
    if (endpoints.has(name)) throw new Error(`duplicate Mecha endpoint: ${name}`);
    endpoints.add(name);
    return `public.${name}`;
  };
  const target = (name: string) => {
    const machine = machines[name];
    if (!machine) throw new Error(`undeclared Mecha machine: ${name}`);
    return machine;
  };
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
projected := ${s}.step(jsonb_build_object('state', game.state, 'event', NULL, 'context', '{}'::jsonb,
 'viewers', (SELECT coalesce(jsonb_agg(m.seat ORDER BY m.seat), '[]'::jsonb) FROM ${s}.member m WHERE m.instance_id = game.id)));
INSERT INTO ${s}.view (instance_id, actor, revision, value)
 SELECT game.id, m.actor, game.revision, p->'value' FROM jsonb_array_elements(projected->'views') p
 JOIN ${s}.member m ON m.instance_id = game.id AND m.seat = p->>'viewer'
 ON CONFLICT ON CONSTRAINT view_pkey DO UPDATE SET revision = EXCLUDED.revision, value = EXCLUDED.value;`, false, `game ${s}.instance; projected jsonb;`));
      output.push(fn(`${s}.spawn`, [...roomParam, {name: "input", type: "jsonb"}, {name: "participants", type: "jsonb"}], "void", `
IF instance_id IS NULL OR jsonb_typeof(participants) IS DISTINCT FROM 'object' OR participants = '{}'::jsonb THEN
 RAISE EXCEPTION 'initialization requires an identity and participants'; END IF;
seeded := ${s}.step(jsonb_build_object('initialize', true, 'payload', input,
 'context', jsonb_build_object('tier', 'mecha', 'now', ${now}), 'viewers', '[]'::jsonb));
INSERT INTO ${s}.instance (id, version, state) VALUES (instance_id, ${m.version}, seeded->'state');
INSERT INTO ${s}.member (instance_id, actor, seat) SELECT instance_id, value::uuid, key FROM jsonb_each_text(participants);
PERFORM ${s}.publish(instance_id);`, false, "seeded jsonb;"));
    }
    if (p.admission) {
      if (!m.initialize || !compiled?.admission) throw new Error(`${m.name}: admission requires initialization and compiled expressions`);
      const a = p.admission, expressions = compiled.admission;
      if (a.params.some(param => ["current_actor", "admission_id", "request_value", "prior", "answer"].includes(param.name))) throw new Error("admission parameter shadows an execution variable");
      if (!a.public && ["step", "dispatch", "deliver", "publish", "spawn", "wake"].includes(a.name)) throw new Error("admission name shadows a Mecha primitive");
      output.push(`CREATE TABLE ${s}.admission_receipt (id uuid PRIMARY KEY, actor uuid NOT NULL, request jsonb NOT NULL, result jsonb);`);
      const paramsJson = `jsonb_build_object(${a.params.flatMap(param => [lit(param.name), ident(param.name)]).join(", ")})`;
      const checks = a.checks.map(check => `IF (${check.sql}) IS NOT TRUE THEN
${check.mode === "error" ? `RAISE EXCEPTION ${lit(check.reason)};` : `answer := jsonb_build_object('kind', 'rejected', 'reason', ${lit(check.reason)}, 'command_id', admission_id);
UPDATE ${s}.admission_receipt r SET result = answer WHERE r.id = admission_id;
RETURN answer;`}
END IF;`).join("\n");
      output.push(fn(a.public ? expose(a.name) : `${s}.${ident(a.name)}`, a.params, "jsonb", `
${auth}
admission_id := ${a.id};
IF admission_id IS NULL THEN RAISE EXCEPTION 'admission identity required'; END IF;
request_value := ${paramsJson};
${expressions.locks}
INSERT INTO ${s}.admission_receipt (id, actor, request) VALUES (admission_id, current_actor, request_value) ON CONFLICT DO NOTHING;
SELECT * INTO STRICT prior FROM ${s}.admission_receipt r WHERE r.id = admission_id FOR UPDATE;
IF prior.actor <> current_actor OR prior.request <> request_value THEN
 RAISE EXCEPTION 'admission id reused with different input or owner' USING ERRCODE = '42501'; END IF;
IF prior.result IS NOT NULL THEN
 RETURN ${a.result === "view" ? `CASE WHEN prior.result->>'kind' = 'accepted' THEN public.${m.name}_view(admission_id) ELSE prior.result END` : "prior.result"};
END IF;
${checks}
PERFORM ${s}.spawn(admission_id, ${expressions.input}, ${expressions.members});
answer := jsonb_build_object('kind', 'accepted', 'command_id', admission_id);
UPDATE ${s}.admission_receipt r SET result = answer WHERE r.id = admission_id;
RETURN ${a.result === "view" ? `public.${m.name}_view(admission_id)` : "answer"};`, a.public,
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
      const joinParams: Param[] = slots ? [...roomParam, {name: "requested_seat", type: "text", default: ""}] : roomParam;
      const choose = slots ? `SELECT slot INTO chosen FROM jsonb_array_elements_text(game.state->${lit(slots)}) WITH ORDINALITY AS candidates(slot, position)
 WHERE (requested_seat = '' OR slot = requested_seat) AND NOT EXISTS
 (SELECT FROM ${s}.member m WHERE m.instance_id = game.id AND m.seat = slot) ORDER BY position LIMIT 1;
IF chosen IS NULL THEN RAISE EXCEPTION 'seat unavailable'; END IF;` : `chosen := ${lit(p.join.seat!)};`;
      const payload = slots ? `jsonb_build_object(${lit(p.join.membersPayload!)}, (SELECT jsonb_agg(m.seat ORDER BY m.seat) FROM ${s}.member m WHERE m.instance_id = game.id))` : "'{}'::jsonb";
      output.push(fn(expose(p.join.name), joinParams, "jsonb", `
${auth}
SELECT * INTO STRICT game FROM ${s}.instance i WHERE i.id = instance_id FOR UPDATE;
IF EXISTS (SELECT FROM ${s}.member m WHERE m.instance_id = game.id AND m.actor = current_actor) THEN
 RETURN public.${m.name}_view(instance_id); END IF;
IF game.state->>'phase' NOT IN (${p.join.phases.map(lit).join(", ")}) THEN RAISE EXCEPTION 'room unavailable'; END IF;
${choose}
INSERT INTO ${s}.member VALUES (instance_id, current_actor, chosen);
PERFORM ${s}.deliver(instance_id, jsonb_build_object('kind', ${lit(p.join.event)}, 'payload', ${payload}));
RETURN public.${m.name}_view(instance_id);`, true, `current_actor uuid := public.auth_uid(); game ${s}.instance; chosen text;`));
    }
    if (p.wake) {
      event(m, p.wake.event);
      if (m.state.type !== "object" || m.state.fields[p.wake.deadline]?.type !== "integer") throw new Error(`${m.name}: unknown deadline field`);
      output.push(fn(`${s}.wake`, roomParam, "void", `
SELECT * INTO STRICT game FROM ${s}.instance i WHERE i.id = instance_id FOR UPDATE;
IF game.state->>'phase' IN (${p.wake.phases.map(lit).join(", ")}) AND (game.state->>${lit(p.wake.deadline)})::bigint <= ${now} THEN
 PERFORM ${s}.deliver(instance_id, jsonb_build_object('kind', ${lit(p.wake.event)}, 'payload', '{}'::jsonb)); END IF;`, false, `game ${s}.instance;`));
    }
    if (p.sync) {
      if (!p.wake) throw new Error(`${m.name}: sync requires a wake declaration`);
      output.push(fn(expose(p.sync.name), roomParam, "jsonb", `${auth}\n${member(s)}
PERFORM ${s}.wake(instance_id);
RETURN public.${m.name}_view(instance_id);`, true, "current_actor uuid := public.auth_uid();"));
    }
    for (const [name, read] of Object.entries(p.reads ?? {})) {
      output.push(fn(`${s}.${ident(name)}`, read.params, read.returns, read.sql, false, "", "sql"));
    }
  }
  // Session compositions are emitted after every participant's private operations.
  for (const m of Object.values(machines)) {
    const s = schema(m.name), p = m.ports, session = p?.session, compiled = m.mecha?.ports?.session;
    if (!session) continue;
    if (!p?.admission || p.admission.params.length || p.admission.public || !compiled) throw new Error(`${m.name}: sessions require private, parameterless admission`);
    event(m, session.renew.event); event(m, session.leave.event);
    const routeCalls = Object.entries(session.routes).map(([key, route]) => {
      const other = target(route.machine);
      const args = compiled.routes[key];
      const a = other.ports?.admission;
      if (route.kind === "admission" && (!a || !a.public)) throw new Error("session admission route must name a public admission");
      if (args.length !== (route.kind === "command" ? 3 : a!.params.length)) throw new Error("session route argument count mismatch");
      const call = `public.${route.kind === "command" ? `${other.name}_command` : a!.name}(${args.join(", ")})`;
      return `WHEN ${lit(key)} THEN result := ${call};`;
    }).join("\n");
    const sweeps = session.sweep.map(name => {
      const other = target(name), wake = other.ports?.wake;
      if (!wake) throw new Error(`${name}: session sweep requires a wake declaration`);
      const os = schema(name);
      return `FOR pending IN SELECT i.id FROM ${os}.instance i JOIN ${os}.member m ON m.instance_id = i.id
WHERE m.actor = current_actor AND i.state->>'phase' IN (${wake.phases.map(lit).join(", ")})
 AND (i.state->>${lit(wake.deadline)})::bigint <= ${now} ORDER BY i.id
LOOP PERFORM ${os}.wake(pending.id); END LOOP;`;
    }).join("\n");
    output.push(fn(expose(session.name), [...sessionParam, {name: "operation", type: "jsonb"}], "jsonb", `
${auth}
IF session_id IS NULL THEN RAISE EXCEPTION 'session identity required'; END IF;
operation := nullif(operation, 'null'::jsonb);
PERFORM ${s}.${ident(p.admission.name)}();
IF operation IS NOT NULL THEN CASE operation->>'type'
${routeCalls}
ELSE RAISE EXCEPTION 'unknown session operation'; END CASE; END IF;
SELECT * INTO STRICT game FROM ${s}.instance i WHERE i.id = current_actor FOR UPDATE;
IF (${session.renew.when}) THEN
 PERFORM ${s}.deliver(current_actor, jsonb_build_object('kind', ${lit(session.renew.event)}, 'payload', ${compiled.payload})); END IF;
${sweeps}
RETURN ${compiled.select};`, true, `current_actor uuid := public.auth_uid(); game ${s}.instance; pending record; result jsonb := NULL;`, "plpgsql", {operation: "NULL"}));
    output.push(fn(expose(session.leave.name), sessionParam, "void", `
${auth}
IF session_id IS NULL THEN RAISE EXCEPTION 'session identity required'; END IF;
PERFORM 1 FROM ${s}.instance i WHERE i.id = current_actor FOR UPDATE;
IF NOT FOUND THEN RETURN; END IF;
PERFORM ${s}.deliver(current_actor, jsonb_build_object('kind', ${lit(session.leave.event)}, 'payload', ${compiled.payload}));`, true, "current_actor uuid := public.auth_uid();"));
  }
  return output.join("\n");
}
