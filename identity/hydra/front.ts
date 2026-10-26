// The identity broker with Ory Hydra as its OpenID Connect provider: Hydra
// issues, signs and redeems every code and ID token, and this front keeps
// what Hydra leaves to a login app — the leg through a social provider and the
// subject a tenant may know — on the broker's one address, so the issuer, the
// provider's registered redirect and every application's settings stay as
// the broker's were.
//
// The front answers Hydra's login and consent steps and the provider's
// callback, and passes Hydra's public routes through. Hydra's admin API is
// never public: the front alone reaches it.
//
// A tenant is still registered by nobody: the first /oauth2/auth for an https
// origin naming its own callback registers that origin as a public client of
// Hydra, its client id the origin and its redirects its callbacks, one per
// provider (core.ts). Hydra then holds the tenant to them. The subject is the
// broker's pairwise one, under the same secret, so a person keeps the subject
// each application already linked.
import { Refused, randomToken, verifyIdToken } from "../oidc.ts";
import { callbackOf, pairwiseKey, pairwiseSubject, tenantOf } from "../broker/core.ts";
import { esc, google, hmacKey, json, page, type Provider, seal, unseal } from "../broker/main.ts";
import { fakeGoogle } from "./fake.ts";

export interface Hydra {
  /** Hydra's public API, as the front reaches it. */
  public: string;
  /** Hydra's admin API, never exposed. */
  admin: string;
}

// The routes of Hydra's public API a tenant or a browser uses; nothing else
// of Hydra is reachable through the front.
const PASSED = /^\/(\.well-known\/(openid-configuration|jwks\.json)|oauth2\/(auth|token|fallbacks\/[a-z]+))$/;

const go = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

