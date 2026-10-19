// The emitted #rpkPipeline in the pinned Connect image, in streams mode with
// the transform's -r cdc-trace.yaml, reading a real Redis stream in the shape
// conduit publishes: each transaction's marker (`__table: txn_trace`)
// right before its first change. Crud is a mock that records each request's
// traceparent, the header PostgREST hands mecha.mark_txn to mark the derived
// write's own transaction with.
import { deepStrictEqual as equal } from "node:assert/strict";
import { created } from "./docker-copy.ts";

const decoder = new TextDecoder();
const REDIS = "redis:7.4.1-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933";
const T1 = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const T2 = "00-1af7651916cd43dd8448eb211c80319c-c7ad6b7169203331-01";

async function run(cmd: string, ...args: string[]) {
  const r = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(`${cmd} ${args.join(" ")}: ${decoder.decode(r.stderr)}`);
  return decoder.decode(r.stdout).trim();
}
async function until(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 60_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen in 60s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

Deno.test("a pipeline's calls carry their row's transaction trace, and markers are no rows", async () => {
  const exported = await new Deno.Command("cue", {
    cwd: new URL(".", import.meta.url),
    args: ["export", ".", "-e", `(#rpkPipeline & {
      p: {name: "count", from: "note", to: "note_count", group: "test-count",
        transform: {aggregate: "select=id", bloblang: "root = {\\"n\\": this.data.parse_json().n}"}}
      sourceTable: "note", sinkTable: "note_count", sinkPk: "id", carriers: {}
    }).out`],
    stdout: "piped", stderr: "piped",
  }).output();
  if (!exported.success) throw new Error(decoder.decode(exported.stderr));
  const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
  const image = cluster.match(/"(redpandadata\/connect:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1];
  if (!image) throw new Error("cluster.cue pins no redpandadata/connect image");

  const posts = new Map<number, string | null>();
  const gets: (string | null)[] = [];
  const crud = Deno.serve({ hostname: "0.0.0.0", port: 0, onListen() {} }, async (req) => {
    const trace = req.headers.get("traceparent");
    if (req.method === "GET") {
      gets.push(trace);
      return Response.json([]);
    }
    const { n } = await req.json();
    if (posts.has(n)) throw new Error(`row ${n} posted twice`);
    posts.set(n, trace);
    return new Response(null, { status: 201 });
  });
  const scratch = await Deno.makeTempDir({ prefix: "pronto-cdc-trace-" });
  const net = `pronto-cdc-trace-${crypto.randomUUID().slice(0, 8)}`;
  const containers: string[] = [];
  try {
    await Deno.writeTextFile(`${scratch}/stream.yaml`, decoder.decode(exported.stdout));
    await Deno.copyFile(new URL("../../libraries/mecha/services/transform/cdc-trace.yaml", import.meta.url), `${scratch}/cdc-trace.yaml`);
    await run("docker", "network", "create", net);
    const redis = await run("docker", "run", "-d", "--rm", "--network", net, "--network-alias", "redis", REDIS);
    containers.push(redis);
    const cli = (...args: string[]) => run("docker", "exec", redis, "redis-cli", "--json", ...args);
    await until(async () => (await cli("PING").catch(() => "")) === '"PONG"', "Redis answering PING");

    const bus = (row: Record<string, unknown>) => JSON.stringify({ data: JSON.stringify(row) });
    const marker = (txid: number, traceparent: string) => bus({ __table: "txn_trace", txid, traceparent, at: "2026-10-14 00:00:00+00" });
    const note = { __table: "note", id: "a" };
    await cli("EVAL", "for i = 1, #ARGV do redis.call('XADD', 'cdc-events', '*', 'data', ARGV[i]) end", "0",
      marker(10, T1),
      bus({ ...note, txid: 10, n: 1 }),
      bus({ ...note, txid: 10, n: 2, __before: JSON.stringify({ ...note, txid: 10 }) }),
      marker(11, ""),
      bus({ __table: "note", id: "b", txid: 11, n: 3 }),
      marker(12, T2),
      // A delete reaches the bus as its before-image, carrying its last
      // writer's txid: only the marker read before it names its transaction.
      bus({ ...note, txid: 10, n: 4 }));

    const connect = await created(["--rm", "--network", net,
      "--add-host=host.docker.internal:host-gateway",
      "-e", "REDIS_URL=redis://redis:6379", "-e", `CRUD_URL=http://host.docker.internal:${crud.addr.port}`,
      "--entrypoint", "/redpanda-connect", image, "streams", "-r", "/w/cdc-trace.yaml", "/w/stream.yaml"], [[scratch, "/w"]]);
    containers.push(connect);
    await run("docker", "start", connect);
    await until(async () => {
      const groups = JSON.parse(await cli("XINFO", "GROUPS", "cdc-events")) as { lag: number; pending: number }[];
      return groups.length === 1 && groups[0].lag === 0 && groups[0].pending === 0 && posts.size >= 4;
    }, "the stream settling");
    equal(Object.fromEntries(posts), { 1: T1, 2: T1, 3: null, 4: T2 });
    equal(gets.toSorted(), [T1, T1, T2, null].toSorted());
  } finally {
    for (const c of containers.toReversed()) await run("docker", "rm", "-f", c);
    await run("docker", "network", "rm", net);
    await crud.shutdown();
    await Deno.remove(scratch, { recursive: true });
  }
});
