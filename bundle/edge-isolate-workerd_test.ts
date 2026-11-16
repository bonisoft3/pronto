// An isolate's Worker as the edge deploys it (edge-bridges.ts's
// writeIsolateWorker), run under workerd and reached by service binding as
// the dispatcher reaches it: the build every release makes, unbundled by
// wrangler, its WebAssembly a source import, answering, and failing, as the
// host does elsewhere ([[../docs/isolate-hatches]]).
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { startWorker } from '../../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts'
import { clusterBridges, writeIsolateWorker } from './edge-bridges.ts'
import { PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE } from './cloudflare-runtime.ts'

const app = path.join(import.meta.dirname!, '../testdata/edge-isolate')

Deno.test("an isolate's Worker runs under workerd, its WebAssembly a module", async () => {
  const out = await Deno.realPath(await Deno.makeTempDir())
  try {
    const [bridge] = await clusterBridges(app)
    const config = await writeIsolateWorker(out, app, bridge, 'fixture-airlock-echo')
    // A caller reaching it by service binding, as the dispatcher does
    // (mecha-edge's dispatch.ts), reporting what the binding hands it.
    await Deno.mkdir(path.join(out, 'caller'))
    await Deno.writeTextFile(path.join(out, 'caller/caller.js'), `export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      const res = await env.BRIDGE_ECHO.fetch(new Request('http://echo' + url.pathname, { method: request.method, body: request.body }))
      return Response.json({ status: res.status, body: await res.text() })
    } catch (error) {
      return Response.json({ threw: String(error) })
    }
  },
}
`)
    await Deno.writeTextFile(path.join(out, 'caller/wrangler.jsonc'), JSON.stringify({ name: 'fixture-airlock', main: 'caller.js', compatibility_date: PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE, services: [{ binding: 'BRIDGE_ECHO', service: 'fixture-airlock-echo' }] }))
    const worker = await startWorker(new URL(`file://${path.join(out, 'caller/wrangler.jsonc')}`), path.join(out, 'state'), [new URL(`file://${path.join(out, config)}`)])
    try {
      const echoed = await (await fetch(`${worker.origin}/echo`, { method: 'POST', body: JSON.stringify({ a: 2, b: 3 }) })).json()
      assert.equal(echoed.status, 200)
      assert.deepEqual(JSON.parse(echoed.body), { echoed: { a: 2, b: 3 }, sum: 5, twice: 5, cdn: 'https://cdn.example/parser.wasm.js', note: 'example import("./docs/add.wasm.js") 2', page: '3\nimport x from "../docs/add.wasm.js"' })
      // A module that throws fails the binding's call, as a broken connection
      // fails it elsewhere: no status stands for an answer it never gave.
      assert.deepEqual(await (await fetch(`${worker.origin}/throw`)).json(), { threw: 'Error: the module refused' })
      assert.ok('threw' in await (await fetch(`${worker.origin}/network-error`)).json(), "a network error was answered with a status")
    } finally {
      await worker.stop()
    }
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})
