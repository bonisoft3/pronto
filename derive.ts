// pronto derivation: reads and handler lists from screen markup, decision
// notes and test citations from the ir.
//
// A screen's markup already says which collections it reads (`data-live`,
// `data-reads`) and which Jessie modules it binds (`data-handler`,
// `data-on-*`); restating both in program.cue was two statements of one fact.
// This pass projects them out of the markup into program_derived.cue, which unifies
// into the program — so `cue export` stays the one source the emitter and the
// checkers read, and the markup is the authority.
//
// Derived per screen: `reads`, every read the markup makes as the terminal
// routes it (#Read: its table, kind, nesting, route, filter clauses, embeds,
// cap and order columns), verbatim from the reader, `writes`, every write it states (#Write), and
// `files.handlers` as shell/handlers/<name>.js for every handler name. They
// are facts, not decisions: what a program concludes from them — which tables
// the terminal reads lazily (read.cue) — is CUE's to say.
// Screen names come from shell/screens/*.html; a stale html file for a screen
// the program no longer declares fails the export rather than deriving in
// silence.
//
// Derived per test: `accepts`, the claims the ir element the test's `ir`
// names cites in `data-accepts`, so a test settles what its design says it
// settles and program.cue states it once, in the ir.
//
// Derived per decision: `note`, the prose of the ir element the decision's
// `ir` names — so the ir, the artifact under review, is the authority, and
// program.cue names its decisions without restating them.

import type { ParsedExpr } from "./cel-emit.ts";
import { enumValues } from "./cel-emit.ts";
import { parseCel } from "./cel.ts";
import { celFixtures } from "./cel-fixtures.ts";
import { DENIED, jessieFacts, jessieSelfTest, splitCompletion } from "./jessie.ts";
import { linkEngine, LinkError } from "./engine-link.ts";
import {
  EXCEPTION_REASONS,
  type Scale,
  ownedTokens,
  resolveImports,
  scaleDeclarations,
  scaleSources,
  scaleSteps,
  scanStylesheet,
  styleSelfTest,
  tokenDeclarations,
} from "./styles.ts";
import { scalesSelfTest } from "./scales.ts";
import { celSites, renderCel, renderIr } from "./derive-cel.ts";
import { renderValidations, resolveEdges, type VEntity, validationLint, validationsSelfTest } from "./validations.ts";
import { oneHome, parseHeld, seedKey, vetHeld } from "./seed.ts";
import type { TypeEntity } from "./type-check.ts";
import { claims, irAccepts, irPaths, LEDGER } from "./acceptance.ts";
import { composeIr } from "./ir-render.ts";
import { chartDeclarations, type ChartSite, declarations, handlersOwed, irIds, irRoutes, KINDS } from "./objects.ts";
import { irDiagrams } from "./diagrams.ts";
import {
  acceptanceFacts,
  artifactFacts,
  designCssFacts,
  importFacts,
  mergeFacts,
  jessieFactRows,
  styleFacts,
  literalFacts,
  bijectionFacts,
  nestingFacts,
  celFacts,
  diagramFacts,
  type FactChart,
  i18nFacts,
  type FactTemplateMsgRef,
  type FactTemplateProse,
  programFacts,
  renderFacts,
  scanTemplateI18n,
  scaleFacts,
  scriptFacts,
  sha256Hex,
} from "./facts.ts";
type Spec = { col: string; op: string; value?: string }[] | null;
/** A read and a write as the reader prints them and program_derived.cue
 * states them (#Read, #Write). */
type Read = {
  table: string;
  kind: "live" | "reads" | "named";
  nested: boolean;
  lists: number[];
  route: "server" | "snapshot" | "whole" | "view";
  clauses?: { col: string; op: string }[];
  embeds?: string[];
  limit?: number;
  orders: string[];
};
type Write = { table: string; op: string; filter?: string };
type Chart = { table: string; field: string; writes: Write[] };
type DerivedScreen = { name: string; reads: Read[]; writes: Write[]; charts: Chart[]; handlers: string[]; adapters: string[] };

/**
 * The markup projection, as the terminal's reader prints it — read-markup.ts's
 * header is the contract, and this is the half of it this pass reads.
 *
 * The readings are the terminal's own: it publishes the markup's grammar, so
 * it publishes what a sentence in that grammar says. They arrive over a pipe
 * rather than through an import because pronto is published on its own, where
 * a path into the terminal's tree resolves to nothing.
 */
type MachineProjection = {
  table: string;
  machine: string;
  emptyRow?: string;
  filter?: string;
  refs: string[];
  assignStrings: string[];
  filterSpec: Spec;
  writes: Write[];
};
export type ScreenProjection = { handlers: string[]; adapters: string[]; reads: Read[]; writes: Write[]; machines: MachineProjection[] };

/** The slice of a program's entity this pass reads off its own export; every
 * module it hands the entities to declares the slice it reads for itself. */
type Entity = {
  table: string;
  durability: string;
  fields: { name: string; type: string; cel?: string }[];
  invariant?: { cel: string };
};

import { dirname, join, relative, sep } from "node:path";
import { quoteKey } from "./cue.ts";
import { entries, exists, ifMissing } from "./missing.ts";

export const GENERATED_HTML_HEADER = "<!-- generated by pronto from program.cue — do not edit -->\n";

const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const OPEN_TAG = /<([a-z][a-z0-9]*)\s[^>]*>/gi;
const ID = /\sid="([^"]*)"/;
const DECISION = /\sdata-kind="decision"/;

/**
 * Inner html of every `data-kind="decision"` element, by id. Scanned with a
 * regex, not a DOM parse, for objects.ts's reason. An ir spells a
 * decision in whatever element its prose sits in — section, p, li — so the
 * body runs to that element's own close tag.
 */
