import * as path from 'node:path'
import { encodeBase64 } from '@std/encoding/base64'

/** Every { file, sha256 } a manifest names, however deeply nested, once each. */
export function blobFiles(manifest: unknown): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node === null || typeof node !== 'object') return
    const { file, sha256 } = node as { file?: unknown; sha256?: unknown }
    if (typeof file === 'string' && typeof sha256 === 'string') {
      if (file !== `${sha256}${file.slice(file.indexOf('.'))}`) throw new Error(`seed assets: ${file} is not named by its sha256`)
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

/** An app's seed assets as the edge's static files, `<publicDir>/seed-assets/<file>`,
 * each fetched from the origin and refused unless it hashes to the manifest's
 * sha256. */
export async function writeEdgeAssets(publicDir: string, manifest: unknown, origin: string, fetcher: typeof fetch = fetch): Promise<number> {
  const dir = path.join(publicDir, 'seed-assets')
  await Deno.mkdir(dir, { recursive: true })
  const pending = [...blobFiles(manifest)]
  const total = pending.length
  const worker = async () => {
    for (let next = pending.pop(); next; next = pending.pop()) {
      const [file, sha256] = next
      const got = await fetcher(`${origin}/${file}`)
      if (!got.ok) throw new Error(`seed assets: GET ${origin}/${file} → ${got.status}`)
      const bytes = new Uint8Array(await got.arrayBuffer())
      const actual = await sha256Hex(bytes)
      if (actual !== sha256) throw new Error(`seed assets: ${file} hashes to ${actual}`)
      await Deno.writeFile(path.join(dir, file), bytes)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return total
}

/** Content-addressed blobs never change under their name. */
export const ASSET_CACHE_RULE = '/seed-assets/*\n  Cache-Control: public, max-age=31536000, immutable\n'

const SEED_URL = /\/(?:img\/insecure\/plain\/s3:\/\/mecha-objects|blobs\/mecha-objects)\/seed\/([0-9a-f]{64}\.[a-z0-9]+)/g
export const SEED_TYPES: Record<string, string> = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' }

/** The seed blobs a directory holds, each refused unless its name is its hash. */
async function seedBlobEntries(dir: string): Promise<{ file: string; type: string; bytes: Uint8Array<ArrayBuffer> }[]> {
  const entries = []
  for await (const e of Deno.readDir(dir)) {
    const type = SEED_TYPES[path.extname(e.name)]
    if (!e.isFile || !type) throw new Error(`seed blobs: ${e.name} is not a picture`)
    const bytes = await Deno.readFile(path.join(dir, e.name))
    const actual = await sha256Hex(bytes)
    if (`${actual}${path.extname(e.name)}` !== e.name) throw new Error(`seed blobs: ${e.name} hashes to ${actual}`)
    entries.push({ file: e.name, type, bytes })
  }
  return entries
}

/** The seed blobs copied where a publish finds them, checked. */
export async function seedBlobFiles(dir: string, out: string): Promise<number> {
  await Deno.mkdir(out, { recursive: true })
  const entries = await seedBlobEntries(dir)
  for (const { file, bytes } of entries) await Deno.writeFile(path.join(out, file), bytes)
  return entries.length
}

/** Rewrites every seed object's URL to its bytes, for a target with no blob storage. */
export async function seedBlobInliner(dir: string): Promise<(sql: string) => string> {
  const data = new Map((await seedBlobEntries(dir)).map(({ file, type, bytes }) => [file, `data:${type};base64,${encodeBase64(bytes)}`]))
  return (sql) => sql.replace(SEED_URL, (_, file: string) => {
    const bytes = data.get(file)
    if (!bytes) throw new Error(`seed blobs: a row names ${file}, which is not in ${dir}`)
    return bytes
  })
}
