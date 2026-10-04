// pronto prerender: one real document per crawlable route per locale.
//
// Run from the repo root; both directories are read as given:
//
//   deno run --no-lock --node-modules-dir=none --allow-read --allow-write=<outDir> \
//     plugins/pronto/prerender.ts <appDir> <outDir> <origin> [<omnishellDir>]
//
// The renderer is omnishell's, read from <omnishellDir>: the installed
// omnishell's root (mise where) where pronto is installed, the sibling tree in
// the monorepo (the default), so nothing here names a path outside pronto's own
// tree.
//
// A route declaring `prerender` is addressable at (tag == i18n.default ? "" :
// "/" + i18n.locales[tag].path) + its pattern in that locale, and this writes
// <outDir>/<that address>/index.html — the layout the emitted Caddyfile's
// `try_files {path} {path}/index.html` would resolve. Nothing ships those bytes
// today: the verb renders into a temporary directory and deletes it, so what is
// graded is that every address CAN be rendered, not that a crawler is answered
// with it.
//
// The renderer is the one check-i18n already runs for every route x state x
// locale (interpreter/storybook.js), against its fixture store: the data a
// crawler should index is the screen's empty state, which is exactly what that
// store answers with. The page it writes is the app's own entry document with
// the screen's markup already in the mount, so the same URL hydrates into the
// live app for a reader.

import { parseHTML } from "npm:linkedom@0.18.4";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.5";

// The terminal's served layout, the same literal emit.cue writes the bundle
// under: shell.yaml, the entry document and the assets they reference all sit
// here, and the served tree roots where this directory does.
const SHELL = "shell";

type Route = {
  path: string;
  screen: string;
  prerender?: boolean;
  ssr?: "ssg" | "ssr" | "spa";
  paths?: Record<string, string>;
  files: { html: string; css: string };
  states?: string[];
};

type Shell = {
  app: string;
  i18n?: { default: string; locales: Record<string, { path: string }> };
  routes?: Route[];
  units?: Record<string, unknown>;
};

// linkedom's Deno-resolved types do not name the window it hands back, so its
// document is reached through the shape used here (diagrams.ts does the same).
type El = {
  textContent: string | null;
  innerHTML: string;
  outerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(sel: string): El | null;
  append(child: El): void;
  remove(): void;
};
type Doc = {
  documentElement: El;
  createElement(tag: string): El;
  getElementById(id: string): El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): El[];
};
const parse = (html: string) => (parseHTML(html) as unknown as { document: Doc }).document;

const fail = (msg: string): never => {
  console.error(msg);
  Deno.exit(1);
};

const [appArg, outArg, origin, omnishellArg] = Deno.args;
if (!appArg || !outArg || !origin) {
  fail("usage: prerender.ts <appDir> <outDir> <origin> [<omnishellDir>]");
}
const appDir = new URL(`${appArg.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`);
const outDir = new URL(`${outArg.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`);
const omnishell = omnishellArg
  ? new URL(`${omnishellArg.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`)
  : new URL("../omnishell/", import.meta.url);
const { renderStorybook } = await import(new URL("interpreter/storybook.js", omnishell).href);
const { directionOf } = await import(new URL("interpreter/fragment.js", omnishell).href);
// Absolute canonical and hreflang URLs, which is what a crawler is asked to
// compare across locales; the origin is the app's, so nothing here can guess it.
const site = new URL(origin);

const shell = parseYaml(await Deno.readTextFile(new URL(`${SHELL}/shell.yaml`, appDir))) as Shell;
const crawlable = (shell.routes ?? []).filter((r) => r.prerender);
if (crawlable.length === 0) {
  console.log("no route declares prerender; nothing written");
  Deno.exit(0);
}
const i18n = shell.i18n ?? fail("a prerendered route needs i18n: one document is written per declared locale");
const tags = Object.keys(i18n.locales);

// One read per screen rather than one per screen x locale, and the renderer
// stays synchronous.
const screenCss = new Map<string, string>();
for (const route of crawlable) {
  if (screenCss.has(route.files.css)) continue;
  screenCss.set(route.files.css, await Deno.readTextFile(new URL(route.files.css, appDir)));
}

