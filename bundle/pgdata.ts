// Writes the data directory an edge release loads into its object: rls.sql, the
// app's migrations (mecha's schedule table before the seed that fills it, where
// the program declares schedules) and, with --derived, the rows derived.ts wrote, applied by
// npm's PGlite to a directory on disk, as the page's cluster applies them in a
// tab. Runs under the cluster's pins: the same Postgres the object runs.
//
// --from starts from a copy of a directory built elsewhere (an archive restored
// from its database, its pgroll ledger included) instead, and applies the app's
// pgroll migrations (--pgroll, the cluster's state.pgroll as JSON) its ledger
// lacks, as the cluster's migrate step would (pglite-workerd's migrate.ts).
//
//   deno run -A --config <mecha>/packages/mecha-browser/cluster.deno.json --lock <mecha>/packages/mecha-browser/deno.lock --frozen \
//     bundle/pgdata.ts <appDir> --mecha <dir> --out <dir> [--derived <file>] [--from <dir> --pgroll <file>]
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

function fail(msg: string): never {
  console.error(`pgdata: ${msg}`)
  Deno.exit(1)
}

const args = Deno.args.slice()
const app = path.resolve(args.shift() ?? fail('usage: pgdata.ts <appDir> --mecha <dir> --out <dir> [--derived <file>] [--from <dir> --pgroll <file>]'))
const flags: Record<string, string> = {}
while (args.length) {
  const flag = args.shift()!
  flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
}
for (const flag of Object.keys(flags)) if (!['--mecha', '--out', '--derived', '--from', '--pgroll'].includes(flag)) fail(`unknown flag ${flag}`)
const mecha = path.resolve(flags['--mecha'] ?? fail('--mecha names the mecha root'))
const out = path.resolve(flags['--out'] ?? fail('--out names the directory to write'))
const derived = flags['--derived']
const from = flags['--from'] ? path.resolve(flags['--from']) : null
if (Boolean(flags['--pgroll']) !== Boolean(from)) fail('--from and --pgroll go together')
if (from && derived) fail("--derived refills tables an archive already holds")

const browser = (p: string) => import(String(pathToFileURL(path.join(mecha, 'packages/mecha-browser', p))))
const { createDatabase } = await browser('src/database.ts')
const { browserTier } = await browser('fence.ts') as { browserTier: (sql: string) => string }

const shell = JSON.parse(await Deno.readTextFile(path.join(app, 'shell/shell.json'))) as { migrations: string[] }
// The schedule seed is fenced container-tier for the page, which runs no
// clock. The object runs the ticker, so it takes the seed whole, after
// mecha's table — the container image's 800 step — which the seed fills.
const SCHEDULE_SEED = '801_schedule_seed.sql'
const steps: { file: string; fenced: boolean }[] = from
  ? []
  : [
    { file: path.join(mecha, 'services/database/rls/rls.sql'), fenced: true },
    ...shell.migrations.flatMap((m) => path.basename(m) === SCHEDULE_SEED
      ? [{ file: path.join(mecha, 'services/ticker/schedule.sql'), fenced: false }, { file: path.join(app, m), fenced: false }]
      : [{ file: path.join(app, m), fenced: true }]),
    ...(derived ? [{ file: path.resolve(derived), fenced: true }] : []),
  ]

async function copy(src: string, dst: string) {
  await Deno.mkdir(dst)
  for await (const e of Deno.readDir(src)) {
    if (e.isDirectory) await copy(path.join(src, e.name), path.join(dst, e.name))
    else if (e.isFile) await Deno.copyFile(path.join(src, e.name), path.join(dst, e.name))
    else fail(`${path.join(src, e.name)} is neither file nor directory`)
  }
}

await Deno.remove(out, { recursive: true }).catch((e) => { if (!(e instanceof Deno.errors.NotFound)) throw e })
await Deno.mkdir(path.dirname(out), { recursive: true })
if (from) await copy(from, out)
const db = await createDatabase({ dataDir: out })
for (const step of steps) {
  const sql = await Deno.readTextFile(step.file)
  await db.exec(step.fenced ? browserTier(sql) : sql)
}
if (from) {
  const { migrate } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/migrate.ts'))))
  await migrate(db, JSON.parse(await Deno.readTextFile(path.resolve(flags['--pgroll']))), (l: string) => console.error(`pgdata: ${l}`))
}
if (!from) await db.exec('VACUUM ANALYZE')
const { closeTrimmed } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/restore.ts'))))
await closeTrimmed(db, out)
console.error(`pgdata: ${out}, ${from ? `from ${from}` : `${steps.length} steps`}`)
