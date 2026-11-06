import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseFiles } from './edge-scripts.ts'
import { emitFiles, paymentProgram } from '../effects-fixtures.ts'

const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))

Deno.test('release files select the explicit tenancy baseline exactly once', async () => {
  const app = await Deno.makeTempDir()
  try {
    const dir = path.join(app, 'services/database/migrations')
    await Deno.mkdir(dir, { recursive: true })
    const script = '-- previously applied floor\nSELECT 42;\n'
    const baseline = 'services/database/migrations/003_rls.sql'
    await Deno.writeTextFile(path.join(app, baseline), script)
    await Deno.writeTextFile(path.join(dir, '010_machines.sql'), 'SELECT 10;\n')
    await Deno.writeTextFile(path.join(dir, '016_mecha_actors.sql'), 'SELECT 16;\n')
    const ordinary = await releaseFiles(app, mecha, ['services/database/migrations/010_machines.sql'])
    assert.equal(ordinary[0].name, '003_rls.sql')
    assert.equal(ordinary[0].sql, await Deno.readTextFile(path.join(mecha, 'services/database/rls/rls.sql')))
    const explicit = await releaseFiles(app, mecha, ['services/database/migrations/016_mecha_actors.sql', 'services/database/migrations/010_machines.sql', baseline])
    assert.deepEqual(explicit.map((file) => file.name), ['003_rls.sql', '010_machines.sql', '016_mecha_actors.sql'])
    assert.equal(explicit[0].sql, script)
    await assert.rejects(() => releaseFiles(app, mecha, [baseline, baseline]), /duplicate migration 003_rls.sql/)
    await assert.rejects(() => releaseFiles(app, mecha, ['services/database/migrations/010_machines.sql', 'services/database/migrations/010_machines.sql']), /duplicate migration 010_machines.sql/)
    await Deno.remove(path.join(app, baseline))
    await assert.rejects(() => releaseFiles(app, mecha, [baseline]), Deno.errors.NotFound)
  } finally {
    await Deno.remove(app, { recursive: true })
  }
})

Deno.test('selected baselines keep their ledger digests across a forward release', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { applyScripts, ChangedScript, recordScripts } = await import('../../../libraries/mecha/packages/pglite-workerd/scripts.ts')
  const app = await Deno.makeTempDir()
  const db = await PGlite.create()
  try {
    const dir = path.join(app, 'services/database/migrations')
    await Deno.mkdir(dir, { recursive: true })
    const scripts = [
      ['003_rls.sql', 'CREATE TABLE floor_row (id int);\n'],
      ['010_machines.sql', 'CREATE TABLE machine_row (id int);\n'],
      ['019_cortex.sql', 'CREATE TABLE cortex_row (id int);\n'],
    ] as const
    for (const [name, sql] of scripts) await Deno.writeTextFile(path.join(dir, name), sql)
    const paths = scripts.map(([name]) => `services/database/migrations/${name}`)
    const original = await releaseFiles(app, mecha, paths)
    for (const file of original) await db.exec(file.sql)
    await recordScripts(db, original)
    await Deno.writeTextFile(path.join(dir, '020_forward.sql'), 'CREATE TABLE forward_row (id int);\n')
    const release = await releaseFiles(app, mecha, [...paths, 'services/database/migrations/020_forward.sql'])
    assert.deepEqual(await applyScripts(db, release, () => {}), ['020_forward.sql'])
    await Deno.writeTextFile(path.join(dir, '010_machines.sql'), 'CREATE TABLE changed_row (id int);\n')
    await Deno.writeTextFile(path.join(dir, '021_later.sql'), 'CREATE TABLE later_row (id int);\n')
    const changed = await releaseFiles(app, mecha, [...paths, 'services/database/migrations/020_forward.sql', 'services/database/migrations/021_later.sql'])
    await assert.rejects(() => applyScripts(db, changed, () => {}), (error: Error) => error instanceof ChangedScript && error.message.includes('010_machines.sql'))
    const result = await db.query<{ name: string | null }>("SELECT to_regclass('public.later_row')::text AS name")
    assert.equal(result.rows[0].name, null)
  } finally {
    await db.close()
    await Deno.remove(app, { recursive: true })
  }
})

