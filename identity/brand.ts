// App brand extraction and sanitization: releases read DESIGN.md tokens,
// display name, and same-origin icon to register with Hydra DCR; the broker
// re-validates any client brand before applying it to auth screens.
export const PALETTE_KEYS = [
  'primary',
  'secondary',
  'accent',
  'danger',
  'neutral',
  'surface',
  'border',
  'surface-muted',
] as const

export type PaletteKey = (typeof PALETTE_KEYS)[number]
export type Palette = Partial<Record<PaletteKey, string>>

export type Brand = {
  name?: string
  logo?: string
  colors?: Palette
  dark?: Palette
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const ALLOWED_KEY_SET = new Set<string>(PALETTE_KEYS)

function sanitizePalette(raw: unknown): Palette | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Palette = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_KEY_SET.has(k) || typeof v !== 'string') continue
    const trimmed = v.trim()
    if (HEX_COLOR.test(trimmed)) out[k as PaletteKey] = trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeLogo(raw: unknown, origin: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || !origin) return undefined
  const base = URL.parse(origin)
  if (!base || base.protocol !== 'https:') return undefined
  const resolved = trimmed.startsWith('/') && !trimmed.startsWith('//')
    ? URL.parse(trimmed, base.origin)
    : URL.parse(trimmed)
  if (!resolved || resolved.protocol !== 'https:' || resolved.origin !== base.origin) return undefined
  return resolved.href
}

function sanitizeName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Strip control chars and truncate to keep client display names bounded.
  const cleaned = [...raw].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f).join('').trim().slice(0, 60)
  return cleaned || undefined
}

export function sanitizeBrand(raw: unknown, origin: string | null): Brand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const name = sanitizeName(r.name)
  const logo = sanitizeLogo(r.logo, origin)
  const colors = sanitizePalette(r.colors)
  const dark = sanitizePalette(r.dark)
  const out: Brand = {
    ...(name ? { name } : {}),
    ...(logo ? { logo } : {}),
    ...(colors ? { colors } : {}),
    ...(dark ? { dark } : {}),
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Extracts `colors` and `dark` maps from DESIGN.md YAML frontmatter without external deps. */
export function parseDesignFrontmatter(md: string): { colors?: Palette; dark?: Palette } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!m) return {}
  let section: 'colors' | 'dark' | null = null
  const raw: { colors: Record<string, string>; dark: Record<string, string> } = { colors: {}, dark: {} }
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const top = /^([a-zA-Z0-9_-]+):\s*(?:#.*)?$/.exec(line)
    if (top) {
      section = top[1] === 'colors' || top[1] === 'dark' ? top[1] : null
      continue
    }
    if (!/^\s/.test(line)) {
      section = null
      continue
    }
    if (!section) continue
    const kv = /^\s+([a-zA-Z0-9_-]+):\s*(.+?)\s*$/.exec(line)
    if (!kv) continue
    let val = kv[2].replace(/\s+#.*$/, '').trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    raw[section][kv[1]] = val
  }
  const colors = sanitizePalette(raw.colors)
  const dark = sanitizePalette(raw.dark)
  return { ...(colors ? { colors } : {}), ...(dark ? { dark } : {}) }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(filePath)
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null
    throw e
  }
}

async function firstLogoPath(appDir: string): Promise<string | undefined> {
  const base = appDir.replace(/\/+$/, '')
  const candidates = [
    ['shell/favicon.svg', '/shell/favicon.svg'],
    ['favicon.svg', '/favicon.svg'],
    ['shell/favicon.png', '/shell/favicon.png'],
    ['favicon.png', '/favicon.png'],
  ] as const
  for (const [rel, urlPath] of candidates) {
    try {
      const st = await Deno.stat(`${base}/${rel}`)
      if (st.isFile) return urlPath
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
  }
  return undefined
}

export async function readAppBrand(appDir: string, origin: string | null): Promise<Brand | null> {
  const base = appDir.replace(/\/+$/, '')
  const [designMd, shellRaw, logo] = await Promise.all([
    readIfExists(`${base}/DESIGN.md`),
    readIfExists(`${base}/shell/shell.json`),
    firstLogoPath(base),
  ])
  const palette = designMd ? parseDesignFrontmatter(designMd) : {}
  let name: unknown
  if (shellRaw) {
    const parsed = JSON.parse(shellRaw) as { app?: unknown }
    name = parsed.app
  }
  return sanitizeBrand({ name, logo, ...palette }, origin)
}
