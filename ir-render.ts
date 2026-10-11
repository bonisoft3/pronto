// The compiler draws, the author writes prose (decisions/2026-10-10-hatches.md,
// "What ir.html shows"). Every `data-kind="entity"` element in ir.html that names
// a declared entity gets a generated region right after its opening tag — the
// entity's card — and the region is the only part of ir.html pronto writes:
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
// answered without the author drawing them. write.ts runs this after derive
// and before the derive that records the regions (facts `ir_region`).


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
  validations?: Record<string, { note: string }>;
  indexes?: { on: string }[];
  uniques?: unknown[];
  /** Derived at #App (writers.cue): every declaration that writes rows here. */
  writers: { by: string; kind: string; ops: string[] }[];
};
export type MechaMachine = {
  ir: string;
  entity: string;
  field: string;
  initial: string;
  level: string;
  states: Record<string, { type?: string; on?: Record<string, unknown>; after?: Record<string, unknown>; invoke?: { src: string; onDone: unknown; onError: unknown } }>;
};
// `reentry` is declared exactly when the sink is not idempotent (#ExternalEffect).
export type Effect = { ir: string; sink: { origin?: string; bridge?: string; idempotent: boolean }; reentry?: "reconcile" | "unknown" | "repeat"; note: string };
export type Program = {
  state: {
    entities: Record<string, Entity>;
    machines?: Record<string, MechaMachine>;
    effects?: Record<string, Effect>;
  };
  capabilities: { auth?: unknown };
};

