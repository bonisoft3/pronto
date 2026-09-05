// The bijection surface: which ids each rung defines, and under what kind.
//
// Compared kinds are the ones whose CUE objects carry `ir`. Not compared:
// `paths` and `diagram` are narration checked through their screen, `auth` has
// no program object with an id, `review` is the virtual team's work product
// linted against the team file.
//
// The ir is scanned with a regex rather than a DOM parser: this runs inside the
// derivation, with --allow-read and --allow-run=cue and no network. Ids are
// opaque tokens — a frame id is BUILT as `${screen.ir}-${state}` and carried
// whole, never split back apart.

export const KINDS = [
  "entity",
  "pipeline",
  "screen",
  "state",
  "flow",
  "test",
  "decision",
  "handler",
  "hatch",
  "unit",
] as const;
type Kind = typeof KINDS[number];

/**
 * Program collection backing each kind whose ids are read straight off `ir`;
 * bucket/field locate it under #App's state/capabilities/surface/meta split.
 */
const COLLECTIONS: Record<string, { bucket: string; field: string; kind: Kind }> = {
  entities: { bucket: "state", field: "entities", kind: "entity" },
  pipelines: { bucket: "state", field: "pipelines", kind: "pipeline" },
  screens: { bucket: "surface", field: "screens", kind: "screen" },
  flows: { bucket: "surface", field: "flows", kind: "flow" },
  tests: { bucket: "meta", field: "tests", kind: "test" },
  decisions: { bucket: "meta", field: "decisions", kind: "decision" },
  handlers: { bucket: "surface", field: "handlers", kind: "handler" },
  hatches: { bucket: "capabilities", field: "hatches", kind: "hatch" },
  units: { bucket: "capabilities", field: "vendored", kind: "unit" },
};

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

type Declaration = { kind: Kind; id: string; where: string };

export function declarations(code: Record<string, any>): Declaration[] {
  const out: Declaration[] = [];
  for (const [collection, { bucket, field, kind }] of Object.entries(COLLECTIONS)) {
    const objects = code[bucket]?.[field];
    if (objects === undefined || objects === null || typeof objects !== "object") {
      throw new Error(
        `program export has no \`${bucket}.${field}\` map: it does not unify with #App`,
      );
    }
    for (const [key, value] of Object.entries(objects as Record<string, any>)) {
      out.push({ kind, id: (value as { ir: string }).ir, where: `${collection}.${key}` });
    }
  }
  for (const [key, screen] of Object.entries(code.surface.screens as Record<string, any>)) {
    for (const state of screen.states as string[]) {
      out.push({ kind: "state", id: `${screen.ir}-${state}`, where: `screens.${key}.states.${state}` });
    }
  }
  return out;
}
