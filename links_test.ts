// pronto is published as the root of bonisoft3/pronto, so a markdown link
// that climbs out of this directory is dead there unless copybara rewrites
// it. copy.bara.sky's _pronto_link_siblings rewrites exactly the links into
// the siblings .mirror/siblings.json names, to their mirrors; a link to an
// app, the monorepo's own docs or .github has no mirror to point at, and
// reaches the published tree as a link to nothing.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SIBLINGS: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, ".mirror/siblings.json"), "utf8"),
);

// Monorepo paths the mirror carries inside itself, which copy.bara.sky moves
// there and relinks from this same file, at any depth and in either form.
const CARRIED: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, ".mirror/carried.json"), "utf8"),
);

type Link = { target: string; wikilink: boolean };

/** Relative link targets outside code, the way copybara's rewrite reads them:
 * `](target)` and `[[target#heading|label]]`, the label's bar escaped in tables. */
function links(markdown: string): Link[] {
  const prose = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/(`+)[\s\S]*?\1/g, "");
  const found: Link[] = [];
  for (const m of prose.matchAll(/\]\(([^)\s]+)/g)) {
    found.push({ target: m[1].split("#")[0], wikilink: false });
  }
  for (const m of prose.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    const target = m[1].split("|")[0].replace(/\\$/, "").split("#")[0];
    found.push({ target: extname(target) ? target : `${target}.md`, wikilink: true });
  }
  return found.filter(({ target }) =>
    target !== "" && target !== ".md" && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("/")
  );
}

/** Where a link from `file` lands, relative to ROOT, and the sibling whose
 * mirror the rewrite sends it to, if it leaves pronto for one. */
// A link is a URL path whatever the platform, so it is resolved as one.
function land(file: string, target: string): { path: string; sibling?: string; carried?: string } {
  const path = posix.normalize(posix.join(posix.dirname(file), target));
  if (path !== ".." && !path.startsWith("../")) return { path };
  const carried = Object.keys(CARRIED).find((at) => path === at || path.startsWith(`${at}/`));
  if (carried) return { path, carried: CARRIED[carried] + path.slice(carried.length) };
  const sibling = Object.keys(SIBLINGS).find((at) => path === at || path.startsWith(`${at}/`));
  return { path, sibling };
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

Deno.test("the parser reads both link forms the docs use, and skips code", () => {
  const doc = [
    "See [the guide](../omnishell/GUIDE.md#links) and",
    "[[../../omnishell/docs/data#A region's rows]], | [[../../omnishell/docs/machines#Effects\\|machines]] |",
    "and [[../../../apps/truco/docs/online-hybrid|Truco]].",
    "`[x](path)` and `[[id]]` are syntax, as is",
    "```",
    "[y](../../elsewhere.md)",
    "```",
  ].join("\n");
  assert.deepEqual(links(doc), [
    { target: "../omnishell/GUIDE.md", wikilink: false },
    { target: "../../omnishell/docs/data.md", wikilink: true },
    { target: "../../omnishell/docs/machines.md", wikilink: true },
    { target: "../../../apps/truco/docs/online-hybrid.md", wikilink: true },
  ]);
  assert.equal(land("docs/index.md", "../../omnishell/docs/terminal.md").sibling, "../omnishell");
  assert.equal(land("docs/a/b.md", "../../../../libraries/mecha/README.md").sibling, "../../libraries/mecha");
  assert.equal(land("docs/index.md", "../../../apps/truco/docs/online-hybrid.md").sibling, undefined);
  assert.deepEqual(land("docs/index.md", "../GUIDE.md"), { path: "GUIDE.md" });
  // The idioms are an app in the monorepo and a directory of the mirror; their
  // links must neither be refused nor sent to a sibling.
  assert.equal(land("docs/index.md", "../../../apps/idioms/README.md").carried, "idioms/README.md");
  assert.equal(land("AGENTS.md", "../../apps/idioms/README.md").sibling, undefined);
});

Deno.test("every relative link stays in pronto or reaches a mirrored sibling, and resolves", () => {
  const files = markdownFiles(ROOT);
  assert.ok(files.length > 0, "found no markdown under pronto");
  const broken: string[] = [];
  for (const file of files) {
    for (const { target } of links(readFileSync(join(ROOT, file), "utf8"))) {
      const { path, sibling, carried } = land(file, target);
      const leaves = path === ".." || path.startsWith("../");
      if (leaves && !sibling && !carried) {
        broken.push(`${file}: ${target} leaves pronto for a path no mirror publishes`);
      } else if (!existsSync(join(ROOT, path))) {
        broken.push(`${file}: ${target} resolves to nothing`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
