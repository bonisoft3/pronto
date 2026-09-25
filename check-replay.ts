// pronto migration replay: what each migration did, read out of the catalog.
//
//   deno run --allow-read --allow-write --allow-run --allow-env \
//     ../../plugins/pronto/check-replay.ts <appDir>
//
// Applies the app's migrations one at a time into an empty database, asks the
// catalog what the schema is after each, and hands the states to DuckDB, which
// compares every step against the one before it (replay.sql).
//
// It exists because neither text pass can see this. squawk reads statements and
// is blind inside a DO $$ ... $$ block — a rename, a dropped column and a
// dropped table hidden in one produce no findings, where the same three bare
// produce eight — and buf reads the emitted proto, which an escape-hatch
// migration never touches. A catalog state does not care how it was reached, so
// a rename spelled by dynamic EXECUTE lands here like a plain one.
//
// It also applies the set a second time, which is the other thing no reader of
// the text finds: 005_policies.sql emits CREATE POLICY, which squawk reports
// nothing about and Postgres refuses on the second pass.
//
// The database is the app's own image, resolved through the generated compose
// rather than named here: it is the one carrying plv8, and its name is the
// project's, which differs between this monorepo and the repo an app is
// copybara'd into.
//
// This runs on `integrate`, the verb whose bayt target brings the stack up, so
// the image it grades is the one this tree just produced. That is why nothing
// here asks whether the image is current: an image older than the migrations
// beside it makes every finding a statement about a schema nobody would deploy,
// and the verb that builds it is what rules that out rather than a comparison
// that would be re-deriving the build graph's job. Its absence is still a
// precondition failure rather than a clean bill of health.
//
// What is the cluster's about that database — which target runs it, and where
// its image applies scripts from — is read from `cluster.surface.schema`,
// which mecha publishes. This pass replays what a cluster declares; it does not
// know how mecha lays an image out, and a second copy of that layout here is
// exactly the thing that would rot without anyone noticing.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any error is reported.

import { fileURLToPath } from "node:url";
import { exportJson } from "./cue.ts";

type Finding = { severity: "error" | "advisory"; path: string; message: string };

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** The scratch database the replay builds up; never the one the image seeded. */
const REPLAY_DB = "pronto_replay";

/**
 * The one step known not to survive a second application, and the reason it is
 * not a finding. Postgres has no CREATE DOMAIN IF NOT EXISTS, and the only
 * idempotent spelling hides the CREATE inside a DO block that swallows
 * duplicate_object — which also hides the domain's CHECK from squawk, where a
 * whole class of change would then pass unread. Visible and not re-appliable
 * was the trade taken (type-sql.ts); a migration ledger is what removes the
 * need to apply it twice at all.
 *
 * Every other step must survive, so this names one file rather than relaxing
 * the rule — and within that file, one condition, checked per statement. The
 * 14 domains and 42 casts here all fail the same way and are all forgiven; a
 * `CREATE FUNCTION` without `OR REPLACE` added beside them is not.
 */
const FORGIVEN_SECOND_PASS = "services/database/migrations/003_types.sql";

/**
 * The two spellings forgiven there, and nothing else that already exists.
 *
 * Postgres says "already exists" for every duplicate object, so matching that
 * alone would forgive `function "f" already exists with same argument types`
 * and `relation "t" already exists` — a CREATE FUNCTION without OR REPLACE and
 * a CREATE TABLE, neither of which has any business being unrepeatable in a
 * file exempted for lacking IF NOT EXISTS. Measured against the app's own
 * image, the domains say `type "d" already exists` and the casts `cast from
 * type a to type b already exists`; those two are the file's whole content
 * besides CREATE OR REPLACE functions, which re-apply cleanly.
 *
 * Matched on the message because psql reports the SQLSTATE only under a
 * verbosity that would put a code and a source location into every other
 * finding. Anything unmatched is reported, so the failure direction is a
 * finding too many, never one too few.
 */
const FORGIVEN_DUPLICATE = [/^ERROR:\s+type ".+" already exists/i, /^ERROR:\s+cast from type .+ already exists/i];
export const forgivable = (error: string) => FORGIVEN_DUPLICATE.some((p) => p.test(error));

/** Named so a run interrupted before its cleanup can be swept by the next one. */
const CONTAINER_PREFIX = "pronto-replay-";

