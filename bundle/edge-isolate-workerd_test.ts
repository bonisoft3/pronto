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
import { pdfOf, receipt, RECEIPT_SHA256, sha256, shape } from '../testdata/pdf-isolate/receipt.ts'

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

// pronto's stock pdf isolate as its Worker, from the sources pronto writes
// into an app (isolates/pdf): the receipt it renders under Deno is the same
// bytes here.
Deno.test("the stock pdf isolate's Worker renders under workerd the bytes Deno renders", async () => {
  const out = await Deno.realPath(await Deno.makeTempDir())
  try {
    const [echo] = await clusterBridges(app)
    const files = ['isolates/pdf/main.ts', 'isolates/pdf/deno.json', 'isolates/pdf/deno.lock']
    const bridge = { name: 'pdf', container: 'pdf', port: 8080, targets: ['cloudflare'], build: 'pdf-appliance', isolate: { entrypoint: files[0], files, memory: 128, build: echo.isolate!.build } }
    const config = await writeIsolateWorker(out, path.join(import.meta.dirname!, '..'), bridge, 'fixture-airlock-pdf')
    await Deno.mkdir(path.join(out, 'caller'))
    await Deno.writeTextFile(path.join(out, 'caller/caller.js'), `export default {
  async fetch(request, env) {
    return env.BRIDGE_PDF.fetch(new Request('http://pdf/', { method: 'POST', body: request.body }))
  },
}
`)
    await Deno.writeTextFile(path.join(out, 'caller/wrangler.jsonc'), JSON.stringify({ name: 'fixture-airlock', main: 'caller.js', compatibility_date: PRONTO_RUNTIME_CLOUDFLARE_WORKER_COMPATIBILITY_DATE, services: [{ binding: 'BRIDGE_PDF', service: 'fixture-airlock-pdf' }] }))
    const worker = await startWorker(new URL(`file://${path.join(out, 'caller/wrangler.jsonc')}`), path.join(out, 'state'), [new URL(`file://${path.join(out, config)}`)])
    try {
      const answered = await fetch(worker.origin, { method: 'POST', body: JSON.stringify(receipt) })
      assert.equal(answered.status, 200)
      const bytes = await pdfOf(answered)
      assert.equal(shape(bytes).pages, 1)
      assert.equal(await sha256(bytes), RECEIPT_SHA256)
      const garbled = await fetch(worker.origin, { method: 'POST', body: '{' })
      assert.equal(garbled.status, 400)
      await garbled.body?.cancel()
    } finally {
      await worker.stop()
    }
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})
