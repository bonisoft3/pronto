import assert from 'node:assert/strict'
import { releaseSealKey } from './edge-seal.ts'

const options = (over: Partial<Parameters<typeof releaseSealKey>[0]> = {}): Parameters<typeof releaseSealKey>[0] => ({
  dev: 'dev-key',
  // A key's id ignores how its text is spelled, as an imported key's does.
  kidOf: (key) => Promise.resolve(key.replace(/\s/g, '')),
  held: () => Promise.resolve({ dispatcher: ['AIRLOCK_SEAL_KEY'], object: ['AIRLOCK_SEAL_PUBLIC'] }),
  publicOf: (key) => Promise.resolve(`public of ${key}`),
  ...over,
})

Deno.test('a key in the environment is set, the private half the dispatcher\'s and the public the object\'s', async () => {
  assert.deepEqual(await releaseSealKey(options({ given: 'k1', held: () => Promise.resolve({ dispatcher: [], object: [] }) })), {
    dispatcher: { AIRLOCK_SEAL_KEY: 'k1' }, object: { AIRLOCK_SEAL_PUBLIC: 'public of k1' },
  })
})

Deno.test('with none in the environment the deployed key is kept, and a release that holds none, or half, is refused: none is ever made', async () => {
  assert.equal(await releaseSealKey(options()), undefined)
  for (const held of [{ dispatcher: [], object: [] }, { dispatcher: [], object: ['AIRLOCK_SEAL_PUBLIC'] }, { dispatcher: ['AIRLOCK_SEAL_KEY'], object: [] }]) {
    await assert.rejects(releaseSealKey(options({ held: () => Promise.resolve(held) })), /is not deployed/)
  }
})

Deno.test('a key in the environment rotates, keeping the replaced one where it is given', async () => {
  assert.deepEqual(await releaseSealKey(options({ given: 'k2', previous: 'k1' })), {
    dispatcher: { AIRLOCK_SEAL_KEY: 'k2', AIRLOCK_SEAL_KEY_PREVIOUS: 'k1' }, object: { AIRLOCK_SEAL_PUBLIC: 'public of k2' },
  })
})

Deno.test('the repository\'s development key is refused, current or previous', async () => {
  await assert.rejects(releaseSealKey(options({ given: 'dev-key\n' })), /development key/)
  await assert.rejects(releaseSealKey(options({ given: 'dev-\nkey' })), /development key/)
  await assert.rejects(releaseSealKey(options({ given: 'k2', previous: 'dev-key' })), /development key/)
})
