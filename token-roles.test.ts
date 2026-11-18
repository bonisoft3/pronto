// A token role as the program declares it: a Postgres role a token names,
// granted to PostgREST's login and holding nothing of its own, and crud
// verifying an issuer's token by the release's keys for its own audience alone.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const served = (roles: string, targets = "[]") =>
  paymentProgram().replace("    effects: charge:", `    tokenRoles: ${roles}\n    effects: charge:`).replace("targets: []", `targets: ${targets}`);

async function refusal(program: string): Promise<string> {
  const res = await cue(["vet", "-c", "-"], `${program}\n_whole: pronto.#emit & {code: app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}\n`);
  assertEquals(res.success, false);
  return res.stderr;
}

const residual = `{residual_bot: {note: "the expense automation, which creates an advance payment's residual"}}`;

Deno.test("a declared token role is a role a token names, which holds nothing but what the app grants it", async () => {
  const files = await emitFiles(served(residual, `["docker", "k8s"]`));
  const roles = files["services/database/migrations/001_roles.sql"].text;
  assertStringIncludes(roles, `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'residual_bot') THEN
    CREATE ROLE "residual_bot" NOLOGIN;
  ELSIF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'residual_bot' AND (r.rolsuper OR r.rolbypassrls OR r.rolcanlogin OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.oid = (SELECT datdba FROM pg_database WHERE datname = current_database()))) THEN
    RAISE EXCEPTION`);
  // PostgREST switches only to a role granted its login, and applies the
  // bounds of one granted it. The fork's 001 restates both idempotently: a
  // loop granting each role (SET only, no INHERIT) and a row of the bounds'
  // VALUES list per role.
  assertStringIncludes(roles, `FOREACH r IN ARRAY ARRAY['anon', 'service', 'residual_bot'] LOOP`);
  assertStringIncludes(roles, `EXECUTE format('GRANT %I TO authenticator WITH INHERIT FALSE, SET TRUE', r);`);
  assertStringIncludes(roles, `('residual_bot', 'statement_timeout', '5s'),`);
  assertStringIncludes(roles, `('residual_bot', 'lock_timeout', '2s'),`);
  assertStringIncludes(roles, `('residual_bot', 'idle_in_transaction_session_timeout', '10s')`);
  // It bypasses nothing: no attribute but NOLOGIN, no grant of any kind.
  assertEquals(/ALTER ROLE "residual_bot" /.test(roles), false);
  for (const [name, f] of Object.entries(files)) {
    if (!name.endsWith(".sql") || name.endsWith("001_roles.sql")) continue;
    assertEquals((f.text ?? JSON.stringify(f.data)).includes("residual_bot"), false, name);
  }
  // A database initdb already built gets them on the next release: the
  // cluster's `roles` reconcile, which the migrate step runs ahead of its
  // ledger, so a migration may grant one.
  const reconciled = await cue(["export", "-", "-e", "_cluster.state.reconcile.roles", "--out", "text"], served(residual, `["docker", "k8s"]`));
  if (!reconciled.success) throw new Error(reconciled.stderr);
  assertStringIncludes(reconciled.stdout, `    CREATE ROLE "residual_bot" NOLOGIN;\n`);
  assertStringIncludes(reconciled.stdout, `GRANT "residual_bot" TO authenticator;\n`);
  assertStringIncludes(reconciled.stdout, `ALTER ROLE "residual_bot" SET statement_timeout`);
  // An outside issuer's token acts as a declared role alone: the floor that
  // says so is restated first, and the list follows the declaration.
  assertEquals(reconciled.stdout.indexOf("CREATE OR REPLACE FUNCTION public.app_pre_request()") < reconciled.stdout.indexOf("CREATE ROLE"), true);
  assertStringIncludes(reconciled.stdout, "INSERT INTO mecha.token_role VALUES ('residual_bot') ON CONFLICT DO NOTHING;\nDELETE FROM mecha.token_role WHERE role_name NOT IN ('residual_bot');\n");
  // A release reads the roles, the program's own among them, from the cluster's facts.
  const facts = files[".pronto/cluster.json"].data;
  assertEquals(facts.tokenRoles, ["anon", "service", "residual_bot"]);
  assertEquals(facts.declaredRoles, ["residual_bot"]);
  // A name that is a keyword is a role all the same.
  const keyword = (await emitFiles(served(`{select: {note: "x"}}`)))["services/database/migrations/001_roles.sql"].text;
  assertStringIncludes(keyword, `CREATE ROLE "select" NOLOGIN;`);
  assertStringIncludes(keyword, `('select', 'lock_timeout', '2s'),`);
});

