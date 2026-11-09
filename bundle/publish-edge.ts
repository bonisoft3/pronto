import { hatchEnvironment, refuseMissingHatchSecrets } from './edge-hatches.ts'
// Makes an edge release live: deploys <out> (edge.ts's) with the wrangler
// mecha's pglite-workerd pins, its secrets in the same version, and loads the
// data directory into its object. JWT_SECRET is set once, since every session
// is signed with it; IMPORT_TOKEN is new at every publish and lives only here.
// Secrets put after a deploy are a version of their own, which a request in
// between does not see. The load resumes a partial one and leaves a complete
// directory, live data, alone, unless --reset replaces it: the object answers
// 503 from the reset until the new directory is complete. A directory left
// alone is handed this release's migrations (edge.ts's migrations.json), and
// the object applies the ones its ledger lacks; one it refuses — built before
// the ledger existed, or holding a file this release changed — fails the
// publish and attempts to restore every Worker's previous version. A Durable
// Object schema migration can prevent rollback; the refusal and every failed
// rollback are reported. The deployment's terminal config is then held to
// the build's ICE servers. Where the release
// carries a Cron Trigger, one poke ends the publish, so the object's clock
// starts now rather than at its first visitor.
//
//   deno run -A --config bundle/deno.json bundle/publish-edge.ts <out> --mecha <dir> [--reset] [--temporary]
import { Buffer } from 'node:buffer'
import https from 'node:https'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { SEED_TYPES } from './edge-blobs.ts'
import { builtRelease, deployedRelease, holdIceServers, releasedIceServers } from './edge-ice.ts'
import { migrateKeptDirectory, previousDeployment, rollbackRefusedMigration } from './publish-edge-state.ts'
import { keptJwtSecrets, validateJwtMode } from './publish-edge-secrets.ts'
import { prepareStorage } from './publish-edge-storage.ts'
import { releaseJwtSecret } from './edge-jwt.ts'
import { requireLocalCluster } from './edge-deployment.ts'

/** One hop's deadline: a stalled stream to the data directory held a publish
 * for 36 minutes at 0% CPU (2026-11-08), past every retry the caller owns. */
const HOP_MS = 60_000
async function edgeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try {
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(HOP_MS)]) : AbortSignal.timeout(HOP_MS)
    return await fetch(input, { ...init, signal })
  } catch (err) {
    // A hop that ran out its deadline is the answer; the raw request below is
    // for a resolver that failed, not for a stream that stalled.
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (u.protocol !== 'https:') throw err
    const ips = await Deno.resolveDns(u.hostname, 'A', { nameServer: { ipAddr: '1.1.1.1', port: 53 } }).catch(() => [] as string[])
    const ip = ips[0]
    if (!ip) throw err
    const reqHeaders: Record<string, string> = { host: u.hostname }
    new Headers(init?.headers).forEach((v, k) => { reqHeaders[k] = v })
    return await new Promise<Response>((resolve, reject) => {
      const req = https.request({
        hostname: ip,
        port: u.port ? Number(u.port) : 443,
        path: u.pathname + u.search,
        method: init?.method ?? 'GET',
        servername: u.hostname,
        headers: reqHeaders,
      }, (res) => {
        const chunks: Uint8Array[] = []
        res.on('data', (c: Uint8Array) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode ?? 500
          if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location && init?.redirect !== 'manual') {
            resolve(edgeFetch(new URL(res.headers.location, u), init))
            return
          }
          const body = (status === 204 || status === 304) ? null : Buffer.concat(chunks)
          const headers = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((item) => headers.append(k, item))
            else if (typeof v === 'string') headers.set(k, v)
          }
          resolve(new Response(body, { status, headers }))
        })
      })
      req.on('error', reject)
      if (init?.body instanceof Uint8Array || typeof init?.body === 'string') req.write(init.body)
      req.end()
    })
  }
}

function fail(msg: string): never {
  console.error(`publish-edge: ${msg}`)
  Deno.exit(1)
}

