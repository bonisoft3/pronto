const root = new URL(".", import.meta.url);
const base = "http://127.0.0.1:18091";
const pipeline = "/v0/pipelines/postgres-sink";
const decoder = new TextDecoder();
type Row = {
  id: number;
  version: number;
  value: number | null;
  deleted: boolean;
};
type Audit = {
  operation: string;
  id: number;
  old_version: number | null;
  new_version: number | null;
};
type Evidence = {
  live: Record<string, Row[]>;
  live_audit: Audit[];
  guarded: {
    stale_replay: Row[];
    final: Row[];
    audit: Audit[];
  };
  before_restart: Row[];
  after_restart: Row[];
  stale_replay: Row[];
  duplicate_audit_before: number;
  duplicate_audit_after: number;
  audit: Audit[];
  checkpoint: { status: number; body: { error_code: string } };
  stats: unknown;
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, label: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify({ actual, expected })}`,
  );
}
async function command(args: string[], input?: string): Promise<string> {
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
  const result = await process.output();
  assert(
    result.success,
    `${args.join(" ")}: ${decoder.decode(result.stderr)}${
      decoder.decode(result.stdout)
    }`,
  );
  return decoder.decode(result.stdout);
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
  assert(response.ok, `${method} ${path}: ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out: ${JSON.stringify(value)}`);
}
async function status(wanted: string, timeout = 600000) {
  return await until(wanted, () => api(pipeline), (state) => {
    assert(
      !state.deployment_error &&
        !["SqlError", "RustError", "SystemError"].includes(
          state.program_status,
        ),
      JSON.stringify(state),
    );
    return state.deployment_status === wanted;
  }, timeout);
}
async function query(sql: string) {
  const response = await fetch(
    `${base}${pipeline}/query?${new URLSearchParams({ sql, format: "json" })}`,
    { signal: AbortSignal.timeout(30000) },
  );
  const text = await response.text();
  assert(response.ok, text);
  return text.trim()
    ? text.trim().split("\n").map((line) => JSON.parse(line))
    : [];
}
const rows = async (table = "authoritative"): Promise<Row[]> =>
  JSON.parse(
    await pg(
      `SELECT COALESCE(json_agg(t ORDER BY id), '[]') FROM ${table} t;`,
    ),
  );
const audit = async (table = "authoritative"): Promise<Audit[]> =>
  JSON.parse(
    await pg(
      `SELECT COALESCE(json_agg(t ORDER BY sequence), '[]') FROM write_audit t WHERE target='${table}';`,
    ),
  );
async function ingress(row: Row) {
  const before =
    (await api(`${pipeline}/stats`)).global_metrics.total_input_records;
  await api(`${pipeline}/ingress/candidate?format=json&array=true`, "POST", [{
    insert: row,
  }]);
  await until(
    "end-to-end input completion",
    () => api(`${pipeline}/stats`),
    (stats) => {
      for (const output of stats.outputs) {
        assert(
          !output.fatal_error &&
            output.metrics.num_encode_errors === 0 &&
            output.metrics.num_transport_errors === 0,
          `output connector failed: ${JSON.stringify(output)}`,
        );
      }
      return stats.global_metrics.total_completed_records >= before + 1;
    },
  );
  await until(
    "input observed",
    () =>
      query(
        `SELECT version FROM candidate WHERE id=${row.id} AND version=${row.version}`,
      ),
    (result) => result.length === 1,
  );
}
async function expectedRows(expected: Row[]) {
  return await until(
    "PostgreSQL rows",
    rows,
    (actual) => JSON.stringify(actual) === JSON.stringify(expected),
  );
}
function verify(e: Evidence) {
  equal(
    e.guarded.stale_replay,
    e.live.tombstone,
    "guarded target rejects stale resurrection",
  );
  equal(
    e.guarded.final,
    e.live.tombstone,
    "guarded target preserves tombstone on replay",
  );
  equal(
    e.guarded.audit.map((a) => [a.operation, a.old_version, a.new_version]),
    [
      ["INSERT", null, 20],
      ["UPDATE", 20, 30],
    ],
    "guarded target has only two durable effects across all replays",
  );
  equal(e.live_audit.map((a) => [a.operation, a.old_version, a.new_version]), [
    ["INSERT", null, 20],
    ["UPDATE", 20, 30],
  ], "all live writes are monotonic and duplicates have no side effect");
  equal(
    e.live.newer,
    [{ id: 1, version: 20, value: 200, deleted: false }],
    "new version",
  );
  equal(
    e.live.late_older,
    e.live.newer,
    "late overlap cannot overwrite live maximum",
  );
  equal(e.live.duplicate, e.live.newer, "duplicate live candidate");
  equal(
    e.live.tombstone,
    [{ id: 1, version: 30, value: null, deleted: true }],
    "tombstone",
  );
  equal(
    e.live.late_after_tombstone,
    e.live.tombstone,
    "late result cannot resurrect live tombstone",
  );
  equal(
    e.after_restart,
    e.before_restart,
    "restart leaves target intact before replay",
  );
  equal(
    e.stale_replay,
    [{ id: 1, version: 10, value: 100, deleted: false }],
    "stock sink replay limitation",
  );
  equal(
    e.duplicate_audit_after,
    e.duplicate_audit_before + 1,
    "fresh replay repeats update side effect",
  );
  assert(
    e.audit.some((a) => a.old_version === 30 && a.new_version === 10),
    "audit must witness committed version regression",
  );
  assert(
    e.audit.some((a) => a.old_version === 30 && a.new_version === 30),
    "audit must witness duplicate committed update",
  );
  equal(e.checkpoint.status, 501, "OSS checkpoint unavailable");
  equal(e.checkpoint.body.error_code, "EnterpriseFeature", "checkpoint tier");
}
async function restart() {
  await api(`${pipeline}/stop?force=true`, "POST");
  await status("Stopped", 30000);
  await api(`${pipeline}/start`, "POST");
  await status("Running", 90000);
  equal(
    await query("SELECT * FROM candidate"),
    [],
    "fresh OSS pipeline has no retained candidate state",
  );
}
async function integrate() {
  try {
    await compose("up", "-d", "--wait");
    await pg(await Deno.readTextFile(new URL("target.sql", root)));
    await api(pipeline, "PUT", {
      name: "postgres-sink",
      program_code: await Deno.readTextFile(new URL("program.sql", root)),
      runtime_config: { workers: 2, storage: null },
      program_config: { profile: "optimized" },
    });
    await api(`${pipeline}/start`, "POST");
    console.log("Compiling pinned native Feldera pipeline...");
    await status("Running");
    const newer = { id: 1, version: 20, value: 200, deleted: false };
    const older = { id: 1, version: 10, value: 100, deleted: false };
    const tombstone = { id: 1, version: 30, value: null, deleted: true };
    const live: Record<string, Row[]> = {};
    await ingress(newer);
    live.newer = await expectedRows([newer]);
    await ingress(older);
    live.late_older = await rows();
    const liveAudit = (await audit()).length;
    await ingress(newer);
    live.duplicate = await rows();
    equal(
      (await audit()).length,
      liveAudit,
      "duplicate live input must not cause PostgreSQL write",
    );
    await ingress(tombstone);
    live.tombstone = await expectedRows([tombstone]);
    await ingress({ id: 1, version: 25, value: 250, deleted: false });
    live.late_after_tombstone = await rows();
    const live_audit = await audit();
    const checkpointResponse = await fetch(base + pipeline + "/checkpoint", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
    });
    const checkpoint = {
      status: checkpointResponse.status,
      body: await checkpointResponse.json(),
    };
    const before_restart = await rows();
    await restart();
    const after_restart = await rows();
    await ingress(older);
    const stale_replay = await expectedRows([older]);
    const guarded_stale_replay = await rows("guarded");
    await ingress(tombstone);
    await expectedRows([tombstone]);
    const duplicate_audit_before = (await audit()).length;
    await restart();
    await ingress(tombstone);
    await until(
      "replay audit write",
      async () => (await audit()).length,
      (n) => n > duplicate_audit_before,
    );
    const duplicate_audit_after = (await audit()).length;
    const evidence: Evidence = {
      live,
      live_audit,
      guarded: {
        stale_replay: guarded_stale_replay,
        final: await rows("guarded"),
        audit: await audit("guarded"),
      },
      before_restart,
      after_restart,
      stale_replay,
      duplicate_audit_before,
      duplicate_audit_after,
      audit: await audit(),
      checkpoint,
      stats: await api(`${pipeline}/stats`),
    };
    verify(evidence);
    await Deno.writeTextFile(
      new URL("results/integration.json", root),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(
      "Live maximum/tombstone checks passed. Restart regression and duplicate side effects reproduced.",
    );
  } finally {
    await compose("down", "-v", "--remove-orphans");
  }
}
switch (Deno.args[0]) {
  case "doctor":
    console.log(await command(["deno", "--version"]));
    console.log(
      await command(["docker", "version", "--format", "{{.Server.Version}}"]),
    );
    await compose("config", "--quiet");
    break;
  case "test":
    verify(
      JSON.parse(
        await Deno.readTextFile(new URL("results/integration.json", root)),
      ),
    );
    console.log(
      "Retained real-runtime evidence satisfies live and recovery assertions.",
    );
    break;
  case "integrate":
    await integrate();
    break;
  default:
    throw new Error("usage: probe.ts doctor|test|integrate");
}
