// pronto migration replay: what each migration did, read out of the catalog.
//
//   deno run --allow-read --allow-write --allow-run --allow-env \
//     ../../plugins/pronto/check-replay.ts <appDir>
//
// Fresh initdb and the migration runner build a database once. A second run
// of that runner must leave its schema, rows and ledger unchanged. Retained
// fixtures exercise upgrades and compare their catalogs through replay.sql;
// intermediate bootstrap tables have never been exposed to a reader.
//
// Compose runs this checker in the replay process after the database is
// healthy; cluster.surface.schema publishes the initdb and migration
// directories baked into the image.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any error is reported.

import { fileURLToPath } from "node:url";
import { exists } from "./missing.ts";

type Finding = { severity: "error" | "advisory"; path: string; message: string };

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The scratch database the replay builds up; never the one the image seeded. */
const REPLAY_DB = "pronto_replay";

/** Where a finding about a pgroll migration sends its reader: the program. */
const declaredAt = (name: string) => `code.state.migrations.${name}`;

/**
 * The versions a migrate image holds, in the order the cluster applies them,
 * from a listing of its directory. Byte order, which is the runner's.
 */
export function pgrollMigrations(listing: string): string[] {
  return listing.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".json")).map((l) => l.replace(/\.json$/, ""))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Reader columns of tables and views. A view replacing a table still has a
 * reader contract; omitting views makes that replacement look like absence.
 *
 * `rel` is the relation's oid, and it is what makes attnum readable: attnum is
 * unique and stable within one relation and says nothing across two, so a table
 * dropped and recreated hands its successor the same numbers starting at 1.
 * Carrying the oid is what lets the comparison tell "this column moved" from
 * "this table is not the table that was here".
 */
export const CATALOG = `
  SELECT c.oid::bigint AS rel,
         c.relname AS tbl,
         c.relkind AS kind,
         a.attname AS col,
         format_type(a.atttypid, a.atttypmod) AS typ,
         a.attnum AS ordinal
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum`;

export type Column = { rel: number; tbl: string; kind: string; col: string; typ: string; ordinal: number };
type Row = Column & { step: number; mig: string };

type Replacement = { kind: "table" | "view" | "absent"; note: string };
export type UpgradeFixture = {
  name: string;
  omitInitdb: string[];
  through: string;
  seed: string;
  verify: string;
  replacements: Record<string, Replacement>;
};

export function fixtureDefinitions(value: unknown): UpgradeFixture[] {
  if (!Array.isArray(value)) throw new Error("tests/replay.json must be an array");
  const names = new Set<string>();
  for (const fixture of value) {
    if (!fixture || typeof fixture !== "object" || Object.keys(fixture).some(k => !["name", "omitInitdb", "through", "seed", "verify", "replacements"].includes(k))) {
      throw new Error("invalid retained fixture definition");
    }
    if (typeof fixture.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(fixture.name) || names.has(fixture.name)) throw new Error("retained fixture needs a unique name");
    names.add(fixture.name);
    if (!Array.isArray(fixture.omitInitdb) || fixture.omitInitdb.some((n: unknown) => typeof n !== "string" || !/^\d{3}_[a-z0-9_]+\.sql$/.test(n))) throw new Error(`${fixture.name}: invalid omitted initdb steps`);
    if (typeof fixture.through !== "string" || !/^[a-z0-9_]+$/.test(fixture.through)) throw new Error(`${fixture.name}: missing prior migration`);
    for (const key of ["seed", "verify"]) {
      if (typeof fixture[key] !== "string" || !/^tests\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.sql$/.test(fixture[key])) throw new Error(`${fixture.name}: ${key} must name a SQL fixture under tests/`);
    }
    if (!fixture.replacements || typeof fixture.replacements !== "object" || Array.isArray(fixture.replacements)) throw new Error(`${fixture.name}: replacements must be an object`);
    for (const [table, declaration] of Object.entries(fixture.replacements)) {
      const r = declaration as Replacement;
      if (!/^[a-z][a-z0-9_]*$/.test(table) || !r || Object.keys(r).some(k => !["kind", "note"].includes(k)) || !["table", "view", "absent"].includes(r.kind) || typeof r.note !== "string" || !r.note.trim()) {
        throw new Error(`${fixture.name}: projection replacement ${table} needs its resulting kind and rationale`);
      }
    }
  }
  return value;
}

