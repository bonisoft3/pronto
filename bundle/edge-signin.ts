// The auth service's provider settings an edge release gives its Worker
// (OIDC_<NAME>_<SETTING>): the program's, a deployment's environment over
// them, and a deployment's broker (OIDC_BROKER, a staging host whose origin no
// client registers) in place of every provider the program's broker stood in
// for — its client the origin — or that names no issuer. A provider of a
// registered client of its own (the Ory broker's `email`) keeps it, and
// Bluesky's client is the origin anyway.
export type SignInSetting = { issuer?: string; client?: string; scope?: string; params?: string; credential?: boolean };

export function signInVars(
  signIn: Record<string, SignInSetting | undefined>,
  env: (name: string) => string | undefined,
): Record<string, string> {
  const declared = Object.keys(signIn)
  if (declared.length === 0) return {}
  const requested = env('OIDC_PROVIDERS')
  const providers = requested !== undefined && requested.trim() !== ''
    ? requested.split(',').map((s) => s.trim()).filter(Boolean)
    : declared
  for (const p of providers) {
    if (!declared.includes(p)) throw new Error(`OIDC_PROVIDERS names ${p}, which this app does not declare`)
  }
  const broker = env('OIDC_BROKER')
  if (broker !== undefined && !/^https:\/\/[^/]+$/.test(broker)) throw new Error(`OIDC_BROKER is ${JSON.stringify(broker)}, not an https origin`)
  const vars: Record<string, string> = { OIDC_PROVIDERS: providers.join(',') }
  for (const p of providers) {
    const upper = p.toUpperCase()
    const own = signIn[p] ?? {}
    const cfg = broker !== undefined && p !== 'bluesky' && (own.issuer === undefined || (own.client === 'origin' && own.params === `provider=${p}`))
      ? { issuer: broker, client: 'origin', scope: 'openid profile email', params: `provider=${p}` }
      : own
    // Bluesky's client is the origin; a deployment may name its entryway and AppView.
    const settings = p === 'bluesky'
      ? [['ENTRYWAY', undefined], ['APPVIEW', undefined]] as const
      : [['ISSUER', cfg.issuer], ['CLIENT_ID', cfg.client], ['SCOPE', cfg.scope], ['AUTHORIZE_PARAMS', cfg.params], ['CREDENTIAL', 'credential' in cfg && cfg.credential ? 'true' : undefined]] as const
    for (const [setting, value] of settings) {
      const set = env(`OIDC_${upper}_${setting}`) || value
      if (set) vars[`OIDC_${upper}_${setting}`] = set
    }
  }
  return vars
}
