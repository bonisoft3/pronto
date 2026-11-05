// The page of an app with server entities: mecha's browser platform booted in
// the tab behind the shim (page-core.ts), on PGlite. `mecha-browser/` resolves
// through the map the bundler writes from the root it is given.
import { createCluster } from 'mecha-browser/cluster.ts'
import type { Drain } from 'mecha-browser/drains.ts'
import { createPageDatabase, type DatabaseAssets } from './database.ts'
import { payload, startPage } from './page-core.ts'

const { sql, tables, drains, clock, assets } = payload.cluster as {
  sql: string[]
  tables: string[]
  drains: Drain[]
  clock: 'ticker' | 'disabled'
  assets: DatabaseAssets
}

startPage(async () => {
  const { schema } = JSON.parse(payload.files['shell/shell.json'])
  const db = await createPageDatabase(assets)
  // A change the cluster lost leaves a table no read can trust again, so
  // the page dies of it where its boot would.
  const cluster = await createCluster({
    db, sql, tables, schema, drains, clock, log: console.error,
    fail: (e) => {
      document.body.textContent = `page failed: ${e.message}`
      reportError(e)
    },
  })
  return (req) => cluster.handle(req)
})
