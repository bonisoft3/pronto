import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEffects } from './edge-effects.ts'
import { dispatcherName, writeEdgeDispatcher } from './edge-dispatcher.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const mecha = path.join(root, 'libraries/mecha')
const snapcards = path.join(root, 'apps/snapcards')
const bridged = fileURLToPath(new URL('../testdata/edge-bridge/', import.meta.url))

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
    assert.deepEqual(JSON.parse(await Deno.readTextFile(path.join(out, 'src/airlock.json'))), release)
    const host = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    assert.deepEqual(host.queues.producers, [{ binding: 'AIRLOCK_QUEUE', queue: 'snapcards-airlock' }])
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
