// A bearer token of a named issuer against key pairs this test mints: one
// issued to the issuer's client for an operation names that operation, and
// every claim, key or issuer that does not hold is refused by its reason,
// which carries none of the token's values.
import { failureStatus, type Issuer, issuerKeys, verifyBearer } from "./bearer.ts";
import { base64url, jwksSource, Refused } from "./oidc.ts";

function assertEquals(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function assertRejects(f: () => Promise<unknown>, kind: new (message?: string) => Error, includes: string) {
  try { await f(); } catch (e) {
    if (e instanceof kind && e.message.includes(includes)) return e as Error;
    throw new Error(`rejected with ${e}, not ${kind.name} "${includes}"`);
  }
  throw new Error(`expected a ${kind.name} "${includes}"`);
}
const assertRefused = (f: () => Promise<unknown>, includes: string) => assertRejects(f, Refused, includes);

const enc = new TextEncoder();
const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const pairA = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const pairB = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const jwkOf = async (pair: CryptoKeyPair) => ({ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" });
const keySets = { a: await jwkOf(pairA), b: await jwkOf(pairB) };
const now = 1_800_000_000;

// Claims as an object, or as the raw JSON an issuer signed (JSON.stringify writes no 1e400).
async function token(claims: Record<string, unknown> | string, key = pairA.privateKey, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) {
  const head = base64url(enc.encode(JSON.stringify(header)));
  const body = base64url(enc.encode(typeof claims === "string" ? claims : JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64url(sig)}`;
}

const issuerA: Issuer = {
  name: "issuer-a",
  kind: "bearer",
  issuer: "https://id.example/realms/guests",
  discovery: "https://id.example/realms/guests/.well-known/openid-configuration",
  alg: "RS256",
  azp: ["web"],
  audience: [],
  require: { operationType: ["ORDER_FLOW"] },
  map: { operation_kind: { claim: "operationType", values: { ORDER_FLOW: "ORDER" } }, operation_id: { claim: "operationId" } },
  amr: ["otp"],
  claimMax: 200,
};
const issuerB: Issuer = { ...issuerA, name: "issuer-b", issuer: "https://other.example", require: {}, discovery: "https://other.example/.well-known/openid-configuration" };
const keys = (i: Issuer) => (kid: string) => Promise.resolve(kid === "k1" ? (i === issuerB ? keySets.b : keySets.a) : undefined);
const good = { iss: issuerA.issuer, azp: "web", exp: now + 300, operationType: "ORDER_FLOW", operationId: "op-1", sub: "kc-9" };
const check = (t: string, issuers: Issuer[] = [issuerA, issuerB]) => verifyBearer(t, { issuers, keys, now });

Deno.test("a token of a named issuer, for its client and its operation, names the operation", async () => {
  assertEquals(await check(await token(good)), { operation_kind: "ORDER", operation_id: "op-1", amr: ["otp"], idp: "issuer-a" });
  // Its words where the issuer's are the application's too.
  const plain = { ...issuerA, require: {}, map: { operation_kind: { claim: "kind" }, operation_id: { claim: "operationId" } } };
  assertEquals((await check(await token({ ...good, kind: "ORDER" }), [plain])).operation_kind, "ORDER");
});

Deno.test("a token of an issuer not named, or naming none, is refused", async () => {
  await assertRefused(async () => check(await token({ ...good, iss: "https://evil.example" })), "issuer unknown");
  await assertRefused(async () => check(await token({ ...good, iss: `${issuerA.issuer}/` })), "issuer unknown");
  const { iss: _, ...unissued } = good;
  await assertRefused(async () => check(await token(unissued)), "issuer unknown");
  await assertRefused(() => check("not-a-token"), "malformed");
  await assertRefused(() => check("a.%%%.c"), "malformed");
});

Deno.test("every claim that does not hold is refused, by its name", async () => {
  const refused = async (claims: Record<string, unknown>, reason: string) => {
    const e = await assertRefused(async () => check(await token(claims)), reason);
    // Nothing a token carries reaches a reason, which a caller may log.
    for (const v of Object.values(claims)) if (typeof v === "string" && v.length > 3) assertEquals(e.message.includes(v), false, reason);
  };
  await refused({ ...good, exp: now - 61 }, "expired");
  await refused({ ...good, exp: undefined }, "expired");
  await refused({ ...good, exp: String(now + 300) }, "expired");
  await refused({ ...good, nbf: now + 61 }, "not yet valid");
  // 1e400 parses as Infinity: an exp no time is past, an nbf no time reaches.
  const raw = JSON.stringify(good);
  await assertRefused(async () => check(await token(raw.replace(`"exp":${good.exp}`, `"exp":1e400`))), "expired");
  await assertRefused(async () => check(await token(raw.replace(`"exp":${good.exp}`, `"exp":${good.exp},"nbf":-1e400`))), "not yet valid");
  await refused({ ...good, azp: "another-client" }, "party");
  await refused({ ...good, azp: undefined }, "party");
  await refused({ ...good, operationType: "PAYMENT_FLOW" }, "operationType");
  await refused({ ...good, operationType: ["ORDER_FLOW"] }, "operationType");
  await refused({ ...good, operationId: undefined }, "operationId");
  await refused({ ...good, operationId: "" }, "operationId");
  await refused({ ...good, operationId: 42 }, "operationId");
  await refused({ ...good, operationId: "x".repeat(201) }, "operationId");
  // A mapped value the issuer's words do not hold, where nothing else requires it.
  const open = { ...issuerA, require: {} };
  await assertRefused(async () => check(await token({ ...good, operationType: "PAYMENT_FLOW" }), [open]), "operationType");
  await assertRefused(async () => check(await token({ ...good, operationType: "constructor" }), [open]), "operationType");
  // An audience, where the issuer names one.
  const audienced = { ...issuerA, audience: ["orders-api"] };
  assertEquals((await check(await token({ ...good, aud: ["account", "orders-api"] }), [audienced])).operation_id, "op-1");
  await assertRefused(async () => check(await token({ ...good, aud: "account" }), [audienced]), "audience");
  await assertRefused(async () => check(await token(good), [audienced]), "audience");
});

Deno.test("a token is checked by the keys of the issuer it names, and only by them", async () => {
  // Signed by issuer A's key but naming issuer B: B's key of the same id refuses it.
  await assertRefused(async () => check(await token({ ...good, iss: issuerB.issuer })), "signature");
  await assertRefused(async () => check(await token(good, pairB.privateKey)), "signature");
  await assertRefused(async () => check(await token(good, pairA.privateKey, { alg: "ES256", kid: "k1" })), "not RS256");
  await assertRefused(async () => check(await token(good, pairA.privateKey, { alg: "none", kid: "k1" })), "not RS256");
  await assertRefused(async () => check(await token(good, pairA.privateKey, { alg: "RS256", kid: "k9" })), "key unknown");
  const [h, b, s] = (await token(good)).split(".");
  await assertRefused(() => check(`${h}.${base64url(enc.encode(JSON.stringify({ ...good, operationId: "op-2" })))}.${s}`), "signature");
  // A signature that is no base64url is a malformed token, never a raw exception.
  for (const sig of ["%%%", "a*b", "é"]) await assertRefused(() => check(`${h}.${b}.${sig}`), "malformed");
});

Deno.test("a word an issuer maps to that the upgrade would not take is refused", async () => {
  const long = { ...issuerA, map: { ...issuerA.map, operation_kind: { claim: "operationType", values: { ORDER_FLOW: "x".repeat(201) } } } };
  await assertRefused(async () => check(await token(good), [long]), "operationType");
  const empty = { ...issuerA, map: { ...issuerA.map, operation_kind: { claim: "operationType", values: { ORDER_FLOW: "" } } } };
  await assertRefused(async () => check(await token(good), [empty]), "operationType");
  // A mapped token value is bounded by the map, not by the upgrade: only the word it becomes is.
  const longType = "FLOW_" + "x".repeat(250);
  const wide = { ...issuerA, require: {}, map: { ...issuerA.map, operation_kind: { claim: "operationType", values: { [longType]: "ORDER" } } } };
  assertEquals((await check(await token({ ...good, operationType: longType }), [wide])).operation_kind, "ORDER");
  // The bound is the issuer's, as identity/issuer.cue emits it, not a number of this file's.
  // ORDER_FLOW becomes ORDER, 5 characters long.
  await assertRefused(async () => check(await token(good), [{ ...issuerA, claimMax: 4 }]), "operationType");
  assertEquals((await check(await token(good), [{ ...issuerA, claimMax: 5 }])).operation_kind, "ORDER");
  // A token's own value becomes the claim as it stands, so it is held to what a mapped word is:
  // printable ASCII, so CUE's count and the upgrade's are one.
  for (const operationId of ["op-\u00e9", "op\n1", "op\u0000"]) {
    await assertRefused(async () => check(await token({ ...good, operationId })), "operationId");
  }
});

Deno.test("two issuers naming one iss are the application's error, not a token's refusal", async () => {
  const e = await assertRejects(async () => check(await token(good), [issuerA, { ...issuerA, name: "issuer-c" }]), Error, "name the same issuer");
  assertEquals(e instanceof Refused, false);
});

function fakeIssuer(doc: Record<string, unknown>, jwks = { keys: [keySets.a] }) {
  const asked: string[] = [];
  const fetcher = ((url: string) => {
    asked.push(url);
    if (url === issuerA.discovery) return Promise.resolve(new Response(JSON.stringify(doc)));
    if (url === doc.jwks_uri) return Promise.resolve(new Response(JSON.stringify(jwks)));
    return Promise.resolve(new Response("", { status: 404 }));
  }) as typeof fetch;
  return { asked, keys: issuerKeys(issuerA, fetcher) };
}
const certs = `${issuerA.issuer}/protocol/openid-connect/certs`;

Deno.test("an issuer's keys are found by its discovery once, and a key it did not hold is asked for seldom", async () => {
  const { asked, keys } = fakeIssuer({ issuer: issuerA.issuer, jwks_uri: certs });
  assertEquals((await keys("k1"))?.kid, "k1");
  assertEquals((await keys("k1"))?.kid, "k1");
  assertEquals(asked, [issuerA.discovery, certs]);
  // A key nobody published, named again and again, is no fetch each time.
  for (let i = 0; i < 5; i++) assertEquals(await keys(`k-forged-${i}`), undefined);
  assertEquals(asked.length, 2);
  // And the whole check over them, end to end.
  assertEquals((await verifyBearer(await token(good), { issuers: [issuerA], keys: () => keys, now })).operation_id, "op-1");
});

Deno.test("a discovery naming another issuer, or a key set off https, is the issuer's fault, and asked again no sooner", async () => {
  const other = fakeIssuer({ issuer: "https://evil.example", jwks_uri: certs });
  await assertRejects(() => other.keys("k1"), Error, "discovery names another issuer");
  await assertRejects(() => other.keys("k1"), Error, "discovery failed recently");
  assertEquals(other.asked, [issuerA.discovery]);
  await assertRejects(() => fakeIssuer({ issuer: issuerA.issuer, jwks_uri: "http://id.example/certs" }).keys("k1"), Error, "not https");
  await assertRejects(() => fakeIssuer({ issuer: issuerA.issuer }).keys("k1"), Error, "names no key set");
  const down = issuerKeys(issuerA, (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch);
  const e = await assertRejects(() => down("k1"), Error, "discovery 503");
  assertEquals(e instanceof Refused, false);
});

Deno.test("a key set over http is a local stand-in's alone: loopback, on the discovery's own host", async () => {
  const local: Issuer = {
    ...issuerA,
    name: "issuer-local",
    issuer: "http://localhost:18080/realms/guests",
    discovery: "http://localhost:18080/realms/guests/.well-known/openid-configuration",
  };
  const keysAt = (jwksUri: string, issuer = local) => {
    const fetcher = ((url: string) => {
      if (url === issuer.discovery) return Promise.resolve(new Response(JSON.stringify({ issuer: issuer.issuer, jwks_uri: jwksUri })));
      return set(keySets.a)();
    }) as typeof fetch;
    return issuerKeys(issuer, fetcher);
  };
  assertEquals((await keysAt("http://localhost:18080/realms/guests/certs")("k1"))?.kid, "k1");
  assertEquals((await keysAt("http://localhost:9999/certs")("k1"))?.kid, "k1", "another port of the same loopback host");
  // Over http from anywhere else, whoever is on the path could hand over keys.
  for (const uri of ["http://keys.example/certs", "http://127.0.0.1:18080/certs", "http://localhost.evil.example/certs"]) {
    await assertRejects(() => keysAt(uri)("k1"), Error, "key set is not https");
  }
  // An https issuer's key set over http is refused even on loopback.
  await assertRejects(() => keysAt("http://localhost:18080/certs", issuerA)("k1"), Error, "key set is not https");
});

Deno.test("a key set spaces the fetches an unknown key makes only when asked to", async () => {
  let fetches = 0;
  const fetcher = (() => {
    fetches++;
    return Promise.resolve(new Response(JSON.stringify({ keys: [keySets.a] })));
  }) as typeof fetch;
  const eager = jwksSource("https://keys.example/certs", fetcher);
  await eager("k2");
  await eager("k3");
  assertEquals(fetches, 2);
  const spaced = jwksSource("https://keys.example/certs", fetcher, { refetchAfterS: 60 });
  await spaced("k2");
  await spaced("k3");
  assertEquals((await spaced("k1"))?.kid, "k1");
  assertEquals(fetches, 3);
  // Tokens arriving together at a cold start wait on the one fetch, and none is refused for it.
  const cold = jwksSource("https://keys.example/certs", fetcher, { refetchAfterS: 60 });
  assertEquals((await Promise.all([cold("k1"), cold("k1"), cold("k1")])).map((k) => k?.kid), ["k1", "k1", "k1"]);
  assertEquals(fetches, 4);
  // A set that ages faster than it may be asked again would serve stale keys in between: refused when made.
  let thrown = "";
  try {
    jwksSource("https://keys.example/certs", fetcher, { maxAgeS: 5, refetchAfterS: 60 });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown, "jwks maxAgeS 5 is under refetchAfterS 60");
  jwksSource("https://keys.example/certs", fetcher, { maxAgeS: 60, refetchAfterS: 60 });
});

/** A key set served as `answers` say, one per fetch, the last repeated; each fetch's signal kept. */
function keyServer(answers: (() => Promise<Response>)[]) {
  const signals: unknown[] = [];
  const fetcher = ((_url: string, init?: RequestInit) => {
    signals.push(init?.signal);
    return answers[Math.min(signals.length, answers.length) - 1]();
  }) as typeof fetch;
  return { signals, fetcher };
}
const set = (...keys: unknown[]) => () => Promise.resolve(new Response(JSON.stringify({ keys })));
const status = (code: number) => () => Promise.resolve(new Response("", { status: code }));

Deno.test("a key set that failed is the issuer's failure, not the token's, until it may be asked again", async () => {
  const server = keyServer([status(503)]);
  const keys = jwksSource("https://keys.example/certs", server.fetcher, { refetchAfterS: 60 });
  await assertRejects(() => keys("k1"), Error, "jwks failed recently (jwks 503)");
  await assertRejects(() => keys("k1"), Error, "jwks failed recently");
  assertEquals(server.signals.length, 1);
  // A valid token is not refused for it: the check fails as the issuer's fault.
  const e = await assertRejects(async () => verifyBearer(await token(good), { issuers: [issuerA], keys: () => keys, now }), Error, "jwks failed recently");
  assertEquals(e instanceof Refused, false);
  // A caller answers the issuer's fault with 503, which a client may retry, and the token's with 401.
  assertEquals(failureStatus(e), 503);
  assertEquals(failureStatus(await assertRejects(async () => check(await token({ ...good, azp: "other" })), Refused, "bearer party")), 401);
});

Deno.test("a key set is fetched with a deadline, and one that fails or is no list of keys serves nothing past its age", async () => {
  let t = 0;
  const body = (text: string) => () => Promise.resolve(new Response(text));
  const server = keyServer([set(keySets.a), status(503), body("{}"), body("null"), set(keySets.a, null), body(JSON.stringify({ keys: [keySets.a, 7] }))]);
  const keys = jwksSource("https://keys.example/certs", server.fetcher, { maxAgeS: 10, clock: () => t });
  assertEquals((await keys("k1"))?.kid, "k1");
  // A fetch for a key it does not hold that fails is that lookup's failure; the set it holds, still young, serves on.
  t = 1;
  await assertRejects(() => keys("k9"), Error, "jwks failed recently (jwks 503)");
  t = 2;
  assertEquals((await keys("k1"))?.kid, "k1");
  // Past its age, every way a fetch can fail is the issuer's failure, a held key's lookup too.
  for (t of [11, 12, 13, 14]) await assertRejects(() => keys("k1"), Error, "jwks failed recently");
  assertEquals(server.signals.length, 6);
  assertEquals(server.signals.every((s) => s instanceof AbortSignal), true, "every fetch has a deadline");
  // A list holding something that is no key is no key set, and replaces none.
  const nulled = jwksSource("https://keys.example/certs", keyServer([set(keySets.a, null)]).fetcher);
  await assertRejects(() => nulled("k1"), Error, "names no key list");
  // An empty list is a list: the key it no longer names is no key.
  const emptied = jwksSource("https://keys.example/certs", keyServer([set(keySets.a), set()]).fetcher, { maxAgeS: 0 });
  assertEquals((await emptied("k1"))?.kid, "k1");
  assertEquals(await emptied("k1"), undefined);
  // A key it never held, while the issuer answers nothing usable, is the issuer's failure.
  const malformed = jwksSource("https://keys.example/certs", keyServer([() => Promise.resolve(new Response("{}"))]).fetcher);
  await assertRejects(() => malformed("k1"), Error, "names no key list");
});

Deno.test("a key set older than its age is asked again, so a key the issuer withdrew stops verifying", async () => {
  const rotated = { ...keySets.b, kid: "k2" };
  const aged = jwksSource("https://keys.example/certs", keyServer([set(keySets.a), set(rotated)]).fetcher, { maxAgeS: 0 });
  assertEquals((await aged("k1"))?.kid, "k1");
  assertEquals(await aged("k1"), undefined);
  assertEquals((await aged("k2"))?.kid, "k2");
  // Without an age, a set is held until a key it does not hold is asked for.
  const held = jwksSource("https://keys.example/certs", keyServer([set(keySets.a), set(rotated)]).fetcher);
  assertEquals((await held("k1"))?.kid, "k1");
  assertEquals((await held("k1"))?.kid, "k1");
});

Deno.test("a key past its set's age stops verifying as soon as the issuer cannot be asked, until it can", async () => {
  let t = 0;
  let up = true;
  let fetches = 0;
  const fetcher = (() => {
    fetches++;
    return up ? set(keySets.a)() : status(503)();
  }) as typeof fetch;
  const keys = jwksSource("https://keys.example/certs", fetcher, { maxAgeS: 600, clock: () => t });
  assertEquals((await keys("k1"))?.kid, "k1");
  // Within its age, the set is not asked again, up or down.
  up = false;
  t = 599;
  assertEquals((await keys("k1"))?.kid, "k1");
  assertEquals(fetches, 1);
  // At its age, a valid token fails as the issuer's fault: k1 may have been withdrawn, and only the issuer can say.
  t = 600;
  await assertRejects(() => keys("k1"), Error, "jwks failed recently (jwks 503)");
  const e = await assertRejects(
    async () => verifyBearer(await token(good), { issuers: [issuerA], keys: () => keys, now }),
    Error,
    "jwks failed recently",
  );
  assertEquals(e instanceof Refused, false);
  assertEquals(fetches, 3);
  // A fetch that succeeds again ends it.
  up = true;
  t = 601;
  assertEquals((await keys("k1"))?.kid, "k1");
  assertEquals(fetches, 4);
});

Deno.test("a discovery that does not answer in time fails, and leaves nothing waiting", async () => {
  const signals: unknown[] = [];
  const timedOut = ((_url: string, init?: RequestInit) => {
    signals.push(init?.signal);
    return Promise.reject(new DOMException("The signal has been aborted", "TimeoutError"));
  }) as typeof fetch;
  const keys = issuerKeys(issuerA, timedOut);
  await assertRejects(() => keys("k1"), Error, "aborted");
  assertEquals(signals[0] instanceof AbortSignal, true, "discovery has a deadline");
  // Asked again within its interval, it fails at once rather than wait on the one that failed.
  await assertRejects(() => keys("k1"), Error, "discovery failed recently");
  assertEquals(signals.length, 1);
});