/** The address one route answers at in one locale. A prerendered route carries
 * no :param, so this is the whole of what routeHref composes: the locale's
 * prefix, empty for the default, ahead of that locale's pattern. */
function address(route: Route, tag: string): string {
  const pattern = route.paths === undefined ? route.path : route.paths[tag];
  if (pattern === undefined) fail(`route ${route.screen} declares paths without ${tag}`);
  if (pattern.includes(":")) fail(`route ${route.screen} declares prerender and a :param pattern ${pattern}`);
  const prefixed = tag === i18n.default ? pattern : `/${i18n.locales[tag].path}${pattern}`;
  return prefixed.replace(/\/+$/, "") || "/";
}

// One DOM for the whole run, the way check-i18n holds one: the interpreter
// reads the ambient document, and the mount is emptied per render.
const document = parse('<!doctype html><html><head></head><body><div id="mount"></div></body></html>');
const global = globalThis as unknown as Record<string, unknown>;
global.document = document;
(global as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };
// The interpreter fetches every screen asset by URL against the app base; here
// that base is the app directory on disk.
global.fetch = async (url: unknown) => {
  const rel = new URL(String(url), site).pathname.replace(/^\//, "");
  return new Response(await Deno.readTextFile(new URL(rel, appDir)));
};
const mount = document.getElementById("mount")!;

const messages: Record<string, Record<string, string | Record<string, string>>> = {};
for (const tag of tags) {
  messages[tag] = JSON.parse(await Deno.readTextFile(new URL(`messages/${tag}.json`, appDir)));
}

const entryHtml = await Deno.readTextFile(new URL(`${SHELL}/index.html`, appDir));

let written = 0;
for (const route of crawlable) {
  for (const tag of tags) {
    const at = address(route, tag);
    global.location = new URL(at, site);
    // "empty" whatever the route's storyboard lists: the rows a live screen
    // would hold do not exist when the build runs, and the empty state is what
    // a crawler should index anyway.
    await renderStorybook(mount, site.href, { ...route, states: ["empty"] }, {}, shell.units ?? {}, {
      messages,
      locale: tag,
      // The whole table, not the crawlable slice: a prerendered screen links
      // to routes that are not themselves written as documents.
      routes: shell.routes,
      i18n,
    });
    const frame = mount.querySelector(".storybook .frame");
    if (!frame) fail(`route ${route.screen} rendered no frame under [${tag}]`);
    await write(at, await document_(route, tag, at, frame!.innerHTML));
    written++;
  }
}
console.log(`${written} document(s) under ${outDir.pathname}`);

/** The app's own entry document, carrying this screen's markup in its mount and
 * this locale's identity in its head. Reusing the entry rather than composing a
 * head here is what keeps the prerendered page and the live one loading the
 * same assets: the entry is where the terminal declares them. */
async function document_(route: Route, tag: string, at: string, markup: string): Promise<string> {
  const doc = parse(entryHtml);
  const head = doc.querySelector("head") ?? fail(`${SHELL}/index.html has no head`);
  const app = doc.getElementById("app") ?? fail(`${SHELL}/index.html has no #app to mount into`);

  // The entry is served from shell/, so its relative references resolve against
  // that directory; this document is served from a route's own path, at a depth
  // it cannot know, so every one of them becomes root-relative.
  for (const el of doc.querySelectorAll("[href], [src]")) {
    for (const attr of ["href", "src"]) {
      const v = el.getAttribute(attr);
      if (v?.startsWith("./")) el.setAttribute(attr, `/${SHELL}/${v.slice(2)}`);
    }
  }

  // The entry's comments explain the entry to whoever edits it. This document
  // is written by a tool and read by a crawler, and carries them once per
  // prerendered page to an audience that cannot act on them.
  const uncomment = (node: { childNodes?: El[] }) => {
    for (const child of [...(node.childNodes ?? [])]) {
      if ((child as unknown as { nodeType: number }).nodeType === 8) child.remove();
      else uncomment(child as unknown as { childNodes?: El[] });
    }
  };
  doc.documentElement.setAttribute("lang", tag);
  doc.documentElement.setAttribute("dir", directionOf(tag) ?? "ltr");
  // The entry's title is the loading placeholder the shell overwrites, and its
  // description is the app's one line in one language. This document says what
  // it is instead, in the language it is in.
  doc.querySelector("title")?.remove();
  doc.querySelector('meta[name="description"]')?.remove();
  doc.querySelector('link[rel="canonical"]')?.remove();
  const ogUrl = doc.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute("content", new URL(at, site).href);
  const heading = doc.createElement("title");
  const h1 = parse(`<body>${markup}</body>`).querySelector("h1");
  if (!h1) fail(`route ${route.screen} renders no h1 under [${tag}], so the document has no title`);
  heading.textContent = `${h1!.textContent?.trim()} — ${shell.app}`;
  head.append(heading);

  const link = (rel: string, href: string, hreflang?: string) => {
    const el = doc.createElement("link");
    el.setAttribute("rel", rel);
    el.setAttribute("href", href);
    if (hreflang) el.setAttribute("hreflang", hreflang);
    head.append(el);
  };
  link("canonical", new URL(at, site).href);
  for (const other of tags) link("alternate", new URL(address(route, other), site).href, other);
  // x-default names the default locale's unprefixed address: what a crawler is
  // told to serve a reader whose language matches no alternate.
  link("alternate", new URL(address(route, i18n.default), site).href, "x-default");
  // The screen's own stylesheet rides inline, the way interpretScreen injects
  // it in the live app, because a screen CSS opens with `@import url("shared/
  // ...")` and an @import inside a LINKED sheet resolves against that sheet's
  // own URL rather than the document's <base href="/shell/">. Linked, it would
  // reach for /shell/screens/shared/… and the shared stylesheet would be
  // missing from the one document a crawler reads.
  const style = doc.createElement("style");
  style.textContent = screenCss.get(route.files.css)!;
  head.append(style);

  // Materialized SSR (M-SSR) dual-witness metadata:
  // pronto-cas: Content-addressed structural hash of the rendered screen markup.
  // pronto-lsn: Monotonic data clock sequence number (0 for static build-time SSG).
  const casBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markup));
  const casHash = Array.from(new Uint8Array(casBuf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

  const metaCas = doc.createElement("meta");
  metaCas.setAttribute("name", "pronto-cas");
  metaCas.setAttribute("content", casHash);
  head.append(metaCas);

  const metaLsn = doc.createElement("meta");
  metaLsn.setAttribute("name", "pronto-lsn");
  metaLsn.setAttribute("content", "0");
  head.append(metaLsn);

  const stateScript = doc.createElement("script");
  stateScript.setAttribute("id", "__PRONTO_STATE__");
  stateScript.setAttribute("type", "application/json");
  stateScript.textContent = JSON.stringify({ lsn: 0, cas: casHash });
  head.append(stateScript);

  // The entry boots with a config path relative to the document, which resolves
  // under shell/ there and under this route's path here. The call is the same
  // one, with the address the config actually has.
  doc.querySelector("script[type=module][src]")?.remove();
  const boot = doc.createElement("script");
  boot.setAttribute("type", "module");
  boot.textContent = `import { createShell } from "/omnishell/interpreter/shell.js";\n` +
    `createShell({ config: "/${SHELL}/shell.yaml", mount: document.getElementById("app") });\n`;
  doc.querySelector("body")!.append(boot);

  app.innerHTML = markup;
  // Last, so the screen's own comments go with the entry's: the markup is
  // injected above and carries the rationale its author wrote for the next
  // author.
  uncomment(doc.documentElement as unknown as { childNodes?: El[] });
  return `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
}

async function write(at: string, html: string) {
  const dir = new URL(`.${at}/`, outDir);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(new URL("index.html", dir), html);
}
