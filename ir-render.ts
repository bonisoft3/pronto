// The compiler draws, the author writes prose (docs/archive/2026-10-10-hatches.md,
// "What ir.html shows"). Every `data-kind="entity"` element in ir.html that names
// a declared entity gets a generated card after its heading. Screen headings
// likewise receive generated neighbourhoods, with their union before the first:
//
//   <section id="Game" data-kind="entity" …>
//   <!-- pronto:card -->…<!-- /pronto:card -->
//   <p>the author's prose, untouched</p>
//
// The card is HTML: chips reading `property: value`, each explaining itself on
// hover, the authored ones (durability, access) in the header and the derived
// ones (level, delivery, writers, read, roles, ir) dashed on their own line;
// every field name on one line, marked only where a mark is navigation; the
// referrers and references as links; and, for an entity a machine moves, the
// chart as the one picture — a D2 rendering carrying its own `data-kind`
// (`machine`, and `effect` for what it invokes), which is how those claims are
// answered without the author drawing them. write.ts runs this after derive.


import { render as peleRender } from "npm:pele@1.12.0";
import { labelledKind } from "./diagrams.ts";
import { chartVariantSuffixes } from "./objects.ts";

type TerminalChart = {
  field: string;
  initial: string;
  states: Record<string, unknown>;
  on?: Record<string, unknown>;
  writes: string[];
  screens: string[];
  suffix: string;
};

export type Field = { name: string; type: string; ordinal?: number; retired?: boolean; pk?: boolean; ref?: string; required?: boolean; unique?: boolean; default?: string; cel?: string };
export type Entity = {
  ir: string;
  /** The type id a diff keys on across renames (#TypeId); its fields keep
   * gap-free ordinals and a retired one stays as a tombstone. */
  id?: string;
  table: string;
  durability: string;
  level: string;
  fields: Field[];
  access?: Record<string, unknown>;
  validations?: Record<string, { note: string; ir?: string; machine?: string; on?: string[] }>;
  indexes?: { on: string }[];
  uniques?: unknown[];
  /** Derived at #App (writers.cue): every declaration that writes rows here. */
  writers: { by: string; kind: string; ops: string[] }[];
};
export type MechaMachine = {
  ir: string;
  entity: string;
  field?: string;
  initial?: string;
  level: string;
  hatches?: string[];
  states?: Record<string, { type?: string; on?: Record<string, unknown>; after?: Record<string, unknown>; invoke?: { src: string; onDone: unknown; onError: unknown } }>;
  timing?: "BEFORE" | "AFTER";
  on?: Partial<Record<"insert" | "update" | "delete", Record<string, unknown> | Record<string, unknown>[]>>;
};
// `reentry` is declared exactly when the sink is not idempotent (#ExternalEffect).
export type Effect = { ir: string; sink: { origin?: string; bridge?: string; ai?: string; tier?: string; idempotent: boolean }; reentry?: "reconcile" | "unknown" | "repeat"; note: string };
/** A vendored unit: its boundary, its ports and, for an agent, its memo. */
export type Unit = { isolation: string; ports: { reads: string[]; raises: string[] }; memo?: { entity: string; key: string[] } };
export type Screen = { ir: string; title: string; hatches?: string[]; reads: { table: string; embeds?: string[] }[] };
export type Program = {
  state: {
    entities: Record<string, Entity>;
    machines?: Record<string, MechaMachine>;
    effects?: Record<string, Effect>;
  };
  surface: { screens: Record<string, Screen> };
  capabilities: { auth?: unknown; vendored?: Record<string, Unit>; hatches?: Record<string, { ir: string; kind: string; note: string }> };
};

/** What a chip explains of itself on hover; one sentence each. */
const TIP: Record<string, string> = {
  durability: "where the row lives, the one word the author chooses: tab · device · offline · live · server",
  access: "who may read and write the row; becomes the roles and the row-level policies",
  id: "the entity's type id, which a schema diff keys on across renames; each field keeps a gap-free ordinal, and a retired field stays as a tombstone",
  retired: "retired: the ordinal is kept so no later field takes it; nothing writes the column",
  level: "",
  delivery: "what a write here can claim when delivered twice — the level's word, and at level 4 the sink's: idempotent or reconciled is exactly-once, unknown at-most-once, repeat at-least-once; a hatch is unspecified",
  writers: "who writes rows here, each as kind:name and its ops — a screen's forms and what its markup writes past them, the terminal's charts, pipelines, computations, machines, a unit's memo",
  "read by": "the vendored units handed this entity's row through their mount, read-only, with the boundary each runs behind",
  "memo of": "this entity is a question's memo: the unit's answer lands here, addressed by the key fields taken from the question, and the same question asked again is answered from the row",
  read: "how the terminal reads a server entity's table: eager syncs it whole, lazy loads what a view asks; a browser tier has no mode",
  roles: "the database roles that may touch the table, from durability and access",
  ir: "whether ir.html carries an element for it — review by consequence: a row that reaches another device or the server does",
  pk: "primary key",
  fk: "references another entity; click to go there",
  unique: "unique",
  index: "indexed",
  nullable: "nullable",
  machine: "the machine's field: only the chart moves it",
};
const LEVEL_TIP: Record<string, string> = {
  ephemeral: "1 of 5 — a register this tab or device alone writes",
  compensable: "2 of 5 — a speculative write over the server's row; the server may refuse it, and the chart must hear the no",
  replicated: "3 of 5 — a write to a row only the cluster holds, inside the transaction; delivered twice it converges, out of order it commutes",
  external: "4 of 5 — a state invokes an effect outside the cluster; the ledger claims before the call",
};
const STAMPS = new Set(["created_by", "updated_by", "created_at", "updated_at"]);
const REACH = ["tab", "device", "offline", "live", "server"];

const esc = (s: unknown) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const quoted = (s: string) => JSON.stringify(s);
const tip = (text: string) => ` data-tip="${esc(text)}" tabindex="0"`;
const chip = (name: string, value: string, derived: boolean, explain = TIP[name]) =>
  `<span class="chip${derived ? " derived" : ""}"${tip(explain)}><b>${name}</b> ${esc(value)}</span>`;

export type Neighbourhood = { entities: string[]; edges: Set<string>; machineFields: Map<string, Set<string>> };
const edgeKey = (from: string, field: string, to: string, target: string) => JSON.stringify([from, field, to, target]);

function neighbourhood(program: Program, names: Iterable<string>, machineFields: Map<string, Set<string>>): Neighbourhood {
  const entities = [...new Set(names)].sort();
  const selected = new Set(entities);
  const selectedMachineFields = new Map<string, Set<string>>();
  for (const name of entities) {
    const fields = machineFields.get(name);
    if (fields !== undefined) selectedMachineFields.set(name, new Set(fields));
  }
  const byTable = new Map(Object.entries(program.state.entities).map(([name, entity]) => [entity.table, { name, entity }]));
  const edges = new Set<string>();
  for (const name of entities) {
    const entity = program.state.entities[name];
    if (entity === undefined) throw new Error(`neighbourhood names undeclared entity ${name}`);
    for (const field of entity.fields) {
      if (field.retired || STAMPS.has(field.name) || field.ref === undefined) continue;
      const target = byTable.get(field.ref);
      if (target === undefined || !selected.has(target.name)) continue;
      const pk = target.entity.fields.find((f) => f.pk && !f.retired && !STAMPS.has(f.name));
      if (pk === undefined) throw new Error(`${name}.${field.name} references ${target.name}, which has no active primary key`);
      edges.add(edgeKey(name, field.name, target.name, pk.name));
    }
  }
  return { entities, edges, machineFields: selectedMachineFields };
}

export function screenNeighbourhood(program: Program, screenName: string, screen: Screen, chartFields: Map<string, Set<string>>): Neighbourhood {
  const byTable = new Map(Object.entries(program.state.entities).map(([name, entity]) => [entity.table, { name, entity }]));
  const names = new Set<string>();
  for (const read of screen.reads) {
    const root = byTable.get(read.table);
    if (root === undefined) throw new Error(`screen ${screenName} reads ${read.table}, the table of no declared entity`);
    names.add(root.name);
    const local = new Set([root.name]);
    for (const embed of read.embeds ?? []) {
      const direct = byTable.get(embed);
      if (direct !== undefined) {
        names.add(direct.name);
        local.add(direct.name);
        continue;
      }
      const targets = new Set<string>();
      let platform = false;
      for (const name of local) {
        for (const field of program.state.entities[name].fields) {
          if (field.name !== embed || field.ref === undefined) continue;
          const target = byTable.get(field.ref);
          if (target !== undefined) targets.add(target.name);
          else if (field.ref === "app_user") platform = true;
        }
      }
      if (targets.size > 1) throw new Error(`screen ${screenName} embed ${embed} names more than one declared entity: ${[...targets].sort().join(", ")}`);
      if (targets.size === 0 && embed !== "app_user" && !platform) throw new Error(`screen ${screenName} read ${read.table} has unresolved embed ${embed}`);
      for (const target of targets) {
        names.add(target);
        local.add(target);
      }
    }
  }
  return neighbourhood(program, names, chartFields);
}

