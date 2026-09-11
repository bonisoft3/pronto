// The vendored vocabularies, read back as facts.
//
// A generator cannot be proven to have read a file. What can be proven is that
// the published vocabulary EQUALS the file, and that is a join — so the bytes
// enter the fact store beside the steps they are quoted into, and
// invariants.sql holds the two together per token. The chain is
// `vendored bytes -> cue export -> shell/design.css`, three tables and two
// joins, every hop a row-level rule whose message names one token.
//
// A tree is a directory under scales/ carrying source.json (what the bytes are
// and where they came from), admitted.json (which declared names this platform
// refuses, and why) and the stylesheets themselves, byte-for-byte from the
// archive source.json names. refresh.ts is the only thing that fetches; this
// pass only reads what is checked in.

import { fileURLToPath } from "node:url";
import { customProperties } from "./styles.ts";

/** Where a vocabulary's bytes came from. `url`/`integrity` describe the archive
 * refresh.ts re-fetches; a source that is this repository has neither. */
export type Source = {
  name: string;
  origin: string;
  version: string;
  license?: string;
  url?: string;
  integrity?: string;
  files: string[];
};

/** One declaration a vendored stylesheet makes, under the source that makes it.
 * Not deduplicated: upstream may redeclare a name under `prefers-color-scheme`,
 * and a rung has no appearance, so the second declaration is a fact this
 * platform must either quote or refuse rather than one to collapse away. */
export type VendorDeclaration = { source: string; token: string; value: string };

/** A tree's admitted.json: the buckets drawn from the archive, and the names refused. */
export type Admitted = {
  admit: { bucket: string; prefix: string; dimension: string; keys: string }[];
  refused: { pattern: string; reason: string }[];
};

/** A declared name this platform does not publish, and the argument for that.
 * `pattern` is a regular expression over the token name. */
export type VendorExclusion = { source: string; pattern: string; reason: string };

const SCALES = fileURLToPath(new URL("./scales/", import.meta.url));

/** One stylesheet's declarations under the source that makes them. Values are
 * collapsed the way scaleDeclarations collapses the published side, so the
 * quotation join compares values rather than whitespace. */
export function vendorDeclarationsOf(source: string, css: string): VendorDeclaration[] {
  return customProperties(css).map((d) => ({
    source,
    token: d.token,
    value: d.value.replace(/\s+/g, " ").trim(),
  }));
}

function fail(msg: string): never {
  throw new Error(`pronto scales: ${msg}`);
}

/**
 * Each archive entry in `files`, mapped to the name the tree keeps it under.
 *
 * `source.files` are the archive's own paths, so a version bump reads as a diff
 * against `tar tzf`; a vendor may nest them and the tree flattens to the
 * basename, because `dist` is ignored repo-wide and a vendored byte that is not
 * checked in is a quotation of nothing. Two entries sharing a basename would
 * overwrite one another, which raises rather than renames: a rule cannot be told
 * which of two files it is reading.
 */
export function vendoredNames(files: string[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Map<string, string>();
  for (const file of files) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const first = taken.get(name);
    if (first !== undefined) fail(`${first} and ${file} would both be vendored as ${name}`);
    taken.set(name, file);
    names.set(file, name);
  }
  return names;
}

/** The tree reader's own cases, wired to `derive.ts --self-test`. */
export function scalesSelfTest(): string[] {
  const failures: string[] = [];
  const nested = ["dist/css/base/typography/typography.css"];
  const flattened = [...vendoredNames(nested).values()];
  if (JSON.stringify(flattened) !== JSON.stringify(["typography.css"])) {
    failures.push(`scales: a nested archive path must vendor as its basename, got ${JSON.stringify(flattened)}`);
  }
  // The raise is what makes vendoring Primer's base ladder ALONE mechanical
  // rather than conventional: its two typography sheets flatten to one basename,
  // so the functional sheet's purpose names cannot be added beside the ladder
  // without editing this function. Silently, the second file would overwrite the
  // first and every quotation rule would read whichever bytes survived.
  let threw: string | null = null;
  try {
    vendoredNames([
      "dist/css/base/typography/typography.css",
      "dist/css/functional/typography/typography.css",
    ]);
  } catch (e) {
    threw = (e as Error).message;
  }
  const want = "pronto scales: dist/css/base/typography/typography.css and " +
    "dist/css/functional/typography/typography.css would both be vendored as typography.css";
  if (threw !== want) {
    failures.push(`scales: want the raise ${JSON.stringify(want)}, got ${JSON.stringify(threw)}`);
  }
  return failures;
}

async function readJson<T>(path: string): Promise<T> {
  const text = await Deno.readTextFile(path).catch(() => fail(`${path} does not open`));
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    return fail(`${path} does not parse: ${(e as Error).message}`);
  }
}

/** Every vendored tree checked in under scales/, by directory name. A directory
 * with no source.json is not a tree and is a hard error rather than a skip: the
 * whole point of the table below is that it cannot arrive short in silence. */
export async function vendoredTrees(): Promise<{ dir: string; source: Source }[]> {
  const trees: { dir: string; source: Source }[] = [];
  for await (const entry of Deno.readDir(SCALES)) {
    if (!entry.isDirectory) continue;
    const source = await readJson<Source>(`${SCALES}${entry.name}/source.json`);
    if (source.name === undefined || source.files === undefined) {
      fail(`${entry.name}/source.json states no name or no file list`);
    }
    trees.push({ dir: entry.name, source });
  }
  // A source NAME is the join key every quotation rule reaches the bytes
  // through, so two trees answering to one name put both archives' declarations
  // under it and the join degrades to the name-only one THE QUOTATION refuses.
  // This is the argument vendoredNames makes for two files inside a
  // tree, one scope up: a rule cannot be told which of two archives it is
  // reading. Keyed on the name and reported with both directories, because the
  // directory is what a reader has to go and look at.
  const byName = new Map<string, string>();
  for (const t of trees) {
    const held = byName.get(t.source.name);
    if (held !== undefined) {
      fail(`${held} and ${t.dir} both vendor a source named "${t.source.name}"; a name answers one archive`);
    }
    byName.set(t.source.name, t.dir);
  }
  return trees.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * What the vendored bytes declare and what this platform refuses of them, read
 * with the same parser `shell/design.css` is read back with — so the two sides
 * of the quotation join are read by one reader and a parser bug moves both.
 */
export async function readVendored(): Promise<{
  sources: Source[];
  declarations: VendorDeclaration[];
  exclusions: VendorExclusion[];
}> {
  const sources: Source[] = [];
  const declarations: VendorDeclaration[] = [];
  const exclusions: VendorExclusion[] = [];
  for (const { dir, source } of await vendoredTrees()) {
    sources.push(source);
    for (const [file, name] of vendoredNames(source.files)) {
      const css = await Deno.readTextFile(`${SCALES}${dir}/${name}`)
        .catch(() => fail(`${dir}/source.json names ${file}, which does not open`));
      declarations.push(...vendorDeclarationsOf(source.name, css));
    }
    const admitted = await readJson<Admitted>(
      `${SCALES}${dir}/admitted.json`,
    );
    for (const r of admitted.refused) {
      // Compiled here so a pattern DuckDB would reject is a derivation failure
      // naming the tree, rather than a query that yields no rows.
      new RegExp(r.pattern);
      exclusions.push({ source: source.name, pattern: r.pattern, reason: r.reason });
    }
  }
  return { sources, declarations, exclusions };
}
