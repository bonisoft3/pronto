// Builds a pronto app's edge release into <out> (dist/cloudflare): a Worker in
// front of mecha's edge cluster, one Durable Object running PGlite
// (libraries/mecha/packages/mecha-edge), with the page as its static assets and
// the data directory the object loads once (publish-edge.ts).
//
//   deno run -A --config bundle/deno.json bundle/edge.ts <appDir> --omnishell <dir> --mecha <dir> --ice-servers <json> [--out <dir>] [--name <worker-name>] [--domain <host>]
//     [--derived <file> | --from <dir>] [--assets-from <previous-public-dir>] [--ssr-origin <https-origin>] [--ssr-database existing|separate] [--clock ticker|disabled]
//
// <out>/public   the terminal and app assets; data requests reach the Worker
// <out>/pglite   pglite-workerd's package, baked from mecha's pinned sources
// <out>/src/machines.js   the app's machines, each the step its migration
//                declares (mecha-reducer.ts), for the object's host import
// <out>/src/functions.js  the app's database functions (database-functions.ts),
//                for the same host import
// <out>/pgdata   rls.sql, the migrations and --derived's rows, applied on disk;
//                or, with --from, a copy of a directory built elsewhere (an
//                archive) with the scripts its ledger lacks applied (pgdata.ts),
//                the pgroll set read from the app's cluster by cue
// <out>/migrations.json   the migrations by name in the order a directory
//                applies them, the cluster's pgroll set last: what a publish
//                hands a data directory the object kept (publish-edge.ts)
// <out>/src/index.ts, <out>/wrangler.jsonc
import { readEdgeHatches, applyHatchAttributes } from './edge-hatches.ts'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeEdgeAssets, type StaticAsset } from './edge-assets.ts'
import { addressEdgeAssets, edgeRoutingRules, realmSubdomains, releaseAddresses } from './edge-addresses.ts'
import { builtRelease, holdIceServers } from './edge-ice.ts'
import { ASSET_CACHE_RULE, seedBlobFiles, writeEdgeAssets as writeSeedAssets } from './edge-blobs.ts'
import { databaseScript, writeEdgeSsr } from './edge-ssr.ts'
import { realmDocumentsOf, subdomainRealmsOf } from './edge-templates.ts'
import { type Reducers, renderMachines } from './edge-machines.ts'
import { computationPackages } from './compute.ts'
import { writeEdgeCompute } from './edge-compute.ts'
import { writeEdgeReader } from './edge-reader.ts'
import { type Functions, renderFunctions } from './edge-functions.ts'
import { renderEffects } from './edge-effects.ts'
import { dispatcherName, writeEdgeDispatcher } from './edge-dispatcher.ts'
import { imagePlanRefusal } from './edge-image-plan.ts'
import { clusterDrains, clusterSteps, EDGE_CAPABILITIES_CUE, EDGE_STATE_CUE, hasEffects, releaseScripts } from './edge-scripts.ts'
import { PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE } from './cloudflare-runtime.ts'

