import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function writeEdgeSsr(out: string, omnishell: string, mecha: string, name: string, origin: string, databaseMode: 'existing' | 'separate' = 'existing') {
  out = await Deno.realPath(out)
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
      else if (/\.(js|ts|json)$/.test(entry.name)) sources.push([path.relative(omnishell, file), await Deno.readTextFile(file)])
    }
  }
  await collect(server)
  await collect(path.join(omnishell, 'interpreter'))
  sources.sort(([a], [b]) => a.localeCompare(b))
  const identity = JSON.stringify([origin, sources, await Deno.readTextFile(path.join(generated, 'assets.json'))])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)))
  const renderer = name + '-renderer-' + [...digest.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('')
  const fromSrc = (file: string) => path.relative(path.join(out, 'src'), file)
  const rel = (file: string) => './' + path.relative(out, file)
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
import hints from './hints.json'
${separate ? '' : "export { Cluster } from './database.ts'"}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if ((request.method === 'GET' || request.method === 'HEAD') && routeAt(hints, url.pathname, url.search, [])) {
      const renderer = env.RENDERER.get(env.RENDERER.idFromName('public'))
      const response = await env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).render(request, renderer)
      const result = new Response(response.body, response)
      result.headers.set('Link', edgeHints(request, hints, routeAt, acceptedLanguages(request.headers.get('accept-language') ?? '')))
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
