// What the identity broker decides, apart from its network: which tenant a
// request is for, the one redirect that tenant may receive, the subject a
// person has in that tenant, and the single-use codes that carry a sign-in
// back. One operator runs the broker; every application is its own tenant.
//
// A tenant is an application's origin, which is also its OAuth client id: a
// public client, proving its code with PKCE, holding no secret and needing no
// registration. Tenants are never merged. A person's subject is a keyed hash
// of the tenant, the provider and the provider's subject, so two applications
// see unrelated subjects for one person, and an application's redirect is its
// own origin's callback for the provider it asks for, exact, never shared or
// wildcarded: the one mecha's auth service signs in at.
import { base64url, sha256url } from "../oidc.ts";


/**
 * The tenant a client id names, or null: an https origin, bare (no path,
 * query, fragment or credentials), its host lowercase. http is refused, even
 * on localhost: the dev door is https.
 */
export function tenantOf(clientId: unknown): string | null {
  if (typeof clientId !== "string" || clientId.length > 255) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.origin === clientId ? url.origin : null;
}

/** The one redirect a tenant may receive for a provider: mecha's auth
 * service's callback for the provider of that name. */
export const callbackOf = (tenant: string, provider: string) => `${tenant}/auth/oidc/${provider}/callback`;

const enc = new TextEncoder();

/** The key a pairwise subject is derived under, from the operator's secret. */
export function pairwiseKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("the pairwise secret is at least 32 characters");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** A person's subject in one tenant: unrelated across tenants and providers. */
export async function pairwiseSubject(key: CryptoKey, tenant: string, provider: string, providerSub: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${tenant}\u0000${provider}\u0000${providerSub}`));
  return base64url(new Uint8Array(mac));
}

/** A tenant's sign-in request, as /authorize accepts it. */
export interface AuthRequest {
  tenant: string;
  redirectUri: string;
  provider: string;
  state: string;
  nonce: string;
  challenge: string;
}

/**
 * The request /authorize is asked for, or why not. `redirect` says whether
 * the error may be sent to the redirect: only once the client id and the
 * redirect are known to belong together, and never otherwise.
 */
export function parseAuthorize(q: URLSearchParams, providers: readonly string[]):
  | { ok: true; request: AuthRequest }
  | { ok: false; error: string; redirect: string | null } {
  const tenant = tenantOf(q.get("client_id"));
  if (!tenant) return { ok: false, error: "client_id is not an https origin", redirect: null };
  // The redirect is the provider's, so a provider the broker does not offer
  // names none it could trust.
  const provider = q.get("provider") ?? "";
  if (!providers.includes(provider)) return { ok: false, error: `provider is not one of ${providers.join(", ")}`, redirect: null };
  const redirect = callbackOf(tenant, provider);
  if (q.get("redirect_uri") !== redirect) return { ok: false, error: `redirect_uri is not ${redirect}`, redirect: null };
  const state = q.get("state") ?? "";
  const fail = (error: string) => ({ ok: false as const, error, redirect });
  if (state === "" || state.length > 1024) return { ok: false, error: "state required", redirect: null };
  if (q.get("response_type") !== "code") return fail("unsupported_response_type");
  if (!(q.get("scope") ?? "").split(" ").includes("openid")) return fail("invalid_scope");
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "")) return fail("invalid_request");
  const nonce = q.get("nonce") ?? "";
  if (nonce === "" || nonce.length > 256) return fail("invalid_request");
  return { ok: true, request: { tenant, redirectUri: redirect, provider, state, nonce, challenge: q.get("code_challenge")! } };
}

export const pkceMatches = async (verifier: unknown, challenge: string) =>
  typeof verifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && (await sha256url(verifier)) === challenge;

/** What a code carries from the provider's callback to the tenant's /token. */
export interface Grant {
  tenant: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  sub: string;
  provider: string;
}

/**
 * Single-use, short-lived codes. In memory: the broker runs as one instance,
 * and a code it forgets on restart is a sign-in the reader repeats.
 */
export class Codes {
  #grants = new Map<string, { grant: Grant; expires: number }>();
  constructor(readonly ttlMs = 60_000, readonly now = () => Date.now()) {}
  issue(grant: Grant, code = crypto.randomUUID()): string {
    for (const [c, g] of this.#grants) if (g.expires <= this.now()) this.#grants.delete(c);
    this.#grants.set(code, { grant, expires: this.now() + this.ttlMs });
    return code;
  }
  take(code: unknown): Grant | null {
    if (typeof code !== "string") return null;
    const held = this.#grants.get(code);
    this.#grants.delete(code);
    return held && held.expires > this.now() ? held.grant : null;
  }
}

/**
 * The grant a /token request redeems, or why not: the code taken once, for
 * the tenant and redirect it was issued to, proven by the PKCE verifier.
 */
export async function redeem(codes: Codes, form: URLSearchParams):
  Promise<{ ok: true; grant: Grant } | { ok: false; error: string }> {
  if (form.get("grant_type") !== "authorization_code") return { ok: false, error: "unsupported_grant_type" };
  const grant = codes.take(form.get("code"));
  if (!grant) return { ok: false, error: "invalid_grant" };
  if (form.get("client_id") !== grant.tenant || form.get("redirect_uri") !== grant.redirectUri) return { ok: false, error: "invalid_grant" };
  if (!(await pkceMatches(form.get("code_verifier"), grant.challenge))) return { ok: false, error: "invalid_grant" };
  return { ok: true, grant };
}

/** The ID token a tenant receives: its audience is the tenant alone. */
export function idTokenClaims(p: { issuer: string; grant: Grant; now?: number }): Record<string, unknown> {
  const now = p.now ?? Math.floor(Date.now() / 1000);
  return {
    iss: p.issuer,
    aud: p.grant.tenant,
    azp: p.grant.tenant,
    sub: p.grant.sub,
    nonce: p.grant.nonce,
    idp: p.grant.provider,
    iat: now,
    exp: now + 300,
  };
}
