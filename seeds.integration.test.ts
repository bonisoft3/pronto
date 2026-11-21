import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";
import { seedSql } from "./seed.ts";

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

// The seed file restores a row standing in a later state; any other writer
// still has its row start where the machine starts.
Deno.test({ name: "a seed file restores a row in a later state, and nothing else may insert one", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const program = paymentProgram({ machine: `
        pending: on: pay: "paid"
        paid: type: "final"` }).replace(/\n    effects: charge: \{[\s\S]*?\n    }\n/, "\n");
  const emitted = await cue(["export", "-", "-e", 'out["services/database/migrations/010_machines.sql"].text', "--out", "json"], program);
  if (!emitted.success) throw new Error(emitted.stderr);
  const machines = JSON.parse(emitted.stdout);
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const seed = seedSql({ entities: [{
    name: "Payment", table: "payment",
    columns: [{ name: "id", type: "uuid" }, { name: "status", type: "string" }, { name: "total" }],
    rows: [{ id: id(1), status: "paid", total: "1" }],
    machines: [{ name: "PaymentMachine", field: "status", initial: "pending", starts: [] }],
  }] }, {});
  const container = `pronto-seeds-${crypto.randomUUID().slice(0, 8)}`;
  const started = await run(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=pw", DATABASE]);
  if (!started.ok) throw new Error(started.err);
  const psql = (sql: string) => run(["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  try {
    for (let i = 0; !(await run(["exec", container, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const setup = await psql(`CREATE TABLE payment (id uuid PRIMARY KEY, status text DEFAULT 'pending', total numeric NOT NULL, failure text);
      ${machines}`);
    if (!setup.ok) throw new Error(setup.err);
    const plain = await psql(`INSERT INTO payment (id, status, total) VALUES ('${id(2)}', 'paid', 1);`);
    assertEquals(plain.ok, false);
    assertStringIncludes(plain.err, "must start in initial state");
    // The file, then an ordinary insert in the same session: the mark ends with the file.
    const seeded = await psql(`${seed}INSERT INTO payment (id, status, total) VALUES ('${id(3)}', 'paid', 1);`);
    assertEquals(seeded.ok, false);
    assertStringIncludes(seeded.err, "must start in initial state");
    assertEquals((await psql("SELECT id || ':' || status FROM payment ORDER BY id;")).out, `${id(1)}:paid`);
    // A client sets the mark too, and it counts for nothing: PostgREST logs in
    // as authenticator, which is not the table's owner.
    const grants = await psql(`CREATE ROLE app_user; CREATE ROLE authenticator LOGIN NOINHERIT; GRANT app_user TO authenticator;
      GRANT INSERT, SELECT ON payment TO app_user;`);
    if (!grants.ok) throw new Error(grants.err);
    const forged = await run(["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "authenticator", "-d", "postgres"],
      `SET ROLE app_user; SELECT set_config('pronto.seed', 'on', false); INSERT INTO payment (id, status, total) VALUES ('${id(4)}', 'paid', 1);`);
    assertEquals(forged.ok, false);
    assertStringIncludes(forged.err, "must start in initial state");
  } finally {
    await run(["rm", "-f", container]);
  }
} });