/** Where the app declares changes for a schema that already exists. */
const PGROLL_DIR = "services/database/pgroll";

/**
 * The ledger name for the schema initdb built, which the declared migrations
 * start from. It is this pass's own and not an app's to use: the emitted
 * migrations are numbered 000, 001, … so a first pgroll migration named in that
 * habit could land on it, and the collision would read as pgroll silently
 * declining to apply a migration rather than as a name that was taken.
 */
const BASELINE = "00_initdb";

/** The versions the app declares, in the order pgroll applies them. */
export async function pgrollMigrations(appDir: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${appDir}/${PGROLL_DIR}`)) {
      if (entry.isFile && entry.name.endsWith(".json")) found.push(entry.name.replace(/\.json$/, ""));
    }
  } catch (error) {
    // An app that has never changed a live schema declares none, and the
    // directory is simply absent; anything else is this pass's problem.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found.sort();
}

/**
 * Columns of every ordinary table in the app's schema, as the catalog holds
 * them.
 *
 * `rel` is the relation's oid, and it is what makes attnum readable: attnum is
 * unique and stable within one relation and says nothing across two, so a table
 * dropped and recreated hands its successor the same numbers starting at 1.
 * Carrying the oid is what lets the comparison tell "this column moved" from
 * "this table is not the table that was here".
 */
const CATALOG = `
  SELECT c.oid::bigint AS rel,
         c.relname AS tbl,
         a.attname AS col,
         format_type(a.atttypid, a.atttypmod) AS typ,
         a.attnum AS ordinal
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum`;

type Row = { step: number; mig: string; rel: number; tbl: string; col: string; typ: string; ordinal: number };

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

async function run(cmd: string, args: string[], opts: { cwd?: string; stdin?: string } = {}) {
  const proc = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
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
type Published = { target: string; initdb: string };

type Service = {
  image?: string;
  environment?: Record<string, string>;
  build?: { context?: string };
};
type Config = { services?: Record<string, Service> };

/**
 * The service running the cluster's database, as compose resolves it in
 * whatever repo this is. Picked by build context and not by name alone: the
 * cluster the app instantiates declares a database of its own under a name that
 * ends the same way, and only one of the two is built out of this directory.
 */
export function databaseService(config: Config, appDir: string, target: string) {
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    if (!name.endsWith(`-${target}`) || !svc.image) continue;
    if (svc.build?.context !== appDir) continue;
    return { name, image: svc.image, env: svc.environment ?? {} };
  }
  return undefined;
}

/**
 * What initdb applies, in the order it applies it — read out of the image
 * rather than off the app's migrations directory, because that directory is not
 * the whole schema. mecha copies its own rls.sql in as 002a_rls.sql, and the
 * app's 005 calls the procedure it defines; a replay of the app's files alone
 * stops there claiming the app is broken, which is a fact about the replay.
 */
async function steps(container: string, initdb: string): Promise<string[]> {
  const listed = await run("docker", ["exec", container, "sh", "-c", `ls -1 ${initdb}/*.sql 2>/dev/null || true`]);
  if (!listed.ok) throw new Error(`could not list the image's initdb scripts: ${listed.stderr}`);
  return listed.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").sort();
}

/**
 * Where a finding belongs: the app's own copy when it has one, so a person is
 * sent to the file they can edit, and the image's path otherwise — a step that
 * came from mecha is not the app's to fix.
 */
export async function locate(appDir: string, scriptPath: string): Promise<string> {
  const name = scriptPath.split("/").pop() ?? scriptPath;
  const owned = `services/database/migrations/${name}`;
  try {
    await Deno.stat(`${appDir}/${owned}`);
    return owned;
  } catch (error) {
    // Absence is the answer this asks for. Anything else — a directory that
    // cannot be read, a broken link — would otherwise be reported as "this step
    // is the image's", sending a person to a file that is not the one at fault.
    if (error instanceof Deno.errors.NotFound) return `the database image's ${name}`;
    throw error;
  }
}

async function main(appDir: string): Promise<number> {
  const config = await run("docker", ["compose", "-f", ".bayt/compose.yaml", "config", "--format", "json"], { cwd: appDir });
  if (!config.ok) throw new Error(`docker compose config failed: ${config.stderr}`);
  // compose answers with absolute build contexts, so the app's is compared as one.
  // Asked before the schema facts, which a cluster only publishes where there is
  // a database to publish them about: without this the misuse answers with
  // `undefined field: schema`, a sentence about CUE rather than about the app.
  if (await exportJson<boolean>(appDir, "cluster.capabilities.server") !== true) {
    throw new Error("this app's every entity is a browser tier: it has no schema to replay");
  }
  const published = await exportJson<Published>(appDir, "cluster.surface.schema");
  const service = databaseService(JSON.parse(config.stdout), await Deno.realPath(appDir), published.target);
  if (service === undefined) throw new Error("no database service in the generated compose: this app has no server tier to replay");

  const present = await run("docker", ["image", "inspect", service.image]);
  if (!present.ok) {
    throw new Error(`${service.image} is not built — build the app before replaying its migrations`);
  }

  // Anything THIS app's replay left behind before it started: the container is
  // removed in a `finally`, which a SIGKILL — an interrupted run, a timeout —
  // never reaches, and a machine that collects them runs out of ports and
  // memory without ever saying why.
  //
  // Scoped to the service, because the sweep is indiscriminate within its
  // prefix: two apps replaying at once on one machine would otherwise tear down
  // each other's database mid-run, and the victim would report a schema that
  // simply stopped answering.
  const mine = `${CONTAINER_PREFIX}${service.name}-`;
  const left = await run("docker", ["ps", "-aq", "--filter", `name=${mine}`]);
  if (!left.ok) throw new Error(`could not list leftover replay containers: ${left.stderr}`);
  const ids = left.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (ids.length > 0) await run("docker", ["rm", "-f", ...ids]);

  const container = `${mine}${crypto.randomUUID().slice(0, 12)}`;
  // Taken from the compose the app ships and never guessed: a replay that
  // invents a user or a database name grades a schema built under settings the
  // app does not run with, and says nothing about having done so.
  const env = service.env;
  const settings = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_INITDB_ARGS"];
  const missing = settings.filter((k) => env[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`${service.name} declares no ${missing.join(", ")}: the replay reads the database's settings from the generated compose`);
  }
  const started = await run("docker", [
    "run", "-d", "--name", container,
    // pgroll runs here, not in the container, so the database needs a port on
    // this side. An ephemeral one, because a fixed one collides with whatever
    // else the machine is running.
    "-p", "127.0.0.1::5432",
    ...settings.flatMap((k) => ["-e", `${k}=${env[k]}`]),
    service.image,
  ]);
  if (!started.ok) throw new Error(`could not start ${service.image}: ${started.stderr}`);

  const mapped = await run("docker", ["port", container, "5432/tcp"]);
  if (!mapped.ok) throw new Error(`could not read the database's published port: ${mapped.stderr}`);
  const port = mapped.stdout.split("\n")[0].trim().split(":").pop();
  if (port === undefined || !/^\d+$/.test(port)) {
    throw new Error(`could not read a port out of \`docker port\`: ${mapped.stdout}`);
  }

  const user = env.POSTGRES_USER;
  const psql = (db: string, sql: string, extra: string[] = []) =>
    run("docker", ["exec", "-i", container, "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", ...extra], { stdin: sql });

  try {
    // Waited for over TCP, and that is the whole point: while initdb applies
    // the scripts baked into the image it runs a temporary server bound to a
    // unix socket alone, which answers pg_isready and then goes away to be
    // restarted. Asking on 127.0.0.1 skips that one and waits for the server
    // that stays.
    const ready = () => run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", user]);
    for (let i = 0; i < 480; i++) {
      if ((await ready()).ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const live = await ready();
    if (!live.ok) throw new Error(`${service.image} never became ready: ${live.stderr || live.stdout}`);

    const scripts = await steps(container, published.initdb);
    if (scripts.length === 0) throw new Error("the database image carries no initdb scripts to replay");
    const rows: Row[] = [];
    const applied_steps: { step: number; mig: string }[] = [];
    const failures: Finding[] = [];

    /** The text of one step, as the image holds it. */
    const read = async (script: string) => {
      const got = await run("docker", ["exec", container, "cat", script]);
      if (!got.ok) throw new Error(`could not read ${script}: ${got.stderr}`);
      return got.stdout;
    };

    const applyAll = async (): Promise<Finding[]> => {
      // Onto a copy, and with every statement attempted rather than the file
      // stopping at its first error.
      //
      // A step is one transaction under ON_ERROR_STOP, so a single failure
      // ends the file: 003_types.sql aborts at its first CREATE DOMAIN, around
      // line 10 of 515, and the 42 CREATE CASTs and 57 functions below it are
      // never tried. Forgiving that file then forgave everything under it,
      // including anything a later emitter change puts there. ON_ERROR_ROLLBACK
      // takes a savepoint per statement, so each failure is isolated and the
      // rest still run — and the copy is what makes that safe, since the
      // successful halves of a partly-failing file would otherwise commit into
      // the schema the pgroll phase then reads.
      const copy = `${REPLAY_DB}_again`;
      const cloned = await psql("postgres", `DROP DATABASE IF EXISTS ${copy}; CREATE DATABASE ${copy} TEMPLATE ${REPLAY_DB};`);
      if (!cloned.ok) throw new Error(`could not copy the replay database: ${cloned.stderr || cloned.stdout}`);

      const again: Finding[] = [];
      for (const script of scripts) {
        const applied = await psql(copy, await read(script), ["-v", "ON_ERROR_STOP=0", "-v", "ON_ERROR_ROLLBACK=on"]);
        const errors = applied.stderr.split("\n").filter((l) => l.startsWith("ERROR:")).map((l) => l.trim());
        if (errors.length === 0) continue;
        const where = await locate(appDir, script);
        const unforgiven = where === FORGIVEN_SECOND_PASS ? errors.filter((e) => !forgivable(e)) : errors;
        if (unforgiven.length === 0) continue;
        again.push({
          severity: "error",
          path: where,
          message: `cannot be applied a second time, so a correction below it never reaches a database that already exists: ${unforgiven[0]}${
            unforgiven.length > 1 ? ` (and ${unforgiven.length - 1} more)` : ""
          }`,
        });
      }
      return again;
    };

    // Checked, because the next statement to fail would be the app's first
    // migration and the finding would name it: a scratch database that could
    // not be made reads as a migration that could not be applied.
    const scratchDb = await psql("postgres", `DROP DATABASE IF EXISTS ${REPLAY_DB}; CREATE DATABASE ${REPLAY_DB};`);
    if (!scratchDb.ok) throw new Error(`could not create the replay database: ${scratchDb.stderr || scratchDb.stdout}`);

    // First pass: one step at a time, asking the catalog after each.
    for (const [i, script] of scripts.entries()) {
      const where = await locate(appDir, script);
      const applied = await psql(REPLAY_DB, await read(script));
      if (!applied.ok) {
        failures.push({
          severity: "error",
          path: where,
          message: `does not apply to the schema the steps before it built: ${
            (applied.stderr.split("\n").find((l) => l.includes("ERROR")) ?? applied.stderr).trim()
          }`,
        });
        break;
      }
      const state = await psql(
        REPLAY_DB,
        `SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM (${CATALOG}) t;`,
        ["-t", "-A"],
      );
      if (!state.ok) throw new Error(`catalog read after ${script} failed: ${state.stderr}`);
      applied_steps.push({ step: i + 1, mig: where });
      for (const r of JSON.parse(state.stdout) as Omit<Row, "step" | "mig">[]) {
        rows.push({ step: i + 1, mig: where, ...r });
      }
    }

    // Second pass over the schema the first one built: what a correction
    // arriving at a database that already exists would meet.
    const notAgain = failures.length > 0 ? [] : await applyAll();

    // Then the changes the app declares for a schema that already exists.
    // Applied here and nowhere earlier because pgroll reads the live schema to
    // judge an operation — `pgroll validate` needs a database too, so there is
    // no cheaper place for this than the one that already has one.
    //
    // init and baseline first: the schema the steps above built is where these
    // start from, and baseline is what records it as that starting point. A
    // second `migrate` is then a no-op rather than an error, which is the
    // property that lets these migrations be written plainly.
    const declared = await pgrollMigrations(appDir);
    if (declared.includes(BASELINE)) {
      throw new Error(`${PGROLL_DIR}/${BASELINE}.json takes the name this pass baselines the initdb schema under; call it something else`);
    }
    const unapplied: Finding[] = [];
    if (declared.length > 0) {
      const url = `postgres://${user}:${env.POSTGRES_PASSWORD}@localhost:${port}/${REPLAY_DB}?sslmode=disable`;
      const pgroll = (args: string[]) => run("mise", ["x", "--", "pgroll", ...args, "--postgres-url", url], { cwd: appDir });
      const init = await pgroll(["init"]);
      if (!init.ok) throw new Error(`pgroll init failed: ${init.stderr}`);
      // Into a directory of its own, never the app's: baseline writes a
      // placeholder migration beside the ones it finds, and a check that leaves
      // a file in the tree it is grading has changed the thing it measured.
      const baselineDir = await Deno.makeTempDir({ prefix: "pronto-baseline-" });
      const based = await pgroll(["baseline", BASELINE, baselineDir, "--json", "--yes"]);
      await Deno.remove(baselineDir, { recursive: true });
      if (!based.ok) throw new Error(`pgroll baseline failed: ${plain(based.stderr)}`);
      // One at a time, with the catalog read after each, so these steps are
      // compared exactly as the initdb ones are. Applying them in a batch would
      // leave a rename inside a pgroll migration unexamined by the very
      // comparison this pass exists for.
      let step = rows.reduce((highest, r) => Math.max(highest, r.step), 0);
      let applied = { ok: true, stdout: "", stderr: "" };
      for (const name of declared) {
        applied = await pgroll(["start", `${PGROLL_DIR}/${name}.json`, "--complete"]);
        if (!applied.ok) break;
        step += 1;
        const state = await psql(
          REPLAY_DB,
          `SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM (${CATALOG}) t;`,
          ["-t", "-A"],
        );
        if (!state.ok) throw new Error(`catalog read after ${name} failed: ${state.stderr}`);
        applied_steps.push({ step, mig: `${PGROLL_DIR}/${name}.json` });
        for (const r of JSON.parse(state.stdout) as Omit<Row, "step" | "mig">[]) {
          rows.push({ step, mig: `${PGROLL_DIR}/${name}.json`, ...r });
        }
      }
      if (!applied.ok) {
        unapplied.push({
          severity: "error",
          path: PGROLL_DIR,
          message: `does not apply to the schema the migrations built: ${plain(applied.stderr)}`,
        });
      } else {
        // Declared but never run is the failure this would otherwise hide: a
        // migration pgroll skipped is one nobody's database will get either.
        const ran = await psql(REPLAY_DB, "SELECT name FROM pgroll.migrations WHERE migration_type = 'pgroll';", ["-t", "-A"]);
        // An unread ledger is not an empty one. Left unchecked this query's
        // failure — a pgroll whose ledger shape moved under the pin — makes
        // `seen` empty and reports every declared migration as skipped, which
        // is a confident statement about the app built out of a broken read.
        if (!ran.ok) throw new Error(`could not read pgroll's ledger: ${ran.stderr || ran.stdout}`);
        const seen = new Set(ran.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""));
        for (const name of declared) {
          if (!seen.has(name)) {
            unapplied.push({
              severity: "error",
              path: `${PGROLL_DIR}/${name}.json`,
              message: "is declared but pgroll did not apply it",
            });
          }
        }
      }
    }

    const scratch = await Deno.makeTempDir({ prefix: "pronto-replay-" });
    const statesPath = `${scratch}/states.json`;
    const stepsPath = `${scratch}/steps.json`;
    await Deno.writeTextFile(statesPath, JSON.stringify(rows));
    await Deno.writeTextFile(stepsPath, JSON.stringify(applied_steps));
    const query = `CREATE TABLE snapshot AS SELECT * FROM read_json_auto('${statesPath}');\n` +
      `CREATE TABLE step AS SELECT * FROM read_json_auto('${stepsPath}');\n` +
      await Deno.readTextFile(here("replay.sql"));
    const duck = await run("mise", ["x", "--", "duckdb", "-json", "-c", query], { cwd: appDir });
    await Deno.remove(scratch, { recursive: true });
    if (!duck.ok) throw new Error(`duckdb failed: ${duck.stderr}`);

    const moved: Finding[] = duck.stdout === "" ? [] : JSON.parse(duck.stdout);
    const found = [...failures, ...moved, ...notAgain, ...unapplied];
    console.log(JSON.stringify(found, null, 2));
    // Returned rather than exited: Deno.exit tears the isolate down without
    // unwinding, so a `Deno.exit` here would skip the cleanup below and strand
    // a postgres holding a published port — on the failing runs, which are the
    // ones this pass exists to produce.
    return found.some((f) => f.severity === "error") ? 1 : 0;
  } finally {
    await run("docker", ["rm", "-f", container]);
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args[0] ?? "."));
}
