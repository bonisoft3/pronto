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
  const res = await fetch(new URL(url, origin), { headers: url === '/' ? { accept: 'text/html' } : {} })
  const text = await res.text()
  if (!res.ok) throw new Error(`${new URL(url, origin)} answered ${res.status}`)
  return text
}

export async function releasedIceServers(read: Read): Promise<unknown> {
  const { document } = parseHTML(await read('/'))
  const map = document.getElementById('pronto-assets')?.textContent
  if (!map) throw new Error('the entry at / carries no import map')
  const url = (JSON.parse(map) as { imports: Record<string, string> }).imports['/shell/shell.json']
  if (!url) throw new Error('the entry\'s import map names no /shell/shell.json')
  const cfg = JSON.parse(await read(url)) as { iceServers?: unknown }
  if (!('iceServers' in cfg)) throw new Error(`${url} carries no iceServers`)
  return cfg.iceServers
}

/** Throws unless the release's terminal config carries exactly `expected`. */
export async function holdIceServers(read: Read, expected: unknown, where: string): Promise<void> {
  const carried = await releasedIceServers(read)
  if (JSON.stringify(carried) !== JSON.stringify(expected)) {
    throw new Error(`${where} carries ICE servers ${JSON.stringify(carried)}, not ${JSON.stringify(expected)}`)
  }
}
