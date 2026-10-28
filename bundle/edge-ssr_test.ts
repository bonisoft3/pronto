import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeEdgeSsr } from './edge-ssr.ts'

const policy = "script-src 'self'; frame-ancestors 'none'"

async function securityHeaders(out: string) {
  await Deno.writeTextFile(path.join(out, 'public/_headers'), `/\n  Content-Security-Policy: ${policy}\n`)
}

type Config = { durable_objects: { bindings: { name: string; script_name?: string }[] } }

Deno.test('SSR database generation preserves the clock policy in both database modes', async () => {
  const out = await Deno.makeTempDir()
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await securityHeaders(out)
    for (const mode of ['existing', 'separate'] as const) {
      for (const clock of ['ticker', 'disabled'] as const) {
        await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' } }))
        await writeEdgeSsr(out, omnishell, mecha, 'app', 'https://app.example', [], mode, clock)
        const source = await Deno.readTextFile(path.join(out, 'src/database.ts'))
        const options = source.slice(source.indexOf('const Base = edgeObject('), source.indexOf('export class Cluster'))
        const captured = new Function('edgeObject', 'pgliteWasm', 'initdbWasm', 'pgliteData', 'icu', options + '\nreturn Base')(Object, null, null, null, null)
        assert.equal(captured.clock, clock)
      }
    }
  } finally { await Deno.remove(out, { recursive: true }) }
})

Deno.test('installed edge helpers load the supplied runtime without a monorepo sibling', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'edge installed ' })
  try {
    const bundle = path.join(tmp, 'pronto/bundle'), runtime = path.join(tmp, 'selected runtime'), out = path.join(tmp, 'release')
    for (const dir of [bundle, path.join(runtime, 'server'), path.join(runtime, 'interpreter'), path.join(out, 'src'), path.join(out, 'public/shell')]) await Deno.mkdir(dir, { recursive: true })
    for (const file of ['edge-ssr.ts', 'edge-hints.ts', 'edge-scripts.ts', 'edge-addresses.ts', 'edge-templates.ts']) await Deno.copyFile(new URL(file, import.meta.url), path.join(bundle, file))
    await Deno.copyFile(new URL('../../omnishell/server/prepare-worker.ts', import.meta.url), path.join(runtime, 'server/prepare-worker.ts'))
    const jessie = await Deno.readTextFile(new URL('../../omnishell/interpreter/jessie.js', import.meta.url))
    await Deno.writeTextFile(path.join(runtime, 'interpreter/jessie.js'), jessie + '\n// selected runtime witness\n')
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await securityHeaders(out)
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' } }))
    const installed = await import(pathToFileURL(path.join(bundle, 'edge-ssr.ts')).href)
    await installed.writeEdgeSsr(out, runtime, path.join(tmp, 'mecha'), 'app', 'https://app.example', [])
    const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    assert.deepEqual(config.assets.run_worker_first, ['/*'])
    assert.equal(config.assets.html_handling, 'drop-trailing-slash')
    assert.match(await Deno.readTextFile(path.join(out, 'renderer/jessie-startup.js')), /selected runtime witness/)
    const entry = await Deno.readTextFile(path.join(out, 'src/index.ts'))
    const hintsImport = entry.match(/^import \{ edgeHints \} from '([^']+)'$/m)
    assert.ok(hintsImport)
    // Wrangler resolves filesystem imports literally, unlike Deno's URL loader.
    assert.ok((await Deno.stat(path.resolve(out, 'src', hintsImport[1]))).isFile)
    const probe = path.join(out, 'src/hints-probe.ts'), bundled = path.join(out, 'hints-probe.js')
    await Deno.writeTextFile(probe, hintsImport[0] + '\nexport { edgeHints }\n')
    const result = await new Deno.Command(Deno.execPath(), {
      args: ['bundle', '--no-config', '--no-lock', '--output', bundled, probe],
      stdout: 'piped', stderr: 'piped',
    }).output()
    assert.equal(result.success, true, new TextDecoder().decode(result.stderr))
    const { edgeHints } = await import(pathToFileURL(bundled).href)
    const manifest = { common: [], routes: [], catalogues: { en: '</en.json>; rel=preload' } }
    const links = edgeHints(new Request('https://app.example/'), manifest, (_cfg: unknown, _path: string, _search: string, preferred: string[]) => ({ route: { links: [] }, locale: preferred[0] }), ['en'])
    assert.equal(links, '</en.json>; rel=preload')
  } finally { await Deno.remove(tmp, { recursive: true }) }
})

