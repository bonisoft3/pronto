type ImageObject = { etag: string; body: ReadableStream<Uint8Array> }
type ImageHead = { etag: string }
type ImagesEnvironment = {
  IMAGE_OBJECTS: { get(key: string): Promise<ImageObject | null>; head(key: string): Promise<ImageHead | null> }
  IMAGES: { input(body: ReadableStream<Uint8Array>): { transform(options: Record<string, never>): { output(options: { format: string }): Promise<{ response(options: { headers: HeadersInit }): Response }> } } }
  IMAGE_SOURCE_BUCKET: string
}

export async function edgeImage(req: Request, env: ImagesEnvironment, cache: Pick<Cache, 'match' | 'put'>, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response | null> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith('/img/')) return null
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  const prefix = `/img/insecure/plain/s3://${env.IMAGE_SOURCE_BUCKET}/`
  if (!url.pathname.startsWith(prefix) || url.search) return new Response(null, { status: 400 })
  let key: string
  try { key = decodeURIComponent(url.pathname.slice(prefix.length)) } catch { return new Response(null, { status: 400 }) }
  if (!key || key.split('/').some(part => !part || part === '.' || part === '..') || key.includes('\\')) return new Response(null, { status: 400 })
  const object = req.method === 'HEAD' ? await env.IMAGE_OBJECTS.head(key) : await env.IMAGE_OBJECTS.get(key)
  if (!object) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const etag = `"${object.etag.replaceAll('"', '')}-webp-v1"`
  const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600', ETag: etag }
  if ((req.headers.get('If-None-Match') ?? '').split(',').map(s => s.trim()).some(s => s === etag || s === '*')) {
    if (req.method === 'GET') await (object as ImageObject).body.cancel()
    return new Response(null, { status: 304, headers })
  }
  if (req.method === 'HEAD') return new Response(null, { headers })
  const cacheUrl = new URL(req.url)
  cacheUrl.searchParams.set('__image_etag', etag)
  const cacheKey = new Request(cacheUrl)
  const cached = await cache.match(cacheKey)
  if (cached) {
    await (object as ImageObject).body.cancel()
    return cached
  }
  const result = await env.IMAGES.input((object as ImageObject).body).transform({}).output({ format: 'image/webp' })
  const response = result.response({ headers: { 'Cache-Control': headers['Cache-Control'], ETag: etag } })
  if (response.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}
