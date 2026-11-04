import { strictEqual as assertEquals } from 'node:assert'
import worker from './edge-static.ts'

Deno.test('static releases serve navigation and never cache missing assets', async () => {
  const env = { ASSETS: { fetch: (req: Request) => Promise.resolve(new URL(req.url).pathname === '/' || new URL(req.url).pathname === '/shell/_immutable-abc.js' ? new Response('asset') : new Response('missing', { status: 404 })) } }
  const request = (path: string, accept = '*/*') => worker.fetch(new Request(`https://example.test${path}`, { headers: { accept } }), env)
  assertEquals(await (await request('/lobby', 'text/html')).text(), 'asset')
  const missing = await request('/shell/missing.js', 'text/html')
  assertEquals(missing.status, 404)
  assertEquals(missing.headers.get('cache-control'), 'no-store')
  assertEquals((await request('/shell/_immutable-abc.js')).headers.get('cache-control'), 'public, max-age=31536000, immutable')
})
