import assert from 'node:assert/strict'
import type { ComputeCapture } from '../../../libraries/mecha/packages/mecha-edge/src/compute.ts'
import { fixture } from './mecha-edge-fixture.ts'

async function controlled() {
  const test = await fixture(1, 'disabled', false, true, true)
  const json = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await test.at(path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return JSON.parse(text)
  }
  const wait = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const value = await read()
      if (accepts(value)) return value
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(JSON.stringify(await read()))
  }
  const claim = async () => (await wait(() => json<ComputeCapture | null>('/test/capture'), value => value !== null))!
  const prepare = async (capture: ComputeCapture) => {
    for (let i = 0; i < 2000; i++) if (await json<boolean>('/test/prepare', capture)) return
    throw new Error('physical reader did not finish preparation')
  }
  const reader = (capture: ComputeCapture, owner: 'A' | 'B', action = 'status') =>
    json<{ waiting: number; released: boolean; imported: unknown }>(`/test/reader/${action}`, { capture, owner })
  const computeStatus = async () => {
    const response = await test.at('/import/compute', { headers: { authorization: 'Bearer test-import' } })
    assert.equal(response.status, 200)
    return await response.json() as { readerOwner: string; readers: { owner: string; capture: ComputeCapture; status: { released: boolean; transfer: unknown } | null }[] }
  }
  const retention = () => json<{ readers: {owner: string; capture: ComputeCapture}[]; snapshots: {id: string}[]; resetStarted: boolean }>('/test/retention')
  return { ...test, json, wait, claim, prepare, reader, retention, computeStatus }
}

for (const lostRelease of [false, true]) Deno.test({ name: `staged publication retires capture and retains baseline${lostRelease ? ' after a lost cleanup acknowledgement' : ''}`, sanitizeResources: false, sanitizeOps: false }, async () => {
  const test = await controlled()
  try {
    const guest = await test.json<{token: string}>('/auth/guest', {})
    const capture = await test.claim()
    await test.prepare(capture)
    await test.json('/test/staged', { capture, action: 'stage' })
    if (lostRelease) await test.reader(capture, 'A', 'fail')
    const response = await test.at('/test/staged', { method: 'POST', body: JSON.stringify({ capture }) })
    const body = await response.text()
    assert.equal(response.status, lostRelease ? 500 : 200, body)
    if (lostRelease) {
      assert.match(body, /lost reader release acknowledgement/)
      assert.equal((await test.retention()).snapshots.length, 1)
      const report = await test.computeStatus()
      assert.equal(report.readerOwner, test.owners.A)
      assert.deepEqual(report.readers[0].status, { released: true, transfer: null })
      await test.worker.restart()
      assert.equal(await test.json('/test/capture'), null)
    }
    assert.equal(await test.json('/test/publication', capture), 'published')
    assert.deepEqual((await test.state()).rows, [{ id: 'staged', body: 'published' }])
    assert.deepEqual((await test.retention()).snapshots, [{ id: JSON.stringify(capture.identity) }])
    assert.deepEqual((await test.retention()).readers, [])
    assert.equal((await test.reader(capture, 'A')).released, true)
    await test.json('/test/staged', { capture })
    const write = await test.at('/crud/note', { method: 'POST', headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'next capture' }) })
    assert.equal(write.status, 201, await write.text())
    const next = await test.claim()
    const before = await test.retention()
    assert.ok(before.snapshots.some(row => row.id === JSON.stringify(capture.identity)))
    await test.prepare(next)
    assert.deepEqual((await test.retention()).snapshots, [{ id: JSON.stringify(next.identity) }])
    await test.install(true)
    const stale = await test.at('/test/staged', { method: 'POST', body: JSON.stringify({ capture }) })
    assert.equal(stale.status, 500)
    assert.match(await stale.text(), /the data directory was replaced/)
    assert.deepEqual((await test.state()).rows, [])
  } finally { await test.cleanup() }
})

