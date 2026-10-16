// Makes an edge release live: deploys <out> (edge.ts's) with the wrangler
// mecha's pglite-workerd pins, its secrets in the same version, and loads the
// data directory into its object. JWT_SECRET is set once, since every session
// is signed with it; IMPORT_TOKEN is new at every publish and lives only here.
// Secrets put after a deploy are a version of their own, which a request in
// between does not see. The load resumes a partial one and leaves a complete
// directory, live data, alone, unless --reset replaces it: the object answers
// 503 from the reset until the new directory is complete.
//
//   deno run -A --config bundle/deno.json bundle/publish-edge.ts <out> --mecha <dir> [--reset]
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

function fail(msg: string): never {
  console.error(`publish-edge: ${msg}`)
  Deno.exit(1)
}

const args = Deno.args.slice()
const out = path.resolve(args.shift() ?? fail('usage: publish-edge.ts <out> --mecha <dir> [--reset]'))
if (args.shift() !== '--mecha') fail('--mecha names the mecha root')
const mecha = path.resolve(args.shift() ?? fail('--mecha takes a value'))
const reset = args[0] === '--reset' && args.length === 1
if (args.length && !reset) fail(`unknown arguments ${args.join(' ')}`)
const workerd = path.join(mecha, 'packages/pglite-workerd')
const config = path.join(out, 'wrangler.jsonc')

async function run(cmd: string, args: string[], { cwd = out }: { cwd?: string } = {}): Promise<string> {
  const r = await new Deno.Command(cmd, { args, cwd, stdin: 'null', stdout: 'piped', stderr: 'inherit' }).output()
  const text = new TextDecoder().decode(r.stdout)
  if (!r.success) fail(`${cmd} ${args.join(' ')} exited ${r.code}:\n${text}`)
  return text
}

// By path: mise puts the npm backend's bin/ on PATH, where a bare `wrangler`
// can resolve to another install.
const wrangler = `${(await run('mise', ['where', 'npm:wrangler'], { cwd: workerd })).trim()}/node_modules/.bin/wrangler`
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')

const token = random()
const secretPath = path.join(path.dirname(out), '.jwt-secret')
let jwtSecret: string
try {
  jwtSecret = (await Deno.readTextFile(secretPath)).trim()
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error
  jwtSecret = random()
  await Deno.writeTextFile(secretPath, jwtSecret, { mode: 0o600 })
}
if (!jwtSecret) fail('JWT secret file is empty')
const secrets: Record<string, string> = { IMPORT_TOKEN: token, JWT_SECRET: jwtSecret }
const secretsDir = await Deno.makeTempDir({ prefix: 'publish-edge-' })
const secretsFile = path.join(secretsDir, 'secrets.json')
let deployed: string
try {
  await Deno.writeTextFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 })
  let ssr = false
  try { ssr = (await Deno.stat(path.join(out, 'renderer.jsonc'))).isFile }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
  if (ssr) {
    console.log(await run(wrangler, ['deploy', '--config', path.join(out, 'renderer.jsonc'), '--durable-objects-code-update-mode', 'immediate']))
    const settings = JSON.parse(await Deno.readTextFile(config))
    if (settings.durable_objects.bindings.some((binding: { name: string; script_name?: string }) => binding.name === 'CLUSTER' && binding.script_name)) {
      console.log(await run(wrangler, ['deploy', '--config', path.join(out, 'database.jsonc'), '--secrets-file', secretsFile, '--durable-objects-code-update-mode', 'immediate']))
    }
  }
  // The object restarts on the new code rather than at its next idle.
  deployed = await run(wrangler, ['deploy', '--config', config, '--secrets-file', secretsFile, '--durable-objects-code-update-mode', 'immediate'])
} finally {
  await Deno.remove(secretsDir, { recursive: true })
}
console.log(deployed)
const settings = JSON.parse(await Deno.readTextFile(config)) as { routes?: { pattern: string }[] }
const origin = settings.routes?.length ? `https://${settings.routes[0].pattern}` : /https:\/\/\S+\.workers\.dev/.exec(deployed)?.[0] ?? fail('wrangler deploy named no workers.dev URL')
const send = (route: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  let body = init?.body
  if (route.startsWith('chunk?') && body instanceof Uint8Array) {
    body = new Uint8Array(gzipSync(body, { level: 1 }))
    headers.set('content-encoding', 'gzip')
  }
  return fetch(`${origin}/import/${route}`, { ...init, body, headers })
}

// The version just deployed is everywhere once the Worker takes this token.
for (let streak = 0, t0 = Date.now(); ; ) {
  const res = await send('status')
  await res.body?.cancel()
  if (res.ok) {
    if (++streak >= 3) break
  } else {
    streak = 0
  }
  if (Date.now() - t0 > 120_000) fail(`${origin}/import/status still answers ${res.status} two minutes after the deploy`)
  await new Promise((r) => setTimeout(r, 2000))
}

const { load } = await import(String(pathToFileURL(path.join(workerd, 'load.ts'))))
const loaded = await load(path.join(out, 'pgdata'), send, { reset })
let ssr = false
try { ssr = (await Deno.stat(path.join(out, 'renderer.jsonc'))).isFile }
catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
if (ssr) {
  const warm = await fetch(`${origin}/`, { headers: { accept: 'text/html' } })
  await warm.body?.cancel()
  if (!warm.ok) fail(`warming ${origin}/ answered ${warm.status}`)
}
console.log(JSON.stringify({ origin, loaded }))
