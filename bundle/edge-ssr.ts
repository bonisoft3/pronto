import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function writeEdgeSsr(out: string, omnishell: string, mecha: string, name: string, origin: string, databaseMode: 'existing' | 'separate' = 'existing') {
  out = await Deno.realPath(out)
  const headers = await Deno.readTextFile(path.join(out, 'public/_headers'))
  const policy = headers.match(/^  Content-Security-Policy: (.+)$/m)?.[1]
  if (!policy) throw new Error('the edge assets carry no Content-Security-Policy header')
  const separate = databaseMode === 'separate'
  const database = separate ? name + '-database' : name
  const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
  const generated = path.join(out, 'renderer')
  const server = path.join(omnishell, 'server')
  const { prepareWorker } = await import(pathToFileURL(path.join(server, 'prepare-worker.ts')).href)
  const cfg = await prepareWorker(path.join(out, 'public'), generated)
  // Keep the old renderer callable until its entry Worker has been replaced.
  // Its HTML must keep naming assets from the same release during deployment.
  const sources: [string, string][] = []
  async function collect(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === 'node_modules') continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory) await collect(file)
      else if (/\.(js|ts|json)$/.test(entry.name)) sources.push([path.relative(omnishell, file).replaceAll('\\', '/'), await Deno.readTextFile(file)])
    }
  }
  await collect(server)
  await collect(path.join(omnishell, 'interpreter'))
  sources.sort(([a], [b]) => a.localeCompare(b))
  const identity = JSON.stringify([origin, sources, await Deno.readTextFile(path.join(generated, 'assets.json'))])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)))
  const renderer = name + '-renderer-' + [...digest.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('')
  // Import specifiers, which a Windows path's separators would escape.
  const specifier = (from: string, file: string) => {
    const r = path.relative(from, file).replaceAll('\\', '/')
    return r.startsWith('.') ? r : `./${r}`
  }
  const fromSrc = (file: string) => specifier(path.join(out, 'src'), file)
  const rel = (file: string) => specifier(out, file)
  const edge = path.join(mecha, 'packages/mecha-edge/src')
  await Deno.writeTextFile(path.join(out, 'src/render.ts'), `
import '${fromSrc(path.join(server, 'worker-roles.ts'))}'
import { appRenderer } from '${fromSrc(path.join(server, 'worker-document.ts'))}'
import { renderObject } from '${fromSrc(path.join(server, 'render-object.ts'))}'
import assets from '../renderer/assets.json'
export class DocumentRenderer extends renderObject(appRenderer(assets, ${JSON.stringify(origin)})) {}
export default { fetch() { return new Response(null, { status: 404 }) } }
`)
  await Deno.writeTextFile(path.join(out, 'src/database.ts'), `
import { RpcTarget } from 'cloudflare:workers'
import { edgeObject, DataDirectoryLoading } from '${fromSrc(path.join(edge, 'object.ts'))}'
import { PublicSnapshotCapacity } from '${fromSrc(path.join(edge, 'public-snapshot.ts'))}'
import pgliteWasm from '../pglite/pglite.wasm'
import initdbWasm from '../pglite/initdb.wasm'
import pgliteData from '../pglite/pglite.data'
import icu from '../pglite/icu-root.tgz'
class SnapshotReader extends RpcTarget {
  constructor(snapshot) { super(); this.snapshot = snapshot }
  read(path) { return this.snapshot.read(path) }
}
const Base = edgeObject({
  assets: { pgliteWasm, initdbWasm, pgliteData, icu },
  tables: ${JSON.stringify(cfg.tables)},
  schema: ${JSON.stringify(cfg.schema ?? {})},
  ${separate ? "storageFormat: { version: 1, blockSize: 131072, codec: 'deflate' }," : ''}
})
export class Cluster extends Base {
  async render(request, renderer) {
    try {
      return await this.readPublic(async snapshot => {
        const response = await renderer.render(request, snapshot.revision, new SnapshotReader(snapshot))
        // Consume the RPC stream while the snapshot capability is still alive.
        return new Response(response.body ? await response.arrayBuffer() : null, response)
      })
    } catch (error) {
      if (!(error instanceof PublicSnapshotCapacity) && !(error instanceof DataDirectoryLoading)) throw error
      return new Response(request.method === 'HEAD' ? null : error.message, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
    }
  }
}
export default { fetch() { return new Response(null, { status: 404 }) } }
`)
  await Deno.writeTextFile(path.join(out, 'src/index.ts'), `
import { edgeWorker } from '${fromSrc(path.join(edge, 'worker.ts'))}'
import { edgeHints } from '${fromSrc(fileURLToPath(new URL('edge-hints.ts', import.meta.url)))}'
import { acceptedLanguages, routeAt } from '${fromSrc(path.join(omnishell, 'interpreter/fragment.js'))}'
import hints from './hints.json' with { type: 'json' }
${separate ? '' : "export { Cluster } from './database.ts'"}
const DOCUMENT_POLICY = ${JSON.stringify(policy)}
const RENDER_FRESH_MS = 60_000
const RENDER_SWR_S = 86_400
const RENDER_CACHE_CONTROL = 'public, no-cache, must-revalidate'
const stripServedReads = (html) => html.replace(/<script type="application\\/json" id="pronto-reads">[\\s\\S]*?<\\/script>/, '')
const keyOf = (...parts) => new Request(\`https://edge-cache.invalid/\${parts.map(encodeURIComponent).join('/')}\`)
const inFlight = new Map()
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const preferred = acceptedLanguages(request.headers.get('accept-language') ?? '')
    const found = (request.method === 'GET' || request.method === 'HEAD') ? routeAt(hints, url.pathname, url.search, preferred) : null
    if (found && found.route.ssr === 'ssr') {
      const linkHeader = edgeHints(request, hints, routeAt, preferred)
      const cache = globalThis.caches?.default
      const version = env.CF_VERSION_METADATA?.id ?? ''
      const reset = cache ? ((await (await cache.match(keyOf(version, 'reset')))?.text()) ?? '0') : '0'
      const lastWrite = cache ? ((await (await cache.match(keyOf(version, reset, 'writes', 'public')))?.text()) ?? '0') : '0'
      const cacheKey = new Request(\`https://edge-cache.invalid/${renderer}/\${encodeURIComponent(reset)}/\${encodeURIComponent(lastWrite)}/\${found.locale ?? ''}\${url.pathname}\${url.search}\`)
      const renderFresh = async () => {
        const getReq = request.method === 'HEAD' ? new Request(request.url, { headers: request.headers }) : request
        const renderer = env.RENDERER.get(env.RENDERER.idFromName('public'))
        const response = await env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).render(getReq, renderer)
        const body = response.body ? await response.arrayBuffer() : null
        const headers = new Headers(response.headers)
        headers.set('Link', linkHeader)
        headers.set('Content-Security-Policy', DOCUMENT_POLICY)
        if (cache && response.status === 200 && body && !request.headers.has('if-none-match')) {
          const storedHeaders = new Headers(headers)
          storedHeaders.set('cache-control', \`public, max-age=\${RENDER_SWR_S}\`)
          storedHeaders.set('x-rendered-at', String(Date.now()))
          await cache.put(cacheKey, new Response(body.slice(0), { status: 200, headers: storedHeaders }))
        }
        headers.set('x-edge-cache', 'miss')
        return { status: response.status, headers, body }
      }
      const renderShared = () => {
        let pending = inFlight.get(cacheKey.url)
        if (!pending) {
          pending = renderFresh().finally(() => inFlight.delete(cacheKey.url))
          inFlight.set(cacheKey.url, pending)
        }
        return pending
      }
      if (cache && !request.headers.has('if-none-match')) {
        const cached = await cache.match(cacheKey)
        if (cached) {
          const age = Date.now() - Number(cached.headers.get('x-rendered-at') ?? 0)
          const headers = new Headers(cached.headers)
          headers.delete('x-rendered-at')
          headers.set('cache-control', RENDER_CACHE_CONTROL)
          headers.set('Link', linkHeader)
          headers.set('Content-Security-Policy', DOCUMENT_POLICY)
          if (age <= RENDER_FRESH_MS) {
            headers.set('x-edge-cache', 'hit')
            return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers })
          }
          headers.delete('etag')
          headers.set('x-edge-cache', 'stale')
          ctx?.waitUntil?.(renderShared())
          // Drop carried reads on a stale hit so the browser paints cached HTML
          // immediately and revalidates live rows from /crud after first paint.
          // A prefetch keeps them: the tab holds what it seeds as stale and
          // refreshes it behind (omnishell's link-prefetch.js).
          const prefetch = request.headers.get('purpose') === 'prefetch'
          const staleBody = request.method === 'HEAD' ? null : prefetch ? await cached.text() : stripServedReads(await cached.text())
          return new Response(staleBody, { status: cached.status, headers })
        }
      }
      const fresh = await (request.headers.has('if-none-match') ? renderFresh() : renderShared())
      return new Response(request.method === 'HEAD' ? null : fresh.body, { status: fresh.status, headers: new Headers(fresh.headers) })
    }
    if (found) {
      let asset = await env.ASSETS.fetch(request)
      if (asset.status === 404) asset = await env.ASSETS.fetch(new Request(new URL('/', request.url), request))
      const result = new Response(request.method === 'HEAD' ? null : asset.body, asset)
      if (result.status === 200) result.headers.set('Link', edgeHints(request, hints, routeAt, preferred))
      return result
    }
    if (!['auth', 'crud', 'electric', 'import'].includes(url.pathname.split('/')[1]) &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        (request.headers.get('accept') ?? '').includes('text/html')) {
      const asset = await env.ASSETS.fetch(request)
      if (asset.status !== 404) return asset
      return new Response(request.method === 'HEAD' ? null : 'Page not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
    return edgeWorker.fetch(request, env, ctx)
  },
}
`)
  const common = { compatibility_date: '2026-09-01', observability: { enabled: true } }
  await Deno.writeTextFile(path.join(out, 'renderer.jsonc'), JSON.stringify({
    ...common, name: renderer, main: 'src/render.ts', workers_dev: false,
    durable_objects: { bindings: [{ name: 'RENDERER', class_name: 'DocumentRenderer' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['DocumentRenderer'] }],
    alias: {
      './jessie.js': rel(path.join(server, 'worker-roles.ts')),
      '@omnishell/jessie-startup': './renderer/jessie-startup.js',
      '@omnishell/release-roles': './renderer/roles.json',
      linkedom: rel(path.join(server, 'worker/node_modules/linkedom/esm/index.js')),
    },
  }, null, 2) + '\n')
  const databaseConfig = {
    ...common, name: database, main: 'src/database.ts', workers_dev: false,
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }],
    rules: [
      { type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false },
      { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false },
    ],
    alias: {
      '@electric-sql/pglite': './pglite/index.js', '@electric-sql/pglite/basefs': './pglite/fs/base.js',
      '@mecha/postgrest-js': rel(path.join(mecha, 'packages/postgrest-js/src/index.ts')),
    },
  }
  if (separate) await Deno.writeTextFile(path.join(out, 'database.jsonc'), JSON.stringify(databaseConfig, null, 2) + '\n')
  else {
    try { await Deno.remove(path.join(out, 'database.jsonc')) }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
  }
  config.name = name
  config.main = 'src/index.ts'
  config.durable_objects = { bindings: [{ name: 'CLUSTER', class_name: 'Cluster', ...(separate ? { script_name: database } : {}) }, { name: 'RENDERER', class_name: 'DocumentRenderer', script_name: renderer }] }
  config.assets.run_worker_first = ['/']
  if (separate) {
    delete config.migrations
    delete config.rules
    delete config.alias
  } else {
    config.migrations ??= databaseConfig.migrations
    config.rules = databaseConfig.rules
    config.alias = databaseConfig.alias
  }
  await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify(config, null, 2) + '\n')
}

if (import.meta.main) {
  const [out, omnishell, mecha, name, origin, mode = 'existing'] = Deno.args
  if (!origin) throw new Error('edge-ssr.ts <release-directory> <omnishell> <mecha> <worker-name> <public-origin>')
  if (mode !== 'existing' && mode !== 'separate') throw new Error('database mode must be existing or separate')
  await writeEdgeSsr(path.resolve(out), path.resolve(omnishell), path.resolve(mecha), name, origin, mode)
}
