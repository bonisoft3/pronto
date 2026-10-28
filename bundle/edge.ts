// Builds a pronto app's edge release into <out> (dist/cloudflare): a Worker in
// front of mecha's edge cluster, one Durable Object running PGlite
// (libraries/mecha/packages/mecha-edge), with the page as its static assets and
// the data directory the object loads once (publish-edge.ts).
//
//   deno run -A --config bundle/deno.json bundle/edge.ts <appDir> --omnishell <dir> --mecha <dir> --ice-servers <json> [--out <dir>] [--domain <host>]
//     [--derived <file> | --from <dir>] [--assets-from <previous-public-dir>] [--ssr-origin <https-origin>] [--ssr-database existing|separate] [--clock ticker|disabled]
//
// <out>/public   the terminal and app assets; data requests reach the Worker
// <out>/pglite   pglite-workerd's package, baked from mecha's pinned sources
// <out>/src/machines.js   the app's machines, each the step its migration
//                declares (mecha-reducer.ts), for the object's host import
// <out>/pgdata   rls.sql, the migrations and --derived's rows, applied on disk;
//                or, with --from, a copy of a directory built elsewhere (an
//                archive) with the pgroll migrations its ledger lacks applied
//                (pgdata.ts), the set read from the app's cluster by cue
// <out>/migrations.json   the migrations by name, the cluster's pgroll set
//                among them: what a publish hands a data directory the object
//                kept (publish-edge.ts)
// <out>/src/index.ts, <out>/wrangler.jsonc
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeEdgeAssets, type StaticAsset } from './edge-assets.ts'
import { addressEdgeAssets, edgeRoutingRules, releaseAddresses } from './edge-addresses.ts'
import { builtRelease, holdIceServers } from './edge-ice.ts'
import { BLOB_CACHE_RULE, writeEdgeBlobs } from './edge-blobs.ts'
import { writeEdgeSsr } from './edge-ssr.ts'
import { type Hybrids, renderMachines } from './edge-machines.ts'
import { clusterDrains, releaseScripts } from './edge-scripts.ts'