Deno.test({ name: 'immutable reader ownership survives rebind, publication and filesystem reset until its owner returns', sanitizeResources: false, sanitizeOps: false }, async () => {
  const test = await controlled()
  try {
    await test.json('/auth/guest', {})
    const capture = await test.claim()
    assert.equal(await test.json('/test/prepare', capture), false)
    assert.ok((await test.reader(capture, 'A')).imported)
    assert.deepEqual((await test.retention()).readers, [{ owner: test.owners.A, capture }])

    await test.rebind('B')
    assert.equal(await test.json('/test/prepare', capture), false)
    assert.equal((await test.retention()).readers.length, 2)
    const report = await test.computeStatus()
    assert.equal(report.readerOwner, test.owners.B)
    assert.equal(report.readers.find(row => row.owner === test.owners.A)?.status, null)
    const current = report.readers.find(row => row.owner === test.owners.B)?.status
    assert.equal(current?.released, false)
    assert.ok(current?.transfer)
    await test.json('/test/stale', capture)
    assert.equal(await test.json('/test/publication', capture), 'published')
    assert.equal((await test.reader(capture, 'B')).released, true)
    assert.deepEqual((await test.retention()).readers, [{ owner: test.owners.A, capture }])
    assert.equal((await test.retention()).snapshots.length, 0)

    await test.install(true)
    await test.worker.restart()
    assert.deepEqual((await test.retention()).readers, [{ owner: test.owners.A, capture }])
    assert.ok((await test.reader(capture, 'A')).imported)
    await test.rebind('A')
    await test.json('/auth/guest', {})
    const fresh = await test.claim()
    assert.notEqual(fresh.generation, capture.generation)
    assert.deepEqual((await test.retention()).readers, [])
    assert.equal((await test.reader(capture, 'A')).released, true)
  } finally { await test.cleanup() }
})

Deno.test({ name: 'reset fences a claim suspended in reader collection before it can retain another physical snapshot', sanitizeResources: false, sanitizeOps: false }, async () => {
  const test = await controlled()
  try {
    const guest = await test.json<{token:string}>('/auth/guest', {})
    const old = await test.claim()
    await test.json('/test/prepare', old)
    await test.json('/test/reject', old)
    await test.reader(old, 'A', 'hold')
    const response = await test.at('/crud/note', {
      method: 'POST', headers: {authorization:`Bearer ${guest.token}`, 'content-type':'application/json'}, body: JSON.stringify({body:'new claim'}),
    })
    assert.equal(response.status, 201, await response.text())
    await new Promise(resolve => setTimeout(resolve, 30))
    await test.json('/test/capture')
    assert.equal(await test.json('/test/publication', old), 'obsolete')
    const claiming = test.at('/test/capture')
    await test.wait(() => test.reader(old, 'A'), value => value.waiting === 1)
    const resetting = test.at('/import/reset', {method:'POST', headers:{authorization:'Bearer test-import'}})
    await test.wait(() => test.reader(old, 'A'), value => value.waiting === 2)
    assert.equal((await test.retention()).resetStarted, true)
    await test.reader(old, 'A', 'resume')
    const [claimResponse, resetResponse] = await Promise.all([claiming, resetting])
    const claimError = await claimResponse.text()
    assert.equal(claimResponse.status, 500, claimError)
    assert.match(claimError, /the data directory is loading/)
    assert.equal(resetResponse.status, 200, await resetResponse.text())

    await test.install()
    assert.deepEqual((await test.retention()).snapshots, [])
    assert.deepEqual((await test.retention()).readers, [])
    await test.json('/test/stale', old)
    assert.deepEqual((await test.state()).rows, [])
    assert.equal(await test.json('/test/publication', old), 'obsolete')
    const fresh = await test.claim()
    assert.notEqual(fresh.generation, old.generation)
  } finally { await test.cleanup() }
})

Deno.test({ name: 'disabling computations still permits source reset and retains unbound reader ownership', sanitizeResources: false, sanitizeOps: false }, async () => {
  const test = await controlled()
  try {
    await test.json('/auth/guest', {})
    const capture = await test.claim()
    await test.json('/test/prepare', capture)
    await test.disableCompute()
    await test.install(true)
    assert.deepEqual((await test.retention()).snapshots, [])
    assert.deepEqual((await test.retention()).readers, [{ owner: test.owners.A, capture }])
    await test.json('/test/stale', capture)
    assert.deepEqual((await test.state()).rows, [])
  } finally { await test.cleanup() }
})
