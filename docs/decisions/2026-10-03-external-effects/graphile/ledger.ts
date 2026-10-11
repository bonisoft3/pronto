// The executor of ../../2026-10-03-external-effects.md in miniature: a guard
// trigger that claims the ledger and enqueues in the transition's commit, and a
// Graphile task that claims before it calls and returns the outcome through the
// guard. `peer` stands for the external sink: rows in it are calls that happened.
import { makeWorkerUtils, runMigrations, runOnce } from "graphile-worker";
import { EventEmitter } from "node:events";
import pg from "pg";

const connectionString = Deno.env.get("PG_URL");
if (!connectionString) throw new Error("PG_URL is unset");
const db = new pg.Pool({ connectionString });
const [mode, id] = Deno.args;
const crash = Deno.env.get("CRASH") ?? "";
const replica = "cortex-0";
const report = async (label: string, key: string) => {
  const r = await db.query(`select (select count(*) from peer where key = $1) calls,
    (select status from charge where id = $2) status,
    (select json_build_object('entered', entered, 'outcome', outcome) from external_effect_ledger where key = $1) ledger,
    (select count(*) from graphile_worker.jobs where key = $1) jobs`, [key, id]);
  console.log(label, JSON.stringify(r.rows[0]));
};

if (mode === "setup") {
  await runMigrations({ connectionString });
  await db.query(`
    create table peer (key text);
    create table cortex_replica (name text primary key, pool text not null);
    create table external_effect_ledger (key text primary key, entered int not null default 0, outcome jsonb);
    create table charge (id text primary key, status text not null);
    create function charge_guard() returns trigger language plpgsql as $$ begin
      if old.status = 'pending' and new.status = 'charging' then
        insert into external_effect_ledger (key) values ('charge:' || new.id) on conflict (key) do nothing;
        if found then
          perform graphile_worker.add_job('external_effect', json_build_object('key', 'charge:' || new.id, 'id', new.id), job_key => 'charge:' || new.id);
        end if;
      elsif old.status = 'charging' then
        -- Only the recorded outcome leaves the invoking state.
        if not exists (select 1 from external_effect_ledger where key = 'charge:' || old.id and outcome->>'target' = new.status) then
          raise exception 'charging is left only by the outcome of charge:%', old.id;
        end if;
      else
        raise exception 'illegal % -> %', old.status, new.status;
      end if;
      return new; end $$;
    create trigger charge_guard before update on charge for each row when (old.status is distinct from new.status) execute function charge_guard();`);
  console.log("setup ok");
  Deno.exit(0);
}

if (mode === "write") {
  await db.query("insert into charge values ($1, 'pending') on conflict do nothing", [id]);
  const c = await db.connect();
  await c.query("begin");
  await c.query("update charge set status = 'charging' where id = $1", [id]);
  await c.query(Deno.env.get("ROLLBACK") ? "rollback" : "commit");
  c.release();
  await report(`write ${Deno.env.get("ROLLBACK") ? "rollback" : "commit"}`, `charge:${id}`);
  Deno.exit(0);
}

if (mode === "forge") {
  const r = await db.query("update charge set status = 'settled' where id = $1", [id]).catch((e) => e);
  console.log("forge", r instanceof Error ? `refused: ${r.message}` : "ACCEPTED");
  Deno.exit(0);
}

if (mode === "jobkey") { // Graphile alone: a job_key deduplicates only while its job exists.
  for (let i = 0; i < 2; i++) {
    await db.query("select graphile_worker.add_job('bare', json_build_object('key', $1::text), job_key => $1)", [`bare:${id}`]);
    await runOnce({ connectionString, noHandleSignals: true, taskList: { bare: async (p: any) => { await db.query("insert into peer values ($1)", [p.key]); } } });
  }
  await report("jobkey enqueued twice, each run to completion:", `bare:${id}`);
  Deno.exit(0);
}

if (mode === "requeue") { // the same job again after completion, as a lost-ack redelivery would
  await db.query("select graphile_worker.add_job('external_effect', json_build_object('key', $1::text, 'id', $2::text), job_key => $1)", [`charge:${id}`, id]);
}

// A replica starting means its previous pool is gone: release what that pool held.
const prev = await db.query("select pool from cortex_replica where name = $1", [replica]);
if (prev.rowCount) {
  const utils = await makeWorkerUtils({ connectionString });
  await utils.forceUnlockWorkers([prev.rows[0].pool]);
  await utils.release();
}
const events = new EventEmitter();
let recorded: Promise<unknown> = Promise.resolve();
events.on("pool:create", ({ workerPool }) => {
  recorded = db.query("insert into cortex_replica values ($1, $2) on conflict (name) do update set pool = excluded.pool", [replica, workerPool.id]);
});

await runOnce({ connectionString, events, noHandleSignals: true, taskList: {
  external_effect: async (p: any) => {
    await recorded;
    const { rows: [l] } = await db.query("select outcome from external_effect_ledger where key = $1", [p.key]);
    let outcome = l.outcome;
    if (!outcome) {
      // The claim commits before the call: a re-entered task knows it may have called.
      const { rows: [c] } = await db.query("update external_effect_ledger set entered = entered + 1 where key = $1 returning entered", [p.key]);
      const called = c.entered > 1 && (await db.query("select 1 from peer where key = $1", [p.key])).rowCount! > 0;
      if (!called) {
        await db.query("insert into peer values ($1)", [p.key]);
        if (crash) { console.log("crash after the external call"); Deno.exit(1); }
      }
      outcome = { target: "settled", kind: "done", reconciled: called };
    }
    // Recording the outcome and delivering it as the machine's event are one commit.
    const c = await db.connect();
    await c.query("begin");
    await c.query("update external_effect_ledger set outcome = $2 where key = $1 and outcome is null", [p.key, outcome]);
    await c.query("update charge set status = $2 where id = $1 and status = 'charging'", [p.id, outcome.target]);
    await c.query("commit");
    c.release();
  },
} });
await report(`${mode}${crash ? " (crash)" : ""}`, `charge:${id}`);
await db.end();
Deno.exit(0);
