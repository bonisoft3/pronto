import assert from 'node:assert/strict'
import { migrateKeptDirectory, previousDeployment, rollbackRefusedMigration } from './publish-edge-state.ts'

const output = (success: boolean, stdout: string, stderr = '') => ({ success, code: success ? 0 : 1, stdout: new TextEncoder().encode(stdout), stderr: new TextEncoder().encode(stderr) })
Deno.test('a first publish accepts only the missing Worker API error', () => {
  assert.equal(previousDeployment(output(false, '', 'This Worker does not exist on your account. [code: 10007]')), null)
  assert.throws(() => previousDeployment(output(false, '', 'Authentication error [code: 10000]')), /Authentication error/)
  assert.throws(() => previousDeployment(output(false, '', 'A different API failure [code: 10007]')), /different API failure/)
  assert.throws(() => previousDeployment(output(false, '', 'This Worker does not exist on your account.')), /exited 1/)
  assert.throws(() => previousDeployment(output(true, '[]')), /one active Worker version/)
  assert.throws(() => previousDeployment(output(true, '[{"versions":[{"version_id":"old"},{"version_id":"new"}]}]')), /one active Worker version/)
  assert.throws(() => previousDeployment(output(true, '[{"versions":[{}]}]')), /no deployed version/)
  assert.equal(previousDeployment(output(true, '[{"versions":[{"version_id":"old"}]},{"versions":[{"version_id":"current"}]}]')), 'current')
  assert.throws(() => previousDeployment(output(true, 'not json')))
})

Deno.test('a migration refusal is reported before rollback and survives an irreversible DO schema change', async () => {
  const events: string[] = []
  const irreversible = new Error('version depends on Durable Object migration v1; current deployment uses v2-compute-coordinator')
  const deployed = [{ config: 'query', previous: 'old-query' }, { config: 'first-publish', previous: null }, { config: 'root', previous: 'old-root' }]
  await assert.rejects(() => rollbackRefusedMigration('409: 799_write_permissions.sql refused', deployed, async (config, previous) => {
    events.push(`rollback ${config} ${previous}`)
    if (config === 'root') throw irreversible
    return `restored ${config}`
  }, (message) => events.push(message)), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [irreversible])
    assert.match(error.message, /409: 799_write_permissions.sql refused/)
    assert.match(error.message, /1 Worker\(s\) restored, 1 failed, 1 have no previous version/)
    return true
  })
  assert.equal(events[0], '409: 799_write_permissions.sql refused')
  assert.equal(events[1], 'rollback root old-root')
  assert.match(events[2], /rollback failed for root: .*v2-compute-coordinator/)
  assert.deepEqual(events.slice(3), ['rollback query old-query', 'restored query'])
  assert.equal(deployed[0].config, 'query')
})

Deno.test('successful rollback still fails the refused publish and identifies Workers without a previous version', async () => {
  const report: string[] = []
  await assert.rejects(() => rollbackRefusedMigration('422: migration SQL failed', [{ config: 'root', previous: 'old-root' }], async () => 'restored root', (message) => report.push(message)), /422: migration SQL failed\nRollback: 1 Worker\(s\) restored, 0 failed, 0 have no previous version/)
  assert.deepEqual(report, ['422: migration SQL failed', 'restored root'])
})

Deno.test('a migration committed before an object restart is confirmed by an idempotent retry', async () => {
  for (const lost of [new TypeError('connection reset'), new Response('object restarted after commit', { status: 500 })]) {
    const events: string[] = []
    let recorded = false
    const answer = await migrateKeptDirectory(async () => {
      events.push('migrate')
      if (recorded) return Response.json({ applied: [] })
      recorded = true
      if (lost instanceof Error) throw lost
      return lost
    }, async () => { events.push('settled') }, (message) => events.push(message))
    assert.equal(answer.ok, true)
    assert.deepEqual(JSON.parse(answer.answer), { applied: [] })
    assert.equal(events[0], 'migrate')
    assert.match(events[1], /migration attempt 1 (lost its response|returned 500)/)
    assert.deepEqual(events.slice(2), ['settled', 'migrate'])
  }
})

Deno.test('definitive migration responses are not retried', async () => {
  for (const status of [200, 400, 401, 403, 409, 422, 501]) {
    let calls = 0
    const result = await migrateKeptDirectory(async () => { calls++; return new Response('migration answer', { status }) }, async () => assert.fail('a definitive response must not wait for another attempt'), () => assert.fail('a definitive response must not be reported as transient'))
    assert.equal(calls, 1)
    assert.equal(result.status, status)
    assert.equal(result.answer, 'migration answer')
  }
})

Deno.test('a PostgreSQL migration refusal reaches rollback immediately with its SQLSTATE diagnostic', async () => {
  const events: string[] = []
  const result = await migrateKeptDirectory(async () => {
    events.push('migrate')
    return Response.json({ error: 'duplicate key violates unique constraint board_pkey', sqlstate: '23505' }, { status: 422 })
  }, async () => assert.fail('SQL refusals must not retry'), () => assert.fail('SQL refusals are not ambiguous'))
  assert.equal(result.ok, false)
  await assert.rejects(() => rollbackRefusedMigration(`${result.status}: ${result.answer}`, [{ config: 'root', previous: 'old-root' }], async (config, previous) => {
    events.push(`rollback ${config} ${previous}`)
    return 'restored root'
  }, (message) => events.push(message)), /422: .*23505/)
  assert.equal(events[0], 'migrate')
  assert.match(events[1], /422: .*duplicate key.*23505/)
  assert.deepEqual(events.slice(2), ['rollback root old-root', 'restored root'])
})

Deno.test('ambiguous migration failures stop after three attempts and preserve every diagnostic', async () => {
  let attempts = 0
  let waits = 0
  const report: string[] = []
  await assert.rejects(() => migrateKeptDirectory(async () => {
    attempts++
    if (attempts === 1) throw new TypeError('first response lost')
    return new Response(`upstream failure ${attempts}`, { status: attempts === 2 ? 502 : 503 })
  }, async () => { waits++ }, (message) => report.push(message)), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /after 3 attempts.*Workers were kept/)
    assert.equal(error.errors.length, 3)
    assert.match(error.errors[0].message, /first response lost/)
    assert.match(error.errors[1].message, /502: upstream failure 2/)
    assert.match(error.errors[2].message, /503: upstream failure 3/)
    return true
  })
  assert.equal(attempts, 3)
  assert.equal(waits, 2)
  assert.equal(report.length, 3)
})

Deno.test('a migration programming error is not retried and a failed settle keeps the earlier network cause', async () => {
  const unexpected = new Error('invalid migration request construction')
  await assert.rejects(() => migrateKeptDirectory(() => { throw unexpected }, async () => assert.fail('must not settle'), () => assert.fail('must not report a programming error as transient')), (error: unknown) => error === unexpected)
  const network = new TypeError('response lost')
  const timeout = new Error('Worker did not settle')
  await assert.rejects(() => migrateKeptDirectory(() => { throw network }, () => { throw timeout }, () => {}), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[0].cause, network)
    assert.equal(error.errors[1], timeout)
    return true
  })
})
