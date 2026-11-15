import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";

const DATABASE = "bonitao/mecha-database:0.23.1@sha256:ab98bb1431e05361e30e73583335c01170c17d8dcddbb666b2f57bb837f63f77";
async function run(args: string[], input?: string) {
  const child = new Deno.Command("docker", { args, stdin: input === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const result = await child.output();
  return { ok: result.success, out: new TextDecoder().decode(result.stdout).trim(), err: new TextDecoder().decode(result.stderr) };
}

Deno.test({ name: "lifecycle guards and actions share the write transaction after RLS", sanitizeOps: false, sanitizeResources: false, fn: async t => {
  const action = (op: string) => `{effect: {op: "create", table: "audit", values: {id: {raw: "gen_random_uuid()"}, operation: "${op}"}}}`;
  const program = paymentProgram({ machine: "pending: {}", entity: `Audit: {table: "audit", durability: "server", fields: [{name: "id", type: "uuid", pk: true}, {name: "operation", type: "string"}]}` })
    .replace(/\n    effects: charge: \{[\s\S]*?\n    }\n/, "\n") + `
app: state: mecha: rows: PaymentRules: {
  entity: "Payment"
  guards: positive: {
    src: "shell/validations/positive.js"
    note: "positive rows and a permitted parent"
    edges: [{table: "parent", key: "id", from: "parent_id"}]
    module: {
      statements: ""
      completion: "({ context, event }) => { if (event.row.total === 20) throw new Error('guard read before RLS'); if (event.row.total === 99) return null; return event.row.total > 0 && event.row.doubled === event.row.total * 2 && context.items.length === (event.type === 'insert' ? 0 : 1) && context.rows.parent.every(p => p.allowed) && (event.type !== 'delete' || event.row.total > 1); }"
    }
  }
  on: {
    insert: {guard: "positive", actions: ${action("insert")}}
    update: {guard: "positive", actions: ${action("update")}}
    delete: {guard: "positive", actions: ${action("delete")}}
  }
}
`;
  const emitted = await cue(["export", "-", "-e", '{predicates: out["services/database/migrations/009_validations.sql"].text, machines: out["services/database/migrations/010_machines.sql"].text}', "--out", "json"], program);
  if (!emitted.success) throw new Error(emitted.stderr);
  const { predicates, machines } = JSON.parse(emitted.stdout);
  const container = `pronto-guards-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run(["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const sql = async (query: string) => {
    const result = await psql(query);
    if (!result.ok) throw new Error(result.err);
    return result.out;
  };
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const insert = (n: number, total: number) => `INSERT INTO payment (id, total, parent_id) VALUES ('${id(n)}', ${total}, '${id(100)}');`;
  try {
    for (let i = 0; !(await run(["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await sql(`CREATE EXTENSION IF NOT EXISTS plv8;
      CREATE TABLE parent (id uuid PRIMARY KEY, allowed boolean NOT NULL);
      INSERT INTO parent VALUES ('${id(100)}', true);
      CREATE TABLE payment (id uuid PRIMARY KEY, status text DEFAULT 'pending', total numeric NOT NULL,
        doubled numeric GENERATED ALWAYS AS (total * 2) STORED, failure text, parent_id uuid REFERENCES parent);
      CREATE TABLE audit (id uuid PRIMARY KEY, operation text NOT NULL);
      CREATE FUNCTION payment_validate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'obsolete validation trigger'; END $$;
      CREATE TRIGGER payment_validate AFTER INSERT ON payment FOR EACH ROW EXECUTE FUNCTION payment_validate();
      ${predicates}
      ${machines}`);
    await t.step("generated columns reach the guard before its action", async () => {
      await sql(insert(1, 1));
      assertEquals(await sql("SELECT count(*) FROM audit"), "1");
    });
    await t.step("refusal rolls back both the row and earlier actions in a batch", async () => {
      const result = await psql(`INSERT INTO payment (id, total, parent_id) VALUES ('${id(2)}', 3, '${id(100)}'), ('${id(3)}', 0, '${id(100)}');`);
      assertEquals(result.ok, false);
      assertStringIncludes(result.err, "validation payment.positive");
      assertEquals(await sql("SELECT (SELECT count(*) FROM payment) || ',' || (SELECT count(*) FROM audit)"), "1,1");
      assertEquals((await psql(`UPDATE payment SET total = 0 WHERE id = '${id(1)}'`)).ok, false);
      assertEquals(await sql("SELECT total FROM payment"), "1");
    });
    await t.step("delete judges OLD and its edges; an accepted transition runs its action", async () => {
      assertEquals((await psql(`DELETE FROM payment WHERE id = '${id(1)}'`)).ok, false);
      await sql(`UPDATE payment SET total = 3 WHERE id = '${id(1)}'; UPDATE parent SET allowed = false;`);
      assertEquals((await psql(`DELETE FROM payment WHERE id = '${id(1)}'`)).ok, false);
      await sql(`UPDATE parent SET allowed = true; DELETE FROM payment WHERE id = '${id(1)}';`);
      assertEquals(await sql("SELECT string_agg(operation, ',' ORDER BY operation) FROM audit"), "delete,insert,update");
    });
    await t.step("a non-boolean answer is a program error", async () => {
      const result = await psql(insert(4, 99));
      assertEquals(result.ok, false);
      assertStringIncludes(result.err, "predicate payment.positive answered object");
    });
    await t.step("RLS refuses before privileged predicate reads, and predicates are not RPCs", async () => {
      await sql(`CREATE ROLE guard_reader; GRANT USAGE ON SCHEMA public TO guard_reader;
        GRANT INSERT, SELECT ON payment TO guard_reader;
        ALTER TABLE payment ENABLE ROW LEVEL SECURITY; ALTER TABLE payment FORCE ROW LEVEL SECURITY;
        CREATE POLICY allowed_payment ON payment TO guard_reader USING (total < 10) WITH CHECK (total < 10);`);
      const refused = await psql(`SET ROLE guard_reader; ${insert(5, 20)}`);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "row-level security");
      assertEquals(refused.err.includes("guard read before RLS"), false);
      await sql(`SET ROLE guard_reader; ${insert(6, 3)}`);
      const rpc = await psql(`SET ROLE guard_reader; SELECT payment_validation_positive('{}', '{}');`);
      assertEquals(rpc.ok, false);
      assertStringIncludes(rpc.err, "permission denied");
    });
  } finally {
    const removed = await run(["rm", "-f", container]);
    if (!removed.ok) throw new Error(removed.err);
  }
} });

// Who sent a write is the event's `_origin`, the session's subject and never a
// column the writer fills, and an edge from it reads the origin's own rows of
// the membership list.
Deno.test({ name: "a lifecycle guard reads the write's origin and its memberships", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const program = paymentProgram({ machine: "pending: {}" })
    .replace(/\n    effects: charge: \{[\s\S]*?\n    }\n/, "\n") + `
app: state: mecha: rows: PaymentRules: {
  entity: "Payment"
  guards: payer: {
    src: "shell/validations/payer.js"
    note: "a payer sends its own payments; the service sends any"
    edges: [{table: "member", key: "user_id", from: "$origin"}]
    module: {
      statements: ""
      completion: "({ context, event }) => event._origin === undefined ? context.rows.member.length === 0 : event._origin === 'user:' + event.row.sent_by && context.rows.member.some(m => m.group_id === 'payers')"
    }
  }
  on: insert: guard: "payer"
}
`;
  const emitted = await cue(["export", "-", "-e", '{predicates: out["services/database/migrations/009_validations.sql"].text, machines: out["services/database/migrations/010_machines.sql"].text}', "--out", "json"], program);
  if (!emitted.success) throw new Error(emitted.stderr);
  const { predicates, machines } = JSON.parse(emitted.stdout);
  const container = `pronto-origin-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run(["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const sent = (n: number, by: string | null, as?: string, role = "app_user") =>
    psql(`${as === undefined ? "" : `SELECT set_config('request.jwt.claims', '{"sub":"${as}","role":"${role}"}', false);`}
      INSERT INTO payment (id, total, sent_by) VALUES ('${id(n)}', 1, ${by === null ? "NULL" : `'${by}'`});`);
  try {
    for (let i = 0; !(await run(["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const made = await psql(`CREATE EXTENSION IF NOT EXISTS plv8;
      CREATE TABLE member (group_id text NOT NULL, user_id uuid NOT NULL);
      INSERT INTO member VALUES ('payers', '${id(1)}'), ('readers', '${id(2)}');
      CREATE TABLE payment (id uuid PRIMARY KEY, status text DEFAULT 'pending', total numeric NOT NULL, failure text, sent_by uuid);
      ${predicates}
      ${machines}`);
    if (!made.ok) throw new Error(made.err);
    assertEquals((await sent(1, id(1), id(1))).ok, true, "a payer sends its own payment");
    const stranger = await sent(2, id(2), id(2));
    assertEquals(stranger.ok, false);
    assertStringIncludes(stranger.err, "validation payment.payer");
    const forged = await sent(3, id(2), id(1));
    assertEquals(forged.ok, false, "the origin is the session's subject, whatever the row says");
    assertEquals((await sent(4, null)).ok, true, "a write with no subject carries no origin");
    // The service's token names a subject too, and not always a person's id.
    assertEquals((await sent(5, null, id(0), "service")).ok, true, "a write the service makes carries no origin");
    const named = await sent(6, null, "compute", "service");
    assertEquals(named.ok, true, named.err);
  } finally {
    const removed = await run(["rm", "-f", container]);
    if (!removed.ok) throw new Error(removed.err);
  }
} });
