// The shared verifier against a key pair this test mints: a token signed for
// this audience and nonce names its subject, and every claim or signature
// that does not hold is refused, by its reason.
import { base64url, jwksSource, Refused, verifyIdToken } from "./oidc.ts";

function assertEquals(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function assertRefused(f: () => Promise<unknown>, includes: string) {
  try { await f(); } catch (e) {
    if (e instanceof Refused && e.message.includes(includes)) return;
    throw new Error(`rejected with ${e}, not Refused "${includes}"`);
  }
  throw new Error(`expected a Refused "${includes}"`);
}

const enc = new TextEncoder();
const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const pair = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const keys = async (kid: string) => (kid === "k1" ? jwk : undefined);
const now = 1_800_000_000;

async function token(claims: Record<string, unknown>, kid = "k1", key = pair.privateKey, alg = "RS256") {
  const head = base64url(enc.encode(JSON.stringify({ alg, kid })));
  const body = base64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64url(sig)}`;
}
const good = { iss: "https://accounts.google.com", aud: "client-1", sub: "g-123", nonce: "n1", exp: now + 3600 };
const check = (t: string) => verifyIdToken(t, { alg: "RS256", issuers: ["https://accounts.google.com"], audience: "client-1", nonce: "n1", keys, now });

Deno.test("a token signed for this audience and nonce names its subject", async () => {
  assertEquals((await check(await token(good))).sub, "g-123");
});

Deno.test("every claim that does not hold is refused", async () => {
  await assertRefused(async () => check(await token({ ...good, iss: "https://evil.example" })), "issuer");
  await assertRefused(async () => check(await token({ ...good, aud: "client-2" })), "audience");
  await assertRefused(async () => check(await token({ ...good, exp: now - 61 })), "expired");
  await assertRefused(async () => check(await token({ ...good, nonce: "n2" })), "nonce");
  await assertRefused(async () => check(await token({ ...good, sub: "" })), "subject");
});

Deno.test("a forged signature, another algorithm, an unknown key and a malformed token are refused", async () => {
  const other = await crypto.subtle.generateKey(rsa, true, ["sign"]);
  await assertRefused(async () => check(await token(good, "k1", other.privateKey)), "signature");
  await assertRefused(async () => check(await token(good, "k1", pair.privateKey, "ES256")), "not RS256");
  await assertRefused(async () => check(await token(good, "k9")), "key unknown");
  await assertRefused(() => check("not.a-token"), "malformed");
  const [h, , s] = (await token(good)).split(".");
  await assertRefused(() => check(`${h}.${base64url(enc.encode(JSON.stringify({ ...good, sub: "g-999" })))}.${s}`), "signature");
});

Deno.test("the key set is fetched again only for a key it did not hold", async () => {
  let fetches = 0;
  const source = jwksSource("https://keys.example/certs", (async () => {
    fetches++;
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch);
  assertEquals((await source("k1"))?.kid, "k1");
  assertEquals((await source("k1"))?.kid, "k1");
  assertEquals(fetches, 1);
  assertEquals(await source("k2"), undefined);
  assertEquals(fetches, 2);
});
