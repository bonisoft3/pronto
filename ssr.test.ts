// A route rendered on request (#Screen.ssr), asked of cue over testdata/emit's
// #ssrCase: the door sends its addresses to the terminal's renderer, the
// renderer reads the app through the door, and a route whose top-level reads
// are anyone's but everyone's is refused, because its document would be
// somebody's and only a document for no one in particular can be served to
// all. A value that fails to evaluate cannot sit in the package `cue vet`
// holds, so the cases are exported one by one.

import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./testdata/emit", import.meta.url));

function exported(expr: string, text: boolean): { ok: boolean; out: string } {
  const out = new Deno.Command("cue", { args: ["export", "read.cue", "ssr.cue", "installed-surface.cue", "-e", expr, ...(text ? ["--out", "text"] : [])], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
  return { ok: out.success, out: new TextDecoder().decode(out.success ? out.stdout : out.stderr) };
}

const ask = (reads: string, field: string) => exported(`(#ssrCase & {reads: [${reads}]}).${field}`, field === "caddyfile");

const note = (extra = "") => `#view & {table: "note", clauses: [{col: "id", op: "eq"}]${extra}}`;

Deno.test("a public route's addresses reach the renderer, ahead of the entry", () => {
  const { ok, out } = ask("_view", "caddyfile");
  if (!ok) throw new Error(out);
  const rendered = out.indexOf("@rendered {\n      path /jogo/* /jogo/*/\n");
  if (out.indexOf("handle @rendered {\n      reverse_proxy {$PRONTO_UPSTREAM_RENDER:render:8090} {", rendered) < 0) throw new Error(`no renderer route:\n${out}`);
  if (rendered < 0) throw new Error(`no renderer route:\n${out}`);
  if (rendered > out.indexOf("rewrite @route")) throw new Error("the entry's rewrite answers before the renderer does");
});

// Each upstream is dialed at its own PRONTO_UPSTREAM_<SERVICE> when set: a k8s
// release sets every one to the caddy pod's Dapr sidecar, which routes by
// dapr-app-id, and a gcp release to the service's own localhost port in the
// shared Cloud Run instance. Regression guard: an upstream spelled as a bare
// host:port, or missing the header, bypasses the mesh on k8s and the sidecar on
// gcp; one naming another service reaches the wrong one.
Deno.test("every upstream the door dials is its own variable's when set, naming its service", () => {
  const { ok, out } = ask("_view", "caddyfile");
  if (!ok) throw new Error(out);
  const proxies = [...out.matchAll(/^\s*(reverse_proxy|forward_auth)\b(.*)$/gm)];
  if (!proxies.some((m) => m[2].includes("render:"))) throw new Error(`no renderer upstream:\n${out}`);
  for (const m of proxies) {
    const spelled = m[2].match(/^ \{\$PRONTO_UPSTREAM_([A-Z0-9_]+):([a-z0-9-]+):\d+\} \{$/);
    if (!spelled) throw new Error(`${m[0].trim()} dials past its variable`);
    if (spelled[1] !== spelled[2].toUpperCase().replaceAll("-", "_")) throw new Error(`${m[0].trim()} names another service's variable`);
    const next = out.slice(m.index! + m[0].length).split("\n").slice(1, 4).map((l) => l.trim());
    if (!next.includes(`header_up dapr-app-id ${spelled[2]}`)) throw new Error(`${m[0].trim()} names no dapr-app-id ${spelled[2]}`);
  }
});

Deno.test("the renderer reads through the door, as a guest would", () => {
  // Through caddy's /electric, under the shape gate, and never electric:3000
  // with a service token: what makes a document cacheable by anyone is that
  // it holds nothing a stranger could not read.
  const { ok, out } = ask("_view", "render.compose");
  if (!ok) throw new Error(out);
  const compose = JSON.parse(out);
  if (compose.environment?.DOOR !== "http://caddy:8080") throw new Error(`DOOR is ${compose.environment?.DOOR}`);
  if (/electric:3000|SERVICE_JWT|ELECTRIC_SECRET/.test(out)) throw new Error(`the renderer is handed a way past the gate:\n${out}`);
});

// The renderer reads the app once, as it starts: its routes and catalogues
// through the door, its entry off its own image. Regression: the image held
// the entry alone, so a deploy rolling the door's files left a renderer
// drawing the old templates and words, and answering 404 at a route the new
// door sent it; and a develop edit to the entry reached the door, which
// restarts the renderer with it, but not the entry the renderer read.
Deno.test("the renderer's image holds every file it reads, and an edit to its entry restarts it", () => {
  const render = ask("_view", "render");
  const statics = ask("_view", "statics");
  for (const r of [render, statics]) if (!r.ok) throw new Error(r.out);
  const { srcs, compose } = JSON.parse(render.out);
  const read = (JSON.parse(statics.out) as { file: string; target: string }[])
    .filter((s) => s.target.startsWith("/srv/shell/") || s.target.startsWith("/srv/messages/"));
  if (!read.some((s) => s.target === "/srv/shell/shell.json")) throw new Error(`no shell.json among the statics:\n${statics.out}`);
  const missing = read.filter((s) => !srcs.globs.includes(s.file)).map((s) => s.file);
  if (missing.length > 0) throw new Error(`the renderer's image misses ${missing.join(", ")}`);
  const entry = { action: "sync+restart", path: "../shell/index.html", target: "/render/entry.html" };
  if (!compose.develop?.watch?.some((w: typeof entry) => JSON.stringify(w) === JSON.stringify(entry))) {
    throw new Error(`no edit to the entry restarts the renderer:\n${JSON.stringify(compose.develop)}`);
  }
});

Deno.test("a route over a private top-level read is refused, naming what is pending", () => {
  const { ok, out } = ask(note(), "caddyfile");
  if (ok) throw new Error("rendered a private read on request");
  if (!/screen jogo declares ssr: "ssr" over Note \(private\).*PENDING\.md#screens/s.test(out)) throw new Error(out);
});

Deno.test("a private read nested under a public row does not decide the route", () => {
  // It reads under whoever the enclosing row is rendered for, which on the
  // server is a guest who owns nothing.
  const { ok, out } = ask(`_view, ${note(", nested: true")}`, "caddyfile");
  if (!ok || !out.includes("@rendered {\n      path /jogo/*")) throw new Error(out);
});

// A document rendered before any request named no canonical and no
// alternates, since nothing at generate knows the origin they are absolute
// against. The door does, and the sitemap already asks it.
//
// The origin is the deployment's, stated once: the door answered any Host and
// composed the origin from it, so a client chose what a document anyone may
// keep spelled (caddy-origin.integration.test.ts runs it).
Deno.test("the door and the renderer spell the one origin the cluster states, and no request's", () => {
  const ssg = exported("{origin: #ssgCase.origin, doorEnv: #ssgCase.doorEnv, document: #ssgCase.document, robots: #ssgCase.robots, sitemap: #ssgCase.sitemap, caddyfile: #ssgCase.caddyfile}", false);
  const render = ask("_view", "render.compose");
  for (const r of [ssg, render]) if (!r.ok) throw new Error(r.out);
  const { origin, doorEnv, document, robots, sitemap, caddyfile } = JSON.parse(ssg.out);
  if (origin !== "${ORIGIN:-https://localhost:${CADDY_TLS_HOST_PORT}}") throw new Error(`the cluster states the origin ${origin}`);
  if (doorEnv.ORIGIN !== origin) throw new Error(`the door is handed ${doorEnv.ORIGIN}`);
  if (JSON.parse(render.out).environment?.ORIGIN !== origin) throw new Error(`the renderer is handed ${render.out}`);
  if (!caddyfile.includes("\n  vars origin {$ORIGIN}\n")) throw new Error(`the door holds no origin:\n${caddyfile}`);
  const declare = '{{- $o := placeholder "http.vars.origin" -}}';
  for (const [name, text] of [["document", document.data.declare], ["robots.txt", robots], ["sitemap.xml", sitemap]]) {
    if (!text.startsWith(declare)) throw new Error(`${name} declares ${text.split("\n")[0]}`);
    if (/\.Req\b|http\.request/.test(text)) throw new Error(`${name} reads the request:\n${text}`);
  }
});
Deno.test("a prerendered document is a template the door answers with the sitemap's origin", () => {
  const document = exported("#ssgCase.document", false);
  const sitemap = exported("#ssgCase.sitemap", true);
  const caddyfile = exported("#ssgCase.caddyfile", true);
  for (const r of [document, sitemap, caddyfile]) if (!r.ok) throw new Error(r.out);
  const { data } = JSON.parse(document.out);
  if (sitemap.out.split("\n")[0] !== data.declare) throw new Error(`the document declares ${data.declare}, the sitemap ${sitemap.out.split("\n")[0]}`);
  if (!sitemap.out.includes(`<loc>${data.origin}/regras</loc>`)) throw new Error(`the document spells the origin ${data.origin}:\n${sitemap.out}`);
  const handle = caddyfile.out.indexOf("@document path /regras /regras/\n    handle @document {");
  const block = caddyfile.out.slice(handle, caddyfile.out.indexOf("\n    }\n", handle));
  // Through the asset's `templated`, the crawler files' route: a bare
  // `templates` deleted the file's ETag, so every revalidation of an unchanged
  // document carried the whole of it.
  if (handle < 0 || !block.endsWith("\n      import templated text/html")) throw new Error(`no templated document route:\n${caddyfile.out}`);
  if (!caddyfile.out.includes("(templated) {")) throw new Error("the document route imports a snippet the Caddyfile does not define");
  if (handle > caddyfile.out.indexOf("rewrite @route")) throw new Error("the entry's rewrite answers before the document does");
});

// A file_server outside `(files)` answers with Caddy's own ETag, mtime and size,
// which clamped image mtimes reduce to size (caddy-etag.integration.test.ts).
Deno.test("every file the door serves is answered with its validator", () => {
  const caddyfile = exported("#ssgCase.caddyfile", true);
  if (!caddyfile.ok) throw new Error(caddyfile.out);
  const servers = caddyfile.out.split("\n").filter((l) => /^\s*file_server\b/.test(l));
  if (servers.length !== 1 || !/\(files\) \{\n\s*file_server \{\n\s*etag_file_extensions \.etag\n\s*hide \*\.etag\n/.test(caddyfile.out)) throw new Error(`a file_server reads no validator:\n${caddyfile.out}`);
});

// A prerendered document is drawn before any read lands, so rows the server
// holds fill its empty lists once the shell takes it over and push down what
// follows them: golaberto's /campeonatos measured a layout shift of 0.12 so.
Deno.test("a route prerendered over rows the server holds is refused, naming them", () => {
  for (const read of [note(", nested: true"), "_view"]) {
    const { ok, out } = exported(`(#ssgCase & {reads: [${read}]}).caddyfile`, true);
    if (ok) throw new Error(`prerendered over ${read}`);
    if (!/screen regras is prerendered over rows the server holds \((Note|Goal)\).*declare ssr: "ssr"/s.test(out)) throw new Error(out);
  }
});

Deno.test("a route prerendered over the browser's rows is left to the terminal's renderer", () => {
  // Its document draws a tab or device region from the row the markup names
  // for it until its read lands, which only the markup says: the renderer
  // refuses one that names none (omnishell's document.test.ts).
  const { ok, out } = exported(`(#ssgCase & {reads: [#view & {table: "draft", clauses: [{col: "id", op: "eq"}]}]}).caddyfile`, true);
  if (!ok || !out.includes("@document path /regras /regras/")) throw new Error(out);
});

Deno.test("the deployed review page carries its relative IR stylesheet", () => {
  const r = ask("_view", "statics");
  if (!r.ok) throw new Error(r.out);
  const statics = JSON.parse(r.out) as { file: string; target: string }[];
  for (const file of ["ir.html", "ir/card.css"]) {
    if (!statics.some((s) => s.file === file && s.target === `/srv/docs/${file}`)) {
      throw new Error(`missing deployed review asset ${file}`);
    }
  }
});

Deno.test("a screen's access and ssr derive from its top-level regions and govern rendering and crawlability", () => {
  // Open + public server read -> access: "public", ssr: "ssr", in sitemap and @rendered.
  const open = exported("(#accessCase & {reads: [_view]}).out", false);
  if (!open.ok) throw new Error(open.out);
  const openData = JSON.parse(open.out);
  if (openData.screen.access !== "public" || openData.screen.ssr !== "ssr") throw new Error(open.out);
  if (openData.shellRoute.access !== undefined || openData.shellRoute.ssr !== "ssr") throw new Error(open.out);
  if (!openData.caddyfile.includes("@rendered {\n      path /jogos /jogos/")) throw new Error(openData.caddyfile);
  if (!openData.sitemap.includes("/jogos</loc>")) throw new Error(openData.sitemap);

  // Mixed top-level reads (public + private) -> access: "public", ssr: "ssr" (renders public regions, leaves private to data-empty).
  const mixed = exported(`(#accessCase & {reads: [_view, ${note()}]}).out`, false);
  if (!mixed.ok) throw new Error(mixed.out);
  const mixedData = JSON.parse(mixed.out);
  if (mixedData.screen.access !== "public" || mixedData.screen.ssr !== "ssr") throw new Error(mixed.out);
  if (!mixedData.caddyfile.includes("@rendered {\n      path /jogos /jogos/")) throw new Error(mixedData.caddyfile);
  if (!mixedData.sitemap.includes("/jogos</loc>")) throw new Error(mixedData.sitemap);

  // Purely restricted top-level reads -> access: "private", ssr: "spa", omitted from @rendered and sitemap.xml.
  const priv = exported(`(#accessCase & {reads: [${note()}]}).out`, false);
  if (!priv.ok) throw new Error(priv.out);
  const privData = JSON.parse(priv.out);
  if (privData.screen.access !== "private" || privData.screen.ssr !== "spa") throw new Error(priv.out);
  if (privData.shellRoute.access !== "private" || privData.shellRoute.ssr !== "spa") throw new Error(priv.out);
  if (privData.caddyfile.includes("@rendered")) throw new Error(privData.caddyfile);
  if (privData.sitemap.includes("/jogos</loc>")) throw new Error(privData.sitemap);

  // Explicit access: "private" override on an open or mixed screen -> derives ssr: "spa" and omits from sitemap.xml.
  const overridden = exported('(#accessCase & {reads: [_view], extra: {access: "private"}}).out', false);
  if (!overridden.ok) throw new Error(overridden.out);
  const overData = JSON.parse(overridden.out);
  if (overData.screen.access !== "private" || overData.screen.ssr !== "spa") throw new Error(overridden.out);
  if (overData.shellRoute.access !== "private" || overData.shellRoute.ssr !== "spa") throw new Error(overridden.out);
  if (overData.caddyfile.includes("@rendered")) throw new Error(overData.caddyfile);
  if (overData.sitemap.includes("/jogos</loc>")) throw new Error(overData.sitemap);

  // Inconsistent overrides are refused.
  const pubOverPriv = exported(`(#accessCase & {reads: [${note()}], extra: {access: "public"}}).out.caddyfile`, true);
  if (pubOverPriv.ok || !/screen jogo declares access: "public" over Note \(private\)/.test(pubOverPriv.out)) {
    throw new Error(pubOverPriv.out);
  }
  const ssrOverPriv = exported('(#accessCase & {reads: [_view], extra: {access: "private", ssr: "ssr"}}).out.caddyfile', true);
  if (ssrOverPriv.ok || !/screen jogo is private and declares ssr: "ssr"/.test(ssrOverPriv.out)) {
    throw new Error(ssrOverPriv.out);
  }
});
