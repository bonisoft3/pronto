// The scripts a release's data directory is built from, in the order a
// directory applies them, and what a publish hands a directory the object
// kept: mecha's tenancy step, the shell's migrations with mecha's schedule
// table before its seed, then the cluster's pgroll set, which is what carries
// a kept directory forward. pgdata.ts builds from them; edge.ts writes them
// as migrations.json; one list, so the names a directory records are the
// names a publish sends.
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface Script { name: string; sql: string | null }
export interface ReleaseScripts {
  /** The files, each fenced for this tier but the schedule seed, which the
   * page's build fences out and a directory here takes whole. */
  files: { name: string; sql: string; fenced: boolean }[]
  pgroll: Script[]
}

const SCHEDULE_SEED = '801_schedule_seed.sql'

export async function releaseScripts(app: string, mecha: string, migrations: string[], pgroll: Record<string, { operations: Record<string, unknown>[] }>): Promise<ReleaseScripts> {
  const { pgrollScripts, SCHEDULE_SCRIPT, TENANCY_SCRIPT } = await import(String(pathToFileURL(path.join(mecha, 'packages/pglite-workerd/scripts.ts')))) as {
    pgrollScripts: (set: unknown) => Script[]
    SCHEDULE_SCRIPT: string
    TENANCY_SCRIPT: string
  }
  const files = [{ name: TENANCY_SCRIPT, file: path.join(mecha, 'services/database/rls/rls.sql'), fenced: true }]
  for (const m of migrations) {
    const name = path.basename(m)
    if (name === SCHEDULE_SEED) files.push({ name: SCHEDULE_SCRIPT, file: path.join(mecha, 'services/ticker/schedule.sql'), fenced: true })
    files.push({ name, file: path.join(app, m), fenced: name !== SCHEDULE_SEED })
  }
  return {
    files: await Promise.all(files.map(async ({ name, file, fenced }) => ({ name, sql: await Deno.readTextFile(file), fenced }))),
    pgroll: pgrollScripts(pgroll),
  }
}