function fail(msg: string): never {
  console.error(`edge: ${msg}`)
  Deno.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Deno.args.slice()
const usage = 'usage: edge.ts <appDir> --omnishell <dir> --mecha <dir> --ice-servers <json> [--out <dir>] [--name <worker-name>] [--domain <host>] [--derived <file> | --from <dir>] [--assets-from <previous-public-dir>] [--ssr-origin <https-origin>] [--ssr-database existing|separate] [--clock ticker|disabled]'
const app = path.resolve(args.shift() ?? fail(usage))
const flags: Record<string, string> = {}
while (args.length) {
  const flag = args.shift()!
  flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
}
for (const flag of Object.keys(flags)) {
  if (!['--omnishell', '--mecha', '--ice-servers', '--out', '--name', '--domain', '--derived', '--from', '--assets-from', '--ssr-origin', '--ssr-database', '--clock'].includes(flag)) fail(`unknown flag ${flag}`)
}
const clock = flags['--clock'] ?? 'ticker'
if (clock !== 'ticker' && clock !== 'disabled') fail('--clock must be ticker or disabled')
const databaseMode = flags['--ssr-database'] ?? 'existing'
if (databaseMode !== 'existing' && databaseMode !== 'separate') fail('--ssr-database must be existing or separate')
if (flags['--ssr-database'] && !flags['--ssr-origin']) fail('--ssr-database requires --ssr-origin')
const omnishell = path.resolve(flags['--omnishell'] ?? fail('--omnishell names the interpreter root'))
const mecha = path.resolve(flags['--mecha'] ?? fail('--mecha names the mecha root'))
let out = path.resolve(flags['--out'] ?? path.join(app, 'dist/cloudflare'))
const domain = flags['--domain'] ?? ''
if ('--domain' in flags && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) fail(`--domain ${JSON.stringify(domain)} is no host name`)
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const workerNameRefusal = '--name must be lowercase letters, digits and hyphens, at most 63 characters'
if ('--name' in flags && !WORKER_NAME.test(flags['--name'])) fail(`${workerNameRefusal}, not ${JSON.stringify(flags['--name'])}`)
if ('--ssr-origin' in flags) {
  const origin = URL.parse(flags['--ssr-origin'])
  if (origin?.origin !== flags['--ssr-origin'] || origin.protocol !== 'https:') fail('--ssr-origin must be an HTTPS origin without a trailing slash')
}
const previousAssets = flags['--assets-from'] ? path.resolve(flags['--assets-from']) : undefined
const addresses = await releaseAddresses(omnishell)
// The target's, from distribution's #IceServers: the release rule names them.
const iceServers = addresses.parseIceServers(flags['--ice-servers'] ?? fail('--ice-servers names the target\'s ICE servers'))
if (previousAssets) addresses.separateAssetDirectories(out, previousAssets)

async function run(cmd: string, args: string[], cwd?: string, env?: Record<string, string>) {
  const r = await new Deno.Command(cmd, { args, cwd, env, stdout: 'inherit', stderr: 'inherit' }).output()
  if (!r.success) fail(`${cmd} ${args.join(' ')} exited ${r.code}`)
}

const shell = JSON.parse(await Deno.readTextFile(path.join(app, 'shell/shell.json'))) as {
  app?: string
  native?: boolean
  ai?: Record<string, unknown>
  tables: string[]
  schema?: Record<string, { durability?: string }>
  migrations: string[]
  routes?: { files: { html: string } }[]
  units?: Record<string, { role?: string; isolation?: string; subdomain?: string; src?: string }>
  presenter?: { policy: string; scripted: string[] }
}
const clustered = shell.migrations.length > 0
// Asked before anything is cleared, as addressEdgeAssets would refuse it.
const subdomains = realmSubdomains(shell.units)
if (subdomains.length && !domain) fail(`realm subdomains ${subdomains.join(', ')} are hosts under the release's domain: --domain names it`)
if (!clustered && (flags['--derived'] || flags['--from'] || flags['--ssr-origin'])) fail('a release without a cluster cannot use --derived, --from, or --ssr-origin')
// A unit's per-unit security headers ride in _headers (edge-addresses.ts): a
// realm's document carries the seat's sandbox, a presenter's worker script its
// own policy, with the refusal of its scripted fetches below; an agent is a
// static file the seat starts from a blob: under the document's policy.
const name = flags['--name'] ?? shell.app ?? path.basename(app)
if (!WORKER_NAME.test(name)) fail(`the worker name ${JSON.stringify(name)} is refused: ${workerNameRefusal}`)
const hatches = await readEdgeHatches(app)
if (hatches.length && flags['--ssr-origin']) fail('edge hatches are not packaged for SSR releases')
if (hatches.length && !clustered) fail('edge hatches run in the cluster, which an app with no migration does not have')
const drains = clustered ? await clusterDrains(path.join(app, '.pronto/cluster.json')) : []

// Asked before anything is cleared: a refused release leaves the last one's output standing.
const seedOut = await new Deno.Command('cue', { args: ['export', '.', '-e', EDGE_CAPABILITIES_CUE, '--out', 'json'], cwd: app, stdout: 'piped', stderr: 'inherit' }).output()
if (!seedOut.success) fail('cue export of code.capabilities failed')
const { assets, seedBlobs, blobs, images, signIn, providerRelease } = JSON.parse(new TextDecoder().decode(seedOut.stdout)) as { assets: { manifest: string; origin: string } | null; seedBlobs: { dir: string } | null; blobs: boolean; images: { sourceBucket?: string; plan: 'free' | 'paid' } | null; signIn: Record<string, { client?: string; issuer?: string; scope?: string; params?: string }>; providerRelease: Record<string, { releaseIssuer?: string }> }
const routeScreens: Record<string, string> = {}
for (const { files } of shell.routes ?? []) routeScreens[files.html] = await Deno.readTextFile(path.join(app, files.html))
const imagePlan = imagePlanRefusal(routeScreens, images)
if (imagePlan) fail(imagePlan)

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
out = await Deno.realPath(out)
const compute = clustered ? await writeEdgeCompute(out, mecha, omnishell, await computationPackages(app, mecha), name) : undefined
await Deno.writeTextFile(path.join(out, 'edge-environment.json'), JSON.stringify([...new Set(hatches.flatMap(h => h.edge.environment ?? []))]))
await Deno.writeTextFile(path.join(out, 'edge-secrets.json'), JSON.stringify([...new Set(hatches.flatMap(h => h.edge.secrets ?? []))]))

// Use the same public files as the container door; the cluster stays remote.
const publicDir = path.join(out, 'public')
const statics = await new Deno.Command('cue', {
  args: ['export', '.', '-e', '{statics: terminal.surface.statics, clusterStatics: cluster.meta.statics}', '--out', 'json'],
  cwd: app, stdout: 'piped', stderr: 'inherit',
}).output()
if (!statics.success) fail('cue export of public assets failed')
const { statics: terminalStatics, clusterStatics } = JSON.parse(new TextDecoder().decode(statics.stdout)) as { statics: StaticAsset[]; clusterStatics: StaticAsset[] }
await writeEdgeAssets(app, omnishell, publicDir, [...terminalStatics, ...clusterStatics])
await applyHatchAttributes(publicDir, hatches)
let nativeBridgeBytes: Uint8Array | undefined
if (shell.native) {
  const { projectAppNative } = await import(pathToFileURL(path.join(omnishell, 'project-native.ts')).href) as {
    projectAppNative: (appDir: URL, options?: { origin?: string }) => Promise<{ screens: Record<string, { divkit: unknown }> }>
  }
  const projected = await projectAppNative(pathToFileURL(app + '/'), { origin: domain ? `https://${domain}` : undefined })
  await Deno.mkdir(path.join(publicDir, 'shell/screens'), { recursive: true })
  for (const [screenName, spec] of Object.entries(projected.screens)) {
    await Deno.writeTextFile(path.join(publicDir, `shell/screens/${screenName}.divkit.json`), JSON.stringify(spec.divkit))
  }
  const bridgeFiles: string[] = []
  for (const sub of ['android/src/main/kotlin/com/pronto/omnishell/bridge', 'ios/Sources/Omnishell/bridge']) {
    const dir = path.join(omnishell, sub)
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile) bridgeFiles.push(path.join(dir, entry.name))
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
  }
  bridgeFiles.sort()
  const parts: Uint8Array[] = []
  for (const f of bridgeFiles) parts.push(await Deno.readFile(f))
  const total = parts.reduce((n, b) => n + b.length, 0)
  nativeBridgeBytes = new Uint8Array(total)
  let offset = 0
  for (const b of parts) {
    nativeBridgeBytes.set(b, offset)
    offset += b.length
  }
}
const ed25519Pkcs8B64 = Deno.env.get('NATIVE_MANIFEST_ED25519_PKCS8')?.trim() ?? ''
const ed25519PrivateKey = ed25519Pkcs8B64
  ? Uint8Array.from(atob(ed25519Pkcs8B64.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
  : undefined
const hints = await addressEdgeAssets(addresses, publicDir, { previous: retainedFrom, iceServers, domain: domain || undefined, nativeBridge: nativeBridgeBytes, ed25519PrivateKey })
if (tempRetained) await Deno.remove(tempRetained, { recursive: true }).catch(() => {})
await holdIceServers(builtRelease(publicDir), iceServers, publicDir)
await Deno.writeTextFile(path.join(out, 'src/hints.json'), JSON.stringify(hints))

// Blob storage is R2 here, one bucket per app, and the image service a layer above it.
const blobVars: Record<string, string> = blobs ? {
  BLOB_URL: images ? '/img/insecure/plain/s3://mecha-objects/' : '/blobs/mecha-objects/',
  ...(images?.sourceBucket ? { IMAGE_SOURCE_BUCKET: images.sourceBucket } : {}),
} : {}
async function assetlinksApkKeyHashes(publicDir: string): Promise<string> {
  let raw: string
  try {
    raw = await Deno.readTextFile(path.join(publicDir, '.well-known/assetlinks.json'))
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return ''
    throw e
  }
  const statements = JSON.parse(raw) as Array<{
    relation?: unknown
    target?: { namespace?: unknown; sha256_cert_fingerprints?: unknown }
  }>
  if (!Array.isArray(statements)) return ''
  const hashes = new Set<string>()
  for (const stmt of statements) {
    if (stmt?.target?.namespace !== 'android_app') continue
    if (!Array.isArray(stmt.relation) || !stmt.relation.includes('delegate_permission/common.get_login_creds')) continue
    if (!Array.isArray(stmt.target.sha256_cert_fingerprints)) continue
    for (const fp of stmt.target.sha256_cert_fingerprints) {
      if (typeof fp !== 'string') continue
      const hex = fp.replaceAll(':', '').trim()
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) fail(`assetlinks.json sha256_cert_fingerprints entry ${JSON.stringify(fp)} is not 32 hex bytes`)
      const bytes = new Uint8Array(32)
      for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      const b64url = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
      hashes.add(`android:apk-key-hash:${b64url}`)
    }
  }
  return [...hashes].join(',')
}

const androidApkKeyHashes = Deno.env.get('ANDROID_APK_KEY_HASHES') ?? await assetlinksApkKeyHashes(publicDir)
const nativeSchemes = Deno.env.get('NATIVE_SCHEMES') ?? ((shell.native || androidApkKeyHashes !== '') && shell.app ? shell.app : '')
const authProviders = Object.keys(signIn)
const authVars: Record<string, string> = {
  ...(authProviders.length ? {
    OIDC_PROVIDERS: authProviders.join(','),
    ...Object.fromEntries(authProviders.flatMap((p) => {
      const upper = p.toUpperCase()
      const cfg = signIn[p] ?? {}
      const localIssuer = cfg.issuer === 'http://localhost:28443'
      const entries: [string, string][] = []
      const issuer = Deno.env.get(`OIDC_${upper}_ISSUER`) || (localIssuer ? providerRelease[p]?.releaseIssuer : cfg.issuer)
      if (issuer) entries.push([`OIDC_${upper}_ISSUER`, issuer])
      const client = Deno.env.get(`OIDC_${upper}_CLIENT_ID`) || (!localIssuer || issuer ? cfg.client : undefined)
      if (client) entries.push([`OIDC_${upper}_CLIENT_ID`, client])
      const scope = Deno.env.get(`OIDC_${upper}_SCOPE`) || (!localIssuer || issuer ? cfg.scope : undefined)
      if (scope) entries.push([`OIDC_${upper}_SCOPE`, scope])
      const params = Deno.env.get(`OIDC_${upper}_AUTHORIZE_PARAMS`) || (!localIssuer || issuer ? cfg.params : undefined)
      if (params) entries.push([`OIDC_${upper}_AUTHORIZE_PARAMS`, params])
      return entries
    })),
  } : {}),
  ...(androidApkKeyHashes ? { ANDROID_APK_KEY_HASHES: androidApkKeyHashes } : {}),
  ...(nativeSchemes ? { NATIVE_SCHEMES: nativeSchemes } : {}),
}
const workerVars: Record<string, string> = {
  ...blobVars,
  ...authVars,
  ...(domain ? { ORIGIN: `https://${domain}` } : {}),
}
const blobBindings = blobs ? {
  r2_buckets: [{ binding: 'BLOB_OBJECTS', bucket_name: `${name}-mecha-objects` }],
  vars: blobVars,
  ...(images ? { images: { binding: 'IMAGES' } } : {}),
} : {}
// The app's own files ride with its release, after addressing: they are already
// named by their content.
if (assets) {
  const count = await writeSeedAssets(publicDir, JSON.parse(await Deno.readTextFile(path.join(app, assets.manifest))), assets.origin)
  await Deno.writeTextFile(path.join(publicDir, '_headers'), '\n' + ASSET_CACHE_RULE, { append: true })
  console.error(`edge: ${count} seed assets`)
}
// What the publish puts in blob storage, outside what the release serves.
if (seedBlobs) {
  if (!clustered) fail('seedBlobs names objects for a cluster, and this app has no migration')
  const count = await seedBlobFiles(path.join(app, seedBlobs.dir), path.join(out, 'seed-blobs'))
  console.error(`edge: ${count} seed blobs`)
}

// A realm's document, served at its own address ([[edge-templates.ts]]).
const realmDocuments = realmDocumentsOf(shell)
const subdomainRealms = subdomainRealmsOf(shell)
const subdomainArgs = Object.keys(subdomainRealms).length ? `, ${JSON.stringify(subdomainRealms)}` : ''
const customDomains = domain ? [domain, ...subdomains.map((sub) => `${sub}.${domain}`)].map((pattern) => ({ pattern, custom_domain: true })) : undefined
if (!clustered) {
  const worker = path.relative(path.join(out, 'src'), path.join(here, 'edge-static.ts')).replaceAll('\\', '/')
  const staticWorker = worker.startsWith('.') ? worker : `./${worker}`
  const imageWorker = path.relative(path.join(out, 'src'), path.join(here, 'edge-images.ts')).replaceAll('\\', '/')
  const fragment = path.relative(path.join(out, 'src'), path.join(omnishell, 'interpreter/fragment.js')).replaceAll('\\', '/')
  await Deno.writeTextFile(path.join(out, 'src/index.ts'), blobs
    ? `import { staticWorker as serveStatic } from '${staticWorker}'\nconst staticWorker = serveStatic(${JSON.stringify(realmDocuments)}${subdomainArgs})\nimport { edgeImage } from '${imageWorker.startsWith('.') ? imageWorker : `./${imageWorker}`}'\nimport { IMAGE_WIDTHS } from '${fragment.startsWith('.') ? fragment : `./${fragment}`}'\nexport default { async fetch(req, env, ctx) { return await edgeImage(req, env, caches.default, ctx, IMAGE_WIDTHS) ?? staticWorker.fetch(req, env) } }\n`
    : `import { staticWorker } from '${staticWorker}'\nexport default staticWorker(${JSON.stringify(realmDocuments)}${subdomainArgs})\n`)
  await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({
    name, main: 'src/index.ts', compatibility_date: PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE,
    assets: { directory: './public', binding: 'ASSETS', run_worker_first: await edgeRoutingRules(publicDir), html_handling: 'drop-trailing-slash', not_found_handling: 'none' },
    observability: { enabled: true },
    ...blobBindings,
    ...(customDomains ? { routes: customDomains } : { workers_dev: true }),
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
const reader = compute ? await writeEdgeReader(out, mecha, compute.definitions, name) : undefined
if (compute) {
  compute.deployments.push('compute/reader/wrangler.jsonc')
  await Deno.writeTextFile(path.join(out, 'src/compute.json'), JSON.stringify({ ...compute, reader }))
}

// The cluster's pgroll set: what carries a database forward, a fresh
// directory's and an archive's alike (pgdata.ts), and a kept one's at publish.
const pgroll = path.join(out, 'pgroll.json')
const pgrollOut = await new Deno.Command('cue', { args: ['export', '.', '-e', 'cluster.state.pgroll', '--out', 'json'], cwd: app, stdout: 'piped', stderr: 'inherit' }).output()
if (!pgrollOut.success) fail(`cue export of cluster.state.pgroll exited ${pgrollOut.code}`)
await Deno.writeFile(pgroll, pgrollOut.stdout)
const cluster = path.join(mecha, 'packages/mecha-browser')
// The cluster uses its Deno pins, independently of the surrounding npm workspace.
await run(Deno.execPath(), [
  'run', '-A', '--no-config', '--import-map', path.join(cluster, 'cluster.deno.json'), '--lock', path.join(cluster, 'deno.lock'), '--frozen',
  path.join(here, 'pgdata.ts'), app, '--mecha', mecha, '--out', path.join(out, 'pgdata'), '--pgroll', pgroll,
  ...(flags['--derived'] ? ['--derived', path.resolve(flags['--derived'])] : []),
  ...(flags['--from'] ? ['--from', path.resolve(flags['--from'])] : []),
], undefined, { DENO_NO_PACKAGE_JSON: '1' })

// What a publish hands a directory the object kept: the scripts a directory
// is built from (edge-scripts.ts), in the order it applies them.
const release = await releaseScripts(app, mecha, shell.migrations, JSON.parse(new TextDecoder().decode(pgrollOut.stdout)), await clusterSteps(path.join(app, '.pronto/cluster.json')))
await Deno.writeTextFile(path.join(out, 'migrations.json'), JSON.stringify(release.scripts))

// The app's machines and functions: the migration declared each over an engine
// this tier supplies (mecha-edge's machines.ts), so the object is handed the
// same modules PostgreSQL would run in plv8 (edge-machines.ts, edge-functions.ts). And what owes a
// tick — its cron schedules, its reducers that arm a deadline; a plv8
// machine's timers never run here — for the clock outside the object below.
const stateOut = await new Deno.Command('cue', {
  args: ['export', '.', '-e', EDGE_STATE_CUE, '--out', 'json'],
  cwd: app, stdout: 'piped', stderr: 'inherit',
}).output()
if (!stateOut.success) fail('cue export of the machines and schedules failed')
const { reducers, functions, crons } = JSON.parse(new TextDecoder().decode(stateOut.stdout)) as { reducers: Reducers; functions: Functions; crons: string[] }
if (Object.keys(reducers).length) await Deno.writeTextFile(path.join(out, 'src/machines.js'), await renderMachines(name, app, omnishell, reducers))
if (Object.keys(functions).length) await Deno.writeTextFile(path.join(out, 'src/functions.js'), await renderFunctions(name, app, omnishell, functions))
const withEffects = await hasEffects(app)
if (withEffects) {
  // The dispatcher is named after the script that holds the object.
  dispatcherName(flags['--ssr-origin'] ? databaseScript(name, databaseMode) : name)
  const { effects, declarations } = await renderEffects(name, app, mecha, out)
  await Deno.writeTextFile(path.join(out, 'src/effects.js'), effects)
  await Deno.writeTextFile(path.join(out, 'src/effect-declarations.js'), declarations)
}

// The object's clock is the ticker's own sweep (mecha-edge's clock.ts), whose
// cron reader croner reaches wrangler's bundler through node_modules beside
// the ticker, installed from its lock; mecha-edge's node_modules provides the
// pinned WebAuthn server dependency.
await run(Deno.execPath(), ['install', '--frozen'], path.join(mecha, 'services/ticker'))
await run(Deno.execPath(), ['install', '--frozen', '--node-modules-dir=auto'], path.join(mecha, 'packages/mecha-edge'), { DENO_NO_PACKAGE_JSON: '1' })
await run(Deno.execPath(), ['install', '--frozen', '--config', path.join(mecha, 'services/airlock/deno.json')], path.join(mecha, 'services/airlock'))
// The clock outside the object: a Cron Trigger poking hourly where anything
// can owe a tick, so the free plan pays a day of object wakes for an alarm
// the platform lost rather than a minute's; the alarm is the exact one.
const armed = Object.values(reducers).some((h) => (h.reducer as { ports?: { wake?: unknown } }).ports?.wake !== undefined)
const pokes = !!compute || clock !== 'disabled' && (crons.length > 0 || armed || withEffects || hatches.length > 0)
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
import { originAssets } from '${fromSrc(path.join(here, 'edge-templates.ts'))}'
${blobs ? `import { edgeImage } from '${fromSrc(path.join(here, 'edge-images.ts'))}'\n` : ''}import { acceptedLanguages, IMAGE_WIDTHS, routeAt } from '${fromSrc(path.join(omnishell, 'interpreter/fragment.js'))}'
import hints from './hints.json'
${compute ? `import { computeCoordinator } from '${fromSrc(path.join(mecha, "packages/mecha-edge/src/compute-coordinator.ts"))}'\nexport class ComputeCoordinator extends computeCoordinator(undefined, ${JSON.stringify(compute.paged ?? [])}, ${JSON.stringify(compute.services[0].service)}) {}\n` : ''}
${compute ? "import computeMachines from './compute-machine.js'\n" : ''}
${hatches.map((h, i) => `import { createHatch as hatch${i} } from '${fromSrc(path.join(app, h.edge.src))}'`).join('\n')}
${Object.keys(reducers).length ? "import machines from './machines.js'\n" : ''}${Object.keys(functions).length ? "import functions from './functions.js'\n" : ''}${withEffects ? "import effects from './effect-declarations.js'\n" : ''}import pgliteWasm from '../pglite/pglite.wasm'
import initdbWasm from '../pglite/initdb.wasm'
import pgliteData from '../pglite/pglite.data'
import icu from '../pglite/icu-root.tgz'

export const Cluster = edgeObject({
  clock: ${JSON.stringify(clock)},
  hatches: [${hatches.map((h, i) => `{ route: ${JSON.stringify(h.edge.route)}, create: hatch${i} }`).join(',')}],
  assets: { pgliteWasm, initdbWasm, pgliteData, icu },
  tables: ${JSON.stringify(shell.tables)},
  schema: ${JSON.stringify(shell.schema ?? {})},
  ${compute ? 'compute: { computations: ' + JSON.stringify(compute.definitions) + ', machine: computeMachines.compute_batch, physicalSnapshots: true, reader: ' + JSON.stringify(reader!.script_name) + ' },' : ''}
  drains: ${JSON.stringify(drains)},${Object.keys(reducers).length ? '\n  machines,' : ''}${Object.keys(functions).length ? '\n  functions,' : ''}${withEffects ? '\n  effects,' : ''}
})
export default {
  scheduled: edgeWorker.scheduled,
  async fetch(req, env, ctx) {
    env = { ...env, ASSETS: originAssets(env.ASSETS, ${JSON.stringify(realmDocuments)}${subdomainArgs}) }
    if (${JSON.stringify(hatches.map(h => h.edge.route))}.some(route => new URL(req.url).pathname === route || new URL(req.url).pathname.startsWith(route + '/'))) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
${blobs ? '    const image = await edgeImage(req, env, caches.default, ctx, IMAGE_WIDTHS)\n    if (image) return image\n' : ''}
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
        /^\\/(?:_immutable-|(?:shell|omnishell|messages|docs)\\/)/.test(url.pathname) ||
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
  compatibility_date: PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE,
  // The object's airlock runs Graphile Worker, which needs Node's built-ins.
  compatibility_flags: ['nodejs_compat'],
  ...(compute ? { services: compute.services } : {}),
  // run_worker_first routes /* to the Worker so immutable assets attach
  // Cache-Control: public, max-age=31536000, immutable strictly on 200 responses,
  // while 404 responses are served with Cache-Control: no-store.
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: await edgeRoutingRules(publicDir), html_handling: 'drop-trailing-slash' },
  durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }, ...(compute ? [{ name: 'COMPUTE_COORDINATOR', class_name: 'ComputeCoordinator' }, reader] : [])] },
  ...(shell.ai ? { ai: { binding: 'AI' } } : {}),
  version_metadata: { binding: 'CF_VERSION_METADATA' },
  ...(hatches.some(h => h.edge.email) ? { send_email: hatches.flatMap(h => h.edge.email ? [{name: h.edge.email.name, allowed_destination_addresses: h.edge.email.recipients}] : []) } : {}),
  exports: { Cluster: { type: 'durable-object', storage: 'sqlite' }, ...(compute ? { ComputeCoordinator: { type: 'durable-object', storage: 'sqlite' } } : {}) },
  observability: { enabled: true },
  ...blobBindings,
  // A handler's sink.origin: the release's domain, never the host a request came by.
  ...(Object.keys(workerVars).length ? { vars: workerVars } : {}),
  ...(pokes ? { triggers: { crons: [POKE_CRON] } } : {}),
  ...(customDomains ? { routes: customDomains } : { workers_dev: true }),
  rules: [
    { type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false },
    { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false },
  ],
  // mecha's sources import these by bare name.
  alias: {
    '@electric-sql/pglite': './pglite/index.js',
    '@electric-sql/pglite/basefs': './pglite/fs/base.js',
    '@mecha/postgrest-js': rel(path.join(mecha, 'packages/postgrest-js/src/index.ts')),
    typescript: rel(path.join(mecha, 'packages/mecha-edge/src/typescript-absent.js')),
  },
}, null, 2) + '\n')
if (flags['--ssr-origin']) {
  const origin = new URL(flags['--ssr-origin'])
  const mise = Deno.env.get('SAYT_MISE_BIN') ?? fail('SAYT_MISE_BIN is required to install the renderer with its pinned Node')
  await run(mise, ['exec', '--', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(omnishell, 'server/worker'))
  await writeEdgeSsr(out, omnishell, mecha, name, origin.origin, drains, databaseMode, clock)
}
// Written last: the queue's producer is whichever script holds the object.
if (withEffects) {
  const airlock = await writeEdgeDispatcher(out, mecha, app, shell.ai)
  console.error(`edge: dispatcher ${airlock.queue}`)
}
console.error(`edge: ${out}`)
