// ir.md: ir.html as Markdown, written beside it by every generate (write.ts), for reading where
// HTML is not rendered — a repository's page, a diff, a model's context. ir.html stays the source:
// the author writes its prose and pronto draws its cards (ir-render.ts); ir.md is derived from the
// whole of it and never edited.
//
// What it keeps: headings, prose, lists, tables, code, links and images as Markdown; each design
// object's id as an anchor (`<a id="Game"></a>`), so `ir.md#Game` lands where `ir.html#Game`
// does, with its kind beside it; a card's chips on one line; the entity as JSON, and a screen's
// paths, as JSON blocks; `<details>` folded as GitHub folds them; mermaid as a mermaid block. A
// drawn picture (D2's SVG) is not text: its caption stays, with a link to it in ir.html.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "ul",
]);

type Node = { tag: string; attrs: Record<string, string>; children: Node[] } | string;
type El = Exclude<Node, string>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

/** The document as a tree: tags, their attributes and their text; comments dropped. */
export function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1];
  const tag = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gi;
  let at = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m.index > at) top().children.push(decode(html.slice(at, m.index)));
    at = tag.lastIndex;
    if (m[1]) {
      const name = m[1].toLowerCase();
      const i = stack.map((e) => e.tag).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    if (!m[2]) continue;
    const name = m[2].toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    const el: El = { tag: name, attrs, children: [] };
    top().children.push(el);
    if (RAW.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, at);
      const body = html.slice(at, end === -1 ? html.length : end);
      el.children.push(name === "script" || name === "style" ? body : decode(body));
      at = end === -1 ? html.length : html.indexOf(">", end) + 1;
      tag.lastIndex = at;
    } else if (!VOID.has(name) && !m[4]) {
      stack.push(el);
    }
  }
  if (at < html.length) top().children.push(decode(html.slice(at)));
  return root;
}

const classes = (e: El) => (e.attrs.class ?? "").split(/\s+/);
const textOf = (n: Node): string => (typeof n === "string" ? n : n.tag === "svg" || n.tag === "script" || n.tag === "style" ? "" : n.children.map(textOf).join(""));
const squash = (s: string) => s.replace(/[ \t\r\n]+/g, " ");
const cell = (s: string) => squash(s).trim().replace(/\|/g, "\\|");

/** A run of inline content as one line of Markdown. */
function inline(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") { out += squash(n); continue; }
    const kids = () => inline(n.children);
    switch (n.tag) {
      case "br": out += "  \n"; break;
      case "b": case "strong": { const t = kids().trim(); out += t ? `**${t}**` : ""; break; }
      case "i": case "em": { const t = kids().trim(); out += t ? `*${t}*` : ""; break; }
      case "code": case "kbd": case "samp": { const t = squash(textOf(n)).trim(); out += t ? (t.includes("`") ? `\`\` ${t} \`\`` : `\`${t}\``) : ""; break; }
      case "a": {
        const t = kids().trim();
        out += n.attrs.href ? `[${t || n.attrs.href}](${n.attrs.href})` : n.attrs.id ? `<a id="${n.attrs.id}"></a>${t}` : t;
        break;
      }
      case "img": out += `![${n.attrs.alt ?? ""}](${n.attrs.src ?? ""})`; break;
      case "svg": case "script": case "style": case "title": break;
      case "span": {
        // A card's chips read as `durability device · level ephemeral`, its labels as `fields: …`.
        const c = classes(n);
        if (c.includes("lbl")) { out += `**${kids().trim()}**: `; break; }
        if (c.includes("counts")) { out += ` — ${kids().trim()}`; break; }
        out += kids() + (c.includes("chip") ? " · " : c.includes("fname") ? ", " : "");
        break;
      }
      default: out += kids();
    }
  }
  return out.replace(/ · (\s*)$/, "$1").replace(/, (\s*)$/, "$1");
}

/** A design object's anchor and kind, where an element carries them (SPEC.md's id convention). */
function anchor(e: El): string {
  if (!e.attrs.id) return "";
  const kind = e.attrs["data-kind"];
  const of = e.attrs["data-of"] ? ` of ${e.attrs["data-of"]}` : "";
  return `<a id="${e.attrs.id}"></a>${kind ? `\n<!-- ${kind}${of} -->` : ""}\n\n`;
}

