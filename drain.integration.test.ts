// Finite batches exercise the emitted processors in the pinned runtime.
// No observation window can establish that an unbounded input stays idle.
import { deepStrictEqual as equal } from "node:assert/strict";

const decoder = new TextDecoder();

Deno.test("drains accept only startup and declared changes, and coalesce pending work", async () => {
  const exported = new Deno.Command("cue", {
    cwd: new URL(".", import.meta.url),
    args: ["export", ".", "-e", '(#rpkDrain & {app: "test", d: {name: "projection", on: ["dirty", "day_tick"], call: "refresh", body: {batch_size: 50}}}).out'],
    stdout: "piped", stderr: "piped",
  }).outputSync();
  if (!exported.success) throw new Error(decoder.decode(exported.stderr));
  const config = JSON.parse(decoder.decode(exported.stdout));
  equal(config.input, { broker: { inputs: [
    { redis_streams: { url: "${REDIS_URL}", streams: ["cdc-events"], body_key: "data", consumer_group: "test-projection" } },
    { generate: { count: 1, interval: "", mapping: 'root = {"wake": "start"}' } },
  ] } });
  equal(config.pipeline.threads, 1);
  equal(config.output.http_client.max_in_flight, 1);
  equal(config.output.http_client.batching.period, "1s");

  const body = { batch_size: 50 };
  const event = (table: string) => JSON.stringify({ data: JSON.stringify({ __table: table }) });
  const cases = [
    { name: "startup repairs missed changes", input: '{"wake":"start"}', accept: true },
    { name: "dirty rows wake the drain", input: event("dirty"), accept: true },
    { name: "the clock arrives as an explicit CDC event", input: event("day_tick"), accept: true },
    { name: "other tables do not wake the drain", input: event("unrelated"), accept: false },
    { name: "invalid envelopes do not wake the drain", input: "not json", accept: false },
    { name: "invalid row JSON does not wake the drain", input: '{"data":"not json"}', accept: false },
    { name: "missing table stamps do not wake the drain", input: '{"data":"{}"}', accept: false },
  ];
  const tests = cases.map(({ name, input, accept }) => ({
    name, target_processors: "/pipeline/processors", input_batch: [{ content: input }],
    output_batches: accept ? [[{ json_equals: body }]] : [],
  }));
  tests.push({
    name: "a burst requests one batch of work",
    target_processors: "/output/http_client/batching/processors",
    input_batch: Array.from({ length: 20 }, () => ({ content: JSON.stringify(body) })),
    output_batches: [[{ json_equals: body }]],
  });
  tests.push({
    name: "empty input produces no work",
    target_processors: "/pipeline/processors", input_batch: [], output_batches: [],
  });
  const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
  const image = cluster.match(/"(redpandadata\/connect:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1];
  if (!image) throw new Error("cluster.cue pins no redpandadata/connect image");
  const scratch = await Deno.makeTempDir({ prefix: "pronto-drain-" });
  try {
    await Deno.writeTextFile(`${scratch}/stream.yaml`, JSON.stringify(config));
    await Deno.writeTextFile(`${scratch}/stream_benthos_test.yaml`, JSON.stringify({ tests }));
    const result = await new Deno.Command("docker", {
      args: ["run", "--rm", "-v", `${scratch}:/w:ro`, "--entrypoint", "/redpanda-connect",
        image, "test", "/w/stream.yaml"], stdout: "piped", stderr: "piped",
    }).output();
    if (!result.success) throw new Error(decoder.decode(result.stdout) + decoder.decode(result.stderr));
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});