export function irDecisions(html: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const text = html.replace(STYLE, "");
  for (const open of text.matchAll(OPEN_TAG)) {
    if (!DECISION.test(open[0])) continue;
    // OPEN_TAG ends at the first ">", so an odd quote count means one sat inside
    // an attribute value and the match stops short of the tag's real end.
    if ((open[0].match(/"/g)?.length ?? 0) % 2 !== 0) {
      throw new Error(`a <${open[1]}> decision: a ">" inside an attribute value ends its opening tag early`);
    }
    const id = ID.exec(open[0]);
    if (!id) throw new Error(`a <${open[1]}> decision carries no id`);
    const rest = text.slice(open.index + open[0].length);
    const close = new RegExp(`</${open[1]}[\\s>]`, "i").exec(rest);
    if (close === null) throw new Error(`decision "${id[1]}": its <${open[1]}> is never closed`);
    const body = rest.slice(0, close.index);
    if (new RegExp(`<${open[1]}[\\s>]`, "i").test(body)) {
      throw new Error(`decision "${id[1]}": a nested <${open[1]}> ends the body before the prose does`);
    }
    if (bodies.has(id[1])) throw new Error(`decision "${id[1]}": two elements bear this id`);
    bodies.set(id[1], body);
  }
  return bodies;
}

/** A closed list: an entity outside it is an error, never a mangled note. */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": "\u00a0",
  "&mdash;": "—",
  "&ldquo;": "“",
  "&rdquo;": "”",
};
const ENTITY = /&[^;<>\s]*;/g;

/**
 * A decision element's prose as the note the program carries, on one line: the
 * ir's words, with the markup and the closing period taken off, and nothing
 * else. The only structure it demands is that there be words.
 */
export function decisionNote(body: string): string {
  const text = body.replace(/<[^>]*>/g, "").replace(ENTITY, (e) => {
    const c = ENTITIES[e];
    if (c === undefined) throw new Error(`${e} is not an entity this pass decodes`);
    return c;
  }).replace(/\s+/g, " ").trim();
  if (text === "") throw new Error("it holds no prose");
  return text.replace(/\.$/, "");
}

/** A derived read or write as a CUE struct; JSON is CUE here, keys and all. */
const row = (value: object): string =>
  `{${Object.entries(value).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}}`;

export function renderDerived(
  pkg: string,
  screens: DerivedScreen[],
  // The app's own Jessie modules, by basename: an adapter it does not ship is
  // the terminal's, and the route names the path the terminal serves it at.
  available: Set<string>,
  decisions: { id: string; note: string }[],
  tests: { id: string; accepts: string[] }[],
  ladder: string[] = [],
): string {
  const blocks = screens.map(({ name, reads, writes, charts, handlers, adapters }) => {
    const mods = handlers.map((h) => `"shell/handlers/${h}.js"`).join(", ");
    // An adapter is listed apart from the reduces: the role decides the cage a
    // module loads in, and a checker cannot ask about a role it cannot see.
    // The terminal serves its own under /omnishell/components/, so an app that
    // ships none of its own carries no copy to drift.
    const adapterMods = adapters
      .map((a) => (available.has(a) ? `"shell/handlers/${a}.js"` : `"/omnishell/components/${a}.js"`))
      .join(", ");
    const list = (rows: object[]) => rows.length === 0 ? "[]" : `[\n${rows.map((r) => `\t\t\t${row(r)},`).join("\n")}\n\t\t]`;
    return `\t${quoteKey(name)}: {\n\t\treads: ${list(reads)}\n\t\twrites: ${list(writes)}\n\t\tcharts: ${list(charts)}\n` +
      `\t\tfiles: {handlers: [${mods}], adapters: [${adapterMods}]}\n\t}`;
  });
  // JSON escapes are CUE escapes, and CUE reads `\(` as interpolation only
  // after a backslash JSON.stringify would have doubled.
  const notes = decisions.map(({ id, note }) => `\t${quoteKey(id)}: ${JSON.stringify(note)}`);
  const accepts = tests.map(({ id, accepts }) => `\t${quoteKey(id)}: ${JSON.stringify(accepts)}`);
  const ladderBlock = ladder.length === 0 ? "" : `\ncode: meta: ladder: ${JSON.stringify(ladder)}\n`;
  // Pattern constraints, not concrete fields: this file supplies notes and
  // citations to the decisions and tests program.cue declares and declares
  // none of its own. Derive's own export sets `derive`, the one read for which
  // they are the previous run's and may not know a new id yet.
  return `// generated by pronto from the ir and the screen markup — do not edit\npackage ${pkg}\n\ncode: surface: screens: {\n${
    blocks.join("\n")
  }\n}\n\n_irNotes: {\n${notes.join("\n")}\n}\n\n_deriving: *false | bool @tag(derive,type=bool)\n\nif !_deriving {\n\tcode: meta: decisions: [Id=string]: note: _irNotes[Id]\n}\n\n_irAccepts: {\n${
    accepts.join("\n")
  }\n}\n\nif !_deriving {\n\tcode: meta: tests: [Id=string]: accepts: _irAccepts[Id]\n}\n${ladderBlock}`;
}

/**
 * The citations of each test the program declares: what the element its `ir`
 * names cites in `data-accepts`, which may be nothing. A missing element fails
 * here, as a decision's does: nothing would constrain that test's citations.
 */
export function acceptsFor(
  elements: string[],
  cited: { test: string; accept: string }[],
  irOf: Record<string, string>,
): { id: string; accepts: string[] }[] {
  const present = new Set(elements);
  const errors: string[] = [];
  const out: { id: string; accepts: string[] }[] = [];
  for (const id of Object.keys(irOf).sort()) {
    if (!present.has(irOf[id])) {
      errors.push(`test "${id}" has no element with id="${irOf[id]}" data-kind="test"`);
      continue;
    }
    out.push({ id, accepts: cited.filter((c) => c.test === irOf[id]).map((c) => c.accept) });
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return out;
}

function fail(msg: string): never {
  console.error(`pronto derive: ${msg}`);
  Deno.exit(1);
}

/**
 * The note of each decision the program declares: the prose of the element its
 * `ir` names, which defaults to the decision's own id. A missing element fails
 * here rather than reaching objects.ts: nothing would constrain that
 * decision's note, so the export carrying the finding never completes.
 */
export function notesFor(
  bodies: Map<string, string>,
  irOf: Record<string, string>,
): { id: string; note: string }[] {
  const errors: string[] = [];
  const out: { id: string; note: string }[] = [];
  for (const id of Object.keys(irOf).sort()) {
    const body = bodies.get(irOf[id]);
    if (body === undefined) {
      errors.push(`decision "${id}" has no element with id="${irOf[id]}" data-kind="decision"`);
      continue;
    }
    try {
      out.push({ id, note: decisionNote(body) });
    } catch (e) {
      errors.push(`decision "${id}": ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return out;
}

// A path the terminal names, from omnishell's root, where the app's mise put it.
export async function terminalPath(path: string, appDir: string): Promise<string> {
  const where = await new Deno.Command("mise", {
    args: ["where", "github:bonisoft3/omnishell"],
    cwd: appDir,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!where.success) throw new Error("mise does not resolve github:bonisoft3/omnishell");
  return `${new TextDecoder().decode(where.stdout).trim()}/${path}`;
}

/** Scan the app's screens and write program_derived.cue beside program.cue. */
/** An effect's handler as a fact row, read in the airlock's cage's terms:
 * endowed with what the effect declares, completing in its exports. */
export async function effectModules(
  appDir: string,
  effects: Record<string, { endowments?: string[] }>,
): Promise<{ path: string; references: string[]; completion: string; role: string }[]> {
  const rows = [];
  for (const [ename, e] of Object.entries(effects)) {
    const path = `effects/${ename}.js`;
    const src = await ifMissing(Deno.readTextFile(`${appDir}/${path}`), null);
    if (src === null) fail(`effect ${ename}: its handler ${path} is not a file`);
    rows.push({ path, references: jessieFacts(src, "effect", e.endowments ?? []).references, completion: "exports", role: "effect" });
  }
  return rows;
}

async function cueJson(cwd: string, args: string[]): Promise<unknown> {
  const result = await new Deno.Command("cue", {
    args, cwd, stdout: "piped", stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr).trim() || `cue exited ${result.code}`);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

/** Importing the app leaves unreferenced deployment roots unevaluated. */
export async function readDerivation(appDir: string, pkg: string, lifting: boolean): Promise<unknown> {
  const app = await Deno.realPath(appDir);
  let root = app;
  while (await ifMissing(Deno.stat(join(root, "cue.mod/module.cue")), null) === null) {
    const parent = dirname(root);
    if (parent === root) throw new Error(`${app}: no enclosing CUE module`);
    root = parent;
  }
  const module = await cueJson(root, ["export", join(root, "cue.mod/module.cue"), "-e", "module", "--out", "json"]);
  if (typeof module !== "string" || module === "") throw new Error(`${root}/cue.mod/module.cue: module must be a string`);
  const versionAt = module.lastIndexOf("@");
  const modulePath = versionAt < 0 ? module : module.slice(0, versionAt);
  const version = versionAt < 0 ? "" : module.slice(versionAt);
  const subdir = relative(root, app).split(sep).join("/");
  const importPath = `${modulePath}${subdir ? `/${subdir}` : ""}${version}:${pkg}`;
  // Write permissions are scoped to the caller's spelling, including Windows short paths.
  const observer = await Deno.makeTempDir({ dir: appDir, prefix: ".pronto-derive-" });
  try {
    const bootstrap = await Deno.makeTempFile({ dir: appDir, prefix: "pronto_derive_", suffix: ".cue" });
    try {
      // Tag injection applies only to the CLI package, so the imported app is lifted explicitly.
      // Every field program_derived.cue holds is defaulted, so a first generate can read a program it has not derived.
      await Deno.writeTextFile(
        bootstrap,
        `package ${pkg}\ncode: surface: screens: [string]: {reads: *[] | [..._], writes: *[] | [..._], charts: *[] | [..._], files: handlers: *[] | [..._]}\n${lifting ? "_deriving: true\n" : ""}`,
      );
      const expression =
        "{entities: app.code.state.entities, ir: app.code.meta.ir.source, " +
        "decisions: {for k, v in app.code.meta.decisions {(k): v.ir}}, " +
        "tests: {for k, t in app.code.meta.tests {(k): t.ir}}, " +
        "paths: {for k, s in app.code.surface.screens {(k): {for n, p in s.paths {(n): p.accepts}}}}, " +
        // Both sides of the literal rule's join, out of this one export, and the
        // shared stylesheets the emission itself carries. Read off disk instead, a missing or stale file
        // would yield an empty step set and a green lint. The checked-in copies are held equal to these by the
        // artifact hashes, so nothing is lost by grading the emission.
        "scale: app.out.scale, design: app.code.surface.design, " +
        "designCss: app.out.files[\"shell/design.css\"].text, " +
        "shellCss: app.out.files[\"shell/shell.css\"].text, " +
        "entry: app.out.terminal.surface.entry, " +
        // The terminal's own paths: what this pass spawns to read the markup,
        // and the published schema it vets each chart against.
        "markupReader: app.out.terminal.surface.markupReader, " +
        "machineSchema: app.out.terminal.surface.machineSchema, " +
        "statics: [for s in app.out.cluster.meta.statics {file: s.file, target: s.target}], " +
        // The scripts accounted for without being Jessie: a declared unit's or
        // host-DOM hatch's files, and the terminal's own service worker and boot
        // script, the boot only where the app has not replaced it.
        "scripts: {units: [for _, v in app.code.capabilities.vendored for f in v.files {f}], " +
        "hatches: [for _, h in app.code.capabilities.hatches if h.kind == \"host-dom\" for f in h.files {f}], " +
        "sw: app.out.terminal.surface.sw, boot: app.out.terminal.surface.boot, bootText: app.out.terminal.surface.assets.boot, " +
        "interpreterRoot: app.out.terminal.surface.interpreterRoot}, " +
        "shared: {for k, s in app.code.surface.screens {(k): s.files.shared}}, " +
        "pendingLiterals: app.code.meta.design.pendingLiterals, " +
        // Which tables the terminal reads lazily and why, as the program
        // decides it from the reads and writes the last derivation projected.
        "read: app.code.#read, " +
        "program: app.code}";
      await Deno.writeTextFile(join(observer, "input.cue"), `package ${pkg === "pronto_derivation" ? "pronto_derivation_reader" : "pronto_derivation"}\nimport app ${JSON.stringify(importPath)}\nreading: ${expression}\n`);
      return await cueJson(observer, ["export", ".", "-e", "reading", "--out", "json"]);
    } finally {
      await Deno.remove(bootstrap);
    }
  } finally {
    await Deno.remove(observer, { recursive: true });
  }
}

export async function derive(appDir: string): Promise<void> {
  const program = await ifMissing(Deno.readTextFile(`${appDir}/program.cue`), null);
  if (program === null) {
    fail(`${appDir}/program.cue: no such file — author program.cue unifying \`code: pronto.#App & { ... }\``);
  }
  const pkg = /^package (\w+)$/m.exec(program)?.[1] ?? fail(`${appDir}/program.cue names no package`);

  // Both derivations unify back into the entities this export reads, so a
  // constraint the previous run derived would judge a row the current run's
  // cel admits, and a module it split would be emitted for a source the
  // current run never read — the files go before the program is read.
  await ifMissing(Deno.remove(`${appDir}/program_cel.cue`), undefined);
  await ifMissing(Deno.remove(`${appDir}/program_validations.cue`), undefined);
  // The previous run's citations are its own: a test or decision new to the
  // ir has no entry until this run derives one, so this read alone lifts them
  // (`_deriving`) and every other read stays strict. A file from before
  // the tag is read as it is; its first rewrite declares it.
  const previous = await ifMissing(Deno.readTextFile(`${appDir}/program_derived.cue`), "");
  const lifting = previous.includes("@tag(derive,");

  const stubDesign = !(await exists(`${appDir}/DESIGN.md`));
  if (stubDesign) await Deno.writeTextFile(`${appDir}/DESIGN.md`, '---\npreset: "press"\n---\n');
  let exp: {
    // The export carries a whole #Entity; each module declares the slice it
    // reads, and this pass reads both the lint slice and the validation one.
    entities: Record<string, Entity & VEntity>;
    ir: string;
    decisions: Record<string, string>;
    tests: Record<string, string>;
    paths: Record<string, Record<string, string[]>>;
    scale: Scale;
    design: Record<string, Record<string, string>>;
    designCss: string;
    shellCss: string;
    entry: string;
    markupReader: string;
    machineSchema: string;
    statics: { file: string; target: string }[];
    scripts: { units: string[]; hatches: string[]; sw: string; boot: string; bootText: string; interpreterRoot: string };
    shared: Record<string, string[]>;
    pendingLiterals: number;
    read: Record<string, { table: string; mode: string; reason: string }>;
    program: Record<string, unknown>;
  };
  try {
    exp = await readDerivation(appDir, pkg, lifting) as typeof exp;
  } finally {
    if (stubDesign) await ifMissing(Deno.remove(`${appDir}/DESIGN.md`), undefined);
  }
  const entities = exp.entities;
  // `program` is exported whole, so the slices the table registry needs are
  // read off it rather than added to the expression above.
  const { surface, state, meta: appMeta } = exp.program as unknown as {
    surface: {
      screens: Record<string, { ir: string; route: string; markup?: string; forms?: { id: string; entity: string }[]; files: { html: string; renderers?: string[] } }>;
      handlers?: Record<string, { ir: string; src: string }>;
      endowments?: Record<string, string[]>;
      engines?: Record<string, { src: string }>;
    };
    state: {
      pipelines?: Record<string, { fold?: { src: string; pair: { table: string } } }>;
      computations?: Record<string, { src: string; wasm: string[]; endowments: string[] }>;
      effects?: Record<string, { endowments?: string[] }>;
      machines?: Record<string, unknown>;
      seed?: { src: string };
    };
    meta?: { i18n?: { default?: string; locales?: Record<string, { path: string }> } };
  };
  const defaultLocale = appMeta?.i18n?.default ?? null;
  const locales = Object.keys(appMeta?.i18n?.locales ?? {});
  const catalogs: Record<string, Record<string, unknown>> = {};
  for (const loc of locales) {
    const text = await ifMissing(Deno.readTextFile(`${appDir}/messages/${loc}.json`), null);
    if (text === null) fail(`messages/${loc}.json is declared in i18n.locales and missing`);
    let catalog: unknown;
    try {
      catalog = JSON.parse(text);
    } catch (e) {
      fail(`messages/${loc}.json does not parse: ${(e as Error).message}`);
    }
    if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) fail(`messages/${loc}.json is not an object`);
    catalogs[loc] = catalog as Record<string, unknown>;
  }
  const byTable = new Map(Object.entries(entities).map(([name, e]) => [e.table, name]));

  // A validation's module joins the handlers in `modules` below, so the
  // denylist and the completion rule reach it through the same fact rows.
  const TAG = "$validation$";
  const modules: { path: string; references: string[]; completion: string; role: string }[] = [];
  const validated: { entity: string; machine: string; name: string; edges: ReturnType<typeof resolveEdges>; statements: string; completion: string }[] = [];
  const surfaceEndowments = surface.endowments ?? {};
  for (const [ename, e] of Object.entries(entities)) {
    for (const [vname, v] of Object.entries(e.validations ?? {})) {
      const why = validationLint(entities, ename, vname);
      if (why !== null) fail(why);
      const src = await ifMissing(Deno.readTextFile(`${appDir}/${v.src}`), null);
      if (src === null) fail(`entity ${ename}: validations "${vname}" src ${v.src} is not a file`);
      if (src.includes(TAG)) fail(`entity ${ename}: validations "${vname}": ${v.src} contains the quote tag ${TAG}`);
      const split = splitCompletion(src);
      if (split === null) fail(`entity ${ename}: validations "${vname}": ${v.src} must end in an arrow function`);
      const facts = jessieFacts(src, "validation", surfaceEndowments[v.src] ?? []);
      modules.push({ path: v.src, ...facts, role: "validation" });
      // A handler's denied name is a fact row a query reports; a validation's
      // is a refusal here, because its source is embedded in a migration and
      // there is no later seat that would catch it.
      for (const name of facts.references) {
        fail(`entity ${ename}: validations "${vname}": ${v.src} reaches ${name} (${DENIED.find((d) => d.name === name)!.reason})`);
      }
      if (!v.machine) fail(`entity ${ename}: validation ${vname} has no lifecycle machine`);
      validated.push({ entity: ename, machine: v.machine, name: vname, edges: resolveEdges(entities, ename, v.via), ...split });
    }
  }

  // A computation's module joins the fact rows in a role of its own: the cage
  // mecha's compute service runs it in endows only what it declares, and what
  // it completes in is its exports, so no completion shape applies.
  for (const [cname, c] of Object.entries(state.computations ?? {})) {
    const src = await ifMissing(Deno.readTextFile(`${appDir}/${c.src}`), null);
    if (src === null) fail(`computation ${cname}: src ${c.src} is not a file`);
    for (const w of c.wasm) {
      if ((await ifMissing(Deno.stat(`${appDir}/${w}`), null)) === null) fail(`computation ${cname}: wasm ${w} is not a file`);
    }
    modules.push({ path: c.src, references: jessieFacts(src, "computation", c.endowments).references, completion: "exports", role: "computation" });
  }

  // A renderer and a fold join them as the terminal loads each: a renderer's
  // `export default` stripped to the arrow it completes in, a fold completing
  // in its exports.
  const renderers = new Set(Object.values(surface.screens).flatMap((sc) => sc.files.renderers ?? []));
  for (const path of [...renderers].sort()) {
    const src = await ifMissing(Deno.readTextFile(`${appDir}/${path}`), null);
    if (src === null) fail(`renderer ${path} is not a file`);
    const facts = jessieFacts(src.replace(/^[ \t]*export[ \t]+default[ \t]+/m, ""), "renderer", surfaceEndowments[path] ?? []);
    modules.push({ path, ...facts, role: "renderer" });
  }
  for (const [pname, p] of Object.entries(state.pipelines ?? {})) {
    if (p.fold === undefined) continue;
    const src = await ifMissing(Deno.readTextFile(`${appDir}/${p.fold.src}`), null);
    if (src === null) fail(`pipeline ${pname}: fold ${p.fold.src} is not a file`);
    modules.push({ path: p.fold.src, references: jessieFacts(src, "fold", surfaceEndowments[p.fold.src] ?? []).references, completion: "exports", role: "fold" });
  }

  // A kinetic engine is linked here, every module of its graph a fact row in
  // the engine's cage, and the graph written where the terminal serves it.
  for (const [ename, e] of Object.entries(surface.engines ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    let graph;
    try {
      graph = await linkEngine(appDir, e.src);
    } catch (err) {
      if (err instanceof LinkError) fail(`engine ${ename}: ${err.message}`);
      throw err;
    }
    for (const key of Object.keys(graph.modules).sort()) modules.push({ path: key.slice(2), references: [], completion: "exports", role: "engine" });
    await Deno.mkdir(`${appDir}/shell/engines`, { recursive: true });
    const text = JSON.stringify(graph) + "\n";
    const path = `${appDir}/shell/engines/${ename}.json`;
    if (await ifMissing(Deno.readTextFile(path), null) !== text) await Deno.writeTextFile(path, text);
  }

  modules.push(...await effectModules(appDir, state.effects ?? {}));

  // One parse per distinct constraint, and then the parser is done: the IR
  // goes to disk and everything downstream — the CHECK bodies, the CUE
  // constraints, the enum a template set is judged against — is read back
  // from the file, so the artifact a reviewer diffs is the artifact the
  // emitters ran on.
  const sites = celSites(entities);
  const parsed = new Map<string, ParsedExpr>();
  for (const s of sites) {
    if (parsed.has(s.cel)) continue;
    try {
      parsed.set(s.cel, parseCel(s.cel));
    } catch (e) {
      fail(`entity ${s.entity}: cel ${JSON.stringify(s.cel)} does not parse: ${(e as Error).message}`);
    }
  }
  await Deno.mkdir(`${appDir}/.pronto`, { recursive: true });
  await Deno.writeTextFile(`${appDir}/.pronto/cel.json`, renderIr(parsed));
  const irs = new Map<string, ParsedExpr>(
    Object.entries(JSON.parse(await Deno.readTextFile(`${appDir}/.pronto/cel.json`)) as Record<string, ParsedExpr>),
  );
  try {
    await Deno.writeTextFile(`${appDir}/program_cel.cue`, renderCel(pkg, sites, irs));
  } catch (e) {
    fail((e as Error).message);
  }
  const enumsOf = (ename: string) => (col: string): string[] | null => {
    const site = sites.find((s) => s.entity === ename && s.col === col);
    return site === undefined ? null : enumValues(irs.get(site.cel)!);
  };

  // The app's declared Jessie modules, by basename: what tells a machine
  // assign's reference from its literals, since a string in that position is a
  // module exactly where one is declared under the name.
  const available = new Set<string>();
  for (const f of await entries(`${appDir}/shell/handlers`)) {
    if (f.isFile && f.name.endsWith(".js")) available.add(f.name.slice(0, -".js".length));
  }
  const declaredHandlers = new Set(
    Object.values(surface.handlers ?? {}).map((h) => h.src.replace(/^.*\//, "").replace(/\.js$/, "")),
  );

  // CUE-authored HTML must reach the markup reader before chart validation,
  // which judges the current declaration rather than an earlier emission.
  const problems: string[] = [];
  for (const [sname, screen] of Object.entries(surface.screens)) {
    if (screen.markup !== undefined) {
      const path = `${appDir}/${screen.files.html}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      const text = GENERATED_HTML_HEADER + screen.markup;
      if (await ifMissing(Deno.readTextFile(path), null) !== text) await Deno.writeTextFile(path, text);
    } else if (!(await exists(`${appDir}/${screen.files.html}`))) {
      problems.push(
        `${screen.files.html}: no such file — author ${screen.files.html} with <section class="screen" data-screen="${sname}"> or set surface.screens.${sname}.markup in program.cue`,
      );
    }
  }

  // What the screens say, as the terminal reads them. Spawned like the export
  // above and from the same directory, so the path the program's terminal
  // declares is the path that resolves; --no-config because every module the
  // reader loads is a static import of its own.
  let projected: Record<string, ScreenProjection> = {};
  if (problems.length === 0 || await exists(`${appDir}/shell/screens`)) {
    const read = await new Deno.Command("deno", {
      args: ["run", "--no-lock", "--no-check", "--no-config", "--allow-read=.", await terminalPath(exp.markupReader, appDir), "."],
      cwd: appDir,
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!read.success) fail(`${exp.markupReader} refused this app's markup`);
    ({ screens: projected } = JSON.parse(new TextDecoder().decode(read.stdout)));
  }

  const screens: DerivedScreen[] = [];
  const machines: { screen: string; region: MachineProjection }[] = [];
  const allMsgRefs: FactTemplateMsgRef[] = [];
  const allProse: FactTemplateProse[] = [];
  for (const [name, screen] of Object.entries(projected)) {
    if (defaultLocale !== null) {
      const html = await Deno.readTextFile(`${appDir}/shell/screens/${name}.html`);
      const { msgRefs, prose } = scanTemplateI18n(html, name, `shell/screens/${name}.html`);
      allMsgRefs.push(...msgRefs);
      allProse.push(...prose);
    }
    for (const t of new Set([...screen.reads, ...screen.writes].map((r) => r.table))) {
      if (!byTable.has(t)) fail(`${name}.html names "${t}", the table of no declared entity`);
    }
    // A machine's leaves are handler modules like any other: its references
    // (and the assign strings that resolve) join the screen's derived
    // files.handlers so the loader can fetch them.
    const machineNames = new Set<string>();
    for (const region of screen.machines) {
      for (const r of region.refs) machineNames.add(r);
      for (const s of region.assignStrings) if (available.has(s) || declaredHandlers.has(s)) machineNames.add(s);
      machines.push({ screen: name, region });
    }
    screens.push({
      name,
      reads: screen.reads,
      writes: screen.writes,
      charts: screen.machines.map((r) => ({ table: r.table, field: (JSON.parse(r.machine) as { field: string }).field, writes: r.writes })),
      handlers: [...new Set([...screen.handlers, ...machineNames])].sort(),
      adapters: [...new Set(screen.adapters)].sort(),
    });
  }
  screens.sort((a, b) => (a.name < b.name ? -1 : 1));

  // The tables the terminal will register, in the set #App.#collections
  // builds: every screen's reads and writes, every form's entity, and each
  // fold's private pair. A validation's edge is read out of that registry at the store seat,
  // so an edge to a table outside it has no collection to read and the seat
  // would throw at the first write. The write of program_validations.cue waits
  // for this, so a refused derivation leaves no artifact for the emitter.
  const held = new Set<string>();
  for (const s of screens) for (const r of [...s.reads, ...s.writes]) held.add(r.table);
  for (const [sname, s] of Object.entries(surface.screens)) {
    for (const f of s.forms ?? []) {
      if (entities[f.entity] === undefined) fail(`screen ${sname}: form ${f.id} names undeclared entity ${f.entity}`);
      held.add(entities[f.entity].table);
    }
  }
  for (const p of Object.values(state.pipelines ?? {})) {
    if (p.fold !== undefined) held.add(p.fold.pair.table);
  }
  for (const v of validated) {
    for (const edge of v.edges) {
      if (held.has(edge.table)) continue;
      fail(
        `entity ${v.entity}: validations "${v.name}" walk to ${edge.table}, ` +
          `which no screen reads and no form writes, so the store cannot judge it`,
      );
    }
  }
  if (validated.length > 0) {
    await Deno.writeTextFile(`${appDir}/program_validations.cue`, renderValidations(pkg, validated));
  }

  // A machine is vetted against the PUBLISHED #Machine (machine.cue), never a
  // local restatement of it; the two structural preconditions the schema
  // cannot see — the empty-row agreement, and the pinned pk a synthesized
  // fallback row needs — are checked here beside it.
  if (machines.length > 0) {
    await Deno.mkdir(`${appDir}/.pronto`, { recursive: true });
    const files: string[] = [];
    // A refusal in this block is thrown, not exited, so the machine-*.json
    // temps go on every way out; fail() runs no finally block. A temp that
    // will not go is reported, and the refusal is what the run dies with.
    class Refused extends Error {}
    const refuse: (msg: string) => never = (msg) => {
      throw new Refused(msg);
    };
    let refused: string | undefined;
    try {
      for (const [i, { screen, region }] of machines.entries()) {
        // The reader refuses a data-machine that is not JSON, so a chart that
        // reaches this parses.
        const parsed = JSON.parse(region.machine) as {
          field: string;
          initial: string;
        } | null;
        if (typeof parsed?.field !== "string" || typeof parsed.initial !== "string") {
          refuse(`${screen}.html: data-machine names no field and initial`);
        }
        const file = `.pronto/machine-${i}.json`;
        await Deno.writeTextFile(`${appDir}/${file}`, region.machine);
        files.push(file);
        if (region.emptyRow !== undefined) {
          let parsedRow: unknown;
          try {
            parsedRow = JSON.parse(region.emptyRow);
          } catch (e) {
            refuse(`${screen}.html: data-empty-row does not parse: ${(e as Error).message}`);
          }
          if (parsedRow === null || typeof parsedRow !== "object" || Array.isArray(parsedRow)) {
            refuse(`${screen}.html: data-empty-row is not an object`);
          }
          const row = parsedRow as Record<string, unknown>;
          if (row[parsed.field] !== parsed.initial) {
            refuse(
              `${screen}.html: data-empty-row["${parsed.field}"] is ${
                JSON.stringify(row[parsed.field])
              } but the machine's initial is "${parsed.initial}" — one fact, two values`,
            );
          }
        } else if (!(region.filterSpec ?? []).some((p) => p.col === "id" && p.op === "eq")) {
          refuse(`${screen}.html: a machine region with no data-empty-row must pin its id with an eq filter`);
        }
      }
      const vet = await new Deno.Command("cue", {
        // The published #Machine, named by the terminal the program targets
        // rather than by a path into a plugin directory: a consumer keeping the
        // terminal elsewhere says where by unifying machineSchema, and vets
        // against the file it ships.
        args: ["vet", "-d", "#Machine", await terminalPath(exp.machineSchema, appDir), ...files],
        cwd: appDir,
        stderr: "inherit",
      }).output();
      if (!vet.success) refuse("a data-machine does not fit the published #Machine");
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      refused = e.message;
    } finally {
      for (const file of files) {
        try {
          Deno.removeSync(`${appDir}/${file}`);
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) continue;
          console.error(`pronto derive: ${file}: ${(e as Error).message}`);
          refused ??= `${file} was left behind`;
        }
      }
    }
    if (refused !== undefined) fail(refused);
  }

  // Held seed rows are judged here, once per change to them or to what judges
  // them, because judging them costs more than evaluating the program does: the
  // verdict is recorded under seedKey, and a recorded key is a verdict already
  // given. check-facts holds the file to its artifact row, so an edit that skips
  // this pass is a lint failure, never an unjudged row in 900_seed.sql.
  const seedSrc = state.seed?.src;
  const seed_vetted: { src: string; key: string }[] = [];
  if (seedSrc !== undefined) {
    const bytes = await Deno.readFile(`${appDir}/${seedSrc}`).catch((e) => fail(`${seedSrc}: state.seed names it, and it does not open: ${e.message}`));
    const key = await seedKey(bytes, entities, await Deno.readTextFile(`${appDir}/program_cel.cue`), state.machines);
    const previous = await ifMissing(Deno.readTextFile(`${appDir}/.pronto/facts.json`), null);
    const vetted = previous !== null &&
      ((JSON.parse(previous).seed_vetted ?? []) as { src: string; key: string }[]).some((r) => r.src === seedSrc && r.key === key);
    if (!vetted) {
      try {
        const held = parseHeld(seedSrc, new TextDecoder().decode(bytes));
        oneHome(seedSrc, entities as Record<string, { seed?: Record<string, unknown>[] }>, held);
        // The export is CUE's, so every field's type is one types.cue names.
        await vetHeld(appDir, seedSrc, held, entities as unknown as Record<string, TypeEntity>);
      } catch (e) {
        fail((e as Error).message);
      }
    }
    seed_vetted.push({ src: seedSrc, key });
  }

  // The fact store, last: it is a projection of everything above, so anything
  // that failed the derivation never reaches a row.
  const enum_value: Record<string, unknown>[] = [];
  for (const site of sites) {
    if (site.col === null) continue;
    for (const value of enumsOf(site.entity)(site.col) ?? []) {
      enum_value.push({ entity: site.entity, field: site.col, value });
    }
  }
  const charts: FactChart[] = machines.map((m) => ({
    screen: m.screen,
    table: m.region.table,
    machine: m.region.machine,
  }));
  // A handler only a tab-reaching chart names is machine-checked with it.
  // Chart claims share their identities with the IR renderer (objects.ts).
  const chartSites: ChartSite[] = machines.map((m) => ({
    screen: m.screen,
    table: m.region.table,
    field: (JSON.parse(m.region.machine) as { field: string }).field,
    machine: m.region.machine,
    writes: m.region.writes.map((w) => w.table),
    refs: m.region.refs,
  }));
  const programEntities = (exp.program as { state: { entities: Record<string, { table: string; ir: string; durability: string }> } }).state.entities;
  const stemToIr = new Map(
    Object.values(surface.handlers ?? {})
      .map((h) => [h.src.replace(/^.*\//, "").replace(/\.js$/, ""), h.ir]),
  );

  let decls: ReturnType<typeof declarations> = [];
  try {
    decls = [
      ...handlersOwed(declarations(exp.program), chartSites, programEntities, stemToIr),
      ...chartDeclarations(chartSites, programEntities),
    ];
  } catch (e) {
    problems.push(`${exp.ir}: ${(e as Error).message}`);
  }

  let composedIr: { html: string; fragments: string[] } | null = null;
  try {
    composedIr = await composeIr(appDir, exp.ir);
  } catch (e) {
    problems.push((e as Error).message);
  }
  const irHtml = composedIr?.html ?? null;
  const irFragments = composedIr?.fragments ?? [];
  let notes: { id: string; note: string }[] = [];
  let diagrams: { nodes: Parameters<typeof diagramFacts>[0]; edges: Parameters<typeof diagramFacts>[1] } = { nodes: [], edges: [] };
  let accepts: ReturnType<typeof acceptsFor> = [];
  let bijection: ReturnType<typeof bijectionFacts> = {};

  if (irHtml === null) {
    const routesByIr = new Map(Object.values(surface.screens).map((s) => [s.ir, s.route]));
    const owedTags = [
      ...Object.values(programEntities).map(
        (ent) => `<section id="${ent.ir}" data-kind="entity" data-durability="${ent.durability}"><table data-extract="fields">`,
      ),
      ...decls.filter((d) => d.owed && d.kind !== "entity").map((d) => {
        if (d.kind === "screen") return `<article id="${d.id}" data-kind="screen" data-route="${routesByIr.get(d.id) ?? "/"}">`;
        if (d.kind === "decision") return `<article id="${d.id}" data-kind="decision"><p>...</p></article>`;
        if (d.kind === "test") return `<article id="${d.id}" data-kind="test" data-accepts="...">`;
        return `<article id="${d.id}" data-kind="${d.kind}">`;
      }),
    ];
    for (const [sname, pmap] of Object.entries(exp.paths)) {
      const keys = Object.keys(pmap);
      if (keys.length > 0) {
        owedTags.push(`<script type="application/json" data-kind="paths" data-of="${sname}"> (paths: ${keys.join(", ")})`);
      }
    }
    owedTags.push('<div class="diagram"><script type="text/plain">');
    problems.push(`${exp.ir}: no such file — author ${exp.ir} with owed elements: ${owedTags.join(", ")}`);
  } else {
    try {
      notes = notesFor(irDecisions(irHtml), exp.decisions);
    } catch (e) {
      problems.push(`${exp.ir}: ${(e as Error).message}`);
    }
    try {
      diagrams = await irDiagrams(irHtml);
    } catch (e) {
      problems.push(`${exp.ir}: ${(e as Error).message}`);
    }
    try {
      accepts = acceptsFor(irIds(irHtml).get("test") ?? [], irAccepts(irHtml), exp.tests);
    } catch (e) {
      problems.push(`${exp.ir}: ${(e as Error).message}`);
    }
    try {
      bijection = bijectionFacts(KINDS, irIds(irHtml), irRoutes(irHtml), decls, exp.program);
    } catch (e) {
      problems.push(`${exp.ir}: ${(e as Error).message}`);
    }
  }

  const ledgerMd = await ifMissing(Deno.readTextFile(`${appDir}/${LEDGER}`), null);
  let ledger: ReturnType<typeof acceptanceFacts> = {};
  if (ledgerMd === null) {
    const citedIds = [
      ...new Set([
        ...Object.values(exp.paths).flatMap((p) => Object.values(p).flat()),
        ...(irHtml !== null ? irAccepts(irHtml).map((a) => a.accept) : []),
      ]),
    ].sort();
    problems.push(
      `${LEDGER}: no such file — author ${LEDGER} with \`- <claim> {#<id>}\` lines${
        citedIds.length > 0 ? ` for cited ids: ${citedIds.join(", ")}` : ""
      }`,
    );
  } else if (irHtml !== null) {
    try {
      ledger = acceptanceFacts(
        claims(ledgerMd),
        irPaths(irHtml),
        irAccepts(irHtml),
        Object.fromEntries(accepts.map((t) => [t.id, t.accepts])),
        exp.paths,
      );
    } catch (e) {
      problems.push(`${LEDGER}: ${(e as Error).message}`);
    }
  }

  if (!(await exists(`${appDir}/DESIGN.md`))) {
    problems.push('DESIGN.md: no such file — author DESIGN.md (with YAML frontmatter `---\\npreset: "press"\\n---`)');
  }
  if (exp.statics.some((s) => s.file === "journal.html") && !(await exists(`${appDir}/journal.html`))) {
    problems.push(
      "journal.html: no such file — the cluster serves it from the build context, so it must exist in the app (most often the review ladder's journal.html, authored per SPEC's journal.html section)",
    );
  }

  // The palette's one declaration: the shared layer owns a token, a screen may
  // only consume it. Read here rather than at lint so the rule is a join.
  const shared = `${exp.shellCss}\n${exp.designCss}`;
  // The screens' own stylesheets and every shared one a screen names. The shared
  // set is a declaration (#Screen.files.shared) rather than a directory walk, so
  // a path in it that does not open is a stylesheet the program says exists and
  // does not — never a file to skip, which would drop it from both token rules.
  const sharedPaths = new Set(Object.values(exp.shared).flat());
  const appCss: { path: string; css: string }[] = [];
  for (const rel of [...Object.keys(surface.screens).map((name) => `shell/screens/${name}.css`), ...[...sharedPaths].sort()]) {
    const css = await ifMissing(Deno.readTextFile(`${appDir}/${rel}`), null);
    if (css === null) problems.push(`${rel} does not open — author ${rel}`);
    else appCss.push({ path: rel, css });
  }

  const owedHandlers = [
    ...new Set([
      ...screens.flatMap((s) => s.handlers.map((h) => `shell/handlers/${h.replace(/^.*\//, "").replace(/\.js$/, "")}.js`)),
      ...Object.values(surface.handlers ?? {}).map((h) => h.src),
    ]),
  ].sort();
  for (const rel of owedHandlers) {
    if (!(await exists(`${appDir}/${rel}`))) {
      problems.push(`${rel}: missing assembly source ${rel} — author a pure Jessie handler module in ${rel}`);
    }
  }

  if (problems.length > 0 || irHtml === null) fail(problems.join("\n"));

  const journalFiles: string[] = [];
  const walkJournal = async (rel: string) => {
    for (const entry of await entries(`${appDir}/${rel}`, [])) {
      if (entry.name.startsWith(".")) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory) await walkJournal(child);
      else if (entry.isFile) journalFiles.push(child);
    }
  };
  await walkJournal("journal");
  journalFiles.sort();
  const ladder = [...new Set([...irFragments, ...journalFiles])].sort();

  await Deno.writeTextFile(`${appDir}/program_derived.cue`, renderDerived(pkg, screens, available, notes, accepts, ladder));
  const scanned = appCss.map(({ path, css }) => ({ path, ...scanStylesheet(css) }));
  const appTokens = scanned.map(({ path, tokens }) => ({ path, tokens }));
  const literals = scanned.map(({ path, literals, exceptions }) => ({ path, literals, exceptions }));
  // Where each stylesheet's imports resolve from. A screen's CSS is injected as
  // a <style> in the document, so an @import in it resolves against the
  // document's directory (#Screen.files.shared says so, and is what makes
  // `shared/screen.css` the spelling); a shared sheet is reached as a stylesheet
  // in its own right, so its own served directory is the base.
  // The terminal's own boot script, beside its interpreter: an app that
  // passes its own in its place serves a script the rule accounts for as the
  // app's.
  const terminalBoot = await Deno.readTextFile(await terminalPath(`${exp.scripts.interpreterRoot}/../boot.js`, appDir));
  const servedAt = new Map(exp.statics.map((s) => [s.file, s.target]));
  const servedDir = (file: string): string => {
    const target = servedAt.get(file) ??
      fail(
        file === exp.entry
          ? `${file} is served nowhere — pass statics: terminal.surface.statics to pronto.#DefaultCluster in program.cue`
          : `${file} is read as a stylesheet and served nowhere, so nothing can reach it`,
      );
    return target.slice(0, target.lastIndexOf("/"));
  };
  const documentDir = servedDir(exp.entry);
  const imports = resolveImports([
    ...appCss.map((s) => ({ ...s, base: sharedPaths.has(s.path) ? servedDir(s.path) : documentDir })),
    { path: "shell/design.css", css: exp.designCss, base: documentDir },
    { path: "shell/shell.css", css: exp.shellCss, base: documentDir },
  ]);

  // What each declared handler reaches for, and in which role: the denylist is
  // a join, and a name one role is endowed with is a reach in every other. A
  // module named in two roles gets a row per role, so the reach is judged
  // against each cage it actually runs in.
  const adapterNames = new Set(screens.flatMap((s) => s.adapters));
  const handlerNames = new Set(screens.flatMap((s) => s.handlers.map((h) => h.replace(/^.*\//, "").replace(/\.js$/, ""))));
  for (const name of [...available].sort()) {
    const rel = `shell/handlers/${name}.js`;
    const src = await Deno.readTextFile(`${appDir}/${rel}`);
    const roles = [...(adapterNames.has(name) ? ["adapter"] : []), ...(handlerNames.has(name) || !adapterNames.has(name) ? ["handler"] : [])];
    for (const role of roles) modules.push({ path: rel, ...jessieFacts(src, role, surfaceEndowments[rel] ?? []), role });
  }
  // A grant is keyed by the module's path, the one spelling every loader
  // reads; a key naming no terminal module grants nothing. A computation or
  // an effect is granted by its own declaration, and an adapter the terminal
  // serves is loaded under the path the route names.
  const modulePaths = new Set([
    ...modules.filter((m) => m.role !== "computation" && m.role !== "effect").map((m) => m.path),
    ...[...adapterNames].filter((a) => !available.has(a)).map((a) => `/omnishell/components/${a}.js`),
  ]);
  for (const key of Object.keys(surfaceEndowments)) {
    if (!modulePaths.has(key)) fail(`surface.endowments names ${key}, which is the path of no terminal module`);
  }
  // A validation's module and a handler's are pushed by two passes, so the
  // fact rows are ordered here rather than by either.
  modules.sort((a, b) => (a.path < b.path ? -1 : 1));

  // Hashed after every write above, so a derived file's row is what derive left
  // on disk and a source's row is what it read.
  const shaText = (text: string) => sha256Hex(new TextEncoder().encode(text));
  const sha = async (path: string) => sha256Hex(await Deno.readFile(`${appDir}/${path}`));
  const artifacts: { path: string; sha256: string; derived: boolean }[] = [];
  for (const [path, derived] of [
    ["program.cue", false],
    ...((await exists(`${appDir}/seed.cue`)) ? [["seed.cue", false]] : []),
    ["DESIGN.md", false],
    [exp.ir, false],
    ...irFragments.map((f): [string, boolean] => [f, false]),
    [LEDGER, false],
    [".pronto/cel.json", true],
    ["program_cel.cue", true],
    ["program_derived.cue", true],
    ...(validated.length > 0 ? [["program_validations.cue", true]] : []),
    ...(seedSrc !== undefined ? [[seedSrc, false]] : []),
  ] as [string, boolean][]) {
    artifacts.push({ path, sha256: await sha(path), derived });
  }
  for (const c of Object.values(state.computations ?? {})) artifacts.push({ path: c.src, sha256: await sha(c.src), derived: false });
  for (const name of Object.keys(state.effects ?? {})) artifacts.push({ path: `effects/${name}.js`, sha256: await sha(`effects/${name}.js`), derived: false });
  // The stylesheets the rules above read, so that editing one and not
  // regenerating is a stale-row finding rather than a green literal lint over
  // yesterday's numbers. A screen's row hashes the STRING scanned rather than a
  // second read of the path: re-reading here would let a write between the scan
  // and the hash produce a row that matches a file no rule was derived from,
  // which is the race the guard exists to close.
  for (const { path, css } of appCss) artifacts.push({ path, sha256: await shaText(css), derived: false });
  // design.css is emitted, so it is graded by the declaration rules rather than
  // scanned, and its row exists only to catch a hand-edit to the emission.
  // Hashed off disk because that is the artifact the claim is about, and
  // because write.ts prefixes a provenance header the export does not carry.
  // Absent before the first export — nothing has emitted it yet — it records
  // a sentinel the fixpoint re-derive replaces once write.ts has written it;
  // check-facts reports the mismatch as a stale row, never a crash, so a new
  // app converges without a hand-made stub.
  const designCss = await sha("shell/design.css").catch(() => null);
  artifacts.push({ path: "shell/design.css", sha256: designCss ?? "missing", derived: true });

  await Deno.mkdir(`${appDir}/.pronto`, { recursive: true });
  await Deno.writeTextFile(
    `${appDir}/.pronto/facts.json`,
    renderFacts(mergeFacts(
      programFacts(
        entities,
        screens.map((s) => ({
          name: s.name,
          entities: screenEntities(s.reads, machines.filter((m) => m.screen === s.name).map((m) => m.region), byTable),
        })),
        charts,
      ),
      ledger,
      bijection,
      nestingFacts(irHtml),
      artifactFacts(artifacts),
      celFacts(sites, [...irs.keys()]),
      styleFacts(ownedTokens(shared), appTokens),
      literalFacts(scaleSteps(exp.scale, exp.design), literals, EXCEPTION_REASONS, exp.pendingLiterals),
      scaleFacts(scaleSources(exp.scale), scaleDeclarations(exp.scale)),
      designCssFacts(tokenDeclarations(exp.designCss)),
      importFacts(exp.statics, imports),
      scriptFacts([...exp.scripts.units, ...exp.scripts.hatches], [exp.scripts.sw, ...(exp.scripts.bootText === terminalBoot ? [exp.scripts.boot] : [])]),
      jessieFactRows(DENIED, modules),
      { enum_value },
      { read_mode: Object.entries(exp.read).map(([entity, s]) => ({ entity, ...s })) },
      seed_vetted.length > 0 ? { seed_vetted } : {},
      diagramFacts(diagrams.nodes, diagrams.edges),
      i18nFacts(defaultLocale, locales, catalogs, allMsgRefs, allProse),
    )),
  );

}

/** The entities a screen needs a collection for, its `reads` fact: each
 * table it reads, and each its charts' effects write. */
function screenEntities(reads: { table: string }[], charts: { writes: Write[] }[], byTable: Map<string, string>): string[] {
  return [...new Set([...reads, ...charts.flatMap((c) => c.writes)].map((r) => byTable.get(r.table) as string))].sort();
}

function selfTest(): void {
  // Real shadcnui prose, verbatim — an anchor, code spans, escaped angle
  // brackets, an apostrophe, a parenthesis before the closing period, and an
  // opening letter no rule may lowercase. A transform this size is pinned
  // against what a reviewer writes, not a fixture written to pass it.
  const notes: { name: string; body: string; note?: string; throws?: string }[] = [
    { name: "decision-01", body: "<p>Every entity is tab: a\ngallery's state is the visit's, so nothing here emits a table, a policy, a\npublication or a pipeline; the durability ladder is demonstrated by the rows\ndying with the tab, not documented.</p>", note: "Every entity is tab: a gallery's state is the visit's, so nothing here emits a table, a policy, a publication or a pipeline; the durability ladder is demonstrated by the rows dying with the tab, not documented" },
    { name: "decision-02", body: "<p>Behavior is data, not code:\neach stateful component carries a #Machine — the XState-JSON subset whose one\naction is writing the target state into the row's field — executed by the\nterminal through the same path as a Jessie reduce, so replay, tempo and the\nrefusal event apply with the machine knowing nothing; a guard is the cliff\nwhere an app writes the reduce instead, and this gallery crosses it once, for\na value and never for a decision (<a href=\"#decision-34\">decision-34</a>).</p>", note: "Behavior is data, not code: each stateful component carries a #Machine — the XState-JSON subset whose one action is writing the target state into the row's field — executed by the terminal through the same path as a Jessie reduce, so replay, tempo and the refusal event apply with the machine knowing nothing; a guard is the cliff where an app writes the reduce instead, and this gallery crosses it once, for a value and never for a decision (decision-34)" },
    { name: "decision-03", body: "<p>State names are the ARIA\nattribute's values: the switch's states are 'true' and 'false' because\naria-checked speaks that vocabulary, so one field binds the semantics and the\nstyling hook and no component carries two spellings of one\nfact.</p>", note: "State names are the ARIA attribute's values: the switch's states are 'true' and 'false' because aria-checked speaks that vocabulary, so one field binds the semantics and the styling hook and no component carries two spellings of one fact" },
    { name: "decision-04", body: "<p>Components are CUE\ndefinitions composed into #Screen.markup at emit; the omnishell-- tag\nsurvives in the served HTML as an inert wrapper — visible to devtools, CSS\nand the visual battery, registered with nothing, no customElements.define and\nno shadow DOM.</p>", note: "Components are CUE definitions composed into #Screen.markup at emit; the omnishell-- tag survives in the served HTML as an inert wrapper — visible to devtools, CSS and the visual battery, registered with nothing, no customElements.define and no shadow DOM" },
    { name: "decision-05", body: "<p>shadcn's theming is CSS\nvariables, so its palette lands on the design-token contract and dark mode is\neach token's light-dark() twin; there is no theme-switch control because\nappearance is a token resolution, reviewed as the storyboard's -dark\nframes.</p>", note: "shadcn's theming is CSS variables, so its palette lands on the design-token contract and dark mode is each token's light-dark() twin; there is no theme-switch control because appearance is a token resolution, reviewed as the storyboard's -dark frames" },
    { name: "decision-06", body: "<p>No auth block: a component\ngallery gates nobody, and a sign-in in front of a reference is a\ntoll.</p>", note: "No auth block: a component gallery gates nobody, and a sign-in in front of a reference is a toll" },
    { name: "decision-07", body: "<p>The machine is the writer\nof the initial fact: the switch region carries no data-empty-row and the\nterminal synthesizes its fallback row from the filter's pinned id plus the\nmachine's initial; the row-readout pane keeps a data-empty-row because it\nshows a fuller row than the machine's one field, and the generate-time\nagreement check keeps the two declarations one fact.</p>", note: "The machine is the writer of the initial fact: the switch region carries no data-empty-row and the terminal synthesizes its fallback row from the filter's pinned id plus the machine's initial; the row-readout pane keeps a data-empty-row because it shows a fuller row than the machine's one field, and the generate-time agreement check keeps the two declarations one fact" },
    { name: "decision-08", body: "<p>The combobox is\ndeliberately last in the catalog: its virtual-focus behavior is the one part\nwith no declarative precedent, and it is where the widget tier died the first\ntime.</p>", note: "The combobox is deliberately last in the catalog: its virtual-focus behavior is the one part with no declarative precedent, and it is where the widget tier died the first time" },
    { name: "decision-09", body: "<p>N triggers share one\nmachine, so the discrimination is component-generated: #Tabs writes one\n<code>click@trigger-&lt;name&gt;</code> transition per (state, trigger) pair —\na grammar the interpreter resolves and no author learns — and each\ntransition's literal assigns keep one <code>aria-selected</code> column per\ntrigger in step, so the ARIA contract stays plain bindings over the\nrow.</p>", note: "N triggers share one machine, so the discrimination is component-generated: #Tabs writes one click@trigger-<name> transition per (state, trigger) pair — a grammar the interpreter resolves and no author learns — and each transition's literal assigns keep one aria-selected column per trigger in step, so the ARIA contract stays plain bindings over the row" },
    {
      name: "the typographic entities and an escaped ampersand",
      body: `<p>It said &ldquo;a &mdash; b&rdquo; &amp; meant &lt;b&gt;.</p>`,
      note: `It said “a — b” & meant <b>`,
    },
    {
      name: "a nested <a> and <code>",
      body: `<p>See <a href="#decision-33">decision-33</a> and <code>role="grid"</code>.</p>`,
      note: `See decision-33 and role="grid"`,
    },
    {
      name: "paragraphs join on the whitespace between them",
      body: `<p>One.</p>\n  <p>Two.</p>`,
      note: "One. Two",
    },
    {
      name: "an entity outside the table",
      body: `<p>a &hellip; b</p>`,
      throws: "&hellip; is not an entity this pass decodes",
    },
    {
      // truco writes a decision as the <p> itself and thenote as an <li> of
      // bare text, so a note is not owed a paragraph.
      name: "a lead-in and bare text, no <p> anywhere",
      body: `<strong>A lead.</strong> And the rest.`,
      note: "A lead. And the rest",
    },
    { name: "an element holding only markup", body: `<p> <em> </em> </p>`, throws: "it holds no prose" },
  ];

  // Whatever element an ir wraps its prose in, the body ends at that element's
  // own close tag.
  const scans: { name: string; html: string; expect?: string[]; note?: string; throws?: string }[] = [
    {
      name: "section, p and li all carry a decision",
      html: `<section id="a" data-kind="decision"><p>a.</p></section>` +
        `<p id="b" data-kind="decision"><strong>b.</strong> more.</p>` +
        `<ol><li id="c" data-kind="decision"><p>c.</p></li></ol>`,
      expect: ["a", "b", "c"],
    },
    {
      name: "a css selector is not a decision",
      html: `<style>[data-kind="decision"] { color: red }</style><p id="a" data-kind="decision">a.</p>`,
      expect: ["a"],
    },
    {
      name: "a > inside an attribute value",
      html: `<p id="a" data-kind="decision" title="a > b">real prose.</p>`,
      throws: 'a <p> decision: a ">" inside an attribute value ends its opening tag early',
    },
    {
      name: "a decision element bearing no id",
      html: `<p data-kind="decision">a.</p>`,
      throws: "a <p> decision carries no id",
    },
    {
      // </br> shares a prefix with </b> and must not close it; `note` is what
      // catches that, since a truncated body still yields the id.
      name: "a close tag that only shares a prefix",
      html: `<b id="a" data-kind="decision">x</br> y.</b>`,
      expect: ["a"],
      note: "x y",
    },
    {
      name: "one id on two elements",
      html: `<p id="a" data-kind="decision">first.</p><p id="a" data-kind="decision">second.</p>`,
      throws: 'decision "a": two elements bear this id',
    },
    {
      name: "an element nested in itself",
      html: `<li id="a" data-kind="decision"><p>a.</p><ol><li>b</li></ol></li>`,
      throws: 'decision "a": a nested <li> ends the body before the prose does',
    },
  ];

  // `ir` defaults to the decision's own id and may name another element; a
  // decision naming none is the one shape that cannot reach a note.
  const maps: { name: string; irOf: Record<string, string>; expect?: [string, string][]; throws?: string }[] = [
    {
      name: "a decision names another element",
      irOf: { "decision-blob-keys-v2": "decision-blob-keys" },
      expect: [["decision-blob-keys-v2", "keys"]],
    },
    {
      name: "notes come back ordered by decision id, not by ir id",
      irOf: { b: "decision-blob-keys", a: "decision-01" },
      expect: [["a", "one"], ["b", "keys"]],
    },
    {
      name: "a decision whose element the ir does not carry",
      irOf: { "decision-99": "decision-99" },
      throws: 'decision "decision-99" has no element with id="decision-99" data-kind="decision"',
    },
  ];
  const bodies = new Map([["decision-blob-keys", "<p>keys.</p>"], ["decision-01", "<p>one.</p>"]]);

  // Rendering, not just transforming: the key is where a backslash gets a
  // second chance to be read as an escape.
  const rendered = renderDerived("p", [], new Set(), [{ id: "decision\\blob", note: 'a "q" and a \\ and \\(x)' }], [
    { id: "test-one", accepts: ["accept-a", "accept-b"] },
    { id: "test-none", accepts: [] },
  ]);
  const wantKey = '\t"decision\\\\blob": "a \\"q\\" and a \\\\ and \\\\(x)"';
  const wantAccepts = '_irAccepts: {\n\t"test-one": ["accept-a","accept-b"]\n\t"test-none": []\n}\n\nif !_deriving {\n\tcode: meta: tests: [Id=string]: accepts: _irAccepts[Id]\n}\n';
  // A screen's reads, writes and charts as rows; read.cue decides each
  // table's read mode from the first two.
  const block = renderDerived("p", [{
    name: "jogo",
    reads: [
      { table: "goal", kind: "live", nested: true, lists: [], route: "view", clauses: [{ col: "game_id", op: "eq" }], embeds: ["player"], limit: 5, orders: ["minute", "id"] },
      { table: "game", kind: "live", nested: false, lists: [], route: "server", orders: [] },
    ],
    writes: [{ table: "goal", op: "delete", filter: "game_id=eq.{id}" }],
    charts: [{ table: "game", field: "phase", writes: [{ table: "goal", op: "update" }] }],
    handlers: [],
    adapters: [],
  }], new Set(), [], []);
  const wantBlock = '\tjogo: {\n\t\treads: [\n' +
    '\t\t\t{table: "goal", kind: "live", nested: true, lists: [], route: "view", clauses: [{"col":"game_id","op":"eq"}], embeds: ["player"], limit: 5, orders: ["minute","id"]},\n' +
    '\t\t\t{table: "game", kind: "live", nested: false, lists: [], route: "server", orders: []},\n\t\t]\n' +
    '\t\twrites: [\n\t\t\t{table: "goal", op: "delete", filter: "game_id=eq.{id}"},\n\t\t]\n' +
    '\t\tcharts: [\n\t\t\t{table: "game", field: "phase", writes: [{"table":"goal","op":"update"}]},\n\t\t]\n';
  // The cel emitters are pinned here too: one self-test, wired to one rule.
  const celFindings = celFixtures();
  for (const f of celFindings) console.error(`FAIL ${f.message}`);
  const styleFailures = styleSelfTest();
  for (const f of styleFailures) console.error(`FAIL ${f}`);
  const jessieFailures = jessieSelfTest();
  for (const f of jessieFailures) console.error(`FAIL ${f}`);
  const validationFailures = validationsSelfTest();
  for (const f of validationFailures) console.error(`FAIL ${f}`);
  const scaleFailures = scalesSelfTest();
  for (const f of scaleFailures) console.error(`FAIL ${f}`);
  let failed = celFindings.length + styleFailures.length + jessieFailures.length + validationFailures.length +
    scaleFailures.length;
  if (!rendered.includes(wantKey)) {
    failed++;
    console.error(`FAIL a backslash in a decision id:\n  got  ${JSON.stringify(rendered.split("_irNotes: {")[1]?.split("\n")[1])}\n  want ${JSON.stringify(wantKey)}`);
  }
  if (!rendered.endsWith(wantAccepts)) {
    failed++;
    console.error(`FAIL a test's citations render as its constraint:\n  got  ${JSON.stringify(rendered.slice(-wantAccepts.length))}\n  want ${JSON.stringify(wantAccepts)}`);
  }
  // Regression: the facts' `reads` held only the tables a screen reads, where
  // it holds every table the screen needs a collection for, a chart's effect's
  // among them, as it did when the markup reader projected one table list.
  const needed = JSON.stringify(screenEntities(
    [{ table: "match" }],
    [{ writes: [{ table: "score", op: "create" }, { table: "match", op: "update" }] }],
    new Map([["match", "Match"], ["score", "Score"]]),
  ));
  if (needed !== '["Match","Score"]') {
    failed++;
    console.error(`FAIL a screen's facts name the tables a chart's effects write:\n  got  ${needed}\n  want ["Match","Score"]`);
  }
  if (!block.includes(wantBlock)) {
    failed++;
    console.error(`FAIL a screen's reads and writes render as rows:\n  got  ${JSON.stringify(block)}\n  want ${JSON.stringify(wantBlock)}`);
  }
  // The element must exist; what it cites may be nothing.
  const acceptsCases: { name: string; elements: string[]; irOf: Record<string, string>; want?: string; throws?: string }[] = [
    { name: "cites through the ir id", elements: ["t-ir"], irOf: { "t-key": "t-ir" }, want: '[["t-key",["accept-a"]]]' },
    { name: "an element citing nothing", elements: ["t-ir", "t-quiet"], irOf: { "t-quiet": "t-quiet" }, want: '[["t-quiet",[]]]' },
    { name: "a test with no element", elements: [], irOf: { "t-key": "t-ir" }, throws: 'test "t-key" has no element with id="t-ir" data-kind="test"' },
  ];
  for (const t of acceptsCases) {
    try {
      const got = JSON.stringify(acceptsFor(t.elements, [{ test: "t-ir", accept: "accept-a" }], t.irOf).map((x) => [x.id, x.accepts]));
      if (t.throws !== undefined || got !== t.want) {
        failed++;
        console.error(`FAIL ${t.name}: got ${got}, want ${t.throws ?? t.want}`);
      }
    } catch (e) {
      if ((e as Error).message !== t.throws) {
        failed++;
        console.error(`FAIL ${t.name}: threw ${JSON.stringify((e as Error).message)}`);
      }
    }
  }
  for (const t of maps) {
    let got: [string, string][];
    try {
      got = notesFor(bodies, t.irOf).map(({ id, note }) => [id, note]);
    } catch (e) {
      const message = (e as Error).message;
      if (t.throws === message) continue;
      failed++;
      console.error(`FAIL ${t.name}: threw ${JSON.stringify(message)}`);
      continue;
    }
    if (t.throws !== undefined) {
      failed++;
      console.error(`FAIL ${t.name}: returned ${JSON.stringify(got)} where it must throw ${JSON.stringify(t.throws)}`);
    } else if (JSON.stringify(got) !== JSON.stringify(t.expect)) {
      failed++;
      console.error(`FAIL ${t.name}: got ${JSON.stringify(got)}, want ${JSON.stringify(t.expect)}`);
    }
  }
  for (const t of notes) {
    let got: string;
    try {
      got = decisionNote(t.body);
    } catch (e) {
      const message = (e as Error).message;
      if (t.throws === message) continue;
      failed++;
      console.error(`FAIL ${t.name}: threw ${JSON.stringify(message)}`);
      continue;
    }
    if (t.throws !== undefined) {
      failed++;
      console.error(`FAIL ${t.name}: returned ${JSON.stringify(got)} where it must throw ${JSON.stringify(t.throws)}`);
    } else if (got !== t.note) {
      failed++;
      console.error(`FAIL ${t.name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(t.note)}`);
    }
  }
  for (const t of scans) {
    let got: string[];
    let note: string | undefined;
    try {
      const found = irDecisions(t.html);
      got = [...found.keys()];
      if (t.note !== undefined) note = decisionNote(found.get(got[0])!);
    } catch (e) {
      const message = (e as Error).message;
      if (t.throws === message) continue;
      failed++;
      console.error(`FAIL ${t.name}: threw ${JSON.stringify(message)}`);
      continue;
    }
    if (t.throws !== undefined) {
      failed++;
      console.error(`FAIL ${t.name}: found ${JSON.stringify(got)} where it must throw ${JSON.stringify(t.throws)}`);
    } else if (JSON.stringify(got) !== JSON.stringify(t.expect)) {
      failed++;
      console.error(`FAIL ${t.name}: found ${JSON.stringify(got)}, want ${JSON.stringify(t.expect)}`);
    } else if (t.note !== undefined && note !== t.note) {
      failed++;
      console.error(`FAIL ${t.name}: body reads ${JSON.stringify(note)}, want ${JSON.stringify(t.note)}`);
    }
  }
  // Template i18n scan assertions: unlocalized prose and msg refs.
  const i18nSample = '<section><h1 data-text="{msg.hello}">Fallback</h1><p>Unlocalized prose</p><span aria-label="Missing key">★</span></section>';
  const { msgRefs, prose } = scanTemplateI18n(i18nSample, "sample", "sample.html");
  if (msgRefs.length !== 1 || msgRefs[0].key !== "hello") {
    failed++;
    console.error(`FAIL i18n scan: expected 1 msgRef ('hello'), got ${JSON.stringify(msgRefs)}`);
  }
  if (prose.length !== 2) {
    failed++;
    console.error(`FAIL i18n scan: expected 2 prose leaks (p and aria-label), got ${JSON.stringify(prose)}`);
  }

  if (failed > 0) Deno.exit(1);
  console.error(
    `derive self-test: ${notes.length + scans.length + maps.length + 1} derivation cases, ` +
      "the cel fixtures, the style scanner, the jessie scanner, the validation resolver, the reads and writes, the tree reader and the i18n template scanner passed",
  );
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    selfTest();
    Deno.exit(0);
  }
  await derive(Deno.args[0] ?? fail("usage: derive.ts <appDir> | --self-test"));
}
