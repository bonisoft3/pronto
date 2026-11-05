import assert from 'node:assert/strict'
import { releaseJwtSecret } from './edge-jwt.ts'

function fixture() {
  const calls: string[][] = []
  const options: Parameters<typeof releaseJwtSecret>[0] = {
    config: 'wrangler.jsonc', previous: 'existing-version',
    wrangler: args => {
      calls.push(args)
      return Promise.resolve(JSON.stringify([{ name: 'JWT_SECRET', type: 'secret_text' }]))
    },
    random: () => { throw new Error('must not generate a replacement signing key') },
  }
  return { options, calls }
}

Deno.test('redeploy preserves the Cloudflare signing key even when an environment key is set', async () => {
  const { options, calls } = fixture()
  assert.equal(await releaseJwtSecret({ ...options, secret: 'stale-key' }), undefined)
  assert.deepEqual(calls, [['secret', 'list', '--config', 'wrangler.jsonc', '--format', 'json']])
})

Deno.test('an existing worker without a secret signing key fails instead of rotating sessions', async () => {
  for (const bindings of [[], [{ name: 'JWT_SECRET', type: 'plain_text' }], [{ name: 'IMPORT_TOKEN', type: 'secret_text' }]]) {
    const { options } = fixture()
    options.wrangler = () => Promise.resolve(JSON.stringify(bindings))
    await assert.rejects(releaseJwtSecret({ ...options, secret: 'stale-key' }), {
      message: 'JWT_SECRET is not deployed for wrangler.jsonc; refusing to replace a signing key on an existing worker',
    })
  }
})

Deno.test('secret listing failures and malformed responses fail closed', async () => {
  for (const response of ['invalid JSON', '{}', '[{}]']) {
    const { options } = fixture()
    options.wrangler = () => Promise.resolve(response)
    await assert.rejects(releaseJwtSecret(options))
  }
  const { options } = fixture()
  options.wrangler = () => Promise.reject(new Error('Authentication failed'))
  await assert.rejects(releaseJwtSecret(options), { message: 'Authentication failed' })
})

Deno.test('a first deployment provisions an explicit or generated signing key', async () => {
  const { options, calls } = fixture()
  const first = { ...options, previous: null, random: () => 'generated-key' }
  assert.equal(await releaseJwtSecret({ ...first, secret: ' configured-key\n' }), 'configured-key')
  assert.equal(await releaseJwtSecret(first), 'generated-key')
  assert.equal(await releaseJwtSecret({ ...first, secret: ' ' }), 'generated-key')
  await assert.rejects(releaseJwtSecret({ ...first, random: () => '' }), { message: 'JWT_SECRET must not be empty' })
  assert.deepEqual(calls, [])
})
