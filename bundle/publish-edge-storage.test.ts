import assert from 'node:assert/strict'
import { prepareStorage } from './publish-edge-storage.ts'

const requested = { version: 1, blockSize: 8192, codec: 'deflate' }
const pending = { ready: false, generation: 'source-generation', requested, maintenance: null, databaseSize: 8_716_251_000 }

Deno.test('storage preparation resumes its generation without resetting or opening PostgreSQL', async () => {
  const calls: string[] = []
  const responses = [
    { ...pending, maintenance: { converted: 1024 } },
    { ...pending, maintenance: { converted: 2048 } },
    { ...pending, ready: true, databaseSize: 4_000_000_000 },
  ]
  await prepareStorage(async (route, init) => {
    calls.push(route)
    if (route === 'compress') {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(init!.body as string), { generation: pending.generation, target: requested })
    }
    return Response.json(responses.shift())
  })
  assert.deepEqual(calls, ['storage', 'compress', 'compress'])
})

Deno.test('compatible storage requires no maintenance request', async () => {
  let calls = 0
  await prepareStorage(async route => {
    calls++
    assert.equal(route, 'storage')
    return Response.json({ ...pending, ready: true })
  })
  assert.equal(calls, 1)
})

for (const [name, next, pattern] of [
  ['generation change', { ...pending, generation: 'different', ready: true }, /identity changed/],
  ['target change', { ...pending, requested: { ...requested, blockSize: 131072 }, ready: true }, /identity changed/],
  ['stalled conversion', pending, /made no progress/],
] as const) Deno.test(`storage preparation refuses ${name}`, async () => {
  let calls = 0
  await assert.rejects(() => prepareStorage(async () => Response.json(calls++ ? next : pending)), pattern)
  assert.equal(calls, 2)
})

Deno.test('failed maintenance stops publication without rollback or reset', async () => {
  const calls: string[] = []
  await assert.rejects(() => prepareStorage(async route => {
    calls.push(route)
    return route === 'storage' ? Response.json(pending) : new Response('active snapshots', { status: 409 })
  }), /409 active snapshots/)
  assert.deepEqual(calls, ['storage', 'compress'])
})
