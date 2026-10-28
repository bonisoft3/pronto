type JwtOptions = {
  secret?: string
  secretPath: string
  ci: boolean
  temporary: boolean
  configs: string[]
  wrangler: (args: string[]) => Promise<string>
  random: () => string
}

/** Undefined leaves the deployed key untouched in Wrangler's secrets file. */
export async function releaseJwtSecret({ secret, secretPath, ci, temporary, configs, wrangler, random }: JwtOptions): Promise<string | undefined> {
  if (secret?.trim()) return secret.trim()
  try {
    const local = (await Deno.readTextFile(secretPath)).trim()
    if (!local) throw new Error('JWT secret is empty')
    return local
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  if (ci) {
    if (temporary || !configs.length) throw new Error('JWT_SECRET must be configured for the first CI release')
    for (const config of configs) {
      const bindings = JSON.parse(await wrangler(['secret', 'list', '--config', config, '--format', 'json'])) as { name: string; type: string }[]
      if (!bindings.some(binding => binding.name === 'JWT_SECRET' && binding.type === 'secret_text')) {
        throw new Error(`JWT_SECRET is not deployed for ${config}; configure secrets.JWT_SECRET for the first CI release`)
      }
    }
    // Wrangler deploy keeps existing secret bindings omitted from --secrets-file.
    return undefined
  }
  const generated = random()
  await Deno.writeTextFile(secretPath, generated, { mode: 0o600 })
  return generated
}
