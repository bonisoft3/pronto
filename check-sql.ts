// pronto SQL lint: squawk over every SQL file the app does not withhold.
//
//   deno run --allow-read --allow-run --allow-env \
//     ../../plugins/pronto/check-sql.ts <appDir>
//
// Inspection is default-on, so the set is discovered rather than listed: every
// *.sql under the app, minus what a `sql`-kind hatch names. Adding SQL to an
// app therefore cannot quietly escape the checks, and escaping them is a
// declaration — one that, because every hatch carries `ir`, also stands as an
// element in ir.html where a reviewer meets it.
//
// What squawk cannot see is the reason this is not the whole story: a statement
// inside a DO $$ ... $$ block is invisible to it — a rename, a dropped column
// and a dropped table hidden in one produce no findings, where the same three
// bare produce eight. The catalog replay is what reads those, by comparing
// states rather than text.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any error is reported.

import { exportJson } from "./cue.ts";
type Finding = { severity: "error" | "advisory"; path: string; message: string };

type Squawk = { file: string; line: number; rule_name: string; message: string; help?: string | null };

type Hatch = { kind: string; files?: string[]; note: string };

type RawMigration = { name: string; src: string };

/** Directories that hold no SQL of the app's own. */
const SKIP = new Set(["node_modules", ".git", ".bayt", ".omc", ".pronto", "dist", "build"]);

/**
 * Integer width is the type table's decision, not the linter's: an app that
 * declares int32 gets `INTEGER` and the range check that bounds it, so a column
 * squawk reads as a future overflow is one the program already constrained.
 */
const EXCLUDED_RULES = ["prefer-bigint-over-int"];

/**
 * The one rule forgiven, and only in the file pronto derives from the type
 * table. Every portable_* domain carries its CHECK by design — that is what
 * makes the domain the canonical form rather than a naked base type — and
 * squawk prefers table constraints because a domain constraint is awkward to
 * change later. Changing one is a type-system change, which is the checks'
 * subject rather than something to hide from them.
 */
const FORGIVEN: { rule: string; path: string } = {
  rule: "ban-create-domain-with-constraint",
  path: "services/database/migrations/004_types.sql",
};

/** Every *.sql under the app, app-relative, in a stable order. */
async function sqlFiles(appDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (SKIP.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
      } else if (entry.isFile && entry.name.endsWith(".sql")) {
        found.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(appDir, "");
  return found.sort();
}

/**
 * The paths inspection skips, each with the reason it is skipped — returned
 * together so the pass can say what it did not read.
 */
export function withheld(hatches: Record<string, Hatch>, raw: RawMigration[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, h] of Object.entries(hatches)) {
    if (h.kind !== "sql") continue;
    for (const f of h.files ?? []) out.set(f, `hatch ${name}: ${h.note}`);
  }
  // write.ts copies each src verbatim into migrations/<name>. Reading both
  // reports one file twice, and reports it second at a generated path nobody
  // can edit — so the copy is skipped and the source is what is read.
  for (const r of raw) {
    const copy = `services/database/migrations/${r.name}`;
    if (copy !== r.src) out.set(copy, `a copy of ${r.src}, which is read instead`);
  }
  return out;
}

/** squawk's findings as lint findings, with the forgiven rule dropped. */
export function findings(reported: Squawk[], appDir: string): Finding[] {
  const out: Finding[] = [];
  for (const r of reported) {
    const path = r.file.startsWith(appDir + "/") ? r.file.slice(appDir.length + 1) : r.file;
    if (r.rule_name === FORGIVEN.rule && path === FORGIVEN.path) continue;
    out.push({
      severity: "error",
      path,
      message: `${path}:${r.line} ${r.rule_name}: ${r.message}${r.help ? ` — ${r.help}` : ""}`,
    });
  }
  return out;
}

async function main(appDir: string) {
  const hatches = await exportJson<Record<string, Hatch>>(appDir, "code.capabilities.hatches");
  const raw = await exportJson<RawMigration[]>(
    appDir,
    "[if code.state.rawMigrations != _|_ {code.state.rawMigrations}, []][0]",
  );

  const skip = withheld(hatches, raw);
  const all = await sqlFiles(appDir);
  const read = all.filter((f) => !skip.has(f));

  // A hatch naming a file the app does not have is an exemption for nothing:
  // it reads as protection while protecting no one, so it is an error here
  // rather than a line nobody revisits. Asked of the hatches alone — the other
  // half of `skip` is the generated copies, which are absent exactly when the
  // app has not been written yet, and that is not a declaration to answer for.
  const declared = withheld(hatches, []);
  const ghosts = [...declared.keys()].filter((f) => !all.includes(f));
  if (ghosts.length > 0) {
    console.log(JSON.stringify(
      ghosts.map((f) => ({ severity: "error", path: "program.cue", message: `hatch withholds ${f}, which the app does not have` })),
      null,
      2,
    ));
    Deno.exit(1);
  }

  if (read.length === 0) {
    console.log(JSON.stringify([], null, 2));
    return;
  }

  const out = await new Deno.Command("mise", {
    args: ["x", "--", "squawk", ...read, "--reporter", "json", `--exclude=${EXCLUDED_RULES.join(",")}`],
    cwd: appDir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  // squawk reports findings on stdout and exits 0; a non-zero exit with nothing
  // parseable is squawk failing to run, which is not a clean bill of health.
  if (stdout === "") {
    const err = new TextDecoder().decode(out.stderr).trim();
    if (!out.success) throw new Error(`squawk failed: ${err || `exit ${out.code}`}`);
  }
  const reported: Squawk[] = stdout === "" ? [] : JSON.parse(stdout);

  const found = findings(reported, appDir);
  console.log(JSON.stringify(found, null, 2));
  if (found.some((f) => f.severity === "error")) Deno.exit(1);
}

if (import.meta.main) {
  await main(Deno.args[0] ?? ".");
}