Deno.test('the Cron Trigger follows the Worker that holds the object', async () => {
  const out = await Deno.makeTempDir()
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await securityHeaders(out)
    const triggers = { crons: ['0 * * * *'] }
    for (const mode of ['existing', 'separate'] as const) {
      await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' }, triggers }))
      await writeEdgeSsr(out, omnishell, mecha, 'app', 'https://app.example', [], mode)
      const entry = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
      assert.deepEqual(entry.triggers, mode === 'existing' ? triggers : undefined)
      if (mode === 'separate') assert.deepEqual(JSON.parse(await Deno.readTextFile(path.join(out, 'database.jsonc'))).triggers, triggers)
      const entrySource = await Deno.readTextFile(path.join(out, 'src/index.ts'))
      const databaseSource = await Deno.readTextFile(path.join(out, 'src/database.ts'))
      if (mode === 'existing') {
        assert.match(entrySource, /scheduled: edgeWorker\.scheduled/)
        assert.doesNotMatch(databaseSource, /scheduled/)
      } else {
        assert.doesNotMatch(entrySource, /scheduled/)
        assert.match(databaseSource, /scheduled\(_controller, env\) \{ return pokeCluster\(env\) \}/)
      }
    }
  } finally { await Deno.remove(out, { recursive: true }) }
})

Deno.test('separate SSR upgrades pin each entry to its renderer while retaining the database namespace', async () => {
  const out = await Deno.makeTempDir()
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await securityHeaders(out)
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' }, migrations: [{ tag: 'old' }] }))
    const build = async (origin = 'https://app.example') => {
      await writeEdgeSsr(out, omnishell, mecha, 'app', origin, [], 'separate')
      return JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    }
    const first = await build(), second = await build()
    assert.deepEqual(second.durable_objects, first.durable_objects)
    assert.equal(first.migrations, undefined)
    await Deno.writeTextFile(path.join(out, 'public/index.html'), '<p>new release</p>')
    const changed = await build()
    const binding = (config: Config, name: string) => config.durable_objects.bindings.find(item => item.name === name)!
    assert.deepEqual(binding(first, 'CLUSTER'), binding(changed, 'CLUSTER'))
    assert.notEqual(binding(first, 'RENDERER').script_name, binding(changed, 'RENDERER').script_name)
    const moved = await build('https://other.example')
    assert.notEqual(binding(moved, 'RENDERER').script_name, binding(changed, 'RENDERER').script_name)
    const renderer = JSON.parse(await Deno.readTextFile(path.join(out, 'renderer.jsonc')))
    assert.equal(renderer.name, binding(moved, 'RENDERER').script_name)
    const database: Config & { name: string } = JSON.parse(await Deno.readTextFile(path.join(out, 'database.jsonc')))
    assert.equal(database.name, binding(moved, 'CLUSTER').script_name)
    assert.equal(database.durable_objects.bindings.some(item => item.name === 'RENDERER'), false)
  } finally { await Deno.remove(out, { recursive: true }) }
})

