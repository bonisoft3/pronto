// Builds a pronto app's edge release into <out> (dist/cloudflare): a Worker in
// front of mecha's edge cluster, one Durable Object running PGlite
// (libraries/mecha/packages/mecha-edge), with the page as its static assets and
// the data directory the object loads once (publish-edge.ts).
//
//   deno run -A --config bundle/deno.json bundle/edge.ts <appDir> --omnishell <dir> --mecha <dir> [--out <dir>] [--domain <host>]
//     [--derived <file> | --from <dir>] [--assets-from <previous-public-dir>]
//
// <out>/public   the terminal and app assets; data requests reach the Worker
// <out>/pglite   pglite-workerd's package, baked from mecha's pinned sources
// <out>/pgdata   rls.sql, the migrations and --derived's rows, applied on disk;
//                or, with --from, a copy of a directory built elsewhere (an
//                archive) with the pgroll migrations its ledger lacks applied
//                (pgdata.ts), the set read from the app's cluster by cue
// <out>/src/index.ts, <out>/wrangler.jsonc
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeEdgeAssets, type StaticAsset } from './edge-assets.ts'
import { addressEdgeAssets, separateAssetDirectories } from './edge-addresses.ts'

function fail(msg: string): never {
  console.error(`edge: ${msg}`)
  Deno.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Deno.args.slice()
const usage = 'usage: edge.ts <appDir> --omnishell <dir> --mecha <dir> [--out <dir>] [--domain <host>] [--derived <file> | --from <dir>] [--assets-from <previous-public-dir>]'
const app = path.resolve(args.shift() ?? fail(usage))
const flags: Record<string, string> = {}
while (args.length) {
  const flag = args.shift()!
  flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
}
for (const flag of Object.keys(flags)) {
  if (!['--omnishell', '--mecha', '--out', '--domain', '--derived', '--from', '--assets-from'].includes(flag)) fail(`unknown flag ${flag}`)
}
const omnishell = path.resolve(flags['--omnishell'] ?? fail('--omnishell names the interpreter root'))
const mecha = path.resolve(flags['--mecha'] ?? fail('--mecha names the mecha root'))
const out = path.resolve(flags['--out'] ?? path.join(app, 'dist/cloudflare'))
const domain = flags['--domain'] ?? ''
const previousAssets = flags['--assets-from'] ? path.resolve(flags['--assets-from']) : undefined
if (previousAssets) separateAssetDirectories(out, previousAssets)

async function run(cmd: string, args: string[], cwd?: string) {
  const r = await new Deno.Command(cmd, { args, cwd, stdout: 'inherit', stderr: 'inherit' }).output()
  if (!r.success) fail(`${cmd} ${args.join(' ')} exited ${r.code}`)
}

const shell = JSON.parse(await Deno.readTextFile(path.join(app, 'shell/shell.json'))) as {
  app?: string
  tables: string[]
  schema?: Record<string, { durability?: string }>
  migrations: string[]
  units?: Record<string, unknown>
}
if (shell.migrations.length === 0) fail('the app has no migration, so no cluster: release it to pages')
// A unit also needs the terminal door's per-unit security headers.
if (Object.keys(shell.units ?? {}).length) fail(`units are not packaged yet: ${Object.keys(shell.units!).join(', ')}`)
const name = shell.app ?? path.basename(app)

await Deno.remove(out, { recursive: true }).catch((e) => { if (!(e instanceof Deno.errors.NotFound)) throw e })
await Deno.mkdir(path.join(out, 'src'), { recursive: true })

// Use the same public files as the container door; the cluster stays remote.
const publicDir = path.join(out, 'public')
const statics = await new Deno.Command('cue', {
  args: ['export', '.', '-e', '{statics: terminal.surface.statics, clusterStatics: cluster.meta.statics}', '--out', 'json'],
  cwd: app, stdout: 'piped', stderr: 'inherit',
}).output()
if (!statics.success) fail('cue export of public assets failed')
const { statics: terminalStatics, clusterStatics } = JSON.parse(new TextDecoder().decode(statics.stdout)) as { statics: StaticAsset[]; clusterStatics: StaticAsset[] }
await writeEdgeAssets(app, omnishell, publicDir, [...terminalStatics, ...clusterStatics])
const hints = await addressEdgeAssets(publicDir, previousAssets)
await Deno.writeTextFile(path.join(out, 'src/hints.json'), JSON.stringify(hints))

// PGlite for workerd. Bake reads the project's compose from its .bayt/, and a
// local export adds to its destination, which is fresh here.
const pglite = path.join(out, 'pglite')
const workerd = path.join(mecha, 'packages/pglite-workerd')
await run('docker', ['buildx', 'bake', `--allow=fs.read=${workerd}`, `--allow=fs.write=${out}`, '-f', 'compose.yaml', '--set', `package.output=type=local,dest=${pglite}`, 'package'], path.join(workerd, '.bayt'))
await Deno.remove(path.join(pglite, '.bayt'), { recursive: true })

// An archive's missing migrations are the cluster's pgroll set less its ledger.
const pgroll = path.join(out, 'pgroll.json')
if (flags['--from']) {
  const r = await new Deno.Command('cue', { args: ['export', '.', '-e', 'cluster.state.pgroll', '--out', 'json'], cwd: app, stdout: 'piped', stderr: 'inherit' }).output()
  if (!r.success) fail(`cue export of cluster.state.pgroll exited ${r.code}`)
  await Deno.writeFile(pgroll, r.stdout)
}
const cluster = path.join(mecha, 'packages/mecha-browser')
await run(Deno.execPath(), [
  'run', '-A', '--config', path.join(cluster, 'cluster.deno.json'), '--lock', path.join(cluster, 'deno.lock'), '--frozen',
  path.join(here, 'pgdata.ts'), app, '--mecha', mecha, '--out', path.join(out, 'pgdata'),
  ...(flags['--derived'] ? ['--derived', path.resolve(flags['--derived'])] : []),
  ...(flags['--from'] ? ['--from', path.resolve(flags['--from']), '--pgroll', pgroll] : []),
])

const rel = (p: string) => {
  const r = path.relative(out, p)
  return r.startsWith('.') ? r : `./${r}`
}
const fromSrc = (p: string) => path.relative(path.join(out, 'src'), p)
await Deno.writeTextFile(path.join(out, 'src/index.ts'), `// Written by pronto's edge.ts for ${name}.
import { edgeObject } from '${fromSrc(path.join(mecha, 'packages/mecha-edge/src/object.ts'))}'
import { edgeWorker } from '${fromSrc(path.join(mecha, 'packages/mecha-edge/src/worker.ts'))}'
import { edgeHints } from '${fromSrc(path.join(here, 'edge-hints.ts'))}'
import { routeAt } from '${fromSrc(path.join(omnishell, 'interpreter/fragment.js'))}'
import hints from './hints.json'
import pgliteWasm from '../pglite/pglite.wasm'
import initdbWasm from '../pglite/initdb.wasm'
import pgliteData from '../pglite/pglite.data'
import icu from '../pglite/icu-root.tgz'

export const Cluster = edgeObject({
  assets: { pgliteWasm, initdbWasm, pgliteData, icu },
  tables: ${JSON.stringify(shell.tables)},
  schema: ${JSON.stringify(Object.fromEntries(Object.entries(shell.schema ?? {}).map(([t, s]) => [t, { durability: s.durability }])))},
})
export default {
  async fetch(req, env, ctx) {
    const response = await edgeWorker.fetch(req, env, ctx)
    if (req.method !== 'GET' || response.status !== 200 ||
        !(response.headers.get('content-type') ?? '').includes('text/html') ||
        !(req.headers.get('sec-fetch-mode') === 'navigate' || (req.headers.get('accept') ?? '').includes('text/html'))) return response
    const result = new Response(response.body, response)
    result.headers.set('Link', edgeHints(req, hints, routeAt))
    return result
  },
}
`)
await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({
  name,
  main: 'src/index.ts',
  compatibility_date: '2026-09-01',
  // No asset matches a route of the page or the cluster's: those reach the
  // Worker, which answers a navigation with the document (mecha-edge's worker.ts).
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: ['/'] },
  durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] },
  version_metadata: { binding: 'CF_VERSION_METADATA' },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }],
  observability: { enabled: true },
  ...(domain ? { routes: [{ pattern: domain, custom_domain: true }] } : { workers_dev: true }),
  rules: [
    { type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false },
    { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false },
  ],
  // mecha's sources import these by bare name.
  alias: {
    '@electric-sql/pglite': './pglite/index.js',
    '@electric-sql/pglite/basefs': './pglite/fs/base.js',
    '@mecha/postgrest-js': rel(path.join(mecha, 'packages/postgrest-js/src/index.ts')),
  },
}, null, 2) + '\n')
console.error(`edge: ${out}`)
