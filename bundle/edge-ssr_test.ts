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
