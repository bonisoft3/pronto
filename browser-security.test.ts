import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

Deno.test("the door emits the terminal fence with only declared resource sources", async () => {
  const files = await emitFiles(paymentProgram() + `
app: capabilities: resources: {
  map: {kind: "frame", source: "https://www.openstreetmap.org", note: "the map presents club locations"}
  pictures: {kind: "img", source: "https:", note: "readers choose image hosts"}
}
`);
  const caddy = files["docker/Caddyfile"].text;
  assertStringIncludes(files["shell/index.html"].text, 'http-equiv="Content-Security-Policy"');
  assertStringIncludes(caddy, "require-trusted-types-for 'script'");
  assertStringIncludes(caddy, "frame-src 'self' https://www.openstreetmap.org;");
  assertStringIncludes(caddy, "img-src 'self' data: blob: https:;");
  assertStringIncludes(caddy, "connect-src 'self';");
  assertStringIncludes(caddy, "font-src 'self' data:;");
  assertStringIncludes(caddy, "script-src-attr 'none';");
});

const sha256 = async (text: string) =>
  `'sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))))}'`;
const inlineScript = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)![1];
const metaPolicy = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1].replaceAll("&#39;", "'");
const consentDeclaration = `app: meta: consent: policy: {url: "https://shop.example/privacy", version: "3"}`;
const googleTagProgram = paymentProgram() + `
app: meta: googleTag: {id: "AW-123", hosts: ["shop.example"]}
${consentDeclaration}
`;

// The tag runs in a frame because in the app's own realm remarketing cannot:
// measured in Chromium, googleads.g.doubleclick.net's viewthroughconversion
// script is refused by the terminal's Trusted Types, and with Google's goog#html
// policy admitted it throws null into SES's uncaught handler.
Deno.test("a Google tag leaves the terminal's policy Google-free and runs in a frame of its own policy", async () => {
  const files = await emitFiles(googleTagProgram);
  const entry = files["shell/index.html"].text;
  const frame = files["shell/tag.html"].text;
  const caddy = files["docker/Caddyfile"].text;
  const terminal = metaPolicy(entry);
  for (const where of [terminal, caddy.split("\n").find((l) => l.includes("header @terminal"))!]) {
    assertStringIncludes(where, await sha256(inlineScript(entry)));
    assertEquals(/google|doubleclick|pronto-google-tag/.test(where), false, where);
  }
  assertStringIncludes(terminal, "frame-src 'self'");
  assertStringIncludes(caddy, "@terminal not path /docs/* /shell/tag.html");

  const policy = metaPolicy(frame);
  const directive = (name: string) => policy.split("; ").find((d) => d.split(" ")[0] === name)!;
  assertStringIncludes(directive("script-src"), `${await sha256(inlineScript(frame))} https://www.googletagmanager.com https://googleads.g.doubleclick.net`);
  assertEquals(directive("default-src"), "default-src 'none'");
  assertEquals(directive("img-src"), "img-src https:");
  assertEquals(policy.includes("trusted-types"), false);
});

const granted = { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "granted" };
const denied = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" };

