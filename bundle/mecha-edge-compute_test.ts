import assert from 'node:assert/strict'
import { fixture } from './mecha-edge-fixture.ts'

Deno.test({ name: 'edge computation arms durable retry, survives restart and publishes live source edits', sanitizeResources: false, sanitizeOps: false }, async () => {
  const { worker, state, until, at, cleanup } = await fixture()
  try {
    assert.equal((await at('/poke', {method:'POST',headers:{authorization:'Bearer test-import'}})).status, 200)
    const guest = await (await at('/auth/guest', { method: 'POST' })).json() as { token: string }
    const failed = await until(value => value.batches[0]?.failures > 0)
    assert.deepEqual(failed.rows, [])
    assert.equal(failed.failures[0].identity.name, 'copy')
    assert.notEqual(failed.alarm, null)
    await worker.restart()
    await at('/test/mend')
    assert.notEqual((await state()).alarm, null)
    await until(value => value.rows.length === 1)
    const response = await at('/crud/note', { method: 'POST', headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'live' }) })
    assert.equal(response.status, 201, await response.text())
    const settled = await until(value => value.rows.length === 2 && value.batches[0].state.requested === value.batches[0].state.completed)
    assert.deepEqual(settled.rows.map(row => row.body).sort(), ['initial', 'live'])
    await until(value => value.failures.length === 0)
  } finally { await cleanup() }
})

for (const physicalSnapshots of [false, true]) Deno.test({ name: `failed and busy computations preserve serving and fence reset (${physicalSnapshots ? 'physical reader' : 'relations'})`, sanitizeResources: false, sanitizeOps: false }, async () => {
  const { until, at, install, state, cleanup } = await fixture(1, 'ticker', false, physicalSnapshots)
  try {
    assert.equal((await at('/auth/guest', {method:'POST'})).status, 200)
    await until(value=>value.batches[0]?.failures === 1 && value.alarm === null)
    const response = await at('/auth/guest', {method:'POST'})
    assert.equal(response.status, 200)
    const guest = await response.json() as {token:string}
    const headers = {authorization:`Bearer ${guest.token}`,'content-type':'application/json'}
    assert.equal((await at('/crud/computed', {headers})).status, 200)
    await at('/test/hold')
    assert.equal((await at('/crud/note', {method:'POST',headers,body:JSON.stringify({body:'held'}),signal:AbortSignal.timeout(5000)})).status, 201)
    await until(value=>value.active)
    const capture = await (await at('/test/capture')).json() as {generation:string}
    assert.equal((await at('/auth/guest', {method:'POST',signal:AbortSignal.timeout(5000)})).status, 200)
    assert.equal((await at('/crud/computed', {headers,signal:AbortSignal.timeout(5000)})).status, 200)
    assert.equal((await at('/crud/note', {method:'POST',headers,body:JSON.stringify({body:'while busy'}),signal:AbortSignal.timeout(5000)})).status, 201)
    await at('/test/clock')
    const poked=await at('/poke', {method:'POST',headers:{authorization:'Bearer test-import'},signal:AbortSignal.timeout(5000)})
    assert.equal(poked.status, 200, await poked.text())
    await until(value=>value.ticks.length===1 && value.active)
    await at('/test/release')
    await until(value=>value.rows.length===3 && value.batches[0].state.requested===value.batches[0].state.completed)
    await install(true)
    await at('/test/hold')
    await at('/auth/guest', {method:'POST'})
    await until(value=>value.active)
    assert.equal((await at('/test/stale', {method:'POST',body:JSON.stringify(capture)})).status,200)
    assert.deepEqual((await state()).rows, [])
    await at('/test/release')
    const reset=await until(value=>value.rows.length===1)
    assert.deepEqual(reset.rows.map(row=>row.body), ['initial'])
  } finally { await cleanup() }
})

Deno.test({ name: 'snapshot transport failure is retained against its compact claim and independent work publishes', sanitizeResources: false, sanitizeOps: false }, async () => {
  const { until, at, install, state: inspect, cleanup } = await fixture(1, 'disabled', true)
  try {
    assert.equal((await at('/auth/guest', { method: 'POST' })).status, 200)
    const state = await until(value => value.batches.find(batch => batch.name === 'copy')?.failures === 1 && value.other.length === 1)
    const failed = state.batches.find(batch => batch.name === 'copy')!
    assert.match(failed.error!, /ReadableStream.*disconnected prematurely/)
    assert.equal(typeof failed.retry_at, 'number')
    assert.equal(failed.state.completed, 0)
    const independent = state.batches.find(batch => batch.name === 'independent')!
    assert.equal(independent.state.completed, independent.state.requested)
    assert.deepEqual(state.other, [{ id: 'done', body: 'independent' }])
    assert.equal(state.failures.length, 1)
    assert.equal(state.failures[0].identity.name, 'copy')
    assert.equal(state.failures[0].identity.revision, failed.state.requested)
    assert.match(state.failures[0].error, /ReadableStream.*disconnected prematurely/)
    assert.equal(state.failure, null)
    const oldFailure = state.failures[0]
    await install(true)
    assert.equal((await at('/auth/guest', { method: 'POST' })).status, 200)
    const reset = await until(value => value.failures.length === 1 && value.failures[0].generation !== oldFailure.generation && value.other.length === 1)
    assert.equal(reset.failures[0].identity.name, 'copy')
    assert.equal((await at('/test/stale', { method: 'POST', body: JSON.stringify(oldFailure) })).status, 200)
    assert.deepEqual((await inspect()).failures, reset.failures)
  } finally { await cleanup() }
})

Deno.test({ name: 'physical reader survives eviction and publishes source edits without retaining tables on the serving database', sanitizeResources: false, sanitizeOps: false }, async () => {
  const { worker, until, at, cleanup } = await fixture(25, 'disabled', false, true)
  try {
    const guest = await (await at('/auth/guest', { method: 'POST' })).json() as { token: string }
    await until(value => value.batches[0]?.failures > 0)
    await worker.restart()
    await at('/test/mend')
    await until(value => value.rows.length === 1)
    const response = await at('/crud/note', { method: 'POST', headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'live isolated' }), signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 201, await response.text())
    const settled = await until(value => value.rows.length === 2 && value.batches[0].state.requested === value.batches[0].state.completed)
    assert.deepEqual(settled.rows.map(row => row.body).sort(), ['initial', 'live isolated'])
    assert.equal(settled.captureTables, 0)
  } finally { await cleanup() }
})
