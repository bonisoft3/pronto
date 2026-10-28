/// <reference lib="dom" />
// The ICE servers an edge release's terminal config carries, read as a page
// reads them: the entry served at `/` maps shell.json to its address, and the
// config there holds the list (distribution's #IceServers). edge.ts holds its
// build to the target's list, publish-edge.ts the deployment to the build.
import * as path from 'node:path'
import { parseHTML } from 'npm:linkedom@0.18.4'

/** Answers a path of the release as text, or throws. */
export type Read = (url: string) => Promise<string>

/** A built release's `public/`, read off disk. */
export const builtRelease = (publicDir: string): Read => (url) =>
  Deno.readTextFile(path.join(publicDir, url === '/' ? 'index.html' : decodeURIComponent(url)))

/** A deployed release, read through its origin. */
export const deployedRelease = (origin: string): Read => async (url) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(new URL(url, origin), { headers: url === '/' ? { accept: 'text/html' } : {} })
    const text = await res.text()
    if (res.ok) return text
    if (![404, 502, 503, 504].includes(res.status) || attempt === 11) {
      throw new Error(`${new URL(url, origin)} answered ${res.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 5000)))
  }
}

export async function releasedIceServers(read: Read): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const html = await read('/')
    const { document } = parseHTML(html)
    const map = (document.getElementById('pronto-assets') ?? document.querySelector('#pronto-assets, script[type="importmap"]'))?.textContent
      ?? /<script\b[^>]*\bid="pronto-assets"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
    if (map) {
      const url = (JSON.parse(map) as { imports: Record<string, string> }).imports['/shell/shell.json']
      if (!url) throw new Error('the entry\'s import map names no /shell/shell.json')
      const cfg = JSON.parse(await read(url)) as { iceServers?: unknown }
      return cfg.iceServers ?? null
    }
    if (attempt >= 20) throw new Error('the entry at / carries no import map')
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
  }
}

/** Throws unless the release's terminal config carries exactly `expected`. */
export async function holdIceServers(read: Read, expected: unknown, where: string): Promise<void> {
  const carried = await releasedIceServers(read)
  if (JSON.stringify(carried) !== JSON.stringify(expected)) {
    throw new Error(`${where} carries ICE servers ${JSON.stringify(carried)}, not ${JSON.stringify(expected)}`)
  }
}
