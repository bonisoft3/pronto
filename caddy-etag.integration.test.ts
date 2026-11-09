// The door answers every file with its content hash as its ETag. Regression:
// Caddy's own is the file's mtime and size, and the images clamp every mtime
// to one value, so a static edited to another of the same length kept its
// ETag, and the worker's If-None-Match revalidation was answered 304 with the
// old file (llms.txt and the manifest measured: their ETags differed only by
// size). A templated file's validator is the same one, put back past
// `templates`.
//
// Read from what ships: #ssgCase's emitted Caddyfile and the command mecha's
// cluster starts its caddy with, as compose reads it, over files at the
// Caddyfile's roots. Release edits restart the door to rebuild sidecars;
// development copies edits directly and leaves those sidecars stale. Neither
// an old timestamp nor If-None-Match: * may hide a development edit.
//
// Installed, the door's /omnishell root is put in its image by the app's
// build, not by the cluster's statics. Regression: the sidecars were written
// under the statics' roots alone, so every file of omnishell's carried
// Caddy's own validator.
//
// A file's name is no command. Regression: the sidecars were written by a
// script spelled from sha256sum's lines and piped into sh, so a static named
// with a quote stopped the door, and one naming `$(…)` ran it.

import { fileURLToPath } from "node:url";
import { created } from "./docker-copy.ts";

const dir = fileURLToPath(new URL("./testdata/emit", import.meta.url));

function fail(message: string): never {
  throw new Error(message);
}

