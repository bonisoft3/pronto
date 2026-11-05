import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseFiles } from './edge-scripts.ts'

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
