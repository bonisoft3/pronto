// Bundles a pronto app into one HTML document: the interpreter and the cluster
// as one minified module written inline, the files shell.json serves in a JSON
// table, its large seed tables as files beside it (shell/seed/),
// the migrations and RLS for the cluster the page boots with the drains it
// calls (.pronto/cluster.json). PGlite's wasm, data and ICU archive are files
// beside it, under pronto/ and named by their content, which the page fetches
// from its own origin at boot: inline, they made the document larger than a
// static host serves (25 MiB a file), and a visit after the first fetches them
// from the cache. The module is `deno bundle`'s, so
// the page resolves through the same map and lock `deno run` would, and it is
// written inline so `import.meta.url` is the page's own, which PGlite's
// relative asset URLs resolve against. Inline script data cannot carry `<!--`
// or `</script`: the data writes its `<` as \u003c, and executable scripts
// escape both. An app with no server entity boots no cluster, and its module
// carries neither the cluster nor PGlite (page-static.ts).
//
//   deno run -A --config bundle/deno.json bundle/bundle.ts <appDir> --omnishell <dir> --mecha <dir> [--base /prefix] [--derived <file>] [--out <dir>] [--clock ticker|disabled] [--first-load <bytes>]
//
// The interpreter is omnishell's and the cluster is mecha's, so both roots are
// named by the caller; the module resolves `omnishell/` and `mecha-browser/`
// through a map written from them, and the cluster's own pins and lock ride along.
//
// --base mounts the page under a path prefix, as a GitHub Pages project site
// does: the shell reads it from its config, takes it off every address it
// matches and puts it on every address it composes, and the same document is
// written as 404.html, which is what makes a deep link boot instead of 404.
//
// --derived names the rows the app's streams and computations derive, as
// derived.ts writes them, run after the migrations: the page runs neither, its
// drains and its clock aside, so what they derive ships as it stood when the
// page was bundled.
import { encodeBase64 } from '@std/encoding/base64'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hostDomAssets, type StaticAsset } from './edge-assets.ts'
import { clusterDrains, releaseFiles } from './edge-scripts.ts'