/** A screen's related entities in D2's SQL-table grammar. */
export function neighbourhoodD2(program: Program, graph: Neighbourhood, cardIrs: Set<string>): string {
  const selected = new Set(graph.entities);
  let source = graph.edges.size === 0 && graph.entities.length > 1
    ? `grid-columns: ${Math.min(3, graph.entities.length)}\ngrid-gap: 16\n`
    : "direction: right\n";
  for (const name of graph.entities) {
    const entity = program.state.entities[name];
    if (entity === undefined) throw new Error(`neighbourhood names undeclared entity ${name}`);
    const marks = graph.machineFields.get(name) ?? new Set<string>();
    source += `${quoted(entity.ir)}: {\n  shape: sql_table\n`;
    if (cardIrs.has(entity.ir)) source += `  link: ${quoted(`#${entity.ir}`)}\n`;
    for (const field of entity.fields) {
      if (field.retired || STAMPS.has(field.name) || (!field.pk && field.ref === undefined && !marks.has(field.name))) continue;
      const constraints = [field.pk ? "primary_key" : "", field.ref === undefined ? "" : "foreign_key", marks.has(field.name) ? "machine" : ""].filter(Boolean);
      const constraint = constraints.length === 1 ? constraints[0] : quoted(constraints.join(" · "));
      source += `  ${quoted(field.name)}: ${quoted(field.type)}${constraints.length === 0 ? "" : ` {constraint: ${constraint}}`}\n`;
    }
    source += "}\n";
  }
  for (const key of [...graph.edges].sort()) {
    const [from, field, to, target] = JSON.parse(key) as [string, string, string, string];
    if (!selected.has(from) || !selected.has(to)) throw new Error(`neighbourhood edge escapes its entities: ${from}.${field} -> ${to}.${target}`);
    source += `${quoted(program.state.entities[from].ir)}.${quoted(field)} -> ${quoted(program.state.entities[to].ir)}.${quoted(target)}\n`;
  }
  return source;
}

export function mergeNeighbourhoods(graphs: Iterable<Neighbourhood>): Neighbourhood {
  const entities = new Set<string>();
  const edges = new Set<string>();
  const machineFields = new Map<string, Set<string>>();
  for (const graph of graphs) {
    for (const entity of graph.entities) entities.add(entity);
    for (const edge of graph.edges) edges.add(edge);
    for (const [entity, fields] of graph.machineFields) {
      const merged = machineFields.get(entity) ?? new Set<string>();
      for (const field of fields) merged.add(field);
      machineFields.set(entity, merged);
    }
  }
  return { entities: [...entities].sort(), edges, machineFields };
}

function entitySummary(program: Program, graph: Neighbourhood, cardIrs: Set<string>): string {
  return graph.entities.map((name) => {
    const ir = program.state.entities[name].ir;
    return cardIrs.has(ir) ? `<a href="#${esc(ir)}">${esc(ir)}</a>` : `<span>${esc(ir)}</span>`;
  }).join(", ");
}

/** The D2 source of a chart: a state a box, an invoking state dashed, a final
 * state a double ring, every arrow labelled by its event. */
export function chartD2(c: { initial: string; states: Record<string, any>; on?: Record<string, unknown> }): string {
  // Every state is a quoted key: `true`, `false` and `null` are D2 keywords,
  // and a chart over a boolean field names its states exactly that.
  const q = (name: string) => JSON.stringify(name);
  let s = 'direction: right\nstart: {shape: circle; width: 28; height: 28; style.fill: "#1b1f2a"; label: ""}\n';
  s += `start -> ${q(c.initial)}\n`;
  const target = (t: unknown) => typeof t === "string" ? t : (t as { target?: string }).target;
  const assigned = (t: unknown) => {
    const a = (t as { assign?: Record<string, unknown> }).assign;
    return a === undefined ? "" : " / " + Object.entries(a).map(([k, v]) => `${k} = ${typeof v === "string" ? v : "…"}`).join(", ");
  };
  for (const [name, st] of Object.entries(c.states)) {
    if (st.invoke) s += `${q(name)}: {label: "${name}\\ninvoke ${st.invoke.src}"; style.stroke-dash: 3}\n`;
    else if (st.type === "final") s += `${q(name)}: {shape: circle; style.double-border: true}\n`;
    for (const [ev, t] of Object.entries(st.on ?? {})) {
      for (const cand of Array.isArray(t) ? t : [t]) {
        const to = target(cand);
        if (to !== undefined) s += `${q(name)} -> ${q(to)}: "${ev}"\n`;
      }
    }
    for (const [ms, t] of Object.entries(st.after ?? {})) {
      const to = target(t) ?? name;
      s += `${q(name)} -> ${q(to)}: "after ${ms} ms${assigned(t)}"\n`;
    }
    if (st.invoke) {
      s += `${q(name)} -> ${q(target(st.invoke.onDone)!)}: onDone\n`;
      s += `${q(name)} -> ${q(target(st.invoke.onError)!)}: onError\n`;
    }
  }
  // A transition at the chart's root fires in every state: drawn once, from a
  // node that stands for any of them, rather than once per state.
  const root = Object.entries(c.on ?? {}).flatMap(([ev, t]) => (Array.isArray(t) ? t : [t]).map((cand) => [ev, target(cand)] as const).filter(([, to]) => to !== undefined));
  if (root.length > 0) {
    s += 'any: {shape: circle; width: 64; height: 64; style.stroke-dash: 3; label: "any"}\n';
    for (const [ev, to] of root) s += `any -> ${q(to!)}: "${ev}"\n`;
  }
  return s;
}

/** Renders a D2 source to SVG through the binary the app's .mise.toml pins —
 * one GitHub release, never aqua (whose registry meets rate limits), locked
 * per platform — the way check-facts runs duckdb; no browser. Only d2: a
 * locked consumer need not have installed the app's other tools to draw. */
