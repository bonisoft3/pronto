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
  const { ModuleSource } = await import(MODULE_SOURCE);
  const modules: Record<string, ModuleRecord> = {};
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
    const references = jessieFacts(text, "engine").references;
    if (references.length > 0) {
      const name = references[0];
      throw new LinkError(`${path} reaches ${name} (${DENIED.find((d) => d.name === name)?.reason ?? "an engine is endowed with nothing"})`);
    }
    let record: ModuleRecord;
    try {
      record = JSON.parse(JSON.stringify(new ModuleSource(text, path)));
    } catch (e) {
      throw new LinkError(`${path}: ${(e as Error).message}`);
    }
    if (record.__needsImport__) throw new LinkError(`${path} imports dynamically: an engine's modules are linked before it runs`);
    if (record.__needsImportMeta__) throw new LinkError(`${path} reads import.meta: an engine knows nothing of where it is served`);
    modules[key(path)] = record;
    for (const specifier of record.imports) pending.push(resolveSpecifier(path, specifier));
  }
  return { entry: key(src), modules };
}

/** The app-relative path `specifier` names from `referrer`, or a LinkError. */
export function resolveSpecifier(referrer: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new LinkError(`${referrer} imports "${specifier}": an engine imports its own modules by relative path, never a package or a URL`);
  }
  const path = posix.normalize(posix.join(posix.dirname(referrer), specifier));
  if (path.startsWith("..") || posix.relative(".", path).startsWith("..")) {
    throw new LinkError(`${referrer} imports "${specifier}", which leaves the app`);
  }
  if (!JESSIE_PATH.test(path)) throw new LinkError(`${referrer} imports "${specifier}", which is no Jessie module path (${path})`);
  return path;
}
