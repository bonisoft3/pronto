// The broker end to end, against a fake Google this test serves: a tenant
// signs a person in and receives an ID token only it accepts, the same person
// is a stranger to a second tenant, and a sign-in never leaves for a redirect
// that is not the tenant's.
import { base64url, type Jwk, randomToken, sha256url, verifyIdToken } from "../oidc.ts";
import { tenantTrustKey, tenantTxtHost, tenantTxtValue } from "./core.ts";
import { broker, type Provider } from "./main.ts";

function assertEquals(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const enc = new TextEncoder();
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const googleJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "g1" };
const pending = new Map<string, { nonce: string; sub: string; redirect: string; scope: string }>();
const fakeGoogle = async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/auth") {
    const code = crypto.randomUUID();
    pending.set(code, {
      nonce: url.searchParams.get("nonce")!,
      sub: url.searchParams.get("login_hint") ?? "alice",
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
const ISSUER = "https://id.example";
// Set by the test that owns the fake Google, before any case runs.
let handler: (req: Request) => Promise<Response>;
const call = (url: string, init?: RequestInit) => handler(new Request(url, init));
const brokerKeys = async (kid: string) => ((await (await call(`${ISSUER}/jwks`)).json()).keys as Jwk[]).find((k) => k.kid === kid);

/** One sign-in as `tenant`, Google's user `who`, returning what the tenant's callback received. */
async function signIn(tenant: string, who: string, over: Record<string, string> = {}) {
  const verifier = randomToken(32);
  const q = new URLSearchParams({
    client_id: tenant, redirect_uri: `${tenant}/auth/oidc/google/callback`, response_type: "code", scope: "openid",
    state: randomToken(8), nonce: randomToken(8), provider: "google", code_challenge: await sha256url(verifier), code_challenge_method: "S256", ...over,
  });
  const shown = await call(`${ISSUER}/authorize?${q}`);
  if (shown.status !== 200) return { shown };
  const html = await shown.text();
  const go = html.match(/href="([^"]+\/authorize\/continue[^"]+)"/)![1].replace(/&#38;/g, "&");
  const toGoogle = new URL((await call(go)).headers.get("location")!);
  toGoogle.searchParams.set("login_hint", who);
  const hop = await fetch(toGoogle, { redirect: "manual" });
  await hop.body?.cancel();
  const fromGoogle = hop.headers.get("location")!;
  const landed = new URL((await call(fromGoogle)).headers.get("location")!);
  return { html, landed, verifier, q };
}

async function redeem(tenant: string, code: string, verifier: string, over: Record<string, string> = {}) {
  const res = await call(`${ISSUER}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: tenant, redirect_uri: `${tenant}/auth/oidc/google/callback`, code_verifier: verifier, ...over }),
  });
  return { status: res.status, body: await res.json() };
}

const A = "https://app-a.example", B = "https://app-b.example", TRUSTED = "https://iris.cleaning";
const SECRET = "s".repeat(40);
const txtRecords = new Map<string, string[]>();
const cases: [string, () => Promise<void>][] = [];


cases.push(["a tenant signs a person in and gets a token only it accepts", async () => {
  const s = await signIn(A, "alice", { scope: "openid profile email" });
  assertEquals(s.html!.includes("Sign in to <span class=\"origin\">app-a.example</span>"), true, "the page names the app");
  assertEquals(`${s.landed!.origin}${s.landed!.pathname}`, `${A}/auth/oidc/google/callback`);
  assertEquals(s.landed!.searchParams.get("state"), s.q!.get("state"));
  const t = await redeem(A, s.landed!.searchParams.get("code")!, s.verifier!);
  assertEquals(t.status, 200);
  const claims = await verifyIdToken(t.body.id_token, { alg: "ES256", issuers: [ISSUER], audience: A, nonce: s.q!.get("nonce")!, keys: brokerKeys });
  assertEquals(claims.aud, A);
  assertEquals(claims.sub === "alice", false, "never Google's own subject");
  assertEquals([claims.name, claims.picture, claims.email], [undefined, undefined, undefined], "unverified tenant never receives profile or email");
}]);

cases.push(["the same person is a stranger to another tenant, and the same to the same tenant", async () => {
  const subOf = async (tenant: string) => {
    const s = await signIn(tenant, "alice");
    const t = await redeem(tenant, s.landed!.searchParams.get("code")!, s.verifier!);
    return (await verifyIdToken(t.body.id_token, { alg: "ES256", issuers: [ISSUER], audience: tenant, nonce: s.q!.get("nonce")!, keys: brokerKeys })).sub;
  };
  const a1 = await subOf(A), a2 = await subOf(A), b = await subOf(B);
  assertEquals(a1, a2);
  assertEquals(a1 === b, false);
}]);

cases.push(["a tenant cannot redeem another tenant's code, nor use another's redirect", async () => {
  const s = await signIn(A, "bob");
  const stolen = await redeem(B, s.landed!.searchParams.get("code")!, s.verifier!);
  assertEquals(stolen.status, 400);
  const replay = await redeem(A, s.landed!.searchParams.get("code")!, s.verifier!);
  assertEquals(replay.status, 400, "the stolen attempt spent the code");
  const elsewhere = await signIn(A, "bob", { redirect_uri: `${B}/auth/oidc/google/callback` });
  assertEquals(elsewhere.shown!.status, 400);
  assertEquals(elsewhere.shown!.headers.get("location"), null, "never redirected");
}]);

cases.push(["a tampered round trip is refused without redirecting", async () => {
  const res = await call(`${ISSUER}/callback/google?code=x&state=${base64url(enc.encode("{}"))}.AAAA`);
  assertEquals(res.status, 400);
  assertEquals(res.headers.get("location"), null);
}]);

cases.push(["discovery and keys describe a pairwise ES256 provider", async () => {
  const d = await (await call(`${ISSUER}/.well-known/openid-configuration`)).json();
  assertEquals([d.issuer, d.subject_types_supported, d.id_token_signing_alg_values_supported, d.token_endpoint_auth_methods_supported],
    [ISSUER, ["pairwise"], ["ES256"], ["none"]]);
  const k = await (await call(`${ISSUER}/jwks`)).json();
  assertEquals([k.keys.length, k.keys[0].kty, k.keys[0].d], [1, "EC", undefined], "the public half only");
}]);

cases.push(["a tenant with a valid _pronto-identity DNS TXT record 302-redirects straight to Google without an interstitial", async () => {
  const key = await tenantTrustKey(SECRET);
  const validTxt = await tenantTxtValue(key, ISSUER, TRUSTED);
  txtRecords.set(tenantTxtHost(TRUSTED), [validTxt]);
  // Forged replay of TRUSTED's TXT record onto another domain must NOT bypass the interstitial.
  txtRecords.set(tenantTxtHost("https://forged.example"), [validTxt]);

  const verifier = randomToken(32);
  const q = new URLSearchParams({
    client_id: TRUSTED, redirect_uri: `${TRUSTED}/auth/oidc/google/callback`, response_type: "code", scope: "openid profile email",
    state: "st-trusted", nonce: "nn-trusted", provider: "google", code_challenge: await sha256url(verifier), code_challenge_method: "S256",
  });
  const direct = await call(`${ISSUER}/authorize?${q}`);
  assertEquals(direct.status, 302, "trusted tenant skips interstitial HTML");
  const toGoogle = new URL(direct.headers.get("location")!);
  assertEquals(toGoogle.searchParams.get("scope"), "openid profile email");
  toGoogle.searchParams.set("login_hint", "alice");
  const hop = await fetch(toGoogle, { redirect: "manual" });
  await hop.body?.cancel();
  const landed = new URL((await call(hop.headers.get("location")!)).headers.get("location")!);
  assertEquals(`${landed.origin}${landed.pathname}`, `${TRUSTED}/auth/oidc/google/callback`);
  const t = await redeem(TRUSTED, landed.searchParams.get("code")!, verifier);
  assertEquals(t.status, 200);
  const claims = await verifyIdToken(t.body.id_token, { alg: "ES256", issuers: [ISSUER], audience: TRUSTED, nonce: "nn-trusted", keys: brokerKeys });
  assertEquals(claims.aud, TRUSTED);
  assertEquals([claims.name, claims.picture, claims.email, claims.email_verified], [
    "Alice Example",
    "https://lh3.googleusercontent.com/a/alice",
    "alice@example.test",
    true,
  ]);

  const forgedQ = new URLSearchParams({
    client_id: "https://forged.example", redirect_uri: "https://forged.example/auth/oidc/google/callback", response_type: "code", scope: "openid",
    state: "st-forged", nonce: "nn-forged", provider: "google", code_challenge: await sha256url(verifier), code_challenge_method: "S256",
  });
  const forgedRes = await call(`${ISSUER}/authorize?${forgedQ}`);
  assertEquals(forgedRes.status, 200, "replayed TXT record on another domain still shows confirmation page");
}]);


// One test owns the fake Google from start to shutdown, so no operation of
// its server outlives the test; each case is a step within it.
Deno.test("the broker end to end", async (t) => {
  const fake = Deno.serve({ port: 0, onListen() {} }, fakeGoogle);
  const G = `http://localhost:${fake.addr.port}`;
  const provider: Provider = {
    name: "google", label: "Google", authUrl: `${G}/auth`, tokenUrl: `${G}/token`, issuers: ["https://accounts.google.com"],
    keys: async (kid) => (kid === "g1" ? googleJwk : undefined), clientId: "op-client", clientSecret: "op-secret",
  };
  handler = await broker({
    issuer: ISSUER,
    secret: SECRET,
    providers: [provider],
    resolveTxt: async (host) => txtRecords.get(host) ?? [],
  });
  try {
    for (const [name, run] of cases) await t.step({ name, fn: run, sanitizeOps: false, sanitizeResources: false });
  } finally {
    await fake.shutdown();
  }
});
