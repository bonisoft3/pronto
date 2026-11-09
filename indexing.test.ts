// What a crawler is told about the addresses an app answers. Search Console
// reported 215 pages not indexed on bonkchess.com: the shell's fragments,
// catalogs, models, fonts and an earlier release's `_immutable-` files, which
// Google finds through the importmap every document carries, and the play
// screen at /, /es and /pt-br, whose document is the SPA entry ("Loading…",
// lang="en", no canonical). So the door marks everything that is not a page
// noindex (never a robots.txt Disallow, which would stop Google fetching what
// it needs to render the pages), and speaks the entry's head for each address
// the sitemap offers of a route only the terminal draws.
//
// Read from what ships: testdata/emit's #indexingCase door, entry, sitemap and
// robots.txt, and the door run for real as a local caddy process (no docker)
// over those files. Without a caddy binary (CADDY_BIN, or `caddy` on the path)
// the behavioural cases are skipped and say so; the cases over the text still run.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./testdata/emit", import.meta.url));
const exported = new Deno.Command("cue", {
  args: ["export", "read-case.cue", "indexing.cue", "-e", "#indexingCase.out", "--out", "json"],
  cwd: dir,
  stdout: "piped",
  stderr: "piped",
}).outputSync();
if (!exported.success) throw new Error(new TextDecoder().decode(exported.stderr));
const { caddyfile, entry, sitemap, robots } = JSON.parse(new TextDecoder().decode(exported.stdout)) as {
  caddyfile: string;
  entry: string;
  sitemap: string;
  robots: string;
};

const ORIGIN = "https://bonk.example";
const locales = [["en", "/"], ["es", "/es"], ["pt-BR", "/pt-br"]] as const;

/** The alternates the sitemap lists for one address, with the deployment's origin spelled. */
function sitemapAlternates(address: string): string[] {
  const spelled = sitemap.replaceAll("{{$o}}", ORIGIN);
  const block = spelled.split("<url>").find((u) => u.includes(`<loc>${ORIGIN}${address}</loc>`));
  assert(block, `the sitemap offers no ${address}`);
  return [...block.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
}

const documentAlternates = (html: string) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => `${m[1]} ${m[2]}`);

Deno.test("robots.txt invites the crawler in: noindex is read only by a page that is fetched", () => {
  assertStringIncludes(robots, "User-agent: *\nAllow: /");
  assert(!robots.includes("Disallow"), robots);
});

Deno.test("every address that is not a page is noindex, and no page is", () => {
  const matcher = caddyfile.match(/@noindex \{\n\s+path ([^\n]+)\n\s+not path ([^\n]+)\n\s+\}/);
  assert(matcher, "no @noindex matcher");
  const paths = matcher[1].split(" ");
  for (const p of ["/shell/*", "/messages/*", "/docs/*", "/omnishell/*", "/.well-known/*", "/electric/*", "/blobs/*", "/img/*"]) assert(paths.includes(p), `${p} is not noindex`);
  assertEquals(matcher[2].split(" "), ["/shell/", "/shell/index.html"], "the entry redirects to the page and is no file");
  assertStringIncludes(caddyfile, '  header @noindex >X-Robots-Tag "noindex, nofollow"\n');
  assertStringIncludes(caddyfile, "  @noindexfile path_regexp /_immutable-[0-9a-f]{64}-[^/]*$\n  header @noindexfile >X-Robots-Tag \"noindex, nofollow\"\n");
  assertEquals(caddyfile.split("X-Robots-Tag").length - 1, 2, "no other address is marked");
});

Deno.test("each address of a spa route the sitemap offers answers with its own head, matching the sitemap's alternates", () => {
  for (const [tag, address] of locales) {
    const block = caddyfile.match(new RegExp(`@spa_play_${tag} path [^\\n]+\\n[\\s\\S]*?respond \`([^\\n]+)\` 200`));
    assert(block, `no head for ${tag}`);
    assertStringIncludes(block[1], `href=\\"@origin@${address}\\">\\n<link rel=\\"alternate\\"`);
  }
  assert(!caddyfile.includes("@spa_regras"), "a prerendered route carries its own head");
  assert(!caddyfile.includes("@spa_jogo"), "a route with a parameter is no address a crawler is offered");
  assertEquals(sitemapAlternates("/es").length, 4);
});

const caddy = await new Deno.Command(Deno.env.get("CADDY_BIN") ?? "caddy", { args: ["version"], stdout: "null", stderr: "null" }).output().then((o) => o.success, () => false);
if (!caddy) console.warn("indexing.test.ts: no caddy binary (CADDY_BIN or on the path): the cases over a running door are skipped");

const freePort = () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
};

