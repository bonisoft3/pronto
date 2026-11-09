import assert from "node:assert/strict";
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { compileCortexRecipe, compileCortexSql, type CortexSqlRecipe } from "./cortex-machine.ts";

const recipe = (): CortexSqlRecipe => ({
  state: "idle", field: "status", mode: "dispatch",
  states: {
    idle: { entry: [], exit: ["INSERT INTO trace VALUES ('exit');"] },
    active: { entry: ["INSERT INTO trace VALUES ('entry');"], exit: [] },
  },
  transitions: [
    { event: "go", target: "active", guard: "(cortex_payload->>'accept')::boolean", actions: ["INSERT INTO trace VALUES ('transition');"] },
    { event: "go", actions: ["INSERT INTO trace VALUES ('targetless');"] },
  ],
});

Deno.test("compiled XState plans keep branch refusal, targetless lifetime and exit/action/entry SQL order", async () => {
  const db = new PGlite();
  try {
    const trigger = compileCortexRecipe(recipe());
    await db.exec(`CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL, accept boolean);
      CREATE TABLE trace(message text);
      CREATE FUNCTION machine() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cortex_event text := 'go'; cortex_payload jsonb := jsonb_build_object('accept', NEW.accept); cortex_changed integer := 1;
      BEGIN ${trigger} END $$;
      CREATE TRIGGER machine BEFORE UPDATE ON job FOR EACH ROW EXECUTE FUNCTION machine();
      INSERT INTO job VALUES ('a', 'idle', true), ('b', 'idle', false), ('c', 'idle', NULL);
      UPDATE job SET status=status WHERE id='a';`);
    assert.deepEqual((await db.query("SELECT message FROM trace")).rows.map((r: any) => r.message), ["exit", "transition", "entry"]);
    await db.exec("DELETE FROM trace; UPDATE job SET status=status WHERE id IN ('b','c');");
    assert.deepEqual((await db.query("SELECT message FROM trace")).rows.map((r: any) => r.message), ["targetless", "targetless"]);
    assert.deepEqual((await db.query("SELECT status FROM job ORDER BY id")).rows.map((r: any) => r.status), ["active", "idle", "idle"]);
  } finally { await db.close(); }
});

Deno.test("the Cortex SQL compiler fails closed on invalid recipes and excessive guard graphs", () => {
  assert.throws(() => compileCortexSql("@PRONTO_XSTATE broken"));
  assert.throws(() => compileCortexSql(" @PRONTO_XSTATE\n"), /malformed/);
  const missing = recipe();
  missing.transitions[0].target = "missing";
  assert.throws(() => compileCortexRecipe(missing), /does not exist/);
  const large = recipe();
  large.transitions = Array.from({ length: 130 }, (_, n) => ({ event: "go", target: "active", guard: `g${n}`, actions: [] }));
  assert.throws(() => compileCortexRecipe(large), /finite compilation bound/);
});

Deno.test("compiled SQL survives Airlock's nested PostgreSQL literals", async () => {
  const db = new PGlite();
  const quoted = (sql: string) => `E'${sql.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  const value = recipe();
  value.transitions[0].actions.push("INSERT INTO trace VALUES ('café O''Reilly \\ quoted');");
  const payload = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
  const source = `CREATE FUNCTION machine() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cortex_event text := 'go'; cortex_payload jsonb := '{"accept":true}'; cortex_changed integer := 1;
BEGIN
IF NEW.id='a' THEN
@PRONTO_XSTATE'${payload}'
END IF;
@PRONTO_XSTATE'${payload}'
END $$;`;
  try {
    await db.exec(`CREATE TABLE job(id text PRIMARY KEY, status text NOT NULL); CREATE TABLE trace(message text);
      ${compileCortexSql(`DO ${quoted(`BEGIN EXECUTE ${quoted(source)}; END`)};`)}
      CREATE TRIGGER machine BEFORE UPDATE ON job FOR EACH ROW EXECUTE FUNCTION machine();
      INSERT INTO job VALUES ('a','idle'),('b','idle'); UPDATE job SET status=status;`);
    const expected = ["exit", "transition", "café O'Reilly \\ quoted", "entry"];
    assert.deepEqual((await db.query("SELECT message FROM trace")).rows.map((r: any) => r.message), [...expected, ...expected]);
  } finally { await db.close(); }
});
