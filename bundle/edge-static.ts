export default {
  async fetch(req: Request, env: { ASSETS: { fetch(req: Request): Promise<Response> } }): Promise<Response> {
    const path = new URL(req.url).pathname
    const res = await env.ASSETS.fetch(req)
    if (res.status === 200 && (path.startsWith('/_immutable-') || path.includes('/_immutable-'))) {
      const result = new Response(req.method === 'HEAD' ? null : res.body, res)
      result.headers.set('cache-control', 'public, max-age=31536000, immutable')
      return result
    }
    if (res.status !== 404) return res
    const navigation = (req.method === 'GET' || req.method === 'HEAD') &&
      (req.headers.get('sec-fetch-mode') === 'navigate' || (req.headers.get('accept') ?? '').includes('text/html'))
    if (navigation && !['/_immutable-', '/shell/', '/omnishell/', '/messages/'].some(prefix => path.startsWith(prefix))) {
      return env.ASSETS.fetch(new Request(new URL('/', req.url), req))
    }
    const result = new Response(req.method === 'HEAD' ? null : res.body, res)
    result.headers.set('cache-control', 'no-store')
    return result
  },
}
