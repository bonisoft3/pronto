// A stand-in for Google on a developer's machine, where the operator's Google
// client and its secret are not: the front serves it under /fake/google, and
// it signs in whichever test person the reader picks. It speaks just enough of
// Google's code flow for the front's own leg, and nothing outside a localhost
// broker ever reaches it (main refuses it on any other issuer).
import { base64url, randomToken } from "../oidc.ts";
import { esc, json, page, type Provider } from "../broker/main.ts";

const enc = new TextEncoder();
const ISSUER = "https://fake-google.localhost";
const CLIENT = "fake-google-client";
const SECRET = "fake-google-secret";

/** The test people a reader may sign in as: two, so "a stranger to another
 * person" can be tried by hand. */
export const PEOPLE = ["tester", "tester-2"];

export async function fakeGoogle(issuer: string): Promise<{ provider: Provider; handle: (req: Request, url: URL) => Promise<Response> | null }> {
  const base = `${issuer.replace(/\/$/, "")}/fake/google`;
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "fake-1" };
  const asked = new Map<string, { nonce: string; state: string; redirect: string; expires: number }>();
  const codes = new Map<string, { nonce: string; sub: string; redirect: string; expires: number }>();
  const live = <T extends { expires: number }>(m: Map<string, T>, k: string | null) => {
    const v = k === null ? undefined : m.get(k);
    if (k !== null) m.delete(k);
    return v && v.expires > Date.now() ? v : undefined;
  };

  function authorize(url: URL): Response {
    const q = url.searchParams;
    if (q.get("client_id") !== CLIENT || !q.get("redirect_uri") || !q.get("state") || !q.get("nonce")) {
      return page("Test sign-in refused", `<h1>This test sign-in can't continue</h1>`, 400);
    }
    const id = randomToken(16);
    asked.set(id, { nonce: q.get("nonce")!, state: q.get("state")!, redirect: q.get("redirect_uri")!, expires: Date.now() + 600_000 });
    const links = PEOPLE.map((who) => `<p><a class="go" href="${esc(`${base}/approve?id=${id}&who=${who}`)}">Continue as ${esc(who)}</a></p>`).join("\n");
    return page("Test sign-in", `<h1>Test sign-in</h1>
<p>This is not Google: the broker on this machine has no Google client, so it signs in a test person instead.</p>
${links}`);
  }

  function approve(url: URL): Response {
    const a = live(asked, url.searchParams.get("id"));
    const who = url.searchParams.get("who") ?? "";
    if (!a || !PEOPLE.includes(who)) return page("Test sign-in expired", `<h1>This test sign-in expired</h1><p>Go back to the app and start again.</p>`, 400);
    const code = randomToken(16);
    codes.set(code, { nonce: a.nonce, sub: who, redirect: a.redirect, expires: Date.now() + 60_000 });
    const to = new URL(a.redirect);
    to.searchParams.set("code", code);
    to.searchParams.set("state", a.state);
    return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
  }

  async function token(req: Request): Promise<Response> {
    const f = new URLSearchParams(await req.text());
    const c = live(codes, f.get("code"));
    if (!c || f.get("client_id") !== CLIENT || f.get("client_secret") !== SECRET || f.get("redirect_uri") !== c.redirect) {
      return json(400, { error: "invalid_grant" });
    }
    const now = Math.floor(Date.now() / 1000);
    const head = base64url(enc.encode(JSON.stringify({ alg: "RS256", kid: jwk.kid })));
    const body = base64url(enc.encode(JSON.stringify({ iss: ISSUER, aud: CLIENT, sub: c.sub, nonce: c.nonce, iat: now, exp: now + 300 })));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, enc.encode(`${head}.${body}`)));
    return json(200, { id_token: `${head}.${body}.${base64url(sig)}`, token_type: "Bearer", expires_in: 300 });
  }

  return {
    provider: {
      name: "google", label: "a test person", authUrl: `${base}/auth`, tokenUrl: `${base}/token`, issuers: [ISSUER],
      keys: async (kid) => (kid === jwk.kid ? jwk : undefined), clientId: CLIENT, clientSecret: SECRET,
    },
    handle(req, url) {
      if (req.method === "GET" && url.pathname === "/fake/google/auth") return Promise.resolve(authorize(url));
      if (req.method === "GET" && url.pathname === "/fake/google/approve") return Promise.resolve(approve(url));
      if (req.method === "POST" && url.pathname === "/fake/google/token") return token(req);
      return null;
    },
  };
}
