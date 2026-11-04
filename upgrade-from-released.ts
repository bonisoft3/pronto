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

/** `database/host.sh <step> <file>... -- <postgres args>`: the initdb steps by name, to the file(s) each is built from. */
export function databaseSteps(proc: Proc): Record<string, string> {
  const w = shellWords(scriptOf(proc))
  const at = w.findIndex((x) => x.endsWith("/database/host.sh"))
  if (at < 0) throw new Error("the database process does not run mecha's database/host.sh")
  const steps: Record<string, string> = {}
  for (let i = at + 1; i + 1 < w.length && w[i] !== "--"; i += 2) steps[w[i]] = w[i + 1]
  return steps
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
export function upgradeScript(o: {
  oldDir: string
  oldBaseline: string
  oldMigrationsDir: string | undefined
  jobFile: string
  mecha: string
}): string {
  return `set -euo pipefail
# The stack's database, from the address it gives this process (a libpq URL).
url=\${DATABASE_URL#postgres://}; cred=\${url%%@*}; rest=\${url#*@}; hostport=\${rest%%/*}; db=\${rest#*/}
export PGUSER=\${cred%%:*} PGPASSWORD=\${cred#*:} PGHOST=\${hostport%%:*} PGPORT=\${hostport##*:} PGDATABASE=\${db%%\\?*}
export POSTGRES_USER=$PGUSER POSTGRES_DB=$PGDATABASE
${
    o.oldMigrationsDir
      ? `# 1. The database as production has it: what the released commit's migrate step carried it to.
echo "upgrade-from-released: the released commit's pgroll migrations"
(cd ${q(o.oldDir)} && mise x -- bash "$(mise where github:bonisoft3/mecha)/services/migrate/migrate.sh" ${q(o.oldMigrationsDir)} ${q(o.oldBaseline)})`
      : "# 1. The released commit had no pgroll migrations."
  }
# 2. The cluster's initdb finds this marker on a database it built (gcp/schema/gcp.cue's job).
psql -X -v ON_ERROR_STOP=1 -qAc "COMMENT ON DATABASE \\"$PGDATABASE\\" IS 'pronto initdb'"
# 3. This tree, as the release applies it.
echo "upgrade-from-released: this tree's schema job over the released commit's database"
exec bash ${q(o.jobFile)}
`
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
  const steps = databaseSteps(procs.database)
  const stepsDir = `${dir}/initdb`
  await Deno.mkdir(stepsDir, { recursive: true })
  const mecha = (await run(["mise", "where", "github:bonisoft3/mecha"], { cwd: appDir })).out.trim()
  if (!mecha) throw new Error("upgrade-from-released: mise does not place mecha's runtime")
  for (const [step, files] of Object.entries(steps)) {
    let body = ""
    for (const f of files.split("+")) body += await Deno.readTextFile(f.startsWith("{mecha}/") ? `${mecha}/${f.slice(8)}` : `${appDir}/${f}`)
    await Deno.writeTextFile(`${stepsDir}/${step}`, body)
  }
  const newMig = procs.migrate ? migrations(procs.migrate) : undefined
  const migDir = `${dir}/pgroll`
  await Deno.mkdir(migDir, { recursive: true })
  for (const [n, body] of Object.entries(newMig?.files ?? {})) await Deno.writeTextFile(`${migDir}/${n}.json`, body)
  const oldMig = oldCompose.processes.migrate ? migrations(oldCompose.processes.migrate) : undefined
  const oldMigDir = `${dir}/pgroll-released`
  await Deno.mkdir(oldMigDir, { recursive: true })
  for (const [n, body] of Object.entries(oldMig?.files ?? {})) await Deno.writeTextFile(`${oldMigDir}/${n}.json`, body)

  const script = localJob(plan.out, { stepsDir, migrateSh: `${mecha}/services/migrate/migrate.sh`, migrationsDir: migDir, hasMigrate: !!newMig })
  const jobFile = `${dir}/job.sh`
  await Deno.writeTextFile(jobFile, script)
  const upgradeFile = `${dir}/upgrade.sh`
  await Deno.writeTextFile(upgradeFile, upgradeScript({ oldDir, oldBaseline: oldMig?.baseline ?? "", oldMigrationsDir: oldMig ? oldMigDir : undefined, jobFile, mecha }))

  // The tree's own stack, but its database is the released commit's, and its migrate step the upgrade.
  const migrate = procs.migrate ?? { depends_on: { database: { condition: "process_healthy" } }, availability: { exit_on_skipped: true } }
  procs.database = { ...oldCompose.processes.database, working_dir: oldDir }
  procs.migrate = { ...migrate, entrypoint: ["mise", "x", "--", "bash", upgradeFile] }
  const file = `${dir}/process-compose.upgrade.yaml`
  await Deno.writeTextFile(file, stringify(compose))
  return { file, note: `the database starts as ${last.commit.slice(0, 8)} left it (${name.out.trim()}'s last release to production) and this tree's schema job is applied to it` }
}
