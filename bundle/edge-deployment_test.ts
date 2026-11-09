import assert from 'node:assert/strict'
import { requireLocalCluster } from './edge-deployment.ts'

const options = {
  config: 'wrangler.jsonc', name: 'app', previous: 'version-1',
  wrangler: (_args: string[]) => Promise.resolve(JSON.stringify({ resources: { bindings: [{ name: 'CLUSTER', type: 'durable_object_namespace', class_name: 'Cluster' }] } })),
}

Deno.test('preflight inspects the deployed version and permits a local Cluster', async () => {
  const calls: string[][] = []
  await requireLocalCluster({ ...options, wrangler: args => { calls.push(args); return options.wrangler(args) } })
  assert.deepEqual(calls, [['versions', 'view', 'version-1', '--config', 'wrangler.jsonc', '--json']])
  await requireLocalCluster({ ...options, previous: null, wrangler: () => { throw new Error('first deployment has no version') } })
  await requireLocalCluster({ ...options, wrangler: () => Promise.resolve(JSON.stringify({ resources: { bindings: [{ name: 'CLUSTER', type: 'durable_object_namespace', class_name: 'Cluster', script_name: 'app' }] } })) })
})

Deno.test('preflight refuses a Cluster in a different namespace', async () => {
  for (const change of [{ script_name: 'app-database' }, { environment: 'production' }, { class_name: 'Other' }]) {
    const binding = { name: 'CLUSTER', type: 'durable_object_namespace', class_name: 'Cluster', ...change }
    await assert.rejects(requireLocalCluster({ ...options, wrangler: () => Promise.resolve(JSON.stringify({ resources: { bindings: [binding] } })) }), /migrate its data before publishing/)
  }
})

Deno.test('preflight fails closed on malformed metadata or API failure', async () => {
  for (const response of ['invalid JSON', '{}', '{"resources":{"bindings":[{}]}}', '{"resources":{"bindings":[{"name":"CLUSTER","type":"durable_object_namespace"}]}}']) {
    await assert.rejects(requireLocalCluster({ ...options, wrangler: () => Promise.resolve(response) }))
  }
  await assert.rejects(requireLocalCluster({ ...options, wrangler: () => Promise.reject(new Error('authentication failed')) }), /authentication failed/)
})