export async function front(p: {
  issuer: string;
  secret: string;
  providers: Provider[];
  hydra: Hydra;
  fetcher?: typeof fetch;
  /** Routes served beside the broker's own: a stand-in provider's (fake.ts). */
  extra?: (req: Request, url: URL) => Promise<Response> | null;
}) {
  if (p.secret.length < 32) throw new Error("BROKER_SECRET is at least 32 characters");
  const fetcher = p.fetcher ?? fetch;
  const issuer = p.issuer.replace(/\/$/, "");
  const providers = new Map(p.providers.map((x) => [x.name, x]));
  const pairwise = await pairwiseKey(p.secret);
  const stateKey = await hmacKey(p.secret, "hydra login round trip");
  const callback = (provider: string) => `${issuer}/callback/${provider}`;

  async function admin(method: string, path: string, body?: unknown): Promise<Response> {
    return await fetcher(`${p.hydra.admin}/admin${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function adminJson(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await admin(method, path, body);
    if (!res.ok) throw new Error(`hydra ${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    return await res.json();
  }

  // The tenant as Hydra's client: its origin, public, PKCE-bound, its one
  // redirect per provider the broker offers.
  async function register(tenant: string): Promise<void> {
    const client = {
      client_id: tenant,
      client_name: new URL(tenant).host,
      redirect_uris: [...providers.keys()].map((name) => callbackOf(tenant, name)).sort(),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid",
    };
    const path = `/clients/${encodeURIComponent(tenant)}`;
    const held = await admin("GET", path);
    if (held.status === 404) {
      await held.body?.cancel();
      await adminJson("POST", "/clients", client);
      return;
    }
    if (!held.ok) throw new Error(`hydra GET client: ${held.status}`);
    const was = await held.json();
    if (JSON.stringify([...(was.redirect_uris ?? [])].sort()) !== JSON.stringify(client.redirect_uris)) await adminJson("PUT", path, client);
  }

  async function pass(req: Request, url: URL): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.delete("host");
    const res = await fetcher(`${p.hydra.public}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  async function authorize(req: Request, url: URL): Promise<Response> {
    // Only an origin asking for its own callback is registered; anything else
    // reaches Hydra as it came, and Hydra refuses a client it does not hold
    // without redirecting.
    const tenant = tenantOf(url.searchParams.get("client_id"));
    const provider = url.searchParams.get("provider") ?? "";
    if (tenant && providers.has(provider) && url.searchParams.get("redirect_uri") === callbackOf(tenant, provider)) await register(tenant);
    return await pass(req, url);
  }

  async function login(url: URL): Promise<Response> {
    const challenge = url.searchParams.get("login_challenge") ?? "";
    const r = await adminJson("GET", `/oauth2/auth/requests/login?login_challenge=${encodeURIComponent(challenge)}`);
    const tenant = (r.client as { client_id: string }).client_id;
    const name = new URL(r.request_url as string).searchParams.get("provider") ?? "";
    const provider = providers.get(name);
    if (!provider) {
      const { redirect_to } = await adminJson("PUT", `/oauth2/auth/requests/login/reject?login_challenge=${encodeURIComponent(challenge)}`, {
        error: "invalid_request", error_description: `provider is not one of ${[...providers.keys()].join(", ")}`,
      });
      return go(redirect_to as string);
    }
    const leg = await seal(stateKey, { c: challenge, t: tenant, p: name, pn: randomToken(16), exp: Math.floor(Date.now() / 1000) + 600 });
    const host = new URL(tenant).host;
    return page(`Sign in to ${host}`, `<h1>Sign in to <span class="origin">${esc(host)}</span></h1>
<p>You'll continue with ${esc(provider.label)}. Only <span class="origin">${esc(tenant)}</span> learns that it's you, and it can't tell you apart in any other app.</p>
<p><a class="go" href="${esc(`${issuer}/login/continue?leg=${encodeURIComponent(leg)}`)}">Continue with ${esc(provider.label)}</a></p>
<p><small>If you didn't start this from ${esc(host)}, close this page.</small></p>`);
  }

  async function proceed(url: URL): Promise<Response> {
    const leg = await unseal(stateKey, url.searchParams.get("leg"));
    if (!leg) return page("Sign-in expired", `<h1>This sign-in expired</h1><p>Go back to the app and start again.</p>`, 400);
    const provider = providers.get(leg.p as string)!;
    const to = new URL(provider.authUrl);
    to.search = new URLSearchParams({
      client_id: provider.clientId, redirect_uri: callback(provider.name), response_type: "code",
      scope: "openid", state: url.searchParams.get("leg")!, nonce: leg.pn as string, prompt: "select_account",
    }).toString();
    return go(to.toString());
  }

  async function arrive(name: string, url: URL): Promise<Response> {
    const provider = providers.get(name);
    const leg = await unseal(stateKey, url.searchParams.get("state"));
    if (!provider || !leg || leg.p !== name) {
      return page("Sign-in refused", `<h1>This sign-in can't continue</h1><p>Go back to the app and start again.</p>`, 400);
    }
    const challenge = encodeURIComponent(leg.c as string);
    // Each refusal says why on the broker's log: the app is told only access_denied.
    const refuse = async (why: string) => {
      console.error(`broker: ${why}`);
      const { redirect_to } = await adminJson("PUT", `/oauth2/auth/requests/login/reject?login_challenge=${challenge}`, { error: "access_denied" });
      return go(redirect_to as string);
    };
    if (url.searchParams.get("error")) return await refuse(`${name} refused: ${url.searchParams.get("error")}`);
    const exchanged = await fetcher(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", client_id: provider.clientId,
        client_secret: provider.clientSecret, redirect_uri: callback(provider.name),
      }),
    });
    if (!exchanged.ok) return await refuse(`${name}'s token exchange answered ${exchanged.status}: ${await exchanged.text()}`);
    let providerSub: string;
    try {
      const { id_token } = await exchanged.json();
      ({ sub: providerSub } = await verifyIdToken(String(id_token ?? ""), {
        alg: "RS256", issuers: provider.issuers, audience: provider.clientId, nonce: leg.pn as string, keys: provider.keys,
      }));
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return await refuse(`${name}'s id token refused: ${e.message}`);
    }
    // Hydra holds the challenge to the tenant it was issued for, so the subject
    // is derived for that tenant and no other.
    const sub = await pairwiseSubject(pairwise, leg.t as string, provider.name, providerSub);
    const { redirect_to } = await adminJson("PUT", `/oauth2/auth/requests/login/accept?login_challenge=${challenge}`, {
      subject: sub, remember: false, context: { idp: provider.name },
    });
    return go(redirect_to as string);
  }

  // Consent is the page the reader already saw: a subject alone, for the
  // tenant that asked, granted without a second question.
  async function consent(url: URL): Promise<Response> {
    const challenge = encodeURIComponent(url.searchParams.get("consent_challenge") ?? "");
    const r = await adminJson("GET", `/oauth2/auth/requests/consent?consent_challenge=${challenge}`);
    const idp = (r.context as { idp?: string } | null)?.idp;
    const { redirect_to } = await adminJson("PUT", `/oauth2/auth/requests/consent/accept?consent_challenge=${challenge}`, {
      grant_scope: ((r.requested_scope as string[]) ?? []).filter((s) => s === "openid"),
      grant_access_token_audience: [],
      remember: false,
      session: { id_token: idp ? { idp } : {} },
    });
    return go(redirect_to as string);
  }

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      const extra = p.extra?.(req, url);
      if (extra) return await extra;
      if (req.method === "GET" && path === "/oauth2/auth") return await authorize(req, url);
      if (PASSED.test(path)) return await pass(req, url);
      if (req.method === "GET" && path === "/login") return await login(url);
      if (req.method === "GET" && path === "/login/continue") return await proceed(url);
      if (req.method === "GET" && path === "/consent") return await consent(url);
      if (req.method === "GET" && path.startsWith("/callback/")) return await arrive(path.slice("/callback/".length), url);
      if (req.method === "GET" && path === "/health") {
        // Hydra not yet listening is not ready, not an error.
        const ok = await fetcher(`${p.hydra.public}/health/ready`).then(async (r) => (await r.body?.cancel(), r.ok), () => false);
        return json(ok ? 200 : 503, { ok });
      }
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
  // The stand-in for Google, asked for by name and only on the developer's
  // own machine: a broker anyone else reaches never signs in a test person.
  let extra;
  if (providers.length === 0 && env("BROKER_FAKE_GOOGLE") === "1") {
    if (new URL(issuer).hostname !== "localhost") throw new Error(`BROKER_FAKE_GOOGLE is for a localhost broker, not ${issuer}`);
    const fake = await fakeGoogle(issuer);
    providers.push(fake.provider);
    extra = fake.handle;
    console.error("broker: no Google client, so it signs in test people (hydra/fake.ts)");
  }
  if (providers.length === 0) throw new Error("no provider is configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const hydra = { public: env("HYDRA_PUBLIC") ?? "http://127.0.0.1:28453", admin: env("HYDRA_ADMIN") ?? "http://127.0.0.1:28455" };
  Deno.serve({ port: Number(env("PORT") ?? 28443) }, await front({ issuer, secret, providers, hydra, extra }));
}
