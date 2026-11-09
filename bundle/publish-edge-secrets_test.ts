import assert from 'node:assert/strict'
import { keptJwtSecrets, validateJwtMode } from './publish-edge-secrets.ts'

Deno.test('kept JWT preflight only lists the auth Worker and rotates only the import token', async () => {
  for (const config of ['/release/wrangler.jsonc', '/release/database.jsonc']) {
    const commands: string[][] = []
    const secrets = await keptJwtSecrets(config, 'new-import-token', async (args) => {
      commands.push(args)
      return JSON.stringify([{ name: 'JWT_SECRET', type: 'secret_text' }, { name: 'IMPORT_TOKEN', type: 'secret_text' }])
    })
    assert.deepEqual(commands, [['secret', 'list', '--config', config]])
    assert.deepEqual(secrets, { IMPORT_TOKEN: 'new-import-token' })
    assert.equal(Object.hasOwn(secrets, 'JWT_SECRET'), false)
  }
})

Deno.test('kept JWT preflight refuses absent, mismatched and unreadable bindings', async () => {
  for (const listing of [[], [{ name: 'OTHER', type: 'secret_text' }], [{ name: 'JWT_SECRET', type: 'plain_text' }], [{ name: 'JWT_SECRET' }]]) {
    await assert.rejects(() => keptJwtSecrets('/release/database.jsonc', 'token', async () => JSON.stringify(listing)), /existing JWT_SECRET secret_text binding/)
  }
  await assert.rejects(() => keptJwtSecrets('/release/database.jsonc', 'token', async () => '{}'), /no secret list/)
  await assert.rejects(() => keptJwtSecrets('/release/database.jsonc', 'token', async () => { throw new Error('secret listing failed') }), /secret listing failed/)
})

Deno.test('kept JWT mode cannot reset data or deploy a temporary Worker', () => {
  validateJwtMode(true, false, false)
  validateJwtMode(false, true, true)
  assert.throws(() => validateJwtMode(true, true, false), /cannot be combined/)
  assert.throws(() => validateJwtMode(true, false, true), /cannot be combined/)
})
