// A `cue vet` that passed, remembered by its inputs, so a change re-vets only what it changed.
//
// Every app's lint runs `cue vet -c ./...`, and the same CUE is vetted again and again: in the
// worktree's gate, on each ci runner that checks the pull request, on main after it merges, and in
// every other pull request that touched none of it. For a large spec that is one 20 GB evaluation of
// several minutes each time (aprende, 2026-11-07: 343 % CPU and 20 GB for 5+ minutes per lint).
// CUE is declarative: a vet's answer is a function of what it reads, nothing else. So a vet is cut
// into its packages, each keyed by exactly what vetting it reads, and a package whose key passed
// before, anywhere on this machine, is not evaluated again. Only the packages a change reaches are.
//
//   deno run -A vetted.ts plan <cue> <args...>
//     exits 1 when the vet can't be keyed (it then runs as asked). Otherwise prints, for what has not
//     passed with these inputs, `run <arg>` lines (the arguments to vet it with), `key <key>` lines and
//     `skipped <n>` (the packages that passed before) and `saved <seconds>` (what their evaluations took,
//     as stored with their keys); when everything passed before, only those two lines (no `key`).
//   deno run -A vetted.ts record <cue> <args...> < keys
//     after the vet ran with those arguments and passed: records each key read on stdin that is still
//     the key of what was vetted (an input changed while it ran records nothing for it). With
//     CUE_RUN_SECS (the seconds the vet took), each key's file holds that divided by the keys it records.
//
// A unit is a package when the arguments are `vet`, the flags -c/--concrete/-E/--all-errors, and
// package folders (`.`, `./x`, `./...`, which takes every folder below with CUE in it, less those whose
// name starts with `.` or `_`, cue.mod and node_modules, as cue's own `./...` does). Any other vet
// (a file, a data file, an expression) is one unit, keyed by the whole module. A package's key, the
// SHA-256 of these lines:
// - `file <path> <sha256>` for every .cue file of the package's folder and those of each folder above
//   it up to the module's root that name the same package (a CUE package takes its name's files from
//   its parent folders too), and the same for every package of the module it imports, transitively;
// - `file <path> <sha256>` for every file an `@embed(file=...)` or `@embed(glob=...)` in those names
//   (a glob's matches as listed now, so a file added or gone changes the key);
// - `file <path> <sha256>` for every file under cue.mod (the module's version, its dependencies' pins,
//   vendored packages): an import from outside the module is held by these;
// - `unit <folder>` (from the module's root) and `flag <flag>` for each flag;
// - `cue <path> <size> <mtime>`: the binary that vets (its install path names its version);
// - `env <name>=<value>` for CUE_EXPERIMENT, CUE_REGISTRY and CUE_DEBUG.
// The whole-module unit hashes every .cue file in the module, their embeds, each argument (and a file
// one names) and the working folder instead. Anything it cannot read the same way twice gives no key and
// the vet runs: no module root, `-` (stdin), `-T`/`--inject-vars`, an @embed it does not understand.
// A failed vet records nothing, so it runs again until it passes. CUE_VETTED_LINES=1 prints each
// key's lines to stderr.
//
// Kept in ~/.cache/pronto/cue-vetted/<key> (CUE_VETTED_DIR), one small file per key (the seconds its
// evaluation took, a share of its run's: what a hit saves, logged by the wrapper), shared by every
// checkout on the machine (the worktrees, the ci and cd runners, all one user). Keys older than 30
// days go when a new one is recorded.

import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const dir = Deno.env.get("CUE_VETTED_DIR") ??
  join(Deno.env.get("HOME") ?? Deno.env.get("TMPDIR") ?? "/tmp", ".cache/pronto/cue-vetted");

class Unkeyable extends Error {}

