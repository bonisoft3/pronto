// Bundles a pronto app into one HTML document: the interpreter and the cluster
// as one module written inline, the files shell.json serves in a base64 table,
// the migrations and RLS for the cluster the page boots, and PGlite's wasm and
// data as base64 of gzip inflated at boot. The module is `deno bundle`'s, so
// the page resolves through the same map and lock `deno run` would, and it is
// written inline so `import.meta.url` is the page's own, which PGlite's
// relative asset URLs resolve against. Inline script data cannot carry `<!--`
// or `</script`, and both occur in SES and in screens: the data rides as
// base64, and the module has the two sequences escaped.
//
//   deno run -A --config bundle/deno.json bundle/bundle.ts <appDir> --omnishell <dir> --mecha <dir> [--base /prefix] [--out <dir>]
//
// The interpreter is omnishell's and the cluster is mecha's, so both roots are
// named by the caller; the module resolves `omnishell/` and `mecha-browser/`
// through a map written from them, and the cluster's own pins and lock ride along.
//
// --base mounts the page under a path prefix, as a GitHub Pages project site
// does: the shell reads it from its config, takes it off every address it
// matches and puts it on every address it composes, and the same document is
// written as 404.html, which is what makes a deep link boot instead of 404.
import { encodeBase64 } from '@std/encoding/base64'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function fail(msg: string): never {
  console.error(`bundle: ${msg}`)
  Deno.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Deno.args.slice()
const app = path.resolve(args.shift() ?? fail('usage: bundle.ts <appDir> --omnishell <dir> --mecha <dir> [--base /prefix] [--out <dir>]'))
const flags: Record<string, string> = {}
while (args.length) {
  const flag = args.shift()!
  flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
}
const omnishell = path.resolve(flags['--omnishell'] ?? fail('--omnishell names the interpreter root'))
const mecha = path.resolve(flags['--mecha'] ?? fail('--mecha names the mecha root'))
const base = (flags['--base'] ?? '').replace(/\/$/, '')
if (base && !base.startsWith('/')) fail(`--base is a path from the site root, such as /truco, not ${base}`)
const out = path.resolve(flags['--out'] ?? path.join(app, 'dist/browser'))
for (const flag of Object.keys(flags)) if (!['--omnishell', '--mecha', '--base', '--out'].includes(flag)) fail(`unknown flag ${flag}`)

const read = (p: string) => Deno.readTextFile(path.join(app, p))
const shell = JSON.parse(await read('shell/shell.json')) as {
  routes: { files: Record<string, string | string[]> }[]
  i18n?: { locales: Record<string, unknown> }
  migrations: string[]
  tables: string[]
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
if (base) {
  shell.prefix = base
  files['shell/shell.json'] = JSON.stringify(shell)
}

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
function inline(p: string, asking: string[]): string {
  if (asking.includes(p)) fail(`${asking.join(' imports ')} imports ${p} again`)
  let sheet = inlined.get(p)
  if (sheet === undefined) {
    sheet = files[p].replace(IMPORT, (_m, a, b) => {
      const target = new URL(a ?? b, baseOf(p)).pathname.slice(1)
      if (!(target in files)) fail(`${p} imports ${target}, which shell.json does not serve`)
      return inline(target, [...asking, p])
    })
    if (/@import\b/.test(sheet)) fail(`${p} carries an @import the bundler does not inline`)
    inlined.set(p, sheet)
  }
  return sheet
}
for (const p of Object.keys(files)) if (p.endsWith('.css')) files[p] = inline(p, [])

// An app with no migration has no cluster to boot: its document carries the
// files alone, and the page runs the shell without PGlite.
const clustered = shell.migrations.length > 0
const sql = clustered ? [await Deno.readTextFile(path.join(mecha, 'services/database/rls/rls.sql')), ...(await Promise.all(shell.migrations.map(read)))] : []
// A publication and a replica identity are a WAL reader's, which the page has
// none of: the cluster skips them by the fence the emitter and an author write,
// read here by the cluster's own grammar, so one outside a fence is refused.
const { browserTier } = (await import(String(pathToFileURL(path.join(mecha, 'packages/mecha-browser/fence.ts'))))) as { browserTier: (sql: string) => string }
for (const [i, text] of sql.entries()) {
  if (/\bPUBLICATION\b|REPLICA IDENTITY/.test(browserTier(text))) fail(`${i === 0 ? 'rls.sql' : shell.migrations[i - 1]} names a publication or a replica identity outside a container-tier fence`)
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
  },
}
const work = await Deno.makeTempDir({ prefix: 'bundle-' })
const mapFile = path.join(work, 'imports.json')
const jsFile = path.join(work, 'page.js')
let js: string
try {
  await Deno.writeTextFile(mapFile, JSON.stringify(map))
  const bundled = new Deno.Command(Deno.execPath(), {
    args: [
      'bundle', '--no-config', '--node-modules-dir=none', '--platform', 'browser', '--format', 'esm', '--packages', 'bundle',
      '--import-map', mapFile, '--lock', clusterLock, '--frozen', '--output', jsFile, path.join(here, 'page.ts'),
    ],
    stdout: 'inherit',
    stderr: 'inherit',
  }).outputSync()
  if (!bundled.success) fail('deno bundle failed')
  js = await Deno.readTextFile(jsFile)
} finally {
  await Deno.remove(work, { recursive: true })
}

// PGlite's assets sit in Deno's cache beside the package the module resolved.
const pglite = /^npm:(@electric-sql\/pglite)@(.+)$/.exec(map.imports['@electric-sql/pglite']) ?? fail(`${clusterPins} pins no @electric-sql/pglite`)
const info = new Deno.Command(Deno.execPath(), { args: ['info', '--json'], stdout: 'piped' }).outputSync()
if (!info.success) fail('deno info failed')
const denoDir = (JSON.parse(new TextDecoder().decode(info.stdout)) as { denoDir: string }).denoDir
const dist = path.join(denoDir, 'npm/registry.npmjs.org', pglite[1], pglite[2], 'dist')
const gz64 = async (f: string) => {
  const bytes = (await Deno.readFile(path.join(dist, f))) as Uint8Array<ArrayBuffer>
  return encodeBase64(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).bytes())
}
const payload = {
  files,
  ...(clustered
    ? { cluster: { sql, tables: shell.tables, assets: { wasm: await gz64('pglite.wasm'), data: await gz64('pglite.data'), initdb: await gz64('initdb.wasm') } } }
    : {}),
}

