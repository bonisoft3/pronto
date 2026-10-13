/// <reference lib="dom" />
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { parseHTML } from 'npm:linkedom@0.18.4'
import { addressEdgeAssets, separateAssetDirectories } from './edge-addresses.ts'
import { edgeHints } from './edge-hints.ts'
import { acceptedLanguages, routeAt } from '../../omnishell/interpreter/fragment.js'

async function fixture(changed = false, previous?: string) {
  const out = await Deno.makeTempDir({ prefix: 'edge-addresses-' })
  const cfg = {
    i18n: { default: 'pt-BR', locales: { 'pt-BR': { path: 'pt' }, 'en-GB': { path: 'en' } } },
    routes: [
      { path: '/equipe/:id', paths: { 'pt-BR': '/equipe/:id', 'en-GB': '/team/:id' }, files: { html: 'shell/screens/team.html', css: 'shell/screens/team.css', handlers: ['shell/handlers/save.js'], shared: ['shell/shared/base.css'] } },
      { path: '/other', files: { html: 'shell/screens/other.html', css: 'shell/screens/other.css' } },
    ],
  }
  const files: Record<string, string> = {
    'shell/index.html': `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'inline-speculation-rules'; require-trusted-types-for 'script'"><base href="/shell/"><link rel="preload" as="fetch" href="./shell.json" crossorigin><script type="speculationrules">{\r\n"prefetch": []}</script></head><body><script type="module" src="./boot.js"></script></body></html>`,
    'shell/boot.js': 'import "./a.js"; export const boot = true;',
    'shell/a.js': 'import "./boot.js"; export const value = ' + (changed ? '2;' : '1;'),
    'shell/unused.js': 'export const unused = true;',
    'shell/shell.json': JSON.stringify(cfg),
    'shell/screens/team.html': '<h1>Team</h1>',
    'shell/screens/team.css': '@import url("shared/base.css");',
    'shell/shared/base.css': '/* url(missing.svg) */ body { background: url("./ball.svg#ball"); mask: url("./a space.svg"); background-image: url("blob:https://release.invalid/456"); cursor: url("urn:isbn:0451450523"); }',
    'shell/shared/ball.svg': '<svg/>',
    'shell/shared/a space.svg': '<svg/>',
    'shell/screens/other.html': '<h1>Other</h1>',
    'shell/screens/other.css': 'h1 { color: red }',
    'shell/handlers/save.js': '(input) => input',
    'omnishell/interpreter/vendor/ses.umd.min.js': 'globalThis.lockdown = () => {}',
    'messages/pt-BR.json': '{}',
    'messages/en-GB.json': '{}',
    'manifest.webmanifest': '{}',
  }
  for (const [name, body] of Object.entries(files)) {
    await Deno.mkdir(path.dirname(path.join(out, name)), { recursive: true })
    await Deno.writeTextFile(path.join(out, name), body)
  }
  try {
    const hints = await addressEdgeAssets(out, previous)
    const { document } = parseHTML(await Deno.readTextFile(path.join(out, 'index.html')))
    const map = document.getElementById('pronto-assets')!.textContent!
    const imports = JSON.parse(map).imports as Record<string, string>
    return { out, hints, document, map, imports, files }
  } catch (error) {
    await Deno.remove(out, { recursive: true })
    throw error
  }
}

