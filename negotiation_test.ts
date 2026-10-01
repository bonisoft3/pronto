// The door and the terminal must choose the same language, or a reader is
// redirected to one page and shown another.
//
// They cannot share code: negotiateLocale runs in a browser against
// navigator.languages, and the door runs in caddy against the Accept-Language
// header the browser builds from that same ordered list. What they share is
// the RULE — first declared tag, exact before bare language — and the door's
// half of it is a regex this compiler emits. So the emitted Caddyfile is read
// back here, its matchers are run as caddy would run them, and every answer is
// held against the function.
//
// Reading the artifact rather than recomposing it is the point: a rule
// rewritten here could drift from the one that ships and the test would still
// pass.
import { strict as assert } from "node:assert";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.5";
import { negotiateLocale } from "../omnishell/interpreter/fragment.js";

type I18n = { default: string; locales: Record<string, { path: string }> };
type Door = { name: string; i18n: I18n; caddyfile: string };

/** Every app whose door negotiates. The rule under test belongs to the
 * EMITTER, so one app cannot stand for it: a regression that only shows where
 * two locales share a language is invisible in an app whose locales do not. */
const APPS = new URL("../../apps/", import.meta.url);
const doors: Door[] = [];
for await (const entry of Deno.readDir(APPS)) {
  if (!entry.isDirectory) continue;
  const app = new URL(`${entry.name}/`, APPS);
  let shell: { i18n?: I18n };
  try {
    shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", app))) as { i18n?: I18n };
  } catch {
    continue;
  }
  if (shell.i18n === undefined || Object.keys(shell.i18n.locales ?? {}).length <= 1) continue;
  doors.push({
    name: entry.name,
    i18n: shell.i18n,
    caddyfile: await Deno.readTextFile(new URL("docker/Caddyfile", app)),
  });
}
if (doors.length === 0) throw new Error("no app declares i18n, so this file grades nothing");

/** The door, as emitted: one capture naming the first declared tag, then a
 * branch per locale saying which captures mean it. */
function door({ i18n, caddyfile }: Door, header: string): string {
  const alternation = caddyfile.match(/header_regexp lang Accept-Language \((\?i)\)(.+)$/m);
  if (!alternation) throw new Error("the Caddyfile emits no Accept-Language capture");
  const capture = header.match(new RegExp(alternation[2], "i"));
  if (capture === null) return i18n.default;
  // `@<screen>_<path> { ... vars_regexp {re.lang.1} (?i)^(<captures>)$ }`, and
  // the locale is the one whose served prefix that matcher is named for.
  for (const [, prefix, captures] of caddyfile.matchAll(/@\w+_([\w-]+) \{[^}]*?vars_regexp \{re\.lang\.1\} \(\?i\)\^\(([^)]+)\)\$/gs)) {
    if (!new RegExp(`^(${captures})$`, "i").test(capture[1])) continue;
    const tag = Object.entries(i18n.locales).find(([, l]) => l.path === prefix)?.[0];
    if (tag === undefined) throw new Error(`the Caddyfile redirects to /${prefix}, which names no declared locale`);
    return tag;
  }
  return i18n.default;
}

/** navigator.languages as the browser would have it for a header it sent:
 * the same ordered list, without the q-values neither side reads. */
const asLanguages = (header: string) =>
  header.split(",").map((part) => part.split(";")[0].trim()).filter((tag) => tag !== "");

// Every case here is a real shape: a plain browser, a browser with a fallback
// chain, a region subtag that spells another language (en-ES is English in
// Spain, not Spanish), a language subtag in caps (the header is defined
// case-insensitively), and a region with no ISO 3166 spelling (es-419).
const CORPUS = [
  "pt-BR,pt;q=0.9",
  "es-ES,es;q=0.9",
  "en-US,en;q=0.9,es;q=0.5",
  "de,es;q=0.9",
  "en-es,en;q=0.9",
  "ES-ES",
  "es-419",
  "pt-PT,pt;q=0.9",
  "fr,en;q=0.9,es;q=0.8",
  "zh-CN",
  "en",
  "es",
  "pt",
  "",
]

Deno.test("the door and the terminal read every header the same way", () => {
  for (const app of doors) {
    for (const header of CORPUS) {
      assert.equal(
        door(app, header),
        negotiateLocale(app.i18n, asLanguages(header)) ?? app.i18n.default,
        `${app.name} disagreed on "${header}"`,
      );
    }
  }
});

function alternation({ caddyfile }: Door): string[] {
  const found = caddyfile.match(/header_regexp lang Accept-Language \(\?i\)\(\?:\^\|,\)\\s\*\(([^)]+)\)/);
  if (!found) throw new Error("the Caddyfile emits no Accept-Language capture");
  return found[1].split("|");
}

Deno.test("the emitted alternation offers every declared tag and every bare language", () => {
  for (const app of doors) {
    const offered = new Set(alternation(app));
    for (const tag of Object.keys(app.i18n.locales)) {
      // A tag missing here is a language the door cannot see, so its reader is
      // never moved and lands on an address in somebody else's language.
      assert.equal(offered.has(tag), true, `${app.name}: the capture never offers ${tag}`);
      const bare = tag.split("-")[0];
      assert.equal(offered.has(bare), true, `${app.name}: the capture never offers the bare ${bare}`);
    }
  }
});

Deno.test("every tag is offered ahead of its own bare language", () => {
  // Go's alternation is leftmost-FIRST, so `pt` written before `pt-BR` captures
  // `pt` out of `pt-BR` and the exact tag is never reached. It costs nothing
  // where both mean one locale, which is why the corpus above cannot see it,
  // and silently picks the wrong one as soon as an app declares two locales
  // sharing a language. No app does today; the sweep is what makes the first
  // one that does fail here rather than in a reader's browser.
  for (const app of doors) {
    const order = alternation(app);
    for (const tag of Object.keys(app.i18n.locales)) {
      const bare = tag.split("-")[0];
      if (bare === tag) continue;
      assert.equal(
        order.indexOf(tag) < order.indexOf(bare),
        true,
        `${app.name}: ${bare} is offered before ${tag}, so ${tag} can never be captured`,
      );
    }
  }
});
