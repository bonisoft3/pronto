/// <reference lib="dom" />
import * as path from 'node:path'
import { parseHTML } from 'npm:linkedom@0.18.4'
import { parse } from 'npm:acorn@8.14.0'
import { simple } from 'npm:acorn-walk@8.3.4'
// @ts-types="npm:@types/css-tree@2.3.10"
import * as cssTree from 'npm:css-tree@3.1.0'

const origin = 'https://release.invalid'
const encoder = new TextEncoder()
const digest = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
const hex = (bytes: Uint8Array) => [...bytes].map(n => n.toString(16).padStart(2, '0')).join('')
const local = (value: string, base: string) => {
  try {
    const url = new URL(value, origin + base)
    return (url.origin === origin && url.protocol === 'https:' && url.pathname.startsWith('/')) ? url.pathname : null
  } catch {
    return null
  }
}

export interface EdgeHints {
  common: string[]
  catalogues: Record<string, string>
  routes: { path: string; paths?: Record<string, string>; links: string[] }[]
  i18n?: unknown
  prefix?: string
}

export function separateAssetDirectories(out: string, previous: string) {
  const overlaps = [path.relative(out, previous), path.relative(previous, out)].some(relative =>
    relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)))
  if (overlaps) throw new Error('previous assets and output must be separate directory trees')
}

/** The URLs keep their directory so relative native imports and import.meta.url
 * still resolve against the source's base. The import map supplies identity;
 * no module is combined, rewritten, or minified. */
