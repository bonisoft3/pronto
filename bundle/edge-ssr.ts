import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { edgeRoutingRules } from './edge-addresses.ts'
import { clusterDrains } from './edge-scripts.ts'

/** `drains` is the app's drain table (.pronto/cluster.json), which the
 * database object calls. */
export async function writeEdgeSsr(out: string, omnishell: string, mecha: string, name: string, origin: string, drains: unknown[], databaseMode: 'existing' | 'separate' = 'existing', clock: 'ticker' | 'disabled' = 'ticker') {
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
export class DocumentRenderer extends renderObject(appRenderer(assets, ${JSON.stringify(origin)}), ${JSON.stringify(renderer)}) {}
export default { fetch() { return new Response(null, { status: 404 }) } }
`)
  await Deno.writeTextFile(path.join(out, 'src/database.ts'), `
import { RpcTarget } from 'cloudflare:workers'
import { edgeObject, DataDirectoryLoading } from '${fromSrc(path.join(edge, 'object.ts'))}'
${separate ? `import { pokeCluster } from '${fromSrc(path.join(edge, 'clock.ts'))}'\n` : ''}import { PublicSnapshotCapacity } from '${fromSrc(path.join(edge, 'public-snapshot.ts'))}'
import pgliteWasm from '../pglite/pglite.wasm'
import initdbWasm from '../pglite/initdb.wasm'
import pgliteData from '../pglite/pglite.data'
import icu from '../pglite/icu-root.tgz'
class SnapshotReader extends RpcTarget {
  constructor(snapshot) { super(); this.snapshot = snapshot }
  read(path) { return this.snapshot.read(path) }
}
const Base = edgeObject({
  clock: ${JSON.stringify(clock)},
  assets: { pgliteWasm, initdbWasm, pgliteData, icu },
  tables: ${JSON.stringify(cfg.tables)},
  schema: ${JSON.stringify(cfg.schema ?? {})},
  drains: ${JSON.stringify(drains)},
  ${separate ? "storageFormat: { version: 1, blockSize: 131072, codec: 'deflate' }," : ''}
})
export class Cluster extends Base {
  async render(request, renderer) {
    try {
      const priority = request.headers.get('x-pronto-speculative') === '1' ? 'low' : 'high'
      let resolveResponse
      let rejectResponse
      let committed = false
      const responseReady = new Promise((resolve, reject) => {
        resolveResponse = (res) => { committed = true; resolve(res) }
        rejectResponse = reject
      })
      const snapshotDone = this.readPublic(async snapshot => {
        const response = await renderer.render(request, snapshot.revision, new SnapshotReader(snapshot))
        const init = { status: response.status, headers: new Headers(response.headers) }
        if (!response.body) {
          resolveResponse(new Response(null, init))
          return
        }
        const { readable, writable } = new TransformStream()
        resolveResponse(new Response(readable, init))
        await response.body.pipeTo(writable)
      }, priority).catch(error => {
        if (!committed) {
          rejectResponse(error)
          return
        }
        throw error
      })
      this.ctx?.waitUntil?.(snapshotDone)
      return await responseReady
    } catch (error) {
      if (!(error instanceof PublicSnapshotCapacity) && !(error instanceof DataDirectoryLoading)) throw error
      return new Response(request.method === 'HEAD' ? null : error.message, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
    }
  }
}
${separate ? "// The Cron Trigger pokes the object from the Worker that holds it.\nexport default { fetch() { return new Response(null, { status: 404 }) }, scheduled(_controller, env) { return pokeCluster(env) } }" : 'export default { fetch() { return new Response(null, { status: 404 }) } }'}
`)
  await Deno.writeTextFile(path.join(out, 'src/index.ts'), `
import { edgeWorker } from '${fromSrc(path.join(edge, 'worker.ts'))}'
import { edgeHints } from '${fromSrc(fileURLToPath(new URL('edge-hints.ts', import.meta.url)))}'
import { acceptedLanguages, routeAt, stripProgressiveReads } from '${fromSrc(path.join(omnishell, 'interpreter/fragment.js'))}'
import hints from './hints.json' with { type: 'json' }
${separate ? '' : "export { Cluster } from './database.ts'"}
const DOCUMENT_POLICY = ${JSON.stringify(policy)}
const RENDER_FRESH_MS = 60_000
const RENDER_SWR_S = 86_400
const RENDER_CACHE_CONTROL = 'public, no-cache, must-revalidate'
const stripServedReads = (html) => html.replace(/<script type="application\\/json" id="pronto-reads">[\\s\\S]*?<\\/script>/, '')
const keyOf = (...parts) => new Request(\`https://edge-cache.invalid/\${parts.filter(Boolean).map(encodeURIComponent).join('/')}\`)
const inFlight = new Map()
export default {
${separate ? '' : '  scheduled: edgeWorker.scheduled,\n'}  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const preferred = acceptedLanguages(request.headers.get('accept-language') ?? '')
    const isAsset = /^\\/(?:_immutable-|(?:shell|omnishell|messages)\\/)/.test(url.pathname)
    const found = (!isAsset && (request.method === 'GET' || request.method === 'HEAD')) ? routeAt(hints, url.pathname, url.search, preferred) : null
    if (found && found.route.ssr === 'ssr') {
      const prefetch = request.headers.get('x-pronto-prefetch') === '1' || request.headers.get('purpose') === 'prefetch' || Boolean(request.headers.get('sec-purpose')?.includes('prefetch'))
      const linkHeader = prefetch ? null : edgeHints(request, hints, routeAt, preferred)
      const cache = globalThis.caches?.default
      const version = env.CF_VERSION_METADATA?.id ?? ''
      const reset = cache ? ((await (await cache.match(keyOf(version, 'reset')))?.text()) ?? '0') : '0'
      const lastWrite = cache ? ((await (await cache.match(keyOf(version, reset, 'writes', 'public')))?.text()) ?? '0') : '0'
      const cacheKey = new Request(\`https://edge-cache.invalid/${renderer}/\${encodeURIComponent(version)}/\${encodeURIComponent(reset)}/\${encodeURIComponent(lastWrite)}/\${encodeURIComponent(found.locale || '_')}\${url.pathname}\${url.search}\`)
      const renderFresh = async (speculative = false) => {
        const reqHeaders = new Headers(request.headers)
        if (speculative) reqHeaders.set('x-pronto-speculative', '1')
        const getReq = request.method === 'HEAD' || speculative ? new Request(request.url, { headers: reqHeaders }) : request
        const renderer = env.RENDERER.get(env.RENDERER.idFromName('public'))
        const response = await env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).render(getReq, renderer)
        const headers = new Headers(response.headers)
        headers.set('Link', edgeHints(request, hints, routeAt, preferred))
        headers.set('Content-Security-Policy', DOCUMENT_POLICY)
        const storedHeaders = new Headers(headers)
        headers.set('x-edge-cache', 'miss')
        if (!response.body) {
          return { status: response.status, headers, makeStream: () => null, done: Promise.resolve() }
        }
        const chunks = []
        const writers = new Set()
        let streamDone = false
        let streamErr = null
        const onWriterDisconnect = (w) => {
          writers.delete(w)
          if (writers.size === 0 && !streamDone) ctx?.waitUntil?.(done)
        }
        const makeStream = () => {
          const { readable, writable } = new TransformStream()
          const writer = writable.getWriter()
          for (const c of chunks) writer.write(c).catch(() => onWriterDisconnect(writer))
          if (streamDone) {
            if (streamErr) writer.abort(streamErr).catch(() => {})
            else writer.close().catch(() => {})
          } else {
            writers.add(writer)
          }
          return readable
        }
        const reader = response.body.getReader()
        const done = (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value && value.byteLength > 0) {
                chunks.push(value)
                for (const w of writers) w.write(value).catch(() => onWriterDisconnect(w))
              }
            }
            streamDone = true
            if (cache && response.status === 200 && chunks.length > 0 && !request.headers.has('if-none-match')) {
              const total = chunks.reduce((n, c) => n + c.byteLength, 0)
              const combined = new Uint8Array(total)
              let offset = 0
              for (const c of chunks) {
                combined.set(c, offset)
                offset += c.byteLength
              }
              const cleanBody = prefetch
                ? new TextEncoder().encode(stripProgressiveReads(new TextDecoder().decode(combined)))
                : combined
              storedHeaders.delete('vary')
              storedHeaders.delete('link')
              storedHeaders.set('cache-control', \`public, max-age=\${RENDER_SWR_S}\`)
              storedHeaders.set('x-rendered-at', String(Date.now()))
              // Keep downstream writers open until cache.put settles so the isolate stays alive without waitUntil.
              await cache.put(cacheKey, new Response(cleanBody, { status: 200, headers: storedHeaders }))
            }
            for (const w of writers) w.close().catch(() => {})
            writers.clear()
          } catch (err) {
            streamErr = err
            streamDone = true
            for (const w of writers) w.abort(err).catch(() => {})
            writers.clear()
            throw err
          }
        })()
        return { status: response.status, headers, makeStream, done }
      }
      const renderShared = (speculative = false) => {
        let pending = inFlight.get(cacheKey.url)
        if (!pending) {
          const clear = () => inFlight.delete(cacheKey.url)
          pending = renderFresh(speculative).then(res => {
            res.done.then(clear, clear)
            return res
          }, err => {
            clear()
            throw err
          })
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
          headers.set('vary', 'Accept-Language')
          if (linkHeader) headers.set('Link', linkHeader)
          else headers.delete('Link')
          headers.set('Content-Security-Policy', DOCUMENT_POLICY)
          if (age <= RENDER_FRESH_MS) {
            headers.set('x-edge-cache', 'hit')
            return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers })
          }
          headers.delete('etag')
          headers.set('x-edge-cache', 'stale')
          ctx?.waitUntil?.(renderShared(true).then(r => r.done))
          // Drop carried reads on a stale hit so the browser paints cached HTML
          // immediately and revalidates live rows from /crud after first paint.
          // A prefetch keeps them: the tab holds what it seeds as stale and
          // refreshes it behind (omnishell's link-prefetch.js).
          const staleBody = request.method === 'HEAD' ? null : prefetch ? await cached.text() : stripServedReads(await cached.text())
          return new Response(staleBody, { status: cached.status, headers })
        }
      }
      const fresh = await (request.headers.has('if-none-match') ? renderFresh() : renderShared())
      const freshHeaders = new Headers(fresh.headers)
      if (!linkHeader) freshHeaders.delete('Link')
      if (request.method === 'HEAD') ctx?.waitUntil?.(fresh.done)
      return new Response(request.method === 'HEAD' ? null : fresh.makeStream(), { status: fresh.status, headers: freshHeaders })
    }
    if (found) {
      let asset = await env.ASSETS.fetch(request)
      if (asset.status === 404) asset = await env.ASSETS.fetch(new Request(new URL('/', request.url), request))
      const result = new Response(request.method === 'HEAD' ? null : asset.body, asset)
      if (result.status === 200) result.headers.set('Link', edgeHints(request, hints, routeAt, preferred))
      return result
    }
    if (env.ASSETS &&
        !['auth', 'crud', 'electric', 'import', 'poke'].includes(url.pathname.split('/')[1]) &&
        (request.method === 'GET' || request.method === 'HEAD')) {
      const asset = await env.ASSETS.fetch(request)
      if (asset.status === 200) {
        if (url.pathname.startsWith('/_immutable-') || url.pathname.includes('/_immutable-')) {
          const headers = new Headers(asset.headers)
          headers.set('Cache-Control', 'public, max-age=31536000, immutable')
          return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers })
        }
        return asset
      }
      if (asset.status !== 404) return asset
      const notFound = (request.headers.get('accept') ?? '').includes('text/html') ? 'Page not found' : 'Not found'
      return new Response(request.method === 'HEAD' ? null : notFound, { status: 404, headers: { 'Cache-Control': 'no-store' } })
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
  // The Cron Trigger (edge.ts) belongs to the Worker holding the object.
  const triggers = config.triggers
  delete config.triggers
  const databaseConfig = {
    ...common, name: database, main: 'src/database.ts', workers_dev: false,
    ...(separate && triggers ? { triggers } : {}),
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
  config.version_metadata = { binding: 'CF_VERSION_METADATA' }
  config.durable_objects = { bindings: [{ name: 'CLUSTER', class_name: 'Cluster', ...(separate ? { script_name: database } : {}) }, { name: 'RENDERER', class_name: 'DocumentRenderer', script_name: renderer }] }
  config.assets.run_worker_first = await edgeRoutingRules(path.join(out, 'public'))
  if (separate) {
    delete config.migrations
    delete config.rules
    delete config.alias
  } else {
    if (triggers) config.triggers = triggers
    config.migrations ??= databaseConfig.migrations
    config.rules = databaseConfig.rules
    config.alias = databaseConfig.alias
  }
  await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify(config, null, 2) + '\n')
}

if (import.meta.main) {
  const [out, omnishell, mecha, name, origin, clusterJson, mode = 'existing', clock = 'ticker'] = Deno.args
  if (!clusterJson) throw new Error('edge-ssr.ts <release-directory> <omnishell> <mecha> <worker-name> <public-origin> <app>/.pronto/cluster.json [existing|separate] [ticker|disabled]')
  if (mode !== 'existing' && mode !== 'separate') throw new Error('database mode must be existing or separate')
  if (clock !== 'ticker' && clock !== 'disabled') throw new Error('clock must be ticker or disabled')
  const drains = await clusterDrains(clusterJson)
  await writeEdgeSsr(path.resolve(out), path.resolve(omnishell), path.resolve(mecha), name, origin, drains, mode, clock)
}
