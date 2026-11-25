// The broker's consent step, in place of Ory's UI's: Hydra asks it what an
// app may know of the person a login was accepted for, and it answers from
// that person's own Kratos identity — the subject of Hydra's consent request,
// read through Kratos's admin API — never from whichever session the
// browser happens to hold when consent runs, so a reader switching accounts
// mid-flow carries no one else's address into an app.
//
// Any app registers its own client (hydra.yml), so a client is the
// operator's — told the person's address and name without a word — when the
// operator registered it first-party (skip_consent) or when every one of its
// callbacks is on one origin whose _pronto-identity TXT record the
// hand-written broker's secret signed (../broker/core.ts, `serve.sh txt`).
// Any other app on one origin is named to the person, who goes on or not, and
// learns only a subject of its own; a client spanning origins is refused.
//   HYDRA_ADMIN=http://hydra:4445 KRATOS_ADMIN=http://kratos:4434 KRATOS_BROWSER=https://id.example \
//   KRATOS_PROVIDERS=google TRUST_ISSUER=https://id.example BROKER_SECRET=… deno run --allow-net --allow-env consent.ts
// It serves start.ts at /start too.
import { tenantOf } from "../broker/core.ts";
import { esc, page, tenantVerifier } from "../broker/main.ts";
import { sanitizeBrand } from "../brand.ts";
import { randomToken, sha256url } from "../oidc.ts";
import { start } from "./start.ts";

export type Admin = { hydra: string; kratos: string; publicOrigin?: string; fetcher?: typeof fetch; trusted: (origin: string) => Promise<boolean> };

