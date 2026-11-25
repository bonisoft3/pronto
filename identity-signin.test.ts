// identity.#Signin embedded in a program puts the operator's broker in each
// provider's place on mecha's own auth service, which a release turns on. No
// secret of a provider's reaches the program: the app is a public client named
// by its origin.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";

// As an app embeds it: at the package's root, where `code` is the program
// (here the fixture's `app`) and `cluster` what the app adds to its cluster.
const signin = (settings = "") => paymentProgram()
  .replace(`import "bonisoft.org/plugins/pronto"`, `import (\n  "bonisoft.org/plugins/pronto"\n  "bonisoft.org/plugins/pronto/identity"\n)`)
  .replace("\napp: pronto.#App & {", "\ncode: pronto.#App & {")
  .replace("capabilities: {hatches: {},", "capabilities: {auth: required: false, hatches: {},")
  .replace("_cluster: (pronto.#DefaultCluster & {code: app, statics: []}).out", "_cluster: (pronto.#DefaultCluster & {code: app, statics: []}).out & {surface: targets: cluster.surface.targets}") +
  `\napp: code\ncluster: surface: targets: {}\nidentity.#Signin & {signin: {${settings}}}\n`;

const BROKER = `broker: "https://id.example.com"`;

async function exported(code: string, expression: string) {
  const res = await cue(["export", "-", "-e", expression, "--out", "json"], code);
  return { ...res, value: res.success ? JSON.parse(res.stdout) : undefined };
}

