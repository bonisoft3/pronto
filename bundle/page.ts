// The page of an app with server entities: mecha's browser platform booted in
// the tab behind the shim (page-core.ts), on PGlite. `mecha-browser/` resolves
// through the map the bundler writes from the root it is given.
import { createCluster } from 'mecha-browser/cluster.ts'
import type { Drain } from 'mecha-browser/drains.ts'
import { browserCompute, type BrowserCompute } from 'mecha-browser/compute.ts'
import type { Computation } from 'mecha-browser/../compute-snapshot/src/index.ts'
import computeMachines from 'pronto-bundle-compute-machine'
import { createPageDatabase, type DatabaseAssets } from './database.ts'
import { payload, startPage } from './page-core.ts'

const { sql, tables, drains, clock, assets, compute } = payload.cluster as {
  sql: string[]
  tables: string[]
  drains: Drain[]
  clock: 'ticker' | 'disabled'
  assets: DatabaseAssets
  compute?: BrowserCompute & { computations: Computation[] }
}

startPage(async () => {
  const { schema } = JSON.parse(payload.files['shell/shell.json'])
  const db = await createPageDatabase(assets)
  const executor = compute ? await browserCompute(compute) : undefined
  // A change the cluster lost leaves a table no read can trust again, so
  // the page dies of it where its boot would.
  const cluster = await createCluster({
    db, sql, tables, schema, drains, clock, log: console.error,
    compute: compute ? { computations: compute.computations, machine: computeMachines.compute_batch, execute: executor!.execute } : undefined,
    fail: (e) => {
      document.body.textContent = `page failed: ${e.message}`
      reportError(e)
    },
  })
  return (req) => cluster.handle(req)
})
