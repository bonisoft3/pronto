import { strictEqual as assertEquals } from 'node:assert'
import { staticWorker } from './edge-static.ts'

const worker = staticWorker([])

Deno.test('static releases serve navigation and never cache missing assets', async () => {
  const served: Record<string, string> = { '/': 'home document', '/shell': 'shell', '/shell/_immutable-abc.js': 'asset' }
  const env = { ASSETS: { fetch: (req: Request) => Promise.resolve(new URL(req.url).pathname in served ? new Response(served[new URL(req.url).pathname]) : new Response('missing', { status: 404 })) } }
  const request = (path: string, accept = '*/*') => worker.fetch(new Request(`https://example.test${path}`, { headers: { accept } }), env)
  // The root may be a pre-rendered document; a route without its own file boots the shell, never the home page.
  assertEquals(await (await request('/lobby', 'text/html')).text(), 'shell')
  assertEquals(await (await request('/', 'text/html')).text(), 'home document')
  const missing = await request('/shell/missing.js', 'text/html')
  assertEquals(missing.status, 404)
  assertEquals(missing.headers.get('cache-control'), 'no-store')
  assertEquals((await request('/shell/_immutable-abc.js')).headers.get('cache-control'), 'public, max-age=31536000, immutable')
})
