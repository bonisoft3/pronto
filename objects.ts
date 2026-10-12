// The bijection surface: which ids each rung defines, and under what kind.
//
// Compared kinds are the ones whose CUE objects carry `ir`. Not compared:
// `paths` and `diagram` are narration checked through their screen, `auth` has
// no program object with an id, `review` is the virtual team's work product,
// which no CUE object realizes.
//
// The ir is scanned with a regex rather than a DOM parser: this runs inside the
// derivation, with --allow-read and --allow-run=cue and no network. Ids are
// opaque tokens — a frame id is BUILT as `${screen.ir}-${state}` and carried
// whole, never split back apart.

import { isDeepStrictEqual } from "node:util";

export const KINDS = [
  "entity",
  "pipeline",
  "screen",
  "state",
  "flow",
  "test",
  "decision",
  "handler",
  "validation",
  "hatch",
  "unit",
  "machine",
  "effect",
] as const;
type Kind = typeof KINDS[number];

/**
 * Program collection backing each kind whose ids are read straight off `ir`;
 * bucket/field locate it under #App's state/capabilities/surface/meta split.
 */
const COLLECTIONS: Record<string, { bucket: string; field: string; kind: Kind; optional?: boolean }> = {
  entities: { bucket: "state", field: "entities", kind: "entity" },
  pipelines: { bucket: "state", field: "pipelines", kind: "pipeline" },
  duckstreams: { bucket: "state", field: "duckstreams", kind: "pipeline", optional: true },
  drains: { bucket: "state", field: "drains", kind: "pipeline", optional: true },
  screens: { bucket: "surface", field: "screens", kind: "screen" },
  flows: { bucket: "surface", field: "flows", kind: "flow" },
  tests: { bucket: "meta", field: "tests", kind: "test" },
  decisions: { bucket: "meta", field: "decisions", kind: "decision" },
  handlers: { bucket: "surface", field: "handlers", kind: "handler" },
  hatches: { bucket: "capabilities", field: "hatches", kind: "hatch" },
  units: { bucket: "capabilities", field: "vendored", kind: "unit" },
  machines: { bucket: "state", field: "machines", kind: "machine", optional: true },
  effects: { bucket: "state", field: "effects", kind: "effect", optional: true },
};

/** Durabilities by reach, least first: what a write at each reaches beyond the
 * tab that made it (decisions/2026-08-27-review-by-consequence.md). */
export const REACH = ["tab", "device", "offline", "live", "server"] as const;

/** The farthest durability among `durabilities`; `tab` when there is none. */
export function reachOf(durabilities: Iterable<string>): string {
  let far = 0;
  for (const d of durabilities) far = Math.max(far, REACH.indexOf(d as typeof REACH[number]));
  return REACH[far];
}

/** Whether an ir element is owed for something whose writes reach `durability`:
 * a `tab` row is machine-checked only; `device` or above reaches another tab
 * or a later session, and a reader must be able to find it. */
export const owedAt = (durability: string): boolean => durability !== "tab";

const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const TAG = /<[a-z][a-z0-9]*\s[^>]*>/gi;
const ID = /\sid="([^"]*)"/;
const DATA_KIND = /\sdata-kind="([^"]*)"/;
const DATA_ROUTE = /\sdata-route="([^"]*)"/;

/**
 * Ids per data-kind, duplicates preserved. Only tag-shaped occurrences count:
 * a real ir carries `data-kind="…"` inside CSS attribute selectors and in
 * review prose, and neither defines an id.
 */
export function irIds(html: string): Map<string, string[]> {
  const byKind = new Map<string, string[]>();
  for (const tag of html.replace(STYLE, "").matchAll(TAG)) {
    const id = ID.exec(tag[0]);
    const kind = DATA_KIND.exec(tag[0]);
    if (!id || !kind) continue;
    const ids = byKind.get(kind[1]) ?? [];
    ids.push(id[1]);
    byKind.set(kind[1], ids);
  }
  return byKind;
}

/**
 * Route of each `data-kind="screen"` element, by id; `null` where the element
 * declares none. Same tag scan as `irIds`, so the same CSS/prose exclusions.
 */
export function irRoutes(html: string): Map<string, string | null> {
  const routes = new Map<string, string | null>();
  for (const tag of html.replace(STYLE, "").matchAll(TAG)) {
    const id = ID.exec(tag[0]);
    const kind = DATA_KIND.exec(tag[0]);
    if (!id || kind?.[1] !== "screen") continue;
    const route = DATA_ROUTE.exec(tag[0]);
    routes.set(id[1], route ? route[1] : null);
  }
  return routes;
}

/** `owed`: whether ir.html must carry the element. Every program declaration
 * is a claim; what reaches no further than a tab is machine-checked only. */
export type Declaration = { kind: Kind; id: string; where: string; owed: boolean };

