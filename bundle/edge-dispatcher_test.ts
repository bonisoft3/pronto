import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEffects } from './edge-effects.ts'
import { dispatcherName, writeEdgeDispatcher } from './edge-dispatcher.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const mecha = path.join(root, 'libraries/mecha')
const snapcards = path.join(root, 'apps/snapcards')

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
    assert.deepEqual(Object.keys(declared).sort(), ['heavy-draft', 'illustrate-card', 'smollm3-draft'])
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
