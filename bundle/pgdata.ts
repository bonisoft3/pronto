// Writes the data directory an edge release loads into its object: rls.sql, the
// app's migrations (mecha's schedule table before the seed that fills it, where
// the program declares schedules), the cluster's pgroll set and, with --derived,
// the rows derived.ts wrote, applied by npm's PGlite to a directory on disk, as
// the page's cluster applies them in a tab. Runs under the cluster's pins: the
// same Postgres the object runs.
//
// The directory records what it applied, by name and digest, in the ledger
// the docker appliance keeps (pglite-workerd's scripts.ts), which a later
// release's publish reads to carry a directory the object kept forward. The
// scripts and their order are edge-scripts.ts's, which the publish's payload
// shares: files, then the pgroll set, as a fresh volume's initdb and migrate
// steps run them.
//
// --from starts from a copy of a directory built elsewhere instead, an archive
// restored from its database with its ledger (pglite-workerd's restore.ts),
// and applies the release's scripts that ledger lacks, files then pgroll, as a
// publish applies them to a kept directory (pglite-workerd's applyScripts):
// the same carry, run here so the directory is loaded complete.
//
//   DENO_NO_PACKAGE_JSON=1 deno run -A --no-config --import-map <mecha>/packages/mecha-browser/cluster.deno.json --lock <mecha>/packages/mecha-browser/deno.lock --frozen \
//     bundle/pgdata.ts <appDir> --mecha <dir> --out <dir> --pgroll <file> [--derived <file>] [--from <dir>]
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

function fail(msg: string): never {
  console.error(`pgdata: ${msg}`)
  Deno.exit(1)
}

const args = Deno.args.slice()
const app = path.resolve(args.shift() ?? fail('usage: pgdata.ts <appDir> --mecha <dir> --out <dir> --pgroll <file> [--derived <file>] [--from <dir>]'))
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
const { clusterSteps, releaseScripts } = await import('./edge-scripts.ts')
const release = await releaseScripts(app, mecha, shell.migrations, pgrollSet, await clusterSteps(path.join(app, '.pronto/cluster.json')))

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
const { applyScripts, recordScripts, UnrunnableScript } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/scripts.ts'))))
if (from) {
  const applied = await applyScripts(db, release.scripts, (l: string) => console.error(`pgdata: ${l}`))
  console.error(`pgdata: ${applied.length} scripts applied over ${from}`)
} else {
  for (const script of release.scripts) {
    if (script.sql === null) throw new UnrunnableScript(script.name, 'an operation')
    await db.exec(browserTier(script.sql))
  }
  if (derived) await db.exec(browserTier(await Deno.readTextFile(path.resolve(derived))))
  await recordScripts(db, release.scripts)
  await db.exec('VACUUM ANALYZE')
}
const { closeTrimmed } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/restore.ts'))))
await closeTrimmed(db, out)
console.error(`pgdata: ${out}, ${from ? `from ${from}` : `${release.files.length} files and ${release.pgroll.length} pgroll migrations`}`)
