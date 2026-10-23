// Writes the data directory an edge release loads into its object: rls.sql, the
// app's migrations (mecha's schedule table before the seed that fills it, where
// the program declares schedules) and, with --derived, the rows derived.ts wrote, applied by
// npm's PGlite to a directory on disk, as the page's cluster applies them in a
// tab. Runs under the cluster's pins: the same Postgres the object runs.
//
// Either way the directory records what it applied, by name and digest, in
// the ledger the docker appliance keeps (pglite-workerd's scripts.ts), which
// a later release's publish reads to carry a directory the object kept
// forward: the pgroll migrations it lacks, as the cluster's migrate step
// carries a volume. A directory built fresh applies the cluster's pgroll set
// after its files, as a fresh volume's migrate step does. The scripts and
// their order are edge-scripts.ts's, which the publish's payload shares. An
// archive records the release's digests: what its database applied is the
// restore's to establish, and the pgroll set is what it is carried by.
//
// --from starts from a copy of a directory built elsewhere (an archive restored
// from its database, its pgroll ledger included) instead, and applies the app's
// pgroll migrations (--pgroll, the cluster's state.pgroll as JSON) its ledger
// lacks, as the cluster's migrate step would (pglite-workerd's migrate.ts).
//
//   deno run -A --config <mecha>/packages/mecha-browser/cluster.deno.json --lock <mecha>/packages/mecha-browser/deno.lock --frozen \
//     bundle/pgdata.ts <appDir> --mecha <dir> --out <dir> --pgroll <file> [--derived <file>] [--from <dir>]
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
const pgrollSet = JSON.parse(await Deno.readTextFile(path.resolve(flags['--pgroll'] ?? fail('--pgroll names the cluster\'s pgroll set')))) as Record<string, { operations: Record<string, unknown>[] }>
if (from && derived) fail("--derived refills tables an archive already holds")

const browser = (p: string) => import(String(pathToFileURL(path.join(mecha, 'packages/mecha-browser', p))))
const { createDatabase } = await browser('src/database.ts')
const { browserTier } = await browser('fence.ts') as { browserTier: (sql: string) => string }

const shell = JSON.parse(await Deno.readTextFile(path.join(app, 'shell/shell.json'))) as { migrations: string[] }
const { releaseScripts } = await import('./edge-scripts.ts')
const release = await releaseScripts(app, mecha, shell.migrations, pgrollSet)

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
const { recordScripts, UnrunnableScript } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/scripts.ts'))))
if (from) {
  // The archive's database applied the files on its container; what it
  // lacks of the pgroll set is applied here against its own ledger.
  const { migrate } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/migrate.ts'))))
  await migrate(db, pgrollSet, (l: string) => console.error(`pgdata: ${l}`))
} else {
  for (const { sql } of release.files) await db.exec(browserTier(sql))
  for (const script of release.pgroll) {
    if (script.sql === null) throw new UnrunnableScript(script.name, 'an operation')
    await db.exec(browserTier(script.sql))
  }
  if (derived) await db.exec(browserTier(await Deno.readTextFile(path.resolve(derived))))
}
await recordScripts(db, [...release.files, ...release.pgroll])
if (!from) await db.exec('VACUUM ANALYZE')
const { closeTrimmed } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/restore.ts'))))
await closeTrimmed(db, out)
console.error(`pgdata: ${out}, ${from ? `from ${from}` : `${release.files.length} files and ${release.pgroll.length} pgroll migrations`}`)
