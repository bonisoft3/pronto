// The door continues the trace a request arrives with: its span is the child of
// the incoming traceparent, the upstream is sent that span as its parent, and
// the access line names the trace. With no collector anywhere, as in compose,
// the request is still answered.
//
// Read from what ships: pronto's Caddyfile, which every app's docker/Caddyfile
// is emitted from, behind resilience's snippets as emit puts them.

import { created } from "./docker-copy.ts";

const CADDYFILE = new URL("./assets/Caddyfile", import.meta.url);

function fail(message: string): never {
  throw new Error(message);
}

async function bounds(): Promise<string> {
  const result = await new Deno.Command("cue", { args: ["export", ".", "-e", "caddySnippets", "--out", "text"], cwd: new URL("./resilience/", import.meta.url), stdout: "piped", stderr: "piped" }).output();
  if (!result.success) fail(`cue export caddySnippets: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout);
}

// The image the cluster's door runs.
const CADDY = (await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url)))
  .match(/"(caddy:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1] ?? fail("cluster.cue pins no caddy image");

async function docker(args: string[]): Promise<string> {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) fail(`docker ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
}

// A crud that answers with the traceparent it was sent.
const CRUD = `:3000 {
  respond "{header.traceparent}" 200
}
`;

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";

Deno.test({ name: "the door's span is the child of the incoming traceparent and the parent of the upstream's", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const network = `caddy-tracing-${suffix}`;
  const scratch = await Deno.makeTempDir({ prefix: "caddy-tracing-" });
  const started: string[] = [];
  await Deno.writeTextFile(`${scratch}/crud`, CRUD);
  await Deno.writeTextFile(`${scratch}/door`, await bounds() + await Deno.readTextFile(CADDYFILE));
  await docker(["network", "create", network]);
  try {
    for (const [name, conf, extra] of [
      [`crud-${suffix}`, "crud", ["--network-alias", "crud"]],
      // Tracing is the deployment's to switch on: where no collector runs, an
      // exporter would spend each batch's deadline dialing one.
      [`door-${suffix}`, "door", ["-e", "ELECTRIC_SECRET=test", "-e", "ORIGIN=https://test.example", "-e", "PRONTO_TRACING=on", "-p", "127.0.0.1::8080"]],
    ] as const) {
      await docker(["start", await created(["--rm", "--name", name, "--network", network, ...extra, CADDY], [[`${scratch}/${conf}`, "/etc/caddy/Caddyfile"]])]);
      started.push(name);
    }
    const port = (await docker(["port", `door-${suffix}`, "8080"])).trim().split("\n")[0].split(":").pop();
    let sent: string | undefined;
    for (let i = 0; i < 40 && sent === undefined; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/crud/x`, { headers: { traceparent: `00-${TRACE}-${PARENT}-01` } }).catch(() => undefined);
      if (response?.status === 200) sent = await response.text();
      else {
        await response?.body?.cancel();
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (sent === undefined) fail("the door never reached crud");
    const [, trace, span] = sent.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/) ?? fail(`crud was sent no traceparent: ${JSON.stringify(sent)}`);
    if (trace !== TRACE) fail(`crud was sent trace ${trace}, not the incoming ${TRACE}`);
    if (span === PARENT) fail("crud was sent the incoming parent: the door opened no span of its own");
    const logs = await docker(["logs", `door-${suffix}`]);
    const line = logs.split("\n").find((l) => l.includes('"uri":"/crud/x"')) ?? fail(`the door logged no access line:\n${logs}`);
    const access = JSON.parse(line);
    if (access.traceID !== TRACE || access.spanID !== span) fail(`the access line names trace ${access.traceID} span ${access.spanID}, not ${TRACE} ${span}`);
  } finally {
    for (const name of started) await docker(["rm", "-f", name]);
    await docker(["network", "rm", network]);
    await Deno.remove(scratch, { recursive: true });
  }
} });
