// The single-file page's entry: the payload read from the document, the app's
// files served from it through a fetch shim, and mecha's browser platform
// booted in the tab behind the same shim. `omnishell/` and `mecha-browser/`
// resolve through the map the bundler writes from the roots it is given.
import { PGlite } from '@electric-sql/pglite'
import { decodeBase64 } from '@std/encoding/base64'
import { createCluster, type Cluster } from 'mecha-browser/cluster.ts'
// @ts-ignore untyped interpreter module
import { createShell } from 'omnishell/shell.js'

interface Payload {
  files: Record<string, string>
  /** Absent for an app with no server entity, which boots no cluster. */
  cluster?: { sql: string[]; tables: string[]; assets: { wasm: string; data: string; initdb: string } }
}

const payload: Payload = JSON.parse(new TextDecoder().decode(decodeBase64(document.getElementById('pronto-payload')!.textContent!)))

const inflate = (b64: string): Promise<ArrayBuffer> =>
  new Response(new Blob([decodeBase64(b64)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()

const MIME: Record<string, string> = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', yaml: 'text/yaml', md: 'text/markdown',
}
const mime = (p: string) => MIME[p.split('.').pop() ?? ''] ?? 'text/plain'

let cluster: Cluster | null = null
const origFetch = globalThis.fetch.bind(globalThis)
// The shell asks for its files from the root, its <base> being /shell/ under
// any prefix, and the door's routes are root-absolute at every target.
const served = new Map(Object.entries(payload.files).map(([k, text]) => [`/${k}`, text]))

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input), location.href)
  if (url.origin === location.origin) {
    const path = url.pathname
    const text = served.get(path)
    if (text !== undefined) return new Response(text, { headers: { 'content-type': mime(path) } })
    if (cluster && /^\/(crud|auth|electric)(\/|$)/.test(path)) {
      const method = req?.method ?? init?.method ?? 'GET'
      const headers = new Headers(req?.headers ?? init?.headers)
      const body = method === 'GET' || method === 'HEAD' ? undefined : req ? await req.arrayBuffer() : (init?.body as BodyInit)
      const signal = req?.signal ?? init?.signal ?? undefined
      return cluster.handle(new Request(`http://cluster.local${path}${url.search}`, { method, headers, body, signal }))
    }
  }
  return origFetch(input as RequestInfo, init)
}

;(async () => {
  if (payload.cluster) {
    const { sql, tables, assets: a } = payload.cluster
    const [wasm, data, initdb] = await Promise.all([inflate(a.wasm), inflate(a.data), inflate(a.initdb)])
    const db = await PGlite.create({
      pgliteWasmModule: await WebAssembly.compile(wasm),
      initdbWasmModule: await WebAssembly.compile(initdb),
      fsBundle: new Blob([data]),
    })
    // A change the cluster lost leaves a table no read can trust again, so
    // the page dies of it where its boot would.
    cluster = await createCluster({
      db, sql, tables, log: console.error,
      fail: (e) => {
        document.body.textContent = `page failed: ${e.message}`
        reportError(e)
      },
    })
  }
  createShell({ config: './shell.json', mount: document.getElementById('app') })
})().catch((e) => {
  document.body.textContent = `boot failed: ${e instanceof Error ? e.message : String(e)}`
  throw e
})
