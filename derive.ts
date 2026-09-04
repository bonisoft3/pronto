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

import { fileURLToPath } from "node:url";
import { parseFilterSpec } from "../omnishell/interpreter/fragment.js";
import type { ParsedExpr } from "./cel-emit.ts";
import { enumValues } from "./cel-emit.ts";
import { parseCel } from "./cel.ts";
import { celFixtures } from "./cel-fixtures.ts";
import { DENIED, jessieFacts, jessieSelfTest } from "./jessie.ts";
import { ownedTokens, styleSelfTest } from "./styles.ts";
import { celSites, renderCel, renderIr } from "./derive-cel.ts";
import { claims, irAccepts, irPaths, LEDGER } from "./acceptance.ts";
import { declarations, irIds, irRoutes, KINDS } from "./objects.ts";
import { irDiagrams } from "./diagrams.ts";
import {
  acceptanceFacts,
  artifactFacts,
  mergeFacts,
  jessieFactRows,
  styleFacts,
  bijectionFacts,
  celFacts,
  diagramFacts,
  type FactChart,
  programFacts,
  renderFacts,
} from "./facts.ts";
// The rules themselves live with the vocabulary they check — the terminal
// publishes its markup's grammar AND its grammar's rules (omnishell/lint.ts);
// this pass only walks an app's screens and applies them.
import {
  type Entity,
  kindedRegions,
  kindLint,
  type MachineRegion,
  machineRegions,
  machineWrites,
  parallelLint,
  focusLint,
  roveLint,
  stopRegions,
  scanScreen,
  slotRegions,
  type StopRegion,
  templateArity,
  unknownColumns,
  unwitnessedControls,
  unwitnessedSlot,
  type Write,
  writeLint,
  machineLint,
} from "../omnishell/interpreter/lint.ts";
import { machineShape } from "../omnishell/interpreter/fragment.js";