Deno.test('enabling SSR on an existing app retains its Cluster namespace and persisted storage format', async () => {
  const out = await Deno.makeTempDir()
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    const migrations = [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }]
    await securityHeaders(out)
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' }, migrations }))
    await writeEdgeSsr(out, omnishell, mecha, 'app', 'https://app.example', [])
    const config = JSON.parse(await Deno.readTextFile(path.join(out, 'wrangler.jsonc')))
    assert.equal(config.name, 'app')
    assert.deepEqual(config.durable_objects.bindings.find((b: { name: string }) => b.name === 'CLUSTER'), { name: 'CLUSTER', class_name: 'Cluster' })
    assert.deepEqual(config.migrations, migrations)
    assert.match(await Deno.readTextFile(path.join(out, 'src/index.ts')), /export \{ Cluster \} from '.\/database.ts'/)
    assert.doesNotMatch(await Deno.readTextFile(path.join(out, 'src/database.ts')), /storageFormat/)
    assert.equal(config.alias['@electric-sql/pglite'], './pglite/index.js')
    await assert.rejects(Deno.stat(path.join(out, 'database.jsonc')), Deno.errors.NotFound)

    // Run the emitted boundary with a failing authority; unrelated failures
    // must still escape instead of being mislabeled as a transient outage.
    const source = await Deno.readTextFile(path.join(out, 'src/database.ts'))
    const declaration = source.slice(source.indexOf('export class Cluster'), source.indexOf('export default')).replace('export class', 'class')
    class Loading extends Error {}
    class Capacity extends Error {}
    let failure: Error
    class Authority { readPublic() { return Promise.reject(failure) } }
    const Cluster = new Function('Base', 'DataDirectoryLoading', 'PublicSnapshotCapacity', declaration + '\nreturn Cluster')(Authority, Loading, Capacity)
    const cluster = new Cluster()
    for (const error of [new Loading('the data directory is loading'), new Capacity('public snapshot queue full')]) {
      failure = error
      for (const method of ['GET', 'HEAD']) {
        const response = await cluster.render(new Request('https://app.example/', { method }), null)
        assert.equal(response.status, 503)
        assert.equal(response.headers.get('retry-after'), '1')
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.equal(await response.text(), method === 'HEAD' ? '' : error.message)
      }
    }
    failure = new Error('the data directory is loading')
    await assert.rejects(cluster.render(new Request('https://app.example/'), null), error => error === failure)
  } finally { await Deno.remove(out, { recursive: true }) }
})

