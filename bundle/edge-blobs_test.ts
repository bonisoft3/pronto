import assert from 'node:assert/strict'
import * as path from 'node:path'
import { blobFiles, seedBlobInliner, seedBlobFiles, writeEdgeAssets } from './edge-blobs.ts'

const hex = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('')

// The edge Worker routed only /crud, /auth and /electric: an app whose art
// lives on the blob plane deployed with no art at all. A declared blob seed
// now ships as the edge's static assets at the URLs the plane serves.
Deno.test('a blob seed lands where the blob plane serves it, verified by its sha256', async () => {
  const body = { a: 'model bytes', b: 'texture bytes' }
  const sha = { a: await hex(body.a), b: await hex(body.b) }
  const manifest = { entries: { 'model/x': { file: `${sha.a}.glb`, sha256: sha.a }, nested: [{ texture: { file: `${sha.b}.webp`, sha256: sha.b } }] } }
  const fetched: string[] = []
  const fetcher = (async (url: string) => {
    fetched.push(url)
    const name = url.split('/').pop()!
    return new Response(name.startsWith(sha.a) ? body.a : body.b)
  }) as unknown as typeof fetch
  const out = await Deno.makeTempDir({ prefix: 'edge-blobs-' })
  assert.equal(await writeEdgeAssets(out, manifest, 'https://origin.test/bucket', fetcher), 2)
  assert.equal(await Deno.readTextFile(path.join(out, `seed-assets/${sha.a}.glb`)), body.a)
  assert.equal(await Deno.readTextFile(path.join(out, `seed-assets/${sha.b}.webp`)), body.b)
  assert.deepEqual(fetched.sort(), [`https://origin.test/bucket/${sha.a}.glb`, `https://origin.test/bucket/${sha.b}.webp`].sort())
})

Deno.test('a blob that does not hash to its manifest entry fails the release', async () => {
  const sha = await hex('expected')
  const fetcher = (async () => new Response('tampered')) as unknown as typeof fetch
  const out = await Deno.makeTempDir({ prefix: 'edge-blobs-' })
  await assert.rejects(writeEdgeAssets(out, { file: `${sha}.glb`, sha256: sha }, 'https://origin.test', fetcher), /hashes to/)
})

Deno.test('a manifest file not named by its sha256 is refused', () => {
  assert.throws(() => blobFiles({ file: 'x.glb', sha256: 'abc' }), /not named by its sha256/)
})

// A file not named by its bytes would keep serving under a name a row already holds.
Deno.test('seed blobs are checked against their names, and inlined where there is no storage', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'seed-blobs-' })
  const bytes = new TextEncoder().encode('picture')
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
  await Deno.writeFile(path.join(dir, `${sha}.webp`), bytes)
  const out = await Deno.makeTempDir({ prefix: 'seed-out-' })
  assert.equal(await seedBlobFiles(dir, out), 1)
  assert.deepEqual(await Deno.readFile(path.join(out, `${sha}.webp`)), bytes)
  const inlined = (await seedBlobInliner(dir))(`back = '/img/insecure/plain/s3://mecha-objects/seed/${sha}.webp', other = '/img/insecure/plain/s3://mecha-objects/effects/a.png'`)
  assert.equal(inlined, `back = 'data:image/webp;base64,cGljdHVyZQ==', other = '/img/insecure/plain/s3://mecha-objects/effects/a.png'`)
  assert.equal((await seedBlobInliner(dir))(`/blobs/mecha-objects/seed/${sha}.webp`), 'data:image/webp;base64,cGljdHVyZQ==')
  await Deno.writeFile(path.join(dir, `${'0'.repeat(64)}.webp`), bytes)
  await assert.rejects(seedBlobFiles(dir, out), /hashes to/)
})
