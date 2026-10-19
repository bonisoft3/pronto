import { basename, join } from "node:path";
import { entries } from "./missing.ts";
import { parseCel } from "./cel.ts";
import { celSites, type Entity, renderCel } from "./derive-cel.ts";
import { renderDerived, type ScreenProjection, terminalPath } from "./derive.ts";

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await new Deno.Command(command, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) {
    throw new Error(`${basename(command)} failed (${result.code}): ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout);
}

async function reading(fixture: string, pkg: string, expr: string): Promise<unknown> {
  const observer = join(fixture, ".storybook");
  await Deno.mkdir(observer, { recursive: true });
  await Deno.writeTextFile(join(observer, "corpus.cue"), `package corpus\nimport (\napp "bonisoft.org/apps/${basename(fixture)}:${pkg}"\n${expr.includes("pronto.") ? 'pronto "bonisoft.org/plugins/pronto"\n' : ""})\nreading: ${expr}\n`);
  return JSON.parse(await run("cue", ["export", ".", "-e", "reading", "--out", "json"], observer));
}

export async function prepareTerminalCorpus(fixture: string): Promise<void> {
  const source = await Deno.readTextFile(join(fixture, "program.cue"));
  const pkg = /^package (\w+)$/m.exec(source)?.[1];
  if (pkg === undefined) throw new Error("storybook corpus: program.cue names no package");
  const previous = await Deno.readTextFile(join(fixture, "program_derived.cue"));
  const suffix = previous.indexOf("\n_irNotes:");
  if (suffix < 0) throw new Error("storybook corpus: program_derived.cue has no metadata boundary");
  for (const name of ["program_cel.cue", "program_validations.cue"]) {
    try { await Deno.remove(join(fixture, name)); }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
  }
  const bootstrap = join(fixture, "storybook_bootstrap.cue");
  await Deno.writeTextFile(bootstrap, `package ${pkg}\ncode: surface: screens: [string]: charts: *[] | [..._]\n${previous.includes("@tag(derive,") ? "_deriving: true\n" : ""}`);
  const authored = await reading(fixture, pkg, "{markupReader: app.terminal.surface.markupReader, machineSchema: app.terminal.surface.machineSchema, entities: app.code.state.entities, screens: {for name, screen in app.code.surface.screens {(name): {files: screen.files, if screen.markup != _|_ {markup: screen.markup}}}}}") as {
    entities: Record<string, Entity>;
    screens: Record<string, { markup?: string; files: { html: string } }>;
    markupReader: string; machineSchema: string;
  };
  const sites = celSites(authored.entities);
  const parsed = new Map(sites.map((site) => [site.cel, parseCel(site.cel)]));
  await Deno.writeTextFile(join(fixture, "program_cel.cue"), renderCel(pkg, sites, parsed));
  for (const screen of Object.values(authored.screens)) {
    if (screen.markup === undefined) continue;
    const target = join(fixture, screen.files.html);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.writeTextFile(target, screen.markup);
  }
  const available = new Set<string>();
  for (const entry of await entries(join(fixture, "shell/handlers"))) {
    if (entry.isFile && entry.name.endsWith(".js")) available.add(entry.name.slice(0, -3));
  }
  const read = await run(Deno.execPath(), ["run", "--no-config", "--no-check", "--no-lock", "--allow-read=.", await terminalPath(authored.markupReader, fixture), "."], fixture);
  const projected = JSON.parse(read) as { screens: Record<string, ScreenProjection> };
  const charts: string[] = [];
  const screens = Object.entries(projected.screens).map(([name, screen]) => {
    const handlers = new Set(screen.handlers);
    for (const region of screen.machines) {
      for (const ref of region.refs) handlers.add(ref);
      for (const ref of region.assignStrings) if (available.has(ref)) handlers.add(ref);
      charts.push(region.machine);
      const chart = JSON.parse(region.machine) as { field: string; initial: string };
      if (region.emptyRow !== undefined) {
        const row = JSON.parse(region.emptyRow);
        if (row === null || typeof row !== "object" || Array.isArray(row) || row[chart.field] !== chart.initial) {
          throw new Error(`${name}.html: data-empty-row disagrees with the machine's initial`);
        }
      } else if (!(region.filterSpec ?? []).some((clause) => clause.col === "id" && clause.op === "eq")) {
        throw new Error(`${name}.html: a machine region with no data-empty-row must pin its id with an eq filter`);
      }
    }
    return { name, reads: screen.reads, writes: screen.writes, charts: screen.machines.map((region) => ({ table: region.table, field: (JSON.parse(region.machine) as { field: string }).field, writes: region.writes })), handlers: [...handlers].sort(), adapters: [...new Set(screen.adapters)].sort() };
  });
  if (charts.length) {
    await Deno.mkdir(join(fixture, ".pronto"), { recursive: true });
    const files = charts.map((_, index) => join(fixture, ".pronto", `storybook-chart-${index}.json`));
    for (const [index, chart] of charts.entries()) await Deno.writeTextFile(files[index], chart);
    await run("cue", ["vet", "-d", "#Machine", await terminalPath(authored.machineSchema, fixture), ...files], fixture);
    for (const file of files) await Deno.remove(file);
  }
  const derived = renderDerived(pkg, screens, available, [], []);
  const boundary = derived.indexOf("\n_irNotes:");
  if (boundary < 0) throw new Error("storybook corpus: derived screens have no metadata boundary");
  await Deno.writeTextFile(join(fixture, "program_derived.cue"), derived.slice(0, boundary) + previous.slice(suffix));
  await Deno.remove(bootstrap);
  // Imported code stays separate from its deployment roots. The storybook
  // never applies migrations, so this uses the canonical terminal config
  // without constructing the cluster's SQL or its package builder.
  const config = await reading(fixture, pkg, `(pronto.#shellConfig & {code: app.code, migrations: [], floors: app.terminal.capabilities.floors, hatch: app.terminal.capabilities.hatch, server: (pronto.#serverOn & {servers: [for _, entity in app.code.state.entities {entity.server}], auth: app.code.capabilities.auth != _|_}).out, native: app.code.capabilities.native}).out`);
  const bytes = JSON.stringify(config);
  await Deno.writeTextFile(join(fixture, "shell/shell.yaml"), bytes);
  await Deno.writeTextFile(join(fixture, "shell/shell.json"), bytes);
}

if (import.meta.main) {
  const app = Deno.args[0];
  if (app === undefined) throw new Error("usage: terminal-corpus.ts <appDir>");
  await prepareTerminalCorpus(app);
}
