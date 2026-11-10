// integrate@local's upgrade from the last release. A fresh initdb is not what production runs: its
// database was built by the last released commit and is carried forward, on each release, by the
// schema job (gcp/schema/gcp.cue's `job`): the re-runnable initdb steps replayed, then the pgroll
// migrations the database lacks. A change that a fresh build takes and that job refuses (Postgres
// refuses CREATE OR REPLACE FUNCTION when the result columns change: attribution_funnel(), 2026-11-03)
// first showed up in a release. So the local stack starts its database from the last released
// commit's own build (its `database` and `migrate` processes) and the tree under test is applied to
// it as the release applies it: the job's own script, rendered by the tree's plan, over this tree's
// initdb files and migrations. The scenarios then run against the database that came out.
//
//   prepare(...) returns the process-compose file the stack runs: the tree's own, with its `database`
//   process the released commit's and its `migrate` process that upgrade. Or, where there is no
//   released commit to start from, a message saying so and the tree's own file untouched: never a
//   silent pass.

import { parse, stringify } from "jsr:@std/yaml@1.0.5";

export type Record_ = { commit: string; outcome: string; preview: string; dirty: boolean; started: string };

/**
 * The commit production runs, from an app's release record (gcp/release-record.nu): the last
 * release that went live to production (no preview) from a clean checkout. A dirty one is not a
 * commit anyone can get back, so the one before it.
 */
export function lastReleased(jsonl: string): { commit: string } | { skip: string } {
  const live = jsonl.split("\n").filter((l) => l.trim()).flatMap((l) => {
    try {
      return [JSON.parse(l) as Record_]
    } catch {
      return []
    }
  }).filter((r) => r.outcome === "live" && !r.preview)
  if (live.length === 0) return { skip: "the release record holds no release that went live" }
  const clean = live.filter((r) => !r.dirty && /^[0-9a-f]{40}$/.test(r.commit ?? ""))
  if (clean.length === 0) return { skip: "every live release in the record was made from a dirty or unknown checkout" }
  return { commit: clean[clean.length - 1].commit }
}

/** A shell command line's words, as the database and migrate entrypoints write them: single quotes only. */
export function shellWords(s: string): string[] {
  return [...s.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2])
}

// deno-lint-ignore no-explicit-any
type Proc = any

/** The script a process-compose process runs: the last word of its `sh -c` entrypoint. */
export function scriptOf(proc: Proc): string {
  const e: string[] = proc?.entrypoint ?? []
  const i = e.lastIndexOf("-c")
  if (i < 0 || i === e.length - 1) throw new Error("the process runs no `sh -c` script")
  return e[i + 1]
}

/** The initdb steps a database process builds, by name, to the file(s) each is built from (`+` joins files), and the postgres arguments it runs. */
export type Database = { steps: Record<string, string>; args: string[] }

/**
 * The database process's initdb steps and postgres arguments, in either form a stack has had:
 *  - mecha before 0.22: `database/host.sh <step> <file>... -- <postgres args>`;
 *  - mecha 0.22: a nu script that copies mecha's rls.sql and role_passwords.sh to their steps, copies
 *    the app's own steps from `.bayt/bayt.database.json`'s `dockerfile.copy.0.srcs` (`srcs`, the
 *    app's folder's files, each its own step by its basename) and execs `services/database/entrypoint.nu
 *    <initdb> postgres <args>`.
 * `srcs` is that list, read by the caller from the app's folder.
 */
export function databaseProcess(proc: Proc, srcs: string[] = []): Database {
  const script = scriptOf(proc)
  const w = shellWords(script)
  const at = w.findIndex((x) => x.endsWith("/database/host.sh"))
  if (at >= 0) {
    const steps: Record<string, string> = {}
    let i = at + 1
    for (; i + 1 < w.length && w[i] !== "--"; i += 2) steps[w[i]] = w[i + 1]
    return { steps, args: w.slice(i + 1) }
  }
  // process-compose's `$$` is a literal `$` to the shell it runs.
  const nu = script.replaceAll("$$", "$")
  const exec = nu.match(/exec nu \([^)]*\) \$initdb\s+postgres\s*(.*)$/m)
  if (!exec || !nu.includes("services/database/entrypoint.nu")) {
    throw new Error("the database process runs neither mecha's database/host.sh nor its services/database/entrypoint.nu")
  }
  const steps: Record<string, string> = {}
  for (const m of nu.matchAll(/cp -f \(\$mecha \| path join '([^']+)'\) \(\$initdb \| path join '([^']+)'\)/g)) steps[m[2]] = `{mecha}/${m[1]}`
  if (nu.includes("bayt.database.json")) for (const f of srcs) steps[f.split("/").pop()!] = f
  return { steps, args: shellWords(exec[1]) }
}

