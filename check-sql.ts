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
const SKIP = new Set(["node_modules", "dist", "build"]);

/**
 * Integer width is the type table's decision, not the linter's: an app that
 * declares int32 gets `INTEGER` and the range check that bounds it, so a column
 * squawk reads as a future overflow is one the program already constrained.
 */
const EXCLUDED_RULES = ["prefer-bigint-over-int"];

/**
 * The one rule forgiven, and only in the file pronto derives from the type
 * table. Every portable_* domain carries its CHECK by design — a domain is
 * kept only where PostgREST needs its representation functions, and its
 * bounds belong with them — and squawk prefers table constraints because a
 * domain constraint is awkward to change later. Changing one is a type-system
 * change, which is the checks' subject rather than something to hide from
 * them.
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
        // A dot directory is tooling's, a mirror's .runtime among them.
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
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

export type DuckStream = {
  name: string;
  ir?: string;
  sql: string;
  sources: string[];
  sink: string;
  tempo?: "hot" | "cold";
  operators?: string[];
};

export function walkAst(obj: unknown, detected: Set<string>) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkAst(item, detected);
    return;
  }
  const record = obj as Record<string, unknown>;

  if (record.class === "FUNCTION" && typeof record.function_name === "string") {
    const fn = record.function_name.toLowerCase();
    if (fn === "tumble" || fn === "hop" || fn === "session") {
      detected.add(fn);
    }
  }

  if (record.type === "DISTINCT_MODIFIER" || record.distinct === true) {
    detected.add("distinct");
  }

  if (record.type === "JOIN" && (record.ref_type === "CROSS" || record.join_type === "CROSS")) {
    detected.add("cross_join");
  }

  if (record.type === "JOIN" && record.condition) {
    const condStr = JSON.stringify(record.condition).toLowerCase();
    const hasInterval = condStr.includes("interval") || condStr.includes("to_seconds") || condStr.includes("to_minutes") || condStr.includes("to_hours") || condStr.includes("to_days");
    const hasRange = condStr.includes("compare_between") || condStr.includes("compare_greaterthan") || condStr.includes("compare_lessthan");
    if (hasInterval && hasRange) {
      detected.add("interval_join");
    }
  }

  for (const val of Object.values(record)) {
    walkAst(val, detected);
  }
}

export async function checkDuckStreams(
  duckstreams: Record<string, DuckStream>,
  appDir: string,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [name, ds] of Object.entries(duckstreams)) {
    const tempo = ds.tempo;
    const declaredOps = new Set(ds.operators ?? []);
    const sql = ds.sql;

    const escaped = sql.replaceAll("'", "''");
    const cmd = new Deno.Command("mise", {
      args: ["exec", "--", "duckdb", "-dark-mode", "-batch", "-json", "-c", `SELECT json_serialize_sql('${escaped}');`],
      cwd: appDir,
      stdout: "piped",
      stderr: "piped",
    });
    const res = await cmd.output();
    if (!res.success) {
      const err = new TextDecoder().decode(res.stderr).trim();
      throw new Error(`duckdb failed to parse "${name}": ${err}`);
    }

    const stdoutText = new TextDecoder().decode(res.stdout).trim();
    if (!stdoutText) {
      throw new Error(`duckdb returned empty output for "${name}"`);
    }
    const rows = JSON.parse(stdoutText);
    const firstRow = rows[0];
    const key = Object.keys(firstRow)[0];
    const parsed = firstRow[key];

    if ((parsed as { error?: boolean })?.error) {
      const errMsg = (parsed as { error_message?: string })?.error_message ?? "syntax error";
      out.push({
        severity: "error",
        path: `pipelines/duckstream/${name}.sql`,
        message: `duckstream "${name}": SQL syntax error: ${errMsg}`,
      });
      continue;
    }

    const detected = new Set<string>();
    walkAst(parsed, detected);

    for (const op of detected) {
      if (!declaredOps.has(op)) {
        out.push({
          severity: "error",
          path: `program.cue`,
          message: `duckstream "${name}" uses operator "${op}" but does not declare it in operators: [...]`,
        });
      }
    }

    for (const op of declaredOps) {
      if (!detected.has(op)) {
        out.push({
          severity: "error",
          path: `program.cue`,
          message: `duckstream "${name}" declares operator "${op}" in operators: [...] but the query does not use it`,
        });
      }
    }

    const windowOps = ["tumble", "hop", "session"].filter((o) => detected.has(o));
    if (windowOps.length > 0 && tempo !== "cold") {
      out.push({
        severity: "error",
        path: `program.cue`,
        message: `duckstream "${name}" uses windowing operator (${windowOps.join(", ")}) which requires tempo: "cold", but tempo is "${tempo}"`,
      });
    }
  }
  return out;
}

async function main(appDir: string) {
  const hatches = await exportJson<Record<string, Hatch>>(appDir, "code.capabilities.hatches");
  const raw = await exportJson<RawMigration[]>(
    appDir,
    "[if code.state.rawMigrations != _|_ {code.state.rawMigrations}, []][0]",
  );
  const duckstreams = await exportJson<Record<string, DuckStream>>(
    appDir,
    "[if code.state.duckstreams != _|_ {code.state.duckstreams}, {}][0]",
  );

  const skip = withheld(hatches, raw);
  const all = await sqlFiles(appDir);
  const duckstreamPaths = new Set(Object.keys(duckstreams).map((n) => `pipelines/duckstream/${n}.sql`));
  const read = all.filter((f) => !skip.has(f) && !duckstreamPaths.has(f));

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

  const duckFindings = await checkDuckStreams(duckstreams, appDir);

  let squawkReported: Squawk[] = [];
  if (read.length > 0) {
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
    squawkReported = stdout === "" ? [] : JSON.parse(stdout);
  }

  const found = [...findings(squawkReported, appDir), ...duckFindings];
  console.log(JSON.stringify(found, null, 2));
  if (found.some((f) => f.severity === "error")) Deno.exit(1);
}

if (import.meta.main) {
  await main(Deno.args[0] ?? ".");
}
