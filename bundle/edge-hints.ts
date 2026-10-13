import type { EdgeHints } from './edge-addresses.ts'

type Resolve = (cfg: EdgeHints, pathname: string, search: string, preferred: string[]) => { route: EdgeHints['routes'][number]; locale?: string } | null

export function edgeHints(req: Request, manifest: EdgeHints, resolve: Resolve, preferred: string[]): string {
  const url = new URL(req.url)
  const found = resolve(manifest, url.pathname, url.search, preferred)
  const hints = new Set(manifest.common)
  if (found) {
    for (const link of found.route.links) hints.add(link)
    if (found.locale && manifest.catalogues[found.locale]) hints.add(manifest.catalogues[found.locale])
  }
  const fallback = (manifest.i18n as { default?: string } | undefined)?.default
  if (fallback && manifest.catalogues[fallback]) hints.add(manifest.catalogues[fallback])
  return [...hints].join(', ')
}