Deno.test('edge identity hashes the served bytes, preserves module bases, and authorizes the map under CSP', async () => {
  const f = await fixture()
  try {
    for (const [canonical, url] of Object.entries(f.imports)) {
      assert.equal(path.posix.dirname(url), path.posix.dirname(canonical))
      assert.ok(!url.startsWith('//'))
      const bytes = await Deno.readFile(path.join(f.out, decodeURIComponent(url)))
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
      assert.ok(url.includes(`_immutable-${hash}-`))
    }
    assert.equal(await Deno.readTextFile(path.join(f.out, f.imports['/shell/boot.js'])), f.files['shell/boot.js'])
    assert.equal(await Deno.readTextFile(path.join(f.out, 'shell/boot.js')), f.files['shell/boot.js'])
    const css = await Deno.readTextFile(path.join(f.out, f.imports['/shell/screens/team.css']))
    assert.ok(css.includes(f.imports['/shell/shared/base.css']))
    const shared = await Deno.readTextFile(path.join(f.out, f.imports['/shell/shared/base.css']))
    assert.ok(shared.includes(f.imports['/shell/shared/ball.svg'] + '#ball'))
    const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.map)))))
    assert.ok(f.document.querySelector('meta')!.getAttribute('content')!.includes(`'sha256-${hash}'`))
    const speculation = f.document.querySelector('script[type="speculationrules"]')!.textContent!
    assert.ok(!speculation.includes('\r'))
    const rulesHash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(speculation)))))
    assert.ok(f.document.querySelector('meta')!.getAttribute('content')!.includes(`'sha256-${rulesHash}'`))
    assert.equal(f.document.head.children[0].tagName, 'META')
    assert.equal(f.document.head.children[1].id, 'pronto-assets')
    assert.equal(f.document.querySelectorAll('link[rel="modulepreload"]').length, 2)
    assert.ok(!f.hints.common.some(link => link.includes('as=script') || link.includes('modulepreload')))
    assert.ok(!f.hints.common.some(link => link.includes('unused.js')))
    assert.ok(!f.hints.common.some(link => link.includes('team.html')))
    assert.ok(f.imports['/shell/screens/team.html'].endsWith('.txt'))
    const headers = await Deno.readTextFile(path.join(f.out, '_headers'))
    assert.ok(headers.includes('/shell/_immutable-*\n  Cache-Control: public, max-age=31536000, immutable'))
    assert.ok(!headers.includes('/shell/*\n'))
  } finally { await Deno.remove(f.out, { recursive: true }) }
})

Deno.test('changing a module keeps unrelated asset URLs and its importing module reusable', async () => {
  const before = await fixture(), after = await fixture(true)
  try {
    assert.notEqual(before.imports['/shell/a.js'], after.imports['/shell/a.js'])
    for (const name of Object.keys(before.imports).filter(name => name !== '/shell/a.js')) assert.equal(before.imports[name], after.imports[name])
    assert.notEqual(before.map, after.map)
  } finally { await Promise.all([before, after].map(f => Deno.remove(f.out, { recursive: true }))) }
})

Deno.test('a deployment retains verified prior URLs for open tabs without replacing current canonical files', async () => {
  const before = await fixture()
  const after = await fixture(true, before.out)
  try {
    assert.equal(await Deno.readTextFile(path.join(after.out, before.imports['/shell/a.js'])), before.files['shell/a.js'])
    assert.equal(await Deno.readTextFile(path.join(after.out, 'shell/a.js')), after.files['shell/a.js'])
    for (const dir of [after.out, path.dirname(after.out), path.join(after.out, 'public')]) {
      assert.throws(() => separateAssetDirectories(after.out, dir), /separate directory trees/)
    }
    await Deno.writeTextFile(path.join(before.out, before.imports['/shell/a.js']), 'corrupt')
    await assert.rejects(() => fixture(true, before.out), /identity mismatch/)
  } finally { await Promise.all([before, after].map(f => Deno.remove(f.out, { recursive: true }))) }
})

Deno.test('route hints follow the shell’s locale and parameter resolution without preloading unrelated screens', async () => {
  const f = await fixture()
  try {
    for (const url of ['/en/team/42', '/equipe/42?lang=en-GB']) {
      const links = edgeHints(new Request('https://app.test' + url), f.hints, routeAt, [])
      for (const name of ['/shell/screens/team.html', '/shell/handlers/save.js', '/messages/en-GB.json', '/messages/pt-BR.json']) assert.ok(links.includes(f.imports[name]))
      assert.ok(!links.includes(f.imports['/shell/screens/other.html']))
      assert.ok(links.includes('crossorigin=anonymous'))
    }
    const portuguese = edgeHints(new Request('https://app.test/equipe/42'), f.hints, routeAt, acceptedLanguages('en-GB;q=0, pt-BR;q=1'))
    assert.ok(!portuguese.includes(f.imports['/messages/en-GB.json']))
  } finally { await Deno.remove(f.out, { recursive: true }) }
})