const args = Deno.args.slice()
const out = path.resolve(args.shift() ?? fail('usage: publish-edge.ts <out> --mecha <dir> [--reset] [--temporary] [--keep-jwt-secret]'))
if (args.shift() !== '--mecha') fail('--mecha names the mecha root')
const mecha = path.resolve(args.shift() ?? fail('--mecha takes a value'))
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const reset = flag('--reset')
const keepJwtSecret = flag('--keep-jwt-secret')
// A throwaway Cloudflare account wrangler makes when none is logged in; it
// expires unless claimed.
const temporary = flag('--temporary') ? ['--temporary'] : []
if (args.length) fail(`unknown arguments ${args.join(' ')}`)
validateJwtMode(keepJwtSecret, reset, temporary.length > 0)
const workerd = path.join(mecha, 'packages/pglite-workerd')
const config = path.join(out, 'wrangler.jsonc')
const settings = JSON.parse(await Deno.readTextFile(config)) as { name: string; durable_objects?: { bindings: { name: string; script_name?: string }[] }; routes?: { pattern: string }[] }
let ssr = false
try { ssr = (await Deno.stat(path.join(out, 'renderer.jsonc'))).isFile }
catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
const authConfig = ssr && settings.durable_objects?.bindings.some((binding: { name: string; script_name?: string }) => binding.name === 'CLUSTER' && binding.script_name)
  ? path.join(out, 'database.jsonc') : config

async function run(cmd: string, args: string[], { cwd = out, env }: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const r = await new Deno.Command(cmd, { args, cwd, env, stdin: 'null', stdout: 'piped', stderr: 'inherit' }).output()
  const text = new TextDecoder().decode(r.stdout)
  if (!r.success) throw new Error(`${cmd} ${args.join(' ')} exited ${r.code}:\n${text}`)
  return text
}

const { wranglerTools } = await import(String(pathToFileURL(path.join(workerd, 'wrangler-tools.ts'))))
const { wrangler, env } = await wranglerTools()
const runWrangler = (args: string[]) => run(wrangler, args, { env })
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
if (!settings.durable_objects) {
  if (reset) fail('--reset requires a cluster')
  const deployed = await runWrangler(['deploy', '--config', config, ...temporary])
  console.log(deployed)
  const origin = settings.routes?.length ? `https://${settings.routes[0].pattern}` : /https:\/\/\S+\.workers\.dev/.exec(deployed)?.[0] ?? fail('wrangler deploy named no workers.dev URL')
  await Deno.writeTextFile(path.join(out, 'origin.txt'), origin)
  const ghEnv = Deno.env.get('GITHUB_ENV')
  if (ghEnv) await Deno.writeTextFile(ghEnv, `PRONTO_DEPLOYED_URL=${origin}\n`, { append: true })
  await holdIceServers(deployedRelease(origin), await releasedIceServers(builtRelease(path.join(out, 'public'))), origin)
  Deno.exit(0)
}

const token = random()
if (temporary.length) fail('Cluster releases require a Cloudflare account to preserve deployed secrets')
const previous = await previousVersion(authConfig)
const authSettings = JSON.parse(await Deno.readTextFile(authConfig))
await requireLocalCluster({ config: authConfig, name: authSettings.name, previous, wrangler: runWrangler })
const jwtSecret = keepJwtSecret
  ? (await keptJwtSecrets(authConfig, token, runWrangler), undefined)
  : await releaseJwtSecret({ secret: Deno.env.get('JWT_SECRET'), config: authConfig, previous, wrangler: runWrangler, random })
const secrets: Record<string, string> = { ...await hatchEnvironment(out, name => Deno.env.get(name)), IMPORT_TOKEN: token, ...(jwtSecret ? { JWT_SECRET: jwtSecret } : {}) }
const turnId = Deno.env.get('CLOUDFLARE_TURN_KEY_ID')
const turnToken = Deno.env.get('CLOUDFLARE_TURN_KEY_TOKEN')
if (Boolean(turnId) !== Boolean(turnToken)) fail('Configure both Cloudflare TURN credentials together')
if (turnId && turnToken) {
  secrets.CLOUDFLARE_TURN_KEY_ID = turnId
  secrets.CLOUDFLARE_TURN_KEY_TOKEN = turnToken
}
/** The Workers this publish deploys, each with the version it replaces, for
 * the rollback a refused migration asks for; a first deploy has none. */