const CONSENT_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const isHttps = (req: Request, url: URL) =>
  url.protocol === "https:" || (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";

const requestOrigin = (req: Request, url: URL) => {
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host"))?.split(",")[0].trim();
  return host ? `${isHttps(req, url) ? "https" : "http"}://${host}` : url.origin;
};

async function challengeCookieName(https: boolean, challenge: string): Promise<string> {
  const tag = (await sha256url(challenge)).slice(0, 16);
  return `${https ? "__Host-" : ""}broker_consent_csrf_${tag}`;
}

const csrfCookieHeader = (name: string, https: boolean, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${https ? "; Secure" : ""}; Max-Age=${maxAge}`;

function cookieOf(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function equalToken(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function consentPage(title: string, body: string, cookie: string): Response {
  const res = page(title, body);
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", CONSENT_PAGE_CSP);
  headers.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, headers });
}

type ClientInfo = {
  subject_type?: string;
  sector_identifier_uri?: string;
  skip_consent?: boolean;
  redirect_uris?: string[];
  client_name?: string;
  logo_uri?: string;
  metadata?: { brand?: unknown };
};
const MAX_LOGO_BYTES = 262_144;
const MAX_REGISTER_BYTES = 4096;
const LOGO_TIMEOUT_MS = 5000;
const REGISTER_KEYS = new Set([
  "client_name",
  "logo_uri",
  "redirect_uris",
  "token_endpoint_auth_method",
  "grant_types",
  "response_types",
  "scope",
  "subject_type",
]);

function badRegistration(reason: string): Response {
  return Response.json({ error: "invalid_client_metadata", error_description: reason }, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });
}

async function readBoundedBytes(res: Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > 0 && bytes.byteLength <= limit ? bytes : null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
type ConsentRequest = {
  subject: string;
  requested_scope: string[];
  requested_access_token_audience: string[];
  client: ClientInfo;
};
type LoginRequest = { client: ClientInfo };
type Identity = { traits: { email?: string; name?: string }; verifiable_addresses?: { value: string; verified: boolean }[] };

const go = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

/** The claims an app is given for the scopes it asked: its verified address
 * for `email`, the name the person gave for `profile`. */
export function claimsOf(identity: Identity, scopes: string[]): Record<string, unknown> {
  const email = identity.traits.email;
  const verified = identity.verifiable_addresses?.some((a) => a.value === email && a.verified) ?? false;
  return {
    ...(scopes.includes("email") && email !== undefined ? { email, email_verified: verified } : {}),
    ...(scopes.includes("profile") && identity.traits.name ? { name: identity.traits.name } : {}),
  };
}

/** The one origin every callback of a client is on, or null. */
export function originOf(redirectUris: readonly string[] | undefined): string | null {
  const origins = new Set((redirectUris ?? []).map((u) => URL.parse(u)?.origin ?? ""));
  if (origins.size !== 1) return null;
  return tenantOf([...origins][0]);
}

const APP_CALLBACK_PATH = /^\/auth\/oidc\/[a-z][a-z0-9]*\/callback$/;

/** True only when every redirect URI is a clean pronto OIDC callback path. */
export function hasOnlyAppCallbacks(redirectUris: readonly string[] | undefined): boolean {
  if (!redirectUris || redirectUris.length === 0) return false;
  return redirectUris.every((raw) => {
    const u = URL.parse(raw);
    return u !== null && u.search === "" && u.hash === "" && APP_CALLBACK_PATH.test(u.pathname);
  });
}

export function consent(admin: Admin): (req: Request) => Promise<Response> {
  const fetcher = admin.fetcher ?? fetch;
  const json = async (url: string, init?: RequestInit) => {
    const res = await fetcher(url, init);
    // The path and status alone: the query carries the live challenge.
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${new URL(url).pathname}: ${res.status}`);
    return await res.json();
  };
  const resolveChallenge = async (url: URL) => {
    const loginChallenge = url.searchParams.get("login_challenge");
    const consentChallenge = url.searchParams.get("consent_challenge");
    if (!loginChallenge && !consentChallenge) return null;
    const challengeParam = loginChallenge
      ? `login_challenge=${encodeURIComponent(loginChallenge)}`
      : `consent_challenge=${encodeURIComponent(consentChallenge!)}`;
    const asked = loginChallenge
      ? (await json(`${admin.hydra}/admin/oauth2/auth/requests/login?${challengeParam}`) as LoginRequest)
      : (await json(`${admin.hydra}/admin/oauth2/auth/requests/consent?${challengeParam}`) as ConsentRequest);
    const client = asked.client;
    const origin = originOf(client.redirect_uris);
    const trusted = !client.sector_identifier_uri && (client.skip_consent === true || (origin !== null && hasOnlyAppCallbacks(client.redirect_uris) && await admin.trusted(origin)));
    // Open DCR is unauthenticated, so client-supplied branding is trusted only
    // for operator-registered first-party clients (skip_consent). TXT-vouched
    // DCR apps get a host label here and receive custom visuals from Electric.
    const brand = client.skip_consent === true
      ? sanitizeBrand({
        name: client.client_name,
        logo: client.logo_uri,
        ...(client.metadata?.brand && typeof client.metadata.brand === "object" ? client.metadata.brand : {}),
      }, origin)
      : (origin ? { name: new URL(origin).host } : null);
    return { challengeParam, origin, trusted, brand };
  };
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.method === "GET" && url.pathname === "/broker-api/brand") {
      const resolved = await resolveChallenge(url);
      if (!resolved) return new Response("login_challenge or consent_challenge required", { status: 400 });
      const brand = resolved.trusted && resolved.brand?.logo
        ? { ...resolved.brand, logo: `/broker-api/logo?${resolved.challengeParam}` }
        : resolved.brand;
      return Response.json({ trusted: resolved.trusted, origin: resolved.origin, brand }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "POST" && url.pathname === "/broker-api/register") {
      const rawBytes = await readBoundedBytes(new Response(req.body, { headers: req.headers }), MAX_REGISTER_BYTES);
      if (!rawBytes) return badRegistration("request body missing or oversized");
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(rawBytes));
      } catch {
        return badRegistration("invalid json body");
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return badRegistration("registration payload must be an object");
      }
      const body = raw as Record<string, unknown>;
      for (const k of Object.keys(body)) {
        if (!REGISTER_KEYS.has(k)) return badRegistration(`unsupported field: ${k}`);
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
        return badRegistration("only public clients (token_endpoint_auth_method: none) are allowed");
      }
      if (body.subject_type !== undefined && body.subject_type !== "pairwise") {
        return badRegistration("only pairwise subjects are allowed");
      }
      if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.length !== 1 || body.grant_types[0] !== "authorization_code")) {
        return badRegistration("only grant_types: [authorization_code] is allowed");
      }
      if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== "code")) {
        return badRegistration("only response_types: [code] is allowed");
      }
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 8 || !body.redirect_uris.every((u) => typeof u === "string")) {
        return badRegistration("redirect_uris must be 1..8 callback URLs");
      }
      const redirectUris = body.redirect_uris as string[];
      const origin = originOf(redirectUris);
      if (origin === null) return badRegistration("all redirect_uris must share one https origin");
      const safe = sanitizeBrand({ name: body.client_name, logo: body.logo_uri }, origin);
      const created = await json(`${admin.hydra}/admin/clients`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: safe?.name ?? new URL(origin).host,
          ...(safe?.logo ? { logo_uri: safe.logo } : {}),
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          scope: "openid email profile",
          subject_type: "pairwise",
          skip_consent: false,
        }),
      }) as { client_id?: unknown };
      if (typeof created.client_id !== "string") {
        return new Response("registration failed", { status: 502, headers: { "cache-control": "no-store" } });
      }
      return Response.json({ client_id: created.client_id }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    if (req.method === "GET" && url.pathname === "/broker-api/logo") {
      const resolved = await resolveChallenge(url);
      if (!resolved) return new Response("login_challenge or consent_challenge required", { status: 400 });
      if (!resolved.trusted || resolved.origin === null) return new Response("not found", { status: 404 });
      const srcParam = url.searchParams.get("src");
      const target = srcParam
        ? sanitizeBrand({ logo: srcParam }, resolved.origin)?.logo
        : resolved.brand?.logo;
      if (!target) return new Response("not found", { status: 404 });
      const res = await fetcher(target, { redirect: "error", signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel();
        return new Response("logo unavailable", { status: 502 });
      }
      const ct = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!ct.startsWith("image/")) {
        await res.body?.cancel();
        return new Response("logo unavailable", { status: 502 });
      }
      const bytes = await readBoundedBytes(res, MAX_LOGO_BYTES);
      if (!bytes) return new Response("logo unavailable", { status: 502 });
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": ct,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
        },
      });
    }
    if ((req.method !== "GET" && req.method !== "POST") || url.pathname !== "/consent") return new Response("not found", { status: 404 });
    const effectiveOrigin = admin.publicOrigin ?? requestOrigin(req, url);
    const https = effectiveOrigin.startsWith("https://");
    let challenge = url.searchParams.get("consent_challenge");
    let verdict: string | null = null;
    let postCookieName: string | null = null;
    if (req.method === "POST") {
      const originHeader = req.headers.get("origin");
      if (originHeader !== null && originHeader !== effectiveOrigin) return new Response("forbidden", { status: 403 });
      const form = await req.formData();
      const postChallenge = form.get("consent_challenge");
      const postGo = form.get("go");
      const csrf = form.get("csrf");
      if (typeof postChallenge !== "string" || !postChallenge) return new Response("consent_challenge required", { status: 400 });
      if (postGo !== "1" && postGo !== "0") return new Response("go must be 0 or 1", { status: 400 });
      postCookieName = await challengeCookieName(https, postChallenge);
      const cookie = cookieOf(req, postCookieName);
      if (typeof csrf !== "string" || !cookie || !equalToken(csrf, cookie)) return new Response("forbidden", { status: 403 });
      challenge = postChallenge;
      verdict = postGo;
    }
    if (!challenge) return new Response("consent_challenge required", { status: 400 });
    const at = `${admin.hydra}/admin/oauth2/auth/requests/consent`;
    const q = `consent_challenge=${encodeURIComponent(challenge)}`;
    const put = async (verb: "accept" | "reject", body: unknown) => {
      const res = go((await json(`${at}/${verb}?${q}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).redirect_to);
      if (!postCookieName) return res;
      const headers = new Headers(res.headers);
      headers.append("set-cookie", csrfCookieHeader(postCookieName, https, "", 0));
      return new Response(null, { status: res.status, headers });
    };
    const asked = await json(`${at}?${q}`) as ConsentRequest;
    if (asked.client.subject_type !== "pairwise") {
      return put("reject", { error: "access_denied", error_description: "clients must use pairwise subjects" });
    }
    if (asked.client.sector_identifier_uri) {
      return put("reject", { error: "access_denied", error_description: "clients must not set sector_identifier_uri" });
    }
    const origin = originOf(asked.client.redirect_uris);
    if (origin === null) return put("reject", { error: "access_denied", error_description: "a client's callbacks are on one origin" });
    if (verdict === "0") return put("reject", { error: "access_denied", error_description: "the person declined" });
    if (asked.client.skip_consent === true || (hasOnlyAppCallbacks(asked.client.redirect_uris) && await admin.trusted(origin))) {
      const identity = await json(`${admin.kratos}/admin/identities/${encodeURIComponent(asked.subject)}`) as Identity;
      return put("accept", {
        grant_scope: asked.requested_scope,
        grant_access_token_audience: asked.requested_access_token_audience,
        session: { id_token: claimsOf(identity, asked.requested_scope) },
      });
    }
    if (verdict === "1") return put("accept", { grant_scope: ["openid"], grant_access_token_audience: [] });
    const host = new URL(origin).host;
    const csrf = randomToken(16);
    const cookieName = await challengeCookieName(https, challenge);
    return consentPage(
      `Sign in to ${host}`,
      `<style>form{display:flex;gap:.75rem;flex-wrap:wrap;margin:1rem 0}button{font:inherit;min-height:48px;padding:0 20px;border-radius:12px;border:1px solid currentColor;background:transparent;color:inherit;font-weight:700;cursor:pointer}button.go{border:0;background:#1f4f9e;color:#fff}</style><h1>Sign in to <span class="origin">${esc(host)}</span></h1>
<p>Only <span class="origin">${esc(origin)}</span> learns that it's you, and apps on other hosts can't tell it's you. It isn't told your address.</p>
<form method="post" action="/consent"><input type="hidden" name="consent_challenge" value="${esc(challenge)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" name="go" value="1" class="go">Continue</button><button type="submit" name="go" value="0">Cancel</button></form>
<p><small>If you didn't start this from ${esc(host)}, close this page.</small></p>`,
      csrfCookieHeader(cookieName, https, csrf, 600),
    );
  };
}

if (import.meta.main) {
  const need = (name: string) => Deno.env.get(name) ?? (() => { throw new Error(`${name} is required`); })();
  const trusted = await tenantVerifier({ issuer: need("TRUST_ISSUER"), secret: need("BROKER_SECRET") });
  const rawOrigin = Deno.env.get("PUBLIC_ORIGIN");
  const publicOrigin = rawOrigin ? new URL(rawOrigin).origin : undefined;
  const consenting = consent({ hydra: need("HYDRA_ADMIN"), kratos: need("KRATOS_ADMIN"), publicOrigin, trusted });
  // KRATOS_PROVIDERS: the social providers Kratos signs in with, by id.
  const starting = start({ hydra: need("HYDRA_ADMIN"), kratos: need("KRATOS_BROWSER"), providers: (Deno.env.get("KRATOS_PROVIDERS") ?? "").split(",").filter(Boolean) });
  Deno.serve({ port: Number(Deno.env.get("PORT") ?? "4456") }, (req) => new URL(req.url).pathname === "/start" ? starting(req) : consenting(req));
}