export async function d2Svg(appDir: string, source: string): Promise<string> {
  const mise = Deno.build.os === "windows" ? `${Deno.env.get("LOCALAPPDATA")}\\mise\\bin\\mise.exe` : "mise";
  const child = new Deno.Command(mise, {
    args: ["x", "github:terrastruct/d2", "--", "d2", "--layout", "elk", "--theme", "0", "--pad", "16", "-", "-"],
    cwd: appDir,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(source));
  await w.close();
  const out = await child.output();
  if (!out.success) throw new Error(`d2: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout).replace(/^<\?xml[^>]*\?>\s*/, "");
}

type Context = {
  program: Program;
  /** Terminal charts by the table they run over, parsed. */
  charts: Map<string, TerminalChart[]>;
  /** How the terminal reads each server entity (facts `read_mode`). */
  readMode: Map<string, string>;
  d2: (source: string) => Promise<string>;
};

function reachOf(d: Iterable<string>): string {
  let far = 0;
  for (const x of d) far = Math.max(far, REACH.indexOf(x));
  return REACH[far];
}

function machineEntity(entities: Record<string, Entity>, machine: MechaMachine): string {
  if (entities[machine.entity] !== undefined) return machine.entity;
  const name = Object.keys(entities).find((name) => entities[name].table === machine.entity);
  if (name === undefined) throw new Error(`machine ${machine.ir} names undeclared entity ${machine.entity}`);
  return name;
}

/** The notes column of the authored `data-extract="fields"` table in an
 * entity element, by field. The card shows them beside what program.cue says,
 * so the authored table, hop 2's input, can stay collapsed under it. */
export function authoredNotes(element: string): Map<string, string> {
  const table = /<table\b[^>]*data-extract="fields"[^>]*>([\s\S]*?)<\/table>/.exec(element);
  if (table === null) return new Map();
  const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => ({ head: c[1] === "h", html: c[2].trim() }))
  );
  const head = rows.find((r) => r.length > 0 && r.every((c) => c.head));
  if (head === undefined) return new Map();
  const at = (word: string) => head.findIndex((c) => c.html.toLowerCase() === word);
  const field = at("field"), notes = at("notes");
  if (field === -1 || notes === -1) return new Map();
  return new Map(rows.filter((r) => r !== head && r[notes]?.html).map((r) => [r[field].html, r[notes].html]));
}

/** A JSON value as nested <details>, each object and array collapsible. */
function jsonTree(key: string, value: unknown): string {
  const k = `<span class="jk">${esc(key)}</span>`;
  if (value === null || typeof value !== "object") return `<div class="jl">${k}: <span class="jv">${esc(JSON.stringify(value))}</span></div>`;
  const entries = Object.entries(value);
  if (key === "seed" && Array.isArray(value)) return `<div class="jl">${k}: <span class="jv">[${entries.length}]</span></div>`;
  const named = (value as { name?: unknown }).name;
  const shape = Array.isArray(value) ? `[${entries.length}]` : typeof named === "string" ? esc(named) : `{${entries.length}}`;
  return `<details class="jn"><summary>${k} <span class="jv">${shape}</span></summary>${entries.map(([ck, cv]) => jsonTree(ck, cv)).join("")}</details>`;
}

/** One entity's card. */
export async function cardHtml(name: string, e: Entity, ctx: Context, notes: ReadonlyMap<string, string> = new Map()): Promise<string> {
  const { entities } = ctx.program.state;
  const byTable = new Map(Object.entries(entities).map(([n, x]) => [x.table, { name: n, ...x }]));
  const fields = e.fields.filter((f) => !STAMPS.has(f.name) && !f.retired);
  const retired = e.fields.filter((f) => f.retired);
  const idx = new Set((e.indexes ?? []).map((i) => i.on));
  const machines = [
    ...(ctx.charts.get(e.table) ?? []).map((c) => ({
      id: `${e.ir}-${c.field}${c.suffix}`,
      title: `${e.ir} · ${c.field}${c.suffix ? ` · ${c.screens.join(", ")} (${c.suffix.slice(1)})` : ""}`,
      level: e.level,
      chart: c,
      invokes: [] as string[],
      lifecycle: undefined as MechaMachine["on"],
      timing: undefined as MechaMachine["timing"],
      hatches: [] as string[],
    })),
    ...Object.values(ctx.program.state.machines ?? {}).filter((m) => machineEntity(entities, m) === name).map((m) => ({
      id: m.ir,
      title: m.field === undefined ? m.ir : `${m.ir} · ${m.field}`,
      level: m.level,
      chart: m.states === undefined ? null : (() => {
        if (m.initial === undefined || m.field === undefined) throw new Error(`machine ${m.ir} has states without a field and initial state`);
        return { field: m.field, initial: m.initial, states: m.states };
      })(),
      invokes: [...new Set(Object.values(m.states ?? {}).flatMap((s) => s.invoke === undefined ? [] : [s.invoke.src]))],
      lifecycle: m.on,
      timing: m.timing,
      hatches: m.hatches ?? [],
    })),
  ];
  const machineField = new Set(machines.flatMap((m) => m.chart === null ? [] : [m.chart.field]));
  const refs = fields.filter((f) => f.ref).map((f) => ({ col: f.name, ref: f.ref! }));
  const referrers: { table: string; col: string }[] = [];
  for (const other of Object.values(entities)) for (const f of other.fields) if (f.ref === e.table) referrers.push({ table: other.table, col: f.name });
  const access = e.access ?? {};
  const accessValue = Object.entries(access).map(([k, v]) => k === "scope" ? String(v) : `${k} ${v}`).join(" · ") || "—";
  const anyAccess = Object.values(entities).some((x) => x.access !== undefined);
  const authOn = ctx.program.capabilities.auth !== undefined || anyAccess;
  const writers = e.writers.map((w) => `${w.kind}:${w.by} ${w.ops.join("·")}`);
  const units = Object.entries(ctx.program.capabilities.vendored ?? {});
  const readBy = units.filter(([, u]) => u.ports.reads.includes(name)).map(([n, u]) => `${n} (${u.isolation})`);
  const memoOf = units.filter(([, u]) => u.memo?.entity === name).map(([n, u]) => `${n} by ${u.memo!.key.join(" · ")}`);
  // A browser tier has no read mode (#Entity `read`), and every server entity
  // has its `read_mode` row before the card is drawn (write.ts derives first).
  const server = e.durability !== "tab" && e.durability !== "device";
  const readMode = !server ? "—" : ctx.readMode.get(name) ?? (() => {
    throw new Error(`${name} is a server entity with no read_mode fact row`);
  })();
  // Delivery is the level's word (the record's table), and at level 4 the
  // sink's: idempotent or reconciled is exactly-once, unknown at-most-once,
  // repeat at-least-once.
  const reentryOf = (x: Effect) =>
    x.reentry ?? (() => {
      throw new Error(`effect ${x.ir} is not idempotent and states no reentry`);
    })();
  const deliveryOf = (level: string, effect: Effect | null) => {
    if (level === "compensable") return "at-most-once";
    if (level !== "external") return "exactly-once";
    if (effect === null) throw new Error(`${name}: an external machine invokes no effect`);
    if (effect.sink.idempotent) return "exactly-once";
    return { reconcile: "exactly-once", unknown: "at-most-once", repeat: "at-least-once" }[reentryOf(effect)];
  };
  const panels = machines.map((m) => {
    const effects = m.invokes.map((src) => {
      const effect = ctx.program.state.effects?.[src];
      if (effect === undefined) throw new Error(`machine ${m.id} invokes ${src}, which is no declared effect`);
      return { src, effect, delivery: deliveryOf(m.level, effect) };
    });
    const hatches = m.hatches.map((name) => {
      const hatch = ctx.program.capabilities.hatches?.[name];
      if (hatch === undefined || hatch.kind !== "sql") throw new Error(`machine ${m.id} calls undeclared SQL hatch ${name}`);
      return hatch;
    });
    const deliveries = hatches.length > 0 ? ["unspecified"] : effects.length === 0 ? [deliveryOf(m.level, null)] : effects.map((e) => e.delivery);
    return { ...m, effects, hatches, deliveries: [...new Set(deliveries)] };
  });
  // The pivot's word is the entity's; the classes are not totally ordered, so
  // external machines that differ each show theirs.
  const external = [...new Set(panels.filter((m) => m.level === "external" || m.hatches.length > 0).flatMap((m) => m.deliveries))];
  const delivery = external.length > 0 ? external.join(" · ") : deliveryOf(e.level, null);
  const glyphs = (f: Field) => [
    f.retired ? `<span class="g"${tip(TIP.retired)}>†</span>` : "",
    f.pk ? `<span class="g pk"${tip(TIP.pk)}>pk</span>` : "",
    f.ref ? `<a class="g fk" href="#${esc(byTable.get(f.ref)?.ir ?? f.ref)}"${tip(TIP.fk)}>→ ${esc(f.ref)}</a>` : "",
    machineField.has(f.name) ? `<span class="g mach"${tip(TIP.machine)}>machine</span>` : "",
    f.unique ? `<span class="g"${tip(TIP.unique)}>◇</span>` : "",
    idx.has(f.name) ? `<span class="g"${tip(TIP.index)}>≡</span>` : "",
    f.required === false ? `<span class="g"${tip(TIP.nullable)}>○</span>` : "",
  ].join("");
  const rule = (f: Field) => f.cel ?? (f.default !== undefined && f.default !== "" ? `= ${f.default}` : "");
  const nameToken = (f: Field) =>
    `<span class="fname">${esc(f.name)}${f.pk ? '<i class="m">pk</i>' : ""}${f.ref ? '<i class="m">→</i>' : ""}${machineField.has(f.name) ? '<i class="m mach">⚙</i>' : ""}</span>`;
  const pills = <T,>(items: T[], keep: number, one: (t: T) => string) =>
    items.slice(0, keep).map(one).join("") +
    (items.length > keep ? `<details class="more inline"><summary>+${items.length - keep}</summary><span class="rels">${items.slice(keep).map(one).join("")}</span></details>` : "");
  const validations = Object.entries(e.validations ?? {});
  const peer = (x: Effect) => x.sink.idempotent ? "idempotent" : `not idempotent · re-entry ${esc(reentryOf(x))}`;
  const machinePanels = await Promise.all(panels.map(async (m) => {
    const diagram = m.chart === null ? "" : `<div class="canvas">${await ctx.d2(chartD2(m.chart))}</div>`;
    const lifecycle = Object.entries(m.lifecycle ?? {}).map(([event, transition]) => {
      const branch = !Array.isArray(transition) && ("guard" in transition || "actions" in transition);
      const guard = branch ? transition.guard : undefined;
      const guards = guard === undefined ? [] : Array.isArray(guard) ? guard : [guard];
      const actions = branch ? transition.actions ?? [] : transition;
      const names = guards.map(name => {
        const predicate = e.validations?.[String(name)];
        if (!predicate) throw new Error(`lifecycle machine ${m.id} names unknown guard ${name}`);
        return `<a href="#${esc(predicate.ir ?? String(name))}">${esc(String(name))}</a>`;
      }).join(", ") || "—";
      return `<tr><th>${esc(m.timing ?? "AFTER")} ${esc(event)}</th><td>${names}</td><td><code>${esc(JSON.stringify(actions))}</code></td></tr>`;
    }).join("");
    return `<section class="machine" data-kind="machine" id="${esc(m.id)}" data-of="${esc(e.ir)}">
<span class="lbl derived">machine</span>
<span class="mtitle">${esc(m.title)} ${chip("level", m.level, true, LEVEL_TIP[m.level])}${chip("delivery", m.deliveries.join(" · "), true)}</span>
${diagram}${lifecycle === "" ? "" : `<table class="fields"><thead><tr><th>event</th><th>guards</th><th>actions</th></tr></thead><tbody>${lifecycle}</tbody></table>`}${
      m.effects.map(({ src, effect, delivery }) => `
<p class="why" data-kind="effect" id="${esc(effect.ir)}" data-of="${esc(m.id)}">${chip("effect", src, true, "an act outside the cluster, performed by the airlock; the ledger claims it before the call")} → ${esc(effect.sink.origin ?? (effect.sink.ai ? `ai ${effect.sink.ai} (${effect.sink.tier ?? "cheap"})` : `bridge ${effect.sink.bridge}`))} · ${peer(effect)}${m.effects.length > 1 ? ` ${chip("delivery", delivery, true)}` : ""} · <span class="note">${esc(effect.note)}</span></p>`).join("")
    }${m.hatches.map((h) => `\n<p class="why">SQL hatch <a href="#${esc(h.ir)}">${esc(h.ir)}</a> · ${chip("delivery", "unspecified", true)} · <span class="note">${esc(h.note)}</span></p>`).join("")}
</section>`;
  }));
  const owed = reachOf([e.durability, ...machines.flatMap((m) => (m.chart as { writes?: string[] } | null)?.writes ?? []).map((t) => byTable.get(t)?.durability ?? "tab")]) !== "tab";
  return `<div class="card dur-${esc(e.durability)}">
<header class="ehead">
<span class="chips">${chip("durability", e.durability, false)}${chip("access", accessValue, false)}${e.id === undefined ? "" : chip("id", e.id, false)}${chip("level", e.level, true, LEVEL_TIP[e.level])}${chip("delivery", delivery, true)}</span>
<span class="counts">${fields.length} fields · ${referrers.length} referrers${machines.length > 0 ? ` · ${machines.length} machine${machines.length > 1 ? "s" : ""}` : ""}</span>
</header>
<div class="names"><span class="lbl">fields</span><span class="namelist">${fields.map(nameToken).join("")}</span>
<details class="more"><summary>all fields, with their metadata</summary>
<table class="fields">${[...fields, ...retired].map((f) => `<tr${f.retired ? ' class="retired"' : ""}><td class="o">${f.ordinal ?? ""}</td><td class="k">${esc(f.name)}</td><td class="t">${esc(f.type)}</td><td class="gl">${glyphs(f)}</td><td class="x" title="${esc(rule(f))}">${esc(rule(f))}</td>${notes.size === 0 ? "" : `<td class="n">${notes.get(f.name) ?? ""}</td>`}</tr>`).join("")}</table>
<p class="legend">${e.id === undefined ? "" : "the first column is the field's ordinal, which a diff keys on · "}<span class="g pk">pk</span> primary key · <span class="g fk">→</span> references · <span class="g">◇</span> unique · <span class="g">≡</span> indexed · <span class="g">○</span> nullable${retired.length > 0 ? ' · <span class="g">†</span> retired' : ""} · a rule or default${notes.size === 0 ? " in the last column" : ", then the author's note"}</p>
</details>
<details class="more authored"><summary>the authored table</summary></details>
<details class="more json"><summary>the entity, as JSON</summary><div class="jt">${Object.entries(e).map(([k, v]) => jsonTree(k, v)).join("")}</div></details></div>
<div class="strips">
<div class="strip"><span class="lbl">referenced by</span><span class="rels">${pills(referrers, 3, (r) => `<a class="rel in" href="#${esc(byTable.get(r.table)?.ir ?? r.table)}">${esc(r.table)}<span class="col">.${esc(r.col)}</span></a>`) || '<span class="why">—</span>'}</span></div>
<div class="strip"><span class="lbl">refers to</span><span class="rels">${pills(refs, 4, (r) => `<a class="rel out" href="#${esc(byTable.get(r.ref)?.ir ?? r.ref)}">${esc(r.ref)}<span class="col"> via ${esc(r.col)}</span></a>`) || '<span class="why">—</span>'}</span></div>
<div class="strip"><span class="lbl">validations</span>${validations.length === 0 ? '<span class="why">none</span>' : `<ul class="vals">${validations.map(([n, v]) => `<li><code>${esc(n)}</code> <span class="note">${esc(v.note)}</span></li>`).join("")}</ul>`}</div>
</div>
<div class="dline"><span class="lbl derived">derived</span><span class="chips">${chip("writers", writers.join(", ") || "—", true)}${chip("read", readMode, true)}${chip("roles", authOn ? "anon · app_user · service" : "anon", true)}${chip("ir", owed ? "required" : "optional", true)}${readBy.length === 0 ? "" : chip("read by", readBy.join(", "), true)}${memoOf.length === 0 ? "" : chip("memo of", memoOf.join(", "), true)}</span>
<details class="more"><summary>the platform’s columns</summary><p class="why"><code>created_by</code>, <code>updated_by</code> → app_user, stamped by the platform on every write; not the author’s.</p></details></div>
${machinePanels.join("\n")}
</div>`;
}

const OPEN = "<!-- pronto:card -->";
const CLOSE = "<!-- /pronto:card -->";
const NEIGHBOURHOOD_OPEN = "<!-- pronto:neighbourhood -->";
const NEIGHBOURHOOD_CLOSE = "<!-- /pronto:neighbourhood -->";
const APP_OPEN = "<!-- pronto:app-neighbourhood -->";
const APP_CLOSE = "<!-- /pronto:app-neighbourhood -->";
const MERMAID_OPEN = "<!-- pronto:mermaid -->";
const MERMAID_CLOSE = "<!-- /pronto:mermaid -->";
const MERMAID_BLOCK = /<(pre|div)\s([^>]*)>([\s\S]*?)<\/\1>/g;
const MERMAID_CLASS = /(^|\s)class="mermaid"/;
const ENTITY_TAG = /<([a-z][a-z0-9]*)\s[^>]*data-kind="entity"[^>]*>/g;
const ENTITY_START = /<[a-z][a-z0-9]*\s[^>]*data-kind="entity"/;
const SCREEN_TAG = /<([a-z][a-z0-9]*)\s[^>]*data-kind="screen"[^>]*>/g;
const ID = /\sid="([^"]*)"/;

const decodeHtml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

function nodeRole(id: string, body: string, program?: Program): string | null {
  const labelMatch = /<text\b[^>]*\bclass="pele-label"[^>]*>([\s\S]*?)<\/text>/.exec(body);
  const label = labelMatch === null ? id : decodeHtml(labelMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const parsed = labelledKind(label);
  if (parsed !== null) {
    const head = parsed.kind.split(/\s+/)[0];
    if (REACH.includes(head)) return head;
    if (head === "external" || head === "machine" || head === "compensable" || head === "replicated" || head === "ephemeral" || head === "local") return "machine";
    if (head === "ai" || head === "effect" || head === "origin" || head === "bridge") return "effect";
    if (head === "screen") return "screen";
    if (head === "handler" || head === "engine" || head === "unit" || head === "hatch" || head === "pipeline" || head === "drain" || head === "duckstream") return "handler";
    if (head === "crud" && program !== undefined) {
      const entity = program.state.entities[parsed.name] ?? Object.values(program.state.entities).find((e) => e.ir === parsed.name);
      if (entity !== undefined) return entity.durability;
    }
  }
  if (/^\S+\s*\(\/[^)]*\)\s*$/.test(label)) return "screen";
  if (program !== undefined) {
    const entity = program.state.entities[id] ?? Object.values(program.state.entities).find((e) => e.ir === id);
    if (entity !== undefined) return entity.durability;
    if (program.state.machines?.[id] !== undefined) return "machine";
    if (program.state.effects?.[id] !== undefined) return "effect";
    const screen = program.surface.screens[id] ?? Object.values(program.surface.screens).find((s) => s.ir === id);
    if (screen !== undefined) return "screen";
  }
  return null;
}

/** Renders a Mermaid source block to a semantic Pele SVG figure, annotating
 * nodes with `data-role` and a left accent band so `ir/card.css` themes them. */
export function peleDiagram(source: string, program?: Program): string {
  const { svg } = peleRender(source.trim());
  const annotated = svg.replace(
    /<g class="(pele-node[^"]*)" data-id="([^"]+)"([^>]*)>([\s\S]*?)<\/g>/g,
    (full, cls: string, id: string, attrs: string, body: string) => {
      const role = nodeRole(id, body, program);
      if (role === null) return full;
      const withBand = cls.includes("pele-shape-rect") && role !== "effect" && role !== "machine"
        ? body.replace(
          /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"([^/]*)\/>/,
          (rect, x: string, y: string, _w: string, h: string) =>
            `${rect}<rect class="pele-band" x="${x}" y="${y}" width="4.5" height="${h}" rx="2" fill="var(--_b)"/>`,
        )
        : body;
      return `<g class="${cls}" data-id="${id}" data-role="${esc(role)}"${attrs}>${withBand}</g>`;
    },
  );
  return `<figure class="pronto-pele">${annotated}</figure>`;
}

/** Places or replaces a `<!-- pronto:mermaid -->` Pele SVG figure immediately
 * after each `<div class="mermaid">` or `<pre class="mermaid">` block while
 * keeping the authored Mermaid source intact for `diagrams.ts`. */
export function fillMermaidRegions(html: string, program?: Program): string {
  let out = "";
  let at = 0;
  for (const block of html.matchAll(MERMAID_BLOCK)) {
    if (!MERMAID_CLASS.test(block[2])) continue;
    const after = block.index! + block[0].length;
    out += html.slice(at, after);
    let resume = after;
    const marker = /^\s*<!-- pronto:mermaid -->/.exec(html.slice(after));
    if (marker !== null) {
      const start = after + marker[0].length - MERMAID_OPEN.length;
      const end = html.indexOf(MERMAID_CLOSE, start + MERMAID_OPEN.length);
      if (end === -1) throw new Error("ir.html: a mermaid region opens and never closes");
      resume = end + MERMAID_CLOSE.length;
    }
    const fig = peleDiagram(decodeHtml(block[3]), program);
    out += `\n${MERMAID_OPEN}${fig}${MERMAID_CLOSE}`;
    at = resume;
  }
  return out + html.slice(at);
}

/** The generated regions in an ir.html, by the entity id they sit under. */
export function irRegions(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of html.matchAll(ENTITY_TAG)) {
    const id = ID.exec(tag[0])?.[1];
    if (id === undefined) continue;
    const after = cardSite(html, tag.index! + tag[0].length);
    if (!html.slice(after, after + OPEN.length + 8).trimStart().startsWith(OPEN)) continue;
    const start = html.indexOf(OPEN, after);
    const end = html.indexOf(CLOSE, start);
    if (end === -1) throw new Error(`ir.html: the card under "${id}" opens and never closes`);
    out.set(id, html.slice(start + OPEN.length, end));
  }
  return out;
}

/** Where an entity's card goes: after its element's opening tag, or after the
 * heading that opens the element, so the author's title stays first. */
function cardSite(html: string, after: number): number {
  const m = /^\s*<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/.exec(html.slice(after, after + 2000));
  return m === null ? after : after + m[0].length;
}

/** ir.html with each named entity's card placed or replaced at its site;
 * elements naming no card are left as they are. */
export function fillRegions(html: string, cards: Map<string, string>): string {
  let out = "";
  let at = 0;
  for (const tag of html.matchAll(ENTITY_TAG)) {
    const id = ID.exec(tag[0])?.[1];
    const card = id === undefined ? undefined : cards.get(id);
    if (card === undefined) continue;
    const after = cardSite(html, tag.index! + tag[0].length);
    out += html.slice(at, after);
    let resume = after;
    if (html.slice(after, after + OPEN.length + 8).trimStart().startsWith(OPEN)) {
      const end = html.indexOf(CLOSE, after);
      if (end === -1) throw new Error(`ir.html: the card under "${id}" opens and never closes`);
      resume = end + CLOSE.length;
    }
    out += `\n${OPEN}${card}${CLOSE}`;
    at = resume;
  }
  return out + html.slice(at);
}

function stripAppNeighbourhood(html: string): string {
  const start = html.indexOf(APP_OPEN);
  if (start === -1) return html;
  if (html.indexOf(APP_OPEN, start + APP_OPEN.length) !== -1) throw new Error("ir.html: more than one app neighbourhood region");
  const end = html.indexOf(APP_CLOSE, start + APP_OPEN.length);
  if (end === -1) throw new Error("ir.html: the app neighbourhood opens and never closes");
  const resume = end + APP_CLOSE.length + (html[end + APP_CLOSE.length] === "\n" ? 1 : 0);
  return html.slice(0, start) + html.slice(resume);
}

/** Replaces each screen graph after its heading and the collapsed app graph
 * before the first screen. Missing screen content removes a prior region. */
export function fillNeighbourhoodRegions(html: string, screens: Map<string, string>, app: string | null): string {
  let out = "";
  let at = 0;
  for (const tag of html.matchAll(SCREEN_TAG)) {
    const id = ID.exec(tag[0])?.[1];
    if (id === undefined) continue;
    const site = cardSite(html, tag.index! + tag[0].length);
    out += html.slice(at, site);
    const marker = /^\s*<!-- pronto:neighbourhood -->/.exec(html.slice(site));
    let resume = site;
    if (marker !== null) {
      const start = site + marker[0].length - NEIGHBOURHOOD_OPEN.length;
      const end = html.indexOf(NEIGHBOURHOOD_CLOSE, start + NEIGHBOURHOOD_OPEN.length);
      if (end === -1) throw new Error(`ir.html: the neighbourhood under "${id}" opens and never closes`);
      resume = end + NEIGHBOURHOOD_CLOSE.length;
    }
    const graph = screens.get(id);
    if (graph !== undefined) out += `\n${NEIGHBOURHOOD_OPEN}${graph}${NEIGHBOURHOOD_CLOSE}`;
    at = resume;
  }
  const withoutApp = stripAppNeighbourhood(out + html.slice(at));
  if (app === null) return withoutApp;
  const first = SCREEN_TAG.exec(withoutApp);
  SCREEN_TAG.lastIndex = 0;
  if (first === null) throw new Error("ir.html: an app neighbourhood has no screen element to precede");
  return withoutApp.slice(0, first.index) + `${APP_OPEN}${app}${APP_CLOSE}\n` + withoutApp.slice(first.index);
}

/** The card's stylesheet, as the ir's head links it (`ir/card.css`). Tokens
 * only, light and dark; the ir's own styles own everything else. */
export const CARD_CSS = `/* generated by pronto from program.cue — do not edit */
:root { color-scheme: light dark; }
:where(body) { max-width: 64rem; margin: 2rem auto; padding: 0 1.25rem; font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
.card, .pronto-neighbourhood, .pronto-pele { --card-ink: #191714; --card-muted: #5c584e; --card-line: #dfd8c8; --card-panel: #fdfbf7; --card-head: #f6f1e6; --card-sub: #faf7f0; --card-token: #f2ece0; --card-accent: #2443b8; --card-derived-bg: #eef2ff; --card-mach-bg: #f8faff; --card-tip: #fff6bf; --card-tip-edge: #e3cf5a; --pele-dot: #d5cdbe; --band: var(--card-accent); }
@media (prefers-color-scheme: dark) { .card, .pronto-neighbourhood, .pronto-pele { --card-ink: #e8eaf0; --card-muted: #9aa3bd; --card-line: #2a3040; --card-panel: #161922; --card-head: #1d2230; --card-sub: #1a1e2b; --card-token: #232838; --card-accent: #8ea2ff; --card-derived-bg: #1e243b; --card-mach-bg: #181d2e; --card-tip: #3a3410; --card-tip-edge: #8a7a2a; --pele-dot: #2e3446; } }
.card {
  position: relative; background: var(--card-panel); border: 1px solid var(--card-line); border-radius: 8px; box-shadow: 0 1px 3px rgba(25, 23, 20, 0.05); color: var(--card-ink); font-size: 14px; line-height: 1.5; margin: 14px 0 22px; overflow: hidden; }
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--band); z-index: 1; }
.card.dur-server { --band: #2443b8; } .card.dur-live { --band: #1a8f5c; } .card.dur-offline { --band: #b8860b; } .card.dur-device { --band: #0e7c86; } .card.dur-tab { --band: #64748b; }
.card .ehead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 18px 10px 22px; background: var(--card-head); border-bottom: 1px solid var(--card-line); }
.card .chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.card .chip { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; padding: 2px 10px; background: var(--card-panel); border: 1px solid var(--card-line); border-radius: 999px; white-space: nowrap; }
.card .chip b { font-weight: 600; color: var(--card-muted); margin-right: 4px; font-family: inherit; }
.card .chip b::after { content: ":"; }
.card .chip.derived { background: var(--card-derived-bg); border-style: dashed; border-color: var(--card-accent); color: var(--card-accent); }
.card .chip.derived b { color: var(--card-accent); opacity: 0.85; }
.card .counts { margin-left: auto; color: var(--card-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: var(--card-panel); border: 1px solid var(--card-line); border-radius: 6px; padding: 2px 8px; }
.card [data-tip] { position: relative; cursor: help; }
.card [data-tip]:hover::after, .card [data-tip]:focus-visible::after { content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); z-index: 10; background: var(--card-tip); color: var(--card-ink); border: 1px solid var(--card-tip-edge); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); padding: 8px 10px; font-size: 12.5px; line-height: 1.4; width: max-content; max-width: 34ch; white-space: normal; font-family: system-ui, sans-serif; font-weight: 400; text-transform: none; letter-spacing: 0; }
.card .lbl { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--card-muted); font-weight: 700; margin-right: 6px; }
.card .lbl.derived { color: var(--card-accent); }
.card .names { display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: baseline; padding: 12px 18px 12px 22px; }
.card .namelist { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.card .fname { display: inline-flex; align-items: baseline; background: var(--card-token); border: 1px solid var(--card-line); border-radius: 4px; padding: 1px 7px; margin: 0; font-weight: 500; }
.card .m { font-style: normal; font-size: 10px; color: var(--card-muted); margin-left: 3px; }
.card .m.mach { color: var(--card-accent); font-weight: 700; }
.card .names .more { grid-column: 1 / -1; background: var(--card-sub); border: 1px solid var(--card-line); border-radius: 6px; padding: 4px 10px; }
.card .more > summary { list-style: none; cursor: pointer; color: var(--card-ink); font-size: 12px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; user-select: none; }
.card .more > summary::-webkit-details-marker { display: none; }
.card .more > summary::before { content: "▸ "; color: var(--band); } .card .more[open] > summary::before { content: "▾ "; color: var(--band); }
.card .more.inline { display: inline; background: none; border: 0; padding: 0; } .card .more.inline[open] > summary { display: inline; margin-right: 6px; }
.card .more.inline .rels { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.card .fields { border-collapse: collapse; font-size: 12.5px; width: 100%; margin: 8px 0 0; }
.card .fields td, .card .fields th { padding: 5px 10px 5px 4px; border: 0; border-bottom: 1px solid var(--card-line); vertical-align: baseline; text-align: left; }
.card .fields th { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--card-muted); }
.card .fields .k { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; } .card .fields .t { color: var(--card-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.card .fields .o { color: var(--card-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; width: 2.5ch; text-align: right; }
.card .fields tr.retired td { color: var(--card-muted); text-decoration: line-through; } .card .fields tr.retired td.gl { text-decoration: none; }
.card .fields .gl { white-space: nowrap; } .card .fields .x { color: var(--card-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .g { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; margin-right: 5px; color: var(--card-muted); padding: 1px 5px; border-radius: 3px; background: var(--card-token); }
.card .g.pk { font-weight: 700; color: #855f00; background: #fef3c7; border: 1px solid #fcd34d; } .card .g.fk { color: var(--card-accent); text-decoration: none; }
.card .g.mach { color: var(--card-accent); background: var(--card-derived-bg); border: 1px dashed var(--card-accent); }
.card .fields .n { color: var(--card-muted); font-size: 12px; }
[data-kind="entity"]:has(> .card) > table[data-extract="fields"] { display: none; }
[data-kind="entity"]:has(> .card .authored[open]) > table[data-extract="fields"] { display: table; }
.card .jt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-top: 6px; }
.card .jn > summary { cursor: pointer; } .card .jl { padding-left: 1.2em; } .card .jn > :not(summary) { margin-left: 14px; }
.card .jk { color: var(--card-accent); } .card .jv { color: var(--card-muted); }
.card .legend { color: var(--card-muted); font-size: 11.5px; margin: 8px 0 2px; }
.card .strips { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 10px 14px; padding: 10px 18px 12px 22px; border-top: 1px solid var(--card-line); align-items: stretch; }
.card .strip { display: flex; flex-wrap: wrap; align-items: baseline; align-content: flex-start; gap: 6px 8px; background: var(--card-sub); border: 1px solid var(--card-line); border-radius: 6px; padding: 8px 12px; }
.card .rels { display: flex; flex-wrap: wrap; gap: 6px; }
.card .rel { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; padding: 2px 8px; background: var(--card-panel); border: 1px solid var(--card-line); border-radius: 4px; color: var(--card-ink); text-decoration: none; }
.card .rel .col { color: var(--card-muted); } .card .rel.in { border-left: 3px solid var(--band); } .card .rel.out { border-right: 3px solid var(--band); }
.card .vals { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; font-size: 12px; } .card .note { color: var(--card-muted); font-style: italic; }
.card .why { color: var(--card-muted); font-size: 12.5px; margin: 0; }
.card .dline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 9px 18px 10px 22px; background: var(--card-head); border-top: 1px solid var(--card-line); }
.card .machine { display: grid; gap: 10px; padding: 12px 18px 14px 22px; background: var(--card-mach-bg); border-top: 1px dashed var(--card-accent); }
.card .mtitle { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13.5px; font-weight: 600; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.card .canvas { overflow-x: auto; background: var(--card-panel); border: 1px solid var(--card-line); border-radius: 6px; padding: 8px; } .card .canvas > svg { display: block; width: 100%; height: auto; max-width: min(100%, 880px); max-height: 360px; }
.pronto-neighbourhood { max-width: 100%; margin: 12px 0 20px; padding: 10px 14px; background: var(--card-sub); border: 1px solid var(--card-line); border-radius: 8px; color: var(--card-ink); }
.pronto-neighbourhood > summary { cursor: pointer; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.pronto-neighbourhood .neighbourhood-canvas { max-width: 100%; max-height: min(70vh, 720px); overflow: auto; padding: 10px; margin-top: 6px; background-color: var(--card-panel); background-image: radial-gradient(var(--pele-dot) 0.85px, transparent 0.85px); background-size: 16px 16px; border: 1px solid var(--card-line); border-radius: 6px; }
.pronto-neighbourhood .neighbourhood-canvas:focus-visible { outline: 2px solid var(--card-accent); outline-offset: 2px; }
.pronto-neighbourhood .neighbourhood-canvas > img { display: block; max-width: none; }
.pronto-neighbourhood figcaption, .pronto-neighbourhood > p { margin: 8px 0 2px; max-width: none; opacity: 1; color: var(--card-muted); font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pronto-neighbourhood figcaption a, .pronto-neighbourhood > p a { color: var(--card-accent); text-decoration: none; font-weight: 500; }
.mermaid:has(+ .pronto-pele) { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.pronto-pele { margin: 14px 0 22px; padding: 20px 22px; background-color: var(--card-sub); background-image: radial-gradient(var(--pele-dot) 0.85px, transparent 0.85px); background-size: 16px 16px; border: 1px solid var(--card-line); border-radius: 10px; box-shadow: 0 1px 3px rgba(25, 23, 20, 0.04); overflow-x: auto; }
.pronto-pele > svg.pele { display: block; margin: 0 auto; border: 0; border-radius: 0; --pele-bg: var(--card-panel); --pele-fg: var(--card-ink); --pele-muted: var(--card-muted); --pele-line: #8492a6; --pele-surface: var(--card-panel); --pele-surface-alt: var(--card-head); --pele-border: #b8c2d1; --pele-accent: var(--card-accent); --pele-radius: 8px; --pele-font: -apple-system, "Segoe UI", system-ui, sans-serif; --pele-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pronto-pele .pele-edge > path:not(.pele-marker) { stroke-width: 1.5px; }
.pronto-pele .pele-edge-label > rect { fill: var(--card-panel); stroke: var(--card-line); stroke-width: 1px; rx: 4px; }
.pronto-pele .pele-edge-label > text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; fill: var(--card-muted); }
.pronto-pele .pele-node { fill: var(--_fg); filter: drop-shadow(0 1px 2px rgba(25, 23, 20, 0.06)); }
.pronto-pele .pele-node > rect:not(.pele-band), .pronto-pele .pele-node > path, .pronto-pele .pele-node > polygon, .pronto-pele .pele-node > circle, .pronto-pele .pele-node > ellipse { stroke-width: 1.5px; }
.pronto-pele .pele-node > text.pele-label { font-size: 13px; font-weight: 600; fill: var(--_fg); }
.pronto-pele .pele-node[data-role="offline"] { --_s: #fef9ee; --_b: #b8860b; --_fg: #3b2806; }
.pronto-pele .pele-node[data-role="live"] { --_s: #f0fdf4; --_b: #1a8f5c; --_fg: #064e3b; }
.pronto-pele .pele-node[data-role="server"] { --_s: #eef2ff; --_b: #2443b8; --_fg: #1e1b4b; }
.pronto-pele .pele-node[data-role="device"] { --_s: #f0fdfa; --_b: #0e7c86; --_fg: #134e4a; }
.pronto-pele .pele-node[data-role="tab"] { --_s: #f8fafc; --_b: #64748b; --_fg: #1e293b; }
.pronto-pele .pele-node[data-role="screen"] { --_s: #ffffff; --_b: #8c8270; --_fg: #1c1917; }
.pronto-pele .pele-node[data-role="handler"] { --_s: #faf5ff; --_b: #7e22ce; --_fg: #3b0764; }
.pronto-pele .pele-node[data-role="machine"], .pronto-pele .pele-node[data-role="effect"] { --_s: #f5f7ff; --_b: #4338ca; --_fg: #1e1b4b; }
.pronto-pele .pele-node[data-role="machine"] > rect:not(.pele-band), .pronto-pele .pele-node[data-role="effect"] > rect:not(.pele-band) { stroke-dasharray: 5 3; }
@media (prefers-color-scheme: dark) {
  .pronto-pele .pele-node[data-role="offline"] { --_s: #2b2108; --_b: #d99b16; --_fg: #fef3c7; }
  .pronto-pele .pele-node[data-role="live"] { --_s: #09261b; --_b: #2bb578; --_fg: #d1fae5; }
  .pronto-pele .pele-node[data-role="server"] { --_s: #171d38; --_b: #6b85ff; --_fg: #e0e7ff; }
  .pronto-pele .pele-node[data-role="device"] { --_s: #0b292c; --_b: #22aab6; --_fg: #ccfbf1; }
  .pronto-pele .pele-node[data-role="tab"] { --_s: #1e2430; --_b: #8a99ad; --_fg: #e2e8f0; }
  .pronto-pele .pele-node[data-role="screen"] { --_s: #22201c; --_b: #a89d89; --_fg: #f5f1e8; }
  .pronto-pele .pele-node[data-role="handler"] { --_s: #27123c; --_b: #a855f7; --_fg: #f3e8ff; }
  .pronto-pele .pele-node[data-role="machine"], .pronto-pele .pele-node[data-role="effect"] { --_s: #191d36; --_b: #818cf8; --_fg: #e0e7ff; }
}
`;

const LINK = '<link rel="stylesheet" href="ir/card.css">';
const IR_IMPORT = /<link\b[^>]*?\brel="import"[^>]*?\bhref="(ir\/[^"]+)"[^>]*>|!\[\[(ir\/[^\]|]+)\]\]/g;
const unsafeIrPath = (p: string) => !p.startsWith("ir/") || p.split("/").some((s) => s === "" || s === "." || s === "..");

/** The ir/*.html fragment paths referenced by an ir.html document, in order. */
export function irFragments(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(IR_IMPORT)) {
    const p = (m[1] ?? m[2]).trim();
    if (unsafeIrPath(p)) throw new Error(`ir.html: unsafe fragment path ${p}`);
    seen.add(p);
  }
  return [...seen];
}

/** Reads ir.html and expands any referenced ir/*.html fragments in place. */
export async function composeIr(appDir: string, irPath: string): Promise<{ html: string; fragments: string[] } | null> {
  const root = await Deno.readTextFile(`${appDir}/${irPath}`).catch(missingIsNull);
  if (root === null) return null;
  const fragments = irFragments(root);
  if (fragments.length === 0) return { html: root, fragments: [] };
  const bodies = new Map<string, string>();
  for (const frag of fragments) {
    const text = await Deno.readTextFile(`${appDir}/${frag}`).catch(missingIsNull);
    if (text === null) throw new Error(`${irPath}: missing fragment ${frag}`);
    bodies.set(frag, text);
  }
  const html = root.replace(IR_IMPORT, (_full, linkHref?: string, wikiPath?: string) => {
    const p = (linkHref ?? wikiPath ?? "").trim();
    return bodies.get(p) ?? "";
  });
  return { html, fragments };
}

/** Draws every card ir.html (and its ir/*.html fragments) has an element for,
 * and writes ir/card.css. Answers whether any file changed. `facts` is
 * .pronto/facts.json, whose `chart` rows carry the terminal's charts as derive
 * read them off the screens. */
export async function renderIr(
  appDir: string,
  irPath: string,
  program: Program,
  facts: {
    chart?: { screen: string; table: string; field: string; machine: string }[];
    read_mode?: { entity: string; mode: string }[];
    reads?: { screen: string; entity: string }[];
  },
  d2: (source: string) => Promise<string> = (source) => d2Svg(appDir, source),
): Promise<boolean> {
  const entities = program.state.entities;
  const byTable = new Map(Object.entries(entities).map(([name, entity]) => [entity.table, { name, entity }]));
  const svgBySource = new Map<string, Promise<string>>();
  const draw = (source: string) => {
    const held = svgBySource.get(source);
    if (held !== undefined) return held;
    const rendered = d2(source);
    svgBySource.set(source, rendered);
    return rendered;
  };
  // D2's outer SVG has only a viewBox; give it intrinsic dimensions so the
  // browser preserves readable labels instead of stretching it to the page.
  const drawNeighbourhood = async (source: string) => (await draw(source)).replace(
    /<svg\b([^>]*?)\bviewBox="([^"]+)"([^>]*?)>/,
    (_tag, before: string, box: string, after: string) => {
      const [, , width, height] = box.split(/\s+/).map(Number);
      if (!(width > 0 && height > 0)) throw new Error(`D2 has invalid viewBox ${box}`);
      return `<svg${before}viewBox="${box}"${after} width="${width}" height="${height}">`;
    },
  );
  // A neighbourhood is a picture of reads with no design object in it, so it
  // lives beside ir.html and the document a reader or a model loads stays the
  // prose, the cards and the frames. The caption carries the card links.
  const placed = new Set<string>();
  const placeNeighbourhood = async (file: string, source: string, alt: string) => {
    const svg = await drawNeighbourhood(source);
    const box = /^<svg\b[^>]*?\bwidth="([^"]+)"[^>]*?\bheight="([^"]+)"/.exec(svg);
    const size = box === null ? "" : ` width="${box[1]}" height="${box[2]}"`;
    await Deno.mkdir(`${appDir}/ir`, { recursive: true });
    const path = `${appDir}/ir/${file}`;
    if ((await Deno.readTextFile(path).catch(missingIsNull)) !== svg) await Deno.writeTextFile(path, svg);
    placed.add(file);
    return `<img src="ir/${esc(file)}"${size} alt="${esc(alt)}">`;
  };
  const charts = new Map<string, TerminalChart[]>();
  const definitions = new Map<string, TerminalChart>();
  const suffixes = chartVariantSuffixes(facts.chart ?? []);
  const chartFields = new Map<string, Map<string, Set<string>>>();
  for (const [index, row] of (facts.chart ?? []).entries()) {
    const entity = byTable.get(row.table);
    if (entity === undefined) throw new Error(`chart fact names ${row.table}, the table of no declared entity`);
    if (program.surface.screens[row.screen] === undefined) throw new Error(`chart fact names undeclared screen ${row.screen}`);
    const parsed = JSON.parse(row.machine) as { field: string; initial: string; states: Record<string, unknown>; on?: Record<string, unknown> };
    if (parsed.field !== row.field) throw new Error(`chart fact ${row.screen}/${row.table} says field ${row.field} but its machine says ${parsed.field}`);
    const suffix = suffixes[index];
    const identity = JSON.stringify([row.table, row.field, suffix]);
    const prior = definitions.get(identity);
    if (prior !== undefined) {
      if (!prior.screens.includes(row.screen)) prior.screens.push(row.screen);
    } else {
      const chart = { ...parsed, writes: [row.table], screens: [row.screen], suffix };
      definitions.set(identity, chart);
      const list = charts.get(row.table) ?? [];
      list.push(chart);
      charts.set(row.table, list);
    }
    const byEntity = chartFields.get(row.screen) ?? new Map<string, Set<string>>();
    const fields = byEntity.get(entity.name) ?? new Set<string>();
    fields.add(row.field);
    byEntity.set(entity.name, fields);
    chartFields.set(row.screen, byEntity);
  }
  for (const row of facts.reads ?? []) {
    if (program.surface.screens[row.screen] === undefined) throw new Error(`read fact names undeclared screen ${row.screen}`);
    if (entities[row.entity] === undefined) throw new Error(`read fact names undeclared entity ${row.entity}`);
  }
  const readMode = new Map((facts.read_mode ?? []).map((r) => [r.entity, r.mode]));
  const ctx: Context = { program, charts, readMode, d2: draw };
  const rootHtml = await Deno.readTextFile(`${appDir}/${irPath}`);
  const sources = [irPath, ...irFragments(rootHtml)];
  const texts = await Promise.all(sources.map((p) => p === irPath ? Promise.resolve(rootHtml) : Deno.readTextFile(`${appDir}/${p}`)));
  const html = texts.join("\n");
  const byIr = new Map(Object.entries(entities).map(([name, e]) => [e.ir, { name, e }]));
  if (byIr.size !== Object.keys(entities).length) throw new Error("two declared entities have the same ir id");
  const cardIrs = new Set<string>();
  for (const tag of html.matchAll(ENTITY_TAG)) {
    const id = ID.exec(tag[0])?.[1];
    if (id !== undefined && byIr.has(id)) cardIrs.add(id);
  }
  const cards = new Map<string, string>();
  for (const tag of html.matchAll(ENTITY_TAG)) {
    const id = ID.exec(tag[0])?.[1];
    const hit = id === undefined ? undefined : byIr.get(id);
    if (hit === undefined || cards.has(id!)) continue;
    const rest = html.slice(tag.index! + tag[0].length);
    const next = rest.search(ENTITY_START);
    cards.set(id!, await cardHtml(hit.name, hit.e, ctx, authoredNotes(next === -1 ? rest : rest.slice(0, next))));
  }
  const filled = texts.map((t) => fillRegions(t, cards));
  const screenTags = new Set<string>();
  for (const part of filled) {
    for (const tag of part.matchAll(SCREEN_TAG)) {
      const id = ID.exec(tag[0])?.[1];
      if (id !== undefined) screenTags.add(id);
    }
  }
  const mechaFields = new Map<string, Set<string>>();
  for (const machine of Object.values(program.state.machines ?? {})) {
    const entity = machineEntity(entities, machine);
    if (machine.field === undefined || machine.states === undefined) continue;
    const fields = mechaFields.get(entity) ?? new Set<string>();
    fields.add(machine.field);
    mechaFields.set(entity, fields);
  }
  const graphs = new Map<string, Neighbourhood>();
  const screenHtml = new Map<string, string>();
  for (const [screenName, screen] of Object.entries(program.surface.screens).sort(([a], [b]) => a.localeCompare(b))) {
    if (!screenTags.has(screen.ir)) continue;
    if (graphs.has(screen.ir)) throw new Error(`screens share ir id ${screen.ir}`);
    const fields = new Map([...mechaFields].map(([entity, names]) => [entity, new Set(names)]));
    for (const [entity, names] of chartFields.get(screenName) ?? []) {
      const set = fields.get(entity) ?? new Set<string>();
      for (const name of names) set.add(name);
      fields.set(entity, set);
    }
    const graph = screenNeighbourhood(program, screenName, screen, fields);
    graphs.set(screen.ir, graph);
    const hatches = (screen.hatches ?? []).map(name => {
      const hatch = program.capabilities.hatches?.[name];
      if (hatch?.kind !== "host-dom") throw new Error(`screen ${screenName} names undeclared host-DOM hatch ${name}`);
      return `<p class="why">Host-DOM hatch <a href="#${esc(hatch.ir)}">${esc(name)}</a> · ${chip("delivery", "unspecified", true)} · <span class="note">${esc(hatch.note)}</span></p>`;
    }).join("\n");
    if (graph.entities.length === 0 && !hatches) continue;
    const img = graph.entities.length
      ? await placeNeighbourhood(`neighbourhood-${screen.ir}.svg`, neighbourhoodD2(program, graph, cardIrs), `${screen.title} entity diagram`)
      : "";
    const entities = img ? `<figure class="pronto-neighbourhood" aria-label="${esc(screen.title)} entity neighbourhood"><div class="neighbourhood-canvas" role="region" tabindex="0" aria-label="${esc(screen.title)} entity diagram">${img}</div><figcaption><b>entities:</b> ${entitySummary(program, graph, cardIrs)}</figcaption></figure>` : "";
    screenHtml.set(screen.ir, entities + hatches);
  }
  const appGraph = mergeNeighbourhoods(graphs.values());
  let appHtml: string | null = null;
  if (appGraph.entities.length > 0) {
    const img = await placeNeighbourhood("neighbourhood-app.svg", neighbourhoodD2(program, appGraph, cardIrs), "App entity diagram");
    appHtml = `<details class="pronto-neighbourhood app-neighbourhood"><summary>App entity neighbourhood · ${appGraph.entities.length} entities</summary><div class="neighbourhood-canvas" role="region" tabindex="0" aria-label="App entity diagram">${img}</div><p><b>entities:</b> ${entitySummary(program, appGraph, cardIrs)}</p></details>`;
  }
  let appPlaced = false;
  let hasMermaid = false;
  const nextParts: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const hasScreen = SCREEN_TAG.test(filled[i]);
    SCREEN_TAG.lastIndex = 0;
    const withNeighbourhoods = fillNeighbourhoodRegions(filled[i], screenHtml, !appPlaced && hasScreen ? appHtml : null);
    if (hasScreen) appPlaced = true;
    const next = fillMermaidRegions(withNeighbourhoods, program);
    if (next.includes(MERMAID_OPEN)) hasMermaid = true;
    nextParts.push(next);
  }
  let changed = false;
  for (let i = 0; i < sources.length; i++) {
    let next = nextParts[i];
    if (i === 0 && (cards.size > 0 || screenHtml.size > 0 || appGraph.entities.length > 0 || hasMermaid) && !next.includes(LINK)) {
      next = next.replace(/<\/head>/, `${LINK}\n</head>`);
    }
    if (next !== texts[i]) {
      await Deno.writeTextFile(`${appDir}/${sources[i]}`, next);
      changed = true;
    }
  }
  await writeIrStylesheet(appDir);
  for await (const entry of Deno.readDir(`${appDir}/ir`)) {
    if (/^neighbourhood-.*\.svg$/.test(entry.name) && !placed.has(entry.name)) await Deno.remove(`${appDir}/ir/${entry.name}`);
  }
  return changed;
}

function missingIsNull(error: unknown): null {
  if (error instanceof Deno.errors.NotFound) return null;
  throw error;
}

export async function writeIrStylesheet(appDir: string): Promise<void> {
  await Deno.mkdir(`${appDir}/ir`, { recursive: true });
  const cssPath = `${appDir}/ir/card.css`;
  const css = await Deno.readTextFile(cssPath).catch(missingIsNull);
  if (css !== CARD_CSS) await Deno.writeTextFile(cssPath, CARD_CSS);
}
