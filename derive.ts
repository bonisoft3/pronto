// pronto derivation: reads and handler lists from screen markup, decision
// notes from the ir.
//
// A screen's markup already says which collections it reads (`data-live`,
// `data-reads`) and which Jessie modules it binds (`data-handler`,
// `data-on-*`); restating both in program.cue was two statements of one fact.
// This pass projects them out of the markup into program_derived.cue, which unifies
// into the program — so `cue export` stays the one source the emitter and the
// checkers read, and the markup is the authority.
//
// Derived per screen: `reads` as the SET of entities the markup touches
// (sorted, deduped, no filter/order/select — those live in the markup alone),
// and `files.handlers` as shell/handlers/<name>.js for every handler name.
// Screen names come from shell/screens/*.html; a stale html file for a screen
// the program no longer declares fails the export rather than deriving in
// silence.
//
// Derived per decision: `note`, the prose of the ir element the decision's
// `ir` names — so the ir, the artifact under review, is the authority, and
// program.cue names its decisions without restating them.

import type { ParsedExpr } from "./cel-emit.ts";
import { enumValues } from "./cel-emit.ts";
import { parseCel } from "./cel.ts";
import { celFixtures } from "./cel-fixtures.ts";
import { DENIED, jessieFacts, jessieSelfTest, splitCompletion } from "./jessie.ts";
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
import { claims, irAccepts, irPaths, LEDGER } from "./acceptance.ts";
import { declarations, irIds, irRoutes, KINDS } from "./objects.ts";
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
  celFacts,
  diagramFacts,
  type FactChart,
  programFacts,
  renderFacts,
  scaleFacts,
  sha256Hex,
} from "./facts.ts";
type Spec = { col: string; op: string; value?: string }[] | null;

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
};
type ScreenProjection = { tables: string[]; handlers: string[]; machines: MachineProjection[] };

/** The slice of a program's entity this pass reads off its own export; every
 * module it hands the entities to declares the slice it reads for itself. */
type Entity = {
  table: string;
  durability: string;
  fields: { name: string; type: string; cel?: string }[];
  invariant?: { cel: string };
};

import { quoteKey } from "./cue.ts";

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

export function renderDerived(
  pkg: string,
  screens: { name: string; entities: string[]; handlers: string[] }[],
  decisions: { id: string; note: string }[],
): string {
  const blocks = screens.map(({ name, entities, handlers }) => {
    const reads = entities.map((e) => `{entity: "${e}"}`).join(", ");
    const mods = handlers.map((h) => `"shell/handlers/${h}.js"`).join(", ");
    return `\t${quoteKey(name)}: {\n\t\treads: [${reads}]\n\t\tfiles: handlers: [${mods}]\n\t}`;
  });
  // JSON escapes are CUE escapes, and CUE reads `\(` as interpolation only
  // after a backslash JSON.stringify would have doubled.
  const notes = decisions.map(({ id, note }) => `\t${quoteKey(id)}: ${JSON.stringify(note)}`);
  // A pattern constraint, not concrete fields: this file supplies notes to the
  // decisions program.cue declares and declares none of its own.
  return `// generated by pronto from the ir and the screen markup — do not edit\npackage ${pkg}\n\ncode: surface: screens: {\n${
    blocks.join("\n")
  }\n}\n\n_irNotes: {\n${notes.join("\n")}\n}\n\ncode: meta: decisions: [Id=string]: note: _irNotes[Id]\n`;
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
  return Object.keys(irOf).sort().map((id) => {
    const body = bodies.get(irOf[id]);
    if (body === undefined) {
      throw new Error(`decision "${id}" has no element with id="${irOf[id]}" data-kind="decision"`);
    }
    try {
      return { id, note: decisionNote(body) };
    } catch (e) {
      throw new Error(`decision "${id}": ${(e as Error).message}`);
    }
  });
}

