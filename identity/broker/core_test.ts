// The broker's isolation rules: a tenant is an https origin, its redirect is
// its own origin's one callback, a person's subject differs per tenant, and a
// code is redeemed once, by the tenant and redirect it was issued to.
import { callbackOf, Codes, type Grant, idTokenClaims, pairwiseKey, pairwiseSubject, parseAuthorize, pkceMatches, redeem, tenantOf } from "./core.ts";
import { randomToken, Refused, sha256url, signEs256, verifyIdToken } from "../oidc.ts";

function assertEquals(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

Deno.test("a tenant is a bare https origin, and nothing else", () => {
  assertEquals(tenantOf("https://brawl.example.com"), "https://brawl.example.com");
  assertEquals(tenantOf("https://localhost:28102"), "https://localhost:28102");
  for (const bad of ["http://localhost:28102", "https://brawl.example.com/", "https://brawl.example.com/app", "https://a@b.example",
    "https://Brawl.Example.com", "https://x.example?y", "https://x.example#z", "brawl.example.com", "", null, 3]) {
    assertEquals(tenantOf(bad), null, String(bad));
  }
});

const providers = ["google"];
async function authorizeQuery(over: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: "https://app-a.example", redirect_uri: "https://app-a.example/auth/oidc/google/callback",
    response_type: "code", scope: "openid", state: "s1", nonce: "n1", provider: "google",
    code_challenge: await sha256url(randomToken(32)), code_challenge_method: "S256", ...over,
  });
}

Deno.test("a request is accepted only for the tenant's own callback for the provider it asks for", async () => {
  const ok = parseAuthorize(await authorizeQuery(), providers);
  assertEquals(ok.ok, true);
  for (const redirect_uri of [
    "https://app-b.example/auth/oidc/google/callback", // another tenant's
    "https://app-a.example/auth/oidc/github/callback", // another provider's
    "https://app-a.example/auth/identity/callback", // the wrapper's, before mecha signed in itself
    "https://app-a.example/auth/oidc/google/callback?x=1",
    "https://app-a.example/elsewhere",
    "https://evil.example/auth/oidc/google/callback",
  ]) {
    const r = parseAuthorize(await authorizeQuery({ redirect_uri }), providers);
    assertEquals(r.ok === false && r.redirect === null, true, redirect_uri);
  }
});

Deno.test("an error is sent to the redirect only once the redirect is the tenant's", async () => {
  // A provider the broker does not offer names no callback it could trust.
  const bad = parseAuthorize(await authorizeQuery({ provider: "myspace", redirect_uri: "https://app-a.example/auth/oidc/myspace/callback" }), providers);
  assertEquals(bad.ok === false && bad.redirect, null);
  const noState = parseAuthorize(await authorizeQuery({ state: "" }), providers);
  assertEquals(noState.ok === false && noState.redirect, null);
  const noPkce = parseAuthorize(await authorizeQuery({ code_challenge_method: "plain" }), providers);
  assertEquals(noPkce, { ok: false, error: "invalid_request", redirect: "https://app-a.example/auth/oidc/google/callback" });
  const notOpenid = parseAuthorize(await authorizeQuery({ scope: "email" }), providers);
  assertEquals(notOpenid.ok === false && notOpenid.error, "invalid_scope");
});

Deno.test("one person has unrelated subjects in two tenants, and per provider", async () => {
  const key = await pairwiseKey("x".repeat(32));
  const a = await pairwiseSubject(key, "https://app-a.example", "google", "g-123");
  const b = await pairwiseSubject(key, "https://app-b.example", "google", "g-123");
  const again = await pairwiseSubject(key, "https://app-a.example", "google", "g-123");
  const other = await pairwiseSubject(key, "https://app-a.example", "github", "g-123");
  assertEquals(a === b, false);
  assertEquals(a === again, true);
  assertEquals(a === other, false);
  const rotated = await pairwiseSubject(await pairwiseKey("y".repeat(32)), "https://app-a.example", "google", "g-123");
  assertEquals(a === rotated, false);
});

const grant = (over: Partial<Grant> = {}): Grant => ({
  tenant: "https://app-a.example", redirectUri: callbackOf("https://app-a.example", "google"), challenge: "", nonce: "n1", sub: "p-1", provider: "google", ...over,
});

Deno.test("a code is redeemed once, by its tenant and redirect, with its verifier", async () => {
  const verifier = randomToken(32);
  const challenge = await sha256url(verifier);
  const codes = new Codes();
  const form = (code: string, over: Record<string, string> = {}) => new URLSearchParams({
    grant_type: "authorization_code", code, client_id: "https://app-a.example",
    redirect_uri: "https://app-a.example/auth/oidc/google/callback", code_verifier: verifier, ...over,
  });
  const c1 = codes.issue(grant({ challenge }));
  assertEquals((await redeem(codes, form(c1))).ok, true);
  assertEquals(await redeem(codes, form(c1)), { ok: false, error: "invalid_grant" }); // single use
  const tampered: Record<string, string>[] = [
    { client_id: "https://app-b.example" }, // another tenant presenting A's code
    { redirect_uri: "https://app-b.example/auth/oidc/google/callback" },
    { code_verifier: randomToken(32) },
    { grant_type: "password" },
  ];
  for (const over of tampered) {
    const c = codes.issue(grant({ challenge }));
    assertEquals((await redeem(codes, form(c, over))).ok, false, JSON.stringify(over));
  }
});

Deno.test("a code expires", async () => {
  let t = 0;
  const codes = new Codes(1000, () => t);
  const c = codes.issue(grant());
  t = 1000;
  assertEquals(codes.take(c), null);
});

Deno.test("PKCE accepts only the verifier of the challenge", async () => {
  const v = randomToken(32);
  assertEquals(await pkceMatches(v, await sha256url(v)), true);
  assertEquals(await pkceMatches(v + "x", await sha256url(v)), false);
  assertEquals(await pkceMatches("short", await sha256url("short")), false);
});

Deno.test("the ID token is the tenant's alone: another tenant refuses it", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "b1" };
  const keys = async (kid: string) => (kid === "b1" ? jwk : undefined);
  const now = 1_800_000_000;
  const token = await signEs256(pair.privateKey, "b1", idTokenClaims({ issuer: "https://id.example", grant: grant(), now }));
  const check = (audience: string) => verifyIdToken(token, { alg: "ES256", issuers: ["https://id.example"], audience, nonce: "n1", keys, now });
  assertEquals((await check("https://app-a.example")).sub, "p-1");
  let refused = "";
  try { await check("https://app-b.example"); } catch (e) { refused = e instanceof Refused ? e.message : String(e); }
  assertEquals(refused, "id token audience");
});
