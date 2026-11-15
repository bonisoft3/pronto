// A kinetic engine's module graph, linked at build time: each module of it
// precompiled by Endo's own ModuleSource into the record the terminal's SES
// Compartment imports (omnishell's interpreter/jessie.js evaluateEngine), so
// the browser links real ES modules with no parser of its own. Why Endo's
// precompile and not a runtime parser or a linker of ours is pronto's
// docs/decisions/2026-10-23-jessie-import.md.
import { join, posix } from "node:path";
import { DENIED, jessieFacts } from "./jessie.ts";

/** The pin: the module-source release cut beside the SES the terminal vendors
 * (omnishell's bundle:ses), whose Compartment reads the records it writes. */
const MODULE_SOURCE = "npm:@endo/module-source@1.4.0";

// The #Jessie path a module of the graph must have, as schema.cue spells it.
const JESSIE_PATH = /^([a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/;

/** A precompiled module record, as ModuleSource serialises it. */
export type ModuleRecord = {
  imports: string[];
  exports: string[];
  reexports: string[];
  __syncModuleProgram__: string;
  __needsImport__: boolean;
  __needsImportMeta__: boolean;
  [field: string]: unknown;
};

/** What the terminal imports: the entry's key and every module by the key its
 * importers resolve to, the app-relative path with a leading `./`. */
export type EngineGraph = { entry: string; modules: Record<string, ModuleRecord> };

export class LinkError extends Error {}

const key = (path: string) => `./${path}`;

/**
 * The graph `src` reaches, each module scanned in the engine's cage on its own.
 * A specifier is a relative literal path to a .js file of the app; a module
 * that reaches a denied name, imports dynamically or reads import.meta fails
 * the link, naming itself. Cycles are what ES modules make of them.
 */
export async function linkEngine(appDir: string, src: string): Promise<EngineGraph> {
  const { entry, modules } = await linkModules(appDir, src, "an engine", (path, text) => {
    const references = jessieFacts(text, "engine").references;
    if (references.length > 0) {
      const name = references[0];
      throw new LinkError(`${path} reaches ${name} (${DENIED.find((d) => d.name === name)?.reason ?? "an engine is endowed with nothing"})`);
    }
  });
  return { entry, modules };
}

/** A graph as linkModules walks it: each module's record and its text. */
export type ModuleGraph = EngineGraph & { sources: Record<string, string> };

/**
 * The graph `src` reaches by static relative imports, `scan` handed each
 * module's text before it is compiled; `who` names the graph's owner in a
 * refusal. Shared by an engine's link and an effect handler's bundle
 * (effect-bundle.ts), so both refuse the same specifiers the same way.
 */
export async function linkModules(appDir: string, src: string, who: string, scan: (path: string, text: string) => void = () => {}): Promise<ModuleGraph> {
  const { ModuleSource } = await import(MODULE_SOURCE);
  const modules: Record<string, ModuleRecord> = {};
  const sources: Record<string, string> = {};
  const pending = [src];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (modules[key(path)] !== undefined) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(join(appDir, path));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) throw new LinkError(`${path} is not a file of the app`);
      throw e;
    }
    scan(path, text);
    let record: ModuleRecord;
    try {
      record = JSON.parse(JSON.stringify(new ModuleSource(text, path)));
    } catch (e) {
      throw new LinkError(`${path}: ${(e as Error).message}`);
    }
    if (record.__needsImport__) throw new LinkError(`${path} imports dynamically: ${who}'s modules are linked before it runs`);
    if (record.__needsImportMeta__) throw new LinkError(`${path} reads import.meta: ${who} knows nothing of where it is served`);
    modules[key(path)] = record;
    sources[key(path)] = text;
    for (const specifier of record.imports) pending.push(resolveSpecifier(path, specifier, who));
  }
  return { entry: key(src), modules, sources };
}

/** The app-relative path `specifier` names from `referrer`, or a LinkError. */
export function resolveSpecifier(referrer: string, specifier: string, who = "an engine"): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new LinkError(`${referrer} imports "${specifier}": ${who} imports its own modules by relative path, never a package or a URL`);
  }
  const path = posix.normalize(posix.join(posix.dirname(referrer), specifier));
  if (path.startsWith("..") || posix.relative(".", path).startsWith("..")) {
    throw new LinkError(`${referrer} imports "${specifier}", which leaves the app`);
  }
  if (!JESSIE_PATH.test(path)) throw new LinkError(`${referrer} imports "${specifier}", which is no Jessie module path (${path})`);
  return path;
}
