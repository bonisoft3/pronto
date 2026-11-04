import assert from 'node:assert/strict'
import { releaseJwtSecret } from './edge-jwt.ts'

async function fixture(run: (options: Parameters<typeof releaseJwtSecret>[0], calls: string[][]) => Promise<void>) {
  const directory = await Deno.makeTempDir({ prefix: 'edge-jwt-' })
  const calls: string[][] = []
  try {
    await run({
      secretPath: `${directory}/.jwt-secret`, ci: true, temporary: false,
      configs: ['database.jsonc', 'wrangler.jsonc'],
      wrangler: args => {
        calls.push(args)
        return Promise.resolve(JSON.stringify([{ name: 'JWT_SECRET', type: 'secret_text' }]))
      },
      random: () => { throw new Error('CI must never generate a signing key') },
    }, calls)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
}

Deno.test('CI preserves existing signing keys on every worker without exporting or writing them', () => fixture(async (options, calls) => {
  assert.equal(await releaseJwtSecret(options), undefined)
  assert.deepEqual(calls, options.configs.map(config => ['secret', 'list', '--config', config, '--format', 'json']))
  await assert.rejects(Deno.stat(options.secretPath), Deno.errors.NotFound)
}))

Deno.test('CI refuses a missing or non-secret JWT binding on either worker', async () => {
  for (const missing of ['database.jsonc', 'wrangler.jsonc']) {
    for (const binding of [[], [{ name: 'JWT_SECRET', type: 'plain_text' }], [{ name: 'IMPORT_TOKEN', type: 'secret_text' }]]) {
      await fixture(async options => {
        const list = options.wrangler
        options.wrangler = args => args[3] === missing ? Promise.resolve(JSON.stringify(binding)) : list(args)
        await assert.rejects(releaseJwtSecret(options), { message: `JWT_SECRET is not deployed for ${missing}; configure secrets.JWT_SECRET for the first CI release` })
      })
    }
  }
})

Deno.test('CI fails closed on an absent worker, API errors, or malformed secret lists', async () => {
  for (const error of ['Worker not found', 'Authentication failed']) {
    await fixture(async options => {
      options.wrangler = () => Promise.reject(new Error(error))
      await assert.rejects(releaseJwtSecret(options), { message: error })
    })
  }
  await fixture(async options => {
    options.wrangler = () => Promise.resolve('invalid JSON')
    await assert.rejects(releaseJwtSecret(options), SyntaxError)
  })
})

Deno.test('explicit environment and local secrets retain precedence over deployed keys', () => fixture(async (options, calls) => {
  await Deno.writeTextFile(options.secretPath, ' local-key\n')
  assert.equal(await releaseJwtSecret({ ...options, secret: ' environment-key\n' }), 'environment-key')
  assert.equal(await releaseJwtSecret({ ...options, secret: ' ' }), 'local-key')
  assert.deepEqual(calls, [])
  await Deno.writeTextFile(options.secretPath, '\n')
  await assert.rejects(releaseJwtSecret(options), { message: 'JWT secret is empty' })
  assert.deepEqual(calls, [])
}))

Deno.test('only local first releases generate a persisted signing key', () => fixture(async (options, calls) => {
  assert.equal(await releaseJwtSecret({ ...options, ci: false, random: () => 'generated-key' }), 'generated-key')
  assert.equal(await Deno.readTextFile(options.secretPath), 'generated-key')
  if (Deno.build.os !== 'windows') assert.equal((await Deno.stat(options.secretPath)).mode! & 0o777, 0o600)
  assert.deepEqual(calls, [])
}))

Deno.test('temporary CI releases require an explicit key and cannot inherit another worker', () => fixture(async (options, calls) => {
  await assert.rejects(releaseJwtSecret({ ...options, temporary: true }), { message: 'JWT_SECRET must be configured for the first CI release' })
  await assert.rejects(releaseJwtSecret({ ...options, configs: [] }), { message: 'JWT_SECRET must be configured for the first CI release' })
  assert.equal(await releaseJwtSecret({ ...options, temporary: true, secret: 'configured-key' }), 'configured-key')
  assert.deepEqual(calls, [])
}))
