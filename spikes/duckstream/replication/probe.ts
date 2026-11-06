const IMAGE =
  "pgducklake/pgduckpipe@sha256:091236d2acecfec1216817aff6e43dc4c036159cebe44a19c73c95c1fe9be348";
const SOURCE = "86d5c248d80370fb2e10ddc1abd780fd94c3a52b";
const decoder = new TextDecoder();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, label: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify({ actual, expected })}`,
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
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await child.output();
  assert(
    result.success,
    `docker ${args.join(" ")} failed: ${decoder.decode(result.stderr)}\n${
      decoder.decode(result.stdout)
    }`,
  );
  return decoder.decode(result.stdout).trim();
}
async function doctor() {
  assert(
    Deno.version.deno === "2.8.2",
    `Expected Deno 2.8.2; got ${Deno.version.deno}`,
  );
  console.log(await docker(["version", "--format", "{{.Server.Version}}"]));
}
async function setup() {
  await doctor();
  await docker(["pull", IMAGE]);
  const provenance = JSON.parse(
    await docker([
      "buildx",
      "imagetools",
      "inspect",
      IMAGE,
      "--format",
      "{{json .Provenance}}",
    ]),
  );
  const identities = Object.fromEntries(
    Object.entries(provenance).map(([platform, entry]) => {
      const definition = (entry as {
        SLSA: {
          buildDefinition: {
            externalParameters: {
              request: {
                root: { request: { args: Record<string, string> } };
              };
            };
          };
        };
      }).SLSA.buildDefinition;
      const args = definition.externalParameters.request.root.request.args;
      assert(
        args["vcs:revision"] === SOURCE,
        `Unexpected source revision for ${platform}`,
      );
      return [platform, {
        revision: args["vcs:revision"],
        repository: args["vcs:source"],
        pg_ducklake: args["build-arg:PGDUCKLAKE_COMMIT"],
      }];
    }),
  );
  assert(Object.keys(identities).length > 0, "Image has no build provenance");
  await Deno.mkdir(".cache", { recursive: true });
  await Deno.writeTextFile(
    ".cache/identity.json",
    JSON.stringify({ image: IMAGE, source: SOURCE, identities }, null, 2) +
      "\n",
  );
  console.log(JSON.stringify(identities));
}
class Service {
  name = `duckstream-replication-${crypto.randomUUID()}`;
  async sql(query: string) {
    return await docker([
      "exec",
      "-i",
      this.name,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-F",
      "\t",
    ], query);
  }
  async rows(query: string) {
    const output = await this.sql(query);
    return output ? output.split("\n").map((line) => line.split("\t")) : [];
  }
  async atSnapshot(table: string, snapshot: number) {
    // pg_ducklake must initialize its time-travel rewrite in each psql session.
    return (await this.rows(
      `SELECT 1 FROM ${table}_ducklake LIMIT 0;
       SELECT * FROM ducklake.time_travel('${table}_ducklake'::regclass,${snapshot})`,
    )).map((row) => row.slice(0, 2)).sort((a, b) =>
      Number(a[0]) - Number(b[0])
    );
  }
  async ready() {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await new Deno.Command("docker", {
        args: [
          "exec",
          this.name,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ],
        stdout: "null",
        stderr: "null",
      }).output();
      if (result.success) return;
      await wait(250);
    }
    throw new Error(
      `PostgreSQL did not start: ${await docker(["logs", this.name])}`,
    );
  }
  async until(query: string, expected: string, label: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const errors = await this.sql(
        "SELECT coalesce(string_agg(error_message,'; '),'') FROM duckpipe.table_mappings WHERE state='ERRORED'",
      );
      assert(!errors, errors);
      if (await this.sql(query) === expected) return;
      await wait(250);
    }
    throw new Error(
      `${label} timed out; status ${await this.sql(
        "SELECT json_agg(s) FROM duckpipe.status() s",
      )}; logs ${await docker(["logs", "--tail", "80", this.name])}`,
    );
  }
  async metadata() {
    return JSON.parse(
      await this.sql(`SELECT json_build_object(
      'tables',(SELECT json_agg(s ORDER BY s.source_table) FROM duckpipe.status() s),
      'group',(SELECT row_to_json(g) FROM duckpipe.sync_groups g WHERE name='default'),
      'slot',(SELECT row_to_json(s) FROM (SELECT slot_name,confirmed_flush_lsn,restart_lsn FROM pg_replication_slots WHERE slot_name='duckpipe_slot_postgres') s))`),
    );
  }
}
async function test() {
  await doctor();
  const identity = JSON.parse(await Deno.readTextFile(".cache/identity.json"));
  assert(
    identity.image === IMAGE && identity.source === SOURCE,
    "Run setup for the pinned image",
  );
  const service = new Service();
  await docker([
    "run",
    "-d",
    "--name",
    service.name,
    "-e",
    "POSTGRES_PASSWORD=spike",
    IMAGE,
  ]);
  let result: Record<string, unknown>;
  try {
    await service.ready();
    const versions = await service.rows(
      "SELECT extname,extversion FROM pg_extension ORDER BY extname",
    );
    const postgres = await service.sql("SHOW server_version");
    await service.sql(`
      CREATE TABLE events(id INTEGER PRIMARY KEY, amount INTEGER);
      CREATE TABLE accounts(id INTEGER PRIMARY KEY, label TEXT);
      CREATE TABLE occurrences(id INTEGER PRIMARY KEY, amount INTEGER);
      ALTER TABLE occurrences REPLICA IDENTITY FULL;
      INSERT INTO events VALUES(1,10),(2,20);
      INSERT INTO accounts VALUES(1,'initial');
      INSERT INTO occurrences VALUES(1,10);
      SELECT duckpipe.set_config('flush_interval_ms','200');
      SELECT duckpipe.add_table('public.events');
      SELECT duckpipe.add_table('public.accounts');
      SELECT duckpipe.add_table('public.occurrences',sync_mode=>'append');
    `);
    await service.until(
      "SELECT count(*) FROM events_ducklake",
      "2",
      "events populated bootstrap",
    );
    await service.until(
      "SELECT count(*) FROM accounts_ducklake",
      "1",
      "accounts populated bootstrap",
    );
    await service.until(
      "SELECT count(*) FROM occurrences_ducklake",
      "1",
      "append populated bootstrap",
    );
    equal(
      await service.rows("SELECT id,amount FROM events_ducklake ORDER BY id"),
      [["1", "10"], ["2", "20"]],
      "bootstrap mirror",
    );
    equal(
      await service.rows("SELECT id,label FROM accounts_ducklake ORDER BY id"),
      [["1", "initial"]],
      "bootstrap accounts mirror",
    );
    equal(
      await service.rows(
        "SELECT id,amount,_duckpipe_op,_duckpipe_lsn FROM occurrences_ducklake",
      ),
      [["1", "10", "I", "0"]],
      "bootstrap append baseline",
    );
    const initialSnapshot = Number(
      await service.sql(
        "SELECT max(snapshot_id) FROM ducklake.ducklake_snapshot",
      ),
    );
    const before = await service.metadata();
    const xid = await service.sql(`BEGIN;
      SELECT txid_current();
      UPDATE events SET amount=15 WHERE id=1;
      DELETE FROM events WHERE id=2;
      UPDATE accounts SET label='second' WHERE id=1;
      UPDATE occurrences SET amount=15 WHERE id=1;
      INSERT INTO occurrences VALUES(99,99);
      DELETE FROM occurrences WHERE id=99;
      COMMIT;`);
    await service.until(
      "SELECT count(*) FROM events_ducklake WHERE id=1 AND amount=15",
      "1",
      "update",
    );
    await service.until(
      "SELECT count(*) FROM accounts_ducklake WHERE label='second'",
      "1",
      "second table",
    );
    await service.until(
      "SELECT count(*) FROM occurrences_ducklake",
      "4",
      "transient occurrences",
    );
    equal(
      await service.rows("SELECT id,amount FROM events_ducklake ORDER BY id"),
      [["1", "15"]],
      "update/delete mirror",
    );
    equal(
      await service.rows("SELECT id,label FROM accounts_ducklake ORDER BY id"),
      [["1", "second"]],
      "updated accounts mirror",
    );
    const history = await service.rows(
      "SELECT id,amount,_duckpipe_op,_duckpipe_lsn FROM occurrences_ducklake ORDER BY _duckpipe_lsn,id",
    );
    equal(
      history.map((row) => row.slice(0, 3)),
      [
        ["1", "10", "I"],
        ["1", "15", "U"],
        ["99", "99", "I"],
        ["99", "", "D"],
      ],
      "append retains operation but drops non-key delete values even with FULL identity",
    );
    assert(
      new Set(history.map((row) => row[3])).size === 4,
      "fixture WAL positions must distinguish these changes",
    );
    const snapshots = (await service.rows(
      `SELECT snapshot_id FROM ducklake.ducklake_snapshot WHERE snapshot_id>=${initialSnapshot} ORDER BY snapshot_id`,
    )).map((row) => Number(row[0]));
    const cuts = [];
    for (const snapshot of snapshots) {
      const events = await service.atSnapshot("events", snapshot);
      const accounts = await service.atSnapshot("accounts", snapshot);
      const eventChanged = events[0][1] === "15";
      const accountChanged = accounts[0][1] === "second";
      cuts.push({
        snapshot,
        events,
        accounts,
        torn: eventChanged !== accountChanged,
      });
    }
    assert(
      cuts.some((cut) => cut.torn),
      "Expected separate table commits to expose a torn source transaction; re-audit changed engine behavior",
    );
    equal(cuts.at(-1)?.events, [["1", "15"]], "converged retained events cut");
    equal(
      cuts.at(-1)?.accounts,
      [["1", "second"]],
      "converged retained accounts cut",
    );
    const retainedBeforeRestart = await service.atSnapshot(
      "events",
      initialSnapshot,
    );
    equal(
      retainedBeforeRestart,
      [["1", "10"], ["2", "20"]],
      "retained baseline",
    );
    await service.until(
      "SELECT (s.confirmed_flush_lsn=min(m.applied_lsn) AND count(m.applied_lsn)=3)::text FROM pg_replication_slots s CROSS JOIN duckpipe.table_mappings m WHERE s.slot_name='duckpipe_slot_postgres' GROUP BY s.confirmed_flush_lsn",
      "true",
      "replication acknowledgment",
    );
    const acknowledged = await service.metadata();
    await service.sql("SELECT duckpipe.stop_worker()");
    await service.sql(`BEGIN;
      UPDATE events SET amount=17 WHERE id=1;
      UPDATE accounts SET label='recovered' WHERE id=1;
      INSERT INTO occurrences VALUES(3,30);
      COMMIT;`);
    equal(await service.rows("SELECT id,amount FROM events_ducklake"), [[
      "1",
      "15",
    ]], "worker stopped before backlog");
    await docker(["kill", "--signal=KILL", service.name]);
    await docker(["start", service.name]);
    await service.ready();
    await service.sql("SELECT duckpipe.start_worker()");
    await service.until(
      "SELECT count(*) FROM events_ducklake WHERE amount=17",
      "1",
      "crash restart backlog",
    );
    await service.until(
      "SELECT count(*) FROM accounts_ducklake WHERE label='recovered'",
      "1",
      "restart second table",
    );
    await service.until(
      "SELECT count(*) FROM occurrences_ducklake",
      "5",
      "restart append count",
    );
    equal(
      await service.rows("SELECT id,amount FROM events_ducklake ORDER BY id"),
      [["1", "17"]],
      "recovered events mirror",
    );
    equal(
      await service.rows("SELECT id,label FROM accounts_ducklake ORDER BY id"),
      [["1", "recovered"]],
      "recovered accounts mirror",
    );
    const recoveredHistory = await service.rows(
      "SELECT id,amount,_duckpipe_op,_duckpipe_lsn FROM occurrences_ducklake ORDER BY _duckpipe_lsn,id",
    );
    equal(
      recoveredHistory.slice(0, 4),
      history,
      "restart retains history without duplicates",
    );
    equal(
      recoveredHistory[4].slice(0, 3),
      ["3", "30", "I"],
      "backlog delivered",
    );
    equal(
      await service.atSnapshot("events", initialSnapshot),
      retainedBeforeRestart,
      "snapshot survives process restart",
    );
    await service.until(
      `SELECT (s.confirmed_flush_lsn=min(m.applied_lsn) AND s.confirmed_flush_lsn>'${acknowledged.slot.confirmed_flush_lsn}'::pg_lsn)::text FROM pg_replication_slots s CROSS JOIN duckpipe.table_mappings m WHERE s.slot_name='duckpipe_slot_postgres' GROUP BY s.confirmed_flush_lsn`,
      "true",
      "acknowledgment advances to the recovered minimum table frontier",
    );
    const recovered = await service.metadata();
    const frontier = await service.rows(
      "SELECT source_table,applied_lsn::text FROM duckpipe.table_mappings ORDER BY source_table",
    );
    result = {
      status: "passed",
      verdict: "useful_mirror_and_append_transport_not_transaction_cut_adapter",
      executed_at: new Date().toISOString(),
      deno: Deno.version.deno,
      identity,
      image_architecture: await docker([
        "image",
        "inspect",
        IMAGE,
        "--format",
        "{{.Architecture}}",
      ]),
      postgres,
      versions,
      bootstrap: {
        populated: true,
        append_baseline_lsn: "0",
        pre_bootstrap_occurrences: "not available",
      },
      source_transaction_xid: xid,
      initial_snapshot: initialSnapshot,
      retained_cuts: cuts,
      append_history: history,
      append_history_after_restart: recoveredHistory,
      metadata: { before, acknowledged, recovered },
      per_table_frontier: frontier,
      assertions: {
        populated_bootstrap: true,
        update_delete_current_mirror: true,
        append_transient_insert_delete: true,
        delete_payload_omits_non_key_even_with_full_identity: true,
        torn_cross_table_snapshot_observed: true,
        retained_snapshot_after_restart: true,
        crash_restart_backlog_delivered: true,
        restart_no_duplicate_observed_occurrences: true,
        source_ack_equals_minimum_applied_lsn: true,
        source_ack_advances_after_restart: true,
      },
      unproved: [
        "concurrent bootstrap global cut",
        "commit-to-ack exact crash window and WAL redelivery",
        "source failover epochs",
        "production load",
        "multiwriter publication",
      ],
      source_audit: {
        revision: SOURCE,
        append_metadata:
          "row WAL position and operation; no xid, commit LSN, transaction ordinal or boundary",
        checkpoint:
          "minimum per-table applied LSN after per-table DuckLake commit; metadata update is a separate PostgreSQL transaction",
        bootstrap:
          "per-table REPEATABLE READ COPY; baseline append rows use LSN zero",
      },
    };
  } finally {
    await docker(["rm", "-f", "-v", service.name]);
  }
  await Deno.writeTextFile(
    "results.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: result.status,
      verdict: result.verdict,
      assertions: result.assertions,
    }),
  );
}
const action = Deno.args[0];
if (action === "doctor") await doctor();
else if (action === "setup") await setup();
else if (action === "test") await test();
else throw new Error("Usage: probe.ts doctor|setup|test");
