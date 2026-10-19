/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import * as path from 'node:path'
import { parseHTML } from 'npm:linkedom@0.18.4'

import { addressRelease, local, retainReleases } from '../../omnishell/server/release-addresses.ts'
export { separateAssetDirectories } from '../../omnishell/server/release-addresses.ts'

export interface EdgeHints {
  common: string[]
  catalogues: Record<string, string>
  routes: { path: string; paths?: Record<string, string>; access?: 'public' | 'private'; ssr?: 'spa' | 'ssg' | 'ssr'; links: string[]; screens: string[] }[]
  i18n?: unknown
  prefix?: string
}

/** Cloudflare's assets answer `.html` by their own routing rules, take cache
 * rules from `_headers`, and serve `/` from `index.html`; the Worker reads the
 * hints to send each route's preloads as early hints. */
export async function addressEdgeAssets(out: string, previous?: string): Promise<EdgeHints> {
  const release = await addressRelease(out, { htmlSuffix: '.txt' })
  const { imports, screens, cfg } = release
  await Deno.copyFile(path.join(out, 'shell/index.html'), path.join(out, 'index.html'))
  const directories = new Set(Object.values(imports).map(url => path.posix.dirname(url)))
  if (previous) for (const dir of await retainReleases(out, previous)) directories.add(dir)
  if (directories.size > 100) throw new Error('edge asset cache rules exceed Cloudflare’s 100-rule limit')
  await Deno.writeTextFile(path.join(out, '_headers'), [...directories].sort().map(dir => `${dir === '/' ? '' : dir}/_immutable-*\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n'))

  const link = (name: string, as: string) => {
    const url = imports[name]
    if (!url) throw new Error(`undeclared preload: ${name}`)
    return `<${url}>; rel=preload; as=${as}${as === 'fetch' ? '; crossorigin=anonymous' : ''}`
  }
  // Header modulepreloads can resolve dependencies before the map exists, so
  // the entry's stylesheets and fetch preloads are the hints all routes share.
  const { document } = parseHTML(await Deno.readTextFile(path.join(out, 'shell/index.html')))
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