/** What a chip explains of itself on hover; one sentence each. */
const TIP: Record<string, string> = {
  durability: "where the row lives, the one word the author chooses: tab · device · offline · live · server",
  access: "who may read and write the row; becomes the roles and the row-level policies",
  id: "the entity's type id, which a schema diff keys on across renames; each field keeps a gap-free ordinal, and a retired field stays as a tombstone",
  retired: "retired: the ordinal is kept so no later field takes it; nothing writes the column",
  level: "",
  delivery: "what a write here can claim when delivered twice — the level's word, and at level 4 the sink's: idempotent or reconciled is exactly-once, unknown at-most-once, repeat at-least-once",
  writers: "who writes rows here, each as kind:name and its ops — a screen's forms and what its markup writes past them, the terminal's charts, pipelines, computations, machines",
  read: "how the terminal reads it: eager syncs the whole table, lazy loads what a view asks",
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
const tip = (text: string) => ` data-tip="${esc(text)}" tabindex="0"`;
const chip = (name: string, value: string, derived: boolean, explain = TIP[name]) =>
  `<span class="chip${derived ? " derived" : ""}"${tip(explain)}><b>${name}</b> ${esc(value)}</span>`;

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
 * per platform — the way check-facts runs duckdb; no browser. */
export async function d2Svg(appDir: string, source: string): Promise<string> {
  const mise = Deno.build.os === "windows" ? `${Deno.env.get("LOCALAPPDATA")}\\mise\\bin\\mise.exe` : "mise";
  const child = new Deno.Command(mise, {
    args: ["x", "--", "d2", "--layout", "elk", "--theme", "0", "--pad", "16", "-", "-"],
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
  charts: Map<string, { field: string; initial: string; states: Record<string, unknown>; on?: Record<string, unknown>; writes: string[] }[]>;
  /** How the terminal reads each server entity (facts `read_mode`). */
  readMode: Map<string, string>;
  d2: (source: string) => Promise<string>;
};

function reachOf(d: Iterable<string>): string {
  let far = 0;
  for (const x of d) far = Math.max(far, REACH.indexOf(x));
  return REACH[far];
}

/** One entity's card. */
export async function cardHtml(name: string, e: Entity, ctx: Context): Promise<string> {
  const { entities } = ctx.program.state;
  const byTable = new Map(Object.entries(entities).map(([n, x]) => [x.table, { name: n, ...x }]));
  const fields = e.fields.filter((f) => !STAMPS.has(f.name) && !f.retired);
  const retired = e.fields.filter((f) => f.retired);
  const idx = new Set((e.indexes ?? []).map((i) => i.on));
  const machines = [
    ...(ctx.charts.get(e.table) ?? []).map((c) => ({ id: `${e.ir}-${c.field}`, title: `${e.ir} · ${c.field}`, level: e.level, chart: c, invoke: null as null | string })),
    ...Object.values(ctx.program.state.machines ?? {}).filter((m) => m.entity === name).map((m) => ({
      id: m.ir,
      title: `${m.ir} · ${m.field}`,
      level: m.level,
      chart: m,
      invoke: Object.values(m.states).find((s) => s.invoke)?.invoke?.src ?? null,
    })),
  ];
  const machineField = new Set(machines.map((m) => m.chart.field));
  const refs = fields.filter((f) => f.ref).map((f) => ({ col: f.name, ref: f.ref! }));
  const referrers: { table: string; col: string }[] = [];
  for (const other of Object.values(entities)) for (const f of other.fields) if (f.ref === e.table) referrers.push({ table: other.table, col: f.name });
  const access = e.access ?? {};
  const accessValue = Object.entries(access).map(([k, v]) => k === "scope" ? String(v) : `${k} ${v}`).join(" · ") || "—";
  const anyAccess = Object.values(entities).some((x) => x.access !== undefined);
  const authOn = ctx.program.capabilities.auth !== undefined || anyAccess;
  const writers = e.writers.map((w) => `${w.kind}:${w.by} ${w.ops.join("·")}`);
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
    const effect = m.invoke === null ? null : ctx.program.state.effects?.[m.invoke] ?? (() => {
      throw new Error(`machine ${m.id} invokes ${m.invoke}, which is no declared effect`);
    })();
    return { ...m, effect, delivery: deliveryOf(m.level, effect) };
  });
  // The pivot's word is the entity's; the classes are not totally ordered, so
  // external machines that differ each show theirs.
  const external = [...new Set(panels.filter((m) => m.level === "external").map((m) => m.delivery))];
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
    const effect = m.effect;
    const svg = await ctx.d2(chartD2(m.chart as { initial: string; states: Record<string, any> }));
    return `<section class="machine" data-kind="machine" id="${esc(m.id)}" data-of="${esc(e.ir)}">
<span class="lbl derived">machine</span>
<span class="mtitle">${esc(m.title)} ${chip("level", m.level, true, LEVEL_TIP[m.level])}${chip("delivery", m.delivery, true)}</span>
<div class="canvas">${svg}</div>${
      effect === null ? "" : `
<p class="why" data-kind="effect" id="${esc(effect.ir)}" data-of="${esc(m.id)}">${chip("effect", m.invoke!, true, "an act outside the cluster, performed by the airlock; the ledger claims it before the call")} → ${esc(effect.sink.origin ?? `bridge ${effect.sink.bridge}`)} · ${peer(effect)} · <span class="note">${esc(effect.note)}</span></p>`
    }
</section>`;
  }));
  const owed = reachOf([e.durability, ...machines.flatMap((m) => (m.chart as { writes?: string[] }).writes ?? []).map((t) => byTable.get(t)?.durability ?? "tab")]) !== "tab";
  return `<div class="card dur-${esc(e.durability)}">
<header class="ehead">
<span class="chips">${chip("durability", e.durability, false)}${chip("access", accessValue, false)}${e.id === undefined ? "" : chip("id", e.id, false)}${chip("level", e.level, true, LEVEL_TIP[e.level])}${chip("delivery", delivery, true)}</span>
<span class="counts">${fields.length} fields · ${referrers.length} referrers${machines.length > 0 ? ` · ${machines.length} machine${machines.length > 1 ? "s" : ""}` : ""}</span>
</header>
<div class="names"><span class="lbl">fields</span><span class="namelist">${fields.map(nameToken).join("")}</span>
<details class="more"><summary>all fields, with their metadata</summary>
<table class="fields">${[...fields, ...retired].map((f) => `<tr${f.retired ? ' class="retired"' : ""}><td class="o">${f.ordinal ?? ""}</td><td class="k">${esc(f.name)}</td><td class="t">${esc(f.type)}</td><td class="gl">${glyphs(f)}</td><td class="x" title="${esc(rule(f))}">${esc(rule(f))}</td></tr>`).join("")}</table>
<p class="legend">${e.id === undefined ? "" : "the first column is the field's ordinal, which a diff keys on · "}<span class="g pk">pk</span> primary key · <span class="g fk">→</span> references · <span class="g">◇</span> unique · <span class="g">≡</span> indexed · <span class="g">○</span> nullable${retired.length > 0 ? ' · <span class="g">†</span> retired' : ""} · a rule or default in the last column</p>
</details></div>
<div class="strips">
<div class="strip"><span class="lbl">referenced by</span><span class="rels">${pills(referrers, 3, (r) => `<a class="rel in" href="#${esc(byTable.get(r.table)?.ir ?? r.table)}">${esc(r.table)}<span class="col">.${esc(r.col)}</span></a>`) || '<span class="why">—</span>'}</span></div>
<div class="strip"><span class="lbl">refers to</span><span class="rels">${pills(refs, 4, (r) => `<a class="rel out" href="#${esc(byTable.get(r.ref)?.ir ?? r.ref)}">${esc(r.ref)}<span class="col"> via ${esc(r.col)}</span></a>`) || '<span class="why">—</span>'}</span></div>
<div class="strip"><span class="lbl">validations</span>${validations.length === 0 ? '<span class="why">none</span>' : `<ul class="vals">${validations.map(([n, v]) => `<li><code>${esc(n)}</code> <span class="note">${esc(v.note)}</span></li>`).join("")}</ul>`}</div>
</div>
<div class="dline"><span class="lbl derived">derived</span><span class="chips">${chip("writers", writers.join(", ") || "—", true)}${chip("read", e.durability === "server" ? "—" : (ctx.readMode.get(name) ?? "lazy"), true)}${chip("roles", authOn ? "anon · app_user · service" : "anon", true)}${chip("ir", owed ? "required" : "optional", true)}</span>
<details class="more"><summary>the platform’s columns</summary><p class="why"><code>created_by</code>, <code>updated_by</code> → app_user, stamped by the platform on every write; not the author’s.</p></details></div>
${machinePanels.join("\n")}
</div>`;
}