Deno.test("the app's bridge mounts the frame with the terminal's consent on a declared host alone, and tells it the page, its click ids and each route", async () => {
  const bridge = inlineScript((await emitFiles(googleTagProgram))["shell/index.html"].text);
  const run = (href: string) => {
    const sent: unknown[] = [];
    const listeners: Record<string, (event: any) => void> = {};
    const body: unknown[] = [];
    const contentWindow = { postMessage: (message: unknown, origin: string) => sent.push([message, origin]) };
    const frame: Record<string, unknown> = { contentWindow, setAttribute: (k: string, v: string) => (frame[k] = v) };
    const window: Record<string, any> = {};
    const navigation = { addEventListener: (_: string, f: (event: any) => void) => (listeners.route = f) };
    const location = new URL(href);
    const document = { referrer: "https://search.example/", createElement: () => frame, body: { append: (node: unknown) => body.push(node) } };
    const addEventListener = (_: string, f: (event: any) => void) => (listeners.message = f);
    new Function("window", "document", "location", "addEventListener", "globalThis", bridge)(window, document, location, addEventListener, { navigation });
    return { window, frame, body, sent, listeners, location };
  };

  const elsewhere = run("http://localhost:8443/?gclid=x");
  elsewhere.window.gtag("consent", "update", granted);
  elsewhere.window.gtag("event", "conversion");
  assertEquals([elsewhere.body, elsewhere.sent, elsewhere.listeners.route], [[], [], undefined]);

  const app = run("https://shop.example/?gclid=G1&wbraid=W1&utm_source=ads");
  // A tag configured before the reader's consent is stated would run under
  // Google's regional default, which grants wherever Google's own geolocation
  // disagrees with the door's.
  assertThrows(() => app.window.gtag("event", "conversion"), Error, "states the reader's consent before any other command");
  assertEquals(app.body, []);
  app.location.href = "https://shop.example/explore";
  app.listeners.route({ navigationType: "push" });
  app.window.gtag("consent", "update", denied);
  assertEquals(app.body, [app.frame]);
  assertEquals([app.frame.src, app.frame.hidden, app.frame.referrerPolicy], ["/shell/tag.html", true, "no-referrer"]);
  app.window.gtag("consent", "update", granted);
  assertEquals(app.sent, []);
  app.listeners.message({ origin: "https://elsewhere.example", source: app.frame.contentWindow, data: { kind: "ready" } });
  assertEquals(app.sent, []);
  app.listeners.message({ origin: "https://shop.example", source: app.frame.contentWindow, data: { kind: "ready" } });
  assertEquals(app.sent, [
    [{ kind: "init", consent: denied, page_location: "https://shop.example/?gclid=G1&wbraid=W1&utm_source=ads", page_referrer: "https://search.example/", click: { gclid: "G1", wbraid: "W1" } }, "https://shop.example"],
    [{ kind: "page_view", page_location: "https://shop.example/explore", page_referrer: "https://shop.example/?gclid=G1&wbraid=W1&utm_source=ads" }, "https://shop.example"],
    [{ kind: "gtag", args: ["consent", "update", granted] }, "https://shop.example"],
  ]);
  app.location.href = "https://shop.example/pt/explore";
  app.listeners.route({ navigationType: "replace" });
  assertEquals(app.sent.length, 3);
  assertThrows(() => app.window.gtag("config", "AW-123"), TypeError, "consent and event commands");
});

Deno.test("the tag frame answers its parent alone, and states consent before it configures the page it is told", async () => {
  const script = inlineScript((await emitFiles(googleTagProgram))["shell/tag.html"].text);
  const run = (hostname: string, framed: boolean) => {
    const window: Record<string, any> = {};
    const parent = framed ? { postMessage: (m: unknown, o: string) => posted.push([m, o]) } : window;
    const posted: unknown[] = [];
    const appended: unknown[] = [];
    const replaced: string[] = [];
    let listener: (event: any) => void = () => {};
    const location = { hostname, origin: `https://${hostname}` };
    const document = { createElement: () => ({}), head: { append: (node: unknown) => appended.push(node) } };
    const history = { replaceState: (_: unknown, __: string, url: string) => replaced.push(url) };
    const addEventListener = (_: string, f: (event: any) => void) => (listener = f);
    const dataLayer = () => (window.dataLayer as ArrayLike<unknown>[]).map((args) => Array.from(args));
    const send = (data: unknown, origin = location.origin, source: unknown = parent) => listener({ data, origin, source });
    new Function("window", "parent", "document", "location", "history", "addEventListener", script)(window, parent, document, location, history, addEventListener);
    return { posted, appended, replaced, dataLayer, send };
  };
  assertThrows(() => run("shop.example", false), Error, "framed by the app");
  assertThrows(() => run("localhost", true), Error, "on a declared host");

  const frame = run("shop.example", true);
  assertEquals(frame.posted, [[{ kind: "ready" }, "https://shop.example"]]);
  assertEquals(frame.dataLayer(), [["consent", "default", denied], ["set", "ads_data_redaction", true]]);
  const init = { kind: "init", consent: granted, page_location: "https://shop.example/?gclid=G1", page_referrer: "https://search.example/", click: { gclid: "G1" } };
  frame.send(init, "https://elsewhere.example");
  frame.send(init, "https://shop.example", {});
  assertEquals(frame.appended, []);
  frame.send(init);
  assertEquals(frame.replaced, ["?gclid=G1"]);
  assertEquals(frame.appended, [{ async: true, src: "https://www.googletagmanager.com/gtag/js?id=AW-123" }]);
  assertEquals(frame.dataLayer().slice(2).map((c) => c[0] === "js" ? ["js"] : c), [
    ["consent", "update", granted],
    ["js"],
    ["config", "AW-123", { page_location: "https://shop.example/?gclid=G1", page_referrer: "https://search.example/" }],
  ]);
  frame.send({ kind: "page_view", page_location: "https://shop.example/explore", page_referrer: "https://shop.example/?gclid=G1" });
  assertEquals(frame.dataLayer().at(-1), ["event", "page_view", { send_to: "AW-123", page_location: "https://shop.example/explore", page_referrer: "https://shop.example/?gclid=G1" }]);
  frame.send({ kind: "gtag", args: ["consent", "update", denied] });
  assertEquals(frame.dataLayer().at(-1), ["consent", "update", denied]);
  assertThrows(() => frame.send({ kind: "other" }), TypeError, "not a tag frame message");
});

