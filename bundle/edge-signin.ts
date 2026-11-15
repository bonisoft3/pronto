// The providers an edge release signs a person in through, as the Worker's
// vars: the settings mecha's cluster.cue renders into the auth service's
// compose environment (capabilities.signIn), each the program's or the
// environment's OIDC_<NAME>_<SETTING> in its place, as compose's
// ${VAR:-default} reads them. A client secret is never a var: publish-edge.ts
// puts it as a Worker secret.

const SETTINGS: Record<string, string> = { client: 'CLIENT_ID', issuer: 'ISSUER', internal: 'INTERNAL', scope: 'SCOPE', params: 'AUTHORIZE_PARAMS' }

/** The vars, or the reason the Worker could not sign in through a provider:
 * one with no client id, from the program or the environment. */
export function signInVars(signIn: Record<string, Record<string, string>>, env: (name: string) => string | undefined): Record<string, string> {
  const vars: Record<string, string> = {}
  if (Object.keys(signIn).length) vars.OIDC_PROVIDERS = Object.keys(signIn).join(',')
  for (const [provider, given] of Object.entries(signIn)) {
    for (const [setting, suffix] of Object.entries(SETTINGS)) {
      const name = `OIDC_${provider.toUpperCase()}_${suffix}`
      const value = env(name) || given[setting]
      if (value) vars[name] = value
    }
    const client = `OIDC_${provider.toUpperCase()}_CLIENT_ID`
    if (!vars[client]) throw new Error(`${client} is required: the cluster signs in through ${provider}`)
  }
  return vars
}

/** The secrets a publish puts beside the vars: each provider's client secret
 * from the environment. Google's own issuer redeems a code only with one. */
export function signInSecrets(vars: Record<string, string>, env: (name: string) => string | undefined): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const provider of (vars.OIDC_PROVIDERS ?? '').split(',').filter(Boolean)) {
    const name = `OIDC_${provider.toUpperCase()}_CLIENT_SECRET`
    const secret = env(name)
    if (secret) secrets[name] = secret
    else if (provider === 'google' && !vars.OIDC_GOOGLE_ISSUER) throw new Error(`${name} is required: Google redeems a code only with the client's secret`)
  }
  return secrets
}

/** A published Worker's issuers, or the reason it may not go out: one a
 * reader could not reach, a loopback host or plain http, which is the local
 * broker a program names for a developer's machine. Its links name the issuer
 * they were signed in through, an earlier edge's taking this one
 * (mecha-edge's cluster.ts), so a wrong one would part every person from
 * who they were. */
export function releasedIssuers(vars: Record<string, string>): void {
  for (const provider of (vars.OIDC_PROVIDERS ?? '').split(',').filter(Boolean)) {
    const name = `OIDC_${provider.toUpperCase()}_ISSUER`
    const issuer = vars[name]
    if (!issuer) continue
    const url = new URL(issuer)
    const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]' || /^127\./.test(url.hostname)
    if (url.protocol !== 'https:' || loopback) throw new Error(`${name} is ${issuer}, a local broker: a release names the operator's, in its environment`)
  }
}