const OPEN = "<!-- pronto:card -->";
const CLOSE = "<!-- /pronto:card -->";
const ENTITY_TAG = /<([a-z][a-z0-9]*)\s[^>]*data-kind="entity"[^>]*>/g;
const ID = /\sid="([^"]*)"/;

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

/** The card's stylesheet, as the ir's head links it (`ir/card.css`). Tokens
 * only, light and dark; the ir's own styles own everything else. */
export const CARD_CSS = `/* generated by pronto from program.cue — do not edit */
.card { --card-ink: #1b1f2a; --card-muted: #5f6782; --card-line: #d6dae4; --card-panel: #fff; --card-accent: #2443b8; --card-tip: #fff6bf; --card-tip-edge: #e3cf5a; --band: var(--card-accent);
  position: relative; background: var(--card-panel); border: 1px solid var(--card-line); color: var(--card-ink); font-size: 14px; line-height: 1.5; margin: 12px 0 20px; }
@media (prefers-color-scheme: dark) { .card { --card-ink: #e8eaf0; --card-muted: #9aa3bd; --card-line: #2a3040; --card-panel: #1b1f2a; --card-accent: #8ea2ff; --card-tip: #3a3410; --card-tip-edge: #8a7a2a; } }
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: var(--band); }
.card.dur-server { --band: #2443b8; } .card.dur-live { --band: #1a8f5c; } .card.dur-offline { --band: #b8860b; } .card.dur-device { --band: #0e7c86; } .card.dur-tab { --band: #8a8f9c; }
.card .ehead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 14px; padding: 12px 18px 8px 24px; }
.card .chips { display: flex; gap: 8px; flex-wrap: wrap; }
.card .chip { font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 2px 10px; border: 1px solid var(--card-ink); border-radius: 999px; white-space: nowrap; }
.card .chip b { font-weight: 500; color: var(--card-muted); margin-right: 5px; font-family: inherit; }
.card .chip b::after { content: ":"; }
.card .chip.derived { border-style: dashed; border-color: var(--card-accent); color: var(--card-accent); }
.card .chip.derived b { color: var(--card-accent); opacity: 0.8; }
.card .counts { margin-left: auto; color: var(--card-muted); font-size: 13px; }
.card [data-tip] { position: relative; cursor: help; }
.card [data-tip]:hover::after, .card [data-tip]:focus-visible::after { content: attr(data-tip); position: absolute; left: 0; top: calc(100% + 6px); z-index: 5; background: var(--card-tip); color: var(--card-ink); border: 1px solid var(--card-tip-edge); padding: 8px 10px; font-size: 13px; line-height: 1.4; width: max-content; max-width: 34ch; white-space: normal; font-family: system-ui, sans-serif; font-weight: 400; text-transform: none; letter-spacing: 0; }
.card .lbl { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--card-muted); font-weight: 600; margin-right: 6px; }
.card .lbl.derived { color: var(--card-accent); }
.card .names { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; align-items: baseline; padding: 4px 18px 10px 24px; }
.card .namelist { font-family: ui-monospace, Menlo, monospace; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
.card .fname { margin-right: 10px; }
.card .m { font-style: normal; font-size: 10px; color: var(--card-muted); margin-left: 2px; vertical-align: super; }
.card .m.mach { color: var(--card-accent); }
.card .names .more { grid-column: 2; }
.card .more > summary { list-style: none; cursor: pointer; color: var(--card-accent); font-size: 13px; font-family: ui-monospace, Menlo, monospace; }
.card .more > summary::-webkit-details-marker { display: none; }
.card .more > summary::before { content: "▸ "; } .card .more[open] > summary::before { content: "▾ "; }
.card .more.inline { display: inline; } .card .more.inline[open] > summary { display: inline; margin-right: 6px; }
.card .more.inline .rels { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.card .fields { border-collapse: collapse; font-size: 13px; width: 100%; margin-top: 8px; }
.card .fields td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--card-line); vertical-align: baseline; }
.card .fields .k { font-family: ui-monospace, Menlo, monospace; } .card .fields .t { color: var(--card-muted); font-family: ui-monospace, Menlo, monospace; }
.card .fields .o { color: var(--card-muted); font-family: ui-monospace, Menlo, monospace; font-size: 11px; width: 2.5ch; text-align: right; }
.card .fields tr.retired td { color: var(--card-muted); text-decoration: line-through; } .card .fields tr.retired td.gl { text-decoration: none; }
.card .fields .gl { white-space: nowrap; } .card .fields .x { color: var(--card-muted); font-family: ui-monospace, Menlo, monospace; font-size: 12px; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .g { font-family: ui-monospace, Menlo, monospace; font-size: 11px; margin-right: 6px; color: var(--card-muted); }
.card .g.pk { font-weight: 600; color: var(--card-ink); } .card .g.fk { color: var(--card-accent); text-decoration: none; }
.card .g.mach { color: var(--card-accent); border: 1px dashed var(--card-accent); padding: 0 4px; }
.card .legend { color: var(--card-muted); font-size: 12px; margin: 8px 0 0; }
.card .strips { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px 24px; padding: 10px 18px 10px 24px; border-top: 1px solid var(--card-line); align-items: baseline; }
.card .strip { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; }
.card .rels { display: flex; flex-wrap: wrap; gap: 6px; }
.card .rel { font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 2px 8px; border: 1px solid var(--card-line); color: var(--card-ink); text-decoration: none; }
.card .rel .col { color: var(--card-muted); } .card .rel.in { border-left: 3px solid var(--band); } .card .rel.out { border-right: 3px solid var(--band); }
.card .vals { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; } .card .note { color: var(--card-muted); font-style: italic; }
.card .why { color: var(--card-muted); font-size: 13px; margin: 0; }
.card .dline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; padding: 10px 18px 12px 24px; border-top: 1px dashed var(--card-accent); }
.card .machine { display: grid; gap: 8px; padding: 10px 18px 14px 24px; border-top: 1px dashed var(--card-accent); }
.card .mtitle { font-size: 15px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.card .canvas { overflow-x: auto; } .card .canvas svg { display: block; width: auto; height: auto; max-width: 640px; max-height: 260px; }
`;