export function declarations(code: Record<string, any>): Declaration[] {
  const out: Declaration[] = [];
  for (const [collection, { bucket, field, kind, optional }] of Object.entries(COLLECTIONS)) {
    const objects = code[bucket]?.[field];
    if (objects === undefined || objects === null || typeof objects !== "object") {
      if (optional) continue;
      throw new Error(
        `program export has no \`${bucket}.${field}\` map: it does not unify with #App`,
      );
    }
    for (const [key, value] of Object.entries(objects as Record<string, any>)) {
      const owed = kind === "entity" ? owedAt(value.durability) : kind === "machine" ? value.level !== "ephemeral" : true;
      const claimedKind = collection === "pipelines" && value.raw === true ? "hatch" : kind;
      out.push({ kind: claimedKind, id: (value as { ir: string }).ir, where: `${collection}.${key}`, owed });
    }
  }
  for (const [key, screen] of Object.entries(code.surface.screens as Record<string, any>)) {
    for (const state of screen.states as string[]) {
      out.push({ kind: "state", id: `${screen.ir}-${state}`, where: `screens.${key}.states.${state}`, owed: true });
    }
  }
  for (const [key, entity] of Object.entries(code.state.entities as Record<string, any>)) {
    for (const [name, v] of Object.entries((entity.validations ?? {}) as Record<string, { ir: string }>)) {
      out.push({ kind: "validation", id: v.ir, where: `entities.${key}.validations.${name}`, owed: owedAt(entity.durability) });
    }
  }
  return out;
}

/** A chart the markup carries, as derive reads it off a screen: the row it
 * runs over, the field it moves, the tables its arrows write, the handler
 * modules it names. */
export type ChartSite = { screen: string; table: string; field: string; machine: string; writes: string[]; refs: string[] };

/** Distinct definitions of one field receive the same suffix in the IR and
 * its claims; identical charts on several screens keep one identity. */
export function chartVariantSuffixes(charts: { table: string; field: string; machine: string }[]): string[] {
  const groups = new Map<string, { machine: unknown; sites: number[] }[]>();
  for (const [index, chart] of charts.entries()) {
    const key = JSON.stringify([chart.table, chart.field]);
    const variants = groups.get(key) ?? [];
    const machine = JSON.parse(chart.machine);
    const prior = variants.find((v) => isDeepStrictEqual(v.machine, machine));
    if (prior) prior.sites.push(index);
    else variants.push({ machine, sites: [index] });
    groups.set(key, variants);
  }
  const suffixes = charts.map(() => "");
  for (const variants of groups.values()) {
    if (variants.length < 2) continue;
    for (const [ordinal, variant] of variants.entries()) {
      for (const site of variant.sites) suffixes[site] = `-${ordinal + 1}`;
    }
  }
  return suffixes;
}

/** The machine claims of terminal charts, owed by the farthest durability
 * their row and writes reach. */
export function chartDeclarations(
  charts: ChartSite[],
  entities: Record<string, { table: string; ir: string; durability: string }>,
): Declaration[] {
  const byTable = new Map(Object.values(entities).map((e) => [e.table, e]));
  const out = new Map<string, Declaration>();
  const suffixes = chartVariantSuffixes(charts);
  for (const [index, c] of charts.entries()) {
    const entity = byTable.get(c.table);
    if (entity === undefined) throw new Error(`${c.screen}: a chart runs over "${c.table}", the table of no declared entity`);
    const reach = reachOf([entity.durability, ...c.writes.map((t) => byTable.get(t)?.durability ?? "tab")]);
    const id = `${entity.ir}-${c.field}${suffixes[index]}`;
    const prior = out.get(id);
    out.set(id, {
      kind: "machine",
      id,
      where: prior === undefined ? `screens.${c.screen}.${c.table}.${c.field}` : prior.where,
      owed: (prior?.owed ?? false) || owedAt(reach),
    });
  }
  return [...out.values()];
}

/** The handler declarations with `owed` read off the charts that name them: a
 * handler only a tab-reaching chart calls is machine-checked with it; one no
 * chart names (a form's, an adapter's) keeps its element. `stemOf` maps a
 * chart's module name to the handler's ir id. */
export function handlersOwed(
  decls: Declaration[],
  charts: Omit<ChartSite, "machine">[],
  entities: Record<string, { table: string; ir: string; durability: string }>,
  stemToIr: Map<string, string>,
): Declaration[] {
  const byTable = new Map(Object.values(entities).map((e) => [e.table, e]));
  const named = new Set<string>();
  const namedByOwed = new Set<string>();
  for (const c of charts) {
    const reach = reachOf([byTable.get(c.table)?.durability ?? "tab", ...c.writes.map((t) => byTable.get(t)?.durability ?? "tab")]);
    for (const r of c.refs) {
      const ir = stemToIr.get(r);
      if (ir === undefined) continue;
      named.add(ir);
      if (owedAt(reach)) namedByOwed.add(ir);
    }
  }
  return decls.map((d) => d.kind === "handler" ? { ...d, owed: !named.has(d.id) || namedByOwed.has(d.id) } : d);
}
