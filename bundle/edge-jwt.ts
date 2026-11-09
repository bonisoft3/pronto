type JwtOptions = {
  secret?: string
  config: string
  previous: string | null
  wrangler: (args: string[]) => Promise<string>
  random: () => string
}

export async function releaseJwtSecret({ secret, config, previous, wrangler, random }: JwtOptions): Promise<string | undefined> {
  if (previous === null) {
    const value = secret?.trim() || random()
    if (!value.trim()) throw new Error('JWT_SECRET must not be empty')
    return value
  }
  const bindings: unknown = JSON.parse(await wrangler(['secret', 'list', '--config', config, '--format', 'json']))
  if (!Array.isArray(bindings) || !bindings.every(binding => binding && typeof binding.name === 'string' && typeof binding.type === 'string')) {
    throw new Error(`Invalid secret list for ${config}`)
  }
  if (!bindings.some(binding => binding.name === 'JWT_SECRET' && binding.type === 'secret_text')) {
    throw new Error(`JWT_SECRET is not deployed for ${config}; refusing to replace a signing key on an existing worker`)
  }
  return undefined
}