function fail(msg: string): never {
  console.error(`bundle: ${msg}`)
  Deno.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Deno.args.slice()
const app = path.resolve(args.shift() ?? fail('usage: bundle.ts <appDir> --omnishell <dir> --mecha <dir> [--base /prefix] [--derived <file>] [--out <dir>] [--clock ticker|disabled] [--first-load <bytes>]'))
const flags: Record<string, string> = {}
while (args.length) {
  const flag = args.shift()!
  if (flag === '--no-cluster') {
    flags[flag] = 'true'
  } else {
    flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
  }
}
const omnishell = path.resolve(flags['--omnishell'] ?? fail('--omnishell names the interpreter root'))
const mecha = path.resolve(flags['--mecha'] ?? fail('--mecha names the mecha root'))
const base = (flags['--base'] ?? '').replace(/\/$/, '')
if (base && !base.startsWith('/')) fail(`--base is a path from the site root, such as /truco, not ${base}`)
const out = path.resolve(flags['--out'] ?? path.join(app, 'dist/browser'))
for (const flag of Object.keys(flags)) if (!['--omnishell', '--mecha', '--base', '--derived', '--out', '--no-cluster', '--clock', '--first-load'].includes(flag)) fail(`unknown flag ${flag}`)
// A frozen archive's page runs no clock over the schedules it keeps.
const clock = flags['--clock'] ?? 'ticker'
if (clock !== 'ticker' && clock !== 'disabled') fail('--clock must be ticker or disabled')
// The most bytes the document may weigh gzipped, which is what a first visit
// waits on before anything shows; none when it is not given.
const firstLoad = flags['--first-load'] === undefined ? undefined : Number(flags['--first-load'])
if (firstLoad !== undefined && !(Number.isInteger(firstLoad) && firstLoad > 0)) fail(`--first-load is a number of bytes, not ${flags['--first-load']}`)

const read = (p: string) => Deno.readTextFile(path.join(app, p))
const shell = JSON.parse(await read('shell/shell.json')) as {
  routes: { files: Record<string, string | string[]> }[]
  i18n?: { locales: Record<string, unknown> }
  migrations: string[]
  tables: string[]
  hostDom?: Record<string, { src: string }>
  seed?: Record<string, unknown[] | { href: string }>
  units?: Record<string, unknown>
  prefix?: string
}
// A unit is a worker the browser fetches on its own, past the document's shim.
const units = Object.keys(shell.units ?? {})
if (units.length) fail(`units are not bundled yet: ${units.join(', ')}`)

// The served set is shell.json's: what its routes name, the catalogues its
// locales name, and the shell's own three files. A file the terminal serves
// from its own tree is named from the root, `/omnishell/...`, and read there.
const served = new Set<string>(['shell/shell.json', 'shell/shell.css', 'shell/design.css'])
for (const route of shell.routes) {
  for (const v of Object.values(route.files)) for (const f of typeof v === 'string' ? [v] : v) served.add(f)
}
for (const loc of Object.keys(shell.i18n?.locales ?? {})) served.add(`messages/${loc}.json`)
const files: Record<string, string> = {}
for (const p of [...served].sort()) {
  if (p.startsWith('/omnishell/')) files[p.slice(1)] = await Deno.readTextFile(path.join(omnishell, p.slice('/omnishell/'.length)))
  else if (p.startsWith('/')) fail(`${p} is served from neither the app nor the terminal`)
  else files[p] = await read(p)
}
if (base) shell.prefix = base
// A seed table larger than SEED_INLINE is written beside the page, named by its
// content, and the config names its file: the shell fetches it the first time
// the table is read and the rest once the page is idle (omnishell's data-sync),
// so the config the first screen waits on carries only the small tables. An
// interpreter that reads only inline seeds gets them all inline.
const SEED_INLINE = 32 * 1024
const seedFiles = new Map<string, string>()
const readsSeedFiles = (await Deno.readTextFile(path.join(omnishell, 'interpreter/data-sync.js'))).includes('seedRows(')
for (const [table, rows] of readsSeedFiles ? Object.entries(shell.seed ?? {}) : []) {
  if (!Array.isArray(rows)) continue
  const text = JSON.stringify(rows)
  if (text.length <= SEED_INLINE) continue
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  const name = `shell/seed/${table}.${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}.json`
  seedFiles.set(name, text)
  shell.seed![table] = { href: name }
}
if (base || seedFiles.size) files['shell/shell.json'] = JSON.stringify(shell)

// A stylesheet's @import is fetched by the browser, not by the shim, so each
// import is inlined into the sheet that asks for it, imports of imports too. A
// screen's sheet and the shell's own are injected into the head, so their
// imports resolve against /shell/; a shared sheet is fetched at its own path
// and its imports resolve beside it. An import the bundler does not read is
// refused rather than left to the browser.
const IMPORT = /@import\s+(?:url\(\s*["']?([^"')]+?)["']?\s*\)|["']([^"']+)["'])\s*;/g
const inHead = new Set(['shell/shell.css', 'shell/design.css', ...shell.routes.map((r) => r.files.css as string)])
const baseOf = (p: string) => (inHead.has(p) ? 'file:///shell/' : `file:///${path.posix.dirname(p)}/`)
const inlined = new Map<string, string>()
// A comment is prose: an @import in one is neither inlined nor refused. A
// string is code, and a `/*` inside one opens no comment.
const TOKEN = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\//g
/** The sheet as alternating code and comments, code first. */
function parts(sheet: string): string[] {
  const out = ['']
  let at = 0
  for (const m of sheet.matchAll(TOKEN)) {
    out[out.length - 1] += sheet.slice(at, m.index)
    if (m[0].startsWith('/*')) out.push(m[0], '')
    else out[out.length - 1] += m[0]
    at = m.index + m[0].length
  }
  out[out.length - 1] += sheet.slice(at)
  return out
}
const comment = (i: number) => i % 2 === 1
const outsideComments = (sheet: string, f: (code: string) => string) =>
  parts(sheet).map((part, i) => (comment(i) ? part : f(part))).join('')
function inline(p: string, asking: string[]): string {
  if (asking.includes(p)) fail(`${asking.join(' imports ')} imports ${p} again`)
  let sheet = inlined.get(p)
  if (sheet === undefined) {
    sheet = outsideComments(files[p], (code) => code.replace(IMPORT, (_m, a, b) => {
      const target = new URL(a ?? b, baseOf(p)).pathname.slice(1)
      if (!(target in files)) fail(`${p} imports ${target}, which shell.json does not serve`)
      return inline(target, [...asking, p])
    }))
    if (parts(sheet).some((part, i) => !comment(i) && /@import\b/.test(part))) fail(`${p} carries an @import the bundler does not inline`)
    inlined.set(p, sheet)
  }
  return sheet
}
for (const p of Object.keys(files)) if (p.endsWith('.css')) files[p] = inline(p, [])

// An app with no migration has no cluster to boot: its document carries the
// files alone, and the page runs the shell without PGlite.
// An app whose migrations make no table the shell reads (its auth's app_user
// alone) has nothing for a cluster to serve either.
const clustered = !flags['--no-cluster'] && shell.migrations.length > 0 && shell.tables.length > 0
const derived = flags['--derived']
if (derived && !clustered) fail('--derived names rows for a cluster, and this app has no migration')
// The scripts the edge's data directory is built from, so the page's
// database is the same: mecha's schedule table before the seed among them.
const scripts = clustered ? await releaseFiles(app, mecha, shell.migrations) : []
const steps = [...scripts.map((f) => f.name), ...(derived ? [derived] : [])]
const sql = [...scripts.map((f) => f.sql), ...(derived ? [await Deno.readTextFile(path.resolve(derived))] : [])]
const drains = clustered ? await clusterDrains(path.join(app, '.pronto/cluster.json')) : []
// A publication and a replica identity are a WAL reader's, which the page has
// none of: the cluster skips them by the fence the emitter and an author write,
// read here by the cluster's own grammar, so one outside a fence is refused.
const { browserTier } = (await import(String(pathToFileURL(path.join(mecha, 'packages/mecha-browser/fence.ts'))))) as { browserTier: (sql: string) => string }
for (const [i, text] of sql.entries()) {
  if (/\bPUBLICATION\b|REPLICA IDENTITY/.test(browserTier(text))) fail(`${steps[i]} names a publication or a replica identity outside a container-tier fence`)
}

// The module's map: the cluster's pins, rebased from where they are written,
// the bundler's own, and the two roots. The cluster's lock is the module's,
// frozen, so a pin the lock does not carry is refused rather than resolved anew.
const rebase = (file: string, imports: Record<string, string>) =>
  Object.fromEntries(Object.entries(imports).map(([k, v]) => [
    k.startsWith('.') ? String(pathToFileURL(path.resolve(path.dirname(file), k))) : k,
    v.startsWith('.') ? String(pathToFileURL(path.resolve(path.dirname(file), v))) : v,
  ]))
const pins = (file: string) => (JSON.parse(Deno.readTextFileSync(file)) as { imports: Record<string, string> }).imports
const clusterPins = path.join(mecha, 'packages/mecha-browser/cluster.deno.json')
const clusterLock = path.join(mecha, 'packages/mecha-browser/deno.lock')
const map: { imports: Record<string, string> } = {
  imports: {
    ...rebase(clusterPins, pins(clusterPins)),
    ...rebase(path.join(here, 'deno.json'), pins(path.join(here, 'deno.json'))),
    'omnishell/': String(pathToFileURL(path.join(omnishell, 'interpreter') + '/')),
    'mecha-browser/': String(pathToFileURL(path.join(mecha, 'packages/mecha-browser') + '/')),
    'node:fs': String(pathToFileURL(path.join(here, 'node-shims.ts'))),
    'node:path': String(pathToFileURL(path.join(here, 'node-shims.ts'))),
    'fs': String(pathToFileURL(path.join(here, 'node-shims.ts'))),
    'path': String(pathToFileURL(path.join(here, 'node-shims.ts'))),
  },
}
const work = await Deno.makeTempDir({ prefix: 'bundle-' })
const mapFile = path.join(work, 'imports.json')
const outDir = path.join(work, 'out')
const entry = clustered ? 'page' : 'page-static'
const sesFile = path.join(work, 'ses.js')
let js: string
// A page with no cluster is split where the interpreter imports a module only
// when it needs it (a game's kinetic host, a YAML config, the storybook): those
// chunks are files beside the page, under pronto/js/ by their content's name,
// and the first visit fetches none of them. A clustered page stays one module,
// whose import.meta.url is the page's own (above).
const chunks = new Map<string, string>()
// Browsers cannot resolve bare node:* specifiers. NodeFS in PGlite is never
// invoked in browser environments, so replace any dangling node:* imports with
// safe browser shims so that scripts parse and run without network CORS errors.
const shimNode = (code: string) => code
  .replaceAll(/import\s*\*\s*as\s+(\w+)\s+from\s*["']node:fs["'];?/g, 'const $1 = { existsSync: () => false, mkdirSync: () => {} };')
  .replaceAll(/import\s*\*\s*as\s+(\w+)\s+from\s*["']node:path["'];?/g, 'const $1 = { resolve: (...a) => a.filter(Boolean).join("/"), join: (...a) => a.filter(Boolean).join("/") };')
  .replaceAll(/import\s*\*\s*as\s+(\w+)\s+from\s*["']node:[^"']+["'];?/g, 'const $1 = {};')
try {
  const ses = await Deno.readTextFile(path.join(omnishell, 'interpreter/vendor/ses.umd.min.js'))
  await Deno.writeTextFile(sesFile, `export function installSes() {\n${ses}\n}\n`)
  map.imports['pronto-bundle-ses'] = String(pathToFileURL(sesFile))
  await Deno.writeTextFile(mapFile, JSON.stringify(map))
  const bundled = new Deno.Command(Deno.execPath(), {
    args: [
      'bundle', '--no-config', '--node-modules-dir=none', '--platform', 'browser', '--format', 'esm', '--packages', 'bundle', '--minify',
      '--import-map', mapFile, '--lock', clusterLock, '--frozen', ...(clustered ? [] : ['--code-splitting']), '--outdir', outDir, path.join(here, `${entry}.ts`),
    ],
    stdout: 'inherit',
    stderr: 'inherit',
  }).outputSync()
  if (!bundled.success) fail('deno bundle failed')
  js = shimNode(await Deno.readTextFile(path.join(outDir, `${entry}.js`)))
  for await (const e of Deno.readDir(outDir)) {
    if (e.name === `${entry}.js` || !e.name.endsWith('.js')) continue
    chunks.set(e.name, shimNode(await Deno.readTextFile(path.join(outDir, e.name))))
  }
  // The inline module's own imports of its chunks resolve against the
  // document's <base>, not beside the chunks, so they name them from the root;
  // a chunk's imports of its siblings resolve beside it.
  for (const name of chunks.keys()) js = js.replaceAll(`"./${name}"`, () => JSON.stringify(`${base}/pronto/js/${name}`))
} finally {
  await Deno.remove(work, { recursive: true })
}

let assets = {}
const assetFiles = new Map<string, Uint8Array>()
if (clustered) {
  const pglite = /^npm:(@electric-sql\/pglite)@(.+)$/.exec(map.imports['@electric-sql/pglite']) ?? fail(`${clusterPins} pins no @electric-sql/pglite`)
  const icu = /^npm:(@electric-sql\/pglite-icu-full)@(.+)$/.exec(map.imports['@electric-sql/pglite-icu-full']) ?? fail(`${clusterPins} pins no @electric-sql/pglite-icu-full`)
  const info = new Deno.Command(Deno.execPath(), { args: ['info', '--json'], stdout: 'piped' }).outputSync()
  if (!info.success) fail('deno info failed')
  const denoDir = (JSON.parse(new TextDecoder().decode(info.stdout)) as { denoDir: string }).denoDir
  const dist = path.join(denoDir, 'npm/registry.npmjs.org', pglite[1], pglite[2], 'dist')
  const icuArchive = path.join(denoDir, 'npm/registry.npmjs.org', icu[1], icu[2], 'dist/icu.76.tgz')
  const beside = async (file: string) => {
    const bytes = await Deno.readFile(file)
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
    const ext = path.extname(file)
    const name = `pronto/${path.basename(file, ext)}.${hash}${ext}`
    assetFiles.set(name, bytes)
    return `${base}/${name}`
  }
  assets = { wasm: await beside(path.join(dist, 'pglite.wasm')), data: await beside(path.join(dist, 'pglite.data')), initdb: await beside(path.join(dist, 'initdb.wasm')), icu: await beside(icuArchive) }
}
const payload = {
  files,
  ...(clustered
    ? { cluster: { sql, tables: shell.tables, drains, clock, assets } }
    : {}),
}

// The payload is JSON, which carries `<` only inside a string, written there as
// \u003c, so neither `</script` nor `<!--` can occur in it. A module carries the two sequences only in a string, a regex or a comment,
// where `\/` and `\!` read as the character.
const scriptText = (text: string) => text.replace(/\r\n?/g, '\n').replaceAll('\0', '\\x00').replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--')
const module = scriptText(js)
// A function, so a `$` in a stylesheet is written as it is and not read as
// a replacement pattern.
const replace = (html: string, from: string | RegExp, to: string) => {
  const next = html.replace(from, () => to)
  return next === html ? fail(`shell/index.html: ${String(from)} not found`) : next
}
let html = await read('shell/index.html')
html = replace(html, '<link rel="stylesheet" href="./shell.css">', `<style>${files['shell/shell.css']}</style>`)
html = replace(html, '<link rel="stylesheet" href="./design.css">', `<style>${files['shell/design.css']}</style>`)
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_match, href) => {
  const p = new URL(href, 'file:///shell/').pathname.slice(1)
  if (!(p in files)) fail(`shell/index.html links ${p}, which shell.json does not serve`)
  return `<style>${files[p]}</style>`
})
html = html.replace(/<link rel="modulepreload"[^>]*>\n/g, '').replace(/<script type="speculationrules">[\s\S]*?<\/script>\n/, '')
// A preload of a file the shim serves goes to the network past it: on a host
// that answers an unknown path with the document, it downloads the whole page.
html = html.replace(/<link rel="preload" href="([^"]+)"[^>]*>\n/g, (tag, href) => {
  if (isExternal(href)) return tag
  const p = new URL(href, 'file:///shell/').pathname.slice(1)
  return p in files ? '' : fail(`shell/index.html preloads ${p}, which shell.json does not serve`)
})

