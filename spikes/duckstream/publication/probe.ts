import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  parse,
  type Plan,
  require,
  type Schema,
  translate,
} from "../json-plan/translator.ts";

Deno.chdir(new URL(".", import.meta.url));
const jar = Deno.env.get("FELDERA_JAR") ??
  new URL("../compiler/.cache/feldera-0.367.0.jar", import.meta.url).pathname;
const jarHash =
  "d08430de8b34ae997b72c44eb9a9274b25955a41af35e7c6997e7e459d3283ab";
const scope = "double/v1/source-1";
const decoder = new TextDecoder();
type Result = {
  output_key: number;
  input_version: number;
  value: number;
  deleted: boolean;
};
type Change = { lsn: string; xid: string; data: string };
type SourceRow = [number, number, boolean];
function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
function equal(actual: unknown, expected: unknown, label: string) {
  require(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: actual=${JSON.stringify(actual)} expected=${
      JSON.stringify(expected)
    }`,
  );
}
async function refuses(action: () => Promise<unknown>, message: string) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  require(
    failure instanceof Error && failure.message.includes(message),
    `expected refusal ${message}; received ${failure}`,
  );
}
async function command(cmd: string, args: string[], input?: string) {
  const child = new Deno.Command(cmd, {
    args,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await child.output();
  require(result.success, `${cmd}: ${decoder.decode(result.stderr)}`);
  return decoder.decode(result.stdout).trim();
}
function compose(args: string[]) {
  return command("docker", ["compose", "-f", "compose.yaml", ...args]);
}
function pg(sql: string) {
  return command("docker", [
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
}
async function pgRows(sql: string): Promise<unknown[][]> {
  return JSON.parse(
    await pg(
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (${sql}) t;`,
    ),
  ).map((row: Record<string, unknown>) => Object.values(row));
}
async function rows(c: DuckDBConnection, sql: string): Promise<unknown[][]> {
  return (await c.runAndReadAll(sql)).getRows().map((row) =>
    row.map((value) => typeof value === "bigint" ? Number(value) : value)
  );
}
async function digest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
async function json(path: string, value: unknown) {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}
async function doctor() {
  require(Deno.version.deno === "2.8.2", "Deno 2.8.2");
  equal(await digest(await Deno.readFile(jar)), jarHash, "compiler hash");
  const version = await command("java", ["-jar", jar, "--version"]);
  require(version.includes("0.367.0"), "compiler 0.367.0");
  return {
    deno: Deno.version.deno,
    feldera: version,
    jar_sha256: jarHash,
    duckdb_package: "@duckdb/node-api@1.4.3-r.3",
    docker: await command("docker", ["info", "--format", "{{.ServerVersion}}"]),
  };
}
async function build() {
  const tools = await doctor();
  await Deno.mkdir("results", { recursive: true });
  await command("java", [
    "-jar",
    jar,
    "-i",
    "--alltables",
    "-v",
    "1",
    "--noRust",
    "--plan",
    "results/plan.json",
    "--js",
    "results/schema.json",
    "authoritative.sql",
  ]);
  const query = translate(
    parse(await Deno.readTextFile("results/plan.json")) as Plan,
    parse(await Deno.readTextFile("results/schema.json")) as Schema,
  );
  await Deno.writeTextFile("results/duckdb.sql", query);
  await json("results/build.json", {
    ...tools,
    source_sha256: await digest(await Deno.readFile("authoritative.sql")),
    translator_sha256: await digest(
      await Deno.readFile("../json-plan/translator.ts"),
    ),
  });
}
async function open(path: string) {
  const db = await DuckDBInstance.create(path);
  const c = await db.connect();
  await c.run(`
    CREATE TABLE IF NOT EXISTS capture(lsn VARCHAR PRIMARY KEY, payload VARCHAR NOT NULL, version BIGINT UNIQUE);
    CREATE TABLE IF NOT EXISTS source_state(id INTEGER PRIMARY KEY, value INTEGER, deleted BOOLEAN);
    CREATE TABLE IF NOT EXISTS snapshots(version BIGINT, id INTEGER, value INTEGER, deleted BOOLEAN, PRIMARY KEY(version,id));
    CREATE TABLE IF NOT EXISTS jobs(identity VARCHAR PRIMARY KEY, payload VARCHAR, completed BOOLEAN);
    CREATE TABLE IF NOT EXISTS candidates(output_key INTEGER, input_version BIGINT, value INTEGER, deleted BOOLEAN, PRIMARY KEY(output_key,input_version));
  `);
  return {
    c,
    close() {
      c.closeSync();
      db.closeSync();
    },
  };
}
async function peek(): Promise<Change[]> {
  const records: Change[] = JSON.parse(
    await pg(`
    SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
      SELECT lsn::text, xid::text, data FROM pg_logical_slot_peek_changes('spike', NULL, NULL)
      WHERE data LIKE 'BEGIN %' OR data LIKE 'COMMIT %' OR data LIKE 'table source.items:%'
    ) t;
  `),
  );
  const groups = new Map<string, Change[]>();
  for (const record of records) {
    const group = groups.get(record.xid) ?? [];
    group.push(record);
    groups.set(record.xid, group);
  }
  return [...groups.values()].filter((group) =>
    group.some((r) => r.data.startsWith("table source.items:"))
  ).flat();
}
async function capture(c: DuckDBConnection, events: Change[], version: number) {
  require(events.length >= 3, "one complete source transaction");
  const first = events[0];
  const last = events.at(-1)!;
  require(
    first.data === `BEGIN ${first.xid}` &&
      last.data === `COMMIT ${first.xid}` &&
      events.every((e) => e.xid === first.xid),
    "one complete source transaction",
  );
  const payload = JSON.stringify(events);
  const prior = await rows(
    c,
    `SELECT payload, version FROM capture WHERE lsn=${literal(last.lsn)}`,
  );
  if (prior.length) {
    equal(prior, [[payload, version]], "conflicting CDC identity");
    return false;
  }
  const frontier = await rows(
    c,
    "SELECT COALESCE(MAX(version),0) FROM capture",
  );
  require(version > Number(frontier[0][0]), "applied versions must advance");
  const changes: SourceRow[] = events.slice(1, -1).map(({ data }) => {
    const change =
      /^table source\.items: (INSERT|UPDATE|DELETE): (?:old-key: id\[integer\]:(\d+) value\[integer\]:(-?\d+) new-tuple: )?id\[integer\]:(\d+) value\[integer\]:(-?\d+)$/
        .exec(data);
    require(change, `unsupported source record ${data}`);
    require(
      change[2] === undefined || change[2] === change[4],
      "immutable source keys required",
    );
    return [Number(change[4]), Number(change[5]), change[1] === "DELETE"];
  });
  await c.run("BEGIN");
  try {
    for (const [id, value, deleted] of changes) {
      await c.run(`INSERT INTO source_state VALUES(${id},${value},${deleted})
        ON CONFLICT(id) DO UPDATE SET value=excluded.value, deleted=excluded.deleted`);
    }
    await c.run(`INSERT INTO snapshots SELECT ${version},* FROM source_state;
      INSERT INTO capture VALUES(${literal(last.lsn)},${
      literal(payload)
    },${version});
      COMMIT`);
  } catch (error) {
    await c.run("ROLLBACK");
    throw error;
  }
  return true;
}
async function acknowledge(lsn: string) {
  await pg(
    `SELECT count(*) FROM pg_logical_slot_get_changes('spike', ${
      literal(lsn)
    }::pg_lsn, NULL);`,
  );
}
const wasm = new WebAssembly.Instance(
  new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      6,
      1,
      96,
      1,
      127,
      1,
      127,
      3,
      2,
      1,
      0,
      7,
      10,
      1,
      6,
      100,
      111,
      117,
      98,
      108,
      101,
      0,
      0,
      10,
      9,
      1,
      7,
      0,
      32,
      0,
      65,
      2,
      108,
      11,
    ]),
  ),
).exports.double as (value: number) => number;
let wasmCalls = 0;
async function admit(
  c: DuckDBConnection,
  identity: string,
  version: number,
  keys: number[],
) {
  const payload = JSON.stringify({ scope, version, keys });
  const prior = await rows(
    c,
    `SELECT payload FROM jobs WHERE identity=${literal(identity)}`,
  );
  if (prior.length) {
    equal(prior, [[payload]], "conflicting job identity");
    return;
  }
  equal(
    await rows(
      c,
      `SELECT id FROM snapshots WHERE version=${version} AND id IN (${
        keys.join(",")
      }) ORDER BY id`,
    ),
    keys.map((key) => [key]),
    "all immutable job inputs retained",
  );
  await c.run(
    `INSERT INTO jobs VALUES(${literal(identity)},${literal(payload)},false)`,
  );
}
async function candidate(c: DuckDBConnection, result: Result) {
  const { output_key: key, input_version: version, value, deleted } = result;
  const prior = await rows(
    c,
    `SELECT value, deleted FROM candidates WHERE output_key=${key} AND input_version=${version}`,
  );
  if (prior.length) {
    equal(prior, [[value, deleted]], "conflicting candidate identity");
    return;
  }
  await c.run(
    `INSERT INTO candidates VALUES(${key},${version},${value},${deleted})`,
  );
}
async function execute(c: DuckDBConnection, identity: string) {
  const job = await rows(
    c,
    `SELECT payload,completed FROM jobs WHERE identity=${literal(identity)}`,
  );
  require(job.length === 1, "admitted job");
  if (job[0][1]) return;
  const { version, keys } = JSON.parse(String(job[0][0]));
  const inputs = await rows(
    c,
    `SELECT id,value,deleted FROM snapshots WHERE version=${version}
    AND id IN (${keys.join(",")}) ORDER BY id`,
  );
  const results = inputs.map(([id, value, deleted]) => {
    wasmCalls++;
    return {
      output_key: Number(id),
      input_version: version,
      value: deleted ? 0 : wasm(Number(value)),
      deleted: Boolean(deleted),
    };
  });
  await c.run("BEGIN");
  try {
    for (const result of results) await candidate(c, result);
    await c.run(
      `UPDATE jobs SET completed=true WHERE identity=${
        literal(identity)
      }; COMMIT`,
    );
  } catch (error) {
    await c.run("ROLLBACK");
    throw error;
  }
}
async function authoritative(
  c: DuckDBConnection,
  query: string,
): Promise<Result[]> {
  return (await rows(
    c,
    `SELECT * FROM (${query.trim().replace(/;$/, "")}) ORDER BY output_key`,
  ))
    .map(([key, version, value, deleted]) => ({
      output_key: Number(key),
      input_version: Number(version),
      value: Number(value),
      deleted: Boolean(deleted),
    }));
}
async function publish(
  identity: string,
  results: Result[],
  fault?: "rollback" | "lost-ack",
  authority = scope,
) {
  const payload = JSON.stringify({ scope: authority, rows: results });
  const outcome = await pg(`BEGIN;
    SELECT publish(${literal(identity)},${literal(payload)}::jsonb);
    ${fault === "rollback" ? "SELECT 1/0;" : ""}
    COMMIT;`);
  if (fault === "lost-ack") throw new Error("publication acknowledgement lost");
  return outcome;
}
async function test() {
  const checks: string[] = [];
  const check = (name: string) => {
    checks.push(name);
    console.log(name);
  };
  await doctor();
  const built = JSON.parse(await Deno.readTextFile("results/build.json"));
  equal(
    await digest(await Deno.readFile("authoritative.sql")),
    built.source_sha256,
    "build source current",
  );
  equal(
    await digest(await Deno.readFile("../json-plan/translator.ts")),
    built.translator_sha256,
    "build translator current",
  );
  const query = await Deno.readTextFile("results/duckdb.sql");
  const dir = await Deno.makeTempDir({ prefix: "duckstream-publication-" });
  let store = await open(`${dir}/state.duckdb`);
  await compose(["up", "-d", "--wait"]);
  try {
    await pg(await Deno.readTextFile("sink.sql"));
    await pg(
      "SELECT pg_create_logical_replication_slot('spike','test_decoding');",
    );
    await pg(
      "INSERT INTO source.items SELECT n,n FROM generate_series(1,15) n;",
    );
    const initial = await peek();
    equal(await capture(store.c, initial, 41), true, "capture bootstrap");
    store.close();
    store = await open(`${dir}/state.duckdb`);
    equal(
      await capture(store.c, await peek(), 41),
      false,
      "replay captured commit before slot ack",
    );
    const conflicting = structuredClone(initial);
    conflicting[1].data += " altered";
    await refuses(
      () => capture(store.c, conflicting, 41),
      "conflicting CDC identity",
    );
    await acknowledge(initial.at(-1)!.lsn);
    equal(
      await rows(store.c, "SELECT count(*) FROM snapshots"),
      [[15]],
      "bootstrap one retained snapshot",
    );
    check(
      "CDC commit replay after local reopen is deduplicated before acknowledgement",
    );
    await admit(store.c, "A", 41, Array.from({ length: 10 }, (_, i) => i + 1));
    await pg(
      "UPDATE source.items SET value=value+100 WHERE id BETWEEN 6 AND 15;",
    );
    const newer = await peek();
    await capture(store.c, newer, 90);
    await acknowledge(newer.at(-1)!.lsn);
    await admit(store.c, "B", 90, Array.from({ length: 10 }, (_, i) => i + 6));
    await refuses(
      () => admit(store.c, "A", 90, [6]),
      "conflicting job identity",
    );
    await execute(store.c, "B");
    const b = await authoritative(store.c, query);
    equal(
      b,
      Array.from({ length: 10 }, (_, i) => ({
        output_key: i + 6,
        input_version: 90,
        value: (i + 106) * 2,
        deleted: false,
      })),
      "B expected results",
    );
    await refuses(() => publish("B-out", b, "rollback"), "division by zero");
    equal(
      await pgRows("SELECT count(*) FROM outputs"),
      [[0]],
      "rolled back rows",
    );
    equal(
      await pgRows("SELECT count(*) FROM receipts"),
      [[0]],
      "rolled back receipt",
    );
    equal(
      await pgRows("SELECT count(*) FROM effects"),
      [[0]],
      "rolled back transactional effects",
    );
    check(
      "publication failure rolls back result, receipt and transactional hook",
    );
    await refuses(
      () => publish("B-out", b, "lost-ack"),
      "acknowledgement lost",
    );
    store.close();
    store = await open(`${dir}/state.duckdb`);
    const callsBeforeReplay = wasmCalls;
    await execute(store.c, "B");
    equal(
      wasmCalls,
      callsBeforeReplay,
      "completed candidate publication retry does not rerun WASM",
    );
    equal(
      await publish("B-out", b),
      "duplicate",
      "commit lost acknowledgement receipt",
    );
    equal(
      await pgRows("SELECT count(*) FROM effects"),
      [[10]],
      "exactly one effect per accepted B key",
    );
    check(
      "post-COMMIT acknowledgement loss and reopen replay reuse receipt without rerunning WASM",
    );
    await execute(store.c, "A");
    const combined = await authoritative(store.c, query);
    const expected = Array.from({ length: 15 }, (_, i) => ({
      output_key: i + 1,
      input_version: i < 5 ? 41 : 90,
      value: (i + 1 + (i < 5 ? 0 : 100)) * 2,
      deleted: false,
    }));
    equal(combined, expected, "late overlapping batch leaves newest per key");
    await publish("A-after-B", combined);
    equal(
      await pgRows(
        "SELECT output_key,input_version,value,deleted FROM outputs ORDER BY output_key",
      ),
      expected.map((r) => Object.values(r)),
      "sink newest per key",
    );
    equal(
      await pgRows("SELECT count(*) FROM effects"),
      [[15]],
      "overlap does not repeat effects",
    );
    await publish(
      "delayed-old-view",
      Array.from({ length: 10 }, (_, i) => ({
        output_key: i + 1,
        input_version: 41,
        value: (i + 1) * 2,
        deleted: false,
      })),
    );
    equal(
      await pgRows("SELECT count(*) FROM effects"),
      [[15]],
      "stale sink delivery no effect",
    );
    check(
      "overlapping reversed completions and reordered sink delivery never regress keys",
    );
    await candidate(store.c, expected[0]);
    equal(
      await rows(store.c, "SELECT count(*) FROM candidates"),
      [[20]],
      "duplicate candidate no multiplicity",
    );
    await refuses(
      () => candidate(store.c, { ...expected[0], value: 999 }),
      "conflicting candidate identity",
    );
    await refuses(
      () => publish("A-after-B", [{ ...expected[0], value: 999 }]),
      "conflicting publication identity",
    );
    await refuses(
      () => publish("conflicting-version", [{ ...expected[0], value: 999 }]),
      "conflicting output version",
    );
    await refuses(
      () => publish("other-writer", combined, undefined, "double/v2/source-1"),
      "unauthorized scope",
    );
    await refuses(
      () =>
        pg(
          "SELECT publish('null-scope','{\"scope\":null,\"rows\":[]}'::jsonb)",
        ),
      "unauthorized scope",
    );
    await refuses(
      () => pg("SELECT publish('missing-scope','{\"rows\":[]}'::jsonb)"),
      "unauthorized scope",
    );
    await refuses(
      () => pg(`SELECT publish('missing-rows','{"scope":"${scope}"}'::jsonb)`),
      "rows array required",
    );
    await refuses(
      () => publish("zero-version", [{ ...expected[0], input_version: 0 }]),
      "positive-version result required",
    );
    check(
      "candidate, publication and output-version conflicts fail; unauthorized writer fails",
    );
    await pg("DELETE FROM source.items WHERE id=6;");
    const deletion = await peek();
    await capture(store.c, deletion, 91);
    await acknowledge(deletion.at(-1)!.lsn);
    await admit(store.c, "delete-6", 91, [6]);
    await execute(store.c, "delete-6");
    const afterDelete = await authoritative(store.c, query);
    equal(afterDelete.find((r) => r.output_key === 6), {
      output_key: 6,
      input_version: 91,
      value: 0,
      deleted: true,
    }, "tombstone retained in view");
    await publish("delete-out", afterDelete);
    await publish("stale-before-delete", b);
    equal(
      await pgRows("SELECT output_key FROM visible_outputs WHERE output_key=6"),
      [],
      "deleted key not resurrected",
    );
    equal(
      await pgRows("SELECT count(*) FROM effects"),
      [[16]],
      "one tombstone effect",
    );
    check("versioned tombstone prevents resurrection by delayed old output");
    await pg("BEGIN; UPDATE source.items SET value=999 WHERE id=1; ROLLBACK;");
    const tail = await peek();
    require(
      !tail.some((r) => r.data.startsWith("table source.items:")),
      "aborted source write absent from CDC",
    );
    check("source rollback creates no computation input");
    const beforeMove = await pgRows(
      "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name='spike'",
    );
    await pg("UPDATE source.items SET id=101 WHERE id=1;");
    const moved = await peek();
    await refuses(
      () => capture(store.c, moved, 92),
      "immutable source keys required",
    );
    equal(
      await pgRows(
        "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name='spike'",
      ),
      beforeMove,
      "refused key move does not acknowledge WAL",
    );
    equal(
      await rows(store.c, "SELECT id FROM source_state WHERE id IN (1,101)"),
      [[1]],
      "refused key move preserves applied state",
    );
    check(
      "primary-key mutation fails before applying or acknowledging source transaction",
    );
    const races = await Promise.allSettled([
      publish("concurrent-older", [{
        output_key: 100,
        input_version: 100,
        value: 200,
        deleted: false,
      }]),
      publish("concurrent-newer", [{
        output_key: 100,
        input_version: 101,
        value: 202,
        deleted: false,
      }]),
    ]);
    require(
      races.every((r) => r.status === "fulfilled"),
      "concurrent publications succeed",
    );
    equal(
      await pgRows(
        "SELECT input_version,value FROM outputs WHERE output_key=100",
      ),
      [[101, 202]],
      "concurrent newest wins",
    );
    const raceEffects = await pgRows(
      "SELECT input_version FROM effects WHERE output_key=100 ORDER BY ordinal",
    );
    require(
      JSON.stringify(raceEffects) === "[[100],[101]]" ||
        JSON.stringify(raceEffects) === "[[101]]",
      "concurrent effects strictly advance",
    );
    check("concurrent PostgreSQL sink sessions serialize monotone replacement");
    const counts = (await rows(
      store.c,
      `SELECT
      (SELECT count(*) FROM capture),
      (SELECT count(DISTINCT version) FROM snapshots),
      (SELECT count(*) FROM jobs WHERE completed),
      (SELECT count(*) FROM candidates)`,
    ))[0];
    equal(counts, [3, 3, 3, 21], "durable pipeline cardinalities");
    const effects = (await pgRows(
      "SELECT count(*) FROM effects WHERE output_key<>100",
    ))[0][0];
    equal(effects, 16, "durable accepted pipeline effects");
    await json("results/tests.json", {
      status: "passed",
      checks,
      source_commits: counts[0],
      retained_snapshots: counts[1],
      completed_jobs: counts[2],
      canonical_candidates: counts[3],
      accepted_output_effects: effects,
      refused_primary_key_transactions: 1,
      concurrent_sink_fixture: {
        newest_version: 101,
        accepted_versions: raceEffects.flat(),
      },
      engines: {
        source_sink: "PostgreSQL 17.6",
        stream: "DuckDB 1.4.3",
        compiler: "Feldera 0.367.0",
        computation: "pure WASM i32 double",
      },
      fault_model:
        "deterministic application boundary injections, local-store close/reopen; no OS kill, HA or network partition",
    });
  } finally {
    store.close();
    await compose(["down", "-v"]);
    await Deno.remove(dir, { recursive: true });
  }
}
switch (Deno.args[0]) {
  case "doctor":
    console.log(JSON.stringify(await doctor(), null, 2));
    break;
  case "build":
    await build();
    break;
  case "test":
    await test();
    break;
  default:
    throw new Error("expected doctor, build or test");
}
