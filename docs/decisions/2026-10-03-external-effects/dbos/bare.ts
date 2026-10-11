import { DBOS } from "@dbos-inc/dbos-sdk";
import { NodePostgresDataSource } from "@dbos-inc/node-pg-datasource";
import pg from "pg";

const url = Deno.env.get("PG_URL");
if (!url) throw new Error("PG_URL is unset");
const exterior = new pg.Pool({ connectionString: url });
const [mode, id] = Deno.args;
const crash = Deno.env.get("CRASH") ?? "";

if (mode === "setup") {
  await exterior.query(`
    drop table if exists peer_calls, ledger, charge cascade;
    create table peer_calls (key text, at timestamptz default clock_timestamp());
    create table ledger (charge_id text, at timestamptz default clock_timestamp());
    create table charge (id text primary key, status text not null);`);
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString: url });
  console.log("setup ok"); Deno.exit(0);
}

const ds = new NodePostgresDataSource("app", { connectionString: url });

const act = DBOS.registerWorkflow(async (chargeId: string) => {
  await DBOS.runStep(async () => {
    await exterior.query("insert into peer_calls (key) values ($1)", [`${DBOS.workflowID}:call`]);
    if (crash === "step") { console.log("crash inside step after exterior call"); Deno.exit(1); }
    return "ok";
  }, { name: "call_peer" });
  await ds.runTransaction(async () => {
    await ds.client.query("insert into ledger (charge_id) values ($1)", [chargeId]);
    await ds.client.query("update charge set status='settled' where id=$1", [chargeId]);
  }, { name: "settle" });
  if (crash === "aftertx") { console.log("crash after settle commit"); Deno.exit(1); }
  return "settled";
}, { name: "act" });

DBOS.setConfig({ name: "impure-gate", systemDatabaseUrl: url });
await DBOS.launch();
if (mode === "start") {
  await exterior.query("insert into charge values ($1,'charging') on conflict do nothing", [id]);
  const h1 = await DBOS.startWorkflow(act, { workflowID: id })(id);
  const h2 = await DBOS.startWorkflow(act, { workflowID: id })(id);
  console.log("results", await h1.getResult(), await h2.getResult());
} else if (mode === "recover") {
  await new Promise((r) => setTimeout(r, 3000));
}
const s = await exterior.query(`select (select count(*) from peer_calls where key like $1||'%') calls,
  (select count(*) from ledger where charge_id=$1) ledger, (select status from charge where id=$1) status`, [id]);
console.log(mode, crash || "-", JSON.stringify(s.rows[0]));
await DBOS.shutdown(); await exterior.end(); Deno.exit(0);
