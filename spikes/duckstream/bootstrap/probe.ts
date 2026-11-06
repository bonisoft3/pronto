const image =
  "postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3";
const project = `duckstream-bootstrap-${crypto.randomUUID()}`;
const composeArgs = ["compose", "-p", project, "-f", "compose.yaml"];
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, label: string) {
  require(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify({ actual, expected })}`,
  );
}
function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
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
    `expected ${message}, got ${failure}`,
  );
}
async function docker(args: string[], input?: string) {
  const child = new Deno.Command("docker", {
    args,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(encoder.encode(input));
    await writer.close();
  }
  const result = await child.output();
  require(
    result.success,
    `docker ${args.join(" ")}: ${decoder.decode(result.stderr)}`,
  );
  return decoder.decode(result.stdout).trim();
}
function psqlArgs(database: string, replication = false) {
  return [
    ...composeArgs,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    `user=postgres dbname=${database}${
      replication ? " replication=database" : ""
    }`,
  ];
}
function pg(sql: string, database = "source") {
  return docker(psqlArgs(database), sql);
}
async function rows(sql: string, database = "receiver") {
  return JSON.parse(
    await pg(`SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`, database),
  );
}
class Session {
  child: Deno.ChildProcess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  buffer = "";
  stderr: Promise<string>;
  output: Promise<void>;
  status: Promise<Deno.CommandStatus>;
  exited?: Deno.CommandStatus;
  closed = false;
  constructor(database: string, replication = false) {
    this.child = new Deno.Command("docker", {
      args: psqlArgs(database, replication),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.writer = this.child.stdin.getWriter();
    this.stderr = new Response(this.child.stderr).text();
    this.status = this.child.status.then((status) => {
      this.exited = status;
      return status;
    });
    const stdout = this.child.stdout;
    this.output = (async () => {
      for await (
        const text of stdout.pipeThrough(new TextDecoderStream())
      ) this.buffer += text;
    })();
  }
  async query(sql: string) {
    const marker = `done_${crypto.randomUUID()}`;
    await this.writer.write(encoder.encode(`${sql}\n\\echo ${marker}\n`));
    const deadline = Date.now() + 30000;
    while (!this.buffer.includes(marker)) {
      if (this.exited) {
        throw new Error(
          `psql exited before query completed: ${await this.stderr}`,
        );
      }
      require(Date.now() < deadline, `psql query timed out: ${sql}`);
      await sleep(10);
    }
    const [result, rest] = this.buffer.split(marker);
    this.buffer = rest.trimStart();
    return result.trim();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.exited) {
      await this.writer.write(encoder.encode("\\q\n"));
      await this.writer.close();
    }
    const [status, stderr] = await Promise.all([
      this.status,
      this.stderr,
      this.output,
    ]);
    require(status.success, `psql session failed: ${stderr}`);
  }
}
type RecordChange = { lsn: string; xid: string; data: string };
async function peek(): Promise<RecordChange[][]> {
  const records: RecordChange[] = await rows(
    "SELECT lsn::text,xid::text,data FROM pg_logical_slot_peek_changes('bootstrap',NULL,NULL)",
    "source",
  );
  const transactions: RecordChange[][] = [];
  let current: RecordChange[] | undefined;
  for (const record of records) {
    if (record.data.startsWith("BEGIN ")) {
      require(!current, "nested decoded transaction");
      current = [];
    }
    require(current, `record outside transaction: ${record.data}`);
    current.push(record);
    if (record.data.startsWith("COMMIT ")) {
      transactions.push(current);
      current = undefined;
    }
  }
  require(!current, "incomplete decoded transaction");
  return transactions.filter((tx) =>
    tx.some((r) => r.data.startsWith("table public."))
  );
}
async function apply(tx: RecordChange[]) {
  const first = tx[0], last = tx.at(-1)!;
  require(
    first.data === `BEGIN ${first.xid}` &&
      last.data === `COMMIT ${first.xid}` &&
      tx.every((r) => r.xid === first.xid),
    "complete source transaction required",
  );
  const payload = JSON.stringify(tx);
  const operations = tx.slice(1, -1).map((record) => {
    const m =
      /^table public\.(events|accounts): (INSERT|UPDATE|DELETE): id\[integer\]:(\d+)(?: value\[integer\]:(-?\d+))?$/
        .exec(record.data);
    require(m, `unsupported fixture record: ${record.data}`);
    require(m[2] === "DELETE" || m[4] !== undefined, "value required");
    return m[2] === "DELETE"
      ? `DELETE FROM state WHERE relation=${literal(m[1])} AND id=${m[3]};`
      : `INSERT INTO state VALUES(${literal(m[1])},${m[3]},${
        m[4]
      }) ON CONFLICT(relation,id) DO UPDATE SET value=excluded.value;`;
  });
  return await pg(
    `BEGIN;
    DO $apply$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM cuts WHERE complete) THEN RAISE EXCEPTION 'incomplete bootstrap'; END IF;
      IF EXISTS(SELECT 1 FROM receipts WHERE lsn=${
      literal(last.lsn)
    }::pg_lsn) THEN
        IF (SELECT payload FROM receipts WHERE lsn=${
      literal(last.lsn)
    }::pg_lsn) <> ${
      literal(payload)
    } THEN RAISE EXCEPTION 'conflicting capture identity'; END IF;
      ELSE
        ${operations.join("\n")}
        INSERT INTO receipts VALUES(${literal(last.lsn)}::pg_lsn,${
      literal(payload)
    });
        INSERT INTO effects VALUES(${literal(last.lsn)}::pg_lsn,${
      tx.length - 2
    });
      END IF;
    END $apply$; COMMIT;`,
    "receiver",
  );
}
async function receiver() {
  return await rows("SELECT relation,id,value FROM state ORDER BY relation,id");
}
async function doctor() {
  equal(Deno.version.deno, "2.8.2", "Deno version");
  return {
    deno: Deno.version.deno,
    docker: await docker(["version", "--format", "{{.Server.Version}}"]),
    image,
  };
}
async function test() {
  const tools = await doctor();
  const sessions: Session[] = [];
  const session = (database: string, replication = false) => {
    const s = new Session(database, replication);
    sessions.push(s);
    return s;
  };
  let evidence: unknown;
  const errors: unknown[] = [];
  try {
    await docker([...composeArgs, "up", "-d", "--wait"]);
    const postgres = await pg("SHOW server_version;");
    require(postgres.startsWith("17.6 "), `unexpected PostgreSQL ${postgres}`);
    await pg(
      `CREATE TABLE events(id integer PRIMARY KEY,value integer NOT NULL);
      CREATE TABLE accounts(id integer PRIMARY KEY,value integer NOT NULL);
      INSERT INTO events VALUES(1,10),(2,20);
      INSERT INTO accounts VALUES(1,100),(2,200);
      CREATE DATABASE receiver;`,
    );
    await pg(
      `CREATE TABLE state(relation text,id integer,value integer,PRIMARY KEY(relation,id));
      CREATE TABLE cuts(lsn pg_lsn PRIMARY KEY,snapshot text NOT NULL,complete boolean NOT NULL);
      CREATE TABLE receipts(lsn pg_lsn PRIMARY KEY,payload text NOT NULL);
      CREATE TABLE effects(lsn pg_lsn PRIMARY KEY,mutations integer NOT NULL);`,
      "receiver",
    );
    const early = session("source");
    await early.query("BEGIN;");
    const exportSession = session("source", true);
    const exported = (await exportSession.query(
      "CREATE_REPLICATION_SLOT bootstrap LOGICAL test_decoding EXPORT_SNAPSHOT;",
    )).split("|");
    equal(exported.length, 4, "slot creation fields");
    const [slot, consistentPoint, snapshot, plugin] = exported;
    equal(
      [slot, plugin],
      ["bootstrap", "test_decoding"],
      "native replication slot",
    );
    require(
      /^[0-9A-F]+\/[0-9A-F]+$/.test(consistentPoint) &&
        /^[0-9A-F-]+$/.test(snapshot),
      "valid exported identifiers",
    );
    const copy = session("source");
    await copy.query(
      `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT ${
        literal(snapshot)
      };`,
    );
    const eventCopy = await copy.query(
      "COPY (SELECT id,value FROM events ORDER BY id) TO STDOUT WITH (FORMAT csv);",
    );
    equal(eventCopy, "1,10\n2,20", "preexisting events copied");
    const incomplete = session("receiver");
    await incomplete.query(
      `BEGIN; COPY state(relation,id,value) FROM STDIN WITH (FORMAT csv);\nevents,1,10\nevents,2,20\n\\.\n`,
    );
    equal(await receiver(), [], "partial copy is invisible to another session");
    equal(
      await rows("SELECT * FROM cuts WHERE complete"),
      [],
      "partial copy cannot admit computation",
    );
    await incomplete.close();
    equal(await receiver(), [], "interrupted copy rolled back");
    const concurrentXid = await pg(`BEGIN; SELECT pg_current_xact_id()::text;
      UPDATE events SET value=11 WHERE id=1; DELETE FROM events WHERE id=2; INSERT INTO events VALUES(3,30);
      UPDATE accounts SET value=101 WHERE id=1; DELETE FROM accounts WHERE id=2; INSERT INTO accounts VALUES(3,300);
      COMMIT;`);
    const earlyXid = await early.query(`SELECT pg_current_xact_id()::text;
      INSERT INTO events VALUES(4,40); INSERT INTO accounts VALUES(4,400); COMMIT;`);
    const accountCopy = await copy.query(
      "COPY (SELECT id,value FROM accounts ORDER BY id) TO STDOUT WITH (FORMAT csv);",
    );
    equal(
      accountCopy,
      "1,100\n2,200",
      "second table shares original snapshot despite committed mutations",
    );
    await copy.query("COMMIT;");
    await copy.close();
    await exportSession.close();
    await refuses(
      () =>
        pg(
          `BEGIN ISOLATION LEVEL REPEATABLE READ; SET TRANSACTION SNAPSHOT ${
            literal(snapshot)
          };`,
        ),
      "does not exist",
    );
    const transactions = await peek();
    equal(
      transactions.length,
      2,
      "exactly two post-snapshot committed source transactions",
    );
    equal(
      transactions.map((tx) => tx[0].xid),
      [concurrentXid, earlyXid],
      "both concurrent commits captured in commit order",
    );
    await refuses(() => apply(transactions[0]), "incomplete bootstrap");
    const prefix = (table: string, csv: string) =>
      csv.split("\n").map((line) => `${table},${line}`).join("\n");
    await pg(
      `BEGIN;
      COPY state(relation,id,value) FROM STDIN WITH (FORMAT csv);\n${
        prefix("events", eventCopy)
      }\n${prefix("accounts", accountCopy)}\n\\.\n
      INSERT INTO cuts VALUES(${literal(consistentPoint)}::pg_lsn,${
        literal(snapshot)
      },true); COMMIT;`,
      "receiver",
    );
    const baseline = await receiver();
    equal(baseline, [
      { relation: "accounts", id: 1, value: 100 },
      { relation: "accounts", id: 2, value: 200 },
      { relation: "events", id: 1, value: 10 },
      { relation: "events", id: 2, value: 20 },
    ], "complete baseline atomically published");
    const beforeAck = await rows(
      "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name='bootstrap'",
      "source",
    );
    await apply(transactions[0]);
    const firstCut = await receiver();
    equal(firstCut, [
      { relation: "accounts", id: 1, value: 101 },
      { relation: "accounts", id: 3, value: 300 },
      { relation: "events", id: 1, value: 11 },
      { relation: "events", id: 3, value: 30 },
    ], "first complete WAL transaction updates both tables");
    const redelivered = await peek();
    equal(
      redelivered,
      transactions,
      "unacknowledged source WAL redelivered after receiver commit",
    );
    await apply(redelivered[0]);
    equal(
      await receiver(),
      firstCut,
      "lost-ack retry has no duplicate state effect",
    );
    equal(await rows("SELECT count(*)::integer AS receipts FROM receipts"), [{
      receipts: 1,
    }], "one durable capture receipt");
    equal(
      await rows(
        "SELECT count(*)::integer AS effects,sum(mutations)::integer AS mutations FROM effects",
      ),
      [{ effects: 1, mutations: 6 }],
      "one effect per captured transaction",
    );
    equal(
      await rows(
        "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name='bootstrap'",
        "source",
      ),
      beforeAck,
      "receiver commit and replay do not acknowledge source",
    );
    const conflicting = structuredClone(transactions[0]);
    conflicting[1].data = conflicting[1].data.replace(
      "value[integer]:11",
      "value[integer]:999",
    );
    await refuses(() => apply(conflicting), "conflicting capture identity");
    await apply(transactions[1]);
    const finalState = await receiver();
    equal(finalState, [
      { relation: "accounts", id: 1, value: 101 },
      { relation: "accounts", id: 3, value: 300 },
      { relation: "accounts", id: 4, value: 400 },
      { relation: "events", id: 1, value: 11 },
      { relation: "events", id: 3, value: 30 },
      { relation: "events", id: 4, value: 40 },
    ], "snapshot plus WAL expected final state has no gap");
    const sourceState = await rows(
      "SELECT 'accounts' AS relation,id,value FROM accounts UNION ALL SELECT 'events',id,value FROM events ORDER BY relation,id",
      "source",
    );
    equal(finalState, sourceState, "receiver equals independent source state");
    const lastLsn = transactions.at(-1)!.at(-1)!.lsn;
    await pg(
      `SELECT count(*) FROM pg_logical_slot_get_changes('bootstrap',${
        literal(lastLsn)
      }::pg_lsn,NULL);`,
    );
    equal(await peek(), [], "acknowledged WAL not delivered again");
    equal(
      await rows(
        "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name='bootstrap'",
        "source",
      ),
      [{ confirmed_flush_lsn: lastLsn }],
      "source acknowledges only the durably applied commit frontier",
    );
    await pg("BEGIN; INSERT INTO events VALUES(9,90); ROLLBACK;");
    equal(await peek(), [], "rolled-back source transaction absent");
    evidence = {
      status: "passed",
      executed_at: new Date().toISOString(),
      tools,
      postgres,
      bootstrap: {
        slot,
        consistent_point: consistentPoint,
        snapshot,
        plugin,
        baseline,
        early_transaction:
          "BEGIN before slot creation, XID assigned and writes committed after snapshot export",
        aborted_partial_copy_visible_rows: 0,
      },
      capture: {
        transactions,
        first_cut: firstCut,
        final_state: finalState,
        source_state: sourceState,
        receipts: await rows("SELECT lsn::text FROM receipts ORDER BY lsn"),
        effects: await rows(
          "SELECT lsn::text,mutations FROM effects ORDER BY lsn",
        ),
        before_ack: beforeAck,
        after_ack: await rows(
          "SELECT confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name='bootstrap'",
          "source",
        ),
      },
      assertions: {
        preexisting_rows: true,
        same_snapshot_across_two_tables: true,
        concurrent_insert_update_delete: true,
        preopened_transaction_commits_after_snapshot: true,
        partial_copy_not_eligible: true,
        partial_copy_rollback: true,
        expired_export_cannot_be_reimported: true,
        snapshot_plus_wal_no_gap: true,
        complete_transaction_atomic_apply: true,
        commit_before_ack_replay_deduplicated: true,
        conflicting_receipt_refused: true,
        source_rollback_absent: true,
      },
      limitations: [
        "Fixed integer tables and test_decoding fixture parser; not production pgoutput CDC",
        "Receiver is separate PostgreSQL database, not a DuckLake adapter",
        "Receiver connection closes after each committed apply; no OS kill or source failover",
        "Preopened transaction has no XID until after snapshot export; existing writers can delay slot initialization",
        "No DDL, broad data types, key mutation, slot loss, retention exhaustion, source epochs, multiwriter or sustained throughput",
      ],
    };
  } catch (error) {
    errors.push(error);
  } finally {
    const closed = await Promise.allSettled(sessions.map((s) => s.close()));
    const removed = await Promise.allSettled([
      docker([...composeArgs, "down", "-v", "--remove-orphans"]),
    ]);
    for (const result of [...closed, ...removed]) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  if (errors.length) throw new AggregateError(errors, "bootstrap probe failed");
  await Deno.writeTextFile(
    "results.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
}
switch (Deno.args[0]) {
  case "doctor":
    console.log(JSON.stringify(await doctor()));
    break;
  case "test":
    await test();
    break;
  default:
    throw new Error("expected doctor or test");
}