export async function addressEdgeAssets(out: string, previous?: string): Promise<EdgeHints> {
  if (previous) separateAssetDirectories(out, previous)
  const files = new Map<string, Uint8Array>()
  async function collect(dir: string) {
    for await (const entry of Deno.readDir(path.join(out, dir))) {
      const name = path.posix.join(dir, entry.name)
      if (entry.name.startsWith('_immutable-')) throw new Error(`reserved asset name: ${name}`)
      if (entry.isDirectory) await collect(name)
      else if (entry.isFile && !['index.html', 'shell/index.html', 'offline-first-sw.js', '_headers'].includes(name)) {
        files.set('/' + name.split('/').map(encodeURIComponent).join('/'), await Deno.readFile(path.join(out, name)))
      }
    }
  }
  await collect('')
  if (files.has('/shell/release.json')) throw new Error('edge asset addressing does not support live-update release manifests')
  const imports: Record<string, string> = {}
  const active = new Set<string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  async function address(name: string): Promise<string> {
    if (imports[name]) return imports[name]
    if (active.has(name)) throw new Error(`cyclic CSS dependency: ${name}`)
    let bytes = files.get(name)
    if (!bytes) throw new Error(`undeclared asset: ${name}`)
    active.add(name)
    if (name.endsWith('.css')) {
      let css = decoder.decode(bytes)
      // Screen CSS is installed as a style element in /shell/, not as an
      // external sheet in /shell/screens/. Other sheets retain their own base.
      const base = name.startsWith('/shell/screens/') ? '/shell/' : name
      const refs: (cssTree.Url | cssTree.StringNode)[] = []
      const ast = cssTree.parse(css, { positions: true, parseCustomProperty: true, onParseError: error => { throw error } })
      cssTree.walk(ast, {
        visit: 'Url', enter(node: cssTree.Url) { refs.push(node) },
      })
      cssTree.walk(ast, {
        visit: 'Atrule', enter(node: cssTree.Atrule) {
          if (node.name.toLowerCase() !== 'import' || node.prelude?.type !== 'AtrulePrelude') return
          const first = node.prelude.children.first
          if (first?.type === 'String') refs.push(first)
        },
      })
      for (const ref of refs.sort((a, b) => b.loc!.start.offset - a.loc!.start.offset)) {
        const value = ref.value
        if (value.startsWith('#') || /^(?:data:|https?:|\/\/)/.test(value)) continue
        const target = local(value, base)
        if (!target) continue
        const url = new URL(value, origin + base)
        const mapped = await address(target) + url.search + url.hash
        const replaced = ref.type === 'Url' ? `url(${JSON.stringify(mapped)})` : JSON.stringify(mapped)
        css = css.slice(0, ref.loc!.start.offset) + replaced + css.slice(ref.loc!.end.offset)
      }
      bytes = encoder.encode(css)
    }
    const hash = hex(await digest(bytes))
    const suffix = name.endsWith('.html') ? '.txt' : ''
    const url = path.posix.join(path.posix.dirname(name), `_immutable-${hash}-${path.posix.basename(name)}${suffix}`)
    await Deno.writeFile(path.join(out, decodeURIComponent(url)), bytes)
    imports[name] = url
    active.delete(name)
    return url
  }
  for (const name of [...files.keys()].sort()) await address(name)

  const dependencies = new Map<string, string[]>()
  for (const [name, bytes] of files) {
    if (!name.endsWith('.js')) continue
    const deps: string[] = []
    const ast = parse(decoder.decode(bytes), { ecmaVersion: 'latest', sourceType: 'module' })
    const take = (source: { value?: unknown } | null | undefined) => {
      if (typeof source?.value !== 'string') return
      const target = local(source.value, name)
      if (target !== null) {
        if (!imports[target]) throw new Error(`undeclared module ${source.value} imported by ${name}`)
        deps.push(target)
      }
    }
    simple(ast, {
      ImportDeclaration: node => take(node.source),
      ExportNamedDeclaration: node => take(node.source),
      ExportAllDeclaration: node => take(node.source),
    })
    dependencies.set(name, deps)
  }

  const entry = (await Deno.readTextFile(path.join(out, 'shell/index.html'))).replace(/\r\n?/g, '\n').replace(/\0/g, '\ufffd')
  const { document } = parseHTML(entry)
  const base = local(document.querySelector('base[href]')?.getAttribute('href') ?? '/shell/', '/')!
  const modules = new Set<string>()
  function closure(name: string) {
    if (modules.has(name)) return
    if (!imports[name]) throw new Error(`undeclared entry module: ${name}`)
    modules.add(name)
    for (const child of dependencies.get(name) ?? []) closure(child)
  }
  const common = new Set<string>()
  const link = (name: string, as: string) => {
    const url = imports[name]
    if (!url) throw new Error(`undeclared preload: ${name}`)
    return `<${url}>; rel=preload; as=${as}${as === 'fetch' ? '; crossorigin=anonymous' : ''}`
  }
  for (const node of document.querySelectorAll('script[type="module"][src], link[href]')) {
    const attr = node.tagName === 'SCRIPT' ? 'src' : 'href'
    const name = local(node.getAttribute(attr)!, base)
    if (name === null || !imports[name]) continue
    const rel = node.getAttribute('rel')
    if (attr === 'src' || rel === 'modulepreload') closure(name)
    if (rel === 'stylesheet') common.add(link(name, 'style'))
    if (rel === 'preload') common.add(link(name, node.getAttribute('as')!))
    node.setAttribute(attr, imports[name])
  }
  // Header modulepreloads can resolve dependencies before the map exists;
  // as=script preloads instead promote the whole graph ahead of first paint.
  // Native modulepreloads after the map preserve both identity and scheduling.
  for (const node of document.querySelectorAll('link[rel="modulepreload"]')) node.remove()
  for (const name of modules) {
    const node = document.createElement('link')
    node.setAttribute('rel', 'modulepreload')
    node.setAttribute('href', imports[name])
    document.head.append(node)
  }
  const map = document.createElement('script')
  map.setAttribute('type', 'importmap')
  map.setAttribute('id', 'pronto-assets')
  const json = JSON.stringify({ imports }).replace(/</g, '\\u003c')
  map.textContent = json
  document.head.prepend(map)
  const charset = document.querySelector('meta[charset]')
  if (charset) document.head.prepend(charset)
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  if (csp) {
    const hashes = await Promise.all([...document.querySelectorAll('script:not([src])')].map(async script =>
      `'sha256-${btoa(String.fromCharCode(...await digest(encoder.encode(script.textContent!))))}'`))
    const policy = csp.getAttribute('content')!
    if (!/(?:^|;)\s*script-src\s/.test(policy)) throw new Error('entry CSP has no script-src')
    csp.setAttribute('content', policy.replace(/((?:^|;)\s*script-src(?:-elem)?)\s/g, `$1 ${hashes.join(' ')} `))
    // The policy must be active before the import map is parsed.
    document.head.prepend(csp)
  }
  const html = '<!doctype html>\n' + document.documentElement.outerHTML + '\n'
  await Deno.writeTextFile(path.join(out, 'shell/index.html'), html)
  await Deno.writeTextFile(path.join(out, 'index.html'), html)
  const directories = new Set(Object.values(imports).map(url => path.posix.dirname(url)))
  // An already-open document can enter a screen it has never downloaded after
  // a deploy. Retain its immutable URLs without retaining mutable entry files.
  async function retain(dir: string) {
    for await (const entry of Deno.readDir(path.join(previous!, dir))) {
      const name = path.join(dir, entry.name)
      if (entry.isDirectory) await retain(name)
      else if (entry.isFile && entry.name.startsWith('_immutable-')) {
        const expected = /^_immutable-([a-f0-9]{64})-/.exec(entry.name)?.[1]
        const bytes = await Deno.readFile(path.join(previous!, name))
        if (hex(await digest(bytes)) !== expected) throw new Error(`retained asset identity mismatch: ${name}`)
        await Deno.mkdir(path.join(out, dir), { recursive: true })
        await Deno.writeFile(path.join(out, name), bytes)
        directories.add('/' + dir.split(path.sep).filter(Boolean).map(encodeURIComponent).join('/'))
      }
    }
  }
  if (previous) await retain('')
  if (directories.size > 100) throw new Error('edge asset cache rules exceed Cloudflare’s 100-rule limit')
  await Deno.writeTextFile(path.join(out, '_headers'), [...directories].sort().map(dir => `${dir === '/' ? '' : dir}/_immutable-*\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n'))

  const cfg = JSON.parse(decoder.decode(files.get('/shell/shell.json')!))
  const routes = cfg.routes.map((route: { path: string; paths?: Record<string, string>; files: Record<string, string | string[]> }) => {
    const links = new Set<string>()
    for (const [kind, value] of Object.entries(route.files)) {
      for (const name of typeof value === 'string' ? [value] : value) links.add(link(local(name, '/')!, kind === 'shared' ? 'style' : 'fetch'))
    }
    return { path: route.path, ...(route.paths ? { paths: route.paths } : {}), links: [...links] }
  })
  const catalogues = Object.fromEntries(Object.keys(cfg.i18n?.locales ?? {}).map(tag => [tag, link(`/messages/${tag}.json`, 'fetch')]))
  return { common: [...common], routes, catalogues, i18n: cfg.i18n, prefix: cfg.prefix }
}
