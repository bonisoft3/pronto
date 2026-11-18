export function validateJwtMode(keepJwtSecret: boolean, reset: boolean, temporary: boolean): void {
  if (keepJwtSecret && (reset || temporary)) {
    throw new Error('--keep-jwt-secret cannot be combined with --reset or --temporary')
  }
}

export async function keptJwtSecrets(
  config: string,
  importToken: string,
  runWrangler: (args: string[]) => Promise<string>,
): Promise<Record<string, string>> {
  const listing: unknown = JSON.parse(await runWrangler(['secret', 'list', '--config', config]))
  if (!Array.isArray(listing)) throw new Error('wrangler secret list returned no secret list')
  const jwt = listing.filter((secret) => secret?.name === 'JWT_SECRET')
  if (jwt.length !== 1 || jwt[0].type !== 'secret_text') {
    throw new Error(`${config}: --keep-jwt-secret requires an existing JWT_SECRET secret_text binding`)
  }
  // Pinned Wrangler retains unspecified secret bindings in the deployed version.
  return { IMPORT_TOKEN: importToken }
}

/** The key groups the selected routes read, for the AI settings this publish
 * carries. A setting held on the dispatcher alone is unreadable here, so its
 * route's key is the call's to refuse (mecha's resolveCallSpec).
 * The value is never echoed. */
export function selectedRouteKeys(routes: Record<string, Record<string, string[][]>>, carried: (name: string) => string | undefined): string[][] {
  return Object.entries(routes).flatMap(([setting, byRoute]) => {
    const value = carried(setting)
    if (!value) return []
    if (!Object.hasOwn(byRoute, value)) throw new Error(`${setting} is not one of ${Object.keys(byRoute).join(', ')}`)
    return byRoute[value]
  })
}