const deployed: { config: string; previous: string | null }[] = []
async function previousVersion(configPath: string): Promise<string | null> {
  const listing = await new Deno.Command(wrangler, {
    args: ['deployments', 'list', '--config', configPath, '--json'], cwd: out, env, stdin: 'null', stdout: 'piped', stderr: 'piped',
  }).output()
  return previousDeployment(listing)
}
async function deploy(configPath: string, ...flags: string[]): Promise<string> {
  // wrangler cannot list a temporary account's deployments, so a temporary
  // publish records no earlier version and cannot be rolled back.
  const previous = temporary.length ? null : await previousVersion(configPath)
  const text = await runWrangler(['deploy', '--config', configPath, ...flags, ...temporary])
  deployed.push({ config: configPath, previous })
  return text
}
await refuseMissingHatchSecrets({
  directory: out,
  configs: [config],
  temporary: !!temporary.length,
  deployedBefore: async configPath => await previousVersion(configPath) !== null,
  wrangler: runWrangler,
})
// The airlock's dispatcher (edge-dispatcher.ts): its queue exists before the
// object's script names it, and the effects' secrets are the dispatcher's alone.
let airlock: { queue: string; deployment: string; secrets: string[]; providers: string[][]; containers: string[] } | undefined
try { airlock = JSON.parse(await Deno.readTextFile(path.join(out, 'src/airlock.json'))) }
catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
if (airlock) {
  if (airlock.deployment !== 'airlock/wrangler.jsonc') throw new Error(`invalid airlock deployment: ${airlock.deployment}`)
  // A bridge's container is built here by the dispatcher's `wrangler deploy`,
  // for linux/amd64, and pushed to Cloudflare's registry: without a running
  // Docker the publish has no image to ship.
  if (airlock.containers.length) {
    const shipped = airlock.containers.join(', ')
    const info = await new Deno.Command('docker', { args: ['info', '--format', '{{.ServerVersion}}'], cwd: out, stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
      .catch((error: Error) => fail(`the dispatcher ships ${shipped} as Cloudflare Containers, and docker cannot be run: ${error.message}`))
    if (!info.success) fail(`the dispatcher ships ${shipped} as Cloudflare Containers, and Docker is not running: ${new TextDecoder().decode(info.stderr).trim()}`)
    console.log(`publish-edge: Docker ${new TextDecoder().decode(info.stdout).trim()} builds ${shipped} for linux/amd64 at the dispatcher's deploy; a first deploy provisions each container, which takes minutes, and its effects wait on it`)
    // Each image is built here first, as wrangler will build it, so a
    // Dockerfile that does not build fails the publish before the object's
    // Worker is switched to a release whose dispatcher never deploys.
    const dispatcher = path.join(out, airlock.deployment)
    const { containers = [] } = JSON.parse(await Deno.readTextFile(dispatcher)) as { containers?: { class_name: string; image: string; image_build_context: string; image_vars?: Record<string, string> }[] }
    for (const c of containers) {
      const args = Object.entries(c.image_vars ?? {}).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`])
      const built = await new Deno.Command('docker', { args: ['build', '--platform', 'linux/amd64', '--provenance=false', '-f', c.image, ...args, c.image_build_context], cwd: path.dirname(dispatcher), stdin: 'null', stdout: 'inherit', stderr: 'inherit' }).output()
      if (!built.success) fail(`the image of ${c.class_name} (${c.image}) does not build, so nothing deploys`)
    }
  }
  // A secret the environment does not carry must already be the deployed
  // dispatcher's, as an edge hatch's is (edge-hatches.ts): a release never
  // invents one, and a first deploy without it would run every effect keyless.
  // A provider's key is any one of the names tsbifrost reads for it.
  const absent = airlock.secrets.filter(name => !Deno.env.get(name))
  const unkeyed = airlock.providers.filter(names => !names.some(name => Deno.env.get(name)))
  if (absent.length || unkeyed.length) {
    const dispatcher = path.join(out, airlock.deployment)
    const held = await previousVersion(dispatcher) === null ? [] : (JSON.parse(await runWrangler(['secret', 'list', '--config', dispatcher, '--format', 'json'])) as { name: string }[]).map(b => b.name)
    const missing = [...absent.filter(name => !held.includes(name)), ...unkeyed.filter(names => !names.some(name => held.includes(name))).map(names => names.join(' or '))]
    if (missing.length) fail(`the dispatcher needs ${missing.join(', ')}: set them in the environment of this publish, or on the deployed ${airlock.queue} Worker`)
  }
  const exists = await new Deno.Command(wrangler, { args: ['queues', 'info', airlock.queue], cwd: out, env, stdin: 'null', stdout: 'null', stderr: 'null' }).output()
  if (!exists.success) console.log(await runWrangler(['queues', 'create', airlock.queue]))
}
const secretsDir = await Deno.makeTempDir({ prefix: 'publish-edge-' })
const secretsFile = path.join(secretsDir, 'secrets.json')
let deployedText: string
try {
  await Deno.writeTextFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 })
  let compute
  try { compute = JSON.parse(await Deno.readTextFile(path.join(out, 'src/compute.json'))) }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
  for (const companion of compute?.deployments ?? []) {
    if (!/^compute\/(queries|execution|reader)\/wrangler\.jsonc$/.test(companion)) throw new Error(`invalid computation deployment: ${companion}`)
    console.log(await deploy(path.join(out, companion), '--durable-objects-code-update-mode', 'immediate'))
  }
  if (ssr) {
    console.log(await deploy(path.join(out, 'renderer.jsonc'), '--durable-objects-code-update-mode', 'immediate'))
    if (authConfig !== config) {
      console.log(await deploy(authConfig, '--secrets-file', secretsFile, '--durable-objects-code-update-mode', 'immediate'))
    }
  }
  // The object restarts on the new code rather than at its next idle.
  deployedText = await deploy(config, '--secrets-file', secretsFile, '--durable-objects-code-update-mode', 'immediate')
} finally {
  await Deno.remove(secretsDir, { recursive: true })
}
console.log(deployedText)
const deployedSettings = JSON.parse(await Deno.readTextFile(config)) as { routes?: { pattern: string }[]; triggers?: { crons: string[] } }
const origin = deployedSettings.routes?.length ? `https://${deployedSettings.routes[0].pattern}` : /https:\/\/\S+\.workers\.dev/.exec(deployedText)?.[0] ?? fail('wrangler deploy named no workers.dev URL')
await Deno.writeTextFile(path.join(out, 'origin.txt'), origin)
const ghEnv = Deno.env.get('GITHUB_ENV')
if (ghEnv) {
  await Deno.writeTextFile(ghEnv, `PRONTO_DEPLOYED_URL=${origin}\n`, { append: true })
}
// Wait for Cloudflare's public DNS (1.1.1.1) to publish the A record before
// querying the OS resolver, preventing local routers from caching NXDOMAIN.
{
  const host = new URL(origin).hostname
  for (let t0 = Date.now(); Date.now() - t0 < 60_000; ) {
    const ips = await Deno.resolveDns(host, 'A', { nameServer: { ipAddr: '1.1.1.1', port: 53 } }).catch(() => [] as string[])
    if (ips.length > 0) break
    await new Promise((r) => setTimeout(r, 2000))
  }
}
const send = (route: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  let body = init?.body
  if (route.startsWith('chunk?') && body instanceof Uint8Array) {
    body = new Uint8Array(gzipSync(body, { level: 1 }))
    headers.set('content-encoding', 'gzip')
  }
  return edgeFetch(`${origin}/import/${route}`, { ...init, body, headers })
}

/** The object answers three times in a row: the version just deployed is
 * everywhere once the Worker takes this token, and an object a migration
 * ended has booted again. */
async function settled(after: string) {
  for (let streak = 0, t0 = Date.now(); ; ) {
    const res = await send('status').catch((error: Error) => ({ ok: false, status: error.message, body: null }))
    await res.body?.cancel()
    if (res.ok) {
      if (++streak >= 3) break
    } else {
      streak = 0
    }
    if (Date.now() - t0 > 120_000) throw new Error(`${origin}/import/status still answers ${res.status} two minutes after ${after}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}
await settled('the deploy')

// Before a migration can name them.
const seedDir = path.join(out, 'seed-blobs')
let seedStored = 0
try {
  for await (const e of Deno.readDir(seedDir)) {
    const held = await send(`blob/seed/${e.name}`, { method: 'HEAD' })
    await held.body?.cancel()
    if (held.ok) continue
    if (held.status !== 404) fail(`seed blob ${e.name}: ${held.status}`)
    const res = await send(`blob/seed/${e.name}`, { method: 'PUT', headers: { 'content-type': SEED_TYPES[path.extname(e.name)] }, body: await Deno.readFile(path.join(seedDir, e.name)) })
    if (!res.ok) fail(`seed blob ${e.name}: ${res.status} ${await res.text()}`)
    if ((await res.json() as { stored: boolean }).stored) seedStored++
  }
  console.log(`publish-edge: ${seedStored} seed blobs stored`)
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e
}

const { load } = await import(String(pathToFileURL(path.join(workerd, 'load.ts'))))
const { isSeedScript } = await import(String(pathToFileURL(path.join(workerd, 'scripts.ts')))) as { isSeedScript: (name: string) => boolean }
const loaded = await load(path.join(out, 'pgdata'), send, { reset })
await prepareStorage(send, status => console.log(JSON.stringify({ storage: status })))
if ('skipped' in loaded) {
  let migrationsBody: string
  try {
    const scripts = (JSON.parse(await Deno.readTextFile(path.join(out, 'migrations.json'))) as { name: string; sql: string | null }[])
      .filter((s) => !isSeedScript(s.name))
    migrationsBody = JSON.stringify(scripts)
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) migrationsBody = '[]'
    else throw e
  }
  let lost = false
  const migrated = await migrateKeptDirectory(async () => {
    let response = await send('migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: migrationsBody })
    for (let attempt = 0; attempt < 5 && response.status === 401; attempt++) {
      await response.body?.cancel()
      await new Promise(resolve => setTimeout(resolve, 2000))
      response = await send('migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: migrationsBody })
    }
    return response
  }, () => settled('the migration'), message => { lost = true; console.error(`publish-edge: ${message}`) })
  const { answer } = migrated
  if (migrated.status === 409 || migrated.status === 422) {
    await rollbackRefusedMigration(
      `the data directory refused this release's migrations: ${migrated.status} ${answer}`,
      deployed,
      (configPath, previous) => runWrangler(['rollback', previous, '--config', configPath, '--yes', '--message', "the data directory refused this release's migrations"]),
      message => console.error(`publish-edge: ${message}`),
    )
  }
  if (!migrated.ok) fail(`the migrations' outcome is unknown, so the Workers stay on this release: ${migrated.status} ${answer}`)
  console.log(answer)
  // A lost answer may have been migrations that landed, which the ledger now answers as nothing owed.
  if (lost) {
    const restarted = await send('restart', { method: 'POST' })
    await restarted.body?.cancel()
    if (!restarted.ok) fail(`the restart after a lost migration answer failed: ${restarted.status}`)
  }
  if (lost || (JSON.parse(answer) as { applied: string[] }).applied.length) await settled('the migration')
}
// The dispatcher follows the directory's acceptance of this release: a refused
// migration rolls the object back with no dispatcher of this release left
// running, and runs the object enqueued meanwhile wait in the queue.
if (airlock) {
  const dispatcherDir = await Deno.makeTempDir({ prefix: 'publish-edge-airlock-' })
  try {
    const dispatcherSecrets = path.join(dispatcherDir, 'airlock.json')
    const names = [...airlock.secrets, ...airlock.providers.flat()]
    await Deno.writeTextFile(dispatcherSecrets, JSON.stringify(Object.fromEntries(names.flatMap(name => Deno.env.get(name) ? [[name, Deno.env.get(name)!]] : []))), { mode: 0o600 })
    console.log(await deploy(path.join(out, airlock.deployment), '--secrets-file', dispatcherSecrets))
  } finally {
    await Deno.remove(dispatcherDir, { recursive: true })
  }
}
if (ssr) {
  const warm = await edgeFetch(`${origin}/`, { headers: { accept: 'text/html' } })
  await warm.text()
  if (!warm.ok) fail(`warming ${origin}/ answered ${warm.status}`)
}
// What a page reads at the deployment's door is what the build wrote: its
// terminal config carries the target's ICE servers (edge-ice.ts).
await holdIceServers(deployedRelease(origin, edgeFetch), await releasedIceServers(builtRelease(path.join(out, 'public'))), origin)
const triggers = authSettings.triggers
if (triggers) {
  let poked!: Response
  let report = ''
  for (let attempt = 0; attempt < 10; attempt++) {
    poked = await edgeFetch(`${origin}/poke?caller=publish`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    report = await poked.text()
    if (poked.status !== 401) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!poked.ok) fail(`deployed and loaded, and the poke answered ${poked.status}: ${report}`)
  console.log(report)
}
console.log(JSON.stringify({ origin, loaded }))
