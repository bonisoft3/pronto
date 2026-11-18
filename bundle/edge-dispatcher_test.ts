import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEffects } from './edge-effects.ts'
import { dispatcherName, writeEdgeDispatcher } from './edge-dispatcher.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const mecha = path.join(root, 'libraries/mecha')
const snapcards = path.join(root, 'apps/snapcards')
const bridged = fileURLToPath(new URL('../testdata/edge-bridge/', import.meta.url))
const isolated = fileURLToPath(new URL('../testdata/edge-isolate/', import.meta.url))

// The object imported effects.js, every handler and what each imports: the
// isolate the dispatcher was meant to relieve held them all.
Deno.test('the object reads the effects as declarations alone, and only the dispatcher loads their handlers', async () => {
  const out = await Deno.makeTempDir()
  try {
    await Deno.mkdir(path.join(out, 'src'))
    const { effects, declarations } = await renderEffects('snapcards', snapcards, mecha, out)
    assert.match(effects, /^import \* as handler_0 from /m)
    assert.doesNotMatch(declarations, /^import /m)
    await Deno.writeTextFile(path.join(out, 'src/effect-declarations.js'), declarations)
    const { default: declared } = await import(`file://${out}/src/effect-declarations.js`)
    assert.deepEqual(Object.keys(declared).sort(), ['heavy-draft', 'illustrate-card', 'print-alert', 'print-check', 'print-fx', 'print-place', 'print-quote', 'print-record', 'print-session', 'print-status', 'smollm3-draft'])
    for (const effect of Object.values(declared) as { declaration: { handler: string }; target: { kind: string }; issue?: unknown }[]) {
      assert.equal(typeof effect.declaration.handler, 'string')
      assert.equal(typeof effect.target.kind, 'string')
      assert.equal(effect.issue, undefined)
      assert.ok(Object.isFrozen(effect.declaration))
    }
    // Prodigi's sandbox or live is each deployment's: the target names the
    // dispatcher's secret, never a compiled URL.
    assert.deepEqual(declared['print-quote'].target, { kind: 'origin', secret: 'PRODIGI_ORIGIN' })
    assert.deepEqual(declared['print-fx'].target, { kind: 'origin', url: 'https://api.stripe.com' })
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})

// The keys were read off `targets.cloudflare` alone, so a global `models`
// override naming Google published a dispatcher with no key to call it.
Deno.test("the dispatcher's provider keys are tsbifrost's resolution of the release's models", async () => {
  const out = await Deno.makeTempDir()
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ name: 'snapcards', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] } }))
    const ai = { image: ['heavy'], models: { image: { heavy: { provider: 'google', model: 'imagen-4.0-ultra-generate-001' } } } }
    const release = await writeEdgeDispatcher(out, mecha, snapcards, ai)
    assert.deepEqual(release.providers, [['GEMINI_API_KEY', 'GOOGLE_API_KEY']])
    // A named origin is a secret the publish carries or finds held, as a key is.
    assert.ok(release.secrets.includes('PRODIGI_ORIGIN'))
    assert.deepEqual(JSON.parse(await Deno.readTextFile(path.join(out, 'src/airlock.json'))), release)
    const host = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    assert.deepEqual(host.queues.producers, [{ binding: 'AIRLOCK_QUEUE', queue: 'snapcards-airlock' }])
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})

// Level 3 was compiled to Gemini, so every deployment of one release needed
// a Gemini key. Snapcards' level 3 is each deployment's AI_IMAGE_HEAVY: a
// secret the publish carries or finds held, and the key only of its route.
Deno.test("an AI setting is the dispatcher's secret, and its route's key is the route's", async () => {
  const out = await Deno.makeTempDir()
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ name: 'snapcards', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] } }))
    const { ai } = JSON.parse(await Deno.readTextFile(path.join(snapcards, 'shell/shell.json')))
    const release = await writeEdgeDispatcher(out, mecha, snapcards, ai)
    assert.ok(release.secrets.includes('AI_IMAGE_HEAVY'))
    assert.deepEqual(release.providers, [])
    assert.deepEqual(release.routes, { AI_IMAGE_HEAVY: { cloudflare: [], google: [['GEMINI_API_KEY', 'GOOGLE_API_KEY']] } })
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})

// The base name was held to Cloudflare's 63 characters and the dispatcher's
// was not: `wrangler queues create` refused it mid-publish, after the object
// that enqueues to it was live.
Deno.test("a dispatcher's name past Cloudflare's 63 characters is refused at build", () => {
  assert.equal(dispatcherName('a'.repeat(55)), `${'a'.repeat(55)}-airlock`)
  assert.throws(() => dispatcherName('a'.repeat(56)), /longer than Cloudflare's 63 characters/)
})

// The release's --name (SAY_RELEASE_ARGS_NAME) names every Worker, queue and
// bucket it deploys; one Cloudflare would refuse is refused before the build
// reads the app or clears the last release's output.
Deno.test('edge.ts refuses a --name given empty or malformed before reading the app', async () => {
  for (const name of ['', 'Snap', '-x', 'a'.repeat(64)]) {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--config', fileURLToPath(new URL('./deno.json', import.meta.url)), fileURLToPath(new URL('./edge.ts', import.meta.url)), '/nonexistent', '--omnishell', '/nonexistent', '--mecha', '/nonexistent', '--ice-servers', '[]', '--name', name],
      stdout: 'null', stderr: 'piped',
    }).output()
    assert.equal(r.success, false)
    assert.match(new TextDecoder().decode(r.stderr), /--name must be lowercase letters/)
  }
})

