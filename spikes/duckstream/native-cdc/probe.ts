const root = new URL(".", import.meta.url);
const base = "http://127.0.0.1:18096/v0/pipelines/native-cdc";
const decoder = new TextDecoder();
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function command(args: string[], input?: string) {
  const process = new Deno.Command(args[0], {
    args: args.slice(1),
    cwd: root,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const out = await process.output();
  assert(out.success, decoder.decode(out.stderr) + decoder.decode(out.stdout));
  return decoder.decode(out.stdout);
}
const compose = (...args: string[]) =>
  command(["docker", "compose", "-f", "compose.yaml", ...args]);
const pg = (sql: string) =>
  command([
    "docker",
    "compose",
    "-f",
    "compose.yaml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "spike",
  ], sql);
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  label: string,
  read: () => Promise<T>,
  ready: (v: T) => boolean,
  timeout = 30000,
) {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value!)}`);
}
async function state(wanted: string) {
  return await until(wanted, () => api(""), (s) => {
    assert(
      !s.deployment_error &&
        !["SqlError", "RustError", "SystemError"].includes(s.program_status),
      JSON.stringify(s),
    );
    return wanted === "Compiled"
      ? s.program_status === "Success"
      : s.deployment_status === wanted;
  }, 600000);
}
async function query(sql: string) {
  const response = await fetch(
    base + "/query?" + new URLSearchParams({ sql, format: "json" }),
  );
  const text = await response.text();
  assert(response.ok, text);
  return text.trim()
    ? text.trim().split("\n").map((line) => JSON.parse(line))
    : [];
}
function program(publication: string) {
  const tables = ["a", "b"].map((table) => {
    const connector = [{
      name: "cdc",
      max_batch_size: 1,
      transport: {
        name: "postgres_cdc_input",
        config: {
          uri: "postgres://postgres:spike@postgres:5432/spike",
          publication,
          source_table: "public." + table,
          batch: { max_fill_ms: 10 },
        },
      },
    }];
    return `CREATE TABLE ${table}(id INTEGER NOT NULL PRIMARY KEY, revision INTEGER NOT NULL) WITH ('materialized'='true','connectors'='${
      JSON.stringify(connector)
    }');`;
  });
  return tables.join("\n") + `
CREATE MATERIALIZED VIEW bounds AS SELECT MIN(revision) AS lo, MAX(revision) AS hi, COUNT(*) AS n FROM a;
CREATE TABLE observed(id INTEGER NOT NULL PRIMARY KEY, a_revision INTEGER NOT NULL, b_revision INTEGER NOT NULL);
CREATE MATERIALIZED VIEW pairs AS SELECT a.id,a.revision AS a_revision,b.revision AS b_revision FROM a JOIN b ON a.id=b.id;
CREATE MATERIALIZED VIEW pending_insert AS SELECT * FROM pairs EXCEPT ALL SELECT * FROM observed;
CREATE MATERIALIZED VIEW pending_delete AS SELECT * FROM observed EXCEPT ALL SELECT * FROM pairs;
`;
}
async function start(publication: string) {
  await api("", "PUT", {
    name: "native-cdc",
    program_code: program(publication),
    runtime_config: {
      workers: 1,
      storage: null,
      max_parallel_connector_init: 1,
    },
    program_config: { profile: "optimized" },
  });
  await state("Compiled");
  await api("/start", "POST");
  await state("Running");
}
async function stop() {
  await api("/stop?force=true", "POST");
  await state("Stopped");
}
const chunks: Record<string, unknown>[] = [];
const controller = new AbortController();
let stream: Promise<void> | undefined;
let evidence: Record<string, unknown> | undefined;
try {
  await compose("up", "-d", "--wait");
  await pg(
    `CREATE TABLE a(id integer PRIMARY KEY,revision integer NOT NULL); CREATE TABLE b(LIKE a INCLUDING ALL);
ALTER TABLE a REPLICA IDENTITY FULL; ALTER TABLE b REPLICA IDENTITY FULL;
INSERT INTO a VALUES (1,0),(2,0); INSERT INTO b SELECT * FROM a;
CREATE PUBLICATION native_cdc_1 FOR TABLE a,b;`,
  );
  await start("native_cdc_1");
  const bootstrap = await until(
    "baseline",
    () => query("SELECT * FROM pairs ORDER BY id"),
    (rows) => rows.length === 2,
  );
  const sourceState = await until(
    "source ready phases",
    async () =>
      JSON.parse(
        await pg(
          "SELECT json_agg(x) FROM (SELECT pipeline_id::text,table_id::regclass::text AS source_table,state::text,metadata FROM etl.replication_state WHERE is_current ORDER BY pipeline_id,table_id) x;",
        ),
      ),
    (rows) =>
      rows?.length > 0 &&
      rows.every((x: { state: string }) =>
        ["sync_done", "ready"].includes(x.state)
      ),
  );
  const sourceSlots = JSON.parse(
    await pg(
      "SELECT json_agg(x) FROM (SELECT slot_name,plugin,active,restart_lsn::text,confirmed_flush_lsn::text FROM pg_replication_slots ORDER BY slot_name) x;",
    ),
  );
  const bootstrapStats = (await api("/stats")).inputs;
  assert(
    sourceState.every((x: { state: string }) =>
      ["sync_done", "ready"].includes(x.state)
    ),
    "bootstrap ETL copy not complete",
  );
  assert(
    bootstrapStats.every((x: { barrier: boolean }) => !x.barrier),
    "bootstrap barrier retained",
  );
  const response = await fetch(
    base + "/egress/bounds?format=json&send_snapshot=true&backpressure=true",
    { method: "POST", signal: controller.signal },
  );
  assert(response.ok && response.body, "egress unavailable");
  stream = (async () => {
    const reader = response.body!.pipeThrough(new TextDecoderStream())
      .getReader();
    let pending = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += value;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) chunks.push(JSON.parse(line));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  await until(
    "egress snapshot",
    async () => chunks,
    (rows) => rows.some((r) => r.snapshot === true),
  );
  await pg("BEGIN; UPDATE a SET revision=1; COMMIT;");
  await until(
    "single transaction converges",
    () => query("SELECT * FROM bounds"),
    (r) => r[0]?.lo === 1 && r[0]?.hi === 1 && r[0]?.n === 2,
  );
  await sleep(200);
  const split = chunks.some((chunk) =>
    JSON.stringify(chunk.json_data).includes('"lo":0,"hi":1') ||
    JSON.stringify(chunk.json_data).includes('"hi":1,"lo":0')
  );
  console.log("single-transaction chunks", JSON.stringify(chunks));
  controller.abort();
  await stream;
  const stats = await api("/stats");
  const endpoint = stats.inputs.find((x: { endpoint_name: string }) =>
    x.endpoint_name.startsWith("a.")
  ).endpoint_name.split(".")[1];
  const path = `/tables/a/connectors/${endpoint}`;
  await api(path + "/pause", "POST");
  await pg("BEGIN; UPDATE a SET revision=2; UPDATE b SET revision=2; COMMIT;");
  const torn = await until("cross-table torn cut", () =>
    query("SELECT * FROM pairs ORDER BY id"), (r) =>
    r.length === 2 && r.every((x) =>
      x.a_revision === 1 && x.b_revision === 2
    ));
  await api(path + "/start", "POST");
  const converged = await until("cross-table converges", () =>
    query("SELECT * FROM pairs ORDER BY id"), (r) =>
    r.length === 2 && r.every((x) =>
      x.a_revision === 2 && x.b_revision === 2
    ));
  await api("/pause", "POST");
  await state("Paused");
  const paused = await query("SELECT * FROM pairs ORDER BY id");
  await pg("UPDATE a SET revision=4;");
  await sleep(200);
  assert(
    JSON.stringify(await query("SELECT * FROM pairs ORDER BY id")) ===
      JSON.stringify(paused),
    "paused materialized state changed",
  );
  await api("/resume", "POST");
  await state("Running");
  const baseline = await api(
    "/ingress/observed?format=json&array=true",
    "POST",
    paused.map((insert) => ({ insert })),
  );
  await until(
    "baseline completion",
    () =>
      api("/completion_status?token=" + encodeURIComponent(baseline.token)),
    (x) =>
      x.status === "complete",
  );
  const deltaInsert = await until("maintained insert delta", () =>
    query("SELECT * FROM pending_insert ORDER BY id"), (x) =>
    x.length === 2 && x.every((r) =>
      r.a_revision === 4
    ));
  const deltaDelete = await query("SELECT * FROM pending_delete ORDER BY id");
  assert(
    JSON.stringify(deltaDelete) === JSON.stringify(paused),
    "maintained retractions differ from baseline",
  );
  const advance = await api(
    "/ingress/observed?format=json&array=true",
    "POST",
    [
      ...deltaDelete.map((row) => ({ delete: row })),
      ...deltaInsert.map((insert) => ({ insert })),
    ],
  );
  await until("advance completion", () =>
    api("/completion_status?token=" + encodeURIComponent(advance.token)), (x) =>
    x.status === "complete");
  assert(
    (await query("SELECT * FROM pending_insert")).length === 0 &&
      (await query("SELECT * FROM pending_delete")).length === 0,
    "acknowledged delta remains",
  );
  await stop();
  await api("/start", "POST");
  await state("Running");
  await pg(
    "BEGIN; INSERT INTO a VALUES(3,3); INSERT INTO b VALUES(3,3); COMMIT;",
  );
  const lost = await until("same identity loses old rows", () =>
    query("SELECT * FROM pairs ORDER BY id"), (r) =>
    r.length === 1 && r[0].id === 3);
  await stop();
  await pg("CREATE PUBLICATION native_cdc_2 FOR TABLE a,b;");
  await start("native_cdc_2");
  const restored = await until("fresh identity reconstructs", () =>
    query("SELECT * FROM pairs ORDER BY id"), (r) =>
    r.length === 3 && r[0].a_revision === 4 && r[2].a_revision === 3);
  evidence = {
    executed_at: new Date().toISOString(),
    version: "0.367.0",
    source_state: sourceState,
    source_slots: sourceSlots,
    bootstrap_stats: bootstrapStats,
    bootstrap,
    single_transaction_split: split,
    egress_chunks: chunks,
    cross_table_torn: torn,
    converged,
    paused,
    delta_insert: deltaInsert,
    delta_delete: deltaDelete,
    without_checkpoint: lost,
    new_publication: restored,
  };
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  controller.abort();
  if (stream) await stream;
  await compose("down", "-v");
}
assert(evidence, "missing evidence");
await Deno.writeTextFile(
  new URL("results.json", root),
  JSON.stringify(evidence, null, 2) + "\n",
);
