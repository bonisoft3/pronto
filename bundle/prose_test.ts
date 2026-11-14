import { assertEquals } from 'jsr:@std/assert@1.0.13'
import { cssWithoutComments, htmlWithoutComments, jsWithoutComments } from './prose.ts'

Deno.test('a sheet loses its comments and keeps its strings', () => {
  const sheet = '/* the page */\n.a { content: "/* kept */"; }\n\n/* gone */\n.b{color:red/**/}\n'
  assertEquals(cssWithoutComments(sheet), '\n.a { content: "/* kept */"; }\n.b{color:red }\n')
  assertEquals(cssWithoutComments('a/**/b'), 'a b')
})

Deno.test('a screen loses its prose comments and keeps markers and raw text', () => {
  const doc = '<main>\n  <!-- what this is -->\n  <p>x</p><!--first-paint-->\n<script>/* <!-- kept --> */</script><pre><!-- kept --></pre></main>'
  assertEquals(htmlWithoutComments(doc), '<main>\n  <p>x</p><!--first-paint-->\n<script>/* <!-- kept --> */</script><pre><!-- kept --></pre></main>')
})

Deno.test('a script loses its comments and keeps strings, templates, regular expressions and division', () => {
  const src = [
    '// a line of its own',
    '(state, event) => {',
    '  const u = "http://x"; // after code',
    "  const r = /a\\/\\/b[/]/g.test('//');",
    '  const t = `// ${state.x /* in code */ + `//${1}`} //`;',
    '  const d = state.n / 2 / 1; /* one line */ const e = 1;',
    '  /* two',
    '     lines */ return u + r + t + d + e;',
    '}',
  ].join('\n')
  assertEquals(jsWithoutComments(src), [
    '(state, event) => {',
    '  const u = "http://x";',
    "  const r = /a\\/\\/b[/]/g.test('//');",
    '  const t = `// ${state.x  + `//${1}`} //`;',
    '  const d = state.n / 2 / 1;  const e = 1;',
    '  ',
    ' return u + r + t + d + e;',
    '}',
  ].join('\n'))
})

Deno.test('a regular expression after return or an operator is read as one', () => {
  assertEquals(jsWithoutComments('return /\\/\\//.test(s) // x'), 'return /\\/\\//.test(s)')
  assertEquals(jsWithoutComments('a = b || /"/.test(c) // x'), 'a = b || /"/.test(c)')
})
