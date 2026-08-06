// pronto bijection lint: hop 2 invented nothing and dropped nothing.
//
//   deno run --allow-read=. --allow-run=cue ../../plugins/pronto/check-bijection.ts <appDir>
//   deno run check-bijection.ts --self-test
//
// Every design object in the ir carries an id; every program object that
// realizes one carries that id back in its `ir` field. The two id sets must be
// equal per kind, in both directions: an id only in the program is code no
// section describes and no reviewer signed; an id only in the ir is a design
// object the app silently lacks. Neither is a warning — the program pins the
// sha256 of the exact ir it was compiled from, in one hop, so there is no
// legitimate partially-implemented state.
//
// Compared kinds: entity, pipeline, screen, state, flow, test, decision,
// handler, hatch — the kinds whose CUE objects carry `ir`. Not compared:
// `paths` and `diagram` are narration checked through their screen, `auth` has
// no program object with an id, `review` is the virtual team's work product
// linted against the team file.
//
// The ir is scanned with a regex rather than a DOM parser: this gates
// `sayt lint`, so it must run with --allow-read and --allow-run=cue and no
// network. Ids are opaque tokens — frame ids are BUILT as `${screen.ir}-${state}`
// and compared literally, never split back apart.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any finding is reported.

type Finding = { severity: string; path: string; message: string };

