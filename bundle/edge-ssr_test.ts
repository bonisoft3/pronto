import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeEdgeSsr } from './edge-ssr.ts'

type Config = { durable_objects: { bindings: { name: string; script_name?: string }[] } }

Deno.test('installed edge helpers load the supplied runtime without a monorepo sibling', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'edge installed ' })
  try {
    const bundle = path.join(tmp, 'pronto/bundle'), runtime = path.join(tmp, 'selected runtime'), out = path.join(tmp, 'release')
    for (const dir of [bundle, path.join(runtime, 'server'), path.join(runtime, 'interpreter'), path.join(out, 'src'), path.join(out, 'public/shell')]) await Deno.mkdir(dir, { recursive: true })
    for (const file of ['edge-ssr.ts', 'edge-hints.ts']) await Deno.copyFile(new URL(file, import.meta.url), path.join(bundle, file))
    await Deno.copyFile(new URL('../../omnishell/server/prepare-worker.ts', import.meta.url), path.join(runtime, 'server/prepare-worker.ts'))
    const jessie = await Deno.readTextFile(new URL('../../omnishell/interpreter/jessie.js', import.meta.url))
    await Deno.writeTextFile(path.join(runtime, 'interpreter/jessie.js'), jessie + '\n// selected runtime witness\n')
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' } }))
    const installed = await import(pathToFileURL(path.join(bundle, 'edge-ssr.ts')).href)
    await installed.writeEdgeSsr(out, runtime, path.join(tmp, 'mecha'), 'app', 'https://app.example')
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

Deno.test('separate SSR upgrades pin each entry to its renderer while retaining the database namespace', async () => {
  const out = await Deno.makeTempDir()
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))
  try {
    await Deno.mkdir(path.join(out, 'src'))
    await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
    await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' }, migrations: [{ tag: 'old' }] }))
    const build = async (origin = 'https://app.example') => {
      await writeEdgeSsr(out, omnishell, mecha, 'app', origin, 'separate')
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
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' }, migrations }))
    await writeEdgeSsr(out, omnishell, mecha, 'app', 'https://app.example')
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
    await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' } }))
    await writeEdgeSsr(out, omnishell, mecha, 'app', 'https://app.example', 'separate')
    await Deno.writeTextFile(path.join(out, 'src/hints.json'), JSON.stringify({
      common: ['</shell/boot.js>; rel=preload; as=script'],
      catalogues: {},
      routes: [
        { path: '/', ssr: 'ssr', links: ['</shell/screens/home.html>; rel=preload; as=fetch; crossorigin=anonymous'] },
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
          async put(req: Request, res: Response) { store.set(req.url, res.clone()) },
        },
      },
    })

    let renders = 0
    let releaseRender: (() => void) | null = null
    const env = {
      CF_VERSION_METADATA: { id: 'v1' },
      ASSETS: {
        async fetch(req: Request) {
          return new URL(req.url).pathname === '/'
            ? new Response('<!doctype html><title>SPA</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
            : new Response('Not found', { status: 404 })
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

    // Concurrent cold misses share one in-flight render.
    releaseRender = () => {}
    const p1 = worker.fetch(new Request('https://app.example/'), env, ctx)
    const p2 = worker.fetch(new Request('https://app.example/'), env, ctx)
    await new Promise(r => setTimeout(r, 10))
    const unblock = releaseRender as () => void
    releaseRender = null
    unblock()
    const [first, concurrent] = await Promise.all([p1, p2])
    assert.equal(first.headers.get('x-edge-cache'), 'miss')
    assert.equal(first.headers.get('cache-control'), 'public, no-cache, must-revalidate')
    assert.equal(first.headers.get('etag'), '"etag-1"')
    assert.match(await first.text(), /id="pronto-reads"/)
    assert.match(await concurrent.text(), /id="pronto-reads"/)
    assert.equal(renders, 1)

    const second = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(second.headers.get('x-edge-cache'), 'hit')
    assert.equal(second.headers.get('cache-control'), 'public, no-cache, must-revalidate')
    assert.equal(second.headers.get('etag'), '"etag-1"')
    assert.match(await second.text(), /id="pronto-reads"/)
    assert.equal(renders, 1)

    // Age the cached response past the 60s fresh window.
    for (const [key, res] of store) {
      const headers = new Headers(res.headers)
      headers.set('x-rendered-at', String(Date.now() - 61_000))
      store.set(key, new Response(await res.arrayBuffer(), { status: res.status, headers }))
    }

    const stale1 = await worker.fetch(new Request('https://app.example/'), env, ctx)
    const stale2 = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(stale1.headers.get('x-edge-cache'), 'stale')
    assert.equal(stale1.headers.get('cache-control'), 'public, no-cache, must-revalidate')
    assert.equal(stale1.headers.get('etag'), null)
    const staleHtml = await stale1.text()
    await stale2.text()
    assert.match(staleHtml, /Render 1/)
    assert.doesNotMatch(staleHtml, /id="pronto-reads"/)
    await Promise.all(background.splice(0))
    assert.equal(renders, 2)

    const refreshed = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(refreshed.headers.get('x-edge-cache'), 'hit')
    assert.equal(refreshed.headers.get('etag'), '"etag-2"')
    const refreshedHtml = await refreshed.text()
    assert.match(refreshedHtml, /Render 2/)
    assert.match(refreshedHtml, /id="pronto-reads"/)

    // A public write marker in caches.default invalidates the cached SSR HTML.
    store.set('https://edge-cache.invalid/v1/0/writes/public', new Response('1700000000000'))
    const afterWrite = await worker.fetch(new Request('https://app.example/'), env, ctx)
    assert.equal(afterWrite.headers.get('x-edge-cache'), 'miss')
    assert.equal(renders, 3)

    // A private / SPA route skips RENDERER + CLUSTER.render and serves the SPA entry with Link hints on GET and HEAD.
    const spa = await worker.fetch(new Request('https://app.example/gerenciar', { headers: { accept: 'text/html' } }), env, ctx)
    assert.equal(spa.status, 200)
    assert.equal(await spa.text(), '<!doctype html><title>SPA</title>')
    assert.match(spa.headers.get('link') ?? '', /gerenciar\.html/)
    const spaHead = await worker.fetch(new Request('https://app.example/gerenciar', { method: 'HEAD' }), env, ctx)
    assert.equal(spaHead.status, 200)
    assert.equal(await spaHead.text(), '')
    assert.match(spaHead.headers.get('link') ?? '', /gerenciar\.html/)
    assert.equal(renders, 3)

    // A link the shell prefetched seeds its tab from the reads; stripped on a
    // stale hit, a prefetch of any page past its first minute seeded nothing.
    await Promise.all(background.splice(0))
    for (const [key, res] of store) {
      const headers = new Headers(res.headers)
      if (!headers.has('x-rendered-at')) continue
      headers.set('x-rendered-at', String(Date.now() - 61_000))
      store.set(key, new Response(await res.arrayBuffer(), { status: res.status, headers }))
    }
    const prefetched = await worker.fetch(new Request('https://app.example/', { headers: { purpose: 'prefetch' } }), env, ctx)
    assert.equal(prefetched.headers.get('x-edge-cache'), 'stale')
    assert.match(await prefetched.text(), /id="pronto-reads"/)
  } finally {
    if (savedCaches) Object.defineProperty(globalThis, 'caches', savedCaches)
    else Reflect.deleteProperty(globalThis, 'caches')
    await Deno.remove(out, { recursive: true })
  }
})
