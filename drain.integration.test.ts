// Finite batches exercise the emitted processors in the pinned runtime.
// No observation window can establish that an unbounded input stays idle.
import { deepStrictEqual as equal } from "node:assert/strict";
import { created } from "./docker-copy.ts";

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
  ] }, processors: [{ mutation: 'meta cdc_consumer = "test-projection"' }, { resource: "cdc_trace_join" }] });
  equal(config.pipeline.threads, 1);
  equal(config.output.http_client.max_in_flight, 1);
  equal(config.output.http_client.batching.period, "1s");

  const body = { batch_size: 50 };
  const call = { body, trace: "" };
  const event = (table: string, row: Record<string, unknown> = {}) => JSON.stringify({ data: JSON.stringify({ __table: table, ...row }) });
  const cases = [
    { name: "startup repairs missed changes", input: '{"wake":"start"}', accept: true },
    { name: "dirty rows wake the drain", input: event("dirty"), accept: true },
    { name: "the clock arrives as an explicit CDC event", input: event("day_tick"), accept: true },
    { name: "other tables do not wake the drain", input: event("unrelated"), accept: false },
    { name: "invalid envelopes do not wake the drain", input: "not json", accept: false },
    { name: "invalid row JSON does not wake the drain", input: '{"data":"not json"}', accept: false },
    { name: "missing table stamps do not wake the drain", input: '{"data":"{}"}', accept: false },
  ];
  type Test = { name: string; target_processors: string; input_batch: { content: string }[]; output_batches: Record<string, unknown>[][] };
  const tests: Test[] = cases.map(({ name, input, accept }) => ({
    name, target_processors: "/pipeline/processors", input_batch: [{ content: input }],
    output_batches: accept ? [[{ json_equals: call }]] : [],
  }));
  tests.push({
    name: "a burst requests one batch of work",
    target_processors: "/output/http_client/batching/processors",
    input_batch: Array.from({ length: 20 }, () => ({ content: JSON.stringify(call) })),
    output_batches: [[{ json_equals: body, bloblang: '!@.exists("traceparent")' }]],
  });
  // The call is what continues a trace: a drain's own deletes are marked with
  // the trace it sent, so a burst they wake carries the same one.
  const T1 = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const T2 = "00-1af7651916cd43dd8448eb211c80319c-c7ad6b7169203331-01";
  tests.push({
    name: "a batch of one transaction's trace continues it",
    target_processors: "/output/http_client/batching/processors",
    input_batch: [T1, "", T1].map((trace) => ({ content: JSON.stringify({ body, trace }) })),
    output_batches: [[{ json_equals: body, metadata_equals: { traceparent: T1 } }]],
  });
  tests.push({
    name: "a batch answering several traces continues the first",
    target_processors: "/output/http_client/batching/processors",
    input_batch: ["", T1, T2].map((trace) => ({ content: JSON.stringify({ body, trace }) })),
    output_batches: [[{ json_equals: body, metadata_equals: { traceparent: T1 } }]],
  });
  // A marker is no table change: consumed, it must not wake the drain as one.
  tests.push({
    name: "the row's transaction marker stamps its trace and is dropped",
    target_processors: "/input/processors",
    input_batch: [
      { content: event("txn_trace", { txid: 7, traceparent: T1 }) },
      { content: event("dirty", { txid: 7 }) },
      { content: '{"wake":"start"}' },
      { content: event("txn_trace", { txid: 8, traceparent: "" }) },
      { content: event("dirty", { txid: 8 }) },
    ],
    output_batches: [[
      { metadata_equals: { traceparent: T1 } },
      { metadata_equals: { traceparent: T1 } },
      { bloblang: '!@.exists("traceparent")' },
    ]],
  });
  tests.push({
    name: "empty input produces no work",
    target_processors: "/pipeline/processors", input_batch: [], output_batches: [],
  });
  const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
  const image = cluster.match(/"(redpandadata\/connect:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1];
  if (!image) throw new Error("cluster.cue pins no redpandadata/connect image");
  const trace = new URL("../../libraries/mecha/services/transform/cdc-trace.yaml", import.meta.url);
  const scratch = await Deno.makeTempDir({ prefix: "pronto-drain-" });
  try {
    await Deno.writeTextFile(`${scratch}/stream.yaml`, JSON.stringify(config));
    await Deno.copyFile(trace, `${scratch}/cdc-trace.yaml`);
    await Deno.writeTextFile(`${scratch}/stream_benthos_test.yaml`, JSON.stringify({ tests }));
    const result = await new Deno.Command("docker", {
      args: ["start", "-a", await created(["--rm", "--entrypoint", "/redpanda-connect",
        image, "test", "-r", "/w/cdc-trace.yaml", "/w/stream.yaml"], [[scratch, "/w"]])], stdout: "piped", stderr: "piped",
    }).output();
    if (!result.success) throw new Error(decoder.decode(result.stdout) + decoder.decode(result.stderr));
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});
