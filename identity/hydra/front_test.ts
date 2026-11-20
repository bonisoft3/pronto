// The broker on Hydra end to end: a Hydra this test starts (HYDRA_BIN, or
// `hydra` on the path), the front, and a fake Google. A tenant nobody
// registered signs a person in and receives a Hydra ID token only it accepts,
// whose subject is the one the broker always gave; the same person is a
// stranger to a second tenant; and a sign-in never leaves for a redirect that
// is not the tenant's.
import { base64url, type Jwk, randomToken, sha256url, verifyIdToken } from "../oidc.ts";
import { pairwiseKey, pairwiseSubject, tenantTrustKey, tenantTxtHost, tenantTxtValue } from "../broker/core.ts";
import type { Provider } from "../broker/main.ts";
import { front } from "./front.ts";

function assertEquals(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const enc = new TextEncoder();
const SECRET = "s".repeat(40);
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const googleJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "g1" };
const pending = new Map<string, { nonce: string; sub: string; redirect: string; scope: string }>();
let nextWho = "alice";
const fakeGoogle = async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/auth") {
    const code = crypto.randomUUID();
    pending.set(code, {
      nonce: url.searchParams.get("nonce")!,
      sub: nextWho,
      redirect: url.searchParams.get("redirect_uri")!,
      scope: url.searchParams.get("scope") ?? "openid",
    });
    const to = new URL(url.searchParams.get("redirect_uri")!);
    to.searchParams.set("code", code);
    to.searchParams.set("state", url.searchParams.get("state")!);
    return Response.redirect(to.toString(), 302);
  }
  if (url.pathname === "/token") {
    const f = new URLSearchParams(await req.text());
    const c = pending.get(f.get("code") ?? "");
    pending.delete(f.get("code") ?? "");
    if (!c || f.get("client_secret") !== "op-secret" || f.get("redirect_uri") !== c.redirect) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const scopes = c.scope.split(/\s+/);
    const head = base64url(enc.encode(JSON.stringify({ alg: "RS256", kid: "g1" })));
    const body = base64url(enc.encode(JSON.stringify({
      iss: "https://accounts.google.com",
      aud: "op-client",
      sub: c.sub,
      nonce: c.nonce,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...(scopes.includes("profile") ? { name: "Alice Example", picture: "https://lh3.googleusercontent.com/a/alice" } : {}),
      ...(scopes.includes("email") ? { email: "Alice@Example.test", email_verified: true } : {}),
    })));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, enc.encode(`${head}.${body}`)));
    return Response.json({ id_token: `${head}.${body}.${base64url(sig)}` });
  }
  return new Response("not found", { status: 404 });
};

const freePort = () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
};

// Set by the test that owns Hydra, the front and the fake Google.
let ISSUER = "";
const keys = async (kid: string) => ((await (await fetch(`${ISSUER}/.well-known/jwks.json`)).json()).keys as Jwk[]).find((k) => k.kid === kid);

/** A browser: follows the broker's own redirects with its cookies, and stops
 * at a page, at a provider, or on leaving for any other origin. */
