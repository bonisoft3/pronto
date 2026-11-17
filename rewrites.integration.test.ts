// An app's rewrites through what a container release runs: the door's emitted
// blocks, the real PostgREST and postgres. Regression rationale: a rewrite is a
// client's existing path, so it answers what /crud answers the same caller,
// credential and query included, and a parameter carries nothing but its value.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const SECRET = "a-secret-of-at-least-thirty-two-characters";
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

const program = paymentProgram().replace("    effects: charge:", `    rewrites: {
      "payment-list": {source: "/expense/payments", destination: "/crud/payment_list", methods: ["GET"]}
      "payment-detail": {source: "/expense/payments/:id", destination: "/crud/payment_list?id=eq.:id", methods: ["GET"]}
      "payment-total": {source: "/expense/payments/:id/total", destination: "/crud/rpc/payment_total?id=:id", methods: ["GET"]}
      "payment-approve": {source: "/expense/payments/:id/approve", destination: "/crud/rpc/payment_approve", methods: ["POST"]}
      "payment-note": {source: "/expense/notes", destination: "/crud/note"}
    }
    effects: charge:`);

/** The door's emitted rewrites, over a stand-in for the snippet the release's Caddyfile imports. */
async function doorRewrites(): Promise<string> {
  const door = (await emitFiles(program))["docker/Caddyfile"].text;
  const rewrites = door.match(/  @rewrite_\w+ \{\n[\s\S]*?\n  \}\n  handle @rewrite_\w+ \{\n[\s\S]*?\n  \}\n/g);
  if (rewrites?.length !== 5) throw new Error("the door does not hold the five rewrites");
  return `{\n  admin off\n  auto_https off\n}\n(bounded-crud) {\n}\n:8080 {\n${rewrites.join("")}  handle {\n    respond "no rewrite" 404\n  }\n}\n`;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
async function token(role: string): Promise<string> {
  const text = new TextEncoder();
  const signed = `${base64url(text.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${base64url(text.encode(JSON.stringify({ role })))}`;
  const key = await crypto.subtle.importKey("raw", text.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${signed}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, text.encode(signed))))}`;
}

Deno.test({ name: "a rewrite answers an app path as /crud answers its destination", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const tag = crypto.randomUUID().slice(0, 8);
  const network = `rewrites-${tag}`, db = `rewrites-pg-${tag}`, rest = `rewrites-rest-${tag}`, door = `rewrites-door-${tag}`;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/Caddyfile`, await doorRewrites());
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
      CREATE ROLE anon NOLOGIN; CREATE ROLE app_user NOLOGIN;
      CREATE TABLE payment (id uuid PRIMARY KEY, status text NOT NULL, total numeric(12,2) NOT NULL);
      INSERT INTO payment VALUES ('00000000-0000-0000-0000-000000000001', 'pending', 10.50), ('00000000-0000-0000-0000-000000000002', 'settled', 2);
      CREATE VIEW payment_list AS SELECT id, status FROM payment;
      CREATE FUNCTION payment_total(id uuid) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT total FROM payment p WHERE p.id = payment_total.id $$;
      CREATE FUNCTION payment_approve() RETURNS json LANGUAGE sql AS
        $$ SELECT json_build_object('as', current_user, 'path', current_setting('request.headers', true)::json ->> 'x-rewrite-path') $$;
      CREATE TABLE note (id int PRIMARY KEY, body text NOT NULL);
      GRANT SELECT, INSERT, DELETE ON note TO app_user;
      GRANT SELECT ON payment_list, payment TO anon, app_user;
      GRANT EXECUTE ON FUNCTION payment_total(uuid), payment_approve() TO anon, app_user;`));
    await must(run("docker", ["run", "-d", "--rm", "--name", rest, "--network", network, "--network-alias", "crud",
      "-e", "PGRST_DB_URI=postgres://postgres:pw@database:5432/postgres", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${SECRET}`, pinned("postgrest/postgrest")]));
    await must(run("docker", ["run", "-d", "--rm", "--name", door, "--network", network, "-p", "127.0.0.1::8080", "-v", `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
      pinned("caddy"), "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]));
    const port = (await run("docker", ["port", door, "8080"])).out.split(":").pop();
    const ask = async (method: string, path: string, headers: Record<string, string> = {}, sent = "{}") => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: method === "POST" ? sent : undefined, headers: { "content-type": "application/json", ...headers } });
      const body = await res.text();
      return { status: res.status, body: res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(body) : body };
    };
    for (let i = 0; (await ask("GET", "/expense/payments").catch(() => ({ status: 0 }))).status !== 200; i++) {
      if (i > 120) throw new Error("the door or PostgREST did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const one = "00000000-0000-0000-0000-000000000001";

    await t.step("a view is read, with the request's own query as PostgREST's", async () => {
      assertEquals((await ask("GET", "/expense/payments")).body.length, 2);
      assertEquals(await ask("GET", "/expense/payments?status=eq.settled&select=status"), { status: 200, body: [{ status: "settled" }] });
    });
    await t.step("a path parameter is the view's filter and the function's argument", async () => {
      assertEquals(await ask("GET", `/expense/payments/${one}`), { status: 200, body: [{ id: one, status: "pending" }] });
      assertEquals(await ask("GET", `/expense/payments/${one}?select=status`), { status: 200, body: [{ status: "pending" }] });
      assertEquals(await ask("GET", `/expense/payments/${one}/total`), { status: 200, body: 10.5 });
    });
    const bearer = { authorization: `Bearer ${await token("app_user")}` };
    await t.step("the caller's credential is PostgREST's to judge, as on /crud", async () => {
      assertEquals(await ask("POST", `/expense/payments/${one}/approve`, bearer), { status: 200, body: { as: "app_user", path: `/expense/payments/${one}/approve` } });
      assertEquals((await ask("POST", `/expense/payments/${one}/approve`)).body.as, "anon");
      assertEquals((await ask("POST", `/expense/payments/${one}/approve`, { authorization: "Bearer forged" })).status, 401);
    });
    await t.step("with no methods every method is the destination's, a POST answering its row as /crud does", async () => {
      assertEquals((await ask("POST", "/expense/notes", {}, `{"id": 1, "body": "a"}`)).status, 401);
      assertEquals(await ask("POST", "/expense/notes", bearer, `{"id": 1, "body": "a"}`), { status: 201, body: [{ id: 1, body: "a" }] });
      assertEquals(await ask("GET", "/expense/notes?select=body", bearer), { status: 200, body: [{ body: "a" }] });
      assertEquals((await ask("DELETE", "/expense/notes?id=eq.1", bearer)).status, 204);
      assertEquals(await ask("GET", "/expense/notes", bearer), { status: 200, body: [] });
    });
    await t.step("what no rewrite names is not a rewrite's to answer", async () => {
      for (const [method, path] of [["POST", "/expense/payments"], ["GET", `/expense/payments/${one}/approve`], ["GET", "/expense/payments/a%26select%3Dtotal"], ["GET", "/payment"], ["GET", `/expense/payments/${one}/total/more`]]) {
        assertEquals(await ask(method, path), { status: 404, body: "no rewrite" }, `${method} ${path}`);
      }
    });
  } finally {
    for (const name of [door, rest, db]) await run("docker", ["rm", "-f", name]);
    await run("docker", ["network", "rm", network]);
    await Deno.remove(dir, { recursive: true });
  }
} });
