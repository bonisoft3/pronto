// A declared token role end to end: Hydra (HYDRA_BIN, or `hydra` on the path)
// issues a client credentials token whose role the broker's token hook takes
// from the client's registration; the door's emitted rewrite hands it to the
// real PostgREST, verifying by the key set trusted-keys.ts composes, over
// postgres holding the emitted roles and mecha's tenancy floor. Regression
// rationale: the role a token names is the operator's, never the caller's;
// a token is crud's only if the issuer signed it for crud's audience; and a
// function granted to the role alone refuses everyone else.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";
import { keySet } from "./trusted-keys.ts";
import { front } from "./identity/hydra/front.ts";

/** The issuer every token the stack signs names (mecha's services/database/rls/issuer.ts). */
const STACK_ISSUER = "mecha:stack";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const SECRET = "a-secret-of-at-least-thirty-two-characters";
const AUDIENCE = "https://expense.example/crud";
const HOOK = "h".repeat(40);
const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
const floor = await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url));
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
const freePort = () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
};

const program = paymentProgram().replace("    effects: charge:", `    tokenRoles: residual_bot: note: "the expense automation, which derives an advance payment's residual"
    rewrites: {
      "advance-residual": {source: "/expense/advance-payment/:id/residual", destination: "/crud/rpc/advance_residual", methods: ["POST"]}
      "advance-list": {source: "/expense/advance-payments", destination: "/crud/advance_payment", methods: ["GET"]}
    }
    effects: charge:`).replace("targets: []", `targets: ["docker"]`).replace("capabilities: {hatches: {}", `capabilities: {auth: {required: false, service: "/auth"}, hatches: {}`);

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const text = new TextEncoder();
const part = (v: unknown) => b64u(text.encode(JSON.stringify(v)));
const claimsOf = (token: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))));
async function hs256(claims: unknown, key = SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const signed = `${part(header)}.${part(claims)}`;
  const k = await crypto.subtle.importKey("raw", text.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${signed}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, text.encode(signed))))}`;
}

Deno.test({ name: "a client calls the function its declared role alone may execute, with a token only the operator's registration names", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const files = await emitFiles(program);
  const door = files["docker/Caddyfile"].text;
  const blocks = door.match(/  @rewrite_\w+ \{\n[\s\S]*?\n  \}\n  handle @rewrite_\w+ \{\n[\s\S]*?\n  \}\n/g);
  if (blocks?.length !== 2) throw new Error("the door does not hold the two rewrites");

  const tag = crypto.randomUUID().slice(0, 8);
  const network = `services-${tag}`, db = `services-pg-${tag}`, rest = `services-rest-${tag}`, gate = `services-door-${tag}`;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/Caddyfile`, `{\n  admin off\n  auto_https off\n}\n(bounded-crud) {\n}\n:8080 {\n${blocks.join("")}  handle {\n    respond "no rewrite" 404\n  }\n}\n`);
  const psql = (sql: string) => run("docker", ["exec", "-i", db, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-h", "127.0.0.1"], sql);
  const must = async (r: Promise<{ ok: boolean; err: string }>) => {
    const done = await r;
    if (!done.ok) throw new Error(done.err);
  };

  // The issuer: Hydra asking the broker's front for a client's role.
  const publicPort = freePort(), adminPort = freePort(), frontPort = freePort();
  const issuer = `http://127.0.0.1:${frontPort}`;
  const hydra = new Deno.Command(Deno.env.get("HYDRA_BIN") ?? "hydra", {
    args: ["serve", "all", "--dev"],
    env: {
      DSN: "memory", SECRETS_SYSTEM: "t".repeat(40), LOG_LEVEL: "fatal", URLS_SELF_ISSUER: issuer,
      SERVE_PUBLIC_HOST: "127.0.0.1", SERVE_PUBLIC_PORT: String(publicPort), SERVE_ADMIN_HOST: "127.0.0.1", SERVE_ADMIN_PORT: String(adminPort),
      OAUTH2_TOKEN_HOOK_URL: `${issuer}/hooks/token`, OAUTH2_TOKEN_HOOK_AUTH_TYPE: "api_key", OAUTH2_TOKEN_HOOK_AUTH_CONFIG_IN: "header",
      OAUTH2_TOKEN_HOOK_AUTH_CONFIG_NAME: "Authorization", OAUTH2_TOKEN_HOOK_AUTH_CONFIG_VALUE: `Bearer ${HOOK}`,
      OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS: "role", OAUTH2_MIRROR_TOP_LEVEL_CLAIMS: "false",
    },
    stdout: "null", stderr: "inherit",
  }).spawn();
  const broker = Deno.serve({ port: frontPort, hostname: "127.0.0.1", onListen() {} }, await front({
    issuer, secret: "s".repeat(40), providers: [], hookSecret: HOOK,
    hydra: { public: `http://127.0.0.1:${publicPort}`, admin: `http://127.0.0.1:${adminPort}` },
  }));
  const register = async (id: string, audience: string, metadata: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${adminPort}/admin/clients`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: id, client_secret: `${id}-secret-of-some-length`, grant_types: ["client_credentials"], access_token_strategy: "jwt", audience: [audience], metadata }),
    });
    if (res.status !== 201) throw new Error(`register ${id}: ${res.status} ${await res.text()}`);
    await res.body?.cancel();
  };
  const tokenOf = async (id: string, audience: string, extra: Record<string, string> = {}) => {
    const res = await fetch(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${id}:${id}-secret-of-some-length`)}` },
      body: new URLSearchParams({ grant_type: "client_credentials", audience, ...extra }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`token ${id}: ${res.status} ${JSON.stringify(body)}`);
    return body.access_token as string;
  };

  try {
    for (let i = 0; !(await fetch(`${issuer}/health`).then(async (r) => (await r.body?.cancel(), r.ok), () => false)); i++) {
      if (i > 120) throw new Error("hydra never became ready");
      await new Promise((r) => setTimeout(r, 250));
    }
    // A first token makes Hydra generate the key it signs with, so the set
    // crud starts with holds it.
    await register("warmup", AUDIENCE);
    await tokenOf("warmup", AUDIENCE);
    const published = await (await fetch(`${issuer}/.well-known/jwks.json`)).text();
    // A second issuer crud trusts, which writes whatever role it likes: the
    // floor, not the issuer, keeps it to the declared roles.
    const outside = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const { n, e } = await crypto.subtle.exportKey("jwk", outside.publicKey);
    const trusted = JSON.stringify({ keys: [...JSON.parse(published).keys, { kty: "RSA", kid: "outside", alg: "RS256", use: "sig", n, e }] });
    const fromOutside = async (claims: Record<string, unknown>) => {
      const signed = `${part({ alg: "RS256", typ: "JWT", kid: "outside" })}.${part({ iss: "https://outside.example", aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
      return `${signed}.${b64u(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", outside.privateKey, text.encode(signed))))}`;
    };

    await must(run("docker", ["network", "create", network]));
    await must(run("docker", ["run", "-d", "--rm", "--name", db, "--network", network, "--network-alias", "database", "-e", "POSTGRES_PASSWORD=pw", POSTGRES]));
    for (let i = 0; !(await run("docker", ["exec", db, "pg_isready", "-qh", "127.0.0.1", "-U", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    // A database initdb built before the role was declared: the role
    // reaches it as every release reaches it, by the cluster's reconcile.
    const before = await emitFiles(program.replace(/    tokenRoles: residual_bot: note: .*\n/, ""));
    if (before["services/database/migrations/001_roles.sql"].text.includes("residual_bot")) throw new Error("the earlier program declares the role");
    await must(psql(before["services/database/migrations/001_roles.sql"].text));
    await must(psql(`CREATE TABLE advance_payment (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric(12,2) NOT NULL, parent_id uuid REFERENCES advance_payment(id));`));
    await must(psql(before["services/database/migrations/002_grants.sql"].text));
    await must(psql(floor));
    // What every release restates, twice: the second over a database that holds it.
    const reconcile = await new Deno.Command("cue", { args: ["export", "-", "-e", "_cluster.state.reconcile.roles", "--out", "text"], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    const w = reconcile.stdin.getWriter();
    await w.write(text.encode(program));
    await w.close();
    const restated = new TextDecoder().decode((await reconcile.output()).stdout);
    if (!restated.includes("residual_bot")) throw new Error("no reconcile for the declared roles");
    await must(psql(restated));
    await must(psql(restated));
    // The app's own SQL: the residual is the role's to create, and the
    // function, owned by the migration role, is how; nobody else executes it.
    await must(psql(`
      ALTER ROLE authenticator PASSWORD 'auth-pw';
      INSERT INTO advance_payment (id, amount) VALUES ('00000000-0000-0000-0000-000000000001', 100);
      CREATE FUNCTION advance_residual() RETURNS json LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
        INSERT INTO advance_payment (amount, parent_id)
        SELECT p.amount / 2, p.id FROM advance_payment p
        WHERE p.id = split_part(current_setting('request.headers', true)::json ->> 'x-rewrite-path', '/', 4)::uuid
        RETURNING json_build_object('parent', parent_id, 'amount', amount, 'by', current_setting('request.jwt.claims', true)::json ->> 'sub')
      $$;
      REVOKE EXECUTE ON FUNCTION advance_residual() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION advance_residual() TO residual_bot;
      CREATE ROLE other_bot NOLOGIN;`));
    await must(run("docker", ["run", "-d", "--rm", "--name", rest, "--network", network, "--network-alias", "crud",
      "-e", "PGRST_DB_URI=postgres://authenticator:auth-pw@database:5432/postgres", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", "PGRST_DB_PRE_REQUEST=public.app_pre_request",
      "-e", `PGRST_JWT_SECRET=${keySet(SECRET, trusted)}`, "-e", `PGRST_JWT_AUD=${AUDIENCE}`, pinned("postgrest/postgrest")]));
    await must(run("docker", ["run", "-d", "--rm", "--name", gate, "--network", network, "-p", "127.0.0.1::8080", "-v", `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
      pinned("caddy"), "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]));
    const port = (await run("docker", ["port", gate, "8080"])).out.split(":").pop();
    const residual = async (token?: string, id = "00000000-0000-0000-0000-000000000001") => {
      const res = await fetch(`http://127.0.0.1:${port}/expense/advance-payment/${id}/residual`, {
        method: "POST", body: "{}", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      const body = await res.text();
      return { status: res.status, body: body.startsWith("{") || body.startsWith("[") ? JSON.parse(body) : body };
    };
    for (let i = 0; (await residual().catch(() => ({ status: 0 }))).status !== 401; i++) {
      if (i > 120) throw new Error("the door or PostgREST did not start");
      await new Promise((r) => setTimeout(r, 500));
    }

    await register("residual_bot", AUDIENCE, { role: "residual_bot" });
    const bot = await tokenOf("residual_bot", AUDIENCE);

    await t.step("the client's token runs the function its role may execute, as its role", async () => {
      assertEquals(await residual(bot), { status: 200, body: { parent: "00000000-0000-0000-0000-000000000001", amount: 50, by: "residual_bot" } });
    });
    await t.step("the role reaches nothing the app did not grant it", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/expense/advance-payments`, { headers: { authorization: `Bearer ${bot}` } });
      assertEquals([res.status, (await res.json()).code], [403, "42501"]);
    });
    await t.step("the same function refuses a signed-in person and anon", async () => {
      const person = await hs256({ iss: STACK_ISSUER, role: "app_user", sub: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 });
      const asPerson = await residual(person);
      assertEquals([asPerson.status, asPerson.body.code], [403, "42501"]);
      const asAnon = await residual();
      assertEquals([asAnon.status, asAnon.body.code], [401, "42501"]);
    });
    await t.step("a token forged, unsigned, altered or signed with the issuer's public key as a secret is refused", async () => {
      const claims = claimsOf(bot);
      const header = JSON.parse(atob(bot.split(".")[0].replaceAll("-", "+").replaceAll("_", "/")));
      // Another RSA key under the issuer's kid.
      const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
      const forgedBody = `${part(header)}.${part({ ...claims, role: "service" })}`;
      const forged = `${forgedBody}.${b64u(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, text.encode(forgedBody))))}`;
      const altered = `${bot.split(".")[0]}.${part({ ...claims, role: "service" })}.${bot.split(".")[2]}`;
      const unsigned = `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`;
      const issuerKey = JSON.parse(published).keys.find((k: { kid: string }) => k.kid === header.kid);
      const confused = await hs256(claims, JSON.stringify(issuerKey), { alg: "HS256", typ: "JWT", kid: header.kid });
      for (const [name, token] of [["forged", forged], ["altered", altered], ["unsigned", unsigned], ["confused", confused]]) {
        assertEquals((await residual(token)).status, 401, name);
      }
    });
    await t.step("a token for another audience is refused, though the issuer signed it with the same role", async () => {
      await register("elsewhere_bot", "https://other.example/crud", { role: "residual_bot" });
      const res = await residual(await tokenOf("elsewhere_bot", "https://other.example/crud"));
      assertEquals([res.status, res.body.message], [401, "JWT not in audience"]);
    });
    await t.step("a client cannot obtain a role it was not registered with", async () => {
      // Asked for in the request: the token names the registration's role, or none.
      assertEquals(claimsOf(await tokenOf("residual_bot", AUDIENCE, { role: "service" })).role, "residual_bot");
      await register("plain_bot", AUDIENCE);
      const plain = await tokenOf("plain_bot", AUDIENCE, { role: "residual_bot" });
      assertEquals(claimsOf(plain).role, undefined);
      assertEquals((await residual(plain)).status, 401, "no role is anon's");
      // A role the program did not declare is no token role of PostgREST's login.
      await register("other_bot", AUDIENCE, { role: "other_bot" });
      const other = await residual(await tokenOf("other_bot", AUDIENCE));
      assertEquals(other.status >= 400, true, JSON.stringify(other.body));
      assertEquals(other.status === 200, false);
    });
    await t.step("an issuer's token acts as a declared role alone, and the stack's own tokens, naming the stack's issuer, as before", async () => {
      const list = async (token: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/expense/advance-payments?select=id&limit=1`, { headers: { authorization: `Bearer ${token}` } });
        return { status: res.status, body: await res.json() };
      };
      for (const role of ["service", "app_user", "authenticator", "postgres"]) {
        const refused = await list(await fromOutside({ role, sub: "bot" }));
        assertEquals(refused.status >= 400, true, role);
        // The cluster's own roles reach the floor, which refuses them; the
        // others are no role PostgREST's login may switch to at all.
        if (role === "service" || role === "app_user") assertEquals([refused.status, refused.body.code], [403, "42501"], role);
      }
      assertEquals((await residual(await fromOutside({ role: "service", sub: "bot" }))).status, 403);
      assertEquals((await residual(await fromOutside({ role: "residual_bot", sub: "bot" }))).status, 200);
      // An outside issuer leaving its own issuer out reaches no role but anon;
      // naming the stack's, it reaches no declared role.
      assertEquals((await list(await fromOutside({ iss: undefined, role: "service", sub: "bot" }))).status, 403);
      assertEquals((await residual(await fromOutside({ iss: STACK_ISSUER, role: "residual_bot", sub: "bot" }))).status, 403);
      const exp = Math.floor(Date.now() / 1000) + 600;
      assertEquals((await list(await hs256({ iss: STACK_ISSUER, role: "service", sub: "00000000-0000-0000-0000-000000000000", exp }))).status, 200);
      assertEquals((await list(await hs256({ iss: STACK_ISSUER, role: "app_user", sub: crypto.randomUUID(), guest: true, exp }))).status, 200);
      // The stack's own token from before it named its issuer acts as anon
      // alone, now that the app trusts another issuer.
      assertEquals((await list(await hs256({ role: "service", sub: "00000000-0000-0000-0000-000000000000", exp }))).status, 403);
    });
  } finally {
    for (const name of [gate, rest, db]) await run("docker", ["rm", "-f", name]);
    await run("docker", ["network", "rm", network]);
    await Deno.remove(dir, { recursive: true });
    hydra.kill();
    await hydra.status;
    await broker.shutdown();
  }
} });
