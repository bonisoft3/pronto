import {
  assert,
  compose,
  counts,
  doctor,
  envelope,
  equal,
  expected,
  json,
  payload,
  pg,
  snapshot,
} from "./probe.ts";
const base = "http://127.0.0.1:18092";
const pipeline = "/v0/pipelines/generation";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${path}: ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function until<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out`);
}
const status = (wanted: string) =>
  until(wanted, () => api(pipeline), (state) => {
    assert(
      !state.deployment_error &&
        !["SqlError", "RustError", "SystemError"].includes(
          state.program_status,
        ),
      JSON.stringify(state),
    );
    return state.deployment_status === wanted;
  }, 600000);
async function send(e: Awaited<ReturnType<typeof envelope>>) {
  const before =
    (await api(`${pipeline}/stats`)).global_metrics.total_input_records;
  await api(`${pipeline}/ingress/candidate?format=json&array=true`, "POST", [{
    insert: {
      scope: "accounts/v1/source-1",
      generation: e.generation,
      payload: JSON.stringify(e.payload),
      digest: e.digest,
    },
  }]);
  await until(
    "native connector completion",
    () => api(`${pipeline}/stats`),
    (stats) => {
      for (const output of stats.outputs) {
        assert(
          !output.fatal_error && output.metrics.num_encode_errors === 0 &&
            output.metrics.num_transport_errors === 0,
          JSON.stringify(output),
        );
      }
      return stats.global_metrics.total_completed_records >= before + 1;
    },
  );
}
async function restart() {
  await api(`${pipeline}/stop?force=true`, "POST");
  await status("Stopped");
  await api(`${pipeline}/start`, "POST");
  await status("Running");
}
try {
  await compose(["--profile", "native", "up", "-d", "--wait"]);
  await pg(await Deno.readTextFile("sink.sql"));
  await pg(
    "CREATE ROLE native_writer LOGIN PASSWORD 'spike'; GRANT generation_writer TO native_writer;",
  );
  await api(pipeline, "PUT", {
    name: "generation",
    program_code: await Deno.readTextFile("program.sql"),
    runtime_config: { workers: 2, storage: null },
    program_config: { profile: "optimized" },
  });
  await api(`${pipeline}/start`, "POST");
  console.log("Compiling pinned native complete-generation pipeline...");
  await status("Running");
  const a = await envelope(100, payload([10, 20]));
  const b = await envelope(200, payload([35]));
  await send(a);
  const first = await until(
    "generation 100",
    snapshot,
    (s) => s.generation === 100,
  );
  equal(first, expected(a), "native first complete generation");
  await send(b);
  const second = await until(
    "generation 200",
    snapshot,
    (s) => s.generation === 200,
  );
  equal(second, expected(b), "native second complete generation");
  equal(await counts(), [2, 2], "two native generations two hooks");
  await restart();
  await send(a);
  const afterOldReplay = await snapshot();
  equal(
    afterOldReplay,
    expected(b),
    "native older replay after fresh start fenced",
  );
  const staleIngress = await pg("SELECT generation FROM generation_ingress;");
  equal(
    staleIngress,
    "100",
    "native connector really redelivered older generation after fresh start",
  );
  equal(await counts(), [2, 2], "old native replay no repeated hook");
  await send(b);
  equal(await snapshot(), expected(b), "native latest replay");
  equal(await counts(), [2, 2], "latest native replay no repeated hook");
  const empty = await envelope(300, payload([]));
  await send(empty);
  const final = await until(
    "empty native generation",
    snapshot,
    (s) => s.generation === 300,
  );
  equal(final, expected(empty), "native empty generation deletes both tables");
  equal(await counts(), [3, 3], "empty generation has one hook");
  await json("results/native.json", {
    tools: await doctor(),
    transport:
      "Feldera 0.367.0 postgres_output materialized mode → generation_ingress AFTER trigger → publish_generation",
    custom_delivery_worker: false,
    first,
    second,
    after_old_replay: afterOldReplay,
    ingress_generation_after_old_replay: staleIngress,
    final,
    counts: await counts(),
    stats: await api(`${pipeline}/stats`),
    restart:
      "stop/start with storage null; older complete candidate replayed before current candidate",
  });
  console.log(
    "PASS native connector atomically activates two tables, fences restart replay, deduplicates hooks and publishes empty generation",
  );
} finally {
  await compose(["--profile", "native", "down", "-v", "--remove-orphans"]);
}
