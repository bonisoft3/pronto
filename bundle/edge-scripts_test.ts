import { assertEquals } from 'jsr:@std/assert@1'
import * as path from 'node:path'
import { FIXTURE, releaseFiles } from './edge-scripts.ts'

// A release's files are what the edge and the page are built from: a test's
// rows (950_fixture.sql) never reach them, as a gcp release's initdb skips them.
Deno.test('an edge release carries every migration but the test fixture', async () => {
  const root = await Deno.makeTempDir()
  try {
    const app = path.join(root, 'app'), mecha = path.join(root, 'mecha')
    const dir = 'services/database/migrations'
    await Deno.mkdir(path.join(app, dir), { recursive: true })
    await Deno.mkdir(path.join(mecha, 'packages/pglite-workerd'), { recursive: true })
    await Deno.mkdir(path.join(mecha, 'services/database/rls'), { recursive: true })
    await Deno.mkdir(path.join(mecha, 'services/ticker'), { recursive: true })
    await Deno.writeTextFile(path.join(mecha, 'packages/pglite-workerd/scripts.ts'),
      "export const SCHEDULE_SCRIPT = '800_schedule.sql'\nexport const TENANCY_SCRIPT = '000_tenancy.sql'\nexport const pgrollScripts = () => []\n")
    await Deno.writeTextFile(path.join(mecha, 'services/database/rls/rls.sql'), '-- rls')
    await Deno.writeTextFile(path.join(mecha, 'services/ticker/schedule.sql'), '-- schedule')
    const names = ['001_schema.sql', '801_schedule_seed.sql', FIXTURE]
    for (const n of names) await Deno.writeTextFile(path.join(app, dir, n), `-- ${n}`)
    const files = await releaseFiles(app, mecha, names.map((n) => `${dir}/${n}`))
    assertEquals(files.map((f) => f.name), ['000_tenancy.sql', '001_schema.sql', '800_schedule.sql', '801_schedule_seed.sql'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
