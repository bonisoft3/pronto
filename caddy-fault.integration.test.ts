// The door answers Electric's 5xx with a fixed body, since Postgres's text can
// quote a row the token does not reach. Regression: the replacement dropped
// every header Electric sent with it, so a 503 lost its Retry-After and the
// client retried on its own backoff while Electric was still starting, the
// window in which a screen fires dozens of subset requests.
//
// Read from the artifacts that ship: pronto's Caddyfile, which every app's
// docker/Caddyfile is emitted from, and mecha's own proxy.

const SHIPPED = [
  new URL("./assets/Caddyfile", import.meta.url),
  new URL("../../libraries/mecha/services/proxy/Caddyfile", import.meta.url),
];

function fail(message: string): never {
  throw new Error(message);
}

// The image the cluster's door runs.
const CADDY = (await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url)))
  .match(/"(caddy:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1] ?? fail("cluster.cue pins no caddy image");

async function docker(args: string[]): Promise<string> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) fail(`docker ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout);
}

/** The `@fault` matcher and its handle_response, as written in `caddyfile`. */
function faultBlock(caddyfile: string, where: string): string {
  const start = caddyfile.search(/^\s*@fault status 5xx$/m);
  if (start === -1) fail(`${where} answers no Electric 5xx`);
  const open = caddyfile.indexOf("handle_response @fault {", start);
  if (open === -1) fail(`${where} names @fault and handles no response with it`);
  let depth = 0;
  for (let i = caddyfile.indexOf("{", open); i < caddyfile.length; i++) {
    if (caddyfile[i] === "{") depth += 1;
    if (caddyfile[i] === "}" && --depth === 0) return caddyfile.slice(start, i + 1);
  }
  fail(`${where}: handle_response @fault never closes`);
}

// Electric's answer to a subset Postgres failed on another subject's row.
const ELECTRIC = `:3000 {
  header Retry-After 7
  header electric-handle 41-1700000000
  header Content-Type application/json
  respond \`{"message":"invalid input syntax for type integer: \\"secret_1\\""}\` 503
}
`;

for (const file of SHIPPED) {
  Deno.test({ name: `${file.pathname.split("/").slice(-3).join("/")} keeps Electric's 5xx headers and drops its text`, sanitizeOps: false, sanitizeResources: false, fn: async () => {
    const block = faultBlock(await Deno.readTextFile(file), file.pathname);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const network = `caddy-fault-${suffix}`;
    const scratch = await Deno.makeTempDir({ prefix: "caddy-fault-" });
    const started: string[] = [];
    await Deno.writeTextFile(`${scratch}/electric`, ELECTRIC);
    await Deno.writeTextFile(`${scratch}/door`, `:8080 {\n  reverse_proxy electric:3000 {\n${block}\n  }\n}\n`);
    await docker(["network", "create", network]);
    try {
      for (const [name, conf, extra] of [[`electric-${suffix}`, "electric", ["--network-alias", "electric"]], [`door-${suffix}`, "door", ["-p", "127.0.0.1::8080"]]] as const) {
        await docker(["run", "-d", "--rm", "--name", name, "--network", network, ...extra, "-v", `${scratch}/${conf}:/etc/caddy/Caddyfile:ro`, CADDY]);
        started.push(name);
      }
      const port = (await docker(["port", `door-${suffix}`, "8080"])).trim().split("\n")[0].split(":").pop();
      let response: Response | undefined;
      for (let i = 0; i < 40 && response === undefined; i++) {
        response = await fetch(`http://127.0.0.1:${port}/v1/shape`).catch(() => undefined);
        if (response === undefined) await new Promise((r) => setTimeout(r, 250));
      }
      if (response === undefined) fail("the door never answered");
      const body = await response.text();
      const got = {
        status: response.status,
        body,
        retryAfter: response.headers.get("retry-after"),
        handle: response.headers.get("electric-handle"),
        type: response.headers.get("content-type"),
      };
      const want = { status: 503, body: '{"message":"electric failed"}', retryAfter: "7", handle: "41-1700000000", type: "application/json" };
      if (JSON.stringify(got) !== JSON.stringify(want)) fail(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    } finally {
      for (const name of started) await docker(["rm", "-f", name]);
      await docker(["network", "rm", network]);
      await Deno.remove(scratch, { recursive: true });
    }
  } });
}