// A bridge on cloudflare is a container of the dispatcher Worker: its class,
// binding, image and build context in the config, its class in the source
// with the environment bayt resolved, and its Dockerfile beside the config; a
// bridge on docker alone stays an address the edge never dials.
Deno.test('a bridge on cloudflare is lowered as a container of the dispatcher', async () => {
  const out = await Deno.makeTempDir()
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ name: 'fixture', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] } }))
    const release = await writeEdgeDispatcher(out, mecha, bridged, undefined)
    assert.deepEqual(release.containers, ['fetch-pages'])
    const config = JSON.parse(await Deno.readTextFile(path.join(out, 'airlock/wrangler.jsonc')))
    assert.deepEqual(config.containers, [{ class_name: 'BridgeFetchPages', image: './Dockerfile.fetch-pages', image_build_context: path.relative(path.join(out, 'airlock'), bridged), max_instances: 1 }])
    assert.deepEqual(config.durable_objects.bindings, [
      { name: 'CLUSTER', class_name: 'Cluster', script_name: 'fixture' },
      { name: 'BRIDGE_FETCH_PAGES', class_name: 'BridgeFetchPages' },
    ])
    assert.deepEqual(config.exports, { BridgeFetchPages: { type: 'durable-object', storage: 'sqlite' } })
    assert.equal(config.migrations, undefined)
    const dockerfile = await Deno.readTextFile(path.join(out, 'airlock/Dockerfile.fetch-pages'))
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.27@sha256:[0-9a-f]{64}\nFROM rust:[^\n]* AS transport-appliance\n/)
    const source = await Deno.readTextFile(path.join(out, 'src/dispatcher.ts'))
    assert.match(source, /^import \{ Bridge \} from '[^']*packages\/mecha-edge\/src\/bridge\.ts'$/m)
    assert.match(source, /^export class BridgeFetchPages extends Bridge \{\n  defaultPort = 8090\n  sleepAfter = '10m'\n  enableInternet = true\n  envVars = \{"TRANSPORT_MODE":"live","RUST_LOG":"info"\}\n\}$/m)
    assert.doesNotMatch(source, /BridgeMail/)

    const { declarations } = await renderEffects('fixture', bridged, mecha, out)
    await Deno.writeTextFile(path.join(out, 'src/effect-declarations.js'), declarations)
    const { default: declared } = await import(`file://${out}/src/effect-declarations.js`)
    assert.deepEqual(declared.acquire.target, { kind: 'container', bridge: 'fetch-pages', binding: 'BRIDGE_FETCH_PAGES' })
    assert.deepEqual(declared.confirm.target, { kind: 'bridge', bridge: 'mail' })
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})

Deno.test('a bridge with instance_type carries it into airlock/wrangler.jsonc', async () => {
  const out = await Deno.makeTempDir()
  const app = await Deno.makeTempDir()
  try {
    for (const rel of ['.pronto', '.bayt', 'services/airlock']) await Deno.mkdir(path.join(app, rel), { recursive: true })
    const cluster = JSON.parse(await Deno.readTextFile(path.join(bridged, '.pronto/cluster.json')))
    cluster.bridges[0].instance_type = 'standard-1'
    await Deno.writeTextFile(path.join(app, '.pronto/cluster.json'), JSON.stringify(cluster))
    for (const rel of ['.bayt/Dockerfile.transport-appliance', '.bayt/compose.transport-appliance.yaml', 'services/airlock/effects.json']) {
      await Deno.copyFile(path.join(bridged, rel), path.join(app, rel))
    }
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ name: 'fixture', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] } }))
    await writeEdgeDispatcher(out, mecha, app, undefined)
    const config = JSON.parse(await Deno.readTextFile(path.join(out, 'airlock/wrangler.jsonc')))
    assert.equal(config.containers[0].instance_type, 'standard-1')
  } finally {
    await Deno.remove(out, { recursive: true })
    await Deno.remove(app, { recursive: true })
  }
})

// Without a bridge on cloudflare the dispatcher declares no container, binds
// none and imports nothing that needs workerd.
Deno.test('a release without a bridge on cloudflare declares no container', async () => {
  const out = await Deno.makeTempDir()
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ name: 'snapcards', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] } }))
    const release = await writeEdgeDispatcher(out, mecha, snapcards, undefined)
    assert.deepEqual(release.containers, [])
    const config = JSON.parse(await Deno.readTextFile(path.join(out, 'airlock/wrangler.jsonc')))
    assert.equal(config.containers, undefined)
    assert.equal(config.exports, undefined)
    assert.equal(config.durable_objects.bindings.length, 1)
    assert.doesNotMatch(await Deno.readTextFile(path.join(out, 'src/dispatcher.ts')), /Container/)
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})

