import { assertEquals } from 'jsr:@std/assert@1.0.13'
import { edgeImage } from './edge-images.ts'

Deno.test('edge image reads only its configured bucket and transforms its R2 object', async () => {
  const calls: unknown[] = []
  let etag = 'abc'
  const object = () => ({ etag, body: new Blob(['png']).stream() })
  const entries = new Map<string, Response>()
  const cache = {
    match: (key: Request) => Promise.resolve(entries.get(key.url)?.clone()),
    put: (key: Request, response: Response) => { entries.set(key.url, response); return Promise.resolve() },
  } as Pick<Cache, 'match' | 'put'>
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }
  const env = {
    IMAGE_SOURCE_BUCKET: 'original-bucket',
    BLOB_OBJECTS: {
      get: (key: string) => { calls.push(['get', key]); return Promise.resolve(key === 'snapcards/a.png' ? object() : null) },
      head: (key: string) => { calls.push(['head', key]); return Promise.resolve(key === 'snapcards/a.png' ? object() : null) },
    },
    IMAGES: { input: (body: ReadableStream<Uint8Array>) => { calls.push(['input', body]); return {
      transform: (options: unknown) => { calls.push(['transform', options]); return {
        output: (options: { format: string }) => { calls.push(['output', options]); return Promise.resolve({ response: ({ headers }: { headers: HeadersInit }) => new Response('webp', { headers: { ...Object.fromEntries(new Headers(headers)), 'content-type': 'image/webp' } }) }) },
      } },
    } } },
  }
  const run = (request: Request) => edgeImage(request, env, cache, ctx, [320, 640, 960])
  const url = 'https://example.test/img/insecure/plain/s3://original-bucket/snapcards/a.png'
  const response = (await run(new Request(url)))!
  assertEquals(await response.text(), 'webp')
  assertEquals(response.headers.get('content-type'), 'image/webp')
  assertEquals(response.headers.get('etag'), '"abc-webp-v1"')
  assertEquals(calls.map(c => (c as unknown[])[0]), ['get', 'input', 'transform', 'output'])
  await Promise.all(pending)
  assertEquals(await (await run(new Request(url)))!.text(), 'webp')
  assertEquals(calls.filter(c => (c as unknown[])[0] === 'output').length, 1)
  etag = 'new'
  await run(new Request(url))
  assertEquals(calls.filter(c => (c as unknown[])[0] === 'output').length, 2)
  etag = 'abc'
  const head = (await run(new Request(url, { method: 'HEAD' })))!
  assertEquals(head.status, 200)
  assertEquals(head.headers.get('etag'), response.headers.get('etag'))
  assertEquals(await head.text(), '')
  const notModified = (await run(new Request(url, { headers: { 'If-None-Match': '"abc-webp-v1"' } })))!
  assertEquals(notModified.status, 304)
  for (const path of [
    '/img/insecure/plain/s3://other/snapcards/a.png',
    '/img/insecure/rs:fill:10:10/plain/s3://original-bucket/snapcards/a.png',
    // An open size would let any caller spend a paid transformation per number.
    '/img/insecure/rs:fit:500:500/plain/s3://original-bucket/snapcards/a.png',
    '/img/insecure/rs:fit:640:320/plain/s3://original-bucket/snapcards/a.png',
    '/img/insecure/rs:fit:640:640/plain/s3://other/snapcards/a.png',
    '/img/insecure/plain/s3://original-bucket/snapcards/a.png?width=10',
    '/img/insecure/plain/s3://original-bucket/snapcards/%2e%2e%2fa.png',
  ]) assertEquals((await run(new Request(`https://example.test${path}`)))!.status, 400)
  assertEquals((await run(new Request(url, { method: 'POST' })))!.status, 405)
  assertEquals((await run(new Request(url.replace('a.png', 'missing.png'))))!.status, 404)
  assertEquals(await run(new Request('https://example.test/cards')), null)
})

