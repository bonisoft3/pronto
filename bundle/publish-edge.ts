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
// the ledger existed, or holding a file this release changed — rolls every
// Worker this publish deployed back to the version it replaced, so the
// refusal is the publish's and not the site's. The deployment's terminal
// config is then held to the build's ICE servers. Where the release
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
import { releaseJwtSecret } from './edge-jwt.ts'
import { requireLocalCluster } from './edge-deployment.ts'

async function edgeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (err) {
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
const out = path.resolve(args.shift() ?? fail('usage: publish-edge.ts <out> --mecha <dir> [--reset] [--temporary]'))
if (args.shift() !== '--mecha') fail('--mecha names the mecha root')
const mecha = path.resolve(args.shift() ?? fail('--mecha takes a value'))
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const reset = flag('--reset')
// A throwaway Cloudflare account wrangler makes when none is logged in; it
// expires unless claimed.
const temporary = flag('--temporary') ? ['--temporary'] : []
if (args.length) fail(`unknown arguments ${args.join(' ')}`)
const workerd = path.join(mecha, 'packages/pglite-workerd')
const config = path.join(out, 'wrangler.jsonc')

async function run(cmd: string, args: string[], { cwd = out, env }: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const r = await new Deno.Command(cmd, { args, cwd, env, stdin: 'null', stdout: 'piped', stderr: 'inherit' }).output()
  const text = new TextDecoder().decode(r.stdout)
  if (!r.success) fail(`${cmd} ${args.join(' ')} exited ${r.code}:\n${text}`)
  return text
}

// By path: a bare `wrangler` on PATH can resolve to another install, and
// where the npm backend puts its bin differs between mise versions.
// The package's pinned node leads PATH for wrangler and its subprocesses.
await run('mise', ['trust', '--yes', '--all'], { cwd: workerd })
await run('mise', ['install', 'node', 'npm:wrangler'], { cwd: workerd })
const wranglerBin = (await run('mise', ['which', 'wrangler'], { cwd: workerd })).trim()
const node = (await run('mise', ['which', 'node'], { cwd: workerd })).trim()
const nodeDir = path.dirname(node)
const runEnv = { ...Deno.env.toObject(), PATH: `${nodeDir}${path.delimiter}${Deno.env.get('PATH') ?? ''}` }
const wrangler = (args: string[]) => run(wranglerBin, args, { env: runEnv })
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
const settings = JSON.parse(await Deno.readTextFile(config)) as { name: string; durable_objects?: { bindings: { name: string; script_name?: string }[] }; routes?: { pattern: string }[] }
if (!settings.durable_objects) {
  if (reset) fail('--reset requires a cluster')
  const deployed = await wrangler(['deploy', '--config', config, ...temporary])
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
const previous = await previousVersion(config)
await requireLocalCluster({ config, name: settings.name, previous, wrangler })
const jwtSecret = await releaseJwtSecret({
  secret: Deno.env.get('JWT_SECRET'), config, previous, wrangler, random,
})
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
/** The version a Worker serves now; null before its first deploy, which
 * Cloudflare answers with error 10007 (no such Worker). */
async function previousVersion(configPath: string): Promise<string | null> {
  const r = await new Deno.Command(wranglerBin, { args: ['deployments', 'list', '--config', configPath, '--json'], cwd: out, env: runEnv, stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
  const stderr = new TextDecoder().decode(r.stderr)
  if (!r.success) {
    if (stderr.includes('[code: 10007]')) return null
    fail(`wrangler deployments list --config ${configPath} exited ${r.code}:\n${stderr}`)
  }
  const listed = JSON.parse(new TextDecoder().decode(r.stdout)) as { versions: { version_id: string }[] }[]
  if (listed.at(-1)?.versions.length !== 1) fail('Release requires one active Worker version; finish the gradual deployment first')
  const version = listed.at(-1)?.versions[0]?.version_id
  if (!version) fail('Cloudflare returned no deployed version for an existing Worker')
  return version
}
async function deploy(configPath: string, ...flags: string[]): Promise<string> {
  const text = await wrangler(['deploy', '--config', configPath, ...flags, ...temporary])
  deployed.push({ config: configPath, previous })
  return text
}
await refuseMissingHatchSecrets({
  directory: out,
  configs: [config],
  temporary: !!temporary.length,
  deployedBefore: async configPath => await previousVersion(configPath) !== null,
  wrangler,
})
const secretsDir = await Deno.makeTempDir({ prefix: 'publish-edge-' })
const secretsFile = path.join(secretsDir, 'secrets.json')
let deployedText: string
try {
  await Deno.writeTextFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 })
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
    if (Date.now() - t0 > 120_000) fail(`${origin}/import/status still answers ${res.status} two minutes after ${after}`)
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
  let migrated: Response = await send('migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: migrationsBody })
  for (let attempt = 0; attempt < 5 && migrated.status === 401; attempt++) {
    await new Promise((r) => setTimeout(r, 2000))
    migrated = await send('migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: migrationsBody })
  }
  let answer = await migrated.text()
  let lost = false
  // Only a 409 says nothing moved. Any other failure may have lost the answer to migrations that
  // landed, and old code over migrated rows is worse than either: the ledger says which it was.
  for (let attempt = 0; attempt < 5 && !migrated.ok && migrated.status !== 409; attempt++) {
    console.log(`the migration answered ${migrated.status}; asking the ledger again once the object settles`)
    lost = true
    await settled('the migration')
    migrated = await send('migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: migrationsBody })
    answer = await migrated.text()
  }
  if (migrated.status === 409) {
    for (const { config: configPath, previous } of deployed.reverse()) {
      if (previous === null) continue
      console.log(await wrangler(['rollback', previous, '--config', configPath, '--yes', '--message', 'the data directory refused this release\'s migrations']))
    }
    fail(`the data directory the object kept refused this release's migrations, and the Workers are rolled back: ${answer}`)
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
let ssr = false
try { ssr = (await Deno.stat(path.join(out, 'renderer/assets.json'))).isFile }
catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
if (ssr) {
  const warm = await edgeFetch(`${origin}/`, { headers: { accept: 'text/html' } })
  await warm.text()
  if (!warm.ok) fail(`warming ${origin}/ answered ${warm.status}`)
}
// What a page reads at the deployment's door is what the build wrote: its
// terminal config carries the target's ICE servers (edge-ice.ts).
await holdIceServers(deployedRelease(origin, edgeFetch), await releasedIceServers(builtRelease(path.join(out, 'public'))), origin)
const triggers = deployedSettings.triggers
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