const b64 = (s: string) => encodeBase64(new TextEncoder().encode(s))
const ses = await Deno.readTextFile(path.join(omnishell, 'interpreter/vendor/ses.umd.min.js'))
// A module carries the two sequences only in a string, a regex or a comment,
// where `\/` and `\!` read as the character.
const module = js.replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--')
// A function, so a `$` in a stylesheet is written as it is and not read as
// a replacement pattern.
const replace = (html: string, from: string | RegExp, to: string) => {
  const next = html.replace(from, () => to)
  return next === html ? fail(`shell/index.html: ${String(from)} not found`) : next
}
let html = await read('shell/index.html')
html = replace(html, '<link rel="stylesheet" href="./shell.css">', `<style>${files['shell/shell.css']}</style>`)
html = replace(html, '<link rel="stylesheet" href="./design.css">', `<style>${files['shell/design.css']}</style>`)
html = html.replace(/<link rel="modulepreload"[^>]*>\n/g, '').replace(/<script type="speculationrules">[\s\S]*?<\/script>\n/, '')
html = replace(
  html,
  '<script type="module" src="./boot.js"></script>',
  `<script type="application/octet-stream" id="pronto-payload">${b64(JSON.stringify(payload))}</script>\n` +
    `<script src="data:text/javascript;base64,${b64(ses)}"></script>\n` +
    `<script type="module">${module}</script>`,
)

await Deno.mkdir(out, { recursive: true })
await Deno.writeTextFile(path.join(out, 'index.html'), html)
// A host that answers an unknown path with 404.html serves the same document
// there, and the deep link boots.
if (base) await Deno.writeTextFile(path.join(out, '404.html'), html)
console.error(`bundle: ${out}/index.html, ${(html.length / 1024 / 1024).toFixed(2)} MB, ${Object.keys(files).length} files, ${clustered ? `${sql.length} sql` : 'no cluster'}`)