// A row names the plane the same on every target, and one written earlier still reads.
Deno.test('edge image answers the logical bucket, an older bucket name, and raw blobs without an image service', async () => {
  const object = () => ({ etag: 'abc', body: new Blob(['png']).stream(), httpMetadata: { contentType: 'image/webp' } })
  const storage = { get: (key: string) => Promise.resolve(key === 'seed/a.webp' ? object() : null), head: (key: string) => Promise.resolve(key === 'seed/a.webp' ? object() : null) }
  const images = { input: () => ({ transform: () => ({ output: () => Promise.resolve({ response: ({ headers }: { headers: Record<string, string> }) => new Response('webp', { headers }) }) }) }) }
  const cache = { match: () => Promise.resolve(undefined), put: () => Promise.resolve() } as unknown as Pick<Cache, 'match' | 'put'>
  const ctx = { waitUntil: () => {} }
  const widths = [320, 640, 960]
  const full = { IMAGE_SOURCE_BUCKET: 'old', BLOB_OBJECTS: storage, IMAGES: images }
  const at = (p: string, env: Parameters<typeof edgeImage>[1]) => edgeImage(new Request(`https://example.test${p}`), env, cache, ctx, widths)
  assertEquals((await at('/img/insecure/plain/s3://mecha-objects/seed/a.webp', full))!.status, 200)
  assertEquals((await at('/img/insecure/rs:fit:320:320/plain/s3://mecha-objects/seed/a.webp', full))!.status, 200)
  assertEquals((await at('/img/insecure/plain/s3://old/seed/a.webp', full))!.status, 200)
  assertEquals((await at('/img/insecure/plain/s3://other/seed/a.webp', full))!.status, 400)
  const bare = { BLOB_OBJECTS: storage }
  const raw = (await at('/blobs/mecha-objects/seed/a.webp', bare))!
  assertEquals([raw.status, raw.headers.get('Content-Type'), raw.headers.get('X-Content-Type-Options')], [200, 'image/webp', 'nosniff'])
  assertEquals(raw.headers.get('Content-Security-Policy'), 'sandbox')
  assertEquals((await at('/blobs/mecha-objects/seed/missing.webp', bare))!.status, 404)
  assertEquals(await at('/img/insecure/plain/s3://mecha-objects/seed/a.webp', bare), null)
})

Deno.test('edge image fits a sized request and caches each size apart', async () => {
  const fits: unknown[] = []
  const entries = new Map<string, Response>()
  const cache = {
    match: (key: Request) => Promise.resolve(entries.get(key.url)?.clone()),
    put: (key: Request, response: Response) => { entries.set(key.url, response); return Promise.resolve() },
  } as Pick<Cache, 'match' | 'put'>
  const pending: Promise<unknown>[] = []
  const env = {
    IMAGE_SOURCE_BUCKET: 'original-bucket',
    BLOB_OBJECTS: {
      get: () => Promise.resolve({ etag: 'abc', body: new Blob(['png']).stream() }),
      head: () => Promise.resolve({ etag: 'abc' }),
    },
    IMAGES: { input: () => ({ transform: (options: unknown) => { fits.push(options); return {
      output: () => Promise.resolve({ response: ({ headers }: { headers: Record<string, string> }) => new Response('webp', { headers }) }),
    } } }) },
  }
  const run = (path: string) => edgeImage(new Request(`https://example.test${path}`), env, cache, { waitUntil: (p) => { pending.push(p) } }, [320, 640, 960])
  const sized = await run('/img/insecure/rs:fit:640:640/plain/s3://original-bucket/snapcards/a.png')
  assertEquals(sized!.headers.get('ETag'), '"abc-w640-webp-v1"')
  await run('/img/insecure/plain/s3://original-bucket/snapcards/a.png')
  await Promise.all(pending)
  await run('/img/insecure/rs:fit:640:640/plain/s3://original-bucket/snapcards/a.png')
  assertEquals(fits, [{ width: 640, height: 640, fit: 'scale-down' }, {}])
})
