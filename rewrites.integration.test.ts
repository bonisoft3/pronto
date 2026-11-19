// An app's rewrites through what a container release runs: the door's emitted
// blocks, the real PostgREST and postgres. Regression rationale: a rewrite is a
// client's existing path, so it answers what /crud answers the same caller,
// credential and query included, and a parameter carries nothing but its value;
// a function is called whatever method the client used and reads what was asked
// from the two headers the door sets, never from the client's own.
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.11";
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
      "payment-settle": {source: "/expense/payments/:id", destination: "/crud/rpc/payment_echo", methods: ["PUT", "PATCH", "DELETE"]}
      "payment-search": {source: "/expense/search", destination: "/crud/rpc/payment_search", methods: ["GET", "HEAD"]}
      "payment-echo": {source: "/expense/echo", destination: "/crud/rpc/payment_echo"}
      "payment-told": {source: "/expense/told", destination: "/crud/rpc/payment_told"}
      "payment-export": {source: "/exports/pdf", methods: ["GET"], has: [{type: "query", key: "job_id", value: "(?<job_id>.+)"}, {type: "query", key: "token"}], destination: "/crud/rpc/payment_export?job_id=:job_id&token=:token"}
      "payment-kind": {source: "/exports/kind", methods: ["GET"], has: [{type: "query", key: "kind", value: "(?<kind>pdf|xlsx)-(?<year>[0-9]{4})"}], destination: "/crud/rpc/payment_export?job_id=:kind&token=:year"}
      "payment-rows-of": {source: "/exports/rows/:scope", methods: ["GET"], destination: "/crud/rpc/payment_rows?scope=:scope"}
      "payment-rows": {source: "/exports/rows", methods: ["GET"], has: [{type: "query", key: "scope"}], destination: "/crud/rpc/payment_rows?scope=:scope"}
      "payment-draft": {source: "/exports/draft", methods: ["GET"], has: [{type: "query", key: "kind", value: "(?<kind>pdf|xlsx)(?<draft>-draft)?"}], destination: "/crud/rpc/payment_export?job_id=:kind&token=:draft"}
      "payment-names": {source: "/exports/names/:token", methods: ["GET"], has: [{type: "query", key: "job_id"}, {type: "query", key: "dlToken"}], destination: "/crud/rpc/payment_export?job_id=:jobid&token=:dlToken"}
      "payment-settled": {source: "/expense/settled", methods: ["GET"], has: [{type: "query", key: "select", value: "status"}], destination: "/crud/payment_list?status=eq.settled"}
    }
    effects: charge:`);

/** The door's emitted rewrites and its own routes to PostgREST, over a stand-in for the snippet the release's Caddyfile imports. */
async function doorRewrites(): Promise<string> {
  const door = (await emitFiles(program))["docker/Caddyfile"].text;
  const own = ["crud", "signal", "blob-claim", "blobs"].map((name) => {
    const found = door.match(new RegExp(`  handle /${name}/\\* \\{\\n[\\s\\S]*?\\n  \\}\\n`))?.[0];
    if (!found) throw new Error(`the door does not answer /${name}`);
    return found;
  });
  const rewrites = door.match(/  @rewrite_\w+ \{\n[\s\S]*?\n  \}\n  handle @rewrite_\w+ \{\n[\s\S]*?\n  \}\n/g);
  if (rewrites?.length !== 16) throw new Error("the door does not hold the sixteen rewrites");
  return `{\n  admin off\n  auto_https off\n}\n(bounded-crud) {\n}\n(bounded-blobs) {\n}\n:8080 {\n${rewrites.join("")}${own.join("")}  handle {\n    respond "no rewrite" 404\n  }\n}\n`;
}

/** A request written to the socket as given, for what fetch does not send: a Connection header naming others, an absolute-form or an unnormalized target. */
async function raw(port: string | undefined, head: string, body = ""): Promise<{ status: number; body: string }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: Number(port) });
  const bytes = new TextEncoder().encode(body);
  await conn.write(new TextEncoder().encode(`${head}\r\nContent-Length: ${bytes.length}\r\n\r\n${body}`));
  const answer = await new Response(conn.readable).text();
  return { status: Number(answer.split(" ")[1]), body: answer.slice(answer.indexOf("\r\n\r\n") + 4) };
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
        $$ SELECT json_build_object('as', current_user, 'path', uri, 'id', substring(uri from '^/expense/payments/([0-9a-f-]{36})/approve([?]|$)')::uuid)
           FROM (SELECT current_setting('request.headers', true)::json ->> 'x-forwarded-uri') AS _(uri) $$;
      -- What the function was asked, and what the door says the client asked.
      CREATE FUNCTION payment_echo() RETURNS jsonb LANGUAGE sql AS $$
        SELECT jsonb_build_object('asked', current_setting('request.method', true), 'readonly', current_setting('transaction_read_only'),
          'method', h ->> 'x-forwarded-method', 'uri', h ->> 'x-forwarded-uri', 'prefer', h ->> 'prefer')
        FROM (SELECT current_setting('request.headers', true)::json) AS _(h) $$;
      -- Stand-ins for what the door's signal and claim routes call, answering what each is told.
      -- The arguments a rewrite's \`has\` gives a function, beside what the door says the client asked.
      CREATE FUNCTION payment_export(job_id text, token text) RETURNS json LANGUAGE sql STABLE AS $$
        SELECT json_build_object('job_id', job_id, 'token', token, 'method', h ->> 'x-forwarded-method', 'uri', h ->> 'x-forwarded-uri')
        FROM (SELECT current_setting('request.headers', true)::json) AS _(h) $$;
      -- An argument with a default, answered beside rows that hold a column of its name.
      CREATE FUNCTION payment_rows(scope text DEFAULT 'all') RETURNS TABLE (scope text, asked text) LANGUAGE sql STABLE AS
        $$ SELECT s, payment_rows.scope FROM unnest(ARRAY['own', 'all']) AS s $$;
      CREATE FUNCTION payment_told() RETURNS jsonb LANGUAGE sql AS $$
        SELECT jsonb_build_object('method', h ->> 'x-forwarded-method', 'uri', h ->> 'x-forwarded-uri', 'signal', h ->> 'x-signal-path', 'blob', h ->> 'x-blob-path')
        FROM (SELECT current_setting('request.headers', true)::json) AS _(h) $$;
      CREATE FUNCTION signal_in(json) RETURNS jsonb LANGUAGE sql AS $$ SELECT payment_told() $$;
      CREATE FUNCTION claim_upload() RETURNS jsonb LANGUAGE sql AS $$ SELECT payment_told() $$;
      -- The check an upload asks first, refusing with what it was told.
      CREATE FUNCTION upload_allowed(key text) RETURNS void LANGUAGE plpgsql STABLE AS $$
        BEGIN RAISE EXCEPTION '%', payment_told() USING ERRCODE = 'PT403'; END $$;
      CREATE FUNCTION payment_echo(json) RETURNS jsonb LANGUAGE sql AS $$ SELECT payment_echo() || jsonb_build_object('body', $1) $$;
      -- A repeated key, which PostgREST binds to no argument, read from the query the client sent.
      CREATE FUNCTION payment_search() RETURNS SETOF payment_list LANGUAGE sql STABLE AS $$
        SELECT * FROM payment_list WHERE status = ANY (
          SELECT split_part(pair, '=', 2)
          FROM unnest(string_to_array(substring(current_setting('request.headers', true)::json ->> 'x-forwarded-uri' from '[?](.*)$'), '&')) AS pair
          WHERE split_part(pair, '=', 1) = 'status')
        ORDER BY id $$;
      CREATE TABLE note (id int PRIMARY KEY, body text NOT NULL);
      GRANT SELECT, INSERT, UPDATE, DELETE ON note TO app_user;
      GRANT SELECT ON payment_list, payment TO anon, app_user;
      GRANT EXECUTE ON FUNCTION payment_rows(text), payment_export(text, text), payment_total(uuid), payment_approve(), payment_echo(), payment_echo(json), payment_search(), payment_told(), signal_in(json), claim_upload(), upload_allowed(text) TO anon, app_user;`));
    await must(run("docker", ["run", "-d", "--rm", "--name", rest, "--network", network, "--network-alias", "crud",
      "-e", "PGRST_DB_URI=postgres://postgres:pw@database:5432/postgres", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${SECRET}`, pinned("postgrest/postgrest")]));
    await must(run("docker", ["run", "-d", "--rm", "--name", door, "--network", network, "-p", "127.0.0.1::8080", "-v", `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
      pinned("caddy"), "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]));
    const port = (await run("docker", ["port", door, "8080"])).out.split(":").pop();
    // A POST carries `{}` unless told otherwise; any other method carries a body only when given one.
    const ask = async (method: string, path: string, headers: Record<string, string> = {}, sent: string | undefined = method === "POST" ? "{}" : undefined) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: sent, headers: { ...(sent === undefined ? {} : { "content-type": "application/json" }), ...headers } });
      const body = await res.text();
      return { status: res.status, body: body !== "" && res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(body) : body };
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
      assertEquals(await ask("POST", `/expense/payments/${one}/approve`, bearer), { status: 200, body: { as: "app_user", path: `/expense/payments/${one}/approve`, id: one } });
      assertEquals((await ask("POST", `/expense/payments/${one}/approve`)).body.as, "anon");
      assertEquals((await ask("POST", `/expense/payments/${one}/approve`, { authorization: "Bearer forged" })).status, 401);
    });
    await t.step("with no methods every method is the destination's, a POST answering its row as /crud does", async () => {
      assertEquals((await ask("POST", "/expense/notes", {}, `{"id": 1, "body": "a"}`)).status, 401);
      assertEquals(await ask("POST", "/expense/notes", bearer, `{"id": 1, "body": "a"}`), { status: 201, body: [{ id: 1, body: "a" }] });
      assertEquals(await ask("GET", "/expense/notes?select=body", bearer), { status: 200, body: [{ body: "a" }] });
      // A table answers PATCH and DELETE itself, so they reach it as they came, the request's query with them.
      assertEquals((await ask("PATCH", "/expense/notes?id=eq.1", bearer, `{"body": "b"}`)).status, 204);
      assertEquals(await ask("GET", "/expense/notes?select=body", bearer), { status: 200, body: [{ body: "b" }] });
      assertEquals((await ask("DELETE", "/expense/notes?id=eq.2", bearer)).status, 204);
      assertEquals((await ask("GET", "/expense/notes", bearer)).body.length, 1);
      assertEquals((await ask("DELETE", "/expense/notes?id=eq.1", bearer)).status, 204);
      assertEquals(await ask("GET", "/expense/notes", bearer), { status: 200, body: [] });
    });
    const prefer = "return=representation,resolution=ignore-duplicates";
    await t.step("a PUT, PATCH or DELETE calls a function as a POST, its body untouched, and the function reads the method asked", async () => {
      assertEquals(await ask("PUT", `/expense/payments/${one}`, {}, `{"status": "settled", "tags": ["a", "b"]}`),
        { status: 200, body: { asked: "POST", readonly: "off", method: "PUT", uri: `/expense/payments/${one}`, prefer, body: { status: "settled", tags: ["a", "b"] } } });
      assertEquals(await ask("PATCH", `/expense/payments/${one}?notify=1`, {}, `{"status": "settled"}`),
        { status: 200, body: { asked: "POST", readonly: "off", method: "PATCH", uri: `/expense/payments/${one}?notify=1`, prefer, body: { status: "settled" } } });
      // No body is no argument: with or without a JSON content type it calls the function that takes none.
      const deleted = { status: 200, body: { asked: "POST", readonly: "off", method: "DELETE", uri: `/expense/payments/${one}`, prefer } };
      assertEquals(await ask("DELETE", `/expense/payments/${one}`), deleted);
      assertEquals(await ask("DELETE", `/expense/payments/${one}`, { "content-type": "application/json" }), deleted);
      // `methods` is the client's method: the POST the function is called by is not one this rewrite names.
      assertEquals(await ask("POST", `/expense/payments/${one}`), { status: 404, body: "no rewrite" });
      assertEquals(await ask("DELETE", `/expense/payments/${one}/approve`), { status: 404, body: "no rewrite" });
    });
    await t.step("the forwarded headers are the door's: what a client sends in them is replaced", async () => {
      const spoofed = { "x-forwarded-method": "GET", "x-forwarded-uri": "/expense/payments/another?admin=1" };
      const echoed = await ask("DELETE", "/expense/echo?a=1", spoofed);
      assertEquals([echoed.body.method, echoed.body.uri], ["DELETE", "/expense/echo?a=1"]);
      assertEquals((await ask("POST", `/expense/payments/${one}/approve?x=y`, spoofed)).body.path, `/expense/payments/${one}/approve?x=y`);
      // Asked at /crud itself nothing was rewritten, so the function is told nothing, the client's own claim least of all.
      assertEquals(await ask("POST", "/crud/rpc/payment_echo", spoofed), { status: 200, body: { asked: "POST", readonly: "off", method: null, uri: null, prefer } });
      assertEquals(await ask("GET", "/crud/rpc/payment_echo", spoofed), { status: 200, body: { asked: "GET", readonly: "on", method: null, uri: null, prefer: null } });
    });
    await t.step("each route to PostgREST states its own header and carries no other's from the client", async () => {
      const forged = { "x-forwarded-method": "DELETE", "x-forwarded-uri": "/expense/payments/another", "x-signal-path": "/signal/forged/1", "x-blob-path": "/blob-claim/forged.jpg" };
      assertEquals((await ask("POST", "/crud/rpc/payment_told", forged)).body, { method: null, uri: null, signal: null, blob: null });
      assertEquals((await ask("POST", "/expense/told", forged)).body, { method: "POST", uri: "/expense/told", signal: null, blob: null });
      assertEquals((await ask("POST", "/signal/stripe/1", forged)).body, { method: null, uri: null, signal: "/signal/stripe/1", blob: null });
      assertEquals((await ask("POST", "/blob-claim/a.jpg", forged)).body, { method: null, uri: null, signal: null, blob: "/blob-claim/a.jpg" });
      // An upload's check is asked with forward_auth's own two, and neither path.
      const upload = await ask("PUT", "/blobs/mecha-objects/a.jpg", forged, "{}");
      assertEquals([upload.status, JSON.parse(upload.body.message)], [403, { method: "PUT", uri: "/blobs/mecha-objects/a.jpg", signal: null, blob: null }]);
    });
    // The body of a raw answer, whatever framing it came in.
    const json = (answer: { body: string }) => JSON.parse(answer.body.slice(answer.body.indexOf("{"), answer.body.lastIndexOf("}") + 1));
    await t.step("a client cannot have the door's headers dropped as hop-by-hop ones", async () => {
      const echoed = json(await raw(port, "DELETE /expense/echo?a=1 HTTP/1.1\r\nHost: door\r\nX-Forwarded-Uri: /spoofed\r\nConnection: X-Forwarded-Method, X-Forwarded-Uri, close"));
      assertEquals([echoed.method, echoed.uri], ["DELETE", "/expense/echo?a=1"]);
    });
    await t.step("the forwarded URI is the target byte for byte as sent, which the door matched cleaned and decoded", async () => {
      const told = async (method: string, target: string, body = "") => json(await raw(port, `${method} ${target} HTTP/1.1\r\nHost: door\r\nContent-Type: application/json\r\nConnection: close`, body));
      // Each of these the door matches as /expense/payments/<one>, and states as the client spelled it:
      // an absolute-form target, an escape the client did not need, a doubled slash and a dot segment,
      // whose fourth segment is another id than the one that matched.
      for (const target of [
        `http://door.example/expense/payments/${one}?notify=1`,
        `/expense/payments/%30${one.slice(1)}`,
        `//expense/payments/${one}`,
        `/expense/payments/00000000-0000-0000-0000-000000000002/../${one}`,
        `/expense/./payments/${one}?`,
      ]) assertEquals((await told("DELETE", target)).uri, target, target);
      // The query is as sent, escapes and repeated keys with it.
      assertEquals((await told("GET", "/expense/echo?q=a%20b%26c&status=1&status=2")).uri, "/expense/echo?q=a%20b%26c&status=1&status=2");
      // A function that takes its parameter by a pattern anchored on the whole target reads the
      // plain spelling, a query after it or not, and no id from any other.
      const approve = `/expense/payments/${one}/approve`;
      assertEquals((await told("POST", `${approve}?notify=1`, "{}")).id, one);
      for (const target of [`http://door.example${approve}`, `/expense/payments/%30${one.slice(1)}/approve`, `//expense/payments/${one}/approve`, `/expense/payments/00000000-0000-0000-0000-000000000002/../${one}/approve`]) {
        assertEquals(await told("POST", target, "{}"), { as: "anon", path: target, id: null }, target);
      }
    });
    await t.step("a `has` key is one argument of the function, the client's value decoded and nothing else of its query", async () => {
      const get = async (target: string) => {
        const answer = await raw(port, `GET ${target} HTTP/1.1\r\nHost: door\r\nConnection: close`);
        return answer.status === 200 ? json(answer) : answer.status;
      };
      assertEquals(await get("/exports/pdf?job_id=j1&token=t1"), { job_id: "j1", token: "t1", method: "GET", uri: "/exports/pdf?job_id=j1&token=t1" });
      // Whatever a value holds it is that one argument's, as the client wrote it and PostgREST decodes it.
      for (const [sent, got] of [
        ["x%26scope%3Dall", "x&scope=all"], ["x%26job_id%3Dother", "x&job_id=other"], ["a%3Db", "a=b"], ["a=b", "a=b"], ["a%23b", "a#b"], ["a+b", "a b"], ["a%20b", "a b"],
        ["a%2Bb", "a+b"], ["100%25", "100%"], ["%2526", "%26"], ["%C3%A9%E2%82%AC", "\u00e9\u20ac"], ["a%0Ab", "a\nb"], ["a%2Cb", "a,b"], ["a%3Fb?c", "a?b?c"],
        ["%7Bhttp.request.host%7D", "{http.request.host}"], ["{re.rewrite_payment_export_has0.job_id}", "{re.rewrite_payment_export_has0.job_id}"], ["%22%27%60%5C", "\"'`\\"],
      ]) {
        const target = `/exports/pdf?job_id=j1&token=${sent}`;
        assertEquals(await get(target), { job_id: "j1", token: got, method: "GET", uri: target }, sent);
      }
      assertEquals(await get("/exports/kind?kind=pdf-2026"), { job_id: "pdf", token: "2026", method: "GET", uri: "/exports/kind?kind=pdf-2026" });
      // A key `has` does not name reaches the function in X-Forwarded-Uri alone, wherever it stands.
      assertEquals((await get("/exports/pdf?scope=all&job_id=j1&token=x&scope=all&select=token")).token, "x");
      // A key's own parameter is named as Next.js names it, by the key's letters, its case kept and
      // a digit or a mark dropped.
      assertEquals(await get("/exports/names/path?job_id=j1&dlToken=t1"), { job_id: "j1", token: "t1", method: "GET", uri: "/exports/names/path?job_id=j1&dlToken=t1" });
      assertEquals(await get("/exports/names/path?jobid=j1&dltoken=t1"), 404);
      // A value is a regular expression's to match in full, its named groups the parameters.
      assertEquals(await get("/exports/kind?kind=xlsx-2026"), { job_id: "xlsx", token: "2026", method: "GET", uri: "/exports/kind?kind=xlsx-2026" });
      // A group that takes no part in the match is an empty value.
      assertEquals((await get("/exports/draft?kind=pdf-draft")).token, "-draft");
      assertEquals(await get("/exports/draft?kind=pdf"), { job_id: "pdf", token: "", method: "GET", uri: "/exports/draft?kind=pdf" });
      for (const target of ["/exports/kind?kind=xlsx-2026x", "/exports/kind?kind=axlsx-2026", "/exports/kind?kind=csv-2026", "/exports/kind?kind=", "/exports/kind"]) assertEquals(await get(target), 404, target);
    });
    await t.step("a value PostgREST would read as a filter on a function's answer meets no `has`", async () => {
      // The shapes are those of the PostgREST the cluster pins (pOpExpr in its QueryParams.hs), which
      // the door's expression mirrors: another version's are read from its source before this is moved.
      // When this fails PostgREST has moved. Re-read, in its src/library/PostgREST/ApiRequest/QueryParams.hs
      // at the new tag: pOpExpr, simpleOperator and quantOperator, and bring emit.cue's _rewriteOperand and
      // the operators below to what they say; `reserved`, `reservedEmbeddable` and how `parse` tells a
      // filter from a parameter, and bring schema.cue's refused keys and the keys below to those; and
      // toRpcParams in its Plan/CallPlan.hs, which takes the last of an argument named twice. Only then
      // name the new version here.
      assertEquals(pinned("postgrest/postgrest").split("@")[0], "postgrest/postgrest:v16.4");
      const get = (target: string) => raw(port, `GET ${target} HTTP/1.1\r\nHost: door\r\nConnection: close`);
      const rows = (answer: { body: string }) => JSON.parse(answer.body.slice(answer.body.indexOf("["), answer.body.lastIndexOf("]") + 1));
      // What the trap is, asked of /crud itself: the function is called by its default, and its rows are filtered.
      assertEquals(rows(await get("/crud/rpc/payment_rows?scope=own")), [{ scope: "own", asked: "own" }, { scope: "all", asked: "own" }]);
      assertEquals(rows(await get("/crud/rpc/payment_rows?scope=eq.own")), [{ scope: "own", asked: "all" }]);
      const quantified = ["eq", "gte", "gt", "lte", "lt", "like", "ilike", "match", "imatch"], simple = ["neq", "cs", "cd", "ov", "sl", "sr", "nxr", "nxl", "adj"], search = ["fts", "plfts", "phfts", "wfts"];
      const operands = [
        ...[...quantified, ...simple, ...search, "isdistinct"].map((op) => `${op}.own`),
        ...quantified.flatMap((op) => [`${op}(any).own`, `${op}(all).{own,all}`]),
        ...search.flatMap((op) => [`${op}(english).own`, `${op}(pg_catalog simple).own`]),
        "in.(own,all)", "in.(own)", "in.own", "is.null", "is.NOT_NULL", "is.true", "is.own", "eq.", "isdistinct.",
      ];
      for (const sent of [...operands, ...operands.map((o) => `not.${o}`), "not.own", "not."]) {
        const value = encodeURIComponent(sent);
        // PostgREST does not hand it to the function, by a filter or by refusing to parse it,
        const direct = await get(`/crud/rpc/payment_rows?scope=${value}`);
        assertEquals(direct.status === 200 ? rows(direct).some((r: { asked: string }) => r.asked === sent) : false, false, sent);
        // so the rewrite is not this request's.
        assertEquals(await get(`/exports/rows?scope=${value}`), { status: 404, body: "no rewrite" }, sent);
      }
      // Any other value is the argument, a dot in it or an operator's letters: at /crud and through the rewrite alike.
      for (const sent of ["own", "john.doe@x.com", "1.5", "v1.2", ".eq.own", "eq", "EQ.own", "Not.eq.own", "x.eq.own", "noteq.own", "island.own", "inside.(own)", "equal.own", "liked.own", "eq(some).own", "eq(any)own", "fts().own", "fts(a-b).own", " eq.own", "nota.eq.own"]) {
        const value = encodeURIComponent(sent), asked = [{ scope: "own", asked: sent }, { scope: "all", asked: sent }];
        assertEquals(rows(await get(`/crud/rpc/payment_rows?scope=${value}`)), asked, sent);
        assertEquals(rows(await get(`/exports/rows?scope=${value}`)), asked, sent);
      }
      // A parameter of the path is held to the same, as the door matched it, whatever the client's spelling;
      for (const segment of ["eq.own", "not.eq.own", "is.null", "in.own", "like.own", "isdistinct.own", "fts.own", "neq.own", "not.own", "%65q.own", "eq%2Eown", "x/../eq.own"]) {
        assertEquals(await get(`/exports/rows/${segment}`), { status: 404, body: "no rewrite" }, segment);
      }
      assertEquals(await get("/expense/payments/eq.1/total"), { status: 404, body: "no rewrite" });
      // and a segment with a dot, or an operator's letters, is the argument as ever.
      for (const segment of ["own", "1.5", "v1.2", "john.doe", "eq", "EQ.own", "x.eq.own", "noteq.own", "island.own", "equal.own", ".eq.own"]) {
        assertEquals(rows(await get(`/exports/rows/${segment}`)), [{ scope: "own", asked: segment }, { scope: "all", asked: segment }], segment);
      }
      // A group of a value is held to the same, being what the destination places.
      assertEquals(await get("/exports/pdf?job_id=eq.j1&token=t1"), { status: 404, body: "no rewrite" });

      // The door holds the value, and the key is the destination's: one PostgREST keeps for itself, or
      // reads as more than a name, is no argument whatever its value, so no destination places a parameter
      // under it. Asked of /crud, none of them is looked up as the function's parameter,
      const placing = (key: string) => emitFiles(program.replace(`      "payment-told":`, `      "placed": {source: "/exports/placed", methods: ["GET"], has: [{type: "query", key: "token"}], destination: "/crud/rpc/payment_rows?${key}=:token"}\n      "payment-told":`));
      const sought = (key: string) => `Searched for the function public.payment_rows with parameter ${key},`;
      for (const key of ["select", "columns", "on_conflict", "order", "limit", "offset", "and", "or", "not.and", "not.or", "rows.order", "rows.limit", "rows.offset", "rows.and", "rows.scope", "scope->a"]) {
        for (const value of ["own", "(scope.eq.own)"]) assertEquals((await get(`/crud/rpc/payment_rows?${key}=${value}`)).body.includes(sought(key)), false, key);
        await assertRejects(() => placing(key), Error, `a function's destination places :token under ${key}, which PostgREST does not read as an argument's name`);
      }
      // a logical key filtering what the function returns by its default, and a dotted one naming another argument;
      assertEquals(rows(await get("/crud/rpc/payment_rows?and=(scope.eq.own)")), [{ scope: "own", asked: "all" }]);
      assertEquals(rows(await get("/crud/rpc/payment_rows?rows.scope=own")), [{ scope: "own", asked: "own" }, { scope: "all", asked: "own" }]);
      // Of an argument named twice PostgREST takes the last, however either is written, so a destination
      // that named one again after a parameter would have its own word replace the client's.
      for (const again of ["scope=all", "%73cope=all"]) {
        assertEquals(rows(await get(`/crud/rpc/payment_rows?scope=own&${again}`)), [{ scope: "own", asked: "all" }, { scope: "all", asked: "all" }], again);
        await assertRejects(() => emitFiles(program.replace(`      "payment-told":`, `      "placed": {source: "/exports/placed", methods: ["GET"], has: [{type: "query", key: "token"}], destination: "/crud/rpc/payment_rows?scope=:token&${again}"}\n      "payment-told":`)), Error, "a function's destination");
      }
      // and any other name is the parameter PostgREST looks for.
      for (const key of ["foo", "Scope", "selects", "ordering", "andor", "_limit"]) {
        assertEquals((await get(`/crud/rpc/payment_rows?${key}=own`)).body.includes(sought(key)), true, key);
        await placing(key);
      }
    });
    await t.step("a rewrite whose `has` is not met is no rewrite: a key absent, empty, or sent more than once", async () => {
      for (const target of [
        "/exports/pdf", "/exports/pdf?job_id=j1", "/exports/pdf?token=t1", "/exports/pdf?job_id=j1&token=", "/exports/pdf?job_id=j1&token", "/exports/pdf?job_id=&token=t1",
        // Sent twice, plainly or escaped, with a value or none.
        "/exports/pdf?job_id=j1&token=a&token=b", "/exports/pdf?job_id=j1&token=a&%74oken=b", "/exports/pdf?job_id=j1&%74%6F%6B%65%6E=a&token=b", "/exports/pdf?job_id=j1&token=a&token",
        "/exports/pdf?job_id=j1&token=a&job%5Fid=j2", "/exports/pdf?token=a&job_id=j1&x=1&job_id=j2",
        // A pair the door does not read, a `;` in it or an escape that is none, is no key.
        "/exports/pdf?job_id=j1&token=a;b", "/exports/pdf?job_id=j1&token=%zz", "/exports/pdf?job_id=j1;token=t1",
      ]) {
        assertEquals(await raw(port, `GET ${target} HTTP/1.1\r\nHost: door\r\nConnection: close`), { status: 404, body: "no rewrite" }, target);
      }
      // The methods are the rewrite's as ever.
      assertEquals(await ask("POST", "/exports/pdf?job_id=j1&token=t1"), { status: 404, body: "no rewrite" });
      // A key that only begins or ends as the named one is another key.
      assertEquals((await ask("GET", "/exports/pdf?job_id=j1&token=t1&xtoken=b&token2=c&tokens")).body.token, "t1");
    });
    await t.step("`has` is a condition of a table or view's rewrite too, whose query the client's follows as ever", async () => {
      assertEquals(await ask("GET", "/expense/settled?select=status"), { status: 200, body: [{ status: "settled" }] });
      assertEquals(await ask("GET", "/expense/settled?select=id"), { status: 404, body: "no rewrite" });
      assertEquals(await ask("GET", "/expense/settled"), { status: 404, body: "no rewrite" });
    });
    await t.step("a function takes the destination's query alone and reads the client's from X-Forwarded-Uri", async () => {
      // A repeated key reaches the function whole, and binds to none of its arguments.
      assertEquals((await ask("GET", "/expense/search?status=pending&status=settled")).body.map((p: { status: string }) => p.status), ["pending", "settled"]);
      assertEquals(await ask("GET", "/expense/search?status=settled&page=2"), { status: 200, body: [{ id: "00000000-0000-0000-0000-000000000002", status: "settled" }] });
      assertEquals(await ask("GET", "/expense/search"), { status: 200, body: [] });
      // The query is all that follows the first `?`, a later one being a value's.
      assertEquals((await ask("GET", "/expense/search?ignored=?&status=settled")).body.length, 1);
      // The destination's own query is still the function's argument, whatever the client adds.
      assertEquals(await ask("GET", `/expense/payments/${one}/total?id=00000000-0000-0000-0000-000000000002&select=x`), { status: 200, body: 10.5 });
      assertEquals(await ask("POST", "/expense/echo?status=1&status=2", {}, `{"a": 1}`), { status: 200, body: { asked: "POST", readonly: "off", method: "POST", uri: "/expense/echo?status=1&status=2", prefer, body: { a: 1 } } });
    });
    await t.step("a GET or HEAD of a function stays one, in PostgREST's read-only transaction, and OPTIONS is PostgREST's to answer", async () => {
      assertEquals(await ask("GET", "/expense/echo?a=1"), { status: 200, body: { asked: "GET", readonly: "on", method: "GET", uri: "/expense/echo?a=1", prefer: null } });
      assertEquals(await ask("HEAD", "/expense/search?status=settled"), { status: 200, body: "" });
      assertEquals(await ask("HEAD", "/expense/echo"), { status: 200, body: "" });
      const options = await fetch(`http://127.0.0.1:${port}/expense/echo`, { method: "OPTIONS" });
      await options.body?.cancel();
      assertEquals([options.status, options.headers.get("allow")], [200, "OPTIONS,POST"]);
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
