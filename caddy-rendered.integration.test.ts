// The door sends a route rendered on request to the terminal's renderer and
// every file the app serves to the file server. Regression: `@rendered` was
// matched ahead of the file check `@route` sits behind, so a route whose first
// segment is a :param, widened to `/*/*`, sent /shell/shell.json and
// /messages/<tag>.json to the renderer: the shell could not boot, and the
// renderer, which reads those same files through the door, asked itself for
// them inside its own serial queue and never became healthy.
//
// Read from what ships: #ssrCase's emitted Caddyfile for such a route, behind
// a renderer that says what it was asked.

const dir = new URL("./testdata/emit", import.meta.url).pathname;

function fail(message: string): never {
  throw new Error(message);
}

const CADDY = (await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url)))
  .match(/"(caddy:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1] ?? fail("cluster.cue pins no caddy image");

const exported = new Deno.Command("cue", { args: ["export", ".", "-e", `(#ssrCase & {reads: [_view], route: "/:team/:game"}).caddyfile`, "--out", "text"], cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
if (!exported.success) fail(new TextDecoder().decode(exported.stderr));
const caddyfile = new TextDecoder().decode(exported.stdout);

async function docker(args: string[]): Promise<string> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) fail(`docker ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout);
}

const RENDER = `:8090 {\n  respond "rendered {path}" 200\n}\n`;
const FILES: Record<string, string> = {
  "shell/shell.json": `{"app": "sync"}\n`,
  "shell/screens/jogo.html": "<section class=\"screen\"></section>\n",
  "messages/en.json": `{"brand": "sync"}\n`,
};

Deno.test({ name: "a route rendered on request whose first segment is a :param leaves the app's files to the file server", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const network = `caddy-rendered-${suffix}`;
  const scratch = await Deno.makeTempDir({ prefix: "caddy-rendered-" });
  const started: string[] = [];
  let networked = false;
  for (const [file, body] of Object.entries(FILES)) {
    await Deno.mkdir(`${scratch}/srv/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/srv/${file}`, body);
  }
  await Deno.writeTextFile(`${scratch}/Caddyfile`, caddyfile);
  await Deno.writeTextFile(`${scratch}/render`, RENDER);
  try {
    await docker(["network", "create", network]);
    networked = true;
    const run = async (name: string, alias: string, args: string[]) => {
      started.push(name);
      await docker(["run", "-d", "--name", name, "--network", network, "--network-alias", alias, ...args]);
    };
    await run(`render-${suffix}`, "render", ["-v", `${scratch}/render:/etc/caddy/Caddyfile:ro`, CADDY]);
    await run(`door-${suffix}`, "caddy", ["-e", "ELECTRIC_SECRET=test", "-e", "ORIGIN=https://test.example", "-p", "127.0.0.1::8080", "-v", `${scratch}/Caddyfile:/etc/caddy/Caddyfile:ro`, "-v", `${scratch}/srv:/srv:ro`, CADDY]);
    const port = (await docker(["port", `door-${suffix}`, "8080"])).trim().split("\n")[0].split(":").pop();
    const url = `http://127.0.0.1:${port}`;
    const get = async (path: string) => {
      const res = await fetch(`${url}${path}`);
      return { status: res.status, body: await res.text() };
    };
    for (let i = 0; ; i++) {
      const up = await get("/a/b").then((r) => r.body === "rendered /a/b", () => false);
      if (up) break;
      if (i === 40) fail(`the door never reached the renderer:\n${await docker(["logs", `door-${suffix}`])}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const [file, body] of Object.entries(FILES)) {
      const res = await get(`/${file}`);
      if (res.status !== 200 || res.body !== body) fail(`/${file} answered ${res.status}: ${res.body}`);
    }
  } finally {
    for (const name of started) await docker(["rm", "-f", name]);
    if (networked) await docker(["network", "rm", network]);
    await Deno.remove(scratch, { recursive: true });
  }
} });
