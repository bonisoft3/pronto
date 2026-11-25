// The broker end to end, every piece Ory's own and unmodified (compose.yaml):
// an app's auth service (mecha's services/auth/oidc.ts) signs a person in
// through Hydra as an `email` provider, Kratos proving the person by the code
// it mails them, read here from Mailpit. Needs Docker.
//   deno test --config deno.json --allow-all identity/ory/broker.integration.test.ts   (from plugins/pronto)
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { signJwt } from "@bonisoft3/mecha/services/auth/jwt.ts";
import { sessionClaims } from "@bonisoft3/mecha/services/auth/claims.ts";
import { type Links, oidc, type Profile, providersFrom, providerStill } from "@bonisoft3/mecha/services/auth/oidc.ts";
import { deviceSession } from "@bonisoft3/mecha/services/auth/session.ts";
import { registerClients } from "../register.ts";

const here = new URL(".", import.meta.url).pathname;
const ORIGIN = "https://app-a.test";
const SECRET = "a-test-secret-that-is-at-least-32-chars";
const HYDRA = "http://localhost:4444", HYDRA_ADMIN = "http://localhost:4445";
const KRATOS = "http://localhost:4433", KRATOS_ADMIN = "http://localhost:4434", MAILPIT = "http://localhost:8025";

async function compose(...args: string[]) {
  const out = await new Deno.Command("docker", { args: ["compose", "-f", `${here}compose.yaml`, ...args], stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`docker compose ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
}

/** A browser's cookies across the broker's hosts, which share localhost. */
function browser() {
  const jar = new Map<string, string>();
  return async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", [...jar].filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };
}

/** The code Kratos mailed `to` after `earlier` messages, once Mailpit holds
 * it (Mailpit lists the newest first). */
async function mailedCode(to: string, earlier = 0): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { messages } = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
    if (messages.length > earlier) {
      const { Text } = await (await fetch(`${MAILPIT}/api/v1/message/${messages[0].ID}`)).json();
      return (Text as string).match(/\b(\d{6})\b/)![1];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code reached ${to}`);
}

/** An app's auth service at ORIGIN, signing in through the broker as its
 * `email` provider, and the profiles it linked. */
/** An app the operator registered first-party, or (`registers`) one that
 * registered itself as its release does. */
async function anApp(origin = ORIGIN, registers = false) {
  const client = registers ? null : await (await fetch(`${HYDRA_ADMIN}/admin/clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "an app", token_endpoint_auth_method: "none", redirect_uris: [`${origin}/auth/oidc/email/callback`],
      grant_types: ["authorization_code"], response_types: ["code"], scope: "openid email profile", subject_type: "pairwise", skip_consent: true,
    }),
  })).json();
  const asked = { OIDC_PROVIDERS: "email", OIDC_EMAIL_ISSUER: HYDRA, OIDC_EMAIL_CLIENT_ID: client?.client_id ?? "origin", OIDC_EMAIL_SCOPE: "openid email profile" };
  // Regression: a self-registering app has two providers through the broker,
  // since one pairwise client for both callbacks was refused at sign-in.
  const env: Record<string, string> = registers
    ? await registerClients({ ...asked, OIDC_PROVIDERS: "email,google", OIDC_GOOGLE_ISSUER: HYDRA, OIDC_GOOGLE_CLIENT_ID: "origin" }, origin)
    : asked;
  const providers = providersFrom((name) => env[name]);
  const linked: Profile[] = [];
  const links: Links = {
    userFor(p) {
      linked.push(p);
      return Promise.resolve({ id: "u1", handle: "ada-0001", name: p.name, email: p.email });
    },
    addTo: () => Promise.reject(new Error("no way is added in this test")),
    handleOf: (_p, _i, _s, id) => Promise.resolve(id === "u1" ? { handle: "ada-0001", name: null, email: null } : null),
  };
  const stands = providerStill(providers, links);
  const device = deviceSession({
    secret: SECRET,
    origin: () => origin,
    still: (way, sub) => way.kind === "provider" ? stands(way, sub) : Promise.resolve(null),
    issue: (u, proof) => signJwt(SECRET, sessionClaims(origin, u, proof, Math.floor(Date.now() / 1000) + 60)),
  });
  return { origin, serve: oidc({ secret: SECRET, origin: () => origin, providers, links, device }), linked };
}

/** The reader's way from the app to the broker's login challenge, and back
 * from the broker's answer to the app's callback, signed in. */
async function through(app: Awaited<ReturnType<typeof anApp>>, go: ReturnType<typeof browser>, prove: (challenge: string) => Promise<string>) {
  let res = await app.serve(new Request(`${app.origin}/auth/oidc/email/start?return=/after`))!;
  assertEquals(res.status, 303);
  const appCookies = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  res = await go(res.headers.get("location")!);
  const challenge = new URL(res.headers.get("location")!).searchParams.get("login_challenge")!;
  assert(challenge, `Hydra asks for a login: ${res.headers.get("location")}`);
  // Back through Hydra's consent, which a first-party app skips, to the app.
  let next = await prove(challenge);
  for (let hop = 0; hop < 6 && !next.startsWith(app.origin); hop++) {
    res = await go(next);
    // The consent step naming an app no record vouches for: the reader goes on via POST.
    if (res.status === 200 && new URL(next).pathname === "/consent") {
      const html = await res.text();
      const csrf = html.match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? "";
      const challenge = html.match(/name="consent_challenge"\s+value="([^"]+)"/)?.[1] ?? "";
      const postRes = await go(new URL("/consent", next).toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(next).origin },
        body: new URLSearchParams({ consent_challenge: challenge, csrf, go: "1" }),
      });
      next = new URL(postRes.headers.get("location")!, next).toString();
      continue;
    }
    next = new URL(res.headers.get("location")!, next).toString();
  }
  assert(next.startsWith(`${app.origin}/auth/oidc/email/callback?`), next);
  res = await app.serve(new Request(next, { headers: { cookie: appCookies } }))!;
  assertEquals([res.status, res.headers.get("location")], [303, "/after"]);
  assert(res.headers.getSetCookie().some((c) => /^(__Host-)?mecha_session=/.test(c)), "the device is signed in");
}

/** What Ory's UI does with a flow, as its page's script would: the flow,
 * and a submit carrying its CSRF token. */
async function flowOf(go: ReturnType<typeof browser>, kind: "login" | "registration", challenge: string) {
  const flow = await (await go(`${KRATOS}/self-service/${kind}/browser?login_challenge=${challenge}`, { headers: { accept: "application/json" } })).json();
  const csrf = flow.ui.nodes.find((n: { attributes: { name?: string } }) => n.attributes.name === "csrf_token").attributes.value;
  return async (body: Record<string, unknown>) =>
    await (await go(`${KRATOS}/self-service/${kind}?flow=${flow.id}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ ...body, csrf_token: csrf }) })).json();
}