const LINK = '<link rel="stylesheet" href="ir/card.css">';

/** Draws every card ir.html has an element for, and writes ir/card.css. Answers
 * whether ir.html changed. `facts` is .pronto/facts.json, whose `chart` rows
 * carry the terminal's charts as derive read them off the screens. */
export async function renderIr(
  appDir: string,
  irPath: string,
  program: Program,
  facts: { chart?: { table: string; field: string; machine: string }[]; read_mode?: { entity: string; mode: string }[] },
  d2: (source: string) => Promise<string> = (source) => d2Svg(appDir, source),
): Promise<boolean> {
  const charts = new Map<string, { field: string; initial: string; states: Record<string, unknown>; on?: Record<string, unknown>; writes: string[] }[]>();
  for (const row of facts.chart ?? []) {
    const parsed = JSON.parse(row.machine) as { field: string; initial: string; states: Record<string, unknown>; on?: Record<string, unknown> };
    const list = charts.get(row.table) ?? [];
    if (list.some((c) => c.field === parsed.field)) continue;
    list.push({ ...parsed, writes: [row.table] });
    charts.set(row.table, list);
  }
  const readMode = new Map((facts.read_mode ?? []).map((r) => [r.entity, r.mode]));
  const ctx: Context = { program, charts, readMode, d2 };
  const html = await Deno.readTextFile(`${appDir}/${irPath}`);
  const byIr = new Map(Object.entries(program.state.entities).map(([name, e]) => [e.ir, { name, e }]));
  const cards = new Map<string, string>();
  for (const tag of html.matchAll(ENTITY_TAG)) {
    const id = ID.exec(tag[0])?.[1];
    const hit = id === undefined ? undefined : byIr.get(id);
    if (hit === undefined || cards.has(id!)) continue;
    cards.set(id!, await cardHtml(hit.name, hit.e, ctx));
  }
  let next = fillRegions(html, cards);
  if (cards.size > 0 && !next.includes(LINK)) next = next.replace(/<\/head>/, `${LINK}\n</head>`);
  await Deno.mkdir(`${appDir}/ir`, { recursive: true });
  const cssPath = `${appDir}/ir/card.css`;
  const css = await Deno.readTextFile(cssPath).catch(() => null);
  if (css !== CARD_CSS) await Deno.writeTextFile(cssPath, CARD_CSS);
  if (next === html) return false;
  await Deno.writeTextFile(`${appDir}/${irPath}`, next);
  return true;
}
