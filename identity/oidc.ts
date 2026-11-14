// The OpenID Connect pieces the broker and every app share: JWTs signed with
// RS256 (Google's ID tokens) or ES256 (the broker's), checked against a key
// set fetched again only for a key it did not hold, as rotation reaches a
// running service.

const enc = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256url(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

export type Jwk = JsonWebKey & { kid?: string };
export type KeySource = (kid: string) => Promise<Jwk | undefined>;

/** How long a fetch of an issuer's documents may take before it is abandoned. */
export const FETCH_TIMEOUT_MS = 5000;

/**
 * An issuer's keys, fetched again for a key the set does not hold or once the
 * set is `maxAgeS` old, by one fetch in flight that every lookup waits on.
 * `refetchAfterS` spaces those fetches, so tokens naming keys that do not
 * exist cannot make every request one. A set younger than `maxAgeS` keeps
 * serving the keys it holds whatever a fetch for another key did; a lookup
 * that waited on a fetch that failed is the issuer's failure (an Error), not
 * the token's, and so is every lookup that needs one until a fetch succeeds:
 * no key outlives its set's age on the strength of an issuer that cannot be
 * asked. `clock` is in seconds.
 */
export function jwksSource(
  url: string,
  fetcher: typeof fetch = fetch,
  { refetchAfterS = 0, maxAgeS = Infinity, clock = () => Date.now() / 1000 }: {
    refetchAfterS?: number;
    maxAgeS?: number;
    clock?: () => number;
  } = {},
): KeySource {
  // A set that ages faster than it may be asked again would serve keys past
  // their age in between.
  if (!(maxAgeS >= refetchAfterS)) throw new Error(`jwks maxAgeS ${maxAgeS} is under refetchAfterS ${refetchAfterS}`);
  let keys: Jwk[] = [];
  let loadedAt = -Infinity;
  let triedAt = -Infinity;
  let failed: Error | undefined;
  let fetching: Promise<void> | undefined;
  const refresh = async () => {
    const res = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const listed = ((await res.json()) as { keys?: unknown } | null)?.keys;
    const key = (k: unknown) => typeof k === "object" && k !== null && !Array.isArray(k);
    if (!Array.isArray(listed) || !listed.every(key)) throw new Error("jwks names no key list");
    keys = listed as Jwk[];
    loadedAt = clock();
  };
  return async (kid) => {
    const held = () => keys.find((k) => k.kid === kid);
    const now = clock();
    if (held() && now - loadedAt < maxAgeS) return held();
    if (fetching === undefined && now - triedAt >= refetchAfterS) {
      triedAt = now;
      fetching = refresh()
        .then(() => failed = undefined, (e) => failed = e instanceof Error ? e : new Error(String(e)))
        .then(() => fetching = undefined);
    }
    await fetching;
    if (failed !== undefined) throw new Error(`jwks failed recently (${failed.message})`);
    return held();
  };
}

const ALGS = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
} as const;
export type Alg = keyof typeof ALGS;

export class Refused extends Error {}

/** An ES256 JWT over `claims`, its header naming `kid`. */
export async function signEs256(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const head = base64url(enc.encode(JSON.stringify({ alg: "ES256", kid, typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign(ALGS.ES256.verify, privateKey, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64url(sig)}`;
}

/**
 * A JWT's claims, once its signature verifies under the key its header names
 * for `alg`; Refused otherwise, its reason opening with `what`.
 */
export async function signedClaims(token: string, alg: Alg, keys: KeySource, what: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Refused(`${what} malformed`);
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
    signature = fromBase64url(parts[2]);
  } catch {
    throw new Refused(`${what} malformed`);
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw new Refused(`${what} malformed`);
  if (header?.alg !== alg || typeof header.kid !== "string") throw new Refused(`${what} not ${alg}`);
  const jwk = await keys(header.kid);
  if (!jwk) throw new Refused(`${what} key unknown`);
  // The key the header names must be of the alg's type, or importKey would throw an Error that reads
  // as the issuer's fault rather than the token's.
  if (alg === "RS256" ? jwk.kty !== "RSA" : jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Refused(`${what} key type`);
  const pub = alg === "RS256" ? { kty: jwk.kty, n: jwk.n, e: jwk.e } : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const key = await crypto.subtle.importKey("jwk", pub, ALGS[alg].import, false, ["verify"]);
  if (!(await crypto.subtle.verify(ALGS[alg].verify, key, signature, enc.encode(`${parts[0]}.${parts[1]}`)))) {
    throw new Refused(`${what} signature`);
  }
  return claims;
}

/**
 * An ID token's claims, once its signature verifies under the issuer's key
 * for `alg` and its claims hold: the issuer, this audience, unexpired, and
 * the nonce this sign-in sent. Anything else is Refused, by its reason.
 */
export async function verifyIdToken(token: string, p: {
  alg: Alg;
  issuers: readonly string[];
  audience: string;
  nonce: string;
  keys: KeySource;
  now?: number;
}): Promise<Record<string, unknown> & { sub: string }> {
  const claims = await signedClaims(token, p.alg, p.keys, "id token");
  const now = p.now ?? Math.floor(Date.now() / 1000);
  if (!p.issuers.includes(claims.iss as string)) throw new Refused("id token issuer");
  const aud = claims.aud;
  if (!(aud === p.audience || (Array.isArray(aud) && aud.includes(p.audience)))) throw new Refused("id token audience");
  // Finite: JSON's 1e400 is Infinity, a number no time is past.
  if (!Number.isFinite(claims.exp) || (claims.exp as number) < now - 60) throw new Refused("id token expired");
  if (claims.nonce !== p.nonce) throw new Refused("id token nonce");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Refused("id token subject");
  return claims as Record<string, unknown> & { sub: string };
}
