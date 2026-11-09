import assert from 'node:assert/strict'
import * as path from 'node:path'
import { writeEdgeReader } from './edge-reader.ts'

Deno.test('physical readers pin copied runtime, assets and definitions in an independent Worker', async () => {
  const temporary = await Deno.makeTempDir()
  const out = path.join(temporary, 'release'), mecha = path.join(temporary, 'mecha')
  const files = {
    'release/pglite/pglite.wasm': 'wasm-one', 'release/pglite/index.js': 'pglite', 'release/src/compute-machine.js': 'machine',
    'mecha/packages/pglite-workerd/src/data-directory.ts': 'directory',
    'mecha/packages/compute-snapshot/src/index.ts': 'coordinator',
    'mecha/packages/mecha-edge/src/compute-reader.ts': 'reader',
  }
  try {
    for (const [file, body] of Object.entries(files)) {
      await Deno.mkdir(path.dirname(path.join(temporary, file)), { recursive: true })
      await Deno.writeTextFile(path.join(temporary, file), body)
    }
    const definitions = [{ name: 'totals', version: 'v1', reads: ['source'], to: ['sink'] }]
    const first = await writeEdgeReader(out, mecha, definitions, 'app')
    assert.equal(first.name, 'COMPUTE_READER')
    assert.match(first.script_name, /^app-reader-[a-f0-9]{12}$/)
    const configuration = JSON.parse(await Deno.readTextFile(path.join(out, 'compute/reader/wrangler.jsonc')))
    assert.equal(configuration.name, first.script_name)
    assert.deepEqual(configuration.durable_objects.bindings, [{ name: 'READER', class_name: 'ComputeReader' }])
    assert.equal(configuration.services, undefined)
    assert.equal(configuration.workers_dev, false)
    assert.deepEqual(await writeEdgeReader(out, mecha, definitions, 'app'), first)
    await Deno.writeTextFile(path.join(mecha, 'packages/mecha-edge/src/compute-reader.ts'), 'reader-two')
    assert.equal(await Deno.readTextFile(path.join(out, 'compute/reader/runtime/packages/mecha-edge/src/compute-reader.ts')), 'reader')
    const second = await writeEdgeReader(out, mecha, definitions, 'app')
    assert.notEqual(second.script_name, first.script_name)
    await Deno.writeTextFile(path.join(out, 'pglite/pglite.wasm'), 'wasm-two')
    const third = await writeEdgeReader(out, mecha, definitions, 'app')
    assert.notEqual(third.script_name, second.script_name)
    const fourth = await writeEdgeReader(out, mecha, [{ ...definitions[0], version: 'v2' }], 'app')
    assert.notEqual(fourth.script_name, third.script_name)
  } finally { await Deno.remove(temporary, { recursive: true }) }
})
