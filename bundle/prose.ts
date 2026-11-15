// What a page's files say to the people who read their source — comments —
// is not what a first visit should wait on: the bundler writes each served
// sheet, script and screen without its prose, and changes nothing else in it.
// A string, a template, a regular expression or a raw-text element keeps every
// character, and a marker the runtime reads (an HTML comment that does not
// open with a space, such as <!--first-paint-->) stays.

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)

/** A sheet without its comments; strings and url() bodies kept as written. */
export function cssWithoutComments(sheet: string): string {
  let out = ''
  let i = 0
  while (i < sheet.length) {
    const c = sheet[i]
    if (c === '"' || c === "'") {
      const end = quoted(sheet, i, c)
      out += sheet.slice(i, end)
      i = end
    } else if (c === '/' && sheet[i + 1] === '*') {
      const close = sheet.indexOf('*/', i + 2)
      const end = close === -1 ? sheet.length : close + 2
      // Two tokens a comment kept apart stay apart.
      if (!isSpace(out.at(-1)) && !isSpace(sheet[end])) out += ' '
      i = end
    } else {
      out += c
      i++
    }
  }
  return dropBlankLines(out)
}

/** Lines left with nothing on them once their comment went; only outside strings is this safe, which a sheet's newlines are. */
const dropBlankLines = (text: string) => text.replace(/\n[ \t]*(?=\n)/g, '')

function quoted(text: string, start: number, quote: string): number {
  let i = start + 1
  while (i < text.length && text[i] !== quote && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
  return Math.min(i + 1, text.length)
}

/** A screen without its prose comments: <!-- followed by a space or a newline. Raw-text elements are kept whole. */
export function htmlWithoutComments(doc: string): string {
  const RAW = /<(script|style|textarea|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
  let out = ''
  let at = 0
  for (const m of doc.matchAll(RAW)) {
    out += stripHtml(doc.slice(at, m.index)) + m[0]
    at = m.index! + m[0].length
  }
  return out + stripHtml(doc.slice(at))
}
const stripHtml = (part: string) => part.replace(/\n?[ \t]*<!--\s[\s\S]*?-->/g, '')

// After one of these, a `/` opens a regular expression rather than dividing.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])
const REGEX_AFTER_PUNCT = new Set([...'(,=:[!&|?{};+-*%<>~^'])

/**
 * A script without its comments. A comment alone on its line takes the line
 * with it; one after code leaves the code and the newline that ends it, so
 * automatic semicolon insertion reads the same statements.
 */
export function jsWithoutComments(src: string): string {
  let out = ''
  let i = 0
  // The last significant token, to tell a regular expression from a division.
  let last = ''
  // Each open `${` of a template, so its `}` returns to the template.
  const braces: ('code' | 'template')[] = []
  const template = (from: number): number => {
    let j = from
    while (j < src.length) {
      if (src[j] === '\\') j += 2
      else if (src[j] === '`') return j + 1
      else if (src[j] === '$' && src[j + 1] === '{') {
        braces.push('template')
        return j + 2
      } else j++
    }
    return j
  }
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '"' || c === "'") {
      const end = quoted(src, i, c)
      out += src.slice(i, end)
      i = end
      last = 'x'
    } else if (c === '`') {
      const end = template(i + 1)
      out += src.slice(i, end)
      i = end
      last = src[end - 1] === '`' ? 'x' : '{'
    } else if (c === '}' && braces.at(-1) === 'template') {
      braces.pop()
      const end = template(i + 1)
      out += src.slice(i, end)
      i = end
      last = src[end - 1] === '`' ? 'x' : '{'
    } else if (c === '/' && n === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      const line = out.lastIndexOf('\n') + 1
      if (/^[ \t]*$/.test(out.slice(line))) {
        // The comment is the whole line: the line goes, its newline too.
        out = out.slice(0, line)
        i = nl === -1 ? end : end + 1
      } else {
        out = out.replace(/[ \t]+$/, '')
        i = end
      }
    } else if (c === '/' && n === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? src.length : close + 2
      const body = src.slice(i, end)
      // A comment that spans lines is a line break to the parser.
      if (body.includes('\n')) out += '\n'
      else if (!isSpace(out.at(-1)) && !isSpace(src[end])) out += ' '
      i = end
    } else if (c === '/' && (last === '' || REGEX_AFTER_PUNCT.has(last) || REGEX_AFTER_WORD.has(last))) {
      let j = i + 1
      let inClass = false
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j += 2
        else if (src[j] === '[') { inClass = true; j++ }
        else if (src[j] === ']') { inClass = false; j++ }
        else if (src[j] === '/' && !inClass) { j++; break }
        else j++
      }
      while (j < src.length && /[a-z]/i.test(src[j])) j++
      out += src.slice(i, j)
      i = j
      last = 'x'
    } else if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z_$0-9]/.test(src[j])) j++
      const word = src.slice(i, j)
      out += word
      i = j
      last = REGEX_AFTER_WORD.has(word) ? word : 'x'
    } else {
      if (c === '{') braces.push('code')
      else if (c === '}') braces.pop()
      out += c
      i++
      if (!isSpace(c)) last = c === ')' || c === ']' || c === '}' ? 'x' : c
    }
  }
  return out
}
