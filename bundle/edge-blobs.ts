import * as path from 'node:path'

/** Every { file, sha256 } a manifest names, however deeply nested, once each. */
export function blobFiles(manifest: unknown): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node === null || typeof node !== 'object') return
    const { file, sha256 } = node as { file?: unknown; sha256?: unknown }
    if (typeof file === 'string' && typeof sha256 === 'string') {
      if (file !== `${sha256}${file.slice(file.indexOf('.'))}`) throw new Error(`blob seed: ${file} is not named by its sha256`)
      files.set(file, sha256)
    }
    Object.values(node).forEach(walk)
  }
  walk(manifest)
  return files
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The blob seed as the edge's static assets, where the blob plane's URLs
 * point: `<publicDir>/blobs/mecha-objects/<file>`, each file fetched from the
 * origin and refused unless it hashes to the manifest's sha256. */
export async function writeEdgeBlobs(publicDir: string, manifest: unknown, origin: string, fetcher: typeof fetch = fetch): Promise<number> {
  const dir = path.join(publicDir, 'blobs/mecha-objects')
  await Deno.mkdir(dir, { recursive: true })
  const pending = [...blobFiles(manifest)]
  const total = pending.length
  const worker = async () => {
    for (let next = pending.pop(); next; next = pending.pop()) {
      const [file, sha256] = next
      const got = await fetcher(`${origin}/${file}`)
      if (!got.ok) throw new Error(`blob seed: GET ${origin}/${file} → ${got.status}`)
      const bytes = new Uint8Array(await got.arrayBuffer())
      const actual = await sha256Hex(bytes)
      if (actual !== sha256) throw new Error(`blob seed: ${file} hashes to ${actual}`)
      await Deno.writeFile(path.join(dir, file), bytes)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return total
}

/** Content-addressed blobs never change under their name. */
export const BLOB_CACHE_RULE = '/blobs/*\n  Cache-Control: public, max-age=31536000, immutable\n'