/** notesFor over the ir the program pins. */
async function decisionNotes(
  appDir: string,
  source: string,
  irOf: Record<string, string>,
): Promise<{ id: string; note: string }[]> {
  try {
    return notesFor(irDecisions(await Deno.readTextFile(`${appDir}/${source}`)), irOf);
  } catch (e) {
    fail(`${source}: ${(e as Error).message}`);
  }
}

/** Scan the app's screens and write program_derived.cue beside program.cue. */
export async function derive(appDir: string): Promise<void> {
  const program = await Deno.readTextFile(`${appDir}/program.cue`);
  const pkg = /^package (\w+)$/m.exec(program)?.[1] ?? fail(`${appDir}/program.cue names no package`);

  // Both derivations unify back into the entities this export reads, so a
  // constraint the previous run derived would judge a row the current run's
  // cel admits, and a module it split would be emitted for a source the
  // current run never read — the files go before the program is read.
  await Deno.remove(`${appDir}/program_cel.cue`).catch(() => {});
  await Deno.remove(`${appDir}/program_validations.cue`).catch(() => {});

  // One export, not one per question: cue dominates this loop, so a second
  // invocation costs more than everything else derivation does.
  const exported = await new Deno.Command("cue", {
    args: [
      "export",
      ".",
      "-e",
      "{entities: code.state.entities, ir: code.meta.ir.source, " +
        "decisions: {for k, v in code.meta.decisions {(k): v.ir}}, " +
        "tests: {for k, t in code.meta.tests {(k): t.accepts}}, " +
        "paths: {for k, s in code.surface.screens {(k): {for n, p in s.paths {(n): p.accepts}}}}, " +
        // Both sides of the literal rule's join, out of this one export, and the
        // shared stylesheets the emission itself carries. Read off disk instead, a missing or stale file
        // would yield an empty step set and a green lint. The checked-in copies are held equal to these by the
        // artifact hashes, so nothing is lost by grading the emission.
        "scale: out.scale, design: code.surface.design, " +
        "designCss: out.files[\"shell/design.css\"].text, " +
        "shellCss: out.files[\"shell/shell.css\"].text, " +
        "entry: out.terminal.surface.entry, " +
        // The terminal's own paths: what this pass spawns to read the markup,
        // and the published schema it vets each chart against.
        "markupReader: out.terminal.surface.markupReader, " +
        "machineSchema: out.terminal.surface.machineSchema, " +
        "statics: [for s in out.cluster.meta.statics {file: s.file, target: s.target}], " +
        "shared: {for k, s in code.surface.screens {(k): s.files.shared}}, " +
        "pendingLiterals: code.meta.design.pendingLiterals, " +
        // `program` rather than `code`: a field named for the value it holds would
        // shadow it inside the struct literal and export an incomplete `_`.
        "program: code}",
      "--out",
      "json",
    ],
    cwd: appDir,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!exported.success) fail("cue export of the entities, the ir source and the decision ids failed");
  const exp: {
    // The export carries a whole #Entity; each module declares the slice it
    // reads, and this pass reads both the lint slice and the validation one.
    entities: Record<string, Entity & VEntity>;
    ir: string;
    decisions: Record<string, string>;
    tests: Record<string, string[]>;
    paths: Record<string, Record<string, string[]>>;
    scale: Scale;
    design: Record<string, Record<string, string>>;
    designCss: string;
    shellCss: string;
    entry: string;
    markupReader: string;
    machineSchema: string;
    statics: { file: string; target: string }[];
    shared: Record<string, string[]>;
    pendingLiterals: number;
    program: Record<string, unknown>;
  } = JSON.parse(new TextDecoder().decode(exported.stdout));
  const entities = exp.entities;
  // `program` is exported whole, so the slices the table registry needs are
  // read off it rather than added to the expression above.
  const { surface, state } = exp.program as unknown as {
    surface: { screens: Record<string, { forms?: { id: string; entity: string }[] }> };
    state: { pipelines?: Record<string, { fold?: { pair: { table: string } } }> };
  };
  const notes = await decisionNotes(appDir, exp.ir, exp.decisions);
  const byTable = new Map(Object.entries(entities).map(([name, e]) => [e.table, name]));

  // A validation's module joins the handlers in `modules` below, so the
  // denylist and the completion rule reach it through the same fact rows.
  const TAG = "$validation$";
  const modules: { path: string; references: string[]; completion: string }[] = [];
  const validated: { entity: string; name: string; edges: ReturnType<typeof resolveEdges>; statements: string; completion: string }[] = [];
  for (const [ename, e] of Object.entries(entities)) {
    for (const [vname, v] of Object.entries(e.validations ?? {})) {
      const why = validationLint(entities, ename, vname);
      if (why !== null) fail(why);
      const src = await Deno.readTextFile(`${appDir}/${v.src}`).catch(() => null);
      if (src === null) fail(`entity ${ename}: validations "${vname}" src ${v.src} is not a file`);
      if (src.includes(TAG)) fail(`entity ${ename}: validations "${vname}": ${v.src} contains the quote tag ${TAG}`);
      const split = splitCompletion(src);
      if (split === null) fail(`entity ${ename}: validations "${vname}": ${v.src} must end in an arrow function`);
      const facts = jessieFacts(src);
      modules.push({ path: v.src, ...facts });
      // A handler's denied name is a fact row a query reports; a validation's
      // is a refusal here, because its source is embedded in a migration and
      // there is no later seat that would catch it.
      for (const name of facts.references) {
        fail(`entity ${ename}: validations "${vname}": ${v.src} reaches ${name} (${DENIED.find((d) => d.name === name)!.reason})`);
      }
      validated.push({ entity: ename, name: vname, edges: resolveEdges(entities, ename, v.via), ...split });
    }
  }

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
  try {
    for await (const f of Deno.readDir(`${appDir}/shell/handlers`)) {
      if (f.isFile && f.name.endsWith(".js")) available.add(f.name.slice(0, -".js".length));
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  // What the screens say, as the terminal reads them. Spawned like the export
  // above and from the same directory, so the path the program's terminal
  // declares is the path that resolves; --no-config because every module the
  // reader loads is a static import of its own.
  const read = await new Deno.Command("deno", {
    args: ["run", "--no-lock", "--no-check", "--no-config", "--allow-read=.", exp.markupReader, "."],
    cwd: appDir,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!read.success) fail(`${exp.markupReader} refused this app's markup`);
  const { screens: projected }: { screens: Record<string, ScreenProjection> } = JSON.parse(
    new TextDecoder().decode(read.stdout),
  );

  const screens: { name: string; entities: string[]; handlers: string[] }[] = [];
  const machines: { screen: string; region: MachineProjection }[] = [];
  for (const [name, screen] of Object.entries(projected)) {
    const named = screen.tables.map((t) =>
      byTable.get(t) ?? fail(`${name}.html reads "${t}", the table of no declared entity`)
    );
    // A machine's leaves are handler modules like any other: its references
    // (and the assign strings that resolve) join the screen's derived
    // files.handlers so the loader can fetch them.
    const machineNames = new Set<string>();
    for (const region of screen.machines) {
      for (const r of region.refs) machineNames.add(r);
      for (const s of region.assignStrings) if (available.has(s)) machineNames.add(s);
      machines.push({ screen: name, region });
    }
    screens.push({
      name,
      entities: [...new Set(named)].sort(),
      handlers: [...new Set([...screen.handlers, ...machineNames])].sort(),
    });
  }
  screens.sort((a, b) => (a.name < b.name ? -1 : 1));

  // The tables the terminal will register, in the set #shellConfig._tables
  // builds: every screen's reads, every form's entity, and each fold's private
  // pair. A validation's edge is read out of that registry at the store seat,
  // so an edge to a table outside it has no collection to read and the seat
  // would throw at the first write. The write of program_validations.cue waits
  // for this, so a refused derivation leaves no artifact for the emitter.
  const held = new Set<string>();
  for (const s of screens) for (const name of s.entities) held.add(entities[name].table);
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
    // fail() is Deno.exit, which runs no finally blocks — so every failure
    // path inside this block goes through die(), or the machine-*.json temps
    // outlive the run.
    const die: (msg: string) => never = (msg) => {
      for (const file of files) {
        try {
          Deno.removeSync(`${appDir}/${file}`);
        } catch { /* already gone */ }
      }
      return fail(msg);
    };
    for (const [i, { screen, region }] of machines.entries()) {
      // The reader refuses a data-machine that is not JSON, so a chart that
      // reaches this parses.
      const parsed = JSON.parse(region.machine) as {
        field: string;
        initial: string;
        context?: Record<string, unknown>;
      };
      const file = `.pronto/machine-${i}.json`;
      await Deno.writeTextFile(`${appDir}/${file}`, region.machine);
      files.push(file);
      if (region.emptyRow !== undefined) {
        const row = JSON.parse(region.emptyRow) as Record<string, unknown>;
        if (row[parsed.field] !== parsed.initial) {
          die(
            `${screen}.html: data-empty-row["${parsed.field}"] is ${
              JSON.stringify(row[parsed.field])
            } but the machine's initial is "${parsed.initial}" — one fact, two values`,
          );
        }
        for (const [k, v] of Object.entries(parsed.context ?? {})) {
          if (k in row && row[k] !== v) {
            die(
              `${screen}.html: data-empty-row["${k}"] is ${JSON.stringify(row[k])} but the machine's ` +
                `context says ${JSON.stringify(v)} — one fact, two values`,
            );
          }
        }
      } else if (!(region.filterSpec ?? []).some((p) => p.col === "id" && p.op === "eq")) {
        die(`${screen}.html: a machine region with no data-empty-row must pin its id with an eq filter`);
      }
    }
    const vet = await new Deno.Command("cue", {
      // The published #Machine, named by the terminal the program targets
      // rather than by a path into a plugin directory: a consumer keeping the
      // terminal elsewhere says where by unifying machineSchema, and vets
      // against the file it ships.
      args: ["vet", "-d", "#Machine", exp.machineSchema, ...files],
      cwd: appDir,
      stderr: "inherit",
    }).output();
    if (!vet.success) die("a data-machine does not fit the published #Machine");
    for (const file of files) await Deno.remove(`${appDir}/${file}`).catch(() => {});
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
  const irHtml = await Deno.readTextFile(`${appDir}/${exp.ir}`);
  let diagrams: { nodes: Parameters<typeof diagramFacts>[0]; edges: Parameters<typeof diagramFacts>[1] };
  let ledger: ReturnType<typeof acceptanceFacts>;
  try {
    diagrams = await irDiagrams(irHtml);
  } catch (e) {
    fail(`${exp.ir}: ${(e as Error).message}`);
  }
  try {
    ledger = acceptanceFacts(
      claims(await Deno.readTextFile(`${appDir}/${LEDGER}`)),
      irPaths(irHtml),
      irAccepts(irHtml),
      exp.tests,
      exp.paths,
    );
  } catch (e) {
    fail(`${LEDGER}: ${(e as Error).message}`);
  }
  await Deno.writeTextFile(`${appDir}/program_derived.cue`, renderDerived(pkg, screens, notes));

  let bijection: ReturnType<typeof bijectionFacts>;
  try {
    bijection = bijectionFacts(KINDS, irIds(irHtml), irRoutes(irHtml), declarations(exp.program), exp.program);
  } catch (e) {
    fail(`${exp.ir}: ${(e as Error).message}`);
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
  for (const rel of [...screens.map((s) => `shell/screens/${s.name}.css`), ...[...sharedPaths].sort()]) {
    appCss.push({ path: rel, css: await Deno.readTextFile(`${appDir}/${rel}`).catch(() => fail(`${rel} does not open`)) });
  }
  const scanned = appCss.map(({ path, css }) => ({ path, ...scanStylesheet(css) }));
  const appTokens = scanned.map(({ path, tokens }) => ({ path, tokens }));
  const literals = scanned.map(({ path, literals, exceptions }) => ({ path, literals, exceptions }));
  // Where each stylesheet's imports resolve from. A screen's CSS is injected as
  // a <style> in the document, so an @import in it resolves against the
  // document's directory (#Screen.files.shared says so, and is what makes
  // `shared/screen.css` the spelling); a shared sheet is reached as a stylesheet
  // in its own right, so its own served directory is the base.
  const servedAt = new Map(exp.statics.map((s) => [s.file, s.target]));
  const servedDir = (file: string): string => {
    const target = servedAt.get(file) ??
      fail(`${file} is read as a stylesheet and served nowhere, so nothing can reach it`);
    return target.slice(0, target.lastIndexOf("/"));
  };
  const documentDir = servedDir(exp.entry);
  const imports = resolveImports([
    ...appCss.map((s) => ({ ...s, base: sharedPaths.has(s.path) ? servedDir(s.path) : documentDir })),
    { path: "shell/design.css", css: exp.designCss, base: documentDir },
    { path: "shell/shell.css", css: exp.shellCss, base: documentDir },
  ]);

  // What each declared handler reaches for. Read here so the denylist is a
  // join rather than a scan repeated per file at lint.
  for (const name of [...available].sort()) {
    const rel = `shell/handlers/${name}.js`;
    const src = await Deno.readTextFile(`${appDir}/${rel}`).catch(() => null);
    if (src !== null) modules.push({ path: rel, ...jessieFacts(src) });
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
    ["DESIGN.md", false],
    [exp.ir, false],
    [LEDGER, false],
    [".pronto/cel.json", true],
    ["program_cel.cue", true],
    ["program_derived.cue", true],
    ...(validated.length > 0 ? [["program_validations.cue", true]] : []),
  ] as [string, boolean][]) {
    artifacts.push({ path, sha256: await sha(path), derived });
  }
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
  artifacts.push({ path: "shell/design.css", sha256: await sha("shell/design.css"), derived: true });

  await Deno.mkdir(`${appDir}/.pronto`, { recursive: true });
  await Deno.writeTextFile(
    `${appDir}/.pronto/facts.json`,
    renderFacts(mergeFacts(
      programFacts(entities, screens, charts),
      ledger,
      bijection,
      artifactFacts(artifacts),
      celFacts(sites, [...irs.keys()]),
      styleFacts(ownedTokens(shared), appTokens),
      literalFacts(scaleSteps(exp.scale, exp.design), literals, EXCEPTION_REASONS, exp.pendingLiterals),
      scaleFacts(scaleSources(exp.scale), scaleDeclarations(exp.scale)),
      designCssFacts(tokenDeclarations(exp.designCss)),
      importFacts(exp.statics, imports),
      jessieFactRows(DENIED, modules),
      { enum_value },
      diagramFacts(diagrams.nodes, diagrams.edges),
    )),
  );

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
  const rendered = renderDerived("p", [], [{ id: "decision\\blob", note: 'a "q" and a \\ and \\(x)' }]);
  const wantKey = '\t"decision\\\\blob": "a \\"q\\" and a \\\\ and \\\\(x)"';
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
  if (failed > 0) Deno.exit(1);
  console.error(
    `derive self-test: ${notes.length + scans.length + maps.length + 1} derivation cases, ` +
      "the cel fixtures, the style scanner, the jessie scanner, the validation resolver and the tree reader passed",
  );
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    selfTest();
    Deno.exit(0);
  }
  await derive(Deno.args[0] ?? fail("usage: derive.ts <appDir> | --self-test"));
}