function isExternal(url: string) {
  return url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')
}

// Mirrors #faviconPlan href emission in schema.cue (./ relative to shell/, / relative to root).
const resolveShellAsset = (appPath: string, href: string): string | null => {
  if (isExternal(href)) return null
  if (href === '/manifest.webmanifest') return path.join(appPath, 'shell', 'manifest.webmanifest')
  if (href.startsWith('/')) return path.join(appPath, href.slice(1))
  return path.join(appPath, 'shell', href.replace(/^\.\//, ''))
}

// Mirrors #manifestPlan icon emission in schema.cue (all local paths relative to root).
const resolveManifestIcon = (appPath: string, src: string): string | null =>
  isExternal(src) ? null : path.join(appPath, src.startsWith('/') ? src.slice(1) : src.replace(/^\.\//, ''))

const inlineAsset = async (filePath: string, label: string): Promise<string> => {
  const ext = path.extname(filePath).toLowerCase()
  const mime =
    ext === '.svg' ? 'image/svg+xml' :
    ext === '.png' ? 'image/png' :
    ext === '.ico' ? 'image/x-icon' :
    ext === '.webp' ? 'image/webp' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    fail(`${label}: unsupported asset format: ${ext}`)
  const data = await Deno.readFile(filePath)
  return `data:${mime};base64,${encodeBase64(data)}`
}

for (const match of html.matchAll(/<link\s+[^>]*rel=["'][^"']*\bicon\b[^"']*["'][^>]*>/gi)) {
  const tag = match[0]
  const hrefMatch = tag.match(/href=["']([^"']+)["']/)
  if (!hrefMatch) continue
  const fullPath = resolveShellAsset(app, hrefMatch[1])
  if (fullPath) {
    const dataUri = await inlineAsset(fullPath, 'shell/index.html')
    const inlinedTag = tag.replace(hrefMatch[0], () => `href="${dataUri}"`)
    html = html.replace(tag, () => inlinedTag)
  }
}

for (const match of html.matchAll(/<link\s+[^>]*rel=["']manifest["'][^>]*>/gi)) {
  const tag = match[0]
  const hrefMatch = tag.match(/href=["']([^"']+)["']/)
  if (!hrefMatch) continue
  const fullPath = resolveShellAsset(app, hrefMatch[1])
  if (!fullPath) continue
  const manifestText = await Deno.readTextFile(fullPath)
  const manifestObj: Record<string, unknown> = JSON.parse(manifestText)
  const cleanBase = base ? (base.endsWith('/') ? base : base + '/') : undefined
  const rebasePath = (u: string): string => {
    if (u.includes('://') || u.startsWith('//')) return u
    if (cleanBase) return u.startsWith('/') ? cleanBase + u.slice(1) : cleanBase + u.replace(/^\.\//, '')
    return u.startsWith('./') ? '/' + u.slice(2) : u
  }

  if (typeof manifestObj.start_url === 'string') {
    manifestObj.start_url = rebasePath(manifestObj.start_url)
  }
  if (typeof manifestObj.scope === 'string') {
    manifestObj.scope = rebasePath(manifestObj.scope)
  }
  if (Array.isArray(manifestObj.shortcuts)) {
    for (const sc of manifestObj.shortcuts as Array<Record<string, unknown>>) {
      if (typeof sc.url === 'string') {
        sc.url = rebasePath(sc.url)
      }
    }
  }
  if (Array.isArray(manifestObj.icons)) {
    for (const icon of manifestObj.icons as Array<Record<string, unknown>>) {
      if (typeof icon.src === 'string') {
        const iconPath = resolveManifestIcon(app, icon.src)
        if (iconPath) {
          icon.src = await inlineAsset(iconPath, 'manifest icon')
        }
      }
    }
  }
  const inlinedManifestJson = JSON.stringify(manifestObj)
  const manifestDataUri = `data:application/manifest+json;base64,${encodeBase64(new TextEncoder().encode(inlinedManifestJson))}`
  const inlinedTag = tag.replace(hrefMatch[0], () => `href="${manifestDataUri}"`)
  html = html.replace(tag, () => inlinedTag)
}
// Bundling changes external scripts into inline scripts; authorize only their
// exact bytes under every policy, including a script-src-elem override.
const hash = `'sha256-${encodeBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(module))))}'`
html = html.replace(/<meta\b[^>]*>/gi, (tag) => {
  if (!/\bhttp-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag)) return tag
  return tag.replace(/\bcontent\s*=\s*"([^"]*)"/i, (_attribute, policy: string) => {
    const directives = policy.split(';').map((d) => d.trim()).filter(Boolean)
    const find = (name: string) => directives.findIndex((d) => d.split(/\s/)[0] === name)
    const element = find('script-src-elem')
    const script = element < 0 ? find('script-src') : element
    if (script >= 0) directives[script] = `${directives[script].replace(/\s+'none'(?=\s|$)/g, '')} ${hash}`
    else {
      const fallback = directives[find('default-src')]?.split(/\s+/).slice(1).filter((s) => s !== "'none'") ?? []
      directives.push(['script-src', ...fallback, hash].join(' '))
    }
    return `content="${directives.join('; ')}"`
  })
})
html = replace(
  html,
  '<script type="module" src="./boot.js"></script>',
  `<script type="application/json" id="pronto-payload">${JSON.stringify(payload).replaceAll('<', '\\u003c')}</script>\n` +
    `<script type="module">${module}</script>`,
)

await Deno.remove(path.join(out, 'pronto'), { recursive: true }).catch((e) => { if (!(e instanceof Deno.errors.NotFound)) throw e })
if (assetFiles.size) await Deno.mkdir(path.join(out, 'pronto'), { recursive: true })
for (const [name, bytes] of assetFiles) await Deno.writeFile(path.join(out, name), bytes)
if (chunks.size) await Deno.mkdir(path.join(out, 'pronto/js'), { recursive: true })
for (const [name, code] of chunks) await Deno.writeTextFile(path.join(out, 'pronto/js', name), code)
await Deno.remove(path.join(out, 'shell/seed'), { recursive: true }).catch((e) => { if (!(e instanceof Deno.errors.NotFound)) throw e })
if (seedFiles.size) await Deno.mkdir(path.join(out, 'shell/seed'), { recursive: true })
for (const [name, text] of seedFiles) await Deno.writeTextFile(path.join(out, name), text)
await Deno.writeTextFile(path.join(out, 'index.html'), html)
// A host that answers an unknown path with 404.html serves the same document
// there, and the deep link boots.
if (base) await Deno.writeTextFile(path.join(out, '404.html'), html)
// The host-DOM hatches, as the terminal serves them (hostDomAssets), and every
// file a hatch names, wherever it sits: a hatch may serve files outside its own
// directory, as aprende's voice hatch serves the exams' figures.
const hatchSrcs = Object.values(shell.hostDom ?? {}).map((h) => h.src)
let hatchFiles = 0
if (hatchSrcs.length) {
  const surface = (e: string) => {
    const exported = new Deno.Command('cue', { args: ['export', '.', '-e', e, '--out', 'json'], cwd: app, stdout: 'piped', stderr: 'inherit' }).outputSync()
    if (!exported.success) fail(`cue export of ${e} failed`)
    return JSON.parse(new TextDecoder().decode(exported.stdout))
  }
  const held = hostDomAssets(surface('terminal.surface.statics') as StaticAsset[], hatchSrcs)
  for (const src of hatchSrcs) if (![...held.keys()].includes(src)) fail(`host-DOM hatch ${src} is not among the terminal's statics`)
  for (const file of surface('terminal.surface.hostDom') as string[]) {
    if (file.split(/[\\/]/).some((part) => part === '..' || part === '.')) fail(`invalid hatch file: ${file}`)
    held.set(file, file)
  }
  for (const [target, file] of held) {
    await Deno.mkdir(path.join(out, path.dirname(target)), { recursive: true })
    await Deno.copyFile(path.join(app, file), path.join(out, target))
  }
  hatchFiles = held.size
}
// What a first visit waits on: the document and the chunks its module imports
// statically, each gzipped; a chunk imported only when needed is not counted.
const gzip = async (text: string) => (await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()).byteLength
const statically = (code: string) => [...code.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+\.js)["']/g)].map((m) => path.posix.basename(m[1]))
const booted = new Set<string>()
for (const queue = statically(js); queue.length;) {
  const name = queue.pop()!
  if (booted.has(name) || !chunks.has(name)) continue
  booted.add(name)
  queue.push(...statically(chunks.get(name)!))
}
let gzipped = await gzip(html)
for (const name of booted) gzipped += await gzip(chunks.get(name)!)
console.error(`bundle: ${out}/index.html, ${(html.length / 1024 / 1024).toFixed(2)} MB (first load ${(gzipped / 1024).toFixed(0)} KB gzipped), ${Object.keys(files).length} files, ${chunks.size ? `${chunks.size} module chunks, ` : ''}${seedFiles.size ? `${seedFiles.size} seed files, ` : ''}${hatchFiles ? `${hatchFiles} hatch files beside it, ` : ''}${clustered ? `${sql.length} sql${derived ? ', derived rows last' : ''}` : 'no cluster'}`)
if (firstLoad !== undefined && gzipped > firstLoad) fail(`the first load is ${gzipped} bytes gzipped, over the app's budget of ${firstLoad}`)
