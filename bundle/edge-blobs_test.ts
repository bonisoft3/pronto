import assert from 'node:assert/strict'
import * as path from 'node:path'
import { blobFiles, writeEdgeBlobs } from './edge-blobs.ts'

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
  assert.equal(await writeEdgeBlobs(out, manifest, 'https://origin.test/bucket', fetcher), 2)
  assert.equal(await Deno.readTextFile(path.join(out, `blobs/mecha-objects/${sha.a}.glb`)), body.a)
  assert.equal(await Deno.readTextFile(path.join(out, `blobs/mecha-objects/${sha.b}.webp`)), body.b)
  assert.deepEqual(fetched.sort(), [`https://origin.test/bucket/${sha.a}.glb`, `https://origin.test/bucket/${sha.b}.webp`].sort())
})

Deno.test('a blob that does not hash to its manifest entry fails the release', async () => {
  const sha = await hex('expected')
  const fetcher = (async () => new Response('tampered')) as unknown as typeof fetch
  const out = await Deno.makeTempDir({ prefix: 'edge-blobs-' })
  await assert.rejects(writeEdgeBlobs(out, { file: `${sha}.glb`, sha256: sha }, 'https://origin.test', fetcher), /hashes to/)
})

Deno.test('a manifest file not named by its sha256 is refused', () => {
  assert.throws(() => blobFiles({ file: 'x.glb', sha256: 'abc' }), /not named by its sha256/)
})