const CADDY = (await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url)))
  .match(/"(caddy:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1] ?? fail("cluster.cue pins no caddy image");

// Evaluate each independent surface separately: merging the local and installed
// cluster graphs in one CUE value needlessly retains both expanded runtimes.
function fixture<T>(expression: string): T {
  const result = new Deno.Command("cue", { args: ["export", ".", "-e", expression], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
  if (!result.success) fail(`cue ${expression}: exit ${result.code}, signal ${result.signal}: ${new TextDecoder().decode(result.stderr)}`);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}
const surface = fixture<{
  caddyfile: string;
  entry: string;
  routes: Record<"release" | "development", {path: string; prerender?: boolean; ssr: string}[]>;
}>("{caddyfile: #ssgCase.caddyfile, entry: #ssgCase.entry, routes: #ssgCase.routes}");
const {caddyfile} = surface;
Deno.test("development routes interpret authored screens instead of retained SSG documents", () => {
  const release = surface.routes.release.find(route => route.path === "/regras");
  const development = surface.routes.development.find(route => route.path === "/regras");
  if (release?.prerender !== true || release.ssr !== "ssg") fail("release lost its SSG contract");
  if (development?.prerender !== undefined || development?.ssr !== "spa") fail("development retained a generated SSG document");
});
const door = fixture<string[]>("#ssgCase.door");
const installedDoor = fixture<string[]>("#ssgCase.installedDoor");

async function docker(args: string[]): Promise<string> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) fail(`docker ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout);
}

// Past encode's 512-byte minimum, so the validator crosses its -gzip suffix.
const filler = "x".repeat(600);
// Each path the door answers, the file behind it, and two contents of one length.
const FILES: [string, string, (v: string) => string][] = [
  ["/docs/ir.html", "srv/docs/ir.html", (v) => `<!doctype html><link rel="stylesheet" href="ir/card.css"><title>${v}</title><p>${filler}</p>\n`],
  ["/docs/ir/card.css", "srv/docs/ir/card.css", (v) => `.${v} {}\n/* ${filler} */\n`],
  ["/llms.txt", "srv/llms.txt", (v) => `# ${v}\n${filler}\n`],
  ["/shell/screens/regras.css", "srv/shell/screens/regras.css", (v) => `.${v} {}\n/* ${filler} */\n`],
  ["/omnishell/interpreter/shell.js", "omnishell/interpreter/shell.js", (v) => `export const v = "${v}";\n// ${filler}\n`],
  ["/robots.txt", "srv/robots.txt", (v) => `User-agent: *\nAllow: /${v}\n# ${filler}\n`],
  ["/regras", "srv/regras/index.html", (v) => `<!doctype html><title>${v}</title><p>${filler}</p>\n`],
];
const ENTRY = (v: string) => `<!doctype html><title>entry-${v}</title><p>${filler}</p>\n`;
const SCREEN = (v: string) => `<section class="screen" data-screen="regras">source-${v}</section>\n`;
const CLAMPED = 1700000000;
// Names a shell would read as more than a name.
const HOSTILE = ['srv/shell/a "quoted" name.css', "srv/shell/$(touch pwned).css", "srv/shell/back\\slash.css", "srv/shell/new\nline.css"];

for (const [layout, composed] of [["local", door], ["installed", installedDoor]] as const)
for (const development of [false, true]) Deno.test({ name: development
  ? `the ${layout} development door serves direct edits without validators or restart`
  : `the ${layout} door revalidates every file on its content, not its length and mtime`, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  // Compose reads `$$` in a command as a literal `$`.
  const command = composed.map((arg) => arg.replaceAll("$$", "$"));
  const scratch = await Deno.makeTempDir({ prefix: "caddy-etag-" });
  const name = `caddy-etag-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const write = async (v: string) => {
    for (const [, file, body] of [...FILES, ["", `srv/${surface.entry}`, ENTRY], ["", "srv/shell/screens/regras.html", SCREEN]] as typeof FILES) {
      const path = `${scratch}/${file}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, body(v));
      await Deno.utime(path, CLAMPED, CLAMPED);
    }
  };
  const base = async () => {
    const port = (await docker(["port", name, "8080"])).trim().split("\n")[0].split(":").pop();
    for (let i = 0; i < 40; i++) {
      const up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text().then(() => r.ok), () => false);
      if (up) return `http://127.0.0.1:${port}`;
      await new Promise((r) => setTimeout(r, 250));
    }
    fail(`the door never answered:\n${await docker(["logs", name])}`);
  };
  const get = async (url: string, etag?: string) => {
    const res = await fetch(url, { headers: {
      ...(etag === undefined ? {} : { "If-None-Match": etag }),
      ...(development ? { "If-Modified-Since": new Date(CLAMPED * 1000).toUTCString() } : {}),
    } });
    const policy = res.headers.get("content-security-policy") ?? "";
    if (new URL(url).pathname.startsWith("/docs/")) {
      if (!policy.includes("script-src-attr 'none'") || !policy.includes("object-src 'none'") || policy.includes("require-trusted-types-for") || policy.includes("'unsafe-eval'")) {
        fail(`the door lost its documentation policy at ${url}: ${policy}`);
      }
    } else if (!policy.includes("require-trusted-types-for 'script'")) fail(`the door omitted its terminal fence at ${url}`);
    if (development && res.status === 200) {
      if (res.headers.get("cache-control") !== "no-store") fail(`${url} permits caching during development`);
      if (res.headers.has("etag") || res.headers.has("last-modified")) fail(`${url} exposes a stale development validator`);
    }
    return { status: res.status, etag: res.headers.get("etag") ?? "", body: await res.text() };
  };
  await write("aaaa");
  for (const file of HOSTILE) {
    await Deno.mkdir(`${scratch}/srv/shell`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/${file}`, file);
  }
  await Deno.writeTextFile(`${scratch}/Caddyfile`, caddyfile);
  const tree: [string, string][] = [[`${scratch}/srv`, "/srv"], [`${scratch}/omnishell`, "/omnishell"]];
  try {
    await docker(["start", await created(["--name", name, "-e", "ELECTRIC_SECRET=test", "-e", "ORIGIN=https://test.example", ...(development ? ["-e", "PRONTO_FILE_MODE=development"] : []), "-p", "127.0.0.1::8080", CADDY, ...command], [[`${scratch}/Caddyfile`, "/etc/caddy/Caddyfile"], ...tree])]);
    let url = await base();
    const started = await docker(["inspect", "-f", "{{.State.StartedAt}}", name]);
    const before: Record<string, string> = {};
    const bodyAt = (path: string, body: (v: string) => string, v: string) => development && path === "/regras" ? ENTRY(v) : body(v);
    for (const [path, , body] of FILES) {
      const first = await get(`${url}${path}`);
      if (first.status !== 200 || first.body !== bodyAt(path, body, "aaaa")) fail(`${path}: ${first.status} ${first.body.slice(0, 80)}`);
      if (!development && !/^"[0-9a-f]{64}(-gzip|-zstd)?"$/.test(first.etag)) fail(`${path} carries the validator ${JSON.stringify(first.etag)}`);
      const validator = development ? "*" : first.etag;
      const again = await get(`${url}${path}`, validator);
      if (again.status !== (development ? 200 : 304) || again.body !== (development ? bodyAt(path, body, "aaaa") : "")) fail(`${path} unchanged answered ${again.status}`);
      before[path] = validator;
    }
    for (const file of HOSTILE) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file)));
      const want = `"${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}"`;
      const got = await docker(["exec", name, "cat", `/${file}.etag`]).catch((err) => fail(`${JSON.stringify(file)} has no validator: ${err}`));
      if (got !== want) fail(`${JSON.stringify(file)} carries ${got}, not ${want}`);
    }
    if ((await docker(["exec", name, "find", "/", "-xdev", "-name", "pwned"])).trim() !== "") fail("a file's name ran as a command");
    for (const sidecar of ["/llms.txt.etag", "/robots.txt.etag", "/regras/index.html.etag", "/omnishell/interpreter/shell.js.etag"]) {
      const res = await get(`${url}${sidecar}`);
      if (res.status !== 404) fail(`${sidecar} is served: ${res.status}`);
    }
    await write("bbbb");
    for (const [source, target] of tree) await docker(["cp", `${source}/.`, `${name}:${target}`]);
    if (!development) {
      await docker(["restart", name]);
      url = await base();
    }
    for (const [path, , body] of FILES) {
      const stale = await get(`${url}${path}`, before[path]);
      if (stale.status !== 200 || stale.body !== bodyAt(path, body, "bbbb")) fail(`${path} edited to the same length answered ${stale.status} to its old validator ${before[path]}`);
      if (!development && stale.etag === before[path]) fail(`${path} kept its validator ${stale.etag} across an edit`);
      const again = await get(`${url}${path}`, development ? before[path] : stale.etag);
      if (again.status !== (development ? 200 : 304)) fail(`${path} unchanged answered ${again.status}`);
    }
    const authored = await get(`${url}/shell/screens/regras.html`);
    if (authored.status !== 200 || authored.body !== SCREEN("bbbb")) fail("the authored SSG screen is not served directly");
    const slash = await get(`${url}/regras/`);
    if (slash.status !== 200 || slash.body !== (development ? ENTRY("bbbb") : FILES.at(-1)![2]("bbbb"))) fail("the SSG trailing slash spelling chose the wrong document");
    if (development && await docker(["inspect", "-f", "{{.State.StartedAt}}", name]) !== started) fail("direct file edits restarted the development door");
  } finally {
    await docker(["rm", "-f", name]);
    await Deno.remove(scratch, { recursive: true });
  }
} });
