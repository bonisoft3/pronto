// A door with several sites answers each listed Host with its own origin and
// client, refuses every other Host with 421 before any route runs, replaces
// whatever origin or client a request claims, and serves the site's brand files
// from the brand's own directory on the assets host under a sandbox, sending it
// no cookie, credential or client. Without the mode, the door answers any Host
// as it always did, sending every upstream the deployment's origin and no
// client whatever the request claimed.
//
// Read from what ships: pronto's Caddyfile, which every app's docker/Caddyfile
// is emitted from, behind resilience's snippets as emit puts them.

const CADDYFILE = new URL("./assets/Caddyfile", import.meta.url);

function fail(message: string): never {
  throw new Error(message);
}

async function bounds(): Promise<string> {
  const result = await new Deno.Command("cue", { args: ["export", ".", "-e", "caddySnippets", "--out", "text"], cwd: new URL("./resilience/", import.meta.url), stdout: "piped", stderr: "piped" }).output();
  if (!result.success) fail(`cue export caddySnippets: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout);
}

// A crud that answers with the origin and client it was sent.
const CRUD = `:3000 {
  respond "{header.X-Pronto-Origin}|{header.X-Client-Id}" 200
}
`;

// An assets host: one logo with a validator and a cookie of its own, one file
// it fails on, two the door must never ask for, nothing else. The logo says what reached it.
const ASSETS = `:80 {
  handle /brand/logo/acme/l.svg {
    header ETag "\\"v1\\""
    header Content-Type image/svg+xml
    header Set-Cookie "assets=1"
    @fresh header If-None-Match "\\"v1\\""
    respond @fresh "" 304
    respond "<svg cookie='{header.Cookie}' authorization='{header.Authorization}' client='{header.X-Client-Id}' agent='{header.User-Agent}'/>" 200
  }
  # Files the door must never fetch for an Acme site: another brand's, another kind.
  @never path /brand/logo/other/l.svg /brand/css/acme/l.svg
  handle @never {
    respond "fetched" 200
  }
  handle /brand/favicon/acme/f.png {
    respond "" 500
  }
  respond "" 404
}
`;

type Answer = { status: number; headers: Map<string, string>; body: string };

// HTTP/1.1 by hand: fetch will not send a Host of the caller's choosing.
async function get(port: string, host: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: Number(port) });
  const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  await conn.write(new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n"));
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(65536);
  for (let n = await conn.read(buffer); n !== null; n = await conn.read(buffer)) chunks.push(buffer.slice(0, n));
  conn.close();
  const raw = new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
  const [head, ...rest] = raw.split("\r\n\r\n");
  const [status, ...fields] = head.split("\r\n");
  const answer = new Map(fields.map((f) => [f.slice(0, f.indexOf(":")).toLowerCase(), f.slice(f.indexOf(":") + 1).trim()]));
  let body = rest.join("\r\n\r\n");
  // A chunked body, as caddy writes a proxied one without a length.
  if (answer.get("transfer-encoding") === "chunked") {
    let out = "";
    for (let at = 0;;) {
      const eol = body.indexOf("\r\n", at);
      const size = parseInt(body.slice(at, eol), 16);
      if (!size) break;
      out += body.slice(eol + 2, eol + 2 + size);
      at = eol + 2 + size + 2;
    }
    body = out;
  }
  return { status: Number(status.split(" ")[1]), headers: answer, body };
}

function expect(what: string, got: unknown, want: unknown) {
  if (got !== want) fail(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// Each a caddy of its own (the caddy on PATH, which ci pins), on ports free now: crud and
// the assets host by the door's upstream variables, the door's automatic HTTPS kept off the machine's
// ports and trust store. The door is ready once `ready`, a Host the case's door answers, gets crud's 200.
const free = () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
};
async function withDoor(env: string[], use: (port: string) => Promise<void>, ready = "shop.example") {
  const scratch = await Deno.makeTempDir({ prefix: "caddy-sites-" });
  const [crud, assets, door, http, https, tls] = [free(), free(), free(), free(), free(), free()];
  const options = (name: string) => `  http_port ${http}\n  https_port ${https}\n  skip_install_trust\n  storage file_system ${scratch}/data-${name}\n`;
  await Deno.writeTextFile(`${scratch}/crud`, `{\n  admin off\n${options("crud")}}\n` + CRUD.replace(":3000", `:${crud}`));
  await Deno.writeTextFile(`${scratch}/assets`, `{\n  admin off\n${options("assets")}}\n` + ASSETS.replace(":80 {", `:${assets} {`));
  // resilience's snippets open with the global options, which the door's own join.
  const snippets = await bounds();
  if (!snippets.startsWith("{\n  admin off\n")) fail("resilience's snippets no longer open with the global options");
  await Deno.writeTextFile(`${scratch}/door`, snippets.replace("{\n  admin off\n", `{\n  admin off\n${options("door")}`) + await Deno.readTextFile(CADDYFILE));
  const doorEnv = {
    ELECTRIC_SECRET: "test",
    ORIGIN: "https://shop.example",
    PORT: String(door),
    CADDY_DOOR_PORT: String(tls),
    PRONTO_UPSTREAM_CRUD: `127.0.0.1:${crud}`,
    ...Object.fromEntries(env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1).replace("http://assets:80", `http://127.0.0.1:${assets}`)])),
  };
  const started: Deno.ChildProcess[] = [];
  try {
    for (const [conf, extra] of [["crud", {}], ["assets", {}], ["door", doorEnv]] as const) {
      started.push(new Deno.Command("caddy", {
        args: ["run", "--config", `${scratch}/${conf}`, "--adapter", "caddyfile"],
        env: { HOME: scratch, XDG_DATA_HOME: scratch, XDG_CONFIG_HOME: scratch, PATH: Deno.env.get("PATH") ?? "", ...extra },
        clearEnv: true,
        stdout: "null",
        stderr: "null",
      }).spawn());
    }
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = (await get(String(door), ready, "/crud/x").catch(() => undefined))?.status === 200;
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) fail("the door never answered");
    await use(String(door));
  } finally {
    // One that already exited (a config caddy refused) has its status to give.
    for (const p of started) {
      try {
        p.kill("SIGTERM");
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
      }
      await p.status;
    }
    await Deno.remove(scratch, { recursive: true });
  }
}

const SITES = [
  "SITES_MODE=on",
  "SITES=shop.example https://shop.example acme ACME\naccount.example https://account.example acme -\nbad.example https://bad.example/x acme -",
  "BRAND_DIRS=acme acme",
  "BRAND_ASSETS_ORIGIN=http://assets:80",
];
const FORGED = { "X-Client-Id": "FORGED", "X-Pronto-Origin": "https://evil.example" };

Deno.test({ name: "each listed site gets its own origin and client, whatever the request claims; an unlisted Host is 421", sanitizeOps: false, sanitizeResources: false, fn: () =>
  withDoor(SITES, async (port) => {
    expect("a site with a client", (await get(port, "shop.example", "/crud/x", FORGED)).body, "https://shop.example|ACME");
    expect("a site without one", (await get(port, "account.example", "/crud/x", FORGED)).body, "https://account.example|");
    expect("an unlisted Host, on a route", (await get(port, "evil.example", "/crud/x")).status, 421);
    expect("an unlisted Host, on a brand file", (await get(port, "evil.example", "/brand/logo/acme/l.svg")).status, 421);
    expect("a site whose origin is no origin", (await get(port, "bad.example", "/crud/x")).status, 421);
    // A probe names the pod's address, which is no site.
    expect("a probe's healthcheck", (await get(port, "10.0.0.7:8080", "/health")).status, 200);
  }) });

Deno.test({ name: "a site's brand files come from the assets host, sandboxed, and nothing of the reader's goes there", sanitizeOps: false, sanitizeResources: false, fn: () =>
  withDoor(SITES, async (port) => {
    const logo = await get(port, "shop.example", "/brand/logo/acme/l.svg", { Cookie: "session=1", Authorization: "Bearer t", ...FORGED });
    expect("the logo's status", logo.status, 200);
    expect("what reached the assets host", logo.body, "<svg cookie='' authorization='' client='' agent='pronto-door-brand-assets'/>");
    expect("the logo's policy", logo.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect("the logo's sniffing", logo.headers.get("x-content-type-options"), "nosniff");
    expect("the logo's caching", logo.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    expect("the logo's validator", logo.headers.get("etag"), '"v1"');
    expect("the assets host's cookie", logo.headers.get("set-cookie"), undefined);
    expect("a revalidation", (await get(port, "shop.example", "/brand/logo/acme/l.svg", { "If-None-Match": '"v1"' })).status, 304);
    expect("a file the assets host lacks", (await get(port, "shop.example", "/brand/logo/acme/gone.svg")).status, 404);
    expect("a file the assets host fails on", (await get(port, "shop.example", "/brand/favicon/acme/f.png")).status, 502);
    expect("another brand's directory", (await get(port, "shop.example", "/brand/logo/other/l.svg")).status, 404);
    expect("a kind no brand has", (await get(port, "shop.example", "/brand/css/acme/l.svg")).status, 404);
  }) });

// A deployment that moves its own port (a laptop's stack, on whatever port is free) names its one site's
// origin as the deployment's ORIGIN, which caddy reads when the line is matched; the Host's port picks
// nothing, so the site answers on every port.
Deno.test({ name: "a site whose origin is the deployment's ({env.ORIGIN}) gets that origin, whatever port its Host names", sanitizeOps: false, sanitizeResources: false, fn: () =>
  withDoor(["SITES_MODE=on", "SITES=localhost {env.ORIGIN} acme ACME", "BRAND_DIRS=acme acme", "BRAND_ASSETS_ORIGIN=http://assets:80"], async (port) => {
    expect("on one port", (await get(port, "localhost:33000", "/crud/x", FORGED)).body, "https://shop.example|ACME");
    expect("on another", (await get(port, "localhost:33100", "/crud/x")).body, "https://shop.example|ACME");
    expect("an unlisted Host", (await get(port, "evil.example", "/crud/x")).status, 421);
  }, "localhost:33000") });

Deno.test({ name: "without the mode, the door answers any Host with the deployment's origin and no client, whatever the request claims", sanitizeOps: false, sanitizeResources: false, fn: () =>
  withDoor([], async (port) => {
    const answer = await get(port, "evil.example", "/crud/x", FORGED);
    expect("any Host's status", answer.status, 200);
    expect("what crud was sent", answer.body, "https://shop.example|");
    expect("a brand file", (await get(port, "shop.example", "/brand/logo/acme/l.svg")).status, 404);
  }) });