/**
 * The migrate process's baseline and pgroll migrations, in either form a stack has had: mecha before
 * 0.22's `migrate/host.sh` (above), or 0.22's `services/migrate/migrate.nu`, whose migrations are the
 * app's own files (`.bayt/bayt.migrate.json`: a `copy` of each, and the `epilogue`'s heredocs for
 * those the app holds only in the file) that the process lays in one directory before it runs.
 * `base` is the app folder the process belongs to.
 */
export async function migrationsOf(proc: Proc, base: string): Promise<{ baseline: string; files: Record<string, string> }> {
  const script = scriptOf(proc)
  if (shellWords(script).some((x) => x.endsWith("/migrate/host.sh"))) return migrations(proc)
  if (!script.includes("bayt.migrate.json") || !script.includes("migrate.nu")) {
    throw new Error("the migrate process runs neither mecha's migrate/host.sh nor its services/migrate/migrate.nu")
  }
  const baseline = script.match(/\^(?:nu|bash) \$+script \$+dir (\S+)/)?.[1]
  if (!baseline) throw new Error("the migrate process names no baseline step")
  const dockerfile = JSON.parse(await Deno.readTextFile(`${base}/.bayt/bayt.migrate.json`)).dockerfile ?? {}
  const files: Record<string, string> = {}
  const keep = (name: string, body: string) => { files[name.replace(/\.json$/, "")] = body }
  for (const c of dockerfile.copy ?? []) keep(String(c.dst).split("/").pop()!, await Deno.readTextFile(`${base}/${c.srcs[0]}`))
  for (const e of dockerfile.epilogue ?? []) {
    const lines = String(e).split("\n")
    let m
    if ((m = lines[0].match(/^COPY <<'PGROLL' \/tmp\/(.+)\.parts$/))) {
      const body = []
      for (const l of lines.slice(1)) { if (l === "PGROLL") break; body.push(l) }
      keep(m[1], atob(body.join("")))
    } else if ((m = lines[0].match(/^COPY <<'PGROLL' \/pgroll\/(.+)$/))) keep(m[1], lines[1])
    else if ((m = lines[0].match(/^COPY <<'RECONCILE' \/pgroll\/(.+)$/))) keep(m[1], lines.slice(1, -1).join("\n"))
  }
  return { baseline, files }
}

/** The initdb steps by name, to the file(s) each is built from. */
export function databaseSteps(proc: Proc, srcs: string[] = []): Record<string, string> {
  return databaseProcess(proc, srcs).steps
}

/** `migrate/host.sh <baseline> [<name> <base64 JSON>]...`: the baseline and the pgroll migrations by name. */
export function migrations(proc: Proc): { baseline: string; files: Record<string, string> } {
  const w = shellWords(scriptOf(proc))
  const at = w.findIndex((x) => x.endsWith("/migrate/host.sh"))
  if (at < 0) throw new Error("the migrate process does not run mecha's migrate/host.sh")
  const files: Record<string, string> = {}
  for (let i = at + 2; i + 1 < w.length; i += 2) files[w[i]] = atob(w[i + 1])
  return { baseline: w[at + 1], files }
}

/**
 * The schema job's script (the plan's jobYaml, gcp/schema/gcp.cue) as it runs on this host: the
 * initdb directory and the migrate runner are where the image has them, and the cluster's
 * connection (Cloud SQL's socket, Secret Manager's password) is the stack's database. Anything
 * else the job does it does here as it is written, with the migrate process's own environment in
 * place of its settings; a job whose shape this cannot place is refused.
 */
