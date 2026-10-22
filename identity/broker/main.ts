// The identity broker: one OpenID Connect provider the operator runs for
// every application, in front of the social providers whose clients the
// operator registers once. An application signs people in through it with no
// client, secret or console of its own (core.ts says how tenants stay apart).
//
// Plain HTTP: TLS is the platform's, as it is the door's. Its one persistent
// secret, BROKER_SECRET, derives the pairwise-subject key and the key that
// signs the round trip through a provider; the ID-token key is minted at
// start and never stored, since its tokens live five minutes and tenants
// fetch a key they do not know.
import { base64url, fromBase64url, jwksSource, type KeySource, randomToken, Refused, signEs256, verifyIdToken } from "../oidc.ts";
import { type AuthRequest, Codes, idTokenClaims, pairwiseKey, pairwiseSubject, parseAuthorize, redeem } from "./core.ts";

const enc = new TextEncoder();

export interface Provider {
  name: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  issuers: readonly string[];
  keys: KeySource;
  clientId: string;
  clientSecret: string;
}

export function google(env: (k: string) => string | undefined): Provider | null {
  const clientId = env("GOOGLE_CLIENT_ID"), clientSecret = env("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return {
    name: "google",
    label: "Google",
    authUrl: env("GOOGLE_AUTH_URL") || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env("GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    keys: jwksSource(env("GOOGLE_JWKS_URL") || "https://www.googleapis.com/oauth2/v3/certs"),
    clientId,
    clientSecret,
  };
}

export async function hmacKey(secret: string, label: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, enc.encode(label)));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// The round trip through a provider: the tenant's request, sealed under the
// broker's key so the provider's callback cannot be handed someone else's.
export async function seal(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const body = base64url(enc.encode(JSON.stringify(claims)));
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body))))}`;
}
export async function unseal(key: CryptoKey, token: unknown): Promise<Record<string, unknown> | null> {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", key, fromBase64url(sig), enc.encode(body)))) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    return typeof claims.exp === "number" && claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    return null;
  }
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

export function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.5 system-ui,sans-serif;background:#fafaf7;color:#1d1b20}
main{max-width:28rem;padding:2rem 1.5rem}h1{font-size:1.5rem;margin:0 0 .75rem}.origin{font-weight:700;word-break:break-all}
a.go{display:inline-flex;align-items:center;min-height:48px;padding:0 20px;border-radius:12px;background:#1f4f9e;color:#fff;font-weight:700;text-decoration:none}
.err{color:#a3331f;font-weight:600}small{color:#5a4d6e}@media (prefers-color-scheme:dark){body{background:#141316;color:#ece7ef}small{color:#b8adc6}.err{color:#f0a06b}}</style></head>
<body><main>${body}</main></body></html>
`, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function back(redirectUri: string, params: Record<string, string>): Response {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function broker(p: { issuer: string; secret: string; providers: Provider[]; codes?: Codes }) {
  if (p.secret.length < 32) throw new Error("BROKER_SECRET is at least 32 characters");
  const issuer = p.issuer.replace(/\/$/, "");
  const providers = new Map(p.providers.map((x) => [x.name, x]));
  const pairwise = await pairwiseKey(p.secret);
  const stateKey = await hmacKey(p.secret, "broker round trip");
  const codes = p.codes ?? new Codes();
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const kid = randomToken(8);
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", signing.publicKey)), kid, alg: "ES256", use: "sig" };
  const callback = (provider: string) => `${issuer}/callback/${provider}`;

  async function authorize(url: URL): Promise<Response> {
    const parsed = parseAuthorize(url.searchParams, [...providers.keys()]);
    if (!parsed.ok) {
      if (parsed.redirect) return back(parsed.redirect, { error: parsed.error, state: url.searchParams.get("state") ?? "" });
      return page("Sign-in refused", `<h1>This sign-in can't continue</h1><p class="err">${esc(parsed.error)}</p>`, 400);
    }
    const r = parsed.request;
    const provider = providers.get(r.provider)!;
    const leg = await seal(stateKey, { r, pn: randomToken(16), exp: Math.floor(Date.now() / 1000) + 600 });
    const host = new URL(r.tenant).host;
    return page(`Sign in to ${host}`, `<h1>Sign in to <span class="origin">${esc(host)}</span></h1>
<p>You'll continue with ${esc(provider.label)}. Only <span class="origin">${esc(r.tenant)}</span> learns that it's you, and it can't tell you apart in any other app.</p>
<p><a class="go" href="${esc(`${issuer}/authorize/continue?leg=${encodeURIComponent(leg)}`)}">Continue with ${esc(provider.label)}</a></p>
<p><small>If you didn't start this from ${esc(host)}, close this page.</small></p>`);
  }

  async function proceed(url: URL): Promise<Response> {
    const leg = await unseal(stateKey, url.searchParams.get("leg"));
    if (!leg) return page("Sign-in expired", `<h1>This sign-in expired</h1><p>Go back to the app and start again.</p>`, 400);
    const r = leg.r as AuthRequest;
    const provider = providers.get(r.provider)!;
    const to = new URL(provider.authUrl);
    to.search = new URLSearchParams({
      client_id: provider.clientId, redirect_uri: callback(provider.name), response_type: "code",
      scope: "openid", state: url.searchParams.get("leg")!, nonce: leg.pn as string, prompt: "select_account",
    }).toString();
    return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
  }

  async function arrive(name: string, url: URL): Promise<Response> {
    const provider = providers.get(name);
    const leg = await unseal(stateKey, url.searchParams.get("state"));
    if (!provider || !leg || (leg.r as AuthRequest).provider !== name) {
      return page("Sign-in refused", `<h1>This sign-in can't continue</h1><p>Go back to the app and start again.</p>`, 400);
    }
    const r = leg.r as AuthRequest;
    // Each refusal says why on the broker's log: the app is told only access_denied.
    if (url.searchParams.get("error")) {
      console.error(`broker: ${name} refused: ${url.searchParams.get("error")}`);
      return back(r.redirectUri, { error: "access_denied", state: r.state });
    }
    const exchanged = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", client_id: provider.clientId,
        client_secret: provider.clientSecret, redirect_uri: callback(provider.name),
      }),
    });
    if (!exchanged.ok) {
      console.error(`broker: ${name}'s token exchange answered ${exchanged.status}: ${await exchanged.text()}`);
      return back(r.redirectUri, { error: "access_denied", state: r.state });
    }
    let providerSub: string;
    try {
      const { id_token } = await exchanged.json();
      ({ sub: providerSub } = await verifyIdToken(String(id_token ?? ""), {
        alg: "RS256", issuers: provider.issuers, audience: provider.clientId, nonce: leg.pn as string, keys: provider.keys,
      }));
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      console.error(`broker: ${name}'s id token refused: ${e.message}`);
      return back(r.redirectUri, { error: "access_denied", state: r.state });
    }
    const sub = await pairwiseSubject(pairwise, r.tenant, provider.name, providerSub);
    const code = codes.issue({ tenant: r.tenant, redirectUri: r.redirectUri, challenge: r.challenge, nonce: r.nonce, sub, provider: provider.name });
    return back(r.redirectUri, { code, state: r.state });
  }

  async function token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const out = await redeem(codes, form);
    if (!out.ok) return json(400, { error: out.error });
    const id_token = await signEs256(signing.privateKey, kid, idTokenClaims({ issuer, grant: out.grant }));
    return json(200, { id_token, token_type: "Bearer", expires_in: 300 });
  }

  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["pairwise"],
    id_token_signing_alg_values_supported: ["ES256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid"],
    providers: [...providers.values()].map((x) => ({ name: x.name, label: x.label })),
  };

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/.well-known/openid-configuration") return json(200, discovery);
      if (req.method === "GET" && path === "/jwks") return json(200, { keys: [publicJwk] });
      if (req.method === "GET" && path === "/authorize") return await authorize(url);
      if (req.method === "GET" && path === "/authorize/continue") return await proceed(url);
      if (req.method === "GET" && path.startsWith("/callback/")) return await arrive(path.slice("/callback/".length), url);
      if (req.method === "POST" && path === "/token") return await token(req);
      if (req.method === "GET" && path === "/health") return json(200, { ok: true });
      return json(404, { error: "not found" });
    } catch (e) {
      console.error(e);
      return json(500, { error: "internal error" });
    }
  };
}

if (import.meta.main) {
  const env = (k: string) => Deno.env.get(k);
  const issuer = env("BROKER_ISSUER");
  const secret = env("BROKER_SECRET");
  if (!issuer || !secret) throw new Error("BROKER_ISSUER and BROKER_SECRET are required");
  const providers = [google(env)].filter((x): x is Provider => x !== null);
  if (providers.length === 0) throw new Error("no provider is configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  Deno.serve({ port: Number(env("PORT") ?? 28443) }, await broker({ issuer, secret, providers }));
}