async function loadFixtures(appDir: string): Promise<UpgradeFixture[]> {
  const path = `${appDir}/tests/replay.json`;
  if (!await exists(path)) return [];
  return await Promise.all(fixtureDefinitions(JSON.parse(await Deno.readTextFile(path))).map(async f => ({
    ...f,
    seed: await Deno.readTextFile(`${appDir}/${f.seed}`),
    verify: await Deno.readTextFile(`${appDir}/${f.verify}`),
  })));
}

export function replacementFindings(before: Column[], after: Column[], replacements: Record<string, Replacement>, path: string): Finding[] {
  const found: Finding[] = [];
  for (const [table, replacement] of Object.entries(replacements)) {
    const old = before.filter(c => c.tbl === table);
    const next = after.filter(c => c.tbl === table);
    const kinds = replacement.kind === "view" ? ["v"] : ["r", "p"];
    const error = (message: string) => found.push({ severity: "error", path, message: `${table}: ${message}` });
    if (!old.length) error("declared projection replacement was absent from the retained fixture");
    if (replacement.kind === "absent") {
      if (next.length) error("retired projection still exists");
      continue;
    }
    if (!next.length || next.some(c => !kinds.includes(c.kind))) error(`replacement is not a ${replacement.kind}`);
    for (const c of old) if (!next.some(n => n.col === c.col && n.typ === c.typ)) error(`replacement lost or retyped reader column ${c.col}`);
  }
  return found;
}

