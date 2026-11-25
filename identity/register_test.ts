// deno test --no-config identity/register_test.ts
import assert from 'node:assert/strict'
import { registerClients } from './register.ts'

const broker = (registers: boolean, seen: unknown[]) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/.well-known/openid-configuration')) {
    return Response.json(registers ? { issuer: 'https://id.test/', registration_endpoint: 'https://id.test/oauth2/register' } : { issuer: 'https://old.test' })
  }
  seen.push(JSON.parse(String(init?.body)))
  return Response.json({ client_id: `c-${seen.length}`, registration_access_token: 'kept-nowhere' }, { status: 201 })
}) as typeof fetch

Deno.test('a release registers a client of its own for each provider signing in through an issuer that registers clients', async () => {
  const seen: Record<string, unknown>[] = []
  const vars = {
    OIDC_PROVIDERS: 'google,email,bluesky',
    OIDC_GOOGLE_ISSUER: 'https://id.test/', OIDC_GOOGLE_CLIENT_ID: 'origin',
    OIDC_EMAIL_ISSUER: 'https://id.test/', OIDC_EMAIL_CLIENT_ID: 'origin',
  }
  const out = await registerClients(vars, 'https://app.test', broker(true, seen))
  assert.deepEqual([out.OIDC_GOOGLE_CLIENT_ID, out.OIDC_EMAIL_CLIENT_ID], ['c-1', 'c-2'])
  // Regression: one client for both callbacks, pairwise, was refused at
  // sign-in by Hydra, which wants a sector document for several callbacks.
  assert.deepEqual(seen.map((s) => s.redirect_uris), [['https://app.test/auth/oidc/google/callback'], ['https://app.test/auth/oidc/email/callback']])
  assert.equal(seen[0].subject_type, 'pairwise')
  assert.equal(seen[0].token_endpoint_auth_method, 'none')
})

Deno.test('an issuer that publishes no registration_endpoint fails loudly instead of keeping origin', async () => {
  const seen: unknown[] = []
  const vars = { OIDC_PROVIDERS: 'google', OIDC_GOOGLE_ISSUER: 'https://old.test', OIDC_GOOGLE_CLIENT_ID: 'origin' }
  await assert.rejects(registerClients(vars, 'https://app.test', broker(false, seen)), /publishes no registration_endpoint/)
  assert.deepEqual(seen, [])
})

Deno.test('a client of its own is never registered, and a registering issuer needs the release\'s domain', async () => {
  const seen: unknown[] = []
  const own = { OIDC_PROVIDERS: 'google', OIDC_GOOGLE_CLIENT_ID: 'c.apps.googleusercontent.com', OIDC_GOOGLE_ISSUER: 'https://accounts.google.com' }
  assert.deepEqual(await registerClients(own, undefined, broker(true, seen)), own)
  await assert.rejects(registerClients({ OIDC_PROVIDERS: 'email', OIDC_EMAIL_ISSUER: 'https://id.test/', OIDC_EMAIL_CLIENT_ID: 'origin' }, undefined, broker(true, seen)), /--domain/)
  assert.deepEqual(seen, [])
})

Deno.test('registerClients trims whitespace in OIDC_PROVIDERS', async () => {
  const seen: Record<string, unknown>[] = []
  const vars = {
    OIDC_PROVIDERS: 'google, email, bluesky',
    OIDC_GOOGLE_ISSUER: 'https://id.test/', OIDC_GOOGLE_CLIENT_ID: 'origin',
    OIDC_EMAIL_ISSUER: 'https://id.test/', OIDC_EMAIL_CLIENT_ID: 'origin',
  }
  const out = await registerClients(vars, 'https://app.test', broker(true, seen))
  assert.deepEqual([out.OIDC_GOOGLE_CLIENT_ID, out.OIDC_EMAIL_CLIENT_ID], ['c-1', 'c-2'])
  assert.equal(seen.length, 2)
})

Deno.test('registerClients attaches sanitized client_name and logo_uri and omits metadata', async () => {
  const seen: Record<string, unknown>[] = []
  const vars = {
    OIDC_PROVIDERS: 'email',
    OIDC_EMAIL_ISSUER: 'https://id.test/', OIDC_EMAIL_CLIENT_ID: 'origin',
  }
  await registerClients(vars, 'https://app.test', broker(true, seen), {
    name: 'App Name',
    logo: '/shell/favicon.svg',
    colors: { accent: '#B45309' },
  })
  assert.equal(seen[0].client_name, 'App Name')
  assert.equal(seen[0].logo_uri, 'https://app.test/shell/favicon.svg')
  // Regression: Hydra open DCR rejects client-supplied `metadata`.
  assert.equal('metadata' in seen[0], false)
})
