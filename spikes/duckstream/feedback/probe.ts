import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  parse,
  type Plan,
  require,
  type Schema,
  translate,
} from "../json-plan/translator.ts";

Deno.chdir(new URL(".", import.meta.url));
const jarHash =
  "d08430de8b34ae997b72c44eb9a9274b25955a41af35e7c6997e7e459d3283ab";
const jar = Deno.env.get("FELDERA_JAR") ??
  new URL("../compiler/.cache/feldera-0.367.0.jar", import.meta.url).pathname;
const decoder = new TextDecoder();
const keyColumns = "computation, program, epoch";
type Key = [string, string, string];
type Row = [
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  boolean,
  boolean,
];
type Event =
  | { kind: "applied"; key: Key; snapshot: number }
  | {
    kind: "lifecycle";
    key: Key;
    revision: number;
    busy: number;
    published: number;
  };
type Claim = {
  token: string;
  key: Key;
  target: number;
  fence: number;
  outcome: "running" | "completed" | "failed";
};
function literal(value: string | number) {
  if (typeof value === "number") {
    require(
      Number.isSafeInteger(value) && value >= 0,
      "nonnegative exact version",
    );
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}
function values(key: Key) {
  return key.map(literal).join(", ");
}
function where(key: Key) {
  return ["computation", "program", "epoch"].map((c, i) =>
    `${c} = ${literal(key[i])}`
  ).join(" AND ");
}
async function rows(c: DuckDBConnection, sql: string): Promise<unknown[][]> {
  const result = await c.runAndReadAll(sql);
  return result.getRows().map((row) =>
    row.map((v) => typeof v === "bigint" ? Number(v) : v)
  );
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
async function json(path: string, value: unknown) {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}
async function digest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
async function command(cmd: string, args: string[]) {
  const result = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  require(
    result.success,
    `${cmd} exited ${result.code}\n${decoder.decode(result.stderr)}`,
  );
  return decoder.decode(result.stdout);
}
async function doctor() {
  require(Deno.version.deno === "2.8.2", "Deno 2.8.2");
  equal(await digest(await Deno.readFile(jar)), jarHash, "compiler hash");
  const version = (await command("java", ["-jar", jar, "--version"])).trim();
  require(version.includes("0.367.0"), "compiler 0.367.0");
  return {
    deno: Deno.version.deno,
    feldera: version,
    jar_sha256: jarHash,
    duckdb_package: "@duckdb/node-api@1.4.3-r.3",
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
    "coordinator.sql",
  ]);
  const query = translate(
    parse(await Deno.readTextFile("results/plan.json")) as Plan,
    parse(await Deno.readTextFile("results/schema.json")) as Schema,
  );
  await Deno.writeTextFile("results/duckdb.sql", query);
  await json("results/build.json", {
    ...tools,
    flags: ["-i", "--alltables", "-v", "1", "--noRust", "--plan", "--js"],
    source_sha256: await digest(await Deno.readFile("coordinator.sql")),
    translator_sha256: await digest(
      await Deno.readFile("../json-plan/translator.ts"),
    ),
  });
  console.log("Stock compiler export translated into native DuckDB query");
}
async function open(path: string) {
  const db = await DuckDBInstance.create(path);
  const c = await db.connect();
  return {
    db,
    c,
    close() {
      c.closeSync();
      db.closeSync();
    },
  };
}
type Database = Awaited<ReturnType<typeof open>>;
class Stream {
  constructor(readonly database: Database, readonly query: string) {}
  async init() {
    await this.database.c.run(`
      CREATE TABLE IF NOT EXISTS applied(computation VARCHAR, program VARCHAR, epoch VARCHAR, snapshot BIGINT);
      CREATE TABLE IF NOT EXISTS lifecycle(computation VARCHAR, program VARCHAR, epoch VARCHAR,
        revision BIGINT, busy INTEGER, published_through BIGINT);
    `);
  }
  async append(event: Event) {
    const c = this.database.c;
    if (event.kind === "lifecycle") {
      const existing = await rows(
        c,
        `SELECT DISTINCT busy, published_through FROM lifecycle
        WHERE ${where(event.key)} AND revision = ${literal(event.revision)}`,
      );
      require(
        existing.length === 0 ||
          JSON.stringify(existing) ===
            JSON.stringify([[event.busy, event.published]]),
        "conflicting lifecycle revision",
      );
      await c.run(`INSERT INTO lifecycle VALUES (${values(event.key)},
        ${literal(event.revision)}, ${literal(event.busy)}, ${
        literal(event.published)
      })`);
    } else {
      await c.run(
        `INSERT INTO ${event.kind} VALUES (${values(event.key)}, ${
          literal(event.snapshot)
        })`,
      );
    }
  }
  async apply(
    key: Key,
    snapshot: number,
    notification: { durable: boolean; complete: boolean; versionKind: string },
  ) {
    require(
      notification.durable && notification.complete &&
        notification.versionKind === "applied_snapshot",
      "durable complete applied snapshot required",
    );
    require(snapshot > 0, "positive applied snapshot");
    await this.append({ kind: "applied", key, snapshot });
  }
  async state(): Promise<Row[]> {
    return await rows(
      this.database.c,
      `SELECT * FROM (${
        this.query.trim().replace(/;$/, "")
      }) ORDER BY computation, program, epoch`,
    ) as Row[];
  }
  async count() {
    return (await rows(
      this.database.c,
      `SELECT
      (SELECT COUNT(*) FROM applied) + (SELECT COUNT(*) FROM lifecycle)`,
    ))[0][0];
  }
  async replayInto(destination: Stream) {
    for (
      const [computation, program, epoch, snapshot] of await rows(
        this.database.c,
        "SELECT * FROM applied",
      )
    ) {
      await destination.append({
        kind: "applied",
        key: [computation, program, epoch] as Key,
        snapshot: snapshot as number,
      });
    }
    for (
      const [computation, program, epoch, revision, busy, published]
        of await rows(
          this.database.c,
          "SELECT * FROM lifecycle ORDER BY revision DESC",
        )
    ) {
      await destination.append({
        kind: "lifecycle",
        key: [computation, program, epoch] as Key,
        revision: revision as number,
        busy: busy as number,
        published: published as number,
      });
    }
  }
}
class Boundary {
  constructor(readonly database: Database) {}
  async init() {
    await this.database.c.run(`
      CREATE TABLE IF NOT EXISTS executions(computation VARCHAR, program VARCHAR, epoch VARCHAR,
        revision BIGINT, busy INTEGER, target BIGINT, covered BIGINT, token VARCHAR,
        PRIMARY KEY (${keyColumns}));
      CREATE TABLE IF NOT EXISTS attempts(token VARCHAR PRIMARY KEY, computation VARCHAR,
        program VARCHAR, epoch VARCHAR, target BIGINT, fence BIGINT, outcome VARCHAR);
      CREATE TABLE IF NOT EXISTS artifacts(computation VARCHAR, program VARCHAR, epoch VARCHAR,
        snapshot BIGINT, payload VARCHAR, PRIMARY KEY (${keyColumns}));
      CREATE TABLE IF NOT EXISTS receipts(token VARCHAR PRIMARY KEY, computation VARCHAR,
        program VARCHAR, epoch VARCHAR, snapshot BIGINT, payload VARCHAR);
      CREATE SEQUENCE IF NOT EXISTS event_sequence;
      CREATE TABLE IF NOT EXISTS outbox(id BIGINT DEFAULT nextval('event_sequence'), event VARCHAR);
    `);
  }
  async atomic<T>(operation: () => Promise<T>): Promise<T> {
    await this.database.c.run("BEGIN");
    try {
      const result = await operation();
      await this.database.c.run("COMMIT");
      return result;
    } catch (error) {
      await this.database.c.run("ROLLBACK");
      throw error;
    }
  }
  async emit(event: Event) {
    await this.database.c.run(
      `INSERT INTO outbox(event) VALUES (${literal(JSON.stringify(event))})`,
    );
  }
  async events(): Promise<Event[]> {
    return (await rows(this.database.c, "SELECT event FROM outbox ORDER BY id"))
      .map(([event]) => JSON.parse(event as string) as Event);
  }
  async claim(
    row: Row,
    token: string,
    injectFailure = false,
  ): Promise<Claim | null> {
    require(row[8], "SQL eligibility required");
    const key = row.slice(0, 3) as Key;
    const target = row[3], revision = row[5];
    return await this.atomic(async () => {
      const c = this.database.c;
      const old = await rows(
        c,
        `SELECT ${keyColumns}, target, fence, outcome FROM attempts WHERE token = ${
          literal(token)
        }`,
      );
      if (old.length) {
        equal(
          old[0].slice(0, 5),
          [...key, target, revision + 1],
          "claim token identity",
        );
        return {
          key,
          token,
          target,
          fence: revision + 1,
          outcome: old[0][5] as Claim["outcome"],
        };
      }
      await c.run(
        `INSERT INTO executions VALUES (${values(key)}, 0, 0, 0, 0, '')
        ON CONFLICT DO NOTHING`,
      );
      const updated = await rows(
        c,
        `UPDATE executions SET revision = revision + 1,
        busy = 1, target = ${literal(target)}, token = ${literal(token)}
        WHERE ${where(key)} AND revision = ${
          literal(revision)
        } AND busy = 0 AND covered < ${literal(target)}
        RETURNING revision, covered`,
      );
      if (!updated.length) return null;
      await c.run(
        `INSERT INTO attempts VALUES (${literal(token)}, ${values(key)},
        ${literal(target)}, ${literal(revision + 1)}, 'running')`,
      );
      require(!injectFailure, "injected admission failure");
      await this.emit({
        kind: "lifecycle",
        key,
        revision: revision + 1,
        busy: 1,
        published: updated[0][1] as number,
      });
      return { key, token, target, fence: revision + 1, outcome: "running" };
    });
  }
  async fail(claim: Claim) {
    await this.atomic(async () => {
      const c = this.database.c;
      const updated = await rows(
        c,
        `UPDATE executions SET revision = revision + 1, busy = 0
        WHERE ${where(claim.key)} AND revision = ${literal(claim.fence)}
          AND token = ${
          literal(claim.token)
        } AND busy = 1 RETURNING revision, covered`,
      );
      require(updated.length === 1, "stale failure fence");
      await c.run(
        `UPDATE attempts SET outcome = 'failed' WHERE token = ${
          literal(claim.token)
        }`,
      );
      await this.emit({
        kind: "lifecycle",
        key: claim.key,
        revision: updated[0][0] as number,
        busy: 0,
        published: updated[0][1] as number,
      });
    });
  }
  async publish(claim: Claim, payload: string, injectFailure = false) {
    return await this.atomic(async () => {
      const c = this.database.c;
      const old = await rows(
        c,
        `SELECT ${keyColumns}, snapshot, payload FROM receipts WHERE token = ${
          literal(claim.token)
        }`,
      );
      if (old.length) {
        equal(
          old[0],
          [...claim.key, claim.target, payload],
          "publication token identity",
        );
        return old[0];
      }
      const updated = await rows(
        c,
        `UPDATE executions SET revision = revision + 1,
        busy = 0, covered = target WHERE ${where(claim.key)}
          AND revision = ${literal(claim.fence)} AND token = ${
          literal(claim.token)
        }
          AND target = ${
          literal(claim.target)
        } AND busy = 1 RETURNING revision`,
      );
      require(updated.length === 1, "stale publication fence");
      await c.run(
        `INSERT INTO artifacts VALUES (${values(claim.key)}, ${
          literal(claim.target)
        }, ${literal(payload)})
        ON CONFLICT (${keyColumns}) DO UPDATE SET snapshot = EXCLUDED.snapshot, payload = EXCLUDED.payload`,
      );
      require(!injectFailure, "injected publication failure");
      await c.run(
        `INSERT INTO receipts VALUES (${literal(claim.token)}, ${
          values(claim.key)
        },
        ${literal(claim.target)}, ${literal(payload)})`,
      );
      await c.run(
        `UPDATE attempts SET outcome = 'completed' WHERE token = ${
          literal(claim.token)
        }`,
      );
      await this.emit({
        kind: "lifecycle",
        key: claim.key,
        revision: updated[0][0] as number,
        busy: 0,
        published: claim.target,
      });
      return [...claim.key, claim.target, payload];
    });
  }
  async counts() {
    return (await rows(
      this.database.c,
      `SELECT
      (SELECT COUNT(*) FROM executions), (SELECT COUNT(*) FROM attempts),
      (SELECT COUNT(*) FROM receipts), (SELECT COUNT(*) FROM outbox)`,
    ))[0];
  }
}
async function test() {
  await doctor();
  const manifest = JSON.parse(await Deno.readTextFile("results/build.json"));
  equal(
    await digest(await Deno.readFile("coordinator.sql")),
    manifest.source_sha256,
    "built source",
  );
  equal(
    await digest(await Deno.readFile("../json-plan/translator.ts")),
    manifest.translator_sha256,
    "built translator",
  );
  const query = await Deno.readTextFile("results/duckdb.sql");
  const directory = await Deno.makeTempDir({ prefix: "feedback-" });
  const databases: Database[] = [];
  async function database(name: string) {
    const result = await open(`${directory}/${name}.duckdb`);
    databases.push(result);
    return result;
  }
  const evidence: { name: string; rows: Row[] }[] = [];
  let stream = new Stream(await database("stream"), query);
  let boundary = new Boundary(await database("boundary"));
  const a: Key = ["ratings", "v1", "epoch1"];
  const b: Key = ["chances", "v1", "epoch1"];
  const otherProgram: Key = ["ratings", "v2", "epoch1"];
  const otherEpoch: Key = ["ratings", "v1", "epoch2"];
  const complete = {
    durable: true,
    complete: true,
    versionKind: "applied_snapshot",
  };
  async function check(name: string, expected: Row[]) {
    const actual = await stream.state();
    equal(actual, expected, name);
    evidence.push({ name, rows: actual });
  }
  async function event(index: number) {
    const events = await boundary.events();
    require(index < events.length, "event index");
    await stream.append(events[index]);
  }
  try {
    await stream.init();
    await boundary.init();
    await check("empty stream", []);
    await refuses(
      () => stream.apply(a, 0, complete),
      "positive applied snapshot",
    );
    for (
      const invalid of [
        { ...complete, durable: false },
        { ...complete, complete: false },
        { ...complete, versionKind: "raw_lsn" },
      ]
    ) {
      await refuses(
        () => stream.apply(a, 41, invalid),
        "durable complete applied snapshot",
      );
    }
    await stream.apply(a, 41, complete);
    await check("idle immediately eligible", [[...a, 41, 0, 0, 0, true, true]]);
    const stale = (await stream.state())[0];
    await refuses(
      () => boundary.claim(stale, "first", true),
      "injected admission failure",
    );
    equal(await boundary.counts(), [0, 0, 0, 0], "failed admission rolls back");
    await check("failed admission remains eligible without new event", [[
      ...a,
      41,
      0,
      0,
      0,
      true,
      true,
    ]]);
    const first = await boundary.claim(stale, "first");
    require(first, "first claim");
    equal(await boundary.claim(stale, "first"), first, "idempotent claim");
    equal(
      await boundary.claim(stale, "competitor"),
      null,
      "delayed claim feedback fenced",
    );
    equal(await boundary.counts(), [1, 1, 0, 1], "one execution");
    await event(0);
    await check("running claim", [[...a, 41, 0, 1, 1, true, false]]);
    const beforeBurst = await boundary.counts();
    for (let snapshot = 42; snapshot <= 90; snapshot++) {
      await stream.apply(a, snapshot, complete);
    }
    await stream.apply(a, 55, complete);
    equal(
      await boundary.counts(),
      beforeBurst,
      "burst does not write execution ledger",
    );
    await check("busy burst coalesced", [[...a, 90, 0, 1, 1, true, false]]);
    await refuses(
      () => boundary.publish(first, "ratings@41", true),
      "injected publication failure",
    );
    equal(
      await rows(boundary.database.c, "SELECT * FROM artifacts"),
      [],
      "atomic artifact rollback",
    );
    equal(await boundary.counts(), [1, 1, 0, 1], "atomic receipt rollback");
    await boundary.publish(first, "ratings@41");
    equal(
      await boundary.publish(first, "ratings@41"),
      [...a, 41, "ratings@41"],
      "lost ack publication retry",
    );
    equal(
      await boundary.counts(),
      [1, 1, 1, 2],
      "publication retry adds no rows",
    );
    await refuses(
      () => boundary.publish(first, "different bytes"),
      "publication token identity",
    );
    equal(
      (await boundary.claim(stale, "first"))?.outcome,
      "completed",
      "claim replay returns completed outcome",
    );
    await check("committed publication with delayed completion stays busy", [[
      ...a,
      90,
      0,
      1,
      1,
      true,
      false,
    ]]);
    await event(1);
    await event(0);
    await event(1);
    await check("snapshot41 does not cover42through90", [[
      ...a,
      90,
      41,
      2,
      0,
      true,
      true,
    ]]);
    equal(
      await boundary.claim(stale, "ancient"),
      null,
      "old eligibility rejected after completion",
    );
    const successor = await boundary.claim(
      (await stream.state())[0],
      "successor",
    );
    require(successor, "successor claim");
    equal(successor.target, 90, "single successor takes latest snapshot");
    equal(
      await boundary.claim((await stream.state())[0], "second-successor"),
      null,
      "one successor",
    );
    await event(2);
    await boundary.fail(successor);
    await event(3);
    await check("failure leaves coverage41 and retries90", [[
      ...a,
      90,
      41,
      4,
      0,
      true,
      true,
    ]]);
    await refuses(
      () => boundary.publish(successor, "late failed worker"),
      "stale publication fence",
    );
    const retry = await boundary.claim((await stream.state())[0], "retry");
    require(retry, "retry claim");
    await event(4);
    await boundary.publish(retry, "ratings@90");
    await event(1);
    await check("old completion cannot clear newer running claim", [[
      ...a,
      90,
      41,
      5,
      1,
      true,
      false,
    ]]);
    await event(5);
    await check("successful90 clean", [[...a, 90, 90, 6, 0, false, false]]);
    await stream.apply(b, 1, complete);
    await check("positive bootstrap snapshot requires first publication", [
      [...b, 1, 0, 0, 0, true, true],
      [...a, 90, 90, 6, 0, false, false],
    ]);
    await stream.apply(b, 7, complete);
    await stream.apply(otherProgram, 12, complete);
    await stream.apply(otherEpoch, 3, complete);
    await stream.apply(a, 91, complete);
    const isolated: Row[] = [
      [...b, 7, 0, 0, 0, true, true],
      [...a, 91, 90, 6, 0, true, true],
      [...otherEpoch, 3, 0, 0, 0, true, true],
      [...otherProgram, 12, 0, 0, 0, true, true],
    ];
    await check("computation program epoch isolated", isolated);
    await refuses(
      () =>
        stream.append({
          kind: "lifecycle",
          key: a,
          revision: 6,
          busy: 1,
          published: 90,
        }),
      "conflicting lifecycle revision",
    );
    const retained = await stream.count();
    stream.database.close();
    databases.splice(databases.indexOf(stream.database), 1);
    boundary.database.close();
    databases.splice(databases.indexOf(boundary.database), 1);
    stream = new Stream(await database("stream"), query);
    boundary = new Boundary(await database("boundary"));
    await check("derived state after database reopen", isolated);
    equal(
      await boundary.publish(retry, "ratings@90"),
      [...a, 90, "ratings@90"],
      "lost ack after reopen",
    );
    const replay = new Stream(await database("replay"), query);
    await replay.init();
    await stream.replayInto(replay);
    await stream.replayInto(replay);
    equal(
      await replay.state(),
      isolated,
      "reverse lifecycle replay with duplicates",
    );
    equal(
      await replay.count(),
      (retained as number) * 2,
      "retained log replay",
    );
    const counts = await boundary.counts();
    equal(
      counts,
      [1, 3, 2, 6],
      "bounded scheduling state and per-execution history",
    );
    const restarted = await boundary.claim(
      (await stream.state())[1],
      "restart-reconciliation",
    );
    require(
      restarted?.target === 91,
      "restart reconciles unchanged runnable relation",
    );
    equal(
      await boundary.counts(),
      [1, 4, 2, 7],
      "restart adds only one execution attempt",
    );
    await json("results/tests.json", {
      native_duckdb_version:
        (await rows(boundary.database.c, "SELECT version()"))[0][0],
      evidence,
      retained_stream_rows: retained,
      execution_rows: counts[0],
      execution_attempts: counts[1],
      publication_receipts: counts[2],
      lifecycle_outbox_rows: counts[3],
      checks: [
        "incomplete, nondurable and raw-LSN notifications refused",
        "zero snapshot refused; positive bootstrap snapshot requires first publication",
        "failed admission leaves unchanged runnable state available for reconciliation",
        "restart dispatches unchanged runnable relation without a new input event",
        "same token claim replay; competing stale eligibility refused",
        "completed claim replay reports completed outcome",
        "49 newer snapshots while busy cause zero execution-boundary writes",
        "publication rollback covers artifact, execution fence, receipt and outbox",
        "lost acknowledgement is idempotent before and after reopen",
        "conflicting token payload refused",
        "delayed, duplicated, out-of-order lifecycle with committed publication coverage",
        "failed stale worker cannot publish",
        "independent computation, program and source epoch identities",
        "reopened persistent databases and full duplicated retained-log replay",
      ],
      limits: [
        "local DuckDB harness, not Cortex or Airlock implementation",
        "queries recomputed over retained tables, no streaming IVM benchmark",
        "trusted adapter must emit only complete durable applied snapshots and authentic committed lifecycle outcomes",
        "snapshot supersession is cumulative within each identity; sparse versions are allowed",
        "no cross-computation prerequisite revision gating",
        "single-process transactions; no concurrent writer conflict recovery or distributed lease expiration",
        "retained events and execution history grow; one mutable scheduling row per executed identity",
      ],
    });
    console.log(
      `${evidence.length} native relation fixtures and durable execution feedback checks passed`,
    );
  } finally {
    for (const db of databases) db.close();
    await Deno.remove(directory, { recursive: true });
  }
}
const mode = Deno.args[0];
if (mode === "doctor") console.log(await doctor());
else if (mode === "build") await build();
else if (mode === "test") await test();
else throw new Error("Expected doctor, build, or test");
