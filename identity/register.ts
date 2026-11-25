// A release's own client of each issuer that registers its clients (OpenID
// Connect Dynamic Client Registration, which the Ory broker serves), for every
// target's release: the edge's imports it, k8s's and gcp's run it on their OIDC_* settings,
//   echo '{"OIDC_PROVIDERS":…}' | deno run --no-config --allow-net --allow-read identity/register.ts https://app.example [--app .]
// A client per provider signing in through that issuer as the origin, each
// public, pairwise and with that provider's one callback: Hydra refuses a
// pairwise client of several callbacks unless it names a sector document,
// and the subject hangs on the callback's host alone, so one person is one
// subject across an app's providers. A person's subject hangs on the release's host, not its
// client, so a fresh client each release keeps them who they were; its
// registration token is not kept, since nothing updates it.
import { type Brand, readAppBrand, sanitizeBrand } from './brand.ts'

export async function registerClients(
  vars: Record<string, string>,
  origin: string | undefined,
  fetcher: typeof fetch = fetch,
  brand?: Brand | null,
): Promise<Record<string, string>> {
  const byIssuer = new Map<string, string[]>()
  for (const p of (vars.OIDC_PROVIDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const upper = p.toUpperCase()
    const issuer = vars[`OIDC_${upper}_ISSUER`]
    if (issuer === undefined || vars[`OIDC_${upper}_CLIENT_ID`] !== 'origin') continue
    byIssuer.set(issuer, [...byIssuer.get(issuer) ?? [], p])
  }
  const json = async (url: string, init?: RequestInit) => {
    const res = await fetcher(url, init)
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: ${res.status} ${await res.text()}`)
    return await res.json()
  }
  const out = { ...vars }
  const safeBrand = brand ? sanitizeBrand(brand, origin ?? null) : null
  for (const [issuer, providers] of byIssuer) {
    const { registration_endpoint } = await json(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
    if (typeof registration_endpoint !== 'string' || registration_endpoint === '') {
      throw new Error(`${issuer} publishes no registration_endpoint in its discovery document`)
    }
    if (origin === undefined) throw new Error(`${issuer} registers its clients, so a release signing in through it names its --domain`)
    for (const p of providers) {
      const { client_id } = await json(registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: safeBrand?.name ?? `${origin} ${p}`,
          ...(safeBrand?.logo ? { logo_uri: safeBrand.logo } : {}),
          redirect_uris: [`${origin}/auth/oidc/${p}/callback`],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'openid email profile',
          subject_type: 'pairwise',
        }),
      })
      if (typeof client_id !== 'string') throw new Error(`${registration_endpoint} registered no client_id`)
      out[`OIDC_${p.toUpperCase()}_CLIENT_ID`] = client_id
    }
  }
  return out
}

if (import.meta.main) {
  const origin = Deno.args[0]
  if (!origin || URL.parse(origin)?.origin !== origin) throw new Error('usage: register.ts <https origin> [--app <dir>] < settings.json')
  const appFlag = Deno.args.indexOf('--app')
  const appDir = appFlag !== -1 ? Deno.args[appFlag + 1] : undefined
  const brand = appDir ? await readAppBrand(appDir, origin) : null
  const vars = JSON.parse(await new Response(Deno.stdin.readable).text()) as Record<string, string>
  console.log(JSON.stringify(await registerClients(vars, origin, fetch, brand)))
}