type Spec = { col: string; op: string; value?: string }[] | null;

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

  // The CEL derivation unifies back into the entities this export reads, and
  // a constraint the previous run derived would judge a row the current run's
  // cel admits — so the file is removed before the program is read, not after.
  await Deno.remove(`${appDir}/program_cel.cue`).catch(() => {});

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
    entities: Record<string, Entity>;
    ir: string;
    decisions: Record<string, string>;
    tests: Record<string, string[]>;
    paths: Record<string, Record<string, string[]>>;
    program: Record<string, unknown>;
  } = JSON.parse(new TextDecoder().decode(exported.stdout));
  const entities = exp.entities;
  const notes = await decisionNotes(appDir, exp.ir, exp.decisions);
  const byTable = new Map(Object.entries(entities).map(([name, e]) => [e.table, name]));
  for (const [ename, e] of Object.entries(entities)) {
    for (const u of e.uniques ?? []) {
      if (u.where !== undefined && parseFilterSpec(u.where) === null) {
        fail(`entity ${ename}: uniques "${u.name}" where "${u.where}" is outside the translatable fragment subset`);
      }
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

  // The app's declared Jessie modules, by basename: what a machine's value
  // positions may reference, and what tells an assign's reference from its
  // literals.
  const available = new Set<string>();
  try {
    for await (const f of Deno.readDir(`${appDir}/shell/handlers`)) {
      if (f.isFile && f.name.endsWith(".js")) available.add(f.name.slice(0, -".js".length));
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  const screens: { name: string; entities: string[]; handlers: string[] }[] = [];
  const machines: { screen: string; region: MachineRegion }[] = [];
  for await (const f of Deno.readDir(`${appDir}/shell/screens`)) {
    if (!f.isFile || !f.name.endsWith(".html")) continue;
    const name = f.name.slice(0, -".html".length);
    const html = await Deno.readTextFile(`${appDir}/shell/screens/${f.name}`);
    const { tables, handlers, filters } = scanScreen(html);
    const named = tables.map((t) =>
      byTable.get(t) ?? fail(`${name}.html reads "${t}", the table of no declared entity`)
    );
    for (const { table, filter } of filters) {
      const entity = entities[
        byTable.get(table) ?? fail(`${name}.html filters "${table}", the table of no declared entity`)
      ];
      const bad = unknownColumns(filter, entity.fields.map((f) => f.name));
      if (bad.length > 0) {
        fail(`${name}.html: data-filter="${filter}" names ${bad.join(", ")} — not fields of "${table}"`);
      }
    }
    for (const slot of slotRegions(html)) {
      const entity = entities[
        byTable.get(slot.table) ?? fail(`${name}.html reads "${slot.table}", the table of no declared entity`)
      ];
      const why = unwitnessedSlot(slot.filter, entity);
      if (why !== null) {
        fail(
          `${name}.html: slot region "${slot.table}" (filter ${JSON.stringify(slot.filter ?? "")}) ` +
            `may bind more than one row: ${why}`,
        );
      }
    }
    for (const kinded of kindedRegions(html)) {
      const ename = byTable.get(kinded.table) ??
        fail(`${name}.html reads "${kinded.table}", the table of no declared entity`);
      const why = kindLint(kinded.whens, entities[ename], enumsOf(ename));
      if (why !== null) fail(`${name}.html: region "${kinded.table}": ${why}`);
    }
    // A machine's leaves are handler modules like any other: its references
    // (and the assign strings that resolve) join the screen's derived
    // files.handlers so the loader can fetch them.
    const machineNames = new Set<string>();
    // Every machine region on the screen that writes the same table is judged
    // together: one region's spelling is only inconsistent against another's.
    const writes = new Map<string, Write[]>();
    let regions: MachineRegion[];
    try {
      regions = machineRegions(html);
    } catch (e) {
      fail(`${name}.html: ${(e as Error).message}`);
    }
    const grouped = new Set<string>();
    for (const region of regions) {
      let parsed: Parameters<typeof machineLint>[0];
      try {
        parsed = JSON.parse(region.machine);
      } catch {
        fail(`${name}.html: data-machine is not JSON`);
      }
      const why = machineLint(parsed, available);
      if (why !== null) fail(`${name}.html: data-machine: ${why}`);
      const shape = machineShape(parsed);
      for (const r of shape.refs) machineNames.add(r);
      for (const s of shape.assignStrings) if (available.has(s)) machineNames.add(s);
      if (region.emptyRow !== undefined && parsed.context !== undefined) {
        const row = JSON.parse(region.emptyRow);
        for (const [k, v] of Object.entries(parsed.context)) {
          if (k in row && row[k] !== v) {
            fail(
              `${name}.html: data-empty-row["${k}"] is ${JSON.stringify(row[k])} but the machine's ` +
                `context says ${JSON.stringify(v)} — one fact, two values`,
            );
          }
        }
      }
      writes.set(region.table, [
        ...(writes.get(region.table) ?? []),
        ...machineWrites(parsed, region.emptyRow),
      ]);
      // The group's own rule, run once per group rather than once per chart.
      const group = region.parallel.join("\u0000");
      if (region.parallel.length > 1 && !grouped.has(group)) {
        grouped.add(group);
        const why = parallelLint(region.parallel.map((c) => JSON.parse(c)));
        if (why !== null) fail(`${name}.html: region "${region.table}": ${why}`);
      }
      machines.push({ screen: name, region });
    }
    for (const [attr, rule] of [["data-rove", roveLint], ["data-focus", focusLint]] as const) {
      let stops: StopRegion[];
      try {
        stops = stopRegions(html, attr);
      } catch (e) {
        fail(`${name}.html: ${(e as Error).message}`);
      }
      const declared = (table: string) =>
        entities[byTable.get(table) ?? fail(`${name}.html reads "${table}", the table of no declared entity`)];
      for (const region of stops) {
        const why = rule(region, declared(region.table), region.outer === undefined ? undefined : declared(region.outer));
        if (why !== null) fail(`${name}.html: region "${region.table}": ${why}`);
      }
    }
    for (const [table, cols] of writes) {
      const entity = entities[
        byTable.get(table) ?? fail(`${name}.html reads "${table}", the table of no declared entity`)
      ];
      const why = writeLint(cols, entity);
      if (why !== null) fail(`${name}.html: region "${table}": ${why}`);
    }
    // After the machine rules: a control's cover depends on what its region's
    // machine answers, and an unparseable machine is that pass's finding.
    for (const why of templateArity(html)) fail(`${name}.html: ${why}`);
    for (const why of unwitnessedControls(html)) fail(`${name}.html: ${why}`);
    screens.push({ name, entities: [...new Set(named)].sort(), handlers: [...new Set([...handlers, ...machineNames])].sort() });
  }
  screens.sort((a, b) => (a.name < b.name ? -1 : 1));

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
      let parsed: { field: string; initial: string };
      try {
        parsed = JSON.parse(region.machine);
      } catch {
        die(`${screen}.html: data-machine is not JSON`);
      }
      const file = `.pronto/machine-${i}.json`;
      await Deno.writeTextFile(`${appDir}/${file}`, region.machine);
      files.push(file);
      if (region.emptyRow !== undefined) {
        const row = JSON.parse(region.emptyRow);
        if (row[parsed.field] !== parsed.initial) {
          die(
            `${screen}.html: data-empty-row["${parsed.field}"] is ${
              JSON.stringify(row[parsed.field])
            } but the machine's initial is "${parsed.initial}" — one fact, two values`,
          );
        }
      } else if (!((parseFilterSpec(region.filter) as Spec) ?? []).some((p) => p.col === "id" && p.op === "eq")) {
        die(`${screen}.html: a machine region with no data-empty-row must pin its id with an eq filter`);
      }
    }
    // Module-relative like the TS imports above, so a relocated appDir — a
    // nested app, a downstream consumer through the CUE module cache — vets
    // against the same published file the plugin ships.
    const machineCue = fileURLToPath(new URL("../omnishell/machine.cue", import.meta.url));
    const vet = await new Deno.Command("cue", {
      args: ["vet", "-d", "#Machine", machineCue, ...files],
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
  const shared = (await Promise.all(
    ["shell/shell.css", "shell/design.css"].map((f) => Deno.readTextFile(`${appDir}/${f}`).catch(() => "")),
  )).join("\n");
  const screenTokens: { path: string; tokens: Iterable<string> }[] = [];
  for (const s of screens) {
    const rel = `shell/screens/${s.name}.css`;
    const css = await Deno.readTextFile(`${appDir}/${rel}`).catch(() => null);
    if (css !== null) screenTokens.push({ path: rel, tokens: ownedTokens(css) });
  }

  // What each declared handler reaches for. Read here so the denylist is a
  // join rather than a scan repeated per file at lint.
  const modules: { path: string; references: string[]; completion: string }[] = [];
  for (const name of [...available].sort()) {
    const rel = `shell/handlers/${name}.js`;
    const src = await Deno.readTextFile(`${appDir}/${rel}`).catch(() => null);
    if (src !== null) modules.push({ path: rel, ...jessieFacts(src) });
  }

  // Hashed after every write above, so a derived file's row is what derive left
  // on disk and a source's row is what it read.
  const sha = async (path: string) => {
    const bytes = await Deno.readFile(`${appDir}/${path}`);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const artifacts: { path: string; sha256: string; derived: boolean }[] = [];
  for (const [path, derived] of [
    ["program.cue", false],
    [exp.ir, false],
    [LEDGER, false],
    [".pronto/cel.json", true],
    ["program_cel.cue", true],
    ["program_derived.cue", true],
  ] as [string, boolean][]) {
    artifacts.push({ path, sha256: await sha(path), derived });
  }

  await Deno.mkdir(`${appDir}/.pronto`, { recursive: true });
  await Deno.writeTextFile(
    `${appDir}/.pronto/facts.json`,
    renderFacts(mergeFacts(
      programFacts(entities, screens, charts),
      ledger,
      bijection,
      artifactFacts(artifacts),
      celFacts(sites, [...irs.keys()]),
      styleFacts(ownedTokens(shared), screenTokens),
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

  let failed = celFindings.length + styleFailures.length + jessieFailures.length;
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
      "the cel fixtures, the style scanner and the jessie scanner passed",
  );
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    selfTest();
    Deno.exit(0);
  }
  await derive(Deno.args[0] ?? fail("usage: derive.ts <appDir> | --self-test"));
}