Deno.test("the broker stands in each provider's place, as defaults a deployment overrides and a release turns on", async () => {
  const env = await exported(signin(BROKER), "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.success, true, env.stderr);
  // A local stack signs in by what needs no one else: the release names the providers.
  assertEquals(env.value.OIDC_PROVIDERS, "${OIDC_PROVIDERS:-}");
  assertEquals(env.value.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-https://id.example.com}");
  assertEquals(env.value.OIDC_GOOGLE_CLIENT_ID, "${OIDC_GOOGLE_CLIENT_ID:-origin}");
  assertEquals(env.value.OIDC_GOOGLE_SCOPE, "${OIDC_GOOGLE_SCOPE:-openid profile email}");
  assertEquals(env.value.OIDC_GOOGLE_AUTHORIZE_PARAMS, "${OIDC_GOOGLE_AUTHORIZE_PARAMS:-provider=google}");
  // A public client: the program gives no secret, only the deployment's slot for one.
  assertEquals(env.value.OIDC_GOOGLE_CLIENT_SECRET, "${OIDC_GOOGLE_CLIENT_SECRET:-}");
});

Deno.test("with no broker, each provider is the app's own client, and Google's own button is the auth service's page, never the app's", async () => {
  const direct = `providers: ["google"], clients: google: {client: "c.apps.googleusercontent.com", credential: true}`;
  const env = await exported(signin(direct), "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.success, true, env.stderr);
  assertEquals(env.value.OIDC_GOOGLE_CLIENT_ID, "${OIDC_GOOGLE_CLIENT_ID:-c.apps.googleusercontent.com}");
  assertEquals(env.value.OIDC_GOOGLE_CREDENTIAL, "${OIDC_GOOGLE_CREDENTIAL:-true}");
  assertEquals(env.value.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-}");
  // Google's script writes markup the app's Trusted Types refuse, so it runs
  // only in the auth service's framed page, whose policy the door leaves be.
  const caddy = await exported(signin(direct), `out["docker/Caddyfile"].text`);
  assertEquals(caddy.success, true, caddy.stderr);
  assert(!caddy.value.includes("accounts.google.com"), "the app's policy admits nothing of Google's");
  assertStringIncludes(caddy.value, " /auth/oidc/google/button\n");
  // A credential is Google's alone.
  const apple = await exported(signin(`providers: ["apple"], clients: apple: {client: "x", credential: true}`), "code.capabilities.auth.provider");
  assert(!apple.success, "credential on apple is refused");
});

Deno.test("a client naming its own issuer is that issuer's, beside a broker standing in for the rest", async () => {
  // The Ory broker's `email`: an issuer and a client the operator registered
  // for this app (docs/decisions/2026-11-24-ory-broker.md).
  const both = `${BROKER}, providers: ["google", "email"], clients: email: {issuer: "https://auth.example.com/", client: "c-123"}`;
  const env = await exported(signin(both), "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.success, true, env.stderr);
  assertEquals(env.value.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-https://id.example.com}");
  // As the issuer names itself, which discovery compares exactly.
  assertEquals(env.value.OIDC_EMAIL_ISSUER, "${OIDC_EMAIL_ISSUER:-https://auth.example.com/}");
  assertEquals(env.value.OIDC_EMAIL_CLIENT_ID, "${OIDC_EMAIL_CLIENT_ID:-c-123}");
  assertEquals(env.value.OIDC_EMAIL_SCOPE, "${OIDC_EMAIL_SCOPE:-openid profile email}");
  assertEquals(env.value.OIDC_EMAIL_AUTHORIZE_PARAMS, "${OIDC_EMAIL_AUTHORIZE_PARAMS:-}");
});

Deno.test("the app's cluster runs no broker of its own", async () => {
  const targets = await exported(signin(BROKER), "_cluster.surface.targets");
  assertEquals(targets.success, true, targets.stderr);
  assertEquals("identity-hydra" in targets.value, false);
  assertEquals("identity" in targets.value, false);
});

Deno.test("the terminal draws the way in and never sees the broker's settings", async () => {
  const files = await exported(signin(BROKER), "out");
  assertEquals(files.success, true, files.stderr);
  const auth = files.value["shell/shell.json"].data.auth;
  assertEquals(auth.providers, ["google"]);
  assertEquals("provider" in auth, false);
});

Deno.test("a provider name or broker address that is not one is refused", async () => {
  for (const settings of [`${BROKER}, providers: ["Google"]`, `${BROKER}, providers: []`, `broker: "id.example.com"`, `broker: "https://id.example.com/path"`, ""]) {
    const res = await exported(signin(settings), "{auth: _cluster.surface.targets.auth, provider: code.capabilities.auth.provider}");
    assert(!res.success, settings);
  }
});

// A pages build signs in as a guest: its in-browser cluster turns no provider
// on, so the terminal draws none there, beside a release that does.
Deno.test("every target admits social sign-in providers, pages among them", async () => {
  for (const target of ["pages", "cloudflare", "gcp", "k8s", "docker"]) {
    const program = signin(BROKER).replace("targets: []", `targets: ["${target}"]`);
    const res = await cue(["export", "-", "-e", "out", "--out", "json"], program);
    assertEquals(res.success, true, res.stderr);
  }
});

Deno.test("an iOS host offers Sign in with Apple beside any other provider, as Apple's App Store requires; an Android one need not", async () => {
  const native = (hosts: string, providers: string) =>
    signin(`${BROKER}, providers: ${providers}`).replace("capabilities: {auth: required: false,", `capabilities: {native: ${hosts}, auth: required: false,`);
  const refused = await cue(["export", "-", "-e", "out", "--out", "json"], native(`["android", "ios"]`, `["google"]`));
  assertEquals(refused.success, false, "expected an iOS host with Google alone to fail");
  assertStringIncludes(refused.stderr, "App Store, which requires Sign in with Apple");
  for (const [hosts, providers] of [[`["android", "ios"]`, `["google", "apple"]`], [`["android"]`, `["google"]`]]) {
    const admitted = await cue(["export", "-", "-e", "out", "--out", "json"], native(hosts, providers));
    assertEquals(admitted.success, true, admitted.stderr);
  }
});

Deno.test("a provider signing in by its own button has no redirect, so no native host signs in by it", async () => {
  const direct = `providers: ["google"], clients: google: {client: "c.apps.googleusercontent.com", credential: true}`;
  const withHost = signin(direct).replace("capabilities: {auth: required: false,", `capabilities: {native: ["android"], auth: required: false,`);
  const refused = await cue(["export", "-", "-e", "out", "--out", "json"], withHost);
  assertEquals(refused.success, false, "expected a native host beside Google's button to fail");
  assertStringIncludes(refused.stderr, "google signs in by its own button (credential), which no native host draws");
});

Deno.test("Bluesky needs no client and no broker: AT Protocol's client is the app's origin, and no native host signs in by it", async () => {
  for (const settings of [`providers: ["bluesky"]`, `${BROKER}, providers: ["google", "bluesky"]`]) {
    const env = await exported(signin(settings), "_cluster.surface.targets.auth.compose.environment");
    assertEquals(env.success, true, env.stderr);
    const bluesky = Object.keys(env.value).filter((k) => k.startsWith("OIDC_BLUESKY_")).sort();
    assertEquals(bluesky, ["OIDC_BLUESKY_APPVIEW", "OIDC_BLUESKY_ENTRYWAY"], "nothing of a client's or broker's for Bluesky, only where it starts and reads profiles");
  }
  const withHost = signin(`providers: ["bluesky"]`).replace("capabilities: {auth: required: false,", `capabilities: {native: ["android"], auth: required: false,`);
  const refused = await cue(["export", "-", "-e", "out", "--out", "json"], withHost);
  assertEquals(refused.success, false, "expected a native host beside Bluesky to fail");
  assertStringIncludes(refused.stderr, "bluesky offers no native sign-in yet");
});
