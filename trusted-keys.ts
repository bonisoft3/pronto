// The key set crud verifies tokens by where a release trusts an issuer: the
// stack's own secret, which signs its users' and its service role's tokens,
// as an `oct` key, beside the public keys the issuer signs with. PostgREST
// reads keys from its configuration and fetches no JWKS URL, so a release
// composes this set and gives it to crud as PGRST_JWKS:
//
//   PGRST_JWT_SECRET=... TRUSTED_ISSUER=https://id.example \
//     TRUSTED_JWKS="$(curl -s https://id.example/.well-known/jwks.json)" \
//     deno run --no-config --allow-env trusted-keys.ts
//
// TRUSTED_ISSUER is the issuer as its tokens name it, its OpenID discovery
// document's `issuer`. It may not be the stack's own (STACK_ISSUER): the
// floor admits the cluster's roles from a token naming that issuer, so an
// issuer that names itself so would reach them.
//
// TRUSTED_JWKS is public, and may hold a key the issuer does not sign with
// yet: that is how a rotation is staged
// (docs/identity.md#token-roles-and-trusted-issuers). The output holds the
// stack's secret, so it is a secret too.

/** Members a public key of each type keeps; anything else, a private part above all, is not carried. */
const PUBLIC: Record<string, string[]> = {
  RSA: ["kty", "kid", "use", "alg", "n", "e"],
  EC: ["kty", "kid", "use", "alg", "crv", "x", "y"],
  OKP: ["kty", "kid", "use", "alg", "crv", "x"],
};
const PRIVATE = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** The issuer every token the stack signs names (mecha's services/auth/jwt.ts). */
export const STACK_ISSUER = "mecha:stack";

/** The issuer a release trusts, as its tokens name it; refused where it is the stack's. */
export function trustedIssuer(issuer: string): string {
  const given = issuer.trim();
  if (given === "") throw new Error("TRUSTED_ISSUER is required: the issuer crud trusts, as its tokens name it (its discovery document's `issuer`)");
  if (given === STACK_ISSUER) throw new Error(`TRUSTED_ISSUER is ${STACK_ISSUER}, the issuer the stack's own tokens name: a token it signed would act as the cluster's own roles`);
  return given;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** The set crud verifies by, as JSON; throws, naming the key, on one it must not trust. */
export function keySet(secret: string, issuerKeys: string): string {
  if (secret.length < 32) throw new Error("PGRST_JWT_SECRET is at least 32 characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(issuerKeys);
  } catch {
    throw new Error("TRUSTED_JWKS is not JSON: give the issuer's JWK set, as its /.well-known/jwks.json answers it");
  }
  const keys = (parsed as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("TRUSTED_JWKS holds no keys");
  const kids = new Set<string>();
  const trusted = keys.map((key: Record<string, unknown>, i) => {
    const kid = typeof key?.kid === "string" && key.kid !== "" ? key.kid : null;
    const name = kid ?? `#${i}`;
    // A private part means the set was read from where the issuer keeps its
    // keys, not where it publishes them: refused, never stripped, so the leak
    // is seen.
    const held = PRIVATE.filter((m) => key?.[m] !== undefined);
    if (held.length > 0) throw new Error(`TRUSTED_JWKS key ${name} holds a private part (${held.join(", ")}): give the issuer's public keys alone`);
    const kept = PUBLIC[String(key?.kty)];
    if (!kept) throw new Error(`TRUSTED_JWKS key ${name} is a ${String(key?.kty)} key: an issuer's key is RSA, EC or OKP`);
    if (kid === null) throw new Error(`TRUSTED_JWKS key ${name} has no kid, which a token names its key by`);
    if (kids.has(kid)) throw new Error(`TRUSTED_JWKS names key ${kid} twice`);
    kids.add(kid);
    if (key.use !== undefined && key.use !== "sig") throw new Error(`TRUSTED_JWKS key ${name} is for ${String(key.use)}, not signatures`);
    if (key.key_ops !== undefined && !(Array.isArray(key.key_ops) && key.key_ops.includes("verify"))) {
      throw new Error(`TRUSTED_JWKS key ${name} is for ${JSON.stringify(key.key_ops)}, not verifying signatures`);
    }
    if (key.alg !== undefined && (typeof key.alg !== "string" || /^(HS|none)/i.test(key.alg))) throw new Error(`TRUSTED_JWKS key ${name} names ${String(key.alg)}`);
    return Object.fromEntries(kept.filter((m) => key[m] !== undefined).map((m) => [m, key[m]]));
  });
  const own = { kty: "oct", alg: "HS256", k: base64url(new TextEncoder().encode(secret)) };
  return JSON.stringify({ keys: [own, ...trusted] });
}

if (import.meta.main) {
  const secret = Deno.env.get("PGRST_JWT_SECRET") ?? "";
  const issuer = Deno.env.get("TRUSTED_JWKS") ?? "";
  if (issuer === "") throw new Error("TRUSTED_JWKS is required: the public JWK set of the issuer crud trusts");
  trustedIssuer(Deno.env.get("TRUSTED_ISSUER") ?? "");
  console.log(keySet(secret, issuer));
}
