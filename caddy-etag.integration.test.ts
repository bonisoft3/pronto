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
// Caddyfile's roots, restarted on an edit as `develop: watch` restarts it.
//
// Installed, the door's /omnishell root is put in its image by the app's
// build, not by the cluster's statics. Regression: the sidecars were written
// under the statics' roots alone, so every file of omnishell's carried
// Caddy's own validator.
//
// A file's name is no command. Regression: the sidecars were written by a
// script spelled from sha256sum's lines and piped into sh, so a static named
// with a quote stopped the door, and one naming `$(…)` ran it.

const dir = new URL("./testdata/emit", import.meta.url).pathname;

function fail(message: string): never {
  throw new Error(message);
}

const CADDY = (await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url)))
  .match(/"(caddy:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1] ?? fail("cluster.cue pins no caddy image");

const exported = new Deno.Command("cue", { args: ["export", ".", "-e", "{caddyfile: #ssgCase.caddyfile, door: #ssgCase.door, installedDoor: #ssgCase.installedDoor}"], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
if (!exported.success) fail(new TextDecoder().decode(exported.stderr));
const { caddyfile, door, installedDoor } = JSON.parse(new TextDecoder().decode(exported.stdout)) as { caddyfile: string; door: string[]; installedDoor: string[] };

async function docker(args: string[]): Promise<string> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) fail(`docker ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout);
}

// Past encode's 512-byte minimum, so the validator crosses its -gzip suffix.
const filler = "x".repeat(600);
// Each path the door answers, the file behind it, and two contents of one length.
const FILES: [string, string, (v: string) => string][] = [
  ["/llms.txt", "srv/llms.txt", (v) => `# ${v}\n${filler}\n`],
  ["/shell/screens/regras.css", "srv/shell/screens/regras.css", (v) => `.${v} {}\n/* ${filler} */\n`],
  ["/omnishell/interpreter/shell.js", "omnishell/interpreter/shell.js", (v) => `export const v = "${v}";\n// ${filler}\n`],
  ["/robots.txt", "srv/robots.txt", (v) => `User-agent: *\nAllow: /${v}\n# ${filler}\n`],
  ["/regras", "srv/regras/index.html", (v) => `<!doctype html><title>${v}</title><p>${filler}</p>\n`],
];
const CLAMPED = 1700000000;
// Names a shell would read as more than a name.
const HOSTILE = ['srv/shell/a "quoted" name.css', "srv/shell/$(touch pwned).css", "srv/shell/back\\slash.css", "srv/shell/new\nline.css"];

for (const [layout, composed] of [["local", door], ["installed", installedDoor]] as const) Deno.test({ name: `the ${layout} door revalidates every file on its content, not its length and mtime`, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  // Compose reads `$$` in a command as a literal `$`.
  const command = composed.map((arg) => arg.replaceAll("$$", "$"));
  const scratch = await Deno.makeTempDir({ prefix: "caddy-etag-" });
  const name = `caddy-etag-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const write = async (v: string) => {
    for (const [, file, body] of FILES) {
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
    const res = await fetch(url, { headers: etag === undefined ? {} : { "If-None-Match": etag } });
    return { status: res.status, etag: res.headers.get("etag") ?? "", body: await res.text() };
  };
  await write("aaaa");
  for (const file of HOSTILE) {
    await Deno.mkdir(`${scratch}/srv/shell`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/${file}`, file);
  }
  await Deno.writeTextFile(`${scratch}/Caddyfile`, caddyfile);
  try {
    await docker(["run", "-d", "--name", name, "-e", "ELECTRIC_SECRET=test", "-e", "ORIGIN=https://test.example", "-p", "127.0.0.1::8080", "-v", `${scratch}/Caddyfile:/etc/caddy/Caddyfile:ro`, "-v", `${scratch}/srv:/srv`, "-v", `${scratch}/omnishell:/omnishell`, CADDY, ...command]);
    let url = await base();
    const before: Record<string, string> = {};
    for (const [path, , body] of FILES) {
      const first = await get(`${url}${path}`);
      if (first.status !== 200 || first.body !== body("aaaa")) fail(`${path}: ${first.status} ${first.body.slice(0, 80)}`);
      if (!/^"[0-9a-f]{64}(-gzip|-zstd)?"$/.test(first.etag)) fail(`${path} carries the validator ${JSON.stringify(first.etag)}`);
      const again = await get(`${url}${path}`, first.etag);
      if (again.status !== 304 || again.body !== "") fail(`${path} unchanged answered ${again.status}`);
      before[path] = first.etag;
    }
    for (const file of HOSTILE) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file)));
      const want = `"${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}"`;
      const got = await Deno.readTextFile(`${scratch}/${file}.etag`).catch((err) => fail(`${JSON.stringify(file)} has no validator: ${err}`));
      if (got !== want) fail(`${JSON.stringify(file)} carries ${got}, not ${want}`);
    }
    for (const dir of [scratch, `${scratch}/srv`, `${scratch}/srv/shell`]) {
      for await (const e of Deno.readDir(dir)) if (e.name === "pwned") fail(`a file's name ran as a command in ${dir}`);
    }
    if ((await docker(["exec", name, "find", "/", "-xdev", "-name", "pwned"])).trim() !== "") fail("a file's name ran as a command");
    for (const sidecar of ["/llms.txt.etag", "/robots.txt.etag", "/regras/index.html.etag", "/omnishell/interpreter/shell.js.etag"]) {
      const res = await get(`${url}${sidecar}`);
      if (res.status !== 404) fail(`${sidecar} is served: ${res.status}`);
    }
    await write("bbbb");
    await docker(["restart", name]);
    url = await base();
    for (const [path, , body] of FILES) {
      const stale = await get(`${url}${path}`, before[path]);
      if (stale.status !== 200 || stale.body !== body("bbbb")) fail(`${path} edited to the same length answered ${stale.status} to its old validator ${before[path]}`);
      if (stale.etag === before[path]) fail(`${path} kept its validator ${stale.etag} across an edit`);
      const again = await get(`${url}${path}`, stale.etag);
      if (again.status !== 304) fail(`${path} unchanged answered ${again.status}`);
    }
  } finally {
    await docker(["rm", "-f", name]);
    await Deno.remove(scratch, { recursive: true });
  }
} });
