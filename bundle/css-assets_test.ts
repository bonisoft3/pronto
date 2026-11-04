import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')

Deno.test('bundled CSS retains its asset URLs under a Pages prefix', async () => {
  const app = await Deno.makeTempDir({ prefix: 'css-assets-' })
  try {
    const write = async (name: string, content: string) => {
      const file = path.join(app, name)
      await Deno.mkdir(path.dirname(file), { recursive: true })
      await Deno.writeTextFile(file, content)
    }
    await write('shell/shell.json', JSON.stringify({ routes: [{ files: { css: 'shell/screens/home.css', shared: ['shell/shared/table.css'] } }], migrations: [], tables: [] }))
    await write('shell/shell.css', '')
    await write('shell/design.css', '')
    await write('shell/screens/home.css', '@import url("shared/table.css");')
    await write('shell/shared/table.css', '/* url("missing.png") */ .a { background: url("/shell/assets/a.png"); } .b { background: url(../assets/b.png); } .c { content: "url(missing.png)"; }')
    await write('shell/assets/a.png', 'portrait a')
    await write('shell/assets/b.png', 'portrait b')
    await write('shell/index.html', '<!doctype html><html><head><base href="/shell/"><link rel="stylesheet" href="./shell.css"><link rel="stylesheet" href="./design.css"></head><body><script type="module" src="./boot.js"></script></body></html>')
    const result = await new Deno.Command(Deno.execPath(), { args: ['run', '-A', '--config', path.join(here, 'deno.json'), path.join(here, 'bundle.ts'), app, '--omnishell', path.join(repo, 'plugins/omnishell'), '--mecha', path.join(repo, 'libraries/mecha'), '--base', '/truco'], stdout: 'inherit', stderr: 'inherit' }).output()
    assert.equal(result.success, true)
    const html = await Deno.readTextFile(path.join(app, 'dist/browser/index.html'))
    const encoded = /<script type="application\/octet-stream" id="pronto-payload">([^<]*)<\/script>/.exec(html)![1]
    const payload = JSON.parse(atob(encoded))
    const css = payload.files['shell/screens/home.css']
    assert.match(css, /url\("\/truco\/shell\/assets\/a\.png"\)/)
    assert.match(css, /url\("\/truco\/shell\/assets\/b\.png"\)/)
    assert.match(css, /content: "url\(missing\.png\)"/)
    assert.equal(await Deno.readTextFile(path.join(app, 'dist/browser/shell/assets/a.png')), 'portrait a')
    assert.equal(await Deno.readTextFile(path.join(app, 'dist/browser/shell/assets/b.png')), 'portrait b')
    await write('shell/shared/table.css', String.raw`.a { background: url("../assets/a\2e png"); }`)
    const escaped = await new Deno.Command(Deno.execPath(), { args: ['run', '-A', '--config', path.join(here, 'deno.json'), path.join(here, 'bundle.ts'), app, '--omnishell', path.join(repo, 'plugins/omnishell'), '--mecha', path.join(repo, 'libraries/mecha')], stderr: 'piped' }).output()
    assert.equal(escaped.success, false)
    assert.match(new TextDecoder().decode(escaped.stderr), /CSS asset with escapes/)

  } finally { await Deno.remove(app, { recursive: true }) }
})