Deno.test("a Google tag that names no host, or asks no consent, is refused, as is consent with no tag to govern or a mode none that states nothing", async () => {
  const tag = `app: meta: googleTag: {id: "AW-123", hosts: ["shop.example"]}`;
  const policy = `app: meta: consent: policy: {url: "https://shop.example/privacy", version: "3"}`;
  for (const [declared, refusal] of [
    [`app: meta: googleTag: {id: "AW-123", hosts: []}\n${consentDeclaration}`, "googleTag.hosts must name the hosts whose readers the tag measures"],
    [tag, "googleTag stores Google's cookies only with the reader's consent: declare meta.consent"],
    [consentDeclaration, "consent governs what a tag sends, and the app declares none: declare meta.googleTag"],
    [`${tag}\n${policy}\napp: meta: consent: mode: "none"`, "consent mode none asks nobody, so it states what everyone gets: write none.advertising"],
    [`${tag}\n${policy}\napp: meta: consent: none: advertising: "denied"`, "consent.none is what mode none states; the bar asks instead"],
  ]) {
    const res = await cue(["export", "-", "-e", "app"], paymentProgram() + "\n" + declared);
    assertEquals(res.success, false, declared);
    assertStringIncludes(res.stderr, refusal);
  }
});

Deno.test("consent hands the terminal its mode, policy and the tag's hosts, and nothing of where a reader is", async () => {
  const files = await emitFiles(googleTagProgram);
  assertEquals(files["shell/shell.json"].data.consent, { mode: "bar", policy: { url: "https://shop.example/privacy", version: "3" }, hosts: ["shop.example"] });
  assertStringIncludes(files["shell/design.css"].text, ".shell-consent-open");
  const none = await emitFiles(googleTagProgram + `app: meta: consent: {mode: "none", none: advertising: "granted"}\n`);
  assertEquals(none["shell/shell.json"].data.consent.none, { advertising: "granted" });
  assertEquals(none["shell/design.css"].text.includes(".shell-consent"), false);
});

Deno.test("resource declarations cannot relax scripts, omit a reason or broaden non-image origins", async () => {
  for (const fields of [
    'kind: "script", source: "https://example.org", note: "code"',
    'kind: "frame", source: "https:", note: "any frame"',
    'kind: "connect", source: "https://example.org/path", note: "a path"',
    'kind: "img", source: "https://example.org"',
    'kind: "img", source: "https://example.org", note: ""',
  ]) {
    const res = await cue(["export", "-", "-e", "app"], paymentProgram() + `\napp: capabilities: resources: bad: {${fields}}`);
    assertEquals(res.success, false, fields);
  }
});

Deno.test("the terminal fence excludes the ladder and a declared realm's served files", async () => {
  const files = await emitFiles(paymentProgram({ vendored: `map: {
    isolation: "realm", ports: {reads: [], raises: {}}, note: "a sandboxed presenter",
    src: "shell/units/map/index.html", files: ["shell/units/map/index.html", "shell/units/map/map.js"]
  }` }));
  assertStringIncludes(files["docker/Caddyfile"].text,
    "@terminal not path /docs/* /shell/units/map/index.html /shell/units/map/map.js\n  header @terminal Content-Security-Policy");
});