export function localJob(jobYaml: string, o: { stepsDir: string; migrateSh: string; migrationsDir: string; hasMigrate: boolean }): string {
  const job = parse(jobYaml) as Proc
  const c = job?.spec?.template?.spec?.template?.spec?.containers?.[0]
  const script: string | undefined = c?.command?.[2]
  if (!script || c.command[0] !== "bash") throw new Error("the schema job is not `bash -c <script>`: upgrade-from-released cannot place it")
  if (!script.includes("/docker-entrypoint-initdb.d")) throw new Error("the schema job replays no /docker-entrypoint-initdb.d step: upgrade-from-released cannot place it")
  let out = script.replaceAll("/docker-entrypoint-initdb.d", o.stepsDir)
  const runner = '"/migrate.sh" "/pgroll"'
  if (o.hasMigrate) {
    if (!out.includes(runner)) throw new Error(`the schema job no longer runs ${runner}: upgrade-from-released cannot place it`)
    out = out.replace(runner, `bash ${JSON.stringify(o.migrateSh)} ${JSON.stringify(o.migrationsDir)}`)
  }
  return out
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** The migrate process's replacement: the released commit's pgroll migrations, then the release's job. */
/** The initdb step a test database's rows are (emit.cue: #App.state.fixture). */
export const FIXTURE = "950_fixture.sql"

export function upgradeScript(o: {
  oldDir: string
  oldBaseline: string
  oldMigrationsDir: string | undefined
  jobFile: string
  mecha: string
  // This tree's test rows (#App.state.fixture), which the released commit's database was built with
  // its own commit's of: a test database holds the tree's, applied over it once the job has run.
  fixtureFile?: string
}): string {
  return `set -euo pipefail
# The stack's database, from the address it gives this process (a libpq URL).
# An app with no pgroll migrations has no migrate step, so no address: the database process's own.
: "\${DATABASE_URL:=postgres://\${POSTGRES_USER:-postgres}:\${POSTGRES_PASSWORD:-postgres}@127.0.0.1:\${PGPORT:-0}/\${POSTGRES_DB:-postgres}?sslmode=disable}"
export DATABASE_URL
url=\${DATABASE_URL#postgres://}; cred=\${url%%@*}; rest=\${url#*@}; hostport=\${rest%%/*}; db=\${rest#*/}
export PGUSER=\${cred%%:*} PGPASSWORD=\${cred#*:} PGHOST=\${hostport%%:*} PGPORT=\${hostport##*:} PGDATABASE=\${db%%\\?*}
export POSTGRES_USER=$PGUSER POSTGRES_DB=$PGDATABASE
${
    o.oldMigrationsDir
      ? `# 1. The database as production has it: what the released commit's migrate step carried it to.
echo "upgrade-from-released: the released commit's pgroll migrations"
(mise x -- bash "$(mise where github:bonisoft3/mecha)/services/migrate/migrate.sh" ${q(o.oldMigrationsDir)} ${q(o.oldBaseline)})`
      : "# 1. The released commit had no pgroll migrations."
  }
# 2. The cluster's initdb finds this marker on a database it built (gcp/schema/gcp.cue's job).
psql -X -v ON_ERROR_STOP=1 -qAc "COMMENT ON DATABASE \\"$PGDATABASE\\" IS 'pronto initdb'"
# 3. This tree, as the release applies it. Its replays are no migrations: pgroll's ledger gains
# no inferred one from them, or every release lengthens the chain pgroll walks (2026-11-04).
inferred() {
  if [ "$(psql -XtAc "SELECT to_regclass('pgroll.migrations') IS NOT NULL")" = t ]; then
    psql -XtAc "SELECT count(*) FROM pgroll.migrations WHERE migration_type = 'inferred'"
  else echo 0; fi
}
before=$(inferred)
echo "upgrade-from-released: this tree's schema job over the released commit's database"
bash ${q(o.jobFile)}
after=$(inferred)
if [ "$after" != "$before" ]; then
  echo "upgrade-from-released: the schema job left $((after - before)) inferred pgroll migrations: its replays ran with pgroll's capture on (it skips only pgroll.no_inferred_migrations = 'TRUE')" >&2
  exit 1
fi
${
    o.fixtureFile
      ? `# 4. This tree's test rows: the released commit's database holds that commit's, and a release's
# initdb skips them, so a stack under test would otherwise run on the old ones (Studio's visual-lint
# app, PRONTO-57).
echo "upgrade-from-released: this tree's fixture"
psql -X -v ON_ERROR_STOP=1 -q -f ${q(o.fixtureFile)}`
      : "# 4. The tree has no fixture."
  }
# PostgREST reads its schema once (migrate.sh tells it too, where there are pgroll migrations).
psql -X -qAc "NOTIFY pgrst, 'reload schema'"
`
}

/** The app's own initdb step files (`.bayt/bayt.database.json`), where it has that file: mecha 0.22's database process. */
async function databaseSrcs(dir: string): Promise<string[]> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/.bayt/bayt.database.json`))?.dockerfile?.copy?.[0]?.srcs ?? []
  } catch {
    return []
  }
}

const run = async (cmd: string[], opts: Deno.CommandOptions = {}) => {
  const out = await new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "piped", ...opts }).output()
  return { ok: out.success, out: new TextDecoder().decode(out.stdout), err: new TextDecoder().decode(out.stderr) }
}

export type Prepared = { file: string; note: string } | { skip: string }

/**
 * The process-compose file for an upgrade run, written in `dir`, or why there is none.
 * `appDir` is the app the stack runs; `gateDir` the checkout it is a copy of (the same, off a slot).
 */
export async function prepare(appDir: string, gateDir: string, dir: string, releases = `${Deno.env.get("HOME")}/.cache/pronto/releases`): Promise<Prepared> {
  const compose = parse(await Deno.readTextFile(`${appDir}/.bayt/process-compose.yaml`)) as Proc
  const procs = compose.processes ?? {}
  if (!procs.database) return { skip: "the app has no database" }
  const cue = (expr: string, ...more: string[]) => run(["cue", "export", "--expression", expr, "--out", "text", ...more, "./release.cue"], { cwd: appDir })
  const name = await cue("GCP.name")
  if (!name.ok) return { skip: "the app releases to no gcp project (GCP.name is not defined), so no release to start from" }
  const record = `${releases}/${name.out.trim()}.jsonl`
  let text: string
  try {
    text = await Deno.readTextFile(record)
  } catch {
    return { skip: `no release record at ${record}: this machine has released nothing of the app` }
  }
  const last = lastReleased(text)
  if ("skip" in last) return { skip: `${record}: ${last.skip}` }
  const top = (await run(["git", "-C", gateDir, "rev-parse", "--show-toplevel"]))
  if (!top.ok) return { skip: `${gateDir} is no git checkout, so the released commit cannot be read` }
  const root = await Deno.realPath(top.out.trim())
  const rel = (await Deno.realPath(gateDir)).slice(root.length + 1)
  if (!(await run(["git", "-C", root, "cat-file", "-e", `${last.commit}^{commit}`])).ok) {
    return { skip: `the released commit ${last.commit} is not in ${root}; fetch it to run the upgrade` }
  }
  // The released commit's app folder, as it was.
  const old = `${dir}/released`
  await Deno.mkdir(old, { recursive: true })
  const archive = new Deno.Command("git", { args: ["-C", root, "archive", last.commit, "--", rel || "."], stdout: "piped" }).spawn()
  const untar = new Deno.Command("tar", { args: ["-x", "-C", old], stdin: "piped", stderr: "piped" }).spawn()
  await archive.stdout.pipeTo(untar.stdin)
  if (!(await untar.output()).success) return { skip: `the released commit ${last.commit} could not be unpacked` }
  const oldDir = rel ? `${old}/${rel}` : old
  let oldCompose: Proc
  try {
    oldCompose = parse(await Deno.readTextFile(`${oldDir}/.bayt/process-compose.yaml`))
  } catch {
    return { skip: `the released commit ${last.commit} has no .bayt/process-compose.yaml: it predates the host stack` }
  }
  if (!oldCompose.processes?.database) return { skip: `the released commit ${last.commit} had no database` }

  // The job as this tree's plan renders it, over this tree's initdb files and migrations.
  // What the release adds to release.cue's plan before it renders the job (gcp/release.nu's base-of and
  // render-staged): the roles and replays generate wrote, and the migrate step where the app runs one.
  const facts = JSON.parse(await Deno.readTextFile(`${appDir}/.pronto/cluster.json`))
  const data = `${dir}/plan-data.json`
  await Deno.writeTextFile(data, JSON.stringify({ GCP: { database: { tokenRoles: facts.tokenRoles, replays: facts.replays ?? [] }, ...(procs.migrate ? { migrate: { env: {} } } : {}) } }))
  const plan = await cue("gcpRelease.plan.jobYaml", data)
  if (!plan.ok) throw new Error(`upgrade-from-released: ${appDir}/release.cue renders no schema job: ${plan.err}`)
  const mecha = (await run([Deno.env.get("SAYT_MISE_BIN") ?? "mise", "where", "github:bonisoft3/mecha"], { cwd: appDir })).out.trim()
  if (!mecha) throw new Error("upgrade-from-released: mise does not place mecha's runtime")
  // The steps of a folder's database process, written to `dest` as the database's initdb directory.
  const build = async (proc: Proc, base: string, dest: string) => {
    const db = databaseProcess(proc, await databaseSrcs(base))
    await Deno.mkdir(dest, { recursive: true })
    for (const [step, files] of Object.entries(db.steps)) {
      let body = ""
      for (const f of files.split("+")) body += await Deno.readTextFile(f.startsWith("{mecha}/") ? `${mecha}/${f.slice(8)}` : `${base}/${f}`)
      await Deno.writeTextFile(`${dest}/${step}`, body)
    }
    return db
  }
  const stepsDir = `${dir}/initdb`
  const steps = (await build(procs.database, appDir, stepsDir)).steps
  const oldInitdb = `${dir}/initdb-released`
  const oldDb = await build(oldCompose.processes.database, oldDir, oldInitdb)
  const newMig = procs.migrate ? await migrationsOf(procs.migrate, appDir) : undefined
  const migDir = `${dir}/pgroll`
  await Deno.mkdir(migDir, { recursive: true })
  for (const [n, body] of Object.entries(newMig?.files ?? {})) await Deno.writeTextFile(`${migDir}/${n}.json`, body)
  const oldMig = oldCompose.processes.migrate ? await migrationsOf(oldCompose.processes.migrate, oldDir) : undefined
  const oldMigDir = `${dir}/pgroll-released`
  await Deno.mkdir(oldMigDir, { recursive: true })
  for (const [n, body] of Object.entries(oldMig?.files ?? {})) await Deno.writeTextFile(`${oldMigDir}/${n}.json`, body)

  const script = localJob(plan.out, { stepsDir, migrateSh: `${mecha}/services/migrate/migrate.sh`, migrationsDir: migDir, hasMigrate: !!newMig })
  const jobFile = `${dir}/job.sh`
  await Deno.writeTextFile(jobFile, script)
  const upgradeFile = `${dir}/upgrade.sh`
  const fixtureFile = steps[FIXTURE] ? `${stepsDir}/${FIXTURE}` : undefined
  await Deno.writeTextFile(upgradeFile, upgradeScript({ oldDir, oldBaseline: oldMig?.baseline ?? "", oldMigrationsDir: oldMig ? oldMigDir : undefined, jobFile, mecha, fixtureFile }))

  // The tree's own stack, but its database is the released commit's, and its migrate step the upgrade.
  const migrate = procs.migrate ?? { depends_on: { database: { condition: "process_healthy" } }, availability: { exit_on_skipped: true }, environment: procs.database.environment }
  // Postgres from the released commit's initdb steps, built by mecha's own entrypoint (the released commit's
  // own process may run a mecha runtime this one no longer carries).
  // The tools are this tree's (its mise, as the tree's own database process runs it): the released commit's mise
  // config names the tools of its own mecha (a Postgres without the plv8 the released steps create), and every
  // path the steps use is absolute.
  procs.database = {
    ...procs.database,
    environment: oldCompose.processes.database.environment ?? procs.database.environment,
    // The initdb directory is where the tree's own database process puts its (BAYT_LOCAL_WORK_DIR/initdb.d),
    // which the `replay` check reads: here it holds the released commit's steps.
    entrypoint: [
      "mise", "x", "--", "nu", "-c",
      `let initdb = (($env.BAYT_LOCAL_WORK_DIR? | default $nu.temp-dir) | path join 'initdb.d'); rm -rf $initdb; cp -r '${oldInitdb}' $initdb; ` +
        `exec nu '${mecha}/services/database/entrypoint.nu' $initdb postgres ${oldDb.args.map((a) => `'${a}'`).join(" ")}`,
    ],
  }
  procs.migrate = { ...migrate, entrypoint: ["mise", "x", "--", "bash", upgradeFile] }
  const file = `${dir}/process-compose.upgrade.yaml`
  await Deno.writeTextFile(file, stringify(compose))
  return { file, note: `the database starts as ${last.commit.slice(0, 8)} left it (${name.out.trim()}'s last release to production) and this tree's schema job is applied to it` }
}