Deno.test('edge SSR caches 200 renders, serves fresh hits with pronto-reads, and strips pronto-reads on stale hits while revalidating', async () => {
  const out = await Deno.makeTempDir()
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await securityHeaders(out)
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' } }))
    await writeEdgeSsr(out, omnishell, mecha, 'app', 'https://app.example', [], 'separate')
    await Deno.writeTextFile(path.join(out, 'src/hints.json'), JSON.stringify({
      common: ['</shell/boot.js>; rel=preload; as=script'],
      catalogues: {},
      routes: [
        { path: '/', ssr: 'ssr', links: ['</shell/screens/home.html>; rel=preload; as=fetch; crossorigin=anonymous'] },
        { path: '/campeonato/:slug', ssr: 'ssr', links: ['</shell/screens/campeonato.html>; rel=preload; as=fetch; crossorigin=anonymous'] },
        { path: '/gerenciar', access: 'private', ssr: 'spa', links: ['</shell/screens/gerenciar.html>; rel=preload; as=fetch; crossorigin=anonymous'] },
      ],
    }))
    const source = await Deno.readTextFile(path.join(out, 'src/index.ts'))
    const stubbed = source.replace(
      /^import \{ edgeWorker \} from '[^']+'$/m,
      'const edgeWorker = { fetch(req) { return new URL(req.url).pathname === "/gerenciar" ? new Response("<!doctype html><title>SPA</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("api") } }',
    )
    const entryPath = path.join(out, 'src/index-test.ts')
    await Deno.writeTextFile(entryPath, stubbed)
    const worker = (await import(pathToFileURL(entryPath).href)).default

    const store = new Map<string, Response>()
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        default: {
          async match(req: Request) { return store.get(req.url)?.clone() ?? null },
          async put(req: Request, res: Response) {
            if (new URL(req.url).pathname.includes('//')) throw new TypeError('double slash cache key')
            store.set(req.url, res.clone())
          },
        },
      },
    })

    let renders = 0
    let releaseRender: (() => void) | null = null
    const env = {
      CF_VERSION_METADATA: { id: 'v1' },
      ASSETS: {
        async fetch(req: Request) {
          const pathname = new URL(req.url).pathname
          if (pathname === '/') return new Response('<!doctype html><title>SPA</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
          if (pathname === '/shell/screens/home.css') return new Response('body { color: red }', { status: 200, headers: { 'content-type': 'text/css' } })
          return new Response('Not found', { status: 404 })
        },
      },
      RENDERER: { idFromName: (n: string) => n, get: () => ({}) },
      CLUSTER: {
        idFromName: (n: string) => n,
        get: () => ({
          async render() {
            renders += 1
            if (releaseRender) await new Promise<void>(r => { releaseRender = r })
            return new Response(
              `<html><body><h1>Render ${renders}</h1><script type="application/json" id="pronto-reads">{"/crud/game":"[${renders}]"}</script></body></html>`,
              {
                status: 200,
                headers: {
                  'content-type': 'text/html; charset=utf-8',
                  'cache-control': 'public, no-cache, must-revalidate',
                  etag: `"etag-${renders}"`,
                },
              },
            )
          },
        }),
      },
    }
    const background: Promise<unknown>[] = []
    const ctx = { waitUntil(p: Promise<unknown>) { background.push(p) } }

    // Concurrent cold misses share one in-flight render, even if one reader cancels its stream.
    releaseRender = () => {}
    const p1 = worker.fetch(new Request('https://app.example/'), env, ctx)
    const p2 = worker.fetch(new Request('https://app.example/'), env, ctx)
    const p3 = worker.fetch(new Request('https://app.example/'), env, ctx)
    await new Promise(r => setTimeout(r, 10))
    const unblock = releaseRender as () => void
    releaseRender = null
    unblock()
    const [first, concurrent, cancelled] = await Promise.all([p1, p2, p3])
    assert.equal(first.headers.get('content-security-policy'), policy)
    assert.equal(first.headers.get('x-edge-cache'), 'miss')
    assert.equal(first.headers.get('cache-control'), 'public, no-cache, must-revalidate')
    assert.equal(first.headers.get('etag'), '"etag-1"')
    await cancelled.body?.cancel()
    assert.match(await first.text(), /id="pronto-reads"/)
    assert.match(await concurrent.text(), /id="pronto-reads"/)
    assert.equal(renders, 1)

    const second = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(second.headers.get('content-security-policy'), policy)
    assert.equal(second.headers.get('x-edge-cache'), 'hit')
    assert.equal(second.headers.get('cache-control'), 'public, no-cache, must-revalidate')
    assert.equal(second.headers.get('vary'), 'Accept-Language')
    assert.equal(second.headers.get('etag'), '"etag-1"')
    assert.match(await second.text(), /id="pronto-reads"/)
    assert.equal(renders, 1)

    // Non-root routes without a matched locale must not produce a '//' segment in cacheKey.
    const nestedMiss = await worker.fetch(new Request('https://app.example/campeonato/brasileiro-2026'), env, ctx)
    assert.equal(nestedMiss.headers.get('x-edge-cache'), 'miss')
    await nestedMiss.text()
    await Promise.all(background.splice(0))
    const nestedHit = await worker.fetch(new Request('https://app.example/campeonato/brasileiro-2026'), env, ctx)
    assert.equal(nestedHit.headers.get('x-edge-cache'), 'hit')
    await nestedHit.text()
    assert.equal(renders, 2)
    store.delete([...store.keys()].find(k => k.endsWith('/campeonato/brasileiro-2026'))!)

    // Age the cached response past the 60s fresh window.
    for (const [key, res] of store) {
      const headers = new Headers(res.headers)
      headers.set('x-rendered-at', String(Date.now() - 61_000))
      store.set(key, new Response(await res.arrayBuffer(), { status: res.status, headers }))
    }

    const stale1 = await worker.fetch(new Request('https://app.example/'), env, ctx)
    const stale2 = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(stale1.headers.get('content-security-policy'), policy)
    assert.equal(stale1.headers.get('x-edge-cache'), 'stale')
    assert.equal(stale1.headers.get('cache-control'), 'public, no-cache, must-revalidate')
    assert.equal(stale1.headers.get('etag'), null)
    const staleHtml = await stale1.text()
    await stale2.text()
    assert.match(staleHtml, /Render 1/)
    assert.doesNotMatch(staleHtml, /id="pronto-reads"/)
    await Promise.all(background.splice(0))
    assert.equal(renders, 3)

    const refreshed = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(refreshed.headers.get('x-edge-cache'), 'hit')
    assert.equal(refreshed.headers.get('etag'), '"etag-3"')
    const refreshedHtml = await refreshed.text()
    assert.match(refreshedHtml, /Render 3/)
    assert.match(refreshedHtml, /id="pronto-reads"/)

    // A public write marker in caches.default invalidates the cached SSR HTML.
    store.set('https://edge-cache.invalid/v1/0/writes/public', new Response('1700000000000'))
    const afterWrite = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(afterWrite.headers.get('x-edge-cache'), 'miss')
    assert.equal(renders, 4)

    // A private / SPA route skips RENDERER + CLUSTER.render and serves the SPA entry with Link hints on GET and HEAD.
    const spa = await worker.fetch(new Request('https://app.example/gerenciar', { headers: { accept: 'text/html' } }), env, ctx)
    assert.equal(spa.status, 200)
    assert.equal(await spa.text(), '<!doctype html><title>SPA</title>')
    assert.match(spa.headers.get('link') ?? '', /gerenciar\.html/)
    const spaHead = await worker.fetch(new Request('https://app.example/gerenciar', { method: 'HEAD' }), env, ctx)
    assert.equal(spaHead.status, 200)
    assert.equal(await spaHead.text(), '')
    assert.match(spaHead.headers.get('link') ?? '', /gerenciar\.html/)
    assert.equal(renders, 4)

    // A link the shell prefetched seeds its tab from the reads; stripped on a
    // stale hit, a prefetch of any page past its first minute seeded nothing.
    await Promise.all(background.splice(0))
    for (const [key, res] of store) {
      const headers = new Headers(res.headers)
      if (!headers.has('x-rendered-at')) continue
      headers.set('x-rendered-at', String(Date.now() - 61_000))
      store.set(key, new Response(await res.arrayBuffer(), { status: res.status, headers }))
    }
    const prefetched = await worker.fetch(new Request('https://app.example/', { headers: { purpose: 'prefetch', 'x-pronto-prefetch': '1' } }), env, ctx)
    assert.equal(prefetched.headers.get('x-edge-cache'), 'stale')
    assert.equal(prefetched.headers.get('link'), null)
    assert.match(await prefetched.text(), /id="pronto-reads"/)

    // Non-cluster static asset routes fetch directly from env.ASSETS without passing through edgeWorker.
    const css = await worker.fetch(new Request('https://app.example/shell/screens/home.css', { headers: { accept: 'text/css' } }), env, ctx)
    assert.equal(css.status, 200)
    assert.equal(await css.text(), 'body { color: red }')

    // Missing assets return 404 with no-store so edge CDNs never cache missing immutable assets.
    const missingCss = await worker.fetch(new Request('https://app.example/shell/screens/missing.css', { headers: { accept: 'text/css' } }), env, ctx)
    assert.equal(missingCss.status, 404)
    assert.equal(await missingCss.text(), 'Not found')
    assert.equal(missingCss.headers.get('cache-control'), 'no-store')

    // Missing asset requests under asset prefixes never rewrite to the SPA entry document even with text/html accept.
    const missingAssetHtml = await worker.fetch(new Request('https://app.example/_immutable-missing.js', { headers: { accept: 'text/html' } }), env, ctx)
    assert.equal(missingAssetHtml.status, 404)
    assert.equal(missingAssetHtml.headers.get('cache-control'), 'no-store')

    // Unmatched HTML requests return 404 Page not found with no-store.
    const missingHtml = await worker.fetch(new Request('https://app.example/unknown-page', { headers: { accept: 'text/html' } }), env, ctx)
    assert.equal(missingHtml.status, 404)
    assert.equal(await missingHtml.text(), 'Page not found')
    assert.equal(missingHtml.headers.get('cache-control'), 'no-store')

    // Cluster routes still pass through to edgeWorker.
    const cluster = await worker.fetch(new Request('https://app.example/crud/game'), env, ctx)
    assert.equal(await cluster.text(), 'api')
  } finally {
    if (savedCaches) Object.defineProperty(globalThis, 'caches', savedCaches)
    else Reflect.deleteProperty(globalThis, 'caches')
    await Deno.remove(out, { recursive: true })
  }
})