/** ir kinds compared against the program, in report order. */
const KINDS = [
  "entity",
  "pipeline",
  "screen",
  "state",
  "flow",
  "test",
  "decision",
  "handler",
  "hatch",
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

function declarations(code: Record<string, any>): Declaration[] {
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

export function checkBijection(
  code: unknown,
  html: string,
  paths: { program: string; ir: string },
): Finding[] {
  const c = code as Record<string, any>;
  const findings: Finding[] = [];
  const declared = declarations(c);
  const byKind = irIds(html);

  const programBy = new Map<string, Declaration[]>();
  for (const d of declared) programBy.set(d.id, [...(programBy.get(d.id) ?? []), d]);
  for (const id of [...programBy.keys()].sort()) {
    const ds = programBy.get(id)!;
    if (ds.length < 2) continue;
    findings.push({
      severity: "error",
      path: paths.program,
      message:
        `ir id "${id}" is declared by ${ds.length} program objects ` +
        `(${ds.map((d) => d.where).sort().join(", ")}): a bijection is one-to-one, ` +
        `so each ir element is realized by exactly one program object.`,
    });
  }

  const irBy = new Map<string, string[]>();
  for (const [kind, ids] of byKind) {
    for (const id of ids) irBy.set(id, [...(irBy.get(id) ?? []), kind]);
  }
  for (const id of [...irBy.keys()].sort()) {
    const kinds = irBy.get(id)!;
    if (kinds.length < 2) continue;
    findings.push({
      severity: "error",
      path: paths.ir,
      message:
        `id "${id}" is borne by ${kinds.length} elements ` +
        `(data-kind ${kinds.slice().sort().join(", ")}): ids are globally unique.`,
    });
  }

  for (const kind of KINDS) {
    const program = new Set(declared.filter((d) => d.kind === kind).map((d) => d.id));
    const ir = new Set(byKind.get(kind) ?? []);
    for (const id of [...program].filter((id) => !ir.has(id)).sort()) {
      const elsewhere = irBy.get(id);
      findings.push({
        severity: "error",
        path: paths.program,
        message: elsewhere
          ? `${kind} "${id}" is defined in ${paths.ir} as data-kind="${elsewhere[0]}": ` +
            `one id, two kinds. Ids are opaque and globally unique — rename one side.`
          : `${kind} "${id}" has no counterpart in ${paths.ir}: the program realizes a ` +
            `design object the ir never defines, so it ships without design rationale ` +
            `or review. Recompile the ir to define ` +
            `<section id="${id}" data-kind="${kind}">, or drop it from the program.`,
      });
    }
    for (const id of [...ir].filter((id) => !program.has(id)).sort()) {
      findings.push({
        severity: "error",
        path: paths.ir,
        message:
          `${kind} "${id}" has no counterpart in ${paths.program}: the ir designs an ` +
          `object hop 2 dropped, so it is silently absent from the running app.`,
      });
    }
  }

  // Ids alone leave the route unchecked, and a screen's route is design: it is
  // what the ir's frame links address and what a reviewer navigates to. Drift
  // here moves a screen without any set difference to show for it.
  const routes = irRoutes(html);
  const screens = Object.entries(c.surface.screens as Record<string, any>)
    .sort(([, a], [, b]) => (a.ir < b.ir ? -1 : a.ir > b.ir ? 1 : 0));
  for (const [key, screen] of screens) {
    const ir = routes.get(screen.ir);
    if (ir === undefined) continue; // no such ir screen — already reported above
    if (ir === null) {
      findings.push({
        severity: "error",
        path: paths.ir,
        message: `screen "${screen.ir}" declares no data-route: the route is part of the ` +
          `id convention, and without it the ir cannot link its storyboard frames to the ` +
          `rendered screen. Add data-route="${screen.route}".`,
      });
    } else if (ir !== screen.route) {
      findings.push({
        severity: "error",
        path: paths.ir,
        message: `screen "${screen.ir}" is designed at route "${ir}" but ` +
          `screens.${key} serves it at "${screen.route}": the design doc sends every ` +
          `reader to a route the app does not answer there.`,
      });
    }
  }
  return findings;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function selfTest(): void {
  const program = {
    state: {
      entities: { Note: { ir: "note-entity" } },
      pipelines: {},
    },
    capabilities: {
      hatches: {},
    },
    surface: {
      screens: { wall: { ir: "wall", route: "/", states: ["loading", "empty"] } },
      flows: {},
      handlers: { "label-items": { ir: "label-items" } },
    },
    meta: {
      tests: {},
      decisions: {},
    },
  };
  const ir = [
    `<style>[data-kind="handler"] { color: red }</style>`,
    `<section id="note-entity" data-kind="entity">n</section>`,
    `<section id="wall" data-kind="screen" data-route="/">w</section>`,
    `<figure id="wall-loading" data-kind="state">l</figure>`,
    `<figure data-kind="state" id="wall-empty">e</figure>`,
    `<li>a section must carry data-kind="handler" to count</li>`,
  ].join("\n");
  const paths = { program: "program.cue", ir: "ir.html" };
  const cases: { name: string; code: unknown; html: string; expect: string[] }[] = [
    {
      // The style block declares a handler selector and the prose names one;
      // neither is an id, so the program's handler is the only finding.
      name: "css selectors and prose are not ids",
      code: program,
      html: ir,
      expect: [`handler "label-items" has no counterpart`],
    },
    {
      name: "a handler in both directions is silent",
      code: program,
      html: ir + `\n<section id="label-items" data-kind="handler">i</section>`,
      expect: [],
    },
    {
      name: "an ir-only handler is an error too",
      code: { ...program, surface: { ...program.surface, handlers: {} } },
      html: ir + `\n<section id="label-items" data-kind="handler">i</section>`,
      expect: [`handler "label-items" has no counterpart in program.cue`],
    },
    {
      // Attribute order is not a contract: wall-empty above is data-kind first.
      name: "frame ids are built from screen.ir, in either attribute order",
      code: {
        ...program,
        surface: {
          ...program.surface,
          handlers: {},
          screens: { wall: { ir: "wall", route: "/", states: ["loading", "empty", "dark"] } },
        },
      },
      html: ir,
      expect: [`state "wall-dark" has no counterpart`],
    },
    {
      name: "screen.ir wins over the collection key",
      code: {
        ...program,
        surface: {
          ...program.surface,
          handlers: {},
          screens: { "the-wall": { ir: "wall", route: "/", states: ["loading", "empty"] } },
        },
      },
      html: ir,
      expect: [],
    },
    {
      name: "two program objects claiming one id",
      code: {
        ...program,
        surface: { ...program.surface, handlers: {} },
        meta: { ...program.meta, decisions: { d: { ir: "wall" } } },
      },
      html: ir,
      expect: [`is declared by 2 program objects`, `decision "wall" is defined in ir.html as data-kind="screen"`],
    },
    {
      name: "one id on two ir elements",
      code: { ...program, surface: { ...program.surface, handlers: {} } },
      html: ir + `\n<section id="wall" data-kind="handler">i</section>`,
      expect: [`is borne by 2 elements`, `handler "wall" has no counterpart in program.cue`],
    },
    {
      // Every id matches; only the route moved. Nothing above this check sees it.
      name: "a route that drifted from the ir",
      code: {
        ...program,
        surface: {
          ...program.surface,
          handlers: {},
          screens: { wall: { ir: "wall", route: "/wall", states: ["loading", "empty"] } },
        },
      },
      html: ir,
      expect: [`is designed at route "/" but screens.wall serves it at "/wall"`],
    },
    {
      name: "an ir screen with no data-route",
      code: { ...program, surface: { ...program.surface, handlers: {} } },
      html: ir.replace(` data-route="/"`, ""),
      expect: [`screen "wall" declares no data-route`],
    },
  ];
  let failed = 0;
  for (const t of cases) {
    const got = checkBijection(t.code, t.html, paths);
    const ok = got.length === t.expect.length &&
      t.expect.every((frag, i) => got[i].message.includes(frag));
    if (!ok) {
      failed++;
      console.error(`FAIL ${t.name}: got ${JSON.stringify(got, null, 2)}`);
    } else {
      console.error(`ok   ${t.name}`);
    }
  }
  if (failed > 0) Deno.exit(1);
  console.error(`check-bijection self-test: ${cases.length} cases passed`);
}

function fail(msg: string): never {
  console.error(`pronto bijection: ${msg}`);
  Deno.exit(1);
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    selfTest();
    Deno.exit(0);
  }
  const appDir = Deno.args[0] ?? fail("usage: check-bijection.ts <appDir> | --self-test");
  const exported = await new Deno.Command("cue", {
    args: ["export", ".", "-e", "code", "--out", "json"],
    cwd: appDir,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!exported.success) fail("cue export failed");
  const code = JSON.parse(new TextDecoder().decode(exported.stdout));

  const rel = (name: string) => [appDir, name].join("/").replace(/^\.\//, "");
  const irPath = rel(code.meta.ir.source);
  const bytes = await Deno.readFile(irPath);
  const actual = await sha256(bytes);
  const findings: Finding[] = actual !== code.meta.ir.sha256
    // A pin mismatch is the finding, not a reason to skip: every difference
    // below would be noise about an ir the program was never compiled from.
    ? [{
      severity: "error",
      path: irPath,
      message:
        `program pins ir sha256 ${code.meta.ir.sha256} but ${code.meta.ir.source} hashes to ` +
        `${actual}: the program was compiled from a different ir. Recompile hop 2 ` +
        `or restore the pinned ir.`,
    }]
    : checkBijection(code, new TextDecoder().decode(bytes), {
      program: rel("program.cue"),
      ir: irPath,
    });

  console.log(JSON.stringify(findings, null, 2));
  if (findings.length > 0) Deno.exit(1);
}
