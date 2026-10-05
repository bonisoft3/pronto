// The door spells every absolute address after the deployment's ORIGIN, never
// the request's Host. Regression: the crawler files and the prerendered
// documents composed the origin from the request's scheme and Host, and the
// door answers any Host, so a client chose the origin written into the
// canonical, the alternates, og:url, robots.txt's Sitemap: line and every
// sitemap <loc> of an answer anyone may keep.
//
// Read from what ships: #ssgCase's emitted Caddyfile, crawler files and the
// command mecha's cluster starts its caddy with, as compose reads it, over a
// document as write.ts writes one: the declaration, then the renderer's text
// spelled after the origin it was handed.

const dir = new URL("./testdata/emit", import.meta.url).pathname;

function fail(message: string): never {
  throw new Error(message);
}

const CADDY = (await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url)))
  .match(/"(caddy:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1] ?? fail("cluster.cue pins no caddy image");

const exported = new Deno.Command("cue", { args: ["export", ".", "-e", "{caddyfile: #ssgCase.caddyfile, door: #ssgCase.door, robots: #ssgCase.robots, sitemap: #ssgCase.sitemap, document: #ssgCase.document}"], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
if (!exported.success) fail(new TextDecoder().decode(exported.stderr));
const { caddyfile, door: composed, robots, sitemap, document } = JSON.parse(new TextDecoder().decode(exported.stdout)) as {
  caddyfile: string;
  door: string[];
  robots: string;
  sitemap: string;
  document: { data: { origin: string; declare: string } };
};
// Compose reads `$$` in a command as a literal `$`.
const door = composed.map((arg) => arg.replaceAll("$$", "$"));
const { origin: o, declare } = document.data;
const page = `${declare}\n<!doctype html><html lang="pt-BR"><head>
<link href="${o}/regras" rel="canonical">
<link hreflang="pt-BR" href="${o}/regras" rel="alternate">
<link hreflang="x-default" href="${o}/regras" rel="alternate">
<meta property="og:url" content="${o}/regras">
</head></html>
`;

async function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
}

const DEPLOYED = "https://gol.example";
const HOSTILE = ["evil.example", "evil.example:8443", "localhost:8443"];

async function withDoor(env: string[], use: (name: string) => Promise<void>) {
  const scratch = await Deno.makeTempDir({ prefix: "caddy-origin-" });
  const name = `caddy-origin-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  for (const [file, body] of [["srv/robots.txt", robots], ["srv/sitemap.xml", sitemap], ["srv/regras/index.html", page], ["omnishell/interpreter/shell.js", ""], ["Caddyfile", caddyfile]]) {
    await Deno.mkdir(`${scratch}/${file}`.replace(/\/[^/]*$/, ""), { recursive: true });
    await Deno.writeTextFile(`${scratch}/${file}`, body);
  }
  try {
    const run = await docker(["run", "-d", "--name", name, "-e", "ELECTRIC_SECRET=test", ...env.flatMap((e) => ["-e", e]), "-p", "127.0.0.1::8080", "-v", `${scratch}/Caddyfile:/etc/caddy/Caddyfile:ro`, "-v", `${scratch}/srv:/srv`, "-v", `${scratch}/omnishell:/omnishell`, CADDY, ...door]);
    if (!run.ok) fail(run.out);
    await use(name);
  } finally {
    await docker(["rm", "-f", name]);
    await Deno.remove(scratch, { recursive: true });
  }
}

Deno.test({ name: "the door spells the deployment's origin whatever Host it is asked under", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  await withDoor([`ORIGIN=${DEPLOYED}`], async (name) => {
    const port = (await docker(["port", name, "8080"])).out.trim().split("\n")[0].split(":").pop();
    const up = async () => {
      for (let i = 0; i < 40; i++) {
        if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text().then(() => r.ok), () => false)) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      fail(`the door never answered:\n${(await docker(["logs", name])).out}`);
    };
    await up();
    // curl, which sends the Host it is given as written.
    for (const host of HOSTILE) {
      for (const [path, want] of [
        ["/robots.txt", [`Sitemap: ${DEPLOYED}/sitemap.xml`]],
        ["/sitemap.xml", [`<loc>${DEPLOYED}/regras</loc>`]],
        ["/regras", [`<link href="${DEPLOYED}/regras" rel="canonical">`, `hreflang="pt-BR" href="${DEPLOYED}/regras"`, `hreflang="x-default" href="${DEPLOYED}/regras"`, `<meta property="og:url" content="${DEPLOYED}/regras">`]],
      ] as const) {
        const got = await new Deno.Command("curl", { args: ["-sS", "-H", `Host: ${host}`, `http://127.0.0.1:${port}${path}`], stdout: "piped", stderr: "piped" }).output();
        const body = new TextDecoder().decode(got.stdout);
        if (!got.success) fail(`${path}: ${new TextDecoder().decode(got.stderr)}`);
        for (const w of want) if (!body.includes(w)) fail(`${path} under Host ${host} does not spell ${w}:\n${body}`);
        if (body.includes(host.split(":")[0])) fail(`${path} under Host ${host} spells the Host:\n${body}`);
      }
    }
  });
} });

Deno.test({ name: "the door does not start without an origin to spell", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  for (const env of [[], ["ORIGIN="], ["ORIGIN=gol.example"], [`ORIGIN=${DEPLOYED}/`], [`ORIGIN=https://gol.example"><script>`]]) {
    await withDoor(env, async (name) => {
      for (let i = 0; (await docker(["inspect", "-f", "{{.State.Running}}", name])).out.trim() === "true"; i++) {
        if (i === 40) fail(`the door started under ${JSON.stringify(env)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      if ((await docker(["inspect", "-f", "{{.State.ExitCode}}", name])).out.trim() === "0") fail(`the door exited 0 under ${JSON.stringify(env)}`);
      const logs = await docker(["logs", name]);
      if (!logs.out.includes("is no origin")) fail(`the door under ${JSON.stringify(env)} said:\n${logs.out}`);
    });
  }
} });
