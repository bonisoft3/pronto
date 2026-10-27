/// <reference lib="dom" />
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'npm:linkedom@0.18.4'
import { addressEdgeAssets, edgeRoutingRules, releaseAddresses } from './edge-addresses.ts'
import { builtRelease, deployedRelease, holdIceServers, releasedIceServers } from './edge-ice.ts'
import { edgeHints } from './edge-hints.ts'
import { acceptedLanguages, routeAt } from '../../omnishell/interpreter/fragment.js'

const addresses = await releaseAddresses(fileURLToPath(new URL('../../omnishell', import.meta.url)))

const stun = [{ urls: 'stun:stun.example:3478' }]

async function fixture(changed = false, previous?: string, presenter?: { policy: string }) {
  const out = await Deno.makeTempDir({ prefix: 'edge-addresses-' })
  const cfg = {
    ...(presenter ? { presenter } : {}),
    i18n: { default: 'pt-BR', locales: { 'pt-BR': { path: 'pt' }, 'en-GB': { path: 'en' } } },
    routes: [
      { path: '/equipe/:id', nav: { label: 'Equipe' }, paths: { 'pt-BR': '/equipe/:id', 'en-GB': '/team/:id' }, files: { html: 'shell/screens/team.html', css: 'shell/screens/team.css', handlers: ['shell/handlers/save.js'], shared: ['shell/shared/base.css'] } },
      { path: '/other', nav: { label: 'Other' }, files: { html: 'shell/screens/other.html', css: 'shell/screens/other.css' } },
    ],
  }
  const files: Record<string, string> = {
    'shell/index.html': `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'inline-speculation-rules'; require-trusted-types-for 'script'"><base href="/shell/"><link rel="preload" as="fetch" href="./shell.json" crossorigin><script type="speculationrules">{\r\n"prefetch": []}</script></head><body><script type="module" src="./boot.js"></script></body></html>`,
    'shell/boot.js': 'import "./a.js"; export const boot = true;',
    'shell/a.js': 'import "./boot.js"; export const value = ' + (changed ? '2;' : '1;'),
    'shell/unused.js': 'export const unused = true;',
    'shell/shell.json': JSON.stringify(cfg),
    'shell/screens/team.html': '<h1>Team</h1><template data-item><a data-route="other">Other</a></template>',
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
    const hints = await addressEdgeAssets(addresses, out, { previous, iceServers: stun })
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
    const preloads = f.document.querySelectorAll('link[rel="modulepreload"]')
    assert.equal(preloads.length, 2)
    for (const preload of preloads) {
      assert.ok(preload.getAttribute('integrity')?.startsWith('sha256-'))
    }
    const bootScript = f.document.querySelector('script[type="module"][src]')
    assert.ok(bootScript?.getAttribute('integrity')?.startsWith('sha256-'))
    assert.ok(!f.hints.common.some(link => link.includes('as=script') || link.includes('modulepreload')))
    assert.ok(!f.hints.common.some(link => link.includes('unused.js')))
    assert.ok(!f.hints.common.some(link => link.includes('team.html')))
    assert.ok(f.imports['/shell/screens/team.html'].endsWith('.txt'))
    const headers = await Deno.readTextFile(path.join(f.out, '_headers'))
    assert.ok(!headers.includes('Cache-Control'))
    assert.ok(!headers.includes('/shell/*\n'))
    assert.ok(headers.startsWith(`/\n  Content-Security-Policy: ${f.document.querySelector('meta')!.getAttribute('content')}\n`))
    assert.deepEqual(JSON.parse(f.map).screens, { team: ['other'], other: [] })
    assert.deepEqual(f.hints.routes[0].screens, ['other'])
  } finally { await Deno.remove(f.out, { recursive: true }) }
})

Deno.test("a presenter's worker script is sent with the presenter's policy, and none is sent without one", async () => {
  const policy = "default-src 'none'; connect-src blob: data:"
  const [with_, without] = [await fixture(false, undefined, { policy }), await fixture()]
  try {
    assert.ok((await Deno.readTextFile(path.join(with_.out, '_headers'))).includes(`/omnishell/interpreter/presenter.js\n  Content-Security-Policy: ${policy}\n`))
    assert.ok(!(await Deno.readTextFile(path.join(without.out, '_headers'))).includes('presenter.js'))
  } finally { await Promise.all([with_, without].map(f => Deno.remove(f.out, { recursive: true }))) }
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
      assert.throws(() => addresses.separateAssetDirectories(after.out, dir), /separate directory trees/)
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

// A release that dropped the target's list would still duel in every dev and
// CI stack, which share a network, and fail only between two homes.
Deno.test('the built edge tree serves the target\'s ICE servers, built and deployed alike', async () => {
  const f = await fixture()
  const fetched = globalThis.fetch
  // The door, answering each path from the built tree.
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://door.example')
    try {
      return new Response(await builtRelease(f.out)(url.pathname))
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
      return new Response(null, { status: 404 })
    }
  }
  try {
    assert.deepEqual(await releasedIceServers(builtRelease(f.out)), stun)
    const deployed = deployedRelease('https://door.example')
    await holdIceServers(deployed, stun, 'the deployment')
    await assert.rejects(holdIceServers(deployed, [], 'the deployment'), /the deployment carries ICE servers \[\{"urls":"stun:stun.example:3478"\}\], not \[\]/)
  } finally {
    globalThis.fetch = fetched
    await Deno.remove(f.out, { recursive: true })
  }
})

Deno.test('edge routing rules route /* to worker', async () => {
  const tmp = await Deno.makeTempDir()
  try {
    for (const dir of ['shell/screens', 'messages', 'omnishell/interpreter', 'docs']) {
      await Deno.mkdir(path.join(tmp, dir), { recursive: true })
    }
    for (const file of ['index.html', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'offline-first-sw.js', '_headers']) {
      await Deno.writeTextFile(path.join(tmp, file), '')
    }
    const rules = await edgeRoutingRules(tmp)
    assert.deepEqual(rules, ['/*'])
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