Deno.test("a presenter's worker script answers with the presenter's policy, and the page connects to its pinned scripts", async () => {
  const babylon = "https://cdn.jsdelivr.net/npm/babylonjs@9.31.0/babylon.js";
  const files = await emitFiles(paymentProgram({ vendored: `painter: {
    isolation: "agent", ports: {reads: [], raises: {}}, note: "paints the kinetic plane", scripts: ["${babylon}"],
    src: "shell/units/painter/unit.js", files: ["shell/units/painter/unit.js"]
  }` }));
  const caddy = files["docker/Caddyfile"].text;
  assertStringIncludes(caddy, "@terminal not path /docs/* /omnishell/interpreter/presenter.js\n  header @terminal Content-Security-Policy");
  assertStringIncludes(caddy, `@presenter path /omnishell/interpreter/presenter.js\n  header @presenter Content-Security-Policy "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src blob:; worker-src 'self'"`);
  assertStringIncludes(caddy, `connect-src 'self' ${babylon};`);
  // The worker's script-src 'self' admits a module import of any path here,
  // a credentialed GET; an upstream's may act (a sign-in callback), so the
  // door answers a script's fetch from its own files or not at all.
  assertStringIncludes(caddy, `  @scripted {\n    header_regexp Sec-Fetch-Dest ^(script|worker|sharedworker|serviceworker)$\n    not file {\n      root {$PRONTO_SRV_ROOT:/srv}\n    }\n  }\n  handle @scripted {\n    respond "" 403\n  }\n`);
  assert(caddy.indexOf("handle @scripted") < caddy.indexOf("handle /crud/*"), "the refusal precedes every upstream");
});

Deno.test("a door with no presenter answers a script's fetch as it answers any", async () => {
  const caddy = (await emitFiles(paymentProgram({ vendored: "" })))["docker/Caddyfile"].text;
  assert(!caddy.includes("@scripted"));
});

const hostDom = `
app: capabilities: hatches: dealer: {
  kind: "host-dom", note: "trusted browser and DOM access",
  src: "shell/hatches/dealer.js", files: ["shell/hatches/dealer.js"]
}
app: surface: screens: board: hatches: ["dealer"]
`;

Deno.test("host-DOM hatches are explicit screen capabilities served under the terminal fence", async () => {
  const files = await emitFiles(paymentProgram() + hostDom) as unknown as Record<string, { text: string; data: any }>;
  assertEquals(files["shell/shell.yaml"].data.hostDom, {
    dealer: { src: "shell/hatches/dealer.js", note: "trusted browser and DOM access" },
  });
  assertEquals(files["shell/shell.yaml"].data.routes[0].hatches, ["dealer"]);
  assertStringIncludes(files["docker/Caddyfile"].text, "script-src-attr 'none'");
  assertEquals(files["docker/Caddyfile"].text.includes("@terminal not path /shell/hatches"), false);
});

Deno.test("projected emission refuses undeclared, unserved and malformed host-DOM hatches", async () => {
  for (const change of [
    hostDom.replace('hatches: ["dealer"]', 'hatches: ["missing"]'),
    hostDom.replace('hatches: ["dealer"]', 'hatches: ["dealer", "dealer"]'),
    hostDom.replace('kind: "host-dom"', 'kind: "sql"').replace('src: "shell/hatches/dealer.js", ', ''),
    hostDom.replace('note: "trusted browser and DOM access",', ''),
    hostDom.replace('note: "trusted browser and DOM access"', 'note: ""'),
    hostDom.replace('files: ["shell/hatches/dealer.js"]', 'files: ["shell/hatches/other.js"]'),
    hostDom.replaceAll('shell/hatches/dealer.js', 'https://example.org/dealer.js'),
    hostDom.replaceAll('shell/hatches/dealer.js', 'shell/hatches/../dealer.js'),
  ]) {
    const result = await cue(["export", "-", "-e", "out", "--out", "json"], paymentProgram() + change);
    assertEquals(result.success, false, change);
  }
});