Deno.test('renderObject folds version into ETag, serves 304 on streaming GET, returns 503 on queue saturation, and surfaces post-head errors', async () => {
  const out = await Deno.makeTempDir()
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  try {
    await Deno.copyFile(path.join(omnishell, 'server/render-queue.ts'), path.join(out, 'render-queue.ts'))
    const rawSource = await Deno.readTextFile(path.join(omnishell, 'server/render-object.ts'))
    const stubbed = rawSource.replace(
      "import { DurableObject } from 'cloudflare:workers'",
      'class DurableObject { ctx: { waitUntil?: (p: Promise<unknown>) => void }; constructor(ctx?: { waitUntil?: (p: Promise<unknown>) => void }) { this.ctx = ctx ?? {} } }',
    )
    const modPath = path.join(out, 'render-object.ts')
    await Deno.writeTextFile(modPath, stubbed)
    const { renderObject } = await import(pathToFileURL(modPath).href)

    const reader = { async read() { return [] } }
    const RendererV1 = renderObject(async (_req: Request, _reader: unknown, stream?: { onHead?: (h: { status: number; gone: boolean }) => void; onChunk?: (c: string) => void }) => {
      stream?.onHead?.({ status: 200, gone: false })
      stream?.onChunk?.('<html>v1</html>')
      return { html: '<html>v1</html>', status: 200 }
    }, 'renderer-v1')
    const RendererV2 = renderObject(async (_req: Request, _reader: unknown, stream?: { onHead?: (h: { status: number; gone: boolean }) => void; onChunk?: (c: string) => void }) => {
      stream?.onHead?.({ status: 200, gone: false })
      stream?.onChunk?.('<html>v2</html>')
      return { html: '<html>v2</html>', status: 200 }
    }, 'renderer-v2')

    const r1 = new RendererV1()
    const r2 = new RendererV2()
    const res1 = await r1.render(new Request('https://app.example/'), 'rev-1', reader)
    const res2 = await r2.render(new Request('https://app.example/'), 'rev-1', reader)
    const etag1 = res1.headers.get('etag')!
    const etag2 = res2.headers.get('etag')!
    assert.ok(etag1)
    assert.notEqual(etag1, etag2)
    assert.equal(await res1.text(), '<html>v1</html>')
    assert.equal(await res2.text(), '<html>v2</html>')

    // 304 Not Modified on streaming GET when If-None-Match matches the ETag.
    const notMod = await r1.render(new Request('https://app.example/', { headers: { 'if-none-match': etag1 } }), 'rev-1', reader)
    assert.equal(notMod.status, 304)
    assert.equal(notMod.body, null)

    // Post-head error aborts the response stream and rejects the waitUntil promise.
    const waited: Promise<unknown>[] = []
    const FailingAfterHead = renderObject(async (_req: Request, _reader: unknown, stream?: { onHead?: (h: { status: number; gone: boolean }) => void; onChunk?: (c: string) => void }) => {
      stream?.onHead?.({ status: 200, gone: false })
      stream?.onChunk?.('<!doctype html>')
      await new Promise(r => setTimeout(r, 5))
      throw new Error('nested read failed after head')
    }, 'renderer-fail')
    const failing = new FailingAfterHead({ waitUntil(p: Promise<unknown>) { waited.push(p) } })
    const streamRes = await failing.render(new Request('https://app.example/'), 'rev-1', reader)
    assert.equal(streamRes.status, 200)
    await assert.rejects(() => streamRes.text(), /nested read failed after head/)
    assert.equal(waited.length, 1)
    await assert.rejects(() => waited[0], /nested read failed after head/)

    // Synchronous RenderCapacity overflow on streaming GET returns 503 Service Unavailable.
    let releaseGate!: () => void
    const gate = new Promise<void>(r => { releaseGate = r })
    let entered = 0
    let allQueued!: () => void
    const readyForOverflow = new Promise<void>(r => { allQueued = r })
    const SlowRenderer = renderObject(async () => {
      await gate
      return { html: '<html>ok</html>', status: 200 }
    }, 'renderer-slow')
    const slow = new SlowRenderer()
    const inFlight = Array.from({ length: 16 }, () => {
      const p = slow.render(new Request('https://app.example/'), 'rev-1', reader)
      if (++entered === 16) setTimeout(allQueued, 5)
      return p
    })
    await readyForOverflow
    const overflow = await slow.render(new Request('https://app.example/'), 'rev-1', reader)
    assert.equal(overflow.status, 503)
    assert.equal(overflow.headers.get('retry-after'), '1')
    releaseGate()
    const responses = await Promise.all(inFlight)
    await Promise.all(responses.map((r: Response) => r.text()))
  } finally {
    await Deno.remove(out, { recursive: true })
  }
})
