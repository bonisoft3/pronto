import { DBOS } from "@dbos-inc/dbos-sdk";
import { NodePostgresDataSource } from "@dbos-inc/node-pg-datasource";
import pg from "pg";

const url = Deno.env.get("PG_URL");
if (!url) throw new Error("PG_URL is unset");
const db = new pg.Pool({ connectionString: url });
const [mode, id] = Deno.args;
const crash = Deno.env.get("CRASH") ?? "";
const q = (s: string, p: unknown[] = []) => db.query(s, p);

if (mode === "setup") {
  await q(`
    drop table if exists peer, attempt, charge cascade; drop function if exists charge_guard;
    create table peer (key text, at timestamptz default clock_timestamp());   -- the exterior world
    create table attempt (id text primary key, entered int not null default 0, outcome jsonb);
    create table charge (id text primary key, status text not null check (status in ('pending','charging','settled','failed','unknown')));
    create function charge_guard() returns trigger language plpgsql as $$ begin
      if not ((old.status='pending' and new.status='charging') or
              (old.status='charging' and new.status in ('settled','failed','unknown'))) then
        raise exception 'illegal % -> %', old.status, new.status; end if;
      if new.status='charging' then
        perform dbos.enqueue_workflow('charge','cortex', array[json_build_object('id',new.id)]::json[], workflow_id => 'charge:'||new.id);
      end if;
      return new; end $$;
    create trigger charge_guard before update on charge for each row when (old.status is distinct from new.status) execute function charge_guard();`);
  console.log("setup ok"); Deno.exit(0);
}
if (mode === "write") { // what a CRUD write does: one transaction, rolled back or committed
  const c = await db.connect();
  await c.query("insert into charge values ($1,'pending') on conflict do nothing", [id]);
  await c.query("begin"); await c.query("update charge set status='charging' where id=$1", [id]);
  await c.query(Deno.env.get("ROLLBACK") ? "rollback" : "commit"); c.release();
  const r = await q("select count(*) n from dbos.workflow_status where workflow_uuid=$1", [`charge:${id}`]);
  console.log("write", Deno.env.get("ROLLBACK") ? "rollback" : "commit", "enqueued:", r.rows[0].n); Deno.exit(0);
}

const ds = new NodePostgresDataSource("app", { connectionString: url });

// The gate's act: the entry counter commits BEFORE the call, so a re-entered step knows it may have called.
async function act(key: string, issue: () => Promise<void>, reconcile: () => Promise<boolean>) {
  return await DBOS.runStep(async () => {
    const { rows } = await q(`insert into attempt (id, entered) values ($1, 1)
      on conflict (id) do update set entered = attempt.entered + 1 returning entered`, [key]);
    if (rows[0].entered > 1 && await reconcile()) return { outcome: "settled", reconciled: true };
    await issue();
    if (crash === "step") { console.log("crash after exterior call, before checkpoint"); Deno.exit(1); }
    return { outcome: "settled", reconciled: false };
  }, { name: "act" });
}

DBOS.registerWorkflow(async (arg: { id: string }) => {
  const key = DBOS.workflowID!;
  const r = await act(key,
    async () => { await q("insert into peer (key) values ($1)", [key]); },
    async () => (await q("select 1 from peer where key=$1", [key])).rowCount! > 0);
  await ds.runTransaction(async () => {   // the outcome returns as a machine event, judged by the guard
    await ds.client.query("update attempt set outcome=$2 where id=$1", [key, r]);
    await ds.client.query("update charge set status=$2 where id=$1", [arg.id, r.outcome]);
  }, { name: "settle" });
  return r;
}, { name: "charge" });

DBOS.setConfig({ name: "impure-gate", systemDatabaseUrl: url });
await DBOS.launch();
await DBOS.registerQueue("cortex");
await new Promise((r) => setTimeout(r, 4000));
const s = await q(`select (select count(*) from peer where key=$2) calls, (select status from charge where id=$1) status,
  (select row_to_json(a) from attempt a where id=$2) attempt,
  (select status from dbos.workflow_status where workflow_uuid=$2) wf`, [id, `charge:${id}`]);
console.log(mode, crash || "-", JSON.stringify(s.rows[0]));
await DBOS.shutdown(); await db.end(); Deno.exit(0);