Deno.test("the roles reconcile restates the floor and the list in the app's own schemas", async () => {
  const program = served(residual, `["docker", "k8s"]`) + "\napp: meta: schemas: {app: \"shop\", floor: \"lists\", mecha: \"mlists\"}\n";
  const reconciled = await cue(["export", "-", "-e", "_cluster.state.reconcile.roles", "--out", "text"], program);
  if (!reconciled.success) throw new Error(reconciled.stderr);
  const sql = reconciled.stdout;
  // The floor is mecha's #Tenancy for these schemas, and the list is the configured one's.
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION lists.app_pre_request()");
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS mlists.token_role");
  assertStringIncludes(sql, "INSERT INTO mlists.token_role VALUES ('residual_bot') ON CONFLICT DO NOTHING;\nDELETE FROM mlists.token_role WHERE role_name NOT IN ('residual_bot');\n");
  assertEquals(sql.includes("public.app_pre_request"), false);
  assertEquals(/(?<![a-z_])mecha\.token_role/.test(sql), false);
  assertEquals(/(?<![a-z_])public\.token_role/.test(sql), false);
});

Deno.test("crud verifies an issuer's token by the release's key set and for its own audience alone", async () => {
  const res = await cue(["export", "-", "-e", "_cluster.surface.targets.crud.entrypoint.env", "--out", "json"], served(residual, `["docker"]`));
  if (!res.success) throw new Error(res.stderr);
  const env = JSON.parse(res.stdout);
  assertEquals(env.PGRST_JWT_SECRET, "${PGRST_JWKS:-${PGRST_JWT_SECRET:-mecha-dev-secret-please-override-32ch}}");
  assertStringIncludes(env.PGRST_JWT_AUD, "${TRUSTED_AUDIENCE:-${ORIGIN:-");
  assertEquals(env.PGRST_JWT_AUD.endsWith("}/crud}"), true, env.PGRST_JWT_AUD);
  // An app declaring no role keeps its crud as it was.
  const plain = await cue(["export", "-", "-e", "_cluster.surface.targets.crud.entrypoint.env", "--out", "json"], paymentProgram());
  const before = JSON.parse(plain.stdout);
  assertEquals(before.PGRST_JWT_AUD, undefined);
  assertEquals(before.PGRST_JWT_SECRET, "${PGRST_JWT_SECRET:-mecha-dev-secret-please-override-32ch}");
});

Deno.test("a token role named as one the cluster or Postgres holds, or on a target without roles, is refused", async () => {
  for (const [roles, targets, error] of [
    [`{service: {note: "x"}}`, "[]", `state.tokenRoles.service: field not allowed`],
    [`{app_user: {note: "x"}}`, "[]", `state.tokenRoles.app_user: field not allowed`],
    [`{authenticator: {note: "x"}}`, "[]", `state.tokenRoles.authenticator: field not allowed`],
    [`{postgres: {note: "x"}}`, "[]", `state.tokenRoles.postgres: field not allowed`],
    [`{pg_monitor: {note: "x"}}`, "[]", `state.tokenRoles.pg_monitor: field not allowed`],
    [`{"Bot": {note: "x"}}`, "[]", `state.tokenRoles.Bot: field not allowed`],
    [`{bot: {}}`, "[]", `state.tokenRoles.bot.note: incomplete value`],
    [`{bot: {note: "x", bypassRls: true}}`, "[]", `state.tokenRoles.bot.bypassRls: field not allowed`],
    [residual, `["cloudflare"]`, "tokenRoles: the cloudflare target has no role a token may switch to"],
    [residual, `["pages"]`, "tokenRoles: the pages target has no role a token may switch to"],
  ]) assertStringIncludes(await refusal(served(roles, targets)), error, `${roles} on ${targets}`);
});

