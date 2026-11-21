// Field behaviour (#Field.outputOnly, #Field.immutable), as Google AIP-203
// states it, held in PostgreSQL for the clients alone: what a role a token
// names sends (anon, app_user, a declared token role, any authenticator may
// switch to but the service) is cleared or refused, and the server's writers,
// a SECURITY DEFINER machine among them, write both.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";

const DATABASE = "bonitao/mecha-database:0.29.0@sha256:615ce52fe0bd24c051b83c24bf5cb954d394065c2e146e35e47a5da70b51155f";
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

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// Payment's `failure` is the server's to set and `code` is set at creation;
// paying assigns the one on the row, and entering `paid` writes both on the
// row ${id(9)} from inside the machine's trigger.
const program = paymentProgram({ machine: `
        pending: on: pay: {target: "paid", actions: [{assign: {failure: "approved"}}]}
        paid: entry: [{effect: {table: "payment", op: "update", values: {code: "Z", failure: "by the machine"}, where: {id: "${id(9)}"}}}]` })
  .replace(/\n    effects: charge: \{[\s\S]*?\n    }\n/, "\n")
  .replace(`{name: "failure", type: "string"},`, `{name: "failure", type: "string", required: false, outputOnly: true},\n          {name: "code", type: "string", required: false, immutable: true},\n          {name: "terms", type: "json", required: false, immutable: true},`);

