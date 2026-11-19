// A read whose sink is a bridge, where it runs: the interpreter emitted for a
// state that invokes one, in postgres, with Graphile's add_job a recording
// stand-in; the airlock's daprd holding the endpoint pronto emits for the read
// behind the cluster's wall; the bridge's simulator a container under the
// container's name on the daprd's network; and mecha's airlock (airlock.ts,
// read.ts) run under its own config, asking through that daprd, delivering,
// journaling and, in replay, answering from the journal. It needs Docker.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { bridgedReadProgram, emitFiles } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const DAPRD = "daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125";
const DENO = "denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432";
const MECHA = new URL("../../libraries/mecha/", import.meta.url);
const AIRLOCK = new URL("services/airlock/", MECHA);

async function run(cmd: string, args: string[], stdin?: string, cwd?: string) {
  const child = new Deno.Command(cmd, { args, cwd, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const res = await child.output();
  return { ok: res.success, out: new TextDecoder().decode(res.stdout).trim(), err: new TextDecoder().decode(res.stderr) };
}

async function must(cmd: string, args: string[], cwd?: string): Promise<string> {
  const r = await run(cmd, args, undefined, cwd);
  if (!r.ok) throw new Error(`${cmd} ${args.join(" ")}: ${r.err}`);
  return r.out;
}

/** The bridge's simulator: the vendor's rates from a fixture, each answer
 * naming how many requests came before it and the credential it was sent,
 * and `/asked` every request it took. */
const SIMULATOR = `
  const asked = [];
  Deno.serve({ port: 3000, hostname: "0.0.0.0", onListen() {} }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/asked") return Response.json(asked);
    asked.push(req.method + " " + u.pathname + u.search);
    const usd = { USD: 5.3, EUR: 6.1 }[u.pathname.slice("/rates/".length)];
    if (usd === undefined) return Response.json({ error: "no such currency" }, { status: 404 });
    return Response.json({ usd, nth: asked.length, authorization: req.headers.get("authorization") }, { headers: { "cache-control": "public, max-age=60" } });
  });`;

/** The airlock's own functions, run in a process of its own config, with one
 * cache for the run as an airlock process has: each step a perform, answered
 * as JSON in order. */
const DRIVER = `
  import pg from "pg";
  import { performRead } from "${new URL("airlock.ts", AIRLOCK).href}";
  import { journalIndexes, parseReads, READ_JOURNAL_SQL } from "${new URL("read.ts", AIRLOCK).href}";
  const [connectionString, mesh, manifest, replay, steps] = Deno.args;
  const db = new pg.Pool({ connectionString, max: 2 });
  await db.query(READ_JOURNAL_SQL);
  await journalIndexes(db);
  // The header main.ts makes of the read's credential, its value compose's default.
  const a = { db, reads: parseReads(manifest), headers: { rate: { Authorization: "Bearer simulator" } }, mesh, target: "local", replay: replay === "replay" };
  const out = [];
  for (const s of JSON.parse(steps)) {
    try {
      out.push({ ok: await performRead(a, s.job, s.last ?? false) ?? null });
    } catch (e) {
      out.push({ error: e.constructor.name, message: e.message });
    }
  }
  await db.end();
  console.log(JSON.stringify(out));`;

Deno.test({ name: "a read is answered by its bridge's simulator through the airlock's daprd, cached, failed where the bridge is not deployed, and replayed from the journal", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const files = await emitFiles(bridgedReadProgram());
  const manifest = JSON.stringify(files["services/airlock/effects.json"].data);
  // The same program with no simulator: the local stack runs no container for the bridge.
  const unsimulated = JSON.stringify((await emitFiles(bridgedReadProgram({ bridge: `{container: "vendor", port: 3000}` })))["services/airlock/effects.json"].data);
  const endpoint = files["services/airlock/dapr/rate.yaml"].data;
  assertEquals(endpoint.spec.baseUrl, "http://vendor:3000");

  const tag = crypto.randomUUID().slice(0, 8);
  const network = `pronto-reads-bridge-${tag}`, pgName = `pronto-reads-bridge-pg-${tag}`, daprName = `pronto-reads-bridge-daprd-${tag}`, simName = `pronto-reads-bridge-vendor-${tag}`;
  const dir = await Deno.makeTempDir();
  const components = `${dir}/components`;
  await Deno.mkdir(components);
  await Deno.writeTextFile(`${dir}/driver.ts`, DRIVER);
  await Deno.writeTextFile(`${dir}/simulator.ts`, SIMULATOR);
  // The endpoint as emitted, and the cluster's own wall and policy for it.
  await Deno.writeTextFile(`${components}/rate.yaml`, JSON.stringify(endpoint));
  const generated = (of: string) => must("cue", ["export", ".:cluster", "--out", "text", "-e", `(${of}).out`], MECHA.pathname);
  await Deno.writeTextFile(`${components}/wall.yaml`, await generated(`#AirlockWall & {effects: ["rate"], blobs: false}`));
  await Deno.writeTextFile(`${components}/resiliency.yaml`, await generated(`#AirlockResiliency & {effects: ["rate"]}`));
  try {
    await must("docker", ["network", "create", network]);
    await must("docker", ["run", "-d", "--rm", "--name", pgName, "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD=pw", POSTGRES]);
    // Copied in, not bind-mounted: a mount names a path on the daemon's host.
    // The simulator answers under the container's name, as compose aliases it.
    await must("docker", ["create", "--rm", "--name", simName, "--network", network, "--network-alias", "vendor", DENO, "run", "--allow-net", "/simulator.ts"]);
    await must("docker", ["cp", `${dir}/simulator.ts`, `${simName}:/simulator.ts`]);
    await must("docker", ["start", simName]);
    await must("docker", [
      "create", "--rm", "--name", daprName, "--network", network, "-p", "127.0.0.1::3500", DAPRD,
      "./daprd", "--app-id", "airlock", "--resources-path", "/components", "--config", "/dapr.yaml", "--dapr-http-port", "3500", "--mode", "standalone",
    ]);
    await Deno.chmod(components, 0o755);
    await must("docker", ["cp", `${components}/.`, `${daprName}:/components`]);
    await must("docker", ["cp", new URL("dapr.yaml", AIRLOCK).pathname, `${daprName}:/dapr.yaml`]);
    await must("docker", ["start", daprName]);
    for (let i = 0; !(await run("docker", ["exec", pgName, "pg_isready", "-qh", "127.0.0.1", "-U", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const mesh = `http://127.0.0.1:${(await must("docker", ["port", daprName, "3500"])).split("\n")[0].split(":").pop()}`;
    for (let i = 0; !(await fetch(`${mesh}/v1.0/healthz/outbound`).then((r) => (r.body?.cancel(), r.ok), () => false)); i++) {
      if (i > 120) throw new Error("daprd did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
    const port = (await must("docker", ["port", pgName, "5432"])).split("\n")[0].split(":").pop();
    const psql = (sql: string) => run("docker", ["exec", "-i", pgName, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], sql);
    const airlock = async (steps: unknown[], { mode = "live", reads = manifest } = {}) => {
      const r = await run(Deno.execPath(), ["run", "--config", new URL("deno.json", AIRLOCK).pathname, "--frozen", "--allow-net", "--allow-read", "--allow-env", "--allow-sys", `${dir}/driver.ts`,
        `postgres://postgres:pw@127.0.0.1:${port}/postgres`, mesh, reads, mode, JSON.stringify(steps)]);
      if (!r.ok) throw new Error(r.err);
      return JSON.parse(r.out) as { ok?: unknown; error?: string; message?: string }[];
    };
    /** Every request the simulator took, asked of it inside its container. */
    const asked = async () => JSON.parse(await must("docker", ["exec", simName, "deno", "eval", `console.log(await (await fetch("http://127.0.0.1:3000/asked")).text())`])) as string[];
    for (let i = 0; !(await run("docker", ["exec", simName, "deno", "eval", `await fetch("http://127.0.0.1:3000/asked")`])).ok; i++) {
      if (i > 60) throw new Error("the simulator did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
    const setup = await psql(`
      CREATE ROLE anon; CREATE ROLE app_user; CREATE ROLE electric; CREATE ROLE crud LOGIN;
      CREATE SCHEMA graphile_worker;
      CREATE TABLE graphile_worker.added (identifier text, payload json, job_key text, max_attempts int);
      CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL, queue_name text DEFAULT NULL,
        run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL, job_key text DEFAULT NULL, priority int DEFAULT NULL,
        flags text[] DEFAULT NULL, job_key_mode text DEFAULT 'replace') RETURNS void LANGUAGE sql AS
        $$ INSERT INTO graphile_worker.added VALUES (identifier, payload, job_key, max_attempts) $$;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL, failure text, pricings int, lineage uuid);
      GRANT ALL ON payment TO crud, anon, app_user;
      ${await Deno.readTextFile(new URL("services/ticker/schedule.sql", MECHA))}
      ${await Deno.readTextFile(new URL("airlock.sql", AIRLOCK))}
      ${await Deno.readTextFile(new URL("job_key.sql", AIRLOCK))}
      ${files["services/database/migrations/010_machines.sql"].text}
      INSERT INTO payment VALUES ${[[1, "USD"], [2, "USD"], [3, "BRL"], [4, "EUR"], [5, "EUR"], [6, "USD"]].map(([n, currency]) => `('${id(n as number)}', 'pending', 1.00, '${currency}', 0, NULL)`).join(", ")};
      UPDATE payment SET status = 'pricing';`);
    if (!setup.ok) throw new Error(setup.err);
    const status = async (n: number) => (await psql(`SELECT status || ' ' || coalesce(failure, '') FROM payment WHERE id = '${id(n)}'`)).out;
    const jobOf = async (n: number) => JSON.parse((await psql(`SELECT payload FROM graphile_worker.added WHERE payload->'row'->>'id' = '${id(n)}' ORDER BY ctid DESC LIMIT 1`)).out);
    const journal = async (n: number) => JSON.parse((await psql(`SELECT outcome FROM airlock.read_journal WHERE row->>'id' = '${id(n)}'`)).out || "null");

    await t.step("the read's path and query reach the bridge's container through its endpoint on the daprd, and a 2xx is done with the body", async () => {
      assertEquals(await airlock([{ op: "perform", job: await jobOf(1) }]), [{ ok: null }]);
      assertEquals(await asked(), ["GET /rates/USD?day=2026-11-16"]);
      assertEquals(await status(1), "settled 5.3");
      // The simulator is sent the read's header, its value compose's default for a simulated sink.
      assertEquals(await journal(1), { target: "settled", kind: "done", data: { usd: 5.3, nth: 1, authorization: "Bearer simulator" } });
    });

    await t.step("an airlock's cache answers the same request again, and another request asks the bridge", async () => {
      // A new process, so a cache of its own: row 2 asks, and row 5, another path, asks too.
      assertEquals(await airlock([{ op: "perform", job: await jobOf(2) }, { op: "perform", job: { ...await jobOf(5), n: 0 } }, { op: "perform", job: await jobOf(5) }]), [{ ok: null }, { ok: null }, { ok: null }]);
      // Row 5's first job names an entry the row does not wait on: its answer
      // moved nothing, and stayed in the cache for the entry that does.
      assertEquals(await asked(), ["GET /rates/USD?day=2026-11-16", "GET /rates/USD?day=2026-11-16", "GET /rates/EUR?day=2026-11-16"]);
      assertEquals([await status(2), await status(5)], ["settled 5.3", "settled 6.1"]);
      assertEquals((await journal(5)).data.nth, 3);
    });

    await t.step("any other status the bridge answers is failed with its status and body", async () => {
      assertEquals(await airlock([{ op: "perform", job: await jobOf(3) }]), [{ ok: null }]);
      assertEquals(await status(3), "failed failed");
      assertEquals(await journal(3), { target: "failed", kind: "failed", data: { status: 404, body: { error: "no such currency" } } });
    });

    await t.step("a bridge the local stack runs no simulator of is failed at once through the read's delivery, and nothing is asked", async () => {
      const before = (await asked()).length;
      assertEquals(await airlock([{ op: "perform", job: await jobOf(4) }], { reads: unsimulated }), [{ ok: null }]);
      assertEquals(await status(4), "failed failed");
      assertEquals(await journal(4), { target: "failed", kind: "failed", data: { bridge: "rates", target: "local", reason: "not deployed" } });
      assertEquals((await asked()).length, before);
    });

    await t.step("a bridge that gives no answer is retried, and failed with the error on the last run", async () => {
      await must("docker", ["rm", "-f", simName]);
      const [first] = await airlock([{ op: "perform", job: await jobOf(6) }]);
      assertEquals(typeof first.error, "string", "a run with no answer throws, for Graphile to retry");
      assertEquals([await status(6), await journal(6)], ["pricing USD", null]);
      assertEquals(await airlock([{ op: "perform", job: await jobOf(6), last: true }]), [{ ok: null }]);
      assertEquals(await status(6), "failed failed");
      assertStringIncludes((await journal(6)).data.error, "read rate");
    });

    // Replay re-runs a row's history from its start: the row as it was, its
    // transitions written again, so its entry is counted to the same n.
    const rewind = (n: number, failure: string) =>
      psql(`ALTER TABLE payment DISABLE TRIGGER USER; UPDATE payment SET status = 'pending', failure = '${failure}', pricings = 0 WHERE id = '${id(n)}'; ALTER TABLE payment ENABLE TRIGGER USER;
        UPDATE payment SET status = 'pricing' WHERE id = '${id(n)}';`);

    await t.step("replay answers each from the journal, the bridge gone: the body, the status and the bridge not deployed", async () => {
      for (const [n, failure, settled] of [[1, "USD", "settled 5.3"], [3, "BRL", "failed failed"], [4, "EUR", "failed failed"]] as const) {
        if (!(await rewind(n, failure)).ok) throw new Error("rewind");
        const job = await jobOf(n);
        assertEquals(job.n, 1);
        assertEquals(await status(n), `pricing ${failure}`);
        assertEquals(await airlock([{ op: "perform", job }], { mode: "replay" }), [{ ok: null }]);
        assertEquals(await status(n), settled);
      }
    });
  } finally {
    await run("docker", ["rm", "-f", pgName, daprName, simName]);
    await run("docker", ["network", "rm", network]);
  }
} });