const hashes = new Map<string, string>();
function sha256(path: string): string {
  let h = hashes.get(path);
  if (h === undefined) {
    try {
      h = createHash("sha256").update(Deno.readFileSync(path)).digest("hex");
    } catch {
      h = "absent";
    }
    hashes.set(path, h);
  }
  return h;
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function moduleRoot(from: string): string | undefined {
  for (let d = from; ; d = dirname(d)) {
    if (isFile(join(d, "cue.mod", "module.cue"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

// A folder's entries. cue reads a symlinked file as the file it points to, which the key would not
// see change: a symlinked .cue file (or any under cue.mod, or an embedded one) makes the vet unkeyable.
// A symlinked folder is passed over, as cue's ./... passes it over.
function entries(d: string, anyFile = false): Deno.DirEntry[] {
  let all: Deno.DirEntry[];
  try {
    all = [...Deno.readDirSync(d)];
  } catch {
    return [];
  }
  for (const e of all) {
    if (e.isSymlink && (anyFile || e.name.endsWith(".cue")) && !isDir(join(d, e.name))) {
      throw new Unkeyable(`symlink ${join(d, e.name)}`);
    }
  }
  return all.filter((e) => !e.isSymlink);
}

// The .cue files directly in a folder.
function cueIn(d: string): string[] {
  return entries(d).filter((e) => e.isFile && e.name.endsWith(".cue")).map((e) => join(d, e.name)).sort();
}

// Every file under a folder (cue.mod), or every .cue file (the module); .git skipped.
function walk(d: string, onlyCue: boolean, out: string[] = []): string[] {
  for (const e of entries(d, !onlyCue)) {
    const p = join(d, e.name);
    if (e.isDirectory) {
      if (e.name !== ".git") walk(p, onlyCue, out);
    } else if (e.isFile && (!onlyCue || e.name.endsWith(".cue"))) out.push(p);
  }
  return out;
}

// The folders `./...` takes below d, as cue's own ./... does: one that holds a .cue file with a package
// clause that cue builds with no tags (see built: a folder of only `@if(x)` files, or only package-less
// files, is no package); not a folder whose name starts with `.` or `_`, nor
// testdata, nor cue.mod, nor another module (a folder with its own cue.mod). node_modules is walked,
// as cue walks it.
const NOTAGS = new Set<string>();

function packagesBelow(d: string, top = true, out: string[] = []): string[] {
  if (!top && isDir(join(d, "cue.mod"))) return out;
  if (cueIn(d).some((f) => packageOf(f) !== undefined && built(f, NOTAGS))) out.push(d);
  for (const e of entries(d)) {
    if (!e.isDirectory || /^[._]/.test(e.name) || e.name === "cue.mod" || e.name === "testdata") continue;
    packagesBelow(join(d, e.name), false, out);
  }
  return out;
}

// Whether cue builds a file with these tags: its `@if(expr)` attributes before the package clause all hold
// (an identifier is true when `-t <it>` was given; !, &&, || and parentheses as in CUE). An expression this
// does not read counts the file in, which can only make a key include more than cue reads, never less.
function built(file: string, tags: Set<string>): boolean {
  const text = source(file).replace(/\/\/[^\n]*/g, "");
  const pkg = /^\s*package\s/m.exec(text);
  for (const m of (pkg ? text.slice(0, pkg.index) : text).matchAll(/@if\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
    if (holds(m[1], tags) === false) return false;
  }
  return true;
}

function holds(expr: string, tags: Set<string>): boolean | undefined {
  const toks = expr.match(/\s*(&&|\|\||!|\(|\)|[A-Za-z_$#][\w$#]*|\S)/g)?.map((t) => t.trim()) ?? [];
  let i = 0;
  const or = (): boolean | undefined => {
    let v = and();
    while (toks[i] === "||") { i++; const r = and(); v = v === undefined || r === undefined ? undefined : v || r; }
    return v;
  };
  const and = (): boolean | undefined => {
    let v = not();
    while (toks[i] === "&&") { i++; const r = not(); v = v === undefined || r === undefined ? undefined : v && r; }
    return v;
  };
  const not = (): boolean | undefined => {
    if (toks[i] === "!") { i++; const v = not(); return v === undefined ? undefined : !v; }
    if (toks[i] === "(") { i++; const v = or(); if (toks[i++] !== ")") return undefined; return v; }
    const t = toks[i++];
    return t !== undefined && /^[A-Za-z_$#][\w$#]*$/.test(t) ? tags.has(t) : undefined;
  };
  const v = or();
  return i === toks.length ? v : undefined;
}

const sources = new Map<string, string>();
function source(file: string): string {
  let s = sources.get(file);
  if (s === undefined) {
    s = Deno.readTextFileSync(file);
    sources.set(file, s);
  }
  return s;
}

// The files an @embed in this file names. CUE's embed reads a file or a glob relative to the file's
// own folder, within the module; its glob has no `**`.
function embeds(file: string, root: string): string[] {
  const text = source(file);
  const out: string[] = [];
  for (const m of text.matchAll(/@embed\(([^)]*)\)/g)) {
    const arg = /^\s*(file|glob)\s*=\s*"([^"]+)"\s*(,\s*type\s*=\s*\w+\s*)?$/.exec(m[1]);
    if (!arg) {
      // A comment that mentions @embed( is not an embed; anything else unknown is no key.
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
      if (line.includes("//")) continue;
      throw new Unkeyable(`@embed(${m[1]}) in ${file}`);
    }
    const target = resolve(dirname(file), arg[2]);
    if (relative(root, target).startsWith("..")) throw new Unkeyable(`@embed outside the module: ${file}`);
    if (arg[1] === "file") {
      try {
        if (Deno.lstatSync(target).isSymlink) throw new Unkeyable(`symlink ${target}`);
      } catch (e) {
        if (e instanceof Unkeyable) throw e;
      }
      out.push(target);
      continue;
    }
    const folder = dirname(target), pattern = target.slice(folder.length + 1);
    if (/[*?[\]{}]/.test(folder) || pattern.includes("**")) throw new Unkeyable(`@embed glob ${arg[2]} in ${file}`);
    const re = new RegExp(
      "^" + pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$",
    );
    out.push(...entries(folder, true).filter((e) => e.isFile && re.test(e.name)).map((e) => join(folder, e.name)).sort());
  }
  return out;
}

// The import paths of a file: `import "p"`, `import x "p"`, and the same inside `import ( ... )`.
function imports(file: string): string[] {
  const text = source(file).replace(/\/\/[^\n]*/g, "");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*\(([^)]*)\)/g)) {
    for (const p of m[1].matchAll(/"([^"]+)"/g)) out.push(p[1]);
  }
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?:[\w$#]+\s+)?"([^"]+)"/g)) out.push(m[1]);
  // `mod@v0/x:pkg` names the folder `mod/x`: its package qualifier and major version are not path.
  return out.map((p) => p.replace(/:[\w$#]+$/, "").replace(/@v\d+(?=\/|$)/, ""));
}

// A file's package clause, the first `package x` outside comments; undefined when there is none.
function packageOf(file: string): string | undefined {
  return /^\s*package\s+([\w$#]+)/m.exec(source(file).replace(/\/\/[^\n]*/g, ""))?.[1];
}

function modulePath(root: string): string {
  const m = /^\s*module:\s*"([^"]+)"/m.exec(source(join(root, "cue.mod", "module.cue")));
  if (!m) throw new Unkeyable("no module path in cue.mod/module.cue");
  return m[1].replace(/@v\d+$/, "");
}

function finish(lines: string[]): string {
  const files = lines.filter((l) => l.startsWith("file ")).sort();
  const rest = lines.filter((l) => !l.startsWith("file "));
  const all = [...new Set(files), ...rest];
  if (Deno.env.get("CUE_VETTED_LINES")) console.error(all.join("\n") + "\n");
  return createHash("sha256").update(all.join("\n")).digest("hex");
}

function tail(cue: string): string[] {
  const st = Deno.statSync(cue);
  return [
    `cue ${Deno.realPathSync(cue)} ${st.size} ${st.mtime?.getTime()}`,
    ...["CUE_EXPERIMENT", "CUE_REGISTRY", "CUE_DEBUG"].map((v) => `env ${v}=${Deno.env.get(v) ?? ""}`),
  ];
}

type Unit = { key: string; arg?: string };

const VET_FLAGS = new Set(["-c", "--concrete", "-E", "--all-errors"]);
// export's flags this reads: those taking a value (its tags, the expression, the format, the package),
// and plain ones that change only how the result is printed.
const EXPORT_VALUE = new Set(["-t", "--inject", "-e", "--expression", "--out", "-p", "--package"]);
const EXPORT_PLAIN = new Set(["-E", "--all-errors", "--escape", "--list"]);

// The units of a vet (its packages) or an export (one unit), each with its key; undefined when it can't
// be keyed. An export's output goes to stdout: one that writes a file (-o) is not keyed.
function units(cue: string, args: string[]): Unit[] | undefined {
  const verb = args[0];
  if (verb !== "vet" && verb !== "export") return undefined;
  const rest = args.slice(1);
  if (rest.some((a) => a === "-" || a === "-T" || a === "--inject-vars" || a.startsWith("--inject-vars="))) {
    return undefined;
  }
  // The arguments as flags (each with its value) and positionals; whether each flag is one this reads.
  const flags: string[] = [], pkgArgs: string[] = [], tags = new Set<string>();
  let known = true;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("-")) {
      // A `json:data.txt` names a file cue reads through a qualifier the key would not see.
      if (/^[A-Za-z+]+:/.test(a) && !isFile(resolve(Deno.cwd(), a)) && !isDir(resolve(Deno.cwd(), a))) return undefined;
      pkgArgs.push(a);
      continue;
    }
    if (verb === "export" && /^(-o|--outfile)/.test(a)) return undefined; // -o, -oout.json, --outfile=x: cue writes a file
    const [f, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (verb === "export" && EXPORT_VALUE.has(f)) {
      const v = inline ?? rest[++i];
      if (v === undefined) return undefined;
      flags.push(`${f} ${v}`);
      if ((f === "-t" || f === "--inject") && !v.includes("=")) tags.add(v);
    } else {
      flags.push(a);
      if (!(verb === "vet" ? VET_FLAGS : EXPORT_PLAIN).has(a)) known = false;
    }
  }
  const cwd = Deno.cwd();
  const root = moduleRoot(cwd);
  if (!root) return undefined;
  const name = (p: string) => relative(root, p) || ".";
  const fileLine = (p: string) => `file ${relative(root, p).startsWith("..") ? p : name(p)} ${sha256(p)}`;
  const modLines = walk(join(root, "cue.mod"), false).map(fileLine);

  try {
    const perPackage = known && pkgArgs.length > 0 &&
      pkgArgs.every((a) => a === "./..." || ((a === "." || a.startsWith("./")) && isDir(resolve(cwd, a)))) &&
      (verb === "vet" || (pkgArgs.length === 1 && pkgArgs[0] !== "./..."));
    if (!perPackage) {
      const lines = [`verb ${verb}`, ...modLines];
      for (const f of walk(root, true)) lines.push(fileLine(f), ...embeds(f, root).map(fileLine));
      for (const a of rest) {
        lines.push(`arg ${a}`);
        const p = isAbsolute(a) ? a : resolve(cwd, a);
        if (isFile(p)) lines.push(fileLine(p));
      }
      lines.push(`cwd ${name(cwd)}`, ...tail(cue));
      return [{ key: finish(lines) }];
    }

    const mod = modulePath(root);
    const pkgs = new Set<string>();
    for (const a of pkgArgs) {
      if (a === "./...") packagesBelow(cwd).forEach((p) => pkgs.add(p));
      else pkgs.add(resolve(cwd, a));
    }
    // A package's own files: its folder's, and those of its parents up to the root that name the same
    // package (a file whose package clause can't be read is counted wherever it is).
    const own = (d: string): string[] => {
      const out = cueIn(d).filter((f) => built(f, tags));
      const names = new Set(out.map(packageOf));
      for (let p = d; p !== root && dirname(p) !== p;) {
        p = dirname(p);
        out.push(...cueIn(p).filter((f) => {
          const n = packageOf(f);
          return (n === undefined || names.has(n) || names.has(undefined)) && built(f, tags);
        }));
      }
      return out;
    };
    // Its lines: its own files, their embeds, and the same for every module package it imports.
    const closure = new Map<string, string[]>();
    const linesOf = (d: string): string[] => {
      const seen = new Set<string>();
      const lines: string[] = [];
      const visit = (p: string) => {
        if (seen.has(p)) return;
        seen.add(p);
        let mine = closure.get(p);
        if (!mine) {
          mine = [];
          for (const f of own(p)) mine.push(fileLine(f), ...embeds(f, root).map(fileLine));
          closure.set(p, mine);
        }
        lines.push(...mine);
        for (const f of own(p)) {
          for (const i of imports(f)) {
            if (i === mod || i.startsWith(mod + "/")) {
              const target = join(root, i.slice(mod.length));
              if (!isDir(target)) throw new Unkeyable(`import ${i} has no folder`);
              visit(target);
            }
          }
        }
      };
      visit(d);
      return lines;
    };
    if (pkgs.size === 0) return undefined; // cue says "matched no packages": let it
    return [...pkgs].sort().map((d) => {
      const rel = relative(cwd, d);
      return {
        key: finish([`verb ${verb}`, ...linesOf(d), ...modLines, `unit ${name(d)}`, ...flags.map((f) => `flag ${f}`), ...tail(cue)]),
        arg: rel === "" ? "." : rel.startsWith("..") ? d : "./" + rel,
      };
    });
  } catch (e) {
    if (e instanceof Unkeyable) return undefined;
    throw e;
  }
}

const passed = (k: string) => isFile(join(dir, k));
// The seconds a kept entry's evaluation took (its file's text; 0 when empty or unknown).
const secsIn = (p: string) => {
  try {
    return Number.parseFloat(Deno.readTextFileSync(p)) || 0;
  } catch {
    return 0;
  }
};
const runSecs = () => Number(Deno.env.get("CUE_RUN_SECS")) || 0;

// Files older than 30 days go, and an export cache over its size (CUE_EXPORTED_GB, 8) loses its oldest.
// An entry's `<key>.secs` (the seconds its evaluation took) goes with it and is no entry of its own.
function prune(d: string, capBytes = Infinity) {
  const old = Date.now() - 30 * 86400_000;
  const kept: { p: string; t: number; n: number }[] = [];
  const secs: string[] = [];
  const gone = new Set<string>();
  for (const e of Deno.readDirSync(d)) {
    const p = join(d, e.name);
    if (e.name.endsWith(".secs")) {
      secs.push(p);
      continue;
    }
    try {
      const st = Deno.statSync(p);
      const t = st.mtime?.getTime() ?? 0;
      if (t < old || (e.name.includes(".tmp-") && t < Date.now() - 86400_000)) {
        Deno.removeSync(p);
        gone.add(p);
      } else if (!e.name.includes(".tmp-")) kept.push({ p, t, n: st.size });
    } catch { /* another checkout pruned it */ }
  }
  let total = kept.reduce((a, k) => a + k.n, 0);
  for (const k of kept.sort((a, b) => a.t - b.t)) {
    if (total <= capBytes) break;
    try {
      Deno.removeSync(k.p);
      gone.add(k.p);
      total -= k.n;
    } catch { /* gone */ }
  }
  for (const s of secs) {
    const entry = s.slice(0, -".secs".length);
    if (gone.has(entry) || !isFile(entry)) {
      try {
        Deno.removeSync(s);
      } catch { /* gone */ }
    }
  }
}

const exported = Deno.env.get("CUE_EXPORTED_DIR") ??
  join(Deno.env.get("HOME") ?? Deno.env.get("TMPDIR") ?? "/tmp", ".cache/pronto/cue-exported");

const [cmd, cue, ...args] = Deno.args;
if (cmd === "export-key") {
  // Prints the path the export's output is kept at; exits 0 when it is there (a hit, and then a second line,
  // the seconds its evaluation took, as export-saved prints them: one deno start for a hit, not two), 1 when
  // not, 3 when the export can't be keyed.
  const us = args[0] === "export" ? units(cue, args) : undefined;
  if (!us || us.length !== 1) Deno.exit(3);
  const p = join(exported, us[0].key);
  console.log(p);
  if (isFile(p)) {
    try {
      Deno.utimeSync(p, new Date(), new Date());
    } catch { /* pruned meanwhile: a miss next time */ }
    console.log(secsIn(`${p}.secs`));
    Deno.exit(0);
  }
  Deno.exit(1);
} else if (cmd === "export-saved") {
  // export-saved <path>: the seconds the evaluation of the export kept at <path> took (0 when unknown).
  console.log(secsIn(`${cue}.secs`));
} else if (cmd === "export-store") {
  // export-store <cue> <path> <output> <args...>: keeps an export's output that passed, if its inputs are
  // still the ones keyed before it ran.
  const [path, output, ...rest] = args;
  const us = units(cue, rest);
  if (!us || us.length !== 1 || join(exported, us[0].key) !== path) Deno.exit(1);
  Deno.mkdirSync(exported, { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  Deno.copyFileSync(output, tmp);
  // Its evaluation's seconds first (CUE_RUN_SECS), then the entry: a hit never finds one without the other's time.
  Deno.writeTextFileSync(`${tmp}.secs`, `${runSecs().toFixed(2)}\n`);
  Deno.renameSync(`${tmp}.secs`, `${path}.secs`);
  Deno.renameSync(tmp, path);
  prune(exported, Number(Deno.env.get("CUE_EXPORTED_GB") ?? 8) * 2 ** 30);
} else if (cmd === "plan") {
  if (args[0] !== "vet") Deno.exit(1);
  const us = units(cue, args);
  if (!us) Deno.exit(1);
  const todo = us.filter((u) => !passed(u.key));
  if (todo.length) {
    if (todo.some((u) => u.arg === undefined)) {
      for (const a of args) console.log(`run ${a}`);
    } else {
      console.log("run vet");
      for (const a of args.slice(1)) if (a.startsWith("-")) console.log(`run ${a}`);
      for (const u of todo) console.log(`run ${u.arg}`);
    }
    for (const u of todo) console.log(`key ${u.key}`);
  }
  console.log(`skipped ${us.length - todo.length}`);
  console.log(`saved ${us.filter((u) => passed(u.key)).reduce((a, u) => a + secsIn(join(dir, u.key)), 0).toFixed(2)}`);
} else if (cmd === "record") {
  const before = new Set(
    new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer()).split("\n").filter((l) =>
      /^[0-9a-f]{64}$/.test(l)
    ),
  );
  const now = args[0] === "vet" ? units(cue, args) ?? [] : [];
  Deno.mkdirSync(dir, { recursive: true });
  const mine = now.filter((u) => before.has(u.key));
  for (const u of mine) Deno.writeTextFileSync(join(dir, u.key), mine.length && runSecs() ? `${(runSecs() / before.size).toFixed(2)}\n` : "");
  prune(dir);
} else {
  console.error("usage: vetted.ts plan|record|export-key <cue> <args...> | export-store <cue> <path> <output> <args...>");
  Deno.exit(2);
}
