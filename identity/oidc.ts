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

export function jwksSource(url: string, fetcher: typeof fetch = fetch): KeySource {
  let keys: Jwk[] = [];
  return async (kid) => {
    let key = keys.find((k) => k.kid === kid);
    if (key) return key;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    keys = ((await res.json()) as { keys: Jwk[] }).keys;
    key = keys.find((k) => k.kid === kid);
    return key;
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
  const parts = token.split(".");
  if (parts.length !== 3) throw new Refused("id token malformed");
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
  } catch {
    throw new Refused("id token malformed");
  }
  if (header.alg !== p.alg || typeof header.kid !== "string") throw new Refused(`id token not ${p.alg}`);
  const jwk = await p.keys(header.kid);
  if (!jwk) throw new Refused("id token key unknown");
  const pub = p.alg === "RS256" ? { kty: jwk.kty, n: jwk.n, e: jwk.e } : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const key = await crypto.subtle.importKey("jwk", pub, ALGS[p.alg].import, false, ["verify"]);
  if (!(await crypto.subtle.verify(ALGS[p.alg].verify, key, fromBase64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`)))) {
    throw new Refused("id token signature");
  }
  const now = p.now ?? Math.floor(Date.now() / 1000);
  if (!p.issuers.includes(claims.iss as string)) throw new Refused("id token issuer");
  const aud = claims.aud;
  if (!(aud === p.audience || (Array.isArray(aud) && aud.includes(p.audience)))) throw new Refused("id token audience");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Refused("id token expired");
  if (claims.nonce !== p.nonce) throw new Refused("id token nonce");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Refused("id token subject");
  return claims as Record<string, unknown> & { sub: string };
}