Deno.test({
  name: "an app signs a person in through the broker by the code Kratos mails them, under a subject of its own",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await compose("up", "-d", "--wait");
    const app = await anApp();
    const email = `ada+${crypto.randomUUID()}@example.test`;
    const person = await (await fetch(`${KRATOS_ADMIN}/admin/identities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_id: "person", traits: { email, name: "Ada" } }),
    })).json();
    const go = browser();
    await through(app, go, async (challenge) => {
      const submit = await flowOf(go, "login", challenge);
      assertEquals((await submit({ method: "code", identifier: email })).state, "sent_email");
      return (await submit({ method: "code", identifier: email, code: await mailedCode(email) })).redirect_browser_to;
    });
    // The app knows the person by the address Kratos verified and a subject
    // of its own, never Kratos's identity id.
    assertEquals(app.linked.length, 1);
    const [p] = app.linked;
    assertEquals([p.provider, p.issuer, p.email, p.name], ["email", HYDRA, email, "Ada"]);
    assertMatch(p.sub, /^[0-9a-f]{64}$/);
    assertNotEquals(p.sub, person.id);
    assertEquals(p.proof.amr, ["code"]);
  },
});

Deno.test({
  name: "a reader new to the broker signs up by the code mailed to the address they give, and the app learns it verified",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await compose("up", "-d", "--wait");
    const app = await anApp();
    const email = `bea+${crypto.randomUUID()}@example.test`;
    const go = browser();
    await through(app, go, async (challenge) => {
      const submit = await flowOf(go, "registration", challenge);
      assertEquals((await submit({ method: "code", traits: { email } })).state, "sent_email");
      // A registration answers with a session, and where the browser goes on.
      const done = await submit({ method: "code", traits: { email }, code: await mailedCode(email) });
      return done.continue_with.find((c: { action: string }) => c.action === "redirect_browser_to").redirect_browser_to;
    });
    assertEquals(app.linked.length, 1);
    assertEquals([app.linked[0].email, app.linked[0].proof.amr], [email, ["code"]]);
  },
});

Deno.test({
  name: "one person signing in to apps on two hosts is a subject of its own in each",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await compose("up", "-d", "--wait");
    // Hydra's pairwise subject hashes the redirect's host, so apps on two hosts
    // see two subjects; the address they are both given still names the
    // person in each (docs/decisions/2026-11-24-ory-broker.md).
    const apps = [await anApp("https://app-a.test"), await anApp("https://app-b.test")];
    const email = `di+${crypto.randomUUID()}@example.test`;
    await fetch(`${KRATOS_ADMIN}/admin/identities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema_id: "person", traits: { email } }),
    });
    for (const [i, app] of apps.entries()) {
      const go = browser();
      await through(app, go, async (challenge) => {
        const submit = await flowOf(go, "login", challenge);
        await submit({ method: "code", identifier: email });
        return (await submit({ method: "code", identifier: email, code: await mailedCode(email, i) })).redirect_browser_to;
      });
    }
    assertNotEquals(apps[0].linked[0].sub, apps[1].linked[0].sub);
  },
});

