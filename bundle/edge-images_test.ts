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
    IMAGE_OBJECTS: {
      get: (key: string) => { calls.push(['get', key]); return Promise.resolve(key === 'snapcards/a.png' ? object() : null) },
      head: (key: string) => { calls.push(['head', key]); return Promise.resolve(key === 'snapcards/a.png' ? object() : null) },
    },
    IMAGES: { input: (body: ReadableStream<Uint8Array>) => { calls.push(['input', body]); return {
      transform: (options: Record<string, never>) => { calls.push(['transform', options]); return {
        output: (options: { format: string }) => { calls.push(['output', options]); return Promise.resolve({ response: ({ headers }: { headers: HeadersInit }) => new Response('webp', { headers: { ...Object.fromEntries(new Headers(headers)), 'content-type': 'image/webp' } }) }) },
      } },
    } } },
  }
  const run = (request: Request) => edgeImage(request, env, cache, ctx)
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
    '/img/insecure/plain/s3://original-bucket/snapcards/a.png?width=10',
    '/img/insecure/plain/s3://original-bucket/snapcards/%2e%2e%2fa.png',
  ]) assertEquals((await run(new Request(`https://example.test${path}`)))!.status, 400)
  assertEquals((await run(new Request(url, { method: 'POST' })))!.status, 405)
  assertEquals((await run(new Request(url.replace('a.png', 'missing.png'))))!.status, 404)
  assertEquals(await run(new Request('https://example.test/cards')), null)
})