async function browse(start: string, jar = new Map<string, string>()): Promise<{ res: Response; at: string; jar: Map<string, string> }> {
  let at = start;
  for (let hops = 0; hops < 12; hops++) {
    const res = await fetch(at, { redirect: "manual", headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const to = res.headers.get("location");
    if (to === null || new URL(to, at).origin !== ISSUER) return { res, at: to === null ? at : new URL(to, at).toString(), jar };
    await res.body?.cancel();
    at = new URL(to, at).toString();
  }
  throw new Error("too many redirects");
}

/** One sign-in as `tenant`, Google's user `who`, returning where the browser landed. */
async function signIn(tenant: string, who: string, over: Record<string, string> = {}) {
  const verifier = randomToken(32);
  const q = new URLSearchParams({
    client_id: tenant, redirect_uri: `${tenant}/auth/oidc/google/callback`, response_type: "code", scope: "openid",
    state: randomToken(8), nonce: randomToken(8), provider: "google", code_challenge: await sha256url(verifier), code_challenge_method: "S256", ...over,
  });
  const shown = await browse(`${ISSUER}/oauth2/auth?${q}`);
  if (shown.res.status !== 200 || shown.res.headers.get("location") !== null) return { shown };
  const html = await shown.res.text();
  const go = html.match(/href="([^"]+\/login\/continue[^"]+)"/)?.[1].replace(/&#38;/g, "&");
  if (!go) return { shown, html };
  nextWho = who;
  const toGoogle = await browse(go, shown.jar);
  const hop = await fetch(toGoogle.at, { redirect: "manual" });
  await hop.body?.cancel();
  const back = await browse(hop.headers.get("location")!, shown.jar);
  await back.res.body?.cancel();
  return { html, landed: new URL(back.at), verifier, q };
}

async function redeem(tenant: string, code: string, verifier: string) {
  const res = await fetch(`${ISSUER}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: tenant, redirect_uri: `${tenant}/auth/oidc/google/callback`, code_verifier: verifier }),
  });
  return { status: res.status, body: await res.json() };
}

const subOf = async (tenant: string, who: string) => {
  const s = await signIn(tenant, who);
  const t = await redeem(tenant, s.landed!.searchParams.get("code")!, s.verifier!);
  return (await verifyIdToken(t.body.id_token, { alg: "RS256", issuers: [ISSUER], audience: tenant, nonce: s.q!.get("nonce")!, keys })).sub;
};

const A = "https://app-a.example", B = "https://app-b.example", TRUSTED = "https://iris.cleaning";
const txtRecords = new Map<string, string[]>();
const cases: [string, () => Promise<void>][] = [];

cases.push(["a tenant nobody registered signs a person in and gets a Hydra token only it accepts", async () => {
  const s = await signIn(A, "alice", { scope: "openid profile email" });
  assertEquals(s.html!.includes("Sign in to <span class=\"origin\">app-a.example</span>"), true, "the page names the app");
  assertEquals(`${s.landed!.origin}${s.landed!.pathname}`, `${A}/auth/oidc/google/callback`);
  assertEquals(s.landed!.searchParams.get("state"), s.q!.get("state"));
  const t = await redeem(A, s.landed!.searchParams.get("code")!, s.verifier!);
  assertEquals(t.status, 200);
  const claims = await verifyIdToken(t.body.id_token, { alg: "RS256", issuers: [ISSUER], audience: A, nonce: s.q!.get("nonce")!, keys });
  assertEquals(claims.idp, "google");
  assertEquals(claims.sub, await pairwiseSubject(await pairwiseKey(SECRET), A, "google", "alice"), "the broker's own subject");
  assertEquals([claims.name, claims.picture, claims.email], [undefined, undefined, undefined], "unverified tenant never receives profile or email");
}]);

cases.push(["the same person is a stranger to another tenant, and the same to the same tenant", async () => {
  const a1 = await subOf(A, "alice"), a2 = await subOf(A, "alice"), b = await subOf(B, "alice");
  assertEquals(a1, a2);
  assertEquals(a1 === b, false);
}]);

cases.push(["a tenant cannot redeem another tenant's code, nor redeem one twice", async () => {
  const s = await signIn(A, "bob");
  const code = s.landed!.searchParams.get("code")!;
  assertEquals((await redeem(B, code, s.verifier!)).status >= 400, true, "another tenant");
  assertEquals((await redeem(A, code, "x".repeat(43))).status >= 400, true, "the wrong verifier");
  const again = await signIn(A, "bob");
  const once = again.landed!.searchParams.get("code")!;
  assertEquals((await redeem(A, once, again.verifier!)).status, 200);
  assertEquals((await redeem(A, once, again.verifier!)).status >= 400, true, "a code is spent once");
}]);

cases.push(["a sign-in never leaves for a redirect that is not the tenant's", async () => {
  const elsewhere = await signIn(A, "bob", { redirect_uri: `${B}/auth/oidc/google/callback` });
  assertEquals(elsewhere.landed, undefined, "no sign-in page reached");
  assertEquals(new URL(elsewhere.shown!.at).origin === B, false, "never redirected to B");
  const unregistered = await signIn("https://app-c.example", "bob", { redirect_uri: "https://evil.example/cb" });
  assertEquals(new URL(unregistered.shown!.at).origin === "https://evil.example", false, "never redirected to evil");
  const held = await fetch(`http://127.0.0.1:${HYDRA_ADMIN_PORT}/admin/clients/${encodeURIComponent("https://app-c.example")}`);
  await held.body?.cancel();
  assertEquals(held.status, 404, "a tenant is registered only for its own callback");
}]);

cases.push(["a provider the broker does not offer goes back to the tenant as an error", async () => {
  const s = await signIn(A, "bob", { provider: "nope" });
  assertEquals(`${new URL(s.shown!.at).origin}${new URL(s.shown!.at).pathname}`, `${A}/auth/oidc/google/callback`);
  assertEquals(new URL(s.shown!.at).searchParams.get("error"), "invalid_request");
}]);

cases.push(["a tampered round trip is refused without redirecting", async () => {
  const res = await fetch(`${ISSUER}/callback/google?code=x&state=${base64url(enc.encode("{}"))}.AAAA`, { redirect: "manual" });
  await res.body?.cancel();
  assertEquals([res.status, res.headers.get("location")], [400, null]);
}]);

cases.push(["only Hydra's public routes pass, and discovery names the broker's issuer", async () => {
  for (const path of ["/admin/clients", "/userinfo", "/oauth2/revoke", "/health/alive"]) {
    const res = await fetch(`${ISSUER}${path}`);
    await res.body?.cancel();
    assertEquals(res.status, 404, path);
  }
  const d = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  assertEquals([d.issuer, d.authorization_endpoint, d.token_endpoint], [ISSUER, `${ISSUER}/oauth2/auth`, `${ISSUER}/oauth2/token`]);
}]);

// mecha's own auth service as the tenant, where MECHA_AUTH names its
// services/auth: the client every application runs, unchanged, with the
// settings pronto-identity gives it.
const MECHA_AUTH = Deno.env.get("MECHA_AUTH");
if (MECHA_AUTH) cases.push(["mecha's auth service signs in through Hydra with the broker's settings", async () => {
  const { oidc, providersFrom } = await import(`file://${MECHA_AUTH}/oidc.ts`);
  const settings: Record<string, string> = {
    OIDC_PROVIDERS: "google", OIDC_GOOGLE_ISSUER: ISSUER, OIDC_GOOGLE_CLIENT_ID: "origin",
    OIDC_GOOGLE_SCOPE: "openid", OIDC_GOOGLE_AUTHORIZE_PARAMS: "provider=google",
  };
  const linked: { provider: string; sub: string }[] = [];
  const routes = oidc({
    secret: "m".repeat(40), origin: () => A, providers: providersFrom((k: string) => settings[k]),
    links: { userFor: async (p: { provider: string; sub: string }) => (linked.push(p), { id: "u1", handle: "alice" }), handleOf: async () => "alice" },
    issue: async () => "token",
  });
  const started: Response = await routes(new Request(`${A}/auth/oidc/google/start?return=/play`))!;
  const verifierCookie = started.headers.getSetCookie().find((c) => c.startsWith("mecha_oidc_state="))!.split(";")[0];
  const shown = await browse(started.headers.get("location")!);
  const go = (await shown.res.text()).match(/href="([^"]+\/login\/continue[^"]+)"/)![1].replace(/&#38;/g, "&");
  nextWho = "alice";
  const toGoogle = await browse(go, shown.jar);
  const hop = await fetch(toGoogle.at, { redirect: "manual" });
  await hop.body?.cancel();
  const back = await browse(hop.headers.get("location")!, shown.jar);
  await back.res.body?.cancel();
  const done: Response = await routes(new Request(back.at, { headers: { cookie: verifierCookie } }))!;
  assertEquals([done.status, done.headers.get("location")], [303, "/play"], await done.clone().text());
  // mecha from 0.14 links the issuer as well: the broker's.
  assertEquals(linked, [{ provider: "google", issuer: ISSUER, sub: await pairwiseSubject(await pairwiseKey(SECRET), A, "google", "alice"), name: null, picture: null, email: null }]);
}]);

cases.push(["a tenant with a valid _pronto-identity DNS TXT record hops through Hydra straight to Google without an interstitial", async () => {
  const key = await tenantTrustKey(SECRET);
  txtRecords.set(tenantTxtHost(TRUSTED), [await tenantTxtValue(key, ISSUER, TRUSTED)]);
  const verifier = randomToken(32);
  const q = new URLSearchParams({
    client_id: TRUSTED, redirect_uri: `${TRUSTED}/auth/oidc/google/callback`, response_type: "code", scope: "openid profile email",
    state: "st-hydra-trusted", nonce: "nn-hydra-trusted", provider: "google", code_challenge: await sha256url(verifier), code_challenge_method: "S256",
  });
  nextWho = "alice";
  // browse() follows all redirects on ISSUER and stops upon leaving for Google — with zero 200 HTML page in between.
  const atGoogle = await browse(`${ISSUER}/oauth2/auth?${q}`);
  assertEquals(atGoogle.res.status, 302, "Hydra login 302-redirects directly to Google");
  assertEquals(new URL(atGoogle.at).searchParams.get("scope"), "openid profile email");
  await atGoogle.res.body?.cancel();
  const hop = await fetch(atGoogle.at, { redirect: "manual" });
  await hop.body?.cancel();
  const back = await browse(hop.headers.get("location")!, atGoogle.jar);
  await back.res.body?.cancel();
  const landed = new URL(back.at);
  assertEquals(`${landed.origin}${landed.pathname}`, `${TRUSTED}/auth/oidc/google/callback`);
  const t = await redeem(TRUSTED, landed.searchParams.get("code")!, verifier);
  assertEquals(t.status, 200);
  const claims = await verifyIdToken(t.body.id_token, { alg: "RS256", issuers: [ISSUER], audience: TRUSTED, nonce: "nn-hydra-trusted", keys });
  assertEquals(claims.aud, [TRUSTED]);
  assertEquals([claims.name, claims.picture, claims.email, claims.email_verified], [
    "Alice Example",
    "https://lh3.googleusercontent.com/a/alice",
    "alice@example.test",
    true,
  ]);
}]);

cases.push(["a localhost app on a broker signing in test people is verified as a DNS record verifies one, profile and all", async () => {
  const LOCAL = "https://snapcards.localhost:8743";
  const verifier = randomToken(32);
  const q = new URLSearchParams({
    client_id: LOCAL, redirect_uri: `${LOCAL}/auth/oidc/google/callback`, response_type: "code", scope: "openid profile email",
    state: "st-local", nonce: "nn-local", provider: "google", code_challenge: await sha256url(verifier), code_challenge_method: "S256",
  });
  nextWho = "alice";
  const atGoogle = await browse(`${ISSUER}/oauth2/auth?${q}`);
  assertEquals(atGoogle.res.status, 302, "no interstitial for an app on this machine");
  await atGoogle.res.body?.cancel();
  const hop = await fetch(atGoogle.at, { redirect: "manual" });
  await hop.body?.cancel();
  const back = await browse(hop.headers.get("location")!, atGoogle.jar);
  await back.res.body?.cancel();
  const t = await redeem(LOCAL, new URL(back.at).searchParams.get("code")!, verifier);
  const claims = await verifyIdToken(t.body.id_token, { alg: "RS256", issuers: [ISSUER], audience: LOCAL, nonce: "nn-local", keys });
  assertEquals([claims.name, claims.email], ["Alice Example", "alice@example.test"]);
}]);

// Token roles: Hydra asks the front's token hook for a client credentials
// token's role, which only the operator's registration names.
const HOOK_SECRET = "h".repeat(40);
const AUDIENCE = "https://app-a.example/crud";
async function register(id: string, extra: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${HYDRA_ADMIN_PORT}/admin/clients`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: id, client_secret: `${id}-secret-of-some-length`, grant_types: ["client_credentials"],
      token_endpoint_auth_method: "client_secret_basic", access_token_strategy: "jwt", audience: [AUDIENCE], ...extra,
    }),
  });
  assertEquals(res.status, 201, await res.text());
}
async function clientToken(id: string, form: Record<string, string>) {
  const res = await fetch(`${ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${id}:${id}-secret-of-some-length`)}` },
    body: new URLSearchParams({ grant_type: "client_credentials", ...form }),
  });
  const body = await res.json();
  const claims = body.access_token ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.access_token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)))) : undefined;
  return { status: res.status, body, claims };
}
cases.push(["a client registered with a role gets a token naming it, signed by the issuer's published keys", async () => {
  await register("residual_bot", { metadata: { role: "residual_bot" } });
  const t = await clientToken("residual_bot", { audience: AUDIENCE });
  assertEquals(t.status, 200, JSON.stringify(t.body));
  assertEquals([t.claims.role, t.claims.sub, t.claims.aud, t.claims.ext], ["residual_bot", "residual_bot", [AUDIENCE], undefined]);
  const kid = JSON.parse(atob(t.body.access_token.split(".")[0].replaceAll("-", "+").replaceAll("_", "/"))).kid;
  assertEquals((await keys(kid))?.kty, "RSA", "the key is in the issuer's JWKS");
}]);
cases.push(["a client cannot name its own role, nor be given one it was not registered with", async () => {
  const asked = await clientToken("residual_bot", { audience: AUDIENCE, role: "service" });
  assertEquals([asked.status, asked.claims.role], [200, "residual_bot"], JSON.stringify(asked.body));
  const scoped = await clientToken("residual_bot", { audience: AUDIENCE, scope: "service" });
  assertEquals(scoped.status >= 400, true, "a scope the client was not registered for");
  await register("plain_client", {});
  const plain = await clientToken("plain_client", { audience: AUDIENCE, role: "service" });
  assertEquals([plain.status, plain.claims?.role], [200, undefined]);
  const other = await clientToken("plain_client", { audience: "https://app-b.example/crud" });
  assertEquals(other.status >= 400, true, "an audience the client was not registered for");
}]);
cases.push(["a role's token names an audience, and no role of the cluster's own is a client's", async () => {
  const bare = await clientToken("residual_bot", {});
  assertEquals([bare.status, bare.body.error], [403, "access_denied"]);
  for (const role of ["service", "app_user", "authenticator", "postgres", "pg_read_all_data", "Residual", 7]) {
    const id = `bad_${String(role).toLowerCase()}`;
    await register(id, { metadata: { role } });
    const t = await clientToken(id, { audience: AUDIENCE });
    assertEquals([t.status, t.claims?.role], [403, undefined], String(role));
  }
}]);
cases.push(["the token hook answers Hydra alone", async () => {
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${HOOK_SECRET}x`]) {
    const res = await fetch(`${ISSUER}/hooks/token`, {
      method: "POST", headers: authorization ? { authorization } : {},
      body: JSON.stringify({ request: { client_id: "residual_bot", grant_types: ["client_credentials"], granted_audience: [AUDIENCE] } }),
    });
    assertEquals(res.status, 401, String(authorization));
    await res.body?.cancel();
  }
}]);

const HYDRA_PUBLIC_PORT = freePort(), HYDRA_ADMIN_PORT = freePort();

// One test owns Hydra, the front and the fake Google from start to shutdown;
// each case is a step within it.
Deno.test({ name: "the broker on Hydra end to end", sanitizeOps: false, sanitizeResources: false }, async (t) => {
  const google = Deno.serve({ port: 0, onListen() {} }, fakeGoogle);
  const frontPort = freePort();
  ISSUER = `http://localhost:${frontPort}`;
  const hydra = new Deno.Command(Deno.env.get("HYDRA_BIN") ?? "hydra", {
    args: ["serve", "all", "--dev"],
    env: {
      DSN: "memory", SECRETS_SYSTEM: "t".repeat(40), LOG_LEVEL: "fatal",
      URLS_SELF_ISSUER: ISSUER, URLS_LOGIN: `${ISSUER}/login`, URLS_CONSENT: `${ISSUER}/consent`,
      SERVE_PUBLIC_HOST: "127.0.0.1", SERVE_PUBLIC_PORT: String(HYDRA_PUBLIC_PORT),
      SERVE_ADMIN_HOST: "127.0.0.1", SERVE_ADMIN_PORT: String(HYDRA_ADMIN_PORT),
      OAUTH2_PKCE_ENFORCED_FOR_PUBLIC_CLIENTS: "true", TTL_ID_TOKEN: "5m",
      OAUTH2_TOKEN_HOOK_URL: `${ISSUER}/hooks/token`, OAUTH2_TOKEN_HOOK_AUTH_TYPE: "api_key", OAUTH2_TOKEN_HOOK_AUTH_CONFIG_IN: "header",
      OAUTH2_TOKEN_HOOK_AUTH_CONFIG_NAME: "Authorization", OAUTH2_TOKEN_HOOK_AUTH_CONFIG_VALUE: `Bearer ${HOOK_SECRET}`,
      OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS: "role", OAUTH2_MIRROR_TOP_LEVEL_CLAIMS: "false",
    },
    stdout: "null", stderr: "inherit",
  }).spawn();
  const G = `http://localhost:${google.addr.port}`;
  const provider: Provider = {
    name: "google", label: "Google", authUrl: `${G}/auth`, tokenUrl: `${G}/token`, issuers: ["https://accounts.google.com"],
    keys: async (kid) => (kid === "g1" ? googleJwk : undefined), clientId: "op-client", clientSecret: "op-secret",
  };
  const hydraUrls = { public: `http://127.0.0.1:${HYDRA_PUBLIC_PORT}`, admin: `http://127.0.0.1:${HYDRA_ADMIN_PORT}` };
  const server = Deno.serve(
    { port: frontPort, hostname: "127.0.0.1", onListen() {} },
    await front({ issuer: ISSUER, secret: SECRET, providers: [provider], hydra: hydraUrls, resolveTxt: async (host) => txtRecords.get(host) ?? [], trustLocal: true, hookSecret: HOOK_SECRET }),
  );
  try {
    for (let i = 0; ; i++) {
      const ok = await fetch(`${ISSUER}/health`).then(async (r) => (await r.body?.cancel(), r.ok), () => false);
      if (ok) break;
      if (i > 60) throw new Error("hydra never became ready");
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const [name, run] of cases) await t.step({ name, fn: run, sanitizeOps: false, sanitizeResources: false });
  } finally {
    hydra.kill();
    await hydra.status;
    await server.shutdown();
    await google.shutdown();
  }
});