// The page and the edge run the effect steps where initdb does: at mecha's
// names by default, at the program's when it places them.
Deno.test('release files place the effect steps where their names sort', async () => {
  const app = await Deno.makeTempDir()
  try {
    const dir = path.join(app, 'services/database/migrations')
    await Deno.mkdir(path.join(app, 'services/airlock'), { recursive: true })
    await Deno.writeTextFile(path.join(app, 'services/airlock/effects.json'), JSON.stringify({ effects: { charge: {} } }))
    await Deno.mkdir(dir, { recursive: true })
    const names = ['010_game_days.sql', '011_comment_writes.sql', '062_machines.sql', '900_seed.sql']
    for (const name of names) await Deno.writeTextFile(path.join(dir, name), 'SELECT 1;\n')
    const paths = names.map((name) => `services/database/migrations/${name}`)
    const order = async (steps = {}) => (await releaseFiles(app, mecha, paths, steps)).map((file) => file.name)
    assert.deepEqual(await order(), ['003_rls.sql', '010_game_days.sql', '011_comment_writes.sql', '011_graphile_worker.sql', '012_airlock.sql', '062_machines.sql', '900_seed.sql'])
    assert.deepEqual(await order({ graphile: '060_graphile_worker.sql', airlock: '061_airlock.sql' }), ['003_rls.sql', '010_game_days.sql', '011_comment_writes.sql', '060_graphile_worker.sql', '061_airlock.sql', '062_machines.sql', '900_seed.sql'])
  } finally {
    await Deno.remove(app, { recursive: true })
  }
})

// A page or edge directory built from a program that places the effect steps
// runs them where their names sort, and its invoking state claims and enqueues.
Deno.test('placed effect steps build a page database that claims and enqueues', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { browserTier } = await import('../../../libraries/mecha/packages/mecha-browser/fence.ts')
  const files = await emitFiles(paymentProgram() + '\napp: state: steps: {machines: "062", graphile: "060", airlock: "061", note: "no payment row is written below 060"}\n')
  const steps = (files['.pronto/cluster.json'] as unknown as { data: { steps: { graphile: string; airlock: string } } }).data.steps
  const app = await Deno.makeTempDir()
  const db = await PGlite.create()
  try {
    const dir = path.join(app, 'services/database/migrations')
    await Deno.mkdir(path.join(app, 'services/airlock'), { recursive: true })
    await Deno.mkdir(dir, { recursive: true })
    await Deno.writeTextFile(path.join(app, 'services/airlock/effects.json'), JSON.stringify((files['services/airlock/effects.json'] as unknown as { data: unknown }).data))
    await Deno.writeTextFile(path.join(dir, '005_payment.sql'), 'CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text);\n')
    await Deno.writeTextFile(path.join(dir, '062_machines.sql'), files['services/database/migrations/062_machines.sql'].text)
    const release = await releaseFiles(app, mecha, ['services/database/migrations/005_payment.sql', 'services/database/migrations/062_machines.sql'], steps)
    assert.deepEqual(release.map((f) => f.name), ['003_rls.sql', '005_payment.sql', '060_graphile_worker.sql', '061_airlock.sql', '062_machines.sql'])
    await db.exec('CREATE ROLE anon; CREATE ROLE app_user; CREATE ROLE electric; CREATE ROLE service;')
    for (const file of release) await db.exec(browserTier(file.sql))
    const id = '00000000-0000-0000-0000-000000000001'
    await db.exec(`INSERT INTO payment VALUES ('${id}', 'pending', 12.50, NULL); UPDATE payment SET status = 'charging' WHERE id = '${id}';`)
    const counts = await db.query<{ n: string }>('SELECT (SELECT count(*) FROM airlock.external_effect_ledger) || \',\' || (SELECT count(*) FROM graphile_worker.jobs) AS n')
    assert.equal(counts.rows[0].n, '1,1')
  } finally {
    await db.close()
    await Deno.remove(app, { recursive: true })
  }
})
