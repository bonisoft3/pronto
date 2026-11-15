import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { buildConfig, sourceKey } from './edge-pglite.ts'

Deno.test('the sources key is their paths and bytes, whatever order they were written in', async () => {
  const a = await Deno.makeTempDir(), b = await Deno.makeTempDir()
  await Deno.mkdir(path.join(a, '.bayt')); await Deno.mkdir(path.join(b, '.bayt'))
  await Deno.writeTextFile(path.join(a, 'x'), '1'); await Deno.writeTextFile(path.join(a, '.bayt/y'), '2')
  await Deno.writeTextFile(path.join(b, '.bayt/y'), '2'); await Deno.writeTextFile(path.join(b, 'x'), '1')
  assert.equal(await sourceKey(a), await sourceKey(b))
  await Deno.writeTextFile(path.join(b, 'x'), '3')
  assert.notEqual(await sourceKey(a), await sourceKey(b))
})

Deno.test('the build leaves <key>.tgz where the release looks, its shell dollars escaped', () => {
  const c = buildConfig('k', 'gs://p-pronto-edge/pglite-workerd/')
  assert.deepEqual(c.artifacts.objects, { location: 'gs://p-pronto-edge/pglite-workerd/', paths: ['/workspace/k.tgz'] })
  const script = c.steps[0].args[1]
  assert.match(script, /tar -czf \/workspace\/k\.tgz -C \/workspace\/out \./)
  assert.doesNotMatch(script.replaceAll('$$', ''), /\$/)
})
