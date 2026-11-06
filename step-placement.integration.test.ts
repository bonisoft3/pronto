// A program that places the framework's steps elsewhere gets a database that
// still claims and enqueues: postgres runs the placed steps in their names'
// order, with Graphile's real schema, and the machine at its placed name
// interprets the invoking state as the defaults do.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const mecha = new URL("../../libraries/mecha/", import.meta.url);
const placed = paymentProgram() + `\napp: state: steps: {machines: "062", graphile: "060", airlock: "061", note: "no payment row is written below 060"}\n`;

async function run(cmd: string, args: string[], stdin?: string) {
  const child = new Deno.Command(cmd, { args, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const res = await child.output();
  return { ok: res.success, out: new TextDecoder().decode(res.stdout).trim(), err: new TextDecoder().decode(res.stderr) };
}

Deno.test({ name: "placed steps build a database whose invoking state claims and enqueues", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const files = await emitFiles(placed);
  const copies = await cue(["export", "-", "-e", "_cluster.surface.targets.database.dockerfile.copy", "--out", "json"], placed);
  if (!copies.success) throw new Error(copies.stderr);
  const staged = (JSON.parse(copies.stdout) as { srcs?: string[]; dst: string; from?: unknown }[])
    .filter((c) => c.from !== undefined && c.dst.endsWith(".sql"))
    .map((c) => c.dst.split("/").at(-1)!);
  const source: Record<string, string> = {
    "060_graphile_worker.sql": await Deno.readTextFile(new URL("services/durex/graphile.sql", mecha)),
    "061_airlock.sql": `${await Deno.readTextFile(new URL("services/ticker/schedule.sql", mecha))}\n${await Deno.readTextFile(new URL("services/airlock/airlock.sql", mecha))}`,
    "062_machines.sql": files["services/database/migrations/062_machines.sql"].text,
  };
  const order = [...staged, "062_machines.sql"].sort();
  assertEquals(order, ["060_graphile_worker.sql", "061_airlock.sql", "062_machines.sql"]);

  const container = `pronto-placement-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", POSTGRES]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  try {
    // The image restarts postgres once initdb is done: ready means a query answers over TCP.
    for (let i = 0; !(await run("docker", ["exec", container, "psql", "-h", "127.0.0.1", "-qtAX", "-U", "postgres", "-c", "SELECT 1"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const schema = await psql(`CREATE ROLE anon; CREATE ROLE app_user; CREATE ROLE electric; CREATE ROLE service;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text);`);
    if (!schema.ok) throw new Error(schema.err);
    for (const name of order) {
      const step = await psql(source[name]);
      if (!step.ok) throw new Error(`${name}: ${step.err}`);
    }
    const id = "00000000-0000-0000-0000-000000000001";
    const moved = await psql(`INSERT INTO payment VALUES ('${id}', 'pending', 12.50, NULL);
      UPDATE payment SET status = 'charging' WHERE id = '${id}';
      SELECT (SELECT count(*) FROM airlock.external_effect_ledger) || ',' || (SELECT count(*) FROM graphile_worker.jobs);`);
    if (!moved.ok) throw new Error(moved.err);
    assertEquals(moved.out, "1,1");
  } finally {
    await run("docker", ["rm", "-f", container]);
  }
}});
