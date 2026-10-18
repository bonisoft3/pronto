// The transaction markers a CDC feed carries (mecha's rls.sql, emit.cue
// #txnMarker), against the emitted schema in a real Postgres. test_decoding
// reads the same WAL pgoutput does, in the same order, without a publication.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { cue } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const RLS = new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url);

// Auth on, so app_user writes under the floor; a schedule, so the feed runs.
const program = `
package test

import (
  "list"
  "bonisoft.org/plugins/pronto"
)

_owned: [
  {name: "id", type: "uuid", pk: true},
  {name: "player_id", type: "uuid"},
  {name: "body", type: "string"},
]
app: pronto.#App & {
  meta: {name: "trace", description: "test", ir: sha256: "", targets: [], clocks: [], decisions: {}, tests: {}}
  state: {
    entities: {
      Note: {table: "note", durability: "server", access: {scope: "private", owner: "player_id"}, fields: _owned}
      Card: {table: "card", durability: "server", access: {scope: "private", owner: "player_id"}, fields: _owned}
      Tick: {table: "tick", durability: "server", fields: list.Concat([pronto.#tickFields, [{name: "status", type: "text"}]])}
    }
    schedules: nightly: {cron: "0 3 * * *", emits: {entity: "Tick", values: status: "requested"}}
  }
  capabilities: {hatches: {}, vendored: {}, auth: {required: false, service: "/auth"}}
  surface: {
    screens: board: {
      title: "Board"
      route: "/"
      markup: "<main></main>"
      reads: [{table: "note", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
      forms: []
      states: []
    }
    handlers: {}
    design: {}
    flows: {}
  }
}

_terminal: (pronto.#DefaultTerminal & {code: app}).out
_cluster: (pronto.#DefaultCluster & {code: app, statics: []}).out
_loop: (pronto.#DefaultLoop & {code: app, terminal: _terminal, cluster: _cluster}).out
out: (pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
}).files
`;

const TRACE = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const OTHER = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const PLAYER = "00000000-0000-0000-0000-00000000000a";

async function run(cmd: string, args: string[], stdin?: string) {
  const child = new Deno.Command(cmd, { args, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const result = await child.output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr) };
}

// What PostgREST does for a request: the role, the claims and headers as
// transaction-local settings, then the pre-request hook.
const request = (headers: Record<string, string>, body: string) => `
  BEGIN;
  SET LOCAL ROLE app_user;
  SELECT set_config('request.jwt.claims', '{"sub":"${PLAYER}","role":"app_user"}', true);
  SELECT set_config('request.headers', '${JSON.stringify(headers)}', true);
  SELECT app_pre_request();
  ${body}
  COMMIT;`;

Deno.test({ name: "every writing transaction is marked ahead of its rows", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const exported = await cue(["export", "-", "-e", '{for k, v in out if k =~ "^services/database/migrations/0" if v.text != _|_ {(k): v.text}}', "--out", "json"], program);
  if (!exported.success) throw new Error(exported.stderr);
  const steps: Record<string, string> = { ...JSON.parse(exported.stdout), "003_rls.sql": await Deno.readTextFile(RLS) };
  const ordered = Object.keys(steps).sort((a, b) => a.split("/").pop()!.localeCompare(b.split("/").pop()!));
  const container = `pronto-trace-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", POSTGRES, "-c", "wal_level=logical"]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const sql = async (query: string) => {
    const r = await psql(query);
    if (!r.ok) throw new Error(r.err);
    return r.out;
  };
  // The changes since the last call, as `<table>:<action>` per change.
  const changes = async () =>
    (await sql(`SELECT data FROM pg_logical_slot_get_changes('trace', NULL, NULL, 'skip-empty-xacts', '1');`))
      .split("\n").filter((l) => l.startsWith("table ")).map((l) => l.replace(/^table ([^:]+): (\w+):.*$/, "$1:$2"));
  const marker = (where: string) => sql(`SELECT traceparent FROM mecha.txn_trace WHERE ${where};`);
  try {
    for (let i = 0; !(await run("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const step of ordered) await sql(steps[step]);
    await sql(`SELECT pg_create_logical_replication_slot('trace', 'test_decoding');`);

    await t.step("a request writing two tables is one marker carrying its trace, first", async () => {
      await sql(request({ traceparent: TRACE }, `
        INSERT INTO note (id, player_id, body) VALUES (gen_random_uuid(), '${PLAYER}', 'a');
        INSERT INTO card (id, player_id, body) VALUES (gen_random_uuid(), '${PLAYER}', 'b');
        INSERT INTO card (id, player_id, body) VALUES (gen_random_uuid(), '${PLAYER}', 'c');`));
      assertEquals(await changes(), ["mecha.txn_trace:INSERT", "public.note:INSERT", "public.card:INSERT", "public.card:INSERT"]);
      assertEquals(await marker(`txid = (SELECT txid FROM note)`), TRACE);
    });

    await t.step("a transaction outside a request is marked with no trace", async () => {
      await sql(`INSERT INTO tick (id, schedule, tick_at, late, status) VALUES (gen_random_uuid(), 'nightly', now(), false, 'requested');`);
      assertEquals(await changes(), ["mecha.txn_trace:INSERT", "public.tick:INSERT"]);
      assertEquals(await marker(`txid = (SELECT txid FROM tick)`), "");
    });

    // The airlock and the ticker's writers state their trace themselves.
    await t.step("a writer's own setting answers ahead of the request's header", async () => {
      await sql(request({ traceparent: TRACE }, `
        SET LOCAL mecha.traceparent = '${OTHER}';
        UPDATE note SET body = 'd';`));
      assertEquals(await changes(), ["mecha.txn_trace:INSERT", "public.note:UPDATE"]);
      assertEquals(await marker(`txid = (SELECT txid FROM note)`), OTHER);
    });

    // A row's delete carries the deleted row, whose txid is its last writer's;
    // only the marker names the transaction that deleted it.
    await t.step("a delete is marked by the deleting transaction", async () => {
      await sql(request({ traceparent: OTHER.replace("-01", "-00") }, `DELETE FROM card;`));
      assertEquals(await changes(), ["mecha.txn_trace:INSERT", "public.card:DELETE", "public.card:DELETE"]);
      assertEquals(await marker(`txid = (SELECT max(txid) FROM mecha.txn_trace)`), OTHER.replace("-01", "-00"));
    });

    await t.step("a header that is not a traceparent is no trace", async () => {
      await sql(request({ traceparent: "00-xyz" }, `UPDATE note SET body = 'e';`));
      assertEquals(await changes(), ["mecha.txn_trace:INSERT", "public.note:UPDATE"]);
      assertEquals(await marker(`txid = (SELECT txid FROM note)`), "");
    });

    await t.step("no app role reaches the markers but through the trigger", async () => {
      const read = await psql(`SET ROLE app_user; SELECT count(*) FROM mecha.txn_trace;`);
      assertEquals(read.ok, false);
      const write = await psql(`SET ROLE service; INSERT INTO mecha.txn_trace VALUES (1, '');`);
      assertEquals(write.ok, false);
      assertEquals(await sql(`SELECT count(*) FROM mecha.rls_unprotected WHERE table_name = 'mecha.txn_trace';`), "0");
    });

    // Electric syncs the publication it reads; a marker there is a row for no one.
    await t.step("the markers join the feed's publication and not Electric's", async () => {
      assertEquals(await sql(`SELECT string_agg(pubname, ',' ORDER BY pubname) FROM pg_publication_tables WHERE schemaname = 'mecha';`), "trace_cdc");
    });
  } finally {
    await run("docker", ["rm", "-f", container]);
  }
} });
