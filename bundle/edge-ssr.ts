import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { edgeRoutingRules } from './edge-addresses.ts'
import { realmDocumentsOf } from './edge-templates.ts'
import { clusterDrains } from './edge-scripts.ts'

/** `drains` is the app's drain table (.pronto/cluster.json), which the
 * database object calls. */
/** The script that holds the database object: the release's own, or its
 * separate database Worker's when SSR renders apart from it. */
export const databaseScript = (name: string, databaseMode: 'existing' | 'separate') =>
  databaseMode === 'separate' ? `${name}-database` : name

export async function writeEdgeSsr(out: string, omnishell: string, mecha: string, name: string, origin: string, drains: unknown[], databaseMode: 'existing' | 'separate' = 'existing', clock: 'ticker' | 'disabled' = 'ticker') {
  out = await Deno.realPath(out)
  const headers = await Deno.readTextFile(path.join(out, 'public/_headers'))
  const policy = headers.match(/^  Content-Security-Policy: (.+)$/m)?.[1]
  if (!policy) throw new Error('the edge assets carry no Content-Security-Policy header')
  const separate = databaseMode === 'separate'
  const database = databaseScript(name, databaseMode)
  const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
  let compute
  try { compute = JSON.parse(await Deno.readTextFile(path.join(out, 'src/compute.json'))) }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
  if (compute && !compute.reader?.script_name) throw new Error('computation requires an immutable reader Worker')
  const images = (config.r2_buckets as { binding?: string }[] | undefined)?.some(b => b.binding === 'BLOB_OBJECTS') ?? false
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
  const fileExists = async (p: string) => {
    try { return (await Deno.stat(p)).isFile }
    catch (e) { if (e instanceof Deno.errors.NotFound) return false; throw e }
  }
  const hasMachines = await fileExists(path.join(out, 'src/machines.js'))
  const hasEffects = await fileExists(path.join(out, 'src/effects.js'))
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
${hasMachines ? "import machines from './machines.js'\n" : ''}${hasEffects ? "import effects from './effect-declarations.js'\n" : ''}import pgliteWasm from '../pglite/pglite.wasm'
import initdbWasm from '../pglite/initdb.wasm'
import pgliteData from '../pglite/pglite.data'
import icu from '../pglite/icu-root.tgz'
${compute ? `import { computeCoordinator } from '${fromSrc(path.join(edge, "compute-coordinator.ts"))}'\nexport class ComputeCoordinator extends computeCoordinator(undefined, ${JSON.stringify(compute.paged ?? [])}, ${JSON.stringify(compute.services[0].service)}) {}\n` : ''}
${compute ? "import computeMachines from './compute-machine.js'\n" : ''}
class SnapshotReader extends RpcTarget {
  constructor(snapshot, done) { super(); this.snapshot = snapshot; this.done = done }
  read(path) { return this.snapshot.read(path) }
  readMany(paths) { return this.snapshot.readMany(paths) }
  [Symbol.dispose]() { this.done() }
}
const Base = edgeObject({
  clock: ${JSON.stringify(clock)},
  assets: { pgliteWasm, initdbWasm, pgliteData, icu },
  tables: ${JSON.stringify(cfg.tables)},
  schema: ${JSON.stringify(cfg.schema ?? {})},
  drains: ${JSON.stringify(drains)},${hasMachines ? '\n  machines,' : ''}${hasEffects ? '\n  effects,' : ''}
  ${compute ? 'compute: { computations: ' + JSON.stringify(compute.definitions) + ', machine: computeMachines.compute_batch, physicalSnapshots: true, reader: ' + JSON.stringify(compute.reader.script_name) + ' },' : ''}
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
        let readerDone
        const rendered = new Promise(resolve => { readerDone = resolve })
        // The lane is the object's one connection: a renderer that never gives the snapshot back
        // would hold every other read behind it.
        const SNAPSHOT_LEASE_MS = 20_000
        let expire
        const lease = new Promise((_, reject) => { expire = setTimeout(() => reject(Object.assign(new Error(\`\${request.url} held its snapshot past \${SNAPSHOT_LEASE_MS} ms\`), { refused: true })), SNAPSHOT_LEASE_MS) })
        try {
          const response = await Promise.race([renderer.render(request, snapshot.revision, new SnapshotReader(snapshot, readerDone)), lease])
          resolveResponse(response)
          await Promise.race([rendered, lease])
        } finally { clearTimeout(expire) }
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
      if (!(error instanceof PublicSnapshotCapacity) && !(error instanceof DataDirectoryLoading) && error?.refused !== true) throw error
      console.error('render refused', request.url, error.message)
      return new Response(request.method === 'HEAD' ? null : error.message, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
    }
  }
}
${separate ? "// The Cron Trigger pokes the object from the Worker that holds it.\nexport default { fetch() { return new Response(null, { status: 404 }) }, scheduled(_controller, env) { return pokeCluster(env) } }" : 'export default { fetch() { return new Response(null, { status: 404 }) } }'}
`)
  await Deno.writeTextFile(path.join(out, 'src/index.ts'), `
import { edgeWorker } from '${fromSrc(path.join(edge, 'worker.ts'))}'
import { edgeHints } from '${fromSrc(fileURLToPath(new URL('edge-hints.ts', import.meta.url)))}'
import { originAssets } from '${fromSrc(fileURLToPath(new URL('edge-templates.ts', import.meta.url)))}'
${images ? `import { edgeImage } from '${fromSrc(fileURLToPath(new URL('edge-images.ts', import.meta.url)))}'\n` : ''}import { acceptedLanguages, IMAGE_WIDTHS, routeAt, stripProgressiveReads } from '${fromSrc(path.join(omnishell, 'interpreter/fragment.js'))}'
import hints from './hints.json' with { type: 'json' }
${separate ? '' : `export { Cluster${compute ? ", ComputeCoordinator" : ""} } from './database.ts'`}
const DOCUMENT_POLICY = ${JSON.stringify(policy)}
const RENDER_FRESH_MS = 60_000
const RENDER_SWR_S = 86_400
const RENDER_CACHE_CONTROL = 'public, no-cache, must-revalidate'
const stripServedReads = (html) => html.replace(/<script type="application\\/json" id="pronto-reads">[\\s\\S]*?<\\/script>/, '')
const keyOf = (...parts) => new Request(\`https://edge-cache.invalid/\${parts.filter(Boolean).map(encodeURIComponent).join('/')}\`)
const inFlight = new Map()
export default {
${separate ? '' : '  scheduled: edgeWorker.scheduled,\n'}
  async fetch(request, env, ctx) {
    if (env.ASSETS) env = { ...env, ASSETS: originAssets(env.ASSETS, ${JSON.stringify(realmDocumentsOf(cfg))}) }
${images ? '    const image = await edgeImage(request, env, caches.default, ctx, IMAGE_WIDTHS)\n    if (image) return image\n' : ''}    const url = new URL(request.url)
    const preferred = acceptedLanguages(request.headers.get('accept-language') ?? '')
    const isAsset = /^\\/(?:_immutable-|(?:shell|omnishell|messages)\\/)/.test(url.pathname)
    const found = (!isAsset && (request.method === 'GET' || request.method === 'HEAD')) ? routeAt(hints, url.pathname, url.search, preferred) : null
    // What a spa route serves: the entry shell, whose store reads the rows itself.
    const entryShell = async () => {
      let asset = await env.ASSETS.fetch(request)
      if (asset.status === 404) asset = await env.ASSETS.fetch(new Request(new URL('/', request.url), request))
      const result = new Response(request.method === 'HEAD' ? null : asset.body, asset)
      if (result.status === 200) result.headers.set('Link', edgeHints(request, hints, routeAt, preferred))
      return result
    }
    if (found && found.route.ssr === 'ssr') {
      const prefetch = request.headers.get('x-pronto-prefetch') === '1' || request.headers.get('purpose') === 'prefetch' || Boolean(request.headers.get('sec-purpose')?.includes('prefetch'))
      const linkHeader = prefetch ? null : edgeHints(request, hints, routeAt, preferred)
      const cache = globalThis.caches?.default
      const version = env.CF_VERSION_METADATA?.id ?? ''
      const reset = cache ? ((await (await cache.match(keyOf(version, 'reset')))?.text()) ?? '0') : '0'
      const lastWrite = cache ? ((await (await cache.match(keyOf(version, reset, 'writes', 'public')))?.text()) ?? '0') : '0'
      const cacheKey = new Request(\`https://edge-cache.invalid/\${encodeURIComponent(version)}/\${encodeURIComponent(reset)}/\${encodeURIComponent(found.locale || '_')}\${url.pathname}\${url.search}\`)
      // A write moved this key once, so every visitor's write cost the next reader of every page a
      // render of seconds. It now makes a document stale, which paints at once and renders behind.
      const sharedRender = cacheKey.url + '|' + lastWrite
      const renderFresh = async (speculative = false) => {
        // When it began: a write landing during the render may not be in it.
        const startedAt = Date.now()
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
              storedHeaders.set('x-rendered-at', String(startedAt))
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
        let pending = inFlight.get(sharedRender)
        if (!pending) {
          const clear = () => inFlight.delete(sharedRender)
          pending = renderFresh(speculative).then(res => {
            res.done.then(clear, clear)
            return res
          }, err => {
            clear()
            throw err
          })
          inFlight.set(sharedRender, pending)
        }
        return pending
      }
      if (cache && !request.headers.has('if-none-match')) {
        const cached = await cache.match(cacheKey)
        if (cached) {
          const renderedAt = Number(cached.headers.get('x-rendered-at') ?? 0)
          const age = Date.now() - renderedAt
          const headers = new Headers(cached.headers)
          headers.delete('x-rendered-at')
          headers.set('cache-control', RENDER_CACHE_CONTROL)
          headers.set('vary', 'Accept-Language')
          if (linkHeader) headers.set('Link', linkHeader)
          else headers.delete('Link')
          headers.set('Content-Security-Policy', DOCUMENT_POLICY)
          if (age <= RENDER_FRESH_MS && renderedAt >= Number(lastWrite)) {
            headers.set('x-edge-cache', 'hit')
            return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers })
          }
          headers.delete('etag')
          headers.set('x-edge-cache', 'stale')
          if (!prefetch) ctx?.waitUntil?.(renderShared(true).then(r => r.done))
          // Drop carried reads on a stale hit so the browser paints cached HTML
          // immediately and revalidates live rows from /crud after first paint.
          // A prefetch keeps them: the tab holds what it seeds as stale and
          // refreshes it behind (omnishell's link-prefetch.js).
          const staleBody = request.method === 'HEAD' ? null : prefetch ? await cached.text() : stripServedReads(await cached.text())
          return new Response(staleBody, { status: cached.status, headers })
        }
      }
      if (prefetch) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
      const fresh = await (request.headers.has('if-none-match') ? renderFresh() : renderShared())
      // A refused render costs the visitor the server's rows, not the page.
      if (fresh.status === 503) {
        ctx?.waitUntil?.(fresh.done)
        const shell = await entryShell()
        shell.headers.set('Cache-Control', 'no-store')
        shell.headers.set('x-render-source', 'refused')
        return shell
      }
      const freshHeaders = new Headers(fresh.headers)
      if (!linkHeader) freshHeaders.delete('Link')
      if (request.method === 'HEAD') ctx?.waitUntil?.(fresh.done)
      return new Response(request.method === 'HEAD' ? null : fresh.makeStream(), { status: fresh.status, headers: freshHeaders })
    }
    if (found) return await entryShell()
    if (env.ASSETS &&
        !['auth', 'crud', 'electric', 'import', 'poke', 'signal'].includes(url.pathname.split('/')[1]) &&
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
  const common = { compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'], observability: { enabled: true } }
  await Deno.writeTextFile(path.join(out, 'renderer.jsonc'), JSON.stringify({
    ...common, name: renderer, main: 'src/render.ts', workers_dev: false,
    durable_objects: { bindings: [{ name: 'RENDERER', class_name: 'DocumentRenderer' }] },
    exports: { DocumentRenderer: { type: 'durable-object', storage: 'sqlite' } },
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
    ...(compute ? { services: compute.services } : {}),
    ...(separate && triggers ? { triggers } : {}),
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }, ...(compute ? [{ name: 'COMPUTE_COORDINATOR', class_name: 'ComputeCoordinator' }, compute.reader] : [])] },
    exports: { Cluster: { type: 'durable-object', storage: 'sqlite' }, ...(compute ? { ComputeCoordinator: { type: 'durable-object', storage: 'sqlite' } } : {}) },
    ...(config.ai ? { ai: config.ai } : {}),
    rules: [
      { type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false },
      { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false },
    ],
    alias: {
      ...config.alias,
      '@electric-sql/pglite': './pglite/index.js', '@electric-sql/pglite/basefs': './pglite/fs/base.js',
      '@mecha/postgrest-js': rel(path.join(mecha, 'packages/postgrest-js/src/index.ts')),
    },
  }
  // A release rewritten after its build keeps the airlock queue the
  // dispatcher's writer gave the script holding the object.
  if (separate) {
    let queues: unknown
    try { queues = JSON.parse(await Deno.readTextFile(path.join(out, 'database.jsonc'))).queues }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
    await Deno.writeTextFile(path.join(out, 'database.jsonc'), JSON.stringify({ ...databaseConfig, ...(queues ? { queues } : {}) }, null, 2) + '\n')
  }
  else {
    try { await Deno.remove(path.join(out, 'database.jsonc')) }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
  }
  config.name = name
  config.main = 'src/index.ts'
  config.durable_objects = { bindings: [{ name: 'CLUSTER', class_name: 'Cluster', ...(separate ? { script_name: database } : {}) }, { name: 'RENDERER', class_name: 'DocumentRenderer', script_name: renderer }, ...(!separate && compute ? [{ name: 'COMPUTE_COORDINATOR', class_name: 'ComputeCoordinator' }, compute.reader] : [])] }
  delete config.migrations
  config.version_metadata = { binding: 'CF_VERSION_METADATA' }
  config.assets.run_worker_first = await edgeRoutingRules(path.join(out, 'public'))
  config.assets.html_handling = 'drop-trailing-slash'
  if (separate) {
    delete config.containers
    delete config.services
    delete config.exports
    delete config.rules
    delete config.alias
  } else {
    delete config.containers
    if (compute) config.services = compute.services
    if (triggers) config.triggers = triggers
    config.exports = databaseConfig.exports
    config.rules = databaseConfig.rules
    config.alias = { ...config.alias, ...databaseConfig.alias }
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