Deno.test("crud's key set is the stack's secret beside the issuer's public keys, and nothing an issuer keeps", async () => {
  const { keySet } = await import("./trusted-keys.ts");
  const secret = "a-secret-of-at-least-thirty-two-characters";
  const rsa = { kty: "RSA", kid: "k1", use: "sig", alg: "RS256", n: "AQAB-n", e: "AQAB", x5c: ["cert"] };
  const set = JSON.parse(keySet(secret, JSON.stringify({ keys: [rsa, { kty: "EC", kid: "k2", crv: "P-256", x: "x", y: "y" }] })));
  assertEquals(set.keys[0], { kty: "oct", alg: "HS256", k: btoa(secret).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") });
  assertEquals(set.keys[1], { kty: "RSA", kid: "k1", use: "sig", alg: "RS256", n: "AQAB-n", e: "AQAB" });
  assertEquals(set.keys[2], { kty: "EC", kid: "k2", crv: "P-256", x: "x", y: "y" });
  // A kid is the issuer's to spell.
  assertEquals(JSON.parse(keySet(secret, JSON.stringify({ keys: [{ ...rsa, kid: "#rotation-1" }] }))).keys[1].kid, "#rotation-1");
  for (const [keys, error] of [
    [[{ ...rsa, d: "private" }], "holds a private part (d)"],
    [[{ kty: "oct", kid: "k3", k: "c2VjcmV0" }], "holds a private part (k)"],
    [[{ kty: "oct", kid: "k3" }], "is a oct key"],
    [[{ ...rsa, kid: undefined }], "has no kid"],
    [[rsa, rsa], "names key k1 twice"],
    [[{ ...rsa, use: "enc" }], "is for enc"],
    [[{ ...rsa, use: undefined, alg: undefined, key_ops: ["encrypt", "wrapKey"] }], "not verifying signatures"],
    [[{ ...rsa, alg: "HS256" }], "names HS256"],
    [[{ ...rsa, alg: "none" }], "names none"],
    [[], "holds no keys"],
    [[{ ...rsa, kid: "" }], "has no kid"],
  ] as const) {
    let thrown = "";
    try {
      keySet(secret, JSON.stringify({ keys }));
    } catch (e) {
      thrown = (e as Error).message;
    }
    assertStringIncludes(thrown, error, JSON.stringify(keys));
  }
  let short = "";
  try {
    keySet("short", JSON.stringify({ keys: [rsa] }));
  } catch (e) {
    short = (e as Error).message;
  }
  assertStringIncludes(short, "at least 32 characters");
});

Deno.test("a release trusts no issuer that names itself as the stack does", async () => {
  const { STACK_ISSUER, trustedIssuer } = await import("./trusted-keys.ts");
  const jwt = await Deno.readTextFile(new URL("../../libraries/mecha/services/auth/jwt.ts", import.meta.url));
  assertEquals(jwt.match(/export const STACK_ISSUER = "([^"]+)"/)?.[1], STACK_ISSUER, "the auth service's");
  const rls = await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url));
  assertStringIncludes(rls, `RETURN '${STACK_ISSUER}';`);
  assertEquals(trustedIssuer(" https://id.example "), "https://id.example");
  for (const [issuer, why] of [[STACK_ISSUER, "the issuer the stack's own tokens name"], ["", "TRUSTED_ISSUER is required"]]) {
    let thrown = "";
    try {
      trustedIssuer(issuer);
    } catch (e) {
      thrown = (e as Error).message;
    }
    assertStringIncludes(thrown, why);
  }
});

Deno.test("a dev token names a declared role, signed with the development secret alone", async () => {
  const { DEV_SECRET, devToken } = await import("./dev-token.ts");
  const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
  assertEquals(cluster.match(/^_devJwtSecret: "([^"]+)"$/m)?.[1], DEV_SECRET, "mecha's development secret");
  const token = await devToken("residual_bot", ["residual_bot"], "https://app.example/crud", DEV_SECRET, 0);
  const [head, body, sig] = token.split(".");
  const claims = JSON.parse(atob(body.replaceAll("-", "+").replaceAll("_", "/")));
  // An issuer other than the stack's, and crud's audience: what the floor asks of a declared role.
  assertEquals(claims, { iss: "mecha:dev-token", aud: "https://app.example/crud", role: "residual_bot", sub: "residual_bot", exp: 3600 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DEV_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const raw = Uint8Array.from(atob(sig.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  assertEquals(await crypto.subtle.verify("HMAC", key, raw, new TextEncoder().encode(`${head}.${body}`)), true);
  for (const [role, declared, secret, error] of [
    ["service", ["residual_bot"], DEV_SECRET, "service is no token role the app declares"],
    ["residual_bot", [], DEV_SECRET, "residual_bot is no token role the app declares"],
    ["residual_bot", ["residual_bot"], "a-release-secret-of-at-least-32-characters", "not the development secret"],
  ] as const) {
    let thrown = "";
    try {
      await devToken(role, declared, "https://app.example/crud", secret);
    } catch (e) {
      thrown = (e as Error).message;
    }
    assertStringIncludes(thrown, error, role);
  }
});
