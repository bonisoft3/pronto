export function previousDeployment(result: { success: boolean; code: number; stdout: Uint8Array; stderr: Uint8Array }): string | null {
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  if (!result.success) {
    if (stderr.includes('This Worker does not exist on your account.') && /\[code: 10007\]/.test(stderr)) return null
    throw new Error(`wrangler deployments list exited ${result.code}:\n${stderr}\n${stdout}`)
  }
  const listed = JSON.parse(stdout) as { versions: { version_id: string }[] }[]
  if (listed.at(-1)?.versions.length !== 1) throw new Error('Release requires one active Worker version; finish the gradual deployment first')
  const version = listed.at(-1)?.versions[0]?.version_id
  if (!version) throw new Error('Cloudflare returned no deployed version for an existing Worker')
  return version
}

/** A rejected data migration remains the primary error even when a Durable
 * Object schema change prevents one Worker rollback. Other Workers can still
 * be restored independently. */
export async function rollbackRefusedMigration(
  refusal: string,
  deployed: { config: string; previous: string | null }[],
  rollback: (config: string, previous: string) => Promise<string>,
  report: (message: string) => void,
): Promise<never> {
  report(refusal)
  const failures: unknown[] = []
  const restored: string[] = []
  const retained: string[] = []
  for (const { config, previous } of [...deployed].reverse()) {
    if (previous === null) { retained.push(config); continue }
    try {
      report(await rollback(config, previous))
      restored.push(config)
    } catch (error) {
      failures.push(error)
      report(`rollback failed for ${config}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const outcome = `${refusal}\nRollback: ${restored.length} Worker(s) restored, ${failures.length} failed, ${retained.length} have no previous version.`
  if (failures.length) throw new AggregateError(failures, outcome)
  throw new Error(outcome)
}

/** An object can commit its ledger and restart before the response reaches
 * the publisher. Repeating the same scripts confirms that committed result. */
export async function migrateKeptDirectory(
  migrate: () => Promise<Response>,
  settled: () => Promise<void>,
  report: (message: string) => void,
): Promise<{ ok: boolean; status: number; answer: string }> {
  const failures: Error[] = []
  for (let attempt = 1; ; attempt++) {
    let result: { response: Response; answer: string } | undefined
    try {
      const response = await migrate()
      result = { response, answer: await response.text() }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      failures.push(new Error(`migration attempt ${attempt} lost its response: ${error.message}`, { cause: error }))
    }
    if (result) {
      const { response, answer } = result
      if (![500, 502, 503, 504].includes(response.status)) return { ok: response.ok, status: response.status, answer }
      failures.push(new Error(`migration attempt ${attempt} returned ${response.status}: ${answer}`))
    }
    report(failures.at(-1)!.message)
    if (attempt === 3) throw new AggregateError(failures, 'could not confirm the data migration after 3 attempts; the deployed Workers were kept because the migration may have committed')
    try { await settled() }
    catch (error) { throw new AggregateError([...failures, error], 'could not confirm the data migration because the deployed Worker did not settle') }
  }
}
