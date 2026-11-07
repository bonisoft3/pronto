// A route rendered on request (#Screen.ssr), asked of cue over testdata/emit's
// #ssrCase: the door sends its addresses to the terminal's renderer, the
// renderer reads the app through the door, and a route whose top-level reads
// are anyone's but everyone's is refused, because its document would be
// somebody's and only a document for no one in particular can be served to
// all. A value that fails to evaluate cannot sit in the package `cue vet`
// holds, so the cases are exported here.

import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./testdata/emit", import.meta.url));
const cache = new Map<string, Promise<{ ok: boolean; out: string }>>();

function exported(expr: string, text: boolean): Promise<{ ok: boolean; out: string }> {
  const key = `${text ? "t" : "j"}:${expr}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = new Deno.Command("cue", {
      args: ["export", "read-case.cue", "ssr.cue", "installed-surface.cue", "-e", expr, ...(text ? ["--out", "text"] : [])],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output().then((out) => ({
      ok: out.success,
      out: new TextDecoder().decode(out.success ? out.stdout : out.stderr),
    }));
    cache.set(key, pending);
  }
  return pending;
}

const ask = (reads: string, field: string) => exported(`(#ssrCase & {reads: [${reads}]}).${field}`, field === "caddyfile" || field === "brief");

const note = (extra = "") => `#view & {table: "note", clauses: [{col: "id", op: "eq"}]${extra}}`;

const ssrView = () =>
  exported("{caddyfile: #ssrView.caddyfile, brief: #ssrView.brief, render: #ssrView.render, statics: #ssrView.statics}", false);
const ssgDefault = () =>
  exported(
    "{origin: #ssgCase.origin, doorEnv: #ssgCase.doorEnv, document: #ssgCase.document, robots: #ssgCase.robots, sitemap: #ssgCase.sitemap, caddyfile: #ssgCase.caddyfile}",
    false,
  );

Deno.test("a public route's addresses reach the renderer, ahead of the entry", async () => {
  const r = await ssrView();
  if (!r.ok) throw new Error(r.out);
  const { caddyfile: out } = JSON.parse(r.out) as { caddyfile: string };
  const rendered = out.indexOf("@rendered {\n      expression");
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
Deno.test("every upstream the door dials is its own variable's when set, naming its service", async () => {
  const r = await ssrView();
  if (!r.ok) throw new Error(r.out);
  const { caddyfile: out } = JSON.parse(r.out) as { caddyfile: string };
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

Deno.test("the renderer reads through the door, as a guest would", async () => {
  // Through caddy's /electric, under the shape gate, and never electric:3000
  // with a service token: what makes a document cacheable by anyone is that
  // it holds nothing a stranger could not read.
  const r = await ssrView();
  if (!r.ok) throw new Error(r.out);
  const { render: { compose } } = JSON.parse(r.out);
  const out = JSON.stringify(compose);
  if (compose.environment?.DOOR !== "http://caddy:8080") throw new Error(`DOOR is ${compose.environment?.DOOR}`);
  if (/electric:3000|SERVICE_JWT|ELECTRIC_SECRET/.test(out)) throw new Error(`the renderer is handed a way past the gate:\n${out}`);
});

// The renderer reads the app once, as it starts: its routes and catalogues
// through the door, its entry off its own image. Regression: the image held
// the entry alone, so a deploy rolling the door's files left a renderer
// drawing the old templates and words, and answering 404 at a route the new
// door sent it; and a develop edit to the entry reached the door, which
// restarts the renderer with it, but not the entry the renderer read.
Deno.test("the renderer's image holds every file it reads, and an edit to its entry restarts it", async () => {
  const r = await ssrView();
  if (!r.ok) throw new Error(r.out);
  const { render: { srcs, compose }, statics } = JSON.parse(r.out);
  const read = (statics as { file: string; target: string }[])
    .filter((s) => s.target.startsWith("/srv/shell/") || s.target.startsWith("/srv/messages/"));
  if (!read.some((s) => s.target === "/srv/shell/shell.json")) throw new Error(`no shell.json among the statics:\n${JSON.stringify(statics)}`);
  const missing = read.filter((s) => !srcs.globs.includes(s.file)).map((s) => s.file);
  if (missing.length > 0) throw new Error(`the renderer's image misses ${missing.join(", ")}`);
  const entry = { action: "sync+restart", path: "../shell/index.html", target: "/render/entry.html" };
  if (!compose.develop?.watch?.some((w: typeof entry) => JSON.stringify(w) === JSON.stringify(entry))) {
    throw new Error(`no edit to the entry restarts the renderer:\n${JSON.stringify(compose.develop)}`);
  }
});

Deno.test("a route over a private top-level read is refused, naming what is pending", async () => {
  const { ok, out } = await ask(note(), "caddyfile");
  if (ok) throw new Error("rendered a private read on request");
  if (!/screen jogo declares ssr: "ssr" over Note \(private\).*PENDING\.md#screens/s.test(out)) throw new Error(out);
});

Deno.test("a private read nested under a public row does not decide the route", async () => {
  // It reads under whoever the enclosing row is rendered for, which on the
  // server is a guest who owns nothing.
  const { ok, out } = await ask(`_view, ${note(", nested: true")}`, "caddyfile");
  if (!ok || !out.includes("@rendered {\n      expression")) throw new Error(out);
});

// A document rendered before any request named no canonical and no
// alternates, since nothing at generate knows the origin they are absolute
// against. The door does, and the sitemap already asks it.
//
// The origin is the deployment's, stated once: the door answered any Host and
// composed the origin from it, so a client chose what a document anyone may
// keep spelled (caddy-origin.integration.test.ts runs it).
Deno.test("the door and the renderer spell the one origin the cluster states, and no request's", async () => {
  const [ssg, view] = await Promise.all([ssgDefault(), ssrView()]);
  for (const r of [ssg, view]) if (!r.ok) throw new Error(r.out);
  const { origin, doorEnv, document, robots, sitemap, caddyfile } = JSON.parse(ssg.out);
  const { render } = JSON.parse(view.out);
  if (origin !== "${ORIGIN:-https://localhost:${CADDY_TLS_HOST_PORT}}") throw new Error(`the cluster states the origin ${origin}`);
  if (doorEnv.ORIGIN !== origin) throw new Error(`the door is handed ${doorEnv.ORIGIN}`);
  if (render.compose.environment?.ORIGIN !== origin) throw new Error(`the renderer is handed ${JSON.stringify(render.compose)}`);
  if (!caddyfile.includes("\n  vars origin {$ORIGIN}\n")) throw new Error(`the door holds no origin:\n${caddyfile}`);
  const declare = '{{- $o := placeholder "http.vars.origin" -}}';
  for (const [name, text] of [["document", document.data.declare], ["robots.txt", robots], ["sitemap.xml", sitemap]]) {
    if (!text.startsWith(declare)) throw new Error(`${name} declares ${text.split("\n")[0]}`);
    if (/\.Req\b|http\.request/.test(text)) throw new Error(`${name} reads the request:\n${text}`);
  }
});
Deno.test("a prerendered document is a template the door answers with the sitemap's origin", async () => {
  const ssg = await ssgDefault();
  if (!ssg.ok) throw new Error(ssg.out);
  const { document: { data }, sitemap, caddyfile } = JSON.parse(ssg.out);
  if (sitemap.split("\n")[0] !== data.declare) throw new Error(`the document declares ${data.declare}, the sitemap ${sitemap.split("\n")[0]}`);
  if (!sitemap.includes(`<loc>${data.origin}/regras</loc>`)) throw new Error(`the document spells the origin ${data.origin}:\n${sitemap}`);
  const handle = caddyfile.indexOf("@document path /regras /regras/\n    handle @document {");
  const block = caddyfile.slice(handle, caddyfile.indexOf("\n    }\n", handle));
  // Through the asset's `templated`, the crawler files' route: a bare
  // `templates` deleted the file's ETag, so every revalidation of an unchanged
  // document carried the whole of it.
  if (handle < 0 || !block.endsWith("\n      import templated text/html")) throw new Error(`no templated document route:\n${caddyfile}`);
  if (!caddyfile.includes("(templated) {")) throw new Error("the document route imports a snippet the Caddyfile does not define");
  if (handle > caddyfile.indexOf("rewrite @route")) throw new Error("the entry's rewrite answers before the document does");
});

// A release file_server outside `(files-release)` answers with Caddy's own ETag, mtime and size,
// which clamped image mtimes reduce to size (caddy-etag.integration.test.ts).
Deno.test("release files retain content validators by default", async () => {
  const ssg = await ssgDefault();
  if (!ssg.ok) throw new Error(ssg.out);
  const { caddyfile } = JSON.parse(ssg.out) as { caddyfile: string };
  const servers = caddyfile.split("\n").filter((l) => /^\s*file_server\b/.test(l));
  if (!caddyfile.includes("import files-{$PRONTO_FILE_MODE:release}")) throw new Error("release validators are not the default");
  if (servers.length !== 2 || !/\(files-release\) \{\n\s*file_server \{\n\s*etag_file_extensions \.etag\n\s*hide \*\.etag\n/.test(caddyfile)) throw new Error(`release file serving lost its content validator:\n${caddyfile}`);
});

Deno.test("the door advertises h3 on its published host port over both TCP and UDP", async () => {
  const ssg = await ssgDefault();
  if (!ssg.ok) throw new Error(ssg.out);
  const { caddyfile } = JSON.parse(ssg.out) as { caddyfile: string };
  if (/20879/.test(caddyfile)) {
    throw new Error(`the Caddyfile hardcodes an app port in Alt-Svc:\n${caddyfile}`);
  }
  if (!/https:\/\/localhost:\{\$CADDY_DOOR_PORT:8443\} \{\n\s*tls \{\$CADDY_TLS:internal\}\n\s*header Alt-Svc `h3=":\{\$CADDY_TLS_HOST_PORT:8443\}"; ma=2592000`\n/.test(caddyfile)) {
    throw new Error(`https://localhost:{$CADDY_DOOR_PORT:8443} does not advertise h3 on CADDY_TLS_HOST_PORT:\n${caddyfile}`);
  }
});

// A prerendered document is drawn before any read lands, so rows the server
// holds fill its empty lists once the shell takes it over and push down what
// follows them: golaberto's /campeonatos measured a layout shift of 0.12 so.
Deno.test("a route prerendered over rows the server holds is refused, naming them", async () => {
  const reads = [note(", nested: true"), "_view"] as const;
  const results = await Promise.all(
    reads.map(async (read) => [read, await exported(`(#ssgCase & {reads: [${read}]}).caddyfile`, true)] as const),
  );
  for (const [read, { ok, out }] of results) {
    if (ok) throw new Error(`prerendered over ${read}`);
    if (!/screen regras is prerendered over rows the server holds \((Note|Goal)\).*declare ssr: "ssr"/s.test(out)) throw new Error(out);
  }
});

Deno.test("a route prerendered over the browser's rows is left to the terminal's renderer", async () => {
  // Its document draws a tab or device region from the row the markup names
  // for it until its read lands, which only the markup says: the renderer
  // refuses one that names none (omnishell's document.test.ts).
  const { ok, out } = await exported(`(#ssgCase & {reads: [#view & {table: "draft", clauses: [{col: "id", op: "eq"}]}]}).caddyfile`, true);
  if (!ok || !out.includes("@document path /regras /regras/")) throw new Error(out);
});

// The ladder's pages answer with their own policy: the terminal's Trusted Types
// and eval are its runtime's, and the brief's page needs the pinned library and
// its one inline script admitted. Regression guard: a policy on the whole site
// blocked every script on /docs/, and a hash computed over anything but the
// exact script text blocks the page it means to admit.
Deno.test("the ladder answers with its own policy, and brief.html's library and script are what it admits", async () => {
  const r = await ssrView();
  if (!r.ok) throw new Error(r.out);
  const { caddyfile: caddyOut, brief: briefOut } = JSON.parse(r.out) as { caddyfile: string; brief: string };
  if (!caddyOut.includes("@terminal not path /docs/*")) throw new Error(`the terminal's policy reaches the ladder:\n${caddyOut}`);
  const ladder = /@ladder path \/docs\/\*\n\s*header @ladder Content-Security-Policy "([^"]*)"/.exec(caddyOut);
  if (ladder === null) throw new Error(`no ladder policy:\n${caddyOut}`);
  if (ladder[1].includes("trusted-types") || ladder[1].includes("unsafe-eval")) throw new Error(`the ladder inherits the terminal's runtime rules: ${ladder[1]}`);
  const library = /<script src="(https:\/\/cdn\.jsdelivr\.net\/npm\/marked@[^/]+\/lib\/marked\.umd\.js)" integrity="(sha384-[^"]+)" crossorigin="anonymous" defer>/.exec(briefOut);
  if (library === null) throw new Error(`brief.html names no pinned library:\n${briefOut}`);
  if (!ladder[1].includes(`script-src 'self' ${library[1]} `)) throw new Error(`the ladder policy does not admit ${library[1]}: ${ladder[1]}`);
  const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(briefOut);
  if (inline === null) throw new Error("brief.html carries no renderer script");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inline[1]));
  const hash = `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
  if (!ladder[1].includes(hash)) throw new Error(`the ladder policy admits a different inline script than brief.html carries: ${ladder[1]}`);
  if (!inline[1].includes('read("brief.md")')) throw new Error("the renderer does not read brief.md");
});

Deno.test("the deployed review pages carry the brief, its page, and the IR's relative stylesheet", async () => {
  const r = await ssrView();
  if (!r.ok) throw new Error(r.out);
  const { statics } = JSON.parse(r.out) as { statics: { file: string; target: string }[] };
  for (const file of ["brief.md", "brief.html", "ir.html", "ir/card.css"]) {
    if (!statics.some((s) => s.file === file && s.target === `/srv/docs/${file}`)) {
      throw new Error(`missing deployed review asset ${file}`);
    }
  }
});

Deno.test("a screen's access and ssr derive from its top-level regions and govern rendering and crawlability", async () => {
  const [open, mixed, priv, overridden, pubOverPriv, ssrOverPriv] = await Promise.all([
    exported("(#accessCase & {reads: [_view]}).out", false),
    exported(`(#accessCase & {reads: [_view, ${note()}]}).out`, false),
    exported(`(#accessCase & {reads: [${note()}]}).out`, false),
    exported('(#accessCase & {reads: [_view], extra: {access: "private"}}).out', false),
    exported(`(#accessCase & {reads: [${note()}], extra: {access: "public"}}).out.caddyfile`, true),
    exported('(#accessCase & {reads: [_view], extra: {access: "private", ssr: "ssr"}}).out.caddyfile', true),
  ]);
  // Open + public server read -> access: "public", ssr: "ssr", in sitemap and @rendered.
  if (!open.ok) throw new Error(open.out);
  const openData = JSON.parse(open.out);
  if (openData.screen.access !== "public" || openData.screen.ssr !== "ssr") throw new Error(open.out);
  if (openData.shellRoute.access !== undefined || openData.shellRoute.ssr !== "ssr") throw new Error(open.out);
  if (!openData.caddyfile.includes("@rendered {\n      expression")) throw new Error(openData.caddyfile);
  if (!openData.sitemap.includes("/jogos</loc>")) throw new Error(openData.sitemap);

  // Mixed top-level reads (public + private) -> access: "public", ssr: "ssr" (renders public regions, leaves private to data-empty).
  if (!mixed.ok) throw new Error(mixed.out);
  const mixedData = JSON.parse(mixed.out);
  if (mixedData.screen.access !== "public" || mixedData.screen.ssr !== "ssr") throw new Error(mixed.out);
  if (!mixedData.caddyfile.includes("@rendered {\n      expression")) throw new Error(mixedData.caddyfile);
  if (!mixedData.sitemap.includes("/jogos</loc>")) throw new Error(mixedData.sitemap);

  // Purely restricted top-level reads -> access: "private", ssr: "spa", omitted from @rendered and sitemap.xml.
  if (!priv.ok) throw new Error(priv.out);
  const privData = JSON.parse(priv.out);
  if (privData.screen.access !== "private" || privData.screen.ssr !== "spa") throw new Error(priv.out);
  if (privData.shellRoute.access !== "private" || privData.shellRoute.ssr !== "spa") throw new Error(priv.out);
  if (privData.caddyfile.includes("@rendered")) throw new Error(privData.caddyfile);
  if (privData.sitemap.includes("/jogos</loc>")) throw new Error(privData.sitemap);

  // Explicit access: "private" override on an open or mixed screen -> derives ssr: "spa" and omits from sitemap.xml.
  if (!overridden.ok) throw new Error(overridden.out);
  const overData = JSON.parse(overridden.out);
  if (overData.screen.access !== "private" || overData.screen.ssr !== "spa") throw new Error(overridden.out);
  if (overData.shellRoute.access !== "private" || overData.shellRoute.ssr !== "spa") throw new Error(overridden.out);
  if (overData.caddyfile.includes("@rendered")) throw new Error(overData.caddyfile);
  if (overData.sitemap.includes("/jogos</loc>")) throw new Error(overData.sitemap);

  // Inconsistent overrides are refused.
  if (pubOverPriv.ok || !/screen jogo declares access: "public" over Note \(private\)/.test(pubOverPriv.out)) {
    throw new Error(pubOverPriv.out);
  }
  if (ssrOverPriv.ok || !/screen jogo is private and declares ssr: "ssr"/.test(ssrOverPriv.out)) {
    throw new Error(ssrOverPriv.out);
  }
});