/** The door as it ships, over its files, serving plain HTTP: the published hostnames' blocks name TLS no test needs. */
async function withDoor(use: (get: (path: string, headers?: Record<string, string>) => Promise<Response>) => Promise<void>) {
  const scratch = await Deno.makeTempDir({ prefix: "indexing-" });
  const hash = "a".repeat(64);
  const files: [string, string][] = [
    ["Caddyfile", caddyfile.slice(0, caddyfile.indexOf("\nhttps://localhost:")) + "\n"],
    ["srv/shell/index.html", entry],
    ["srv/shell/screens/play.html", "<p>fragment</p>"],
    [`srv/shell/screens/_immutable-${hash}-play.html`, "<p>fragment</p>"],
    [`srv/_immutable-${hash}-model.glb`, "glb"],
    ["srv/messages/en.json", "{}"],
    ["srv/docs/ir.html", "<html>ir</html>"],
    ["srv/.well-known/assetlinks.json", "[]"],
    ["srv/regras/index.html", "{{- $o := placeholder \"http.vars.origin\" -}}<html><title>Regras</title></html>"],
    ["srv/robots.txt", robots],
    ["srv/sitemap.xml", sitemap],
    ["omnishell/interpreter/shell.js", "export {}"],
  ];
  for (const [file, body] of files) {
    await Deno.mkdir(`${scratch}/${file}`.replace(/\/[^/]*$/, ""), { recursive: true });
    await Deno.writeTextFile(`${scratch}/${file}`, body);
  }
  // The gate behind /electric, which refuses everyone: a refusal is an upstream's answer, not the door's.
  const gate = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }));
  const port = freePort();
  const door = new Deno.Command(Deno.env.get("CADDY_BIN") ?? "caddy", {
    args: ["run", "--config", `${scratch}/Caddyfile`, "--adapter", "caddyfile"],
    env: {
      ORIGIN, ELECTRIC_SECRET: "test", PORT: String(port), PRONTO_SRV_ROOT: `${scratch}/srv`, PRONTO_OMNISHELL_ROOT: `${scratch}/omnishell`,
      PRONTO_UPSTREAM_AUTH: `127.0.0.1:${gate.addr.port}`, XDG_DATA_HOME: `${scratch}/data`, XDG_CONFIG_HOME: `${scratch}/config`,
    },
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });
    for (let i = 0; ; i++) {
      if (await get("/health").then((r) => r.text().then(() => r.ok), () => false)) break;
      if (i > 60) throw new Error("the door never answered");
      await new Promise((r) => setTimeout(r, 250));
    }
    await use(get);
  } finally {
    door.kill();
    await door.status;
    await gate.shutdown();
    await Deno.remove(scratch, { recursive: true });
  }
}

Deno.test({ name: "the door marks files noindex and leaves pages alone", ignore: !caddy, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const hash = "a".repeat(64);
  await withDoor(async (get) => {
    const tag = async (path: string) => {
      const res = await get(path);
      await res.body?.cancel();
      return [res.status, res.headers.get("x-robots-tag")] as const;
    };
    for (const path of ["/shell/screens/play.html", `/shell/screens/_immutable-${hash}-play.html`, `/_immutable-${hash}-model.glb`, "/messages/en.json", "/docs/ir.html", "/omnishell/interpreter/shell.js", "/.well-known/assetlinks.json"]) {
      assertEquals(await tag(path), [200, "noindex, nofollow"], path);
    }
    assertEquals(await tag("/electric/v1/shape"), [401, "noindex, nofollow"], "an upstream's refusal carries it too");
    for (const path of ["/", "/es", "/pt-br", "/regras", "/robots.txt", "/sitemap.xml"]) assertEquals(await tag(path), [200, null], path);
    assertEquals(await tag("/shell/"), [301, null], "the entry's address redirects to the page, which is indexable");
    assertEquals(await tag("/shell/index.html"), [301, null]);
  });
} });

Deno.test({ name: "the play screen's document carries its locale's lang, title, canonical and the sitemap's alternates", ignore: !caddy, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  await withDoor(async (get) => {
    for (const [tag, address] of locales) {
      const res = await get(address);
      const html = await res.text();
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
      assertStringIncludes(html, `<html lang="${tag}" dir="ltr">`);
      assertEquals(html.match(/<title>/g)?.length, 1, "the entry's own title is replaced, not joined");
      assertStringIncludes(html, '<title>Bonk &amp; &quot;Chess&quot;</title>');
      assertEquals(html.match(/<link rel="canonical" href="([^"]+)">/)?.[1], `${ORIGIN}${address}`);
      assertEquals(documentAlternates(html), sitemapAlternates(address));
      assertStringIncludes(html, "<base href=\"/shell/\">");
      assertEquals(html.replace(/<html lang[^\n]*\n/, "").includes("Loading…"), false);
    }
    // The negotiated address is the reader's language, not the default's.
    const negotiated = await (await get("/", { "accept-language": "pt-BR,pt;q=0.9" })).text();
    assertStringIncludes(negotiated, '<html lang="pt-BR" dir="ltr">');
    // A crawler's request, which names no language, reads the default's.
    assertStringIncludes(await (await get("/")).text(), '<html lang="en" dir="ltr">');
    // A document the terminal prerenders keeps its own head.
    assertEquals(await (await get("/regras")).text(), "<html><title>Regras</title></html>");
  });
} });