Deno.test({
  name: "a password is no way to sign up, so no one can set one for an address before its owner proves it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await compose("up", "-d", "--wait");
    const app = await anApp();
    const go = browser();
    let res = await app.serve(new Request(`${app.origin}/auth/oidc/email/start?return=/after`))!;
    res = await go(res.headers.get("location")!);
    const challenge = new URL(res.headers.get("location")!).searchParams.get("login_challenge")!;
    const submit = await flowOf(go, "registration", challenge);
    const refused = await submit({ method: "password", traits: { email: `eve+${crypto.randomUUID()}@example.test` }, password: `a long passphrase ${crypto.randomUUID()}` });
    assertEquals(refused.continue_with, undefined);
    assertEquals(refused.session, undefined);
  },
});

Deno.test({
  name: "the stock UI approves no consent, and a signed-in person changes no address the broker signs in by",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await compose("up", "-d", "--wait");
    // Regression: the UI's own consent route named the person from the
    // browser's session and approved clients the broker's step refuses.
    const ui = await fetch("http://localhost:4455/consent?consent_challenge=any", { redirect: "manual" });
    await ui.body?.cancel();
    assert(ui.status >= 400 || !(ui.headers.get("location") ?? "").includes("localhost:4444"), `the UI's consent answered ${ui.status} ${ui.headers.get("location")}`);
    // Regression: an address changed unproven is one its owner may later sign
    // in by a code to, so two people would share the account.
    const app = await anApp();
    const email = `fay+${crypto.randomUUID()}@example.test`;
    const go = browser();
    await through(app, go, async (challenge) => {
      const submit = await flowOf(go, "registration", challenge);
      await submit({ method: "code", traits: { email } });
      const done = await submit({ method: "code", traits: { email }, code: await mailedCode(email) });
      return done.continue_with.find((c: { action: string }) => c.action === "redirect_browser_to").redirect_browser_to;
    });
    const settings = await (await go(`${KRATOS}/self-service/settings/browser`, { headers: { accept: "application/json" } })).json();
    // With profile and password off, settings offers nothing at all.
    const groups = new Set((settings.ui.nodes ?? []).map((n: { group: string }) => n.group));
    assertEquals(groups.has("profile"), false, `settings offers ${[...groups]}`);
  },
});

Deno.test({
  name: "an app registering its own client, as its release does, is named to the reader and learns no address",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await compose("up", "-d", "--wait");
    // No TXT record vouches for app.example (a reserved name no lookup
    // reaches), so the broker treats it as any stranger's app.
    const app = await anApp("https://app.example", true);
    const email = `gil+${crypto.randomUUID()}@example.test`;
    const go = browser();
    await through(app, go, async (challenge) => {
      const submit = await flowOf(go, "registration", challenge);
      await submit({ method: "code", traits: { email } });
      const done = await submit({ method: "code", traits: { email }, code: await mailedCode(email) });
      return done.continue_with.find((c: { action: string }) => c.action === "redirect_browser_to").redirect_browser_to;
    });
    assertEquals(app.linked.length, 1);
    assertEquals(app.linked[0].email ?? null, null);
  },
});

Deno.test({
  name: "direct Hydra DCR is disabled and /broker-api/register refuses skip_consent and sector_identifier_uri",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await compose("up", "-d", "--wait");
    const direct = await fetch(`${HYDRA}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "attacker",
        redirect_uris: ["https://attacker.test/auth/oidc/email/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "openid email",
        subject_type: "pairwise",
      }),
    });
    await direct.body?.cancel();
    assertEquals(direct.status, 404);

    for (const extra of [
      { skip_consent: true },
      { sector_identifier_uri: "https://evil.test/sector.json" },
      { subject_type: "public" },
      { token_endpoint_auth_method: "client_secret_basic" },
    ]) {
      const refused = await fetch("http://localhost:4456/broker-api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "attacker",
          redirect_uris: ["https://attacker.test/auth/oidc/email/callback"],
          ...extra,
        }),
      });
      await refused.body?.cancel();
      assertEquals(refused.status, 400);
    }
  },
});
