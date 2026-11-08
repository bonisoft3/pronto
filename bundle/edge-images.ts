type ImageObject = { etag: string; body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string } }
type ImageHead = { etag: string; httpMetadata?: { contentType?: string } }
type ImageFit = { width: number; height: number; fit: 'scale-down' }
type ImagesEnvironment = {
  BLOB_OBJECTS: { get(key: string): Promise<ImageObject | null>; head(key: string): Promise<ImageHead | null> }
  IMAGES?: { input(body: ReadableStream<Uint8Array>): { transform(options: ImageFit | Record<string, never>): { output(options: { format: string }): Promise<{ response(options: { headers: HeadersInit }): Response }> } } }
  IMAGE_SOURCE_BUCKET?: string
}

// widths are the ones the terminal's data-image-src offers (omnishell's fragment.js). Each size of
// each picture is a paid transformation, so no others are answered.
export async function edgeImage(req: Request, env: ImagesEnvironment, cache: Pick<Cache, 'match' | 'put'>, ctx: { waitUntil(promise: Promise<unknown>): void }, widths: readonly number[]): Promise<Response | null> {
  const url = new URL(req.url)
  const raw = url.pathname.startsWith('/blobs/mecha-objects/')
  if (!raw && (!url.pathname.startsWith('/img/') || env.IMAGES === undefined)) return null
  // A claimed write is the cluster's route (mecha-edge's worker.ts).
  if (raw && req.method === 'PUT') return null
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  const sized = /^\/img\/insecure\/rs:fit:(\d+):\1\/plain\//.exec(url.pathname)
  const width = sized ? Number(sized[1]) : undefined
  if (width !== undefined && !widths.includes(width)) return new Response(null, { status: 400 })
  // Rows name the plane by its logical name on every target; a bucket a row
  // written before that still spells is the same objects.
  const transform = `/img/insecure/${width === undefined ? '' : `rs:fit:${width}:${width}/`}plain/s3://`
  const prefix = raw
    ? '/blobs/mecha-objects/'
    : ['mecha-objects', env.IMAGE_SOURCE_BUCKET].filter(Boolean).map((b) => `${transform}${b}/`).find((p) => url.pathname.startsWith(p))
  if (prefix === undefined || url.search) return new Response(null, { status: 400 })
  let key: string
  try { key = decodeURIComponent(url.pathname.slice(prefix.length)) } catch { return new Response(null, { status: 400 }) }
  if (!key || key.split('/').some(part => !part || part === '.' || part === '..') || key.includes('\\')) return new Response(null, { status: 400 })
  const object = req.method === 'HEAD' ? await env.BLOB_OBJECTS.head(key) : await env.BLOB_OBJECTS.get(key)
  if (!object) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const etag = `"${object.etag.replaceAll('"', '')}${width === undefined ? '' : `-w${width}`}-webp-v1"`
  // A stored object can claim any type, and on this origin an SVG's or an HTML file's script would run.
  const headers: Record<string, string> = raw
    ? { 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', ETag: `"${object.etag.replaceAll('"', '')}"` }
    : { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600', ETag: etag }
  if ((req.headers.get('If-None-Match') ?? '').split(',').map(s => s.trim()).some(s => s === headers.ETag || s === '*')) {
    if (req.method === 'GET') await (object as ImageObject).body.cancel()
    return new Response(null, { status: 304, headers })
  }
  if (req.method === 'HEAD') return new Response(null, { headers })
  if (raw) return new Response((object as ImageObject).body, { headers })
  const cacheUrl = new URL(req.url)
  cacheUrl.searchParams.set('__image_etag', etag)
  const cacheKey = new Request(cacheUrl)
  const cached = await cache.match(cacheKey)
  if (cached) {
    await (object as ImageObject).body.cancel()
    return cached
  }
  const result = await env.IMAGES!.input((object as ImageObject).body).transform(width === undefined ? {} : { width, height: width, fit: 'scale-down' }).output({ format: 'image/webp' })
  const response = result.response({ headers: { 'Cache-Control': headers['Cache-Control'], ETag: etag } })
  if (response.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}