function table(e: El): string {
  const rows: El[] = [];
  const walk = (n: Node) => {
    if (typeof n === "string") return;
    if (n.tag === "tr") rows.push(n);
    else n.children.forEach(walk);
  };
  walk(e);
  if (rows.length === 0) return "";
  const cellsOf = (r: El) => r.children.filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th")).map((c) => cell(inline(c.children)));
  const all = rows.map(cellsOf);
  const width = Math.max(...all.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const headed = rows[0].children.some((c) => typeof c !== "string" && c.tag === "th");
  const head = headed ? pad(all[0]) : Array(width).fill("");
  const body = headed ? all.slice(1) : all;
  return [`| ${head.join(" | ")} |`, `|${" --- |".repeat(width)}`, ...body.map((r) => `| ${pad(r).join(" | ")} |`)].join("\n") + "\n\n";
}

/** Block content as Markdown paragraphs, each ending in a blank line. */
function blocks(nodes: Node[], list = ""): string {
  let out = "";
  let run: Node[] = [];
  const flush = () => {
    const t = inline(run).trim();
    if (t) out += t + "\n\n";
    run = [];
  };
  for (const n of nodes) {
    if (typeof n === "string" || !BLOCK.has(n.tag) && n.tag !== "svg" && n.tag !== "script" && n.tag !== "head") { run.push(n); continue; }
    flush();
    out += block(n, list);
  }
  flush();
  return out;
}

/** The lines of a card's JSON tree: `key: value`, or `key [n]` with its members beneath. */
function jsonLines(nodes: Node[], indent: string): string[] {
  const lines: string[] = [];
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (n.tag === "div" && classes(n).includes("jl")) lines.push(indent + squash(textOf(n)).trim());
    else if (n.tag === "details") {
      const summary = n.children.find((s): s is El => typeof s !== "string" && s.tag === "summary");
      lines.push(indent + (summary ? squash(textOf(summary)).trim() : ""));
      lines.push(...jsonLines(n.children.filter((s) => s !== summary), indent + "  "));
    }
  }
  return lines;
}

function block(e: El, list: string): string {
  const pre = anchor(e);
  const c = classes(e);
  switch (e.tag) {
    case "head": case "style": return "";
    case "svg": return "";
    case "script": {
      // Design data a screen declares (its paths), kept; a page's code is not the document.
      if ((e.attrs.type ?? "").includes("json")) {
        const raw = e.children.filter((n): n is string => typeof n === "string").join("").trim();
        let body = raw;
        try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* kept as written */ }
        const what = e.attrs["data-kind"] ? `${e.attrs["data-kind"]}${e.attrs["data-of"] ? ` of ${e.attrs["data-of"]}` : ""}` : "data";
        return `${pre}*${what}:*\n\n\`\`\`json\n${body}\n\`\`\`\n\n`;
      }
      return "";
    }
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return `${pre}${"#".repeat(Number(e.tag[1]))} ${inline(e.children).trim()}\n\n`;
    case "p": { const t = inline(e.children).trim(); return t ? `${pre}${t}\n\n` : pre; }
    case "pre": {
      const body = textOf(e).replace(/^\n/, "").replace(/\s+$/, "");
      const lang = c.includes("mermaid") ? "mermaid" : (c.find((x) => x.startsWith("language-"))?.slice(9) ?? "");
      return `${pre}\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
    }
    case "ul": case "ol": {
      let i = 0;
      const items = e.children.filter((n): n is El => typeof n !== "string" && n.tag === "li").map((li) => {
        const mark = e.tag === "ol" ? `${++i}. ` : "- ";
        const body = blocks(li.children, list + "   ").trim().split("\n").map((l, j) => (j === 0 ? l : l ? `${list}   ${l}` : l)).join("\n");
        return `${list}${mark}${body}`;
      });
      return `${pre}${items.join("\n")}\n\n`;
    }
    case "table": return pre + table(e);
    case "details": {
      const summary = e.children.find((n): n is El => typeof n !== "string" && n.tag === "summary");
      const rest = e.children.filter((n) => n !== summary);
      const inner = blocks(rest, list).trim();
      return `${pre}<details><summary>${summary ? squash(inline(summary.children)).trim() : "more"}</summary>\n\n${inner ? inner + "\n\n" : ""}</details>\n\n`;
    }
    case "figure": {
      const caption = e.children.find((n): n is El => typeof n !== "string" && n.tag === "figcaption");
      const drawn = JSON.stringify(e).includes('"tag":"svg"');
      const inner = blocks(e.children.filter((n) => n !== caption), list).trim();
      const said = caption ? inline(caption.children).trim() : e.attrs["aria-label"] ?? "";
      const link = drawn ? ` (drawn in [ir.html](ir.html${e.attrs.id ? `#${e.attrs.id}` : ""}))` : "";
      return `${pre}${inner ? inner + "\n\n" : ""}${said || link ? `*${said || "a picture"}*${link}\n\n` : ""}`;
    }
    case "div":
      // The entity as JSON, folded in ir.html a key at a time: one block, a line a key, nested
      // keys indented under theirs.
      if (c.includes("jt")) return `${pre}\`\`\`\n${jsonLines(e.children, "").join("\n")}\n\`\`\`\n\n`;
      return pre + blocks(e.children, list);
    default:
      return pre + blocks(e.children, list);
  }
}

/** ir.html as Markdown, its source named in a do-not-edit header. */
export function irMarkdown(html: string, source = "ir.html"): string {
  const doc = parse(html);
  const md = blocks(doc.children).replace(/\n{3,}/g, "\n\n").trim();
  return `<!-- generated by pronto from ${source}: do not edit, edit ${source} -->\n\n${md}\n`;
}
