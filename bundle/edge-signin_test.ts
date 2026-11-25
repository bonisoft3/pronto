import assert from 'node:assert/strict'
import { signInVars } from './edge-signin.ts'

const env = (vars: Record<string, string>) => (name: string) => vars[name]

Deno.test('a deployment\'s broker stands in for the program\'s, and a client of its own keeps its issuer', () => {
  // Regression: the program's broker reaches the edge as Google's issuer, so
  // an issuer alone looked like a client of Google's own and kept the
  // program's broker after the deployment named another.
  const signIn = {
    google: { issuer: 'https://program-broker.test', client: 'origin', scope: 'openid profile email', params: 'provider=google' },
    email: { issuer: 'https://id.bonisoft3.com', client: 'origin', scope: 'openid profile email' },
    owned: { issuer: 'https://auth.test/', client: 'c-123', scope: 'openid profile email' },
    bluesky: {},
  }
  const vars = signInVars(signIn, env({ OIDC_BROKER: 'https://deployment-broker.test' }))
  assert.deepEqual(vars.OIDC_PROVIDERS, 'google,email,owned,bluesky')
  assert.deepEqual([vars.OIDC_GOOGLE_ISSUER, vars.OIDC_GOOGLE_CLIENT_ID, vars.OIDC_GOOGLE_AUTHORIZE_PARAMS], ['https://deployment-broker.test', 'origin', 'provider=google'])
  assert.deepEqual([vars.OIDC_EMAIL_ISSUER, vars.OIDC_EMAIL_CLIENT_ID], ['https://id.bonisoft3.com', 'origin'])
  assert.deepEqual([vars.OIDC_OWNED_ISSUER, vars.OIDC_OWNED_CLIENT_ID], ['https://auth.test/', 'c-123'])
  assert.deepEqual(Object.keys(vars).filter((k) => k.startsWith('OIDC_BLUESKY_')), [])
})

Deno.test('with no deployment broker, the program\'s settings stand, under a deployment\'s own variables', () => {
  const signIn = { google: { client: 'c.apps.googleusercontent.com', credential: true } }
  assert.deepEqual(signInVars(signIn, env({})), { OIDC_PROVIDERS: 'google', OIDC_GOOGLE_CLIENT_ID: 'c.apps.googleusercontent.com', OIDC_GOOGLE_CREDENTIAL: 'true' })
  assert.deepEqual(signInVars(signIn, env({ OIDC_GOOGLE_CLIENT_ID: 'other' })).OIDC_GOOGLE_CLIENT_ID, 'other')
  assert.deepEqual(signInVars({}, env({ OIDC_BROKER: 'https://b.test' })), {})
})

Deno.test('a deployment broker that is no https origin is refused', () => {
  assert.throws(() => signInVars({ google: {} }, env({ OIDC_BROKER: 'http://b.test' })), /not an https origin/)
})