Deno.test({ name: "a client's output-only value is cleared and its immutable change refused, and the server writes both", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const emitted = await cue(["export", "-", "-e", '{behavior: out["services/database/migrations/799_field_behavior.sql"].text, machines: out["services/database/migrations/010_machines.sql"].text}', "--out", "json"], program);
  if (!emitted.success) throw new Error(emitted.stderr);
  const { behavior, machines } = JSON.parse(emitted.stdout);
  // The same program with no field behaving, whose release reconciles for a
  // token role, and whose audit table no migration has created yet.
  const ordinary = paymentProgram({ entity: `Audit: {table: "audit", durability: "server", fields: [{name: "id", type: "uuid", pk: true}]}` })
    .replace("    effects: charge:", "    tokenRoles: {}\n    effects: charge:");
  const reconciled = await cue(["export", "-", "-e", "_cluster.state.reconcile.field_behavior", "--out", "json"], ordinary);
  if (!reconciled.success) throw new Error(reconciled.stderr);
  const dropped: string = JSON.parse(reconciled.stdout);
  const container = `pronto-behavior-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run(["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "postgres"], sql);
  const sql = async (query: string) => {
    const result = await psql(query);
    if (!result.ok) throw new Error(result.err);
    return result.out;
  };
  const row = (n: number) => sql(`SELECT concat_ws(',', status, total, coalesce(failure, '-'), coalesce(code, '-')) FROM payment WHERE id = '${id(n)}'`);
  try {
    for (let i = 0; !(await run(["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // As 001_roles.sql grants them: authenticator switches into every role a
    // token names, a declared token role (partner) among them.
    await sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE app_user NOLOGIN; CREATE ROLE service NOLOGIN; CREATE ROLE partner NOLOGIN;
      CREATE ROLE authenticator LOGIN NOINHERIT; GRANT anon, app_user, service, partner TO authenticator;
      CREATE ROLE reporting NOLOGIN;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'pending', total numeric NOT NULL DEFAULT 0, failure text, code text, terms json);
      GRANT SELECT, INSERT, UPDATE ON payment TO anon, app_user, service, partner, reporting;
      INSERT INTO payment (id, code) VALUES ('${id(9)}', 'Y');
      ${behavior}
      ${machines}`);

    await t.step("the field's trigger fires before the machine's", async () => {
      const names = await sql("SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'payment'::regclass AND NOT tgisinternal");
      assertEquals(names.split(",")[0], "0_payment_field_behavior");
      assertEquals(names.split(",").length > 1, true);
    });

    await t.step("a client's insert takes the output-only default and sets the immutable value", async () => {
      await sql(`SET ROLE app_user; INSERT INTO payment (id, total, failure, code) VALUES ('${id(1)}', 1, 'by the client', 'A');`);
      await sql(`SET ROLE anon; INSERT INTO payment (id, total, failure, code) VALUES ('${id(2)}', 2, 'by the client', 'B');`);
      assertEquals(await row(1), "pending,1,-,A");
      assertEquals(await row(2), "pending,2,-,B");
    });

    await t.step("a client's update keeps the output-only value, and is never refused for it", async () => {
      await sql(`SET ROLE app_user; UPDATE payment SET total = 5, failure = 'by the client' WHERE id = '${id(1)}';`);
      assertEquals(await row(1), "pending,5,-,A");
    });

    await t.step("a client's update stating the immutable value passes, and one changing it is an invalid argument", async () => {
      await sql(`SET ROLE app_user; UPDATE payment SET code = 'A', total = 6 WHERE id = '${id(1)}';`);
      assertEquals(await row(1), "pending,6,-,A");
      const refused = await psql(`SET ROLE app_user; UPDATE payment SET code = 'C' WHERE id = '${id(1)}';`);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "22023");
      assertStringIncludes(refused.err, "payment.code is immutable: it is set when the row is created and never changed");
      const anon = await psql(`SET ROLE anon; UPDATE payment SET code = 'C' WHERE id = '${id(2)}';`);
      assertEquals(anon.ok, false);
      assertEquals(await row(1), "pending,6,-,A");
    });

    await t.step("the machine a client moves writes both, on its row and on another", async () => {
      await sql(`SET ROLE app_user; UPDATE payment SET status = 'paid', failure = 'by the client' WHERE id = '${id(1)}';`);
      assertEquals(await row(1), "paid,6,approved,A");
      assertEquals(await row(9), "pending,0,by the machine,Z");
    });

    await t.step("a declared token role is a client, which a role added after the trigger is held as too", async () => {
      await sql(`SET ROLE partner; INSERT INTO payment (id, failure, code) VALUES ('${id(3)}', 'by the partner', 'P');`);
      assertEquals(await row(3), "pending,0,-,P");
      await sql(`SET ROLE partner; UPDATE payment SET failure = 'by the partner' WHERE id = '${id(3)}';`);
      assertEquals(await row(3), "pending,0,-,P");
      const refused = await psql(`SET ROLE partner; UPDATE payment SET code = 'Q' WHERE id = '${id(3)}';`);
      assertEquals(refused.ok, false);
      assertStringIncludes(refused.err, "22023");
      await sql(`CREATE ROLE later NOLOGIN; GRANT later TO authenticator; GRANT SELECT, UPDATE ON payment TO later;`);
      await sql(`SET ROLE later; UPDATE payment SET failure = 'by a later role' WHERE id = '${id(3)}';`);
      assertEquals(await row(3), "pending,0,-,P");
    });

    await t.step("a role no token names is no client", async () => {
      await sql(`SET ROLE reporting; UPDATE payment SET failure = 'by reporting', code = 'R' WHERE id = '${id(3)}';`);
      assertEquals(await row(3), "pending,0,by reporting,R");
    });

    await t.step("an immutable json value restated with its keys in another order is the same value", async () => {
      await sql(`SET ROLE app_user; INSERT INTO payment (id, terms) VALUES ('${id(4)}', '{"a": 1, "b": [1, 2]}');`);
      await sql(`SET ROLE app_user; UPDATE payment SET terms = '{"b":[1,2],"a":1}' WHERE id = '${id(4)}';`);
      const changed = await psql(`SET ROLE app_user; UPDATE payment SET terms = '{"a": 1, "b": [2, 1]}' WHERE id = '${id(4)}';`);
      assertEquals(changed.ok, false);
      assertStringIncludes(changed.err, "payment.terms is immutable");
    });

    await t.step("the service is no client", async () => {
      await sql(`SET ROLE service; UPDATE payment SET failure = 'by the service', code = 'S' WHERE id = '${id(2)}';`);
      assertEquals(await row(2), "pending,2,by the service,S");
      await sql(`UPDATE payment SET failure = 'by the owner', code = 'O' WHERE id = '${id(2)}';`);
      assertEquals(await row(2), "pending,2,by the owner,O");
    });

    await t.step("a release of the program that states none takes the trigger off, and again finds nothing to take", async () => {
      await sql(dropped);
      await sql(dropped);
      assertEquals(await sql("SELECT count(*) FROM pg_trigger WHERE tgname = '0_payment_field_behavior'"), "0");
      assertEquals(await sql("SELECT count(*) FROM pg_proc WHERE proname = 'trg_payment_field_behavior'"), "0");
      await sql(`SET ROLE app_user; UPDATE payment SET failure = 'by the client', code = 'N' WHERE id = '${id(4)}';`);
      assertEquals(await row(4), "pending,0,by the client,N");
    });
  } finally {
    const removed = await run(["rm", "-f", container]);
    if (!removed.ok) throw new Error(removed.err);
  }
} });
