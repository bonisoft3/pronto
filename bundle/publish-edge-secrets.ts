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
