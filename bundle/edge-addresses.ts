/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseHTML } from 'npm:linkedom@0.18.4'

/** What this reads of omnishell's release addressing (server/release-addresses.ts). */
interface Release {
  imports: Record<string, string>
  screens: Record<string, string[]>
  cfg: {
    routes: { path: string; screen?: string; paths?: Record<string, string>; access?: 'public' | 'private'; ssr?: 'spa' | 'ssg' | 'ssr'; files: Record<string, string | string[]> }[]
    i18n?: { locales?: Record<string, unknown> }
    prefix?: string
    presenter?: { policy: string }
  }
}
/** An RTCIceServer, as omnishell's release addressing writes it. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}
export interface Addresses {
  local: (value: string, base: string) => string | null
  addressRelease: (out: string, options?: { htmlSuffix?: string; iceServers?: IceServer[] }) => Promise<Release>
  parseIceServers: (text: string) => IceServer[]
  retainReleases: (out: string, previous: string) => Promise<Set<string>>
  separateAssetDirectories: (out: string, previous: string) => void
}

/** omnishell's release addressing, loaded from where the app's mise puts the
 * interpreter (edge.ts's --omnishell): an installed pronto has no sibling tree
 * to import it from. */
export function releaseAddresses(omnishell: string): Promise<Addresses> {
  return import(pathToFileURL(path.join(omnishell, 'server/release-addresses.ts')).href)
}

export interface EdgeHints {
  common: string[]
  catalogues: Record<string, string>
  routes: { path: string; paths?: Record<string, string>; access?: 'public' | 'private'; ssr?: 'spa' | 'ssg' | 'ssr'; links: string[]; screens: string[] }[]
  i18n?: unknown
  prefix?: string
}

/** Cloudflare's assets answer `.html` by their own routing rules, take cache
 * rules from `_headers`, and serve `/` from `index.html`; the Worker reads the
 * hints to send each route's preloads as early hints. The terminal config
 * carries the target's ICE servers. */
export async function addressEdgeAssets(addresses: Addresses, out: string, { previous, iceServers }: { previous?: string; iceServers: IceServer[] }): Promise<EdgeHints> {
  const { addressRelease, local, retainReleases } = addresses
  const release = await addressRelease(out, { htmlSuffix: '.txt', iceServers })
  const { imports, screens, cfg } = release
  await Deno.copyFile(path.join(out, 'shell/index.html'), path.join(out, 'index.html'))
  if (previous) await retainReleases(out, previous)
  // The document's policy as a header too, as the container door sends it:
  // the Worker answers every navigation with `/`, so the rule covers them all.
  const { document } = parseHTML(await Deno.readTextFile(path.join(out, 'shell/index.html')))
  const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')
  if (!policy) throw new Error('the document carries no Content-Security-Policy')
  // A presenter's worker takes its policy from its script's own response.
  // Cache-Control headers are omitted here because Cloudflare's _headers applies
  // to 404 responses unconditionally; immutable caching is attached on 200 responses
  // only by the worker.
  await Deno.writeTextFile(path.join(out, '_headers'), [
    `/\n  Content-Security-Policy: ${policy}\n`,
    ...(cfg.presenter ? [`/omnishell/interpreter/presenter.js\n  Content-Security-Policy: ${cfg.presenter.policy}\n`] : []),
  ].join('\n'))

  const link = (name: string, as: string) => {
    const url = imports[name]
    if (!url) throw new Error(`undeclared preload: ${name}`)
    return `<${url}>; rel=preload; as=${as}${as === 'fetch' ? '; crossorigin=anonymous' : ''}`
  }
  // Header modulepreloads can resolve dependencies before the map exists, so
  // the entry's stylesheets and fetch preloads are the hints all routes share.
  const common = new Set<string>()
  for (const node of document.querySelectorAll('link[rel="stylesheet"][href], link[rel="preload"][href]')) {
    const href = node.getAttribute('href')!
    if (!Object.values(imports).includes(href)) continue
    const as = node.getAttribute('rel') === 'stylesheet' ? 'style' : node.getAttribute('as')!
    common.add(`<${href}>; rel=preload; as=${as}${as === 'fetch' ? '; crossorigin=anonymous' : ''}`)
  }
  const routes = cfg.routes.map(route => {
    const name = route.screen ?? path.posix.basename(String(route.files.html), '.html')
    const links = new Set<string>()
    for (const [kind, value] of Object.entries(route.files)) {
      for (const file of typeof value === 'string' ? [value] : value) links.add(link(local(file, '/')!, kind === 'shared' ? 'style' : 'fetch'))
    }
    return {
      path: route.path,
      ...(route.paths ? { paths: route.paths } : {}),
      ...(route.access ? { access: route.access } : {}),
      ...(route.ssr ? { ssr: route.ssr } : {}),
      links: [...links],
      screens: screens[name] ?? [],
    }
  })
  const catalogues = Object.fromEntries(Object.keys(cfg.i18n?.locales ?? {}).map(tag => [tag, link(`/messages/${tag}.json`, 'fetch')]))
  return { common: [...common], routes, catalogues, i18n: cfg.i18n, prefix: cfg.prefix }
}

/** Routing rules for Cloudflare Workers Assets run_worker_first: dynamic routes
 * and asset requests run the Worker first, so immutable assets attach
 * Cache-Control: public, max-age=31536000, immutable strictly on 200 responses,
 * while 404 responses are served with Cache-Control: no-store. */
export async function edgeRoutingRules(_publicDir: string): Promise<string[]> {
  return ['/*']
}