// An isolate's bridge on cloudflare is a Worker of its own, not a class of the
// dispatcher's: its isolate bounds its memory and time. The dispatcher binds
// it by service, the publish deploys it first, and what deploys is the bundle
// every release makes, with the WebAssembly beside it as modules.
Deno.test('an isolate bridge on cloudflare is a Worker of its own, bound by service', async () => {
  const out = await Deno.makeTempDir()
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ name: 'fixture', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] } }))
    const release = await writeEdgeDispatcher(out, mecha, isolated, undefined)
    assert.deepEqual(release.containers, [])
    assert.deepEqual(release.isolates, ['airlock/isolates/echo/wrangler.jsonc'])
    const config = JSON.parse(await Deno.readTextFile(path.join(out, 'airlock/wrangler.jsonc')))
    assert.deepEqual(config.services, [{ binding: 'BRIDGE_ECHO', service: 'fixture-airlock-echo' }])
    assert.equal(config.containers, undefined)
    assert.equal(config.exports, undefined)
    assert.deepEqual(config.durable_objects.bindings, [{ name: 'CLUSTER', class_name: 'Cluster', script_name: 'fixture' }])
    assert.doesNotMatch(await Deno.readTextFile(path.join(out, 'src/dispatcher.ts')), /Bridge/)
    const worker = JSON.parse(await Deno.readTextFile(path.join(out, 'airlock/isolates/echo/wrangler.jsonc')))
    assert.equal(worker.name, 'fixture-airlock-echo')
    assert.equal(worker.main, 'entry.js')
    assert.equal(worker.no_bundle, true)
    assert.equal(worker.workers_dev, false)
    assert.deepEqual(worker.rules, [{ type: 'ESModule', globs: ['**/*.js'] }, { type: 'CompiledWasm', globs: ['**/*.wasm'] }])
    // The shim, imported by a relative path from lib/sum.ts and by a bare
    // alias from main.ts, is never the bundle's: the bundle imports nothing,
    // and the registry beside it imports the shim, which the entry loads first.
    const dir = path.join(out, 'airlock/isolates/echo')
    const bundle = await Deno.readTextFile(path.join(dir, 'bundle.js'))
    assert.doesNotMatch(bundle, /^import .*;$/m)
    assert.match(bundle, /^import x from "\.\.\/docs\/add\.wasm\.js"`/m)
    assert.doesNotMatch(bundle, /AGFzbQ/)
    assert.match(await Deno.readTextFile(path.join(dir, 'shims.js')), /^import shim0 from "\.\/add\.wasm\.js"$/m)
    assert.equal(await Deno.readTextFile(path.join(dir, 'entry.js')), 'import "./shims.js"\nexport { default } from "./bundle.js"\n')
    await Deno.stat(path.join(out, 'airlock/isolates/echo/add.wasm'))
    await Deno.stat(path.join(out, 'airlock/isolates/echo/add.wasm.js'))

    const { declarations } = await renderEffects('fixture', isolated, mecha, out)
    await Deno.writeTextFile(path.join(out, 'src/effect-declarations.js'), declarations)
    const { default: declared } = await import(`file://${out}/src/effect-declarations.js`)
    assert.deepEqual(declared.echo.target, { kind: 'isolate', bridge: 'echo', binding: 'BRIDGE_ECHO' })
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})

// The bundle the edge deploys is the one Deno serves elsewhere: Workers-shaped,
// its WebAssembly a module under either.
Deno.test("an isolate's bundle serves under deno serve, its WebAssembly a module", async () => {
  // Deno loads a source-imported .wasm by its real path: macOS's temporary
  // directory is a symlink, from which the import is refused as unprepared.
  const out = await Deno.realPath(await Deno.makeTempDir())
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ name: 'fixture', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] } }))
    await writeEdgeDispatcher(out, mecha, isolated, undefined)
    const port = 18000 + Math.floor(Math.random() * 1000)
    const server = new Deno.Command(Deno.execPath(), {
      args: ['serve', '--no-config', '--allow-net', '--port', String(port), path.join(out, 'airlock/isolates/echo/entry.js')],
      stdout: 'null', stderr: 'piped',
    }).spawn()
    try {
      let answer: unknown
      for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/echo`, { method: 'POST', body: JSON.stringify({ a: 2, b: 3 }) })
          answer = await res.json()
          break
        } catch {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      if (answer === undefined) {
        try { server.kill('SIGKILL') } catch { /* it ended on its own */ }
        throw new Error(`deno serve never answered: ${new TextDecoder().decode((await server.output()).stderr)}`)
      }
      assert.deepEqual(answer, { echoed: { a: 2, b: 3 }, sum: 5, twice: 5, cdn: 'https://cdn.example/parser.wasm.js', note: 'example import("./docs/add.wasm.js") 2', page: '3\nimport x from "../docs/add.wasm.js"' })
    } finally {
      try { server.kill('SIGKILL') } catch { /* it ended on its own */ }
      await server.stderr.cancel().catch(() => {})
      await server.status.catch(() => {})
    }
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})
