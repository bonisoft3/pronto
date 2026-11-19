// A handler effect whose sink on the compose stack is a bridge the stack runs
// no simulator of, where it runs: the interpreter emitted for its invoking
// state and Graphile's own schema in postgres, and mecha's airlock (airlock.ts)
// run under its own config as the local stack's, handed the emitted manifest.
// Regression rationale: the manifest must say where the bridge runs, or the
// airlock dials a container that is not there, run after run, and the row ends
// `unknown`. It needs Docker.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const MECHA = new URL("../../libraries/mecha/", import.meta.url);
const AIRLOCK = new URL("services/airlock/", MECHA);

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

/** The airlock's worker over the emitted manifest, as the local stack runs
 * it, with no handler and no sink to call: it runs until the row leaves its
 * invoking state, or a quarter of a minute. */
const DRIVER = `
  import pg from "pg";
  import { hold, start } from "${new URL("airlock.ts", AIRLOCK).href}";
  import { parseManifest } from "${new URL("reentry.ts", AIRLOCK).href}";
  const [connectionString, manifest, id] = Deno.args;
  const db = new pg.Pool({ connectionString, max: 4 });
  const called = () => { throw new Error("a bridge not deployed is not called"); };
  const liveness = await hold(connectionString);
  const runner = await start({ connectionString, db, effects: parseManifest(manifest), handlers: {}, transport: called, secrets: {}, headers: {}, target: "local" }, liveness.key, { noHandleSignals: true, housekeepingMs: 0 });
  let status = "charging";
  for (let i = 0; i < 60 && status === "charging"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    status = (await db.query("SELECT status FROM payment WHERE id = $1", [id])).rows[0].status;
  }
  await runner.stop();
  await liveness.release();
  await db.end();
  console.log(status);`;

Deno.test({ name: "a handler effect whose compose bridge has no simulator settles failed at once on the local stack, as not deployed", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const files = await emitFiles(
    paymentProgram().replace(
      'sink: {origin: "https://api.acquirer.example", idempotent: true}',
      'sink: {origin: "https://api.acquirer.example", idempotent: true, targets: docker: bridge: "fetch"}',
    ) + `\napp: capabilities: hatches: transport: {kind: "container", note: "a native transport"}\napp: state: bridges: fetch: {container: "transport"}\n` +
      `_cluster: surface: targets: transport: {activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {}}\n`,
  );
  const container = `pronto-bridge-undeployed-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/driver.ts`, DRIVER);
  const psql = (sql: string) => run("docker", ["exec", "-i", container, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  try {
    const started = await run("docker", ["run", "-d", "--rm", "--name", container, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=pw", POSTGRES]);
    if (!started.ok) throw new Error(started.err);
    for (let i = 0; !(await run("docker", ["exec", container, "pg_isready", "-qh", "127.0.0.1", "-U", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const port = (await run("docker", ["port", container, "5432"])).out.split("\n")[0].split(":").pop();
    const one = "00000000-0000-0000-0000-000000000001";
    const setup = await psql(`
      CREATE ROLE anon; CREATE ROLE app_user; CREATE ROLE electric;
      ${await Deno.readTextFile(new URL("services/durex/graphile.sql", MECHA))}
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text);
      ${await Deno.readTextFile(new URL("services/ticker/schedule.sql", MECHA))}
      ${await Deno.readTextFile(new URL("airlock.sql", AIRLOCK))}
      ${await Deno.readTextFile(new URL("job_key.sql", AIRLOCK))}
      ${files["services/database/migrations/010_machines.sql"].text}
      INSERT INTO payment VALUES ('${one}', 'pending', 12.50, NULL);
      UPDATE payment SET status = 'charging' WHERE id = '${one}';`);
    if (!setup.ok) throw new Error(setup.err);
    const r = await run(Deno.execPath(), ["run", "--config", new URL("deno.json", AIRLOCK).pathname, "--frozen", "--unstable-worker-options", "--allow-net", "--allow-read", "--allow-env", "--allow-sys", `${dir}/driver.ts`,
      `postgres://postgres:pw@127.0.0.1:${port}/postgres`, JSON.stringify(files["services/airlock/effects.json"].data), one]);
    if (!r.ok) throw new Error(r.err);
    // The row took its onError arrow, whose action reads the outcome's kind.
    assertEquals(r.out.split("\n").pop(), "failed");
    assertEquals((await psql(`SELECT failure FROM payment WHERE id = '${one}'`)).out, "failed");
    // Settled before its run was counted, with no dead letter left.
    assertEquals(
      JSON.parse((await psql(`SELECT json_build_object('entered', entered, 'outcome', outcome) FROM airlock.external_effect_ledger`)).out),
      { entered: 0, outcome: { target: "failed", kind: "failed", data: { bridge: "fetch", target: "local", reason: "not deployed" }, reconciled: false } },
    );
    assertEquals((await psql(`SELECT count(*) FROM graphile_worker._private_jobs`)).out, "0");
  } finally {
    await run("docker", ["rm", "-f", container]);
    await Deno.remove(dir, { recursive: true });
  }
} });