export async function compareCatalogs(before: Column[], after: Column[], path: string, cwd?: string): Promise<Finding[]> {
  const scratch = await Deno.makeTempDir({ prefix: "pronto-replay-" });
  try {
    const rows: Row[] = [...before.map(c => ({ ...c, step: 0, mig: "retained" })), ...after.map(c => ({ ...c, step: 1, mig: path }))];
    await Deno.writeTextFile(`${scratch}/states.json`, JSON.stringify(rows));
    await Deno.writeTextFile(`${scratch}/steps.json`, JSON.stringify([{ step: 0, mig: "retained" }, { step: 1, mig: path }]));
    const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const query = `CREATE TABLE snapshot (step INTEGER, mig VARCHAR, rel BIGINT, tbl VARCHAR, kind VARCHAR, col VARCHAR, typ VARCHAR, ordinal INTEGER);
      INSERT INTO snapshot SELECT * FROM read_json(${literal(`${scratch}/states.json`)}, columns={step:'INTEGER',mig:'VARCHAR',rel:'BIGINT',tbl:'VARCHAR',kind:'VARCHAR',col:'VARCHAR',typ:'VARCHAR',ordinal:'INTEGER'});
      CREATE TABLE step AS SELECT * FROM read_json_auto(${literal(`${scratch}/steps.json`)});
      ${await Deno.readTextFile(here("replay.sql"))}`;
    const out = await run("mise", ["x", "--", "duckdb", "-json", "-c", query], { cwd });
    if (!out.ok) throw new Error(`catalog comparison failed: ${out.stderr}`);
    return out.stdout ? JSON.parse(out.stdout) : [];
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

// Views may depend on now(); only stored rows must stay byte-identical when
// the migration ledger says there is no work left to do.
const DATA_SNAPSHOT = `
  CREATE TEMP TABLE replay_rows (name text, rows bigint, digest text);
  DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','m') ORDER BY c.relname LOOP
      EXECUTE format('INSERT INTO replay_rows SELECT %L, count(*), md5(coalesce(string_agg(md5(row_to_json(t)::text), '''' ORDER BY md5(row_to_json(t)::text)), '''')) FROM public.%I t', r.relname, r.relname);
    END LOOP;
  END $$;
  SELECT coalesce(json_agg(r ORDER BY name), '[]') FROM replay_rows r;`;

// pgroll draws a spinner and colours its output, so its stderr arrives wrapped
// in escape sequences and carriage returns. A finding is read by a person, so
// what reaches one is the sentence and not the animation.
//
// Every frame is a segment, and the diagnosis is one of them — not the last,
// because pgroll draws a cleanup frame after it, and not the one carrying
// "error", because pgroll's word is "failed". Taking the last segment or
// grepping for "error" both end at the erase frame, which is empty: the finding
// then prints its prefix and stops, naming a failure it does not describe. So
// the sentence is chosen by what a diagnosis says, and the last non-empty frame
// is the fallback that still says something.
const PLAIN = /\u001b\[[0-9;]*[A-Za-z]/g;
const DIAGNOSIS = /\b(error|fail(ed|ure)?|fatal|panic)\b/i;

/** Every frame of a spinner's output, stripped and in order, empties dropped. */
export function frames(text: string): string[] {
  return text.replace(PLAIN, "").split(/[\r\n]/).map((s) => s.trim()).filter((s) => s !== "");
}

export function plain(text: string): string {
  const seen = frames(text);
  return seen.findLast((f) => DIAGNOSIS.test(f)) ?? seen.at(-1) ?? "";
}

async function run(cmd: string, args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}) {
  const proc = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (opts.stdin !== undefined) {
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const out = await proc.output();
  return {
    ok: out.success,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
}

/** What the cluster publishes about its database (mecha's cluster.cue). */
export type Published = { target: string; initdb: string; pgroll?: { target: string; dir: string; baseline: string } };

/**
 * What initdb applies, in the order it applies it — read out of the image
 * rather than off the app's migrations directory, because that directory is not
 * the whole schema. The image carries mecha's tenancy floor, whose procedure the
 * app's policies call; a replay of the app's files alone stops there claiming
 * the app is broken, which is a fact about the replay. Byte order is initdb's
 * own: mecha's cluster refuses a step name under which the two would differ.
 */
async function steps(initdb: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(initdb)) {
    if (entry.isFile && entry.name.endsWith(".sql")) out.push(`${initdb}/${entry.name}`);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Where a finding belongs: the app's own copy when it has one, so a person is
 * sent to the file they can edit, and the image's path otherwise — a step that
 * came from mecha is not the app's to fix.
 */
export async function locate(appDir: string, scriptPath: string): Promise<string> {
  const name = scriptPath.split("/").pop() ?? scriptPath;
  const owned = `services/database/migrations/${name}`;
  // Absence is the answer this asks for. A dangling link is still the app's
  // file, and a directory that cannot be read is raised: either, reported as
  // the image's, would send a person to a file that is not the one at fault.
  return (await exists(`${appDir}/${owned}`)) ? owned : `the database image's ${name}`;
}

export async function main(appDir: string): Promise<number> {
  const facts = JSON.parse(await Deno.readTextFile(`${appDir}/.pronto/cluster.json`)) as { server: boolean; schema?: Published };
  if (!facts.server || facts.schema === undefined) {
    throw new Error("this app's every entity is a browser tier: it has no schema to replay");
  }
  const fixtures = await loadFixtures(appDir);
  const found = await replayDatabase({ appDir, published: facts.schema, env: Deno.env.toObject(), fixtures });
  console.log(JSON.stringify(found, null, 2));
  return found.some((f) => f.severity === "error") ? 1 : 0;
}

export type Migrator = { entrypoint?: string[]; command?: string[]; env?: Record<string, string> };
export async function replayDatabase({ appDir, published, env, migrator, fixtures = [] }: {
  appDir: string; published: Published; env: Record<string, string>; migrator?: Migrator; fixtures?: UpgradeFixture[];
}): Promise<Finding[]> {
  const settings = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_INITDB_ARGS"];
  const missing = settings.filter((k) => env[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`${published.target} declares no ${missing.join(", ")}: the replay reads the database's settings from its entrypoint environment`);
  }

  const user = env.POSTGRES_USER;
  const pgEnv = { ...Deno.env.toObject(), ...env, PGPASSWORD: env.POSTGRES_PASSWORD };
  const psql = (db: string, sql: string, extra: string[] = []) =>
    run("psql", ["-h", "127.0.0.1", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", ...extra], { stdin: sql, env: pgEnv });
  const created: string[] = [];
  let finished = false;
  const finish = (findings: Finding[]) => {
    finished = true;
    return findings;
  };

  try {
    // Waited for over TCP, and that is the whole point: while initdb applies
    // the scripts baked into the image it runs a temporary server bound to a
    // unix socket alone, which answers pg_isready and then goes away to be
    // restarted. Asking on 127.0.0.1 skips that one and waits for the server
    // that stays.
    const ready = () => run("pg_isready", ["-h", "127.0.0.1", "-U", user], { env: pgEnv });
    for (let i = 0; i < 480; i++) {
      if ((await ready()).ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const live = await ready();
    if (!live.ok) throw new Error(`${published.target} never became ready: ${live.stderr || live.stdout}`);

    const scripts = await steps(published.initdb);
    if (scripts.length === 0) throw new Error("the database image carries no initdb scripts to replay");
    const findings: Finding[] = [];
    const must = async (result: ReturnType<typeof run>, what: string) => {
      const out = await result;
      if (!out.ok) throw new Error(`${what}: ${out.stderr || out.stdout}`);
      return out.stdout;
    };
    const sql = (db: string, query: string) => must(psql(db, `SET pgroll.no_inferred_migrations = 'true'; ${query}`, ["-X", "-t", "-A"]), `query ${db}`);
    const catalog = async (db: string): Promise<Column[]> => JSON.parse(await sql(db, `SELECT coalesce(json_agg(t), '[]') FROM (${CATALOG}) t`));
    const bootstrap = async (db: string, omitted: string[] = []) => {
      for (const name of omitted) {
        if (!scripts.some(s => s.endsWith(`/${name}`))) throw new Error(`retained fixture omits unknown initdb step ${name}`);
      }
      await sql("postgres", `CREATE DATABASE ${db}`);
      created.push(db);
      for (const script of scripts) {
        if (omitted.includes(script.split("/").at(-1)!)) continue;
        const applied = await psql(db, await Deno.readTextFile(script));
        if (!applied.ok) {
          findings.push({ severity: "error", path: await locate(appDir, script), message: `${db}: bootstrap failed: ${plain(applied.stderr)}` });
          return false;
        }
      }
      return true;
    };
    if (!await bootstrap(REPLAY_DB)) return finish(findings);
    if (!published.pgroll) {
      if (fixtures.length) throw new Error("retained fixtures require a migration runner");
      return finish(findings);
    }
    const { dir, baseline } = published.pgroll;
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) entries.push(entry.name);
    }
    const declared = pgrollMigrations(entries.join("\n"));
    const entrypoint = migrator?.entrypoint ?? ["/migrate.sh"];
    const command = migrator?.command ?? [dir, baseline];
    if (!Array.isArray(entrypoint) || !Array.isArray(command) || !entrypoint.length) throw new Error("migration runner must have an executable entrypoint");
    const migrate = async (db: string, through?: string) => {
      const url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:5432/${db}?sslmode=disable`;
      const runEnv = { ...pgEnv, ...migrator?.env, DATABASE_URL: url };
      if (through !== undefined) {
        if (!declared.includes(through)) throw new Error(`retained fixture names unknown migration ${through}`);
        if (!command.includes(dir)) throw new Error("migration runner command does not expose its migration directory");
        const subset = await Deno.makeTempDir({ prefix: "pronto-replay-migrations-" });
        try {
          for (const n of declared.filter(n => n <= through)) {
            await Deno.copyFile(`${dir}/${n}.json`, `${subset}/${n}.json`);
          }
          const argv = [...entrypoint, ...command.map((arg: string) => arg === dir ? subset : arg)];
          return await run(argv[0], argv.slice(1), { env: runEnv });
        } finally {
          await Deno.remove(subset, { recursive: true });
        }
      }
      const argv = [...entrypoint, ...command];
      return await run(argv[0], argv.slice(1), { env: runEnv });
    };
    const ledger = (db: string) => sql(db, "SELECT coalesce(json_agg(m ORDER BY name), '[]') FROM pgroll.migrations m WHERE schema = 'public'");
    const snapshot = async (db: string) => {
      const schema = await must(run("pg_dump", ["-h", "127.0.0.1", "-U", user, "-d", db, "--schema-only", "--schema=public"], { env: pgEnv }), "dump schema");
      return JSON.stringify({
        schema: schema.split("\n").filter(l => !/^\\(?:un)?restrict /.test(l)).join("\n"),
        catalog: await catalog(db),
        rows: await sql(db, DATA_SNAPSHOT),
        ledger: await ledger(db),
      });
    };
    const completed = async (db: string) => {
      const seen = JSON.parse(await ledger(db)) as { name: string; migration_type: string; done: boolean }[];
      for (const name of declared) if (!seen.some(m => m.name === name && m.migration_type === "pgroll" && m.done)) {
        findings.push({ severity: "error", path: declaredAt(name), message: `${db}: migration runner did not complete this migration` });
      }
    };
    const runAndRepeat = async (db: string, path: string) => {
      const first = await migrate(db);
      if (!first.ok) {
        findings.push({ severity: "error", path, message: `migration runner failed: ${plain(first.stderr || first.stdout)}` });
        return false;
      }
      await completed(db);
      const before = await snapshot(db);
      const second = await migrate(db);
      if (!second.ok) findings.push({ severity: "error", path, message: `migration runner failed on restart: ${plain(second.stderr || second.stdout)}` });
      else if (before !== await snapshot(db)) findings.push({ severity: "error", path, message: "migration runner changed the schema, stored rows or ledger on restart" });
      return true;
    };
    if (!await runAndRepeat(REPLAY_DB, "code.state.migrations")) return finish(findings);
    if (!fixtures.length) findings.push({ severity: "advisory", path: "tests/replay.json", message: "fresh bootstrap and migration restart checked; no retained-data upgrade fixtures are declared" });
    for (const [i, fixture] of fixtures.entries()) {
      const db = `${REPLAY_DB}_${i}`;
      const path = `tests/replay.json:${fixture.name}`;
      if (!await bootstrap(db, fixture.omitInitdb)) continue;
      await must(migrate(db, fixture.through), `${path}: prepare prior migration ledger`);
      await sql(db, fixture.seed);
      const before = await catalog(db);
      if (!await runAndRepeat(db, path)) continue;
      const after = await catalog(db);
      const verified = await sql(db, fixture.verify);
      if (verified !== "t") findings.push({ severity: "error", path, message: "retained-data verification must return one true boolean" });
      findings.push(...replacementFindings(before, after, fixture.replacements, path));
      // Only named, asserted projection replacements leave the strict
      // identity comparison. Every other drop/recreate remains an error.
      const replaced = new Set(Object.keys(fixture.replacements));
      findings.push(...await compareCatalogs(before.filter(c => !replaced.has(c.tbl)), after.filter(c => !replaced.has(c.tbl)), path, appDir));
    }
    return finish(findings);
  } finally {
    for (const db of created) {
      const dropped = await psql("postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      if (!dropped.ok && finished) throw new Error(`could not drop replay database ${db}: ${dropped.stderr}`);
    }
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args[0] ?? "."));
}
