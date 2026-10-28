import assert from 'node:assert/strict'
import { releasedIssuers, signInSecrets, signInVars } from './edge-signin.ts'

const env = (values: Record<string, string>) => (name: string) => values[name]

Deno.test('an app naming no provider gives the Worker no var and no secret', () => {
  assert.deepEqual(signInVars({}, env({ OIDC_GOOGLE_CLIENT_ID: 'stray' })), {})
  assert.deepEqual(signInSecrets({}, env({ OIDC_GOOGLE_CLIENT_SECRET: 'stray' })), {})
})

Deno.test("the program's settings are the vars, and the environment's win", () => {
  const signIn = { google: { client: 'program.apps.googleusercontent.com', scope: 'openid profile' } }
  assert.deepEqual(signInVars(signIn, env({})), {
    OIDC_PROVIDERS: 'google',
    OIDC_GOOGLE_CLIENT_ID: 'program.apps.googleusercontent.com',
    OIDC_GOOGLE_SCOPE: 'openid profile',
  })
  assert.deepEqual(signInVars(signIn, env({ OIDC_GOOGLE_CLIENT_ID: 'deploy.apps.googleusercontent.com', OIDC_GOOGLE_AUTHORIZE_PARAMS: 'hd=example.com' })), {
    OIDC_PROVIDERS: 'google',
    OIDC_GOOGLE_CLIENT_ID: 'deploy.apps.googleusercontent.com',
    OIDC_GOOGLE_SCOPE: 'openid profile',
    OIDC_GOOGLE_AUTHORIZE_PARAMS: 'hd=example.com',
  })
})

Deno.test('a provider with no client id from either is refused, as compose refuses it', () => {
  assert.throws(() => signInVars({ google: {} }, env({})), { message: /OIDC_GOOGLE_CLIENT_ID is required/ })
  assert.deepEqual(signInVars({ google: {} }, env({ OIDC_GOOGLE_CLIENT_ID: 'c' })).OIDC_GOOGLE_CLIENT_ID, 'c')
})

Deno.test("a client secret is a publish's secret, never a var, and Google's own issuer needs one", () => {
  const vars = signInVars({ google: { client: 'c' } }, env({ OIDC_GOOGLE_CLIENT_SECRET: 's' }))
  assert.deepEqual(Object.keys(vars).some((k) => k.endsWith('_SECRET')), false)
  assert.deepEqual(signInSecrets(vars, env({ OIDC_GOOGLE_CLIENT_SECRET: 's' })), { OIDC_GOOGLE_CLIENT_SECRET: 's' })
  assert.throws(() => signInSecrets(vars, env({})), { message: /OIDC_GOOGLE_CLIENT_SECRET is required/ })
  // A broker in Google's place, a public client named by the door's origin.
  const broker = signInVars({ google: { client: 'origin', issuer: 'https://broker.example' } }, env({}))
  assert.deepEqual(signInSecrets(broker, env({})), {})
})

Deno.test("a release goes out only through an issuer a reader reaches: the local broker's is refused", () => {
  const vars = (issuer: string) => ({ OIDC_PROVIDERS: 'google', OIDC_GOOGLE_CLIENT_ID: 'origin', OIDC_GOOGLE_ISSUER: issuer })
  releasedIssuers(vars('https://id.bonkchess.com'))
  releasedIssuers({ OIDC_PROVIDERS: 'google', OIDC_GOOGLE_CLIENT_ID: 'app.apps.googleusercontent.com' })
  releasedIssuers({})
  for (const local of ['http://localhost:28443', 'https://localhost:28443', 'http://127.0.0.1:28443', 'https://id.localhost', 'http://id.example.com']) {
    assert.throws(() => releasedIssuers(vars(local)), /OIDC_GOOGLE_ISSUER is .* a local broker/, local)
  }
})
