// A provider's signal through what a container release runs: the door's own route,
// the real PostgREST, the emitted function and interpreter in postgres. Graphile's
// add_job is a stand-in, as in external-effects.integration.test.ts. Regression
// rationale: a signal believed in nothing still must not be lost while a check runs,
// so mid-check answers 503 and the provider's redelivery carries it.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
const pinned = (name: string) => {
  const found = cluster.match(new RegExp(`"(${name}:[^"@]+@sha256:[0-9a-f]{64})"`))?.[1];
  if (!found) throw new Error(`cluster.cue pins no ${name} image`);
  return found;
};

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

const program = paymentProgram({
  effect: `key: ["id", "checks"]`,
  machine: `pending: on: nudge: "charging"
        charging: invoke: {src: "charge", onDone: "settled", onError: "pending"}
        settled: type: "final"`,
}).replace(`{name: "failure", type: "string"},`, `{name: "failure", type: "string"},\n          {name: "checks", type: "int32"},`)
  .replace("    effects: charge:", `    signals: {
      stripe: {machine: "PaymentMachine", event: "nudge", id: {body: ["data", "object", "client_reference_id"]}, count: "checks"}
      vendor: {machine: "PaymentMachine", event: "nudge", id: {path: true}, count: "checks"}
    }
    effects: charge:`);

/** The door's own route, over a stand-in for the snippet the release's Caddyfile imports. */
async function doorRoute(): Promise<string> {
  const door = await Deno.readTextFile(new URL("./assets/Caddyfile", import.meta.url));
  const route = door.match(/  handle \/signal\/\* \{\n[\s\S]*?\n  \}\n/)?.[0];
  if (!route) throw new Error("the door has no signal route");
  return `{\n  admin off\n  auto_https off\n}\n(bounded-crud) {\n}\n:8080 {\n${route}\n}\n`;
}

Deno.test({ name: "a signal moves a row once, is refused mid-check, and believes nothing else", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const files = await emitFiles(program);
  const tag = crypto.randomUUID().slice(0, 8);
  const network = `signals-${tag}`, db = `signals-pg-${tag}`, rest = `signals-rest-${tag}`, door = `signals-door-${tag}`;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/Caddyfile`, await doorRoute());
  const psql = (sql: string) => run("docker", ["exec", "-i", db, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const must = async (r: Promise<{ ok: boolean; err: string }>) => {
    const done = await r;
    if (!done.ok) throw new Error(done.err);
  };
  try {
    await must(run("docker", ["network", "create", network]));
    await must(run("docker", ["run", "-d", "--rm", "--name", db, "--network", network, "--network-alias", "database", "-e", "POSTGRES_PASSWORD=pw", POSTGRES]));
    for (let i = 0; !(await run("docker", ["exec", db, "pg_isready", "-qh", "127.0.0.1", "-U", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    await must(psql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE app_user; CREATE ROLE electric;
      CREATE SCHEMA graphile_worker;
      CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
      CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
        run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
        flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
        $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text, checks int NOT NULL DEFAULT 0);
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/ticker/schedule.sql", import.meta.url))}
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/airlock/airlock.sql", import.meta.url))}
      ${files["services/database/migrations/010_machines.sql"].text}
      ${files["services/database/migrations/802_signals.sql"].text}
      INSERT INTO payment (id, status, total) VALUES ('00000000-0000-0000-0000-000000000001', 'pending', 1),
                                                     ('00000000-0000-0000-0000-000000000002', 'pending', 1);`));
    await must(run("docker", ["run", "-d", "--rm", "--name", rest, "--network", network, "--network-alias", "crud",
      "-e", "PGRST_DB_URI=postgres://postgres:pw@database:5432/postgres", "-e", "PGRST_DB_ANON_ROLE=anon", pinned("postgrest/postgrest")]));
    await must(run("docker", ["run", "-d", "--rm", "--name", door, "--network", network, "-p", "127.0.0.1::8080", "-v", `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
      pinned("caddy"), "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]));
    const port = (await run("docker", ["port", door, "8080"])).out.split(":").pop();
    const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
      return { status: res.status, body: await res.text() };
    };
    for (let i = 0; (await post("/signal/stripe", "{}").catch(() => ({ status: 0 }))).status !== 200; i++) {
      if (i > 120) throw new Error("the door or PostgREST did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const one = "00000000-0000-0000-0000-000000000001", two = "00000000-0000-0000-0000-000000000002";
    const stripe = (id: string) => JSON.stringify({ type: "checkout.session.completed", data: { object: { client_reference_id: id, payment_status: "paid" } } });

    await t.step("a signal naming a waiting row moves it and claims a counted key", async () => {
      assertEquals(await post("/signal/stripe", stripe(one), { authorization: "Bearer forged" }), { status: 200, body: `{"signal" : "moved"}` });
      assertEquals((await psql(`SELECT status, checks FROM payment WHERE id = '${one}'`)).out, "charging|1");
      assertEquals((await psql(`SELECT key FROM airlock.external_effect_ledger`)).out, `charge:["${one}", "1"]`);
    });
    await t.step("mid-check answers 503, so the provider redelivers and the signal is not lost", async () => {
      assertEquals((await post("/signal/stripe", stripe(one))).status, 503);
      assertEquals((await psql(`SELECT checks FROM payment WHERE id = '${one}'`)).out, "1");
    });
    await t.step("an id in the path works as one in the body", async () => {
      assertEquals(await post(`/signal/vendor/${two}`, "{}"), { status: 200, body: `{"signal" : "moved"}` });
    });
    await t.step("whatever names no waiting row is acknowledged and moves nothing", async () => {
      for (const body of ["{}", stripe("not-a-uuid"), stripe("00000000-0000-0000-0000-00000000dead")]) {
        assertEquals(await post("/signal/stripe", body), { status: 200, body: `{"signal" : "ignored"}` });
      }
    });
    await t.step("anything else is refused at the door", async () => {
      assertEquals((await post("/signal/absent", "{}")).status, 404);
      assertEquals((await post("/signal/stripe", "not json")).status, 400);
      assertEquals((await fetch(`http://127.0.0.1:${port}/signal/stripe`).then(async (r) => (await r.body?.cancel(), r))).status, 405);
    });
  } finally {
    for (const name of [door, rest, db]) await run("docker", ["rm", "-f", name]);
    await run("docker", ["network", "rm", network]);
    await Deno.remove(dir, { recursive: true });
  }
} });