function fail(msg: string): never {
  console.error(`edge: ${msg}`)
  Deno.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Deno.args.slice()
const usage = 'usage: edge.ts <appDir> --omnishell <dir> --mecha <dir> --ice-servers <json> [--out <dir>] [--domain <host>] [--derived <file> | --from <dir>] [--assets-from <previous-public-dir>] [--ssr-origin <https-origin>] [--ssr-database existing|separate] [--clock ticker|disabled]'
const app = path.resolve(args.shift() ?? fail(usage))
const flags: Record<string, string> = {}
while (args.length) {
  const flag = args.shift()!
  flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
}
for (const flag of Object.keys(flags)) {
  if (!['--omnishell', '--mecha', '--ice-servers', '--out', '--domain', '--derived', '--from', '--assets-from', '--ssr-origin', '--ssr-database', '--clock'].includes(flag)) fail(`unknown flag ${flag}`)
}
const clock = flags['--clock'] ?? 'ticker'
if (clock !== 'ticker' && clock !== 'disabled') fail('--clock must be ticker or disabled')
const databaseMode = flags['--ssr-database'] ?? 'existing'
if (databaseMode !== 'existing' && databaseMode !== 'separate') fail('--ssr-database must be existing or separate')
if (flags['--ssr-database'] && !flags['--ssr-origin']) fail('--ssr-database requires --ssr-origin')
const omnishell = path.resolve(flags['--omnishell'] ?? fail('--omnishell names the interpreter root'))
const mecha = path.resolve(flags['--mecha'] ?? fail('--mecha names the mecha root'))
const out = path.resolve(flags['--out'] ?? path.join(app, 'dist/cloudflare'))
const domain = flags['--domain'] ?? ''
const previousAssets = flags['--assets-from'] ? path.resolve(flags['--assets-from']) : undefined
const addresses = await releaseAddresses(omnishell)
// The target's, from distribution's #IceServers: the release rule names them.
const iceServers = addresses.parseIceServers(flags['--ice-servers'] ?? fail('--ice-servers names the target\'s ICE servers'))
if (previousAssets) addresses.separateAssetDirectories(out, previousAssets)

async function run(cmd: string, args: string[], cwd?: string) {
  const r = await new Deno.Command(cmd, { args, cwd, stdout: 'inherit', stderr: 'inherit' }).output()
  if (!r.success) fail(`${cmd} ${args.join(' ')} exited ${r.code}`)
}

const shell = JSON.parse(await Deno.readTextFile(path.join(app, 'shell/shell.json'))) as {
  app?: string
  tables: string[]
  schema?: Record<string, { durability?: string }>
  migrations: string[]
  units?: Record<string, { role?: string; isolation?: string }>
  presenter?: { policy: string; scripted: string[] }
}
const clustered = shell.migrations.length > 0
if (!clustered && (flags['--derived'] || flags['--from'] || flags['--ssr-origin'])) fail('a release without a cluster cannot use --derived, --from, or --ssr-origin')
// A unit also needs the terminal door's per-unit security headers. A
// presenter's are its worker script's own, which _headers carries
// (edge-addresses.ts), and the refusal of its scripted fetches below.
const unpackaged = Object.entries(shell.units ?? {}).filter(([, unit]) => unit.role !== 'presenter' && unit.isolation !== 'compartment').map(([unit]) => unit)
if (unpackaged.length) fail(`units are not packaged yet: ${unpackaged.join(', ')}`)
const name = shell.app ?? path.basename(app)
const drains = clustered ? await clusterDrains(path.join(app, '.pronto/cluster.json')) : []

let retainedFrom = previousAssets
let tempRetained: string | undefined
if (!retainedFrom) {
  const existingPublic = path.join(out, 'public')
  try {
    if ((await Deno.stat(existingPublic)).isDirectory) {
      tempRetained = await Deno.makeTempDir({ dir: path.dirname(out), prefix: '.retained-' })
      const stage = path.join(tempRetained, 'public')
      await Deno.rename(existingPublic, stage)
      retainedFrom = stage
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  }
}

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
const hints = await addressEdgeAssets(addresses, publicDir, { previous: retainedFrom, iceServers })
if (tempRetained) await Deno.remove(tempRetained, { recursive: true }).catch(() => {})
await holdIceServers(builtRelease(publicDir), iceServers, publicDir)
await Deno.writeTextFile(path.join(out, 'src/hints.json'), JSON.stringify(hints))

// The blob plane's seed rides as static assets, after addressing: its files
// are already named by their content and keep the URLs the page asks for.
const seedOut = await new Deno.Command('cue', { args: ['export', '.', '-e', '{seed: *code.capabilities.blobSeed | null}', '--out', 'json'], cwd: app, stdout: 'piped', stderr: 'inherit' }).output()
if (!seedOut.success) fail('cue export of code.capabilities.blobSeed failed')
const { seed } = JSON.parse(new TextDecoder().decode(seedOut.stdout)) as { seed: { manifest: string; origin: string } | null }
if (seed) {
  const count = await writeEdgeBlobs(publicDir, JSON.parse(await Deno.readTextFile(path.join(app, seed.manifest))), seed.origin)
  await Deno.writeTextFile(path.join(publicDir, '_headers'), '\n' + BLOB_CACHE_RULE, { append: true })
  console.error(`edge: ${count} seeded blobs`)
}

if (!clustered) {
  const worker = path.relative(path.join(out, 'src'), path.join(here, 'edge-static.ts')).replaceAll('\\', '/')
  await Deno.writeTextFile(path.join(out, 'src/index.ts'), `export { default } from '${worker.startsWith('.') ? worker : `./${worker}`}'\n`)
  await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({
    name, main: 'src/index.ts', compatibility_date: '2026-09-01',
    assets: { directory: './public', binding: 'ASSETS', run_worker_first: await edgeRoutingRules(publicDir), not_found_handling: 'none' },
    observability: { enabled: true },
    ...(domain ? { routes: [{ pattern: domain, custom_domain: true }] } : { workers_dev: true }),
  }, null, 2) + '\n')
  console.error(`edge: ${out}`)
  Deno.exit(0)
}

// PGlite for workerd. Bake reads the project's compose from its .bayt/, and a
// local export adds to its destination, which is fresh here.
const pglite = path.join(out, 'pglite')
const workerd = path.join(mecha, 'packages/pglite-workerd')
await run('docker', ['buildx', 'bake', `--allow=fs.read=${workerd}`, `--allow=fs.write=${out}`, '-f', 'compose.yaml', '--set', `package.output=type=local,dest=${pglite}`, 'package'], path.join(workerd, '.bayt'))
await Deno.remove(path.join(pglite, '.bayt'), { recursive: true })

// The cluster's pgroll set: what carries a database forward, a fresh
// directory's and an archive's alike (pgdata.ts), and a kept one's at publish.
const pgroll = path.join(out, 'pgroll.json')
const pgrollOut = await new Deno.Command('cue', { args: ['export', '.', '-e', 'cluster.state.pgroll', '--out', 'json'], cwd: app, stdout: 'piped', stderr: 'inherit' }).output()
if (!pgrollOut.success) fail(`cue export of cluster.state.pgroll exited ${pgrollOut.code}`)
await Deno.writeFile(pgroll, pgrollOut.stdout)
const cluster = path.join(mecha, 'packages/mecha-browser')
await run(Deno.execPath(), [
  'run', '-A', '--config', path.join(cluster, 'cluster.deno.json'), '--lock', path.join(cluster, 'deno.lock'), '--frozen',
  path.join(here, 'pgdata.ts'), app, '--mecha', mecha, '--out', path.join(out, 'pgdata'), '--pgroll', pgroll,
  ...(flags['--derived'] ? ['--derived', path.resolve(flags['--derived'])] : []),
  ...(flags['--from'] ? ['--from', path.resolve(flags['--from'])] : []),
])

// What a publish hands a directory the object kept: the scripts a directory
// is built from (edge-scripts.ts), the pgroll set among them.
const release = await releaseScripts(app, mecha, shell.migrations, JSON.parse(new TextDecoder().decode(pgrollOut.stdout)))
await Deno.writeTextFile(path.join(out, 'migrations.json'), JSON.stringify([...release.files.map(({ name, sql }) => ({ name, sql })), ...release.pgroll]))

// The app's machines: the migration declared each step over an engine this
// tier supplies (mecha-edge's machines.ts), so the object is handed the same
// rules PostgreSQL would run in plv8 (edge-machines.ts). And what owes a
// tick — its cron schedules, its hybrids that arm a deadline; a plv8
// machine's timers never run here — for the clock outside the object below.
const stateOut = await new Deno.Command('cue', {
  args: ['export', '.', '-e', '{hybrids: *code.state.hybrids | {}, crons: [for n, s in code.state.schedules if !s.suspend {n}]}', '--out', 'json'],
  cwd: app, stdout: 'piped', stderr: 'inherit',
}).output()
if (!stateOut.success) fail('cue export of the machines and schedules failed')
const { hybrids, crons } = JSON.parse(new TextDecoder().decode(stateOut.stdout)) as { hybrids: Hybrids; crons: string[] }
if (Object.keys(hybrids).length) await Deno.writeTextFile(path.join(out, 'src/machines.js'), await renderMachines(name, app, omnishell, hybrids))

// The object's clock is the ticker's own sweep (mecha-edge's clock.ts), whose
// cron reader croner reaches wrangler's bundler through node_modules beside
// the ticker, installed from its lock; mecha-edge's node_modules provides the
// pinned WebAuthn server dependency.
await run(Deno.execPath(), ['install', '--frozen'], path.join(mecha, 'services/ticker'))
await run(Deno.execPath(), ['install', '--frozen', '--node-modules-dir=auto'], path.join(mecha, 'packages/mecha-edge'))
// The clock outside the object: a Cron Trigger poking hourly where anything
// can owe a tick, so the free plan pays a day of object wakes for an alarm
// the platform lost rather than a minute's; the alarm is the exact one.
const armed = Object.values(hybrids).some((h) => (h.reducer as { ports?: { wake?: unknown } }).ports?.wake !== undefined)
const pokes = clock !== 'disabled' && (crons.length > 0 || armed)
const POKE_CRON = '0 * * * *'

const rel = (p: string) => {
  const r = path.relative(out, p).replaceAll('\\', '/')
  return r.startsWith('.') ? r : `./${r}`
}
// An import specifier, which a Windows path's separators would escape.
const fromSrc = (p: string) => {
  const rel = path.relative(path.join(out, 'src'), p).replaceAll('\\', '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}
await Deno.writeTextFile(path.join(out, 'src/index.ts'), `// Written by pronto's edge.ts for ${name}.
import { edgeObject } from '${fromSrc(path.join(mecha, 'packages/mecha-edge/src/object.ts'))}'
import { edgeWorker } from '${fromSrc(path.join(mecha, 'packages/mecha-edge/src/worker.ts'))}'
import { edgeHints } from '${fromSrc(path.join(here, 'edge-hints.ts'))}'
import { acceptedLanguages, routeAt } from '${fromSrc(path.join(omnishell, 'interpreter/fragment.js'))}'
import hints from './hints.json'
${Object.keys(hybrids).length ? "import machines from './machines.js'\n" : ''}import pgliteWasm from '../pglite/pglite.wasm'
import initdbWasm from '../pglite/initdb.wasm'
import pgliteData from '../pglite/pglite.data'
import icu from '../pglite/icu-root.tgz'

export const Cluster = edgeObject({
  clock: ${JSON.stringify(clock)},
  assets: { pgliteWasm, initdbWasm, pgliteData, icu },
  tables: ${JSON.stringify(shell.tables)},
  schema: ${JSON.stringify(shell.schema ?? {})},
  drains: ${JSON.stringify(drains)},${Object.keys(hybrids).length ? '\n  machines,' : ''}
})
export default {
  scheduled: edgeWorker.scheduled,
  async fetch(req, env, ctx) {
${shell.presenter ? `    // A presenter's module import of this origin is answered by a static
    // asset, which never reaches upstream dynamic handlers, or not at all: the cluster's
    // GET may act (omnishell's terminal.cue \`presenter.scripted\`).
    if (${JSON.stringify(shell.presenter.scripted)}.includes(req.headers.get('sec-fetch-dest') ?? '')) {
      if (env.ASSETS) {
        const asset = await env.ASSETS.fetch(req)
        if (asset.status === 200 || asset.status === 304) {
          if (asset.status === 200) {
            const path = new URL(req.url).pathname
            if (path.startsWith('/_immutable-') || path.includes('/_immutable-')) {
              const out = new Response(req.method === 'HEAD' ? null : asset.body, asset)
              out.headers.set('cache-control', 'public, max-age=31536000, immutable')
              return out
            }
          }
          return asset
        }
      }
      return new Response(null, { status: 403 })
    }
` : ''}    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/rtc-ice') {
      const baseIce = ${JSON.stringify(iceServers)}
      const keyId = env.CLOUDFLARE_TURN_KEY_ID
      const token = env.CLOUDFLARE_TURN_KEY_TOKEN
      if (!keyId || !token) {
        return new Response(JSON.stringify(baseIce), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      }
      try {
        const turnRes = await fetch(\`https://rtc.live.cloudflare.com/v1/turn/keys/\${keyId}/credentials/generate-ice-servers\`, {
          method: 'POST',
          headers: {
            'Authorization': \`Bearer \${token}\`,
            'Content-Type': 'application/json',
            'User-Agent': 'cloudflare-worker/1.0',
          },
          body: JSON.stringify({ ttl: 86400 }),
        })
        if (!turnRes.ok) {
          return new Response(JSON.stringify(baseIce), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          })
        }
        const turnData = await turnRes.json()
        const dynamicServers = Array.isArray(turnData.iceServers) ? turnData.iceServers : [turnData.iceServers]
        return new Response(JSON.stringify(dynamicServers.filter(Boolean)), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      } catch (_) {
        return new Response(JSON.stringify(baseIce), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      }
    }
    const response = await edgeWorker.fetch(req, env, ctx)
    if (req.method !== 'GET' || response.status !== 200 ||
        !(response.headers.get('content-type') ?? '').includes('text/html') ||
        !(req.headers.get('sec-fetch-mode') === 'navigate' || (req.headers.get('accept') ?? '').includes('text/html'))) return response
    const result = new Response(response.body, response)
    result.headers.set('Link', edgeHints(req, hints, routeAt, acceptedLanguages(req.headers.get('accept-language') ?? '')))
    return result
  },
}
`)
await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({
  name,
  main: 'src/index.ts',
  compatibility_date: '2026-09-01',
  // run_worker_first routes /* to the Worker so immutable assets attach
  // Cache-Control: public, max-age=31536000, immutable strictly on 200 responses,
  // while 404 responses are served with Cache-Control: no-store.
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: await edgeRoutingRules(publicDir) },
  durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] },
  version_metadata: { binding: 'CF_VERSION_METADATA' },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }],
  observability: { enabled: true },
  ...(pokes ? { triggers: { crons: [POKE_CRON] } } : {}),
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
if (flags['--ssr-origin']) {
  const origin = new URL(flags['--ssr-origin'])
  if (origin.origin !== flags['--ssr-origin'] || origin.protocol !== 'https:') fail('--ssr-origin must be an HTTPS origin without a trailing slash')
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(omnishell, 'server/worker'))
  await writeEdgeSsr(out, omnishell, mecha, name, origin.origin, drains, databaseMode, clock)
}
console.error(`edge: ${out}`)
