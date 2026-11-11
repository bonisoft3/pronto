// A provider an app signs in through reaches both halves that run it: the
// terminal, which draws its way in and adopts its session (shell.json's auth),
// and the cluster's auth service, which runs the sign-in and is refused a start
// without the provider's client (mecha's capabilities.signIn).
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";

const withAuth = (auth: string) =>
  paymentProgram().replace("capabilities: {hatches: {},", `capabilities: {auth: ${auth}, hatches: {},`);

async function exported(code: string, expression: string) {
  const res = await cue(["export", "-", "-e", expression, "--out", "json"], code);
  return { ...res, value: res.success ? JSON.parse(res.stdout) : undefined };
}

Deno.test("a provider reaches the terminal's auth and the auth service as a required client", async () => {
  const code = withAuth(`{required: false, service: "/auth", providers: ["google"]}`);
  const files = await exported(code, "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals(files.value["shell/shell.json"].data.auth.providers, ["google"]);
  const env = await exported(code, "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.success, true, env.stderr);
  assertEquals(env.value.OIDC_PROVIDERS, "google");
  assertStringIncludes(env.value.OIDC_GOOGLE_CLIENT_ID, "OIDC_GOOGLE_CLIENT_ID is required");
});

// The cluster's capabilities.android is mecha-fork's (0.18.1-host.12): run against the module
// the fork publishes, as prerelease.env pins it (CUE_REGISTRY github.com/bonisoft3/mecha=ghcr.io/bsoneca/cue-modules).
Deno.test("the app's Android certificates reach the cluster's auth and not the terminal", async () => {
  const fp = "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C";
  const code = withAuth(`{required: false, service: "/auth", android: ["${fp}"]}`);
  const files = await exported(code, "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals("android" in files.value["shell/shell.json"].data.auth, false);
  const env = await exported(code, "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.value.WEBAUTHN_ANDROID_ORIGINS, `\${WEBAUTHN_ANDROID_ORIGINS:-${fp}}`);
  for (const bad of [`["fa:c6"]`, `[]`, `["${fp}", "${fp}"]`, `["${fp.toLowerCase()}"]`]) {
    const res = await exported(withAuth(`{required: false, service: "/auth", android: ${bad}}`), "app.capabilities.auth.android");
    assertEquals(res.success, false, bad);
  }
});

// The cluster's capabilities.apiKeys is mecha-fork's (0.22.0-host.9, PRONTO-312): the auth service
// serves /auth/keys only where the app turns it on, and the terminal never sees it.
Deno.test("the app's API keys reach the cluster's auth and not the terminal", async () => {
  const code = withAuth(`{required: false, service: "/auth", apiKeys: true}`);
  const files = await exported(code, "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals("apiKeys" in files.value["shell/shell.json"].data.auth, false);
  const env = await exported(code, "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.value.AUTH_API_KEYS, "true");
  const off = await exported(withAuth(`{required: false, service: "/auth"}`), "_cluster.surface.targets.auth.compose.environment");
  assertEquals("AUTH_API_KEYS" in off.value, false);
  const bad = await exported(withAuth(`{required: false, service: "/auth", apiKeys: "yes"}`), "app.capabilities.auth.apiKeys");
  assertEquals(bad.success, false);
});

Deno.test("an app naming no provider leaves the terminal and the auth service as they were", async () => {
  const code = withAuth(`{required: false, service: "/auth"}`);
  const files = await exported(code, "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals("providers" in files.value["shell/shell.json"].data.auth, false);
  const env = await exported(code, "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.value.OIDC_PROVIDERS, "");
  assertEquals(Object.keys(env.value).some((k) => k.startsWith("OIDC_GOOGLE")), false);
});

Deno.test("a provider the terminal does not offer, a repeated one, and an empty list are refused", async () => {
  // Each refused for its own reason, not for one the program shares with them.
  // A provider the terminal does not name, with no issuer in its place, is
  // refused where the auth service would be given none.
  for (const [providers, why] of [[`["myspace"]`, "OIDC_MYSPACE_ISSUER: required field missing: issuer"], [`["google", "google"]`, "list.UniqueItems"], [`[]`, "app.capabilities.auth.providers: incompatible list lengths"]]) {
    const res = await exported(withAuth(`{required: false, service: "/auth", providers: ${providers}}`), "out");
    assertEquals(res.success, false, providers);
    assertStringIncludes(res.stderr, why, providers);
  }
});

// A provider the terminal does not name is one an identity broker offers (its
// phone sign-in): offered where the program names the issuer standing in its
// place, drawn by the terminal as any other, and refused without one.
Deno.test("a provider the terminal does not name is offered through the issuer the program names", async () => {
  const code = withAuth(`{required: false, service: "/auth", providers: ["google", "phone"], provider: phone: {issuer: "http://localhost:28443", client: "origin", params: "provider=phone"}}`);
  const files = await exported(code, "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals(files.value["shell/shell.json"].data.auth.providers, ["google", "phone"]);
  const env = await exported(code, "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.success, true, env.stderr);
  assertEquals(env.value.OIDC_PROVIDERS, "google,phone");
  assertEquals(env.value.OIDC_PHONE_ISSUER, "${OIDC_PHONE_ISSUER:-http://localhost:28443}");
  const bare = await exported(withAuth(`{required: false, service: "/auth", providers: ["google", "phone"]}`), "out");
  assertEquals(bare.success, false, "no issuer stands in the phone's place");
});

// A provider's settings reach the auth service as defaults the deployment's
// variables override, and never the terminal: a compose run handed no
// environment, as the visual check's is, still starts.
Deno.test("a provider's settings reach the auth service as defaults and not the terminal", async () => {
  const code = withAuth(`{required: false, service: "/auth", providers: ["google"], provider: google: {issuer: "http://localhost:28443", client: "origin", params: "provider=google"}}`);
  const files = await exported(code, "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals(files.value["shell/shell.json"].data.auth.providers, ["google"]);
  assertEquals("provider" in files.value["shell/shell.json"].data.auth, false);
  const env = await exported(code, "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.success, true, env.stderr);
  assertEquals(env.value.OIDC_GOOGLE_CLIENT_ID, "${OIDC_GOOGLE_CLIENT_ID:-origin}");
  assertEquals(env.value.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-http://localhost:28443}");
  assertEquals(env.value.OIDC_GOOGLE_AUTHORIZE_PARAMS, "${OIDC_GOOGLE_AUTHORIZE_PARAMS:-provider=google}");
  // Settings for a provider the app does not name are refused, not dropped.
  const stray = await exported(withAuth(`{required: false, service: "/auth", providers: ["google"], provider: github: {client: "origin"}}`), "out");
  assertEquals(stray.success, false);
  assertStringIncludes(stray.stderr, "github");
});

Deno.test("invalid provider settings are refused rather than replaced by defaults", async () => {
  for (const settings of [
    `client: "bad$client", issuer: "https://login.example"`,
    `client: "valid", issuer: "https://login.example/}"`,
    `client: "", issuer: "https://login.example"`,
  ]) {
    const res = await exported(withAuth(`{required: false, service: "/auth", providers: ["google"], provider: google: {${settings}}}`), "out");
    assertEquals(res.success, false, settings);
    assertStringIncludes(res.stderr, "signIn.google", settings);
  }
});

Deno.test("provider settings require a provider list while an empty settings map needs none", async () => {
  const stray = await exported(withAuth(`{required: false, service: "/auth", provider: google: {client: "valid"}}`), "out");
  assertEquals(stray.success, false);
  assertStringIncludes(stray.stderr, "_providersPresent");
  const empty = await exported(withAuth(`{required: false, service: "/auth", provider: {}}`), "out");
  assertEquals(empty.success, true, empty.stderr);
  assertEquals("providers" in empty.value["shell/shell.json"].data.auth, false);
  const unauthenticated = await exported(paymentProgram(), "out");
  assertEquals(unauthenticated.success, true, unauthenticated.stderr);
  assertEquals("auth" in unauthenticated.value["shell/shell.json"].data, false);
});

// A guest kept across visits (PRONTO-208): the flag that turns it on reaches the
// terminal, which asks it before keeping or adopting a guest.
Deno.test("the flag that keeps a guest across visits reaches the terminal's auth", async () => {
  const files = await exported(withAuth(`{required: false, service: "/auth", keepGuest: "keep_guest"}`), "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals(files.value["shell/shell.json"].data.auth.keepGuest, "keep_guest");
  const bad = await exported(withAuth(`{required: false, service: "/auth", keepGuest: "Keep Guest"}`), "out");
  assertEquals(bad.success, false);
});

// A provider's sign-in that keeps the guest it starts from (PRONTO-209): the flag that
// turns it on reaches the terminal, which asks it before handing the guest over.
Deno.test("the flag that has a provider's sign-in adopt the guest reaches the terminal's auth", async () => {
  const files = await exported(withAuth(`{required: false, service: "/auth", adoptGuest: "google_adopts_guest"}`), "out");
  assertEquals(files.success, true, files.stderr);
  assertEquals(files.value["shell/shell.json"].data.auth.adoptGuest, "google_adopts_guest");
  const bad = await exported(withAuth(`{required: false, service: "/auth", adoptGuest: "Adopt Guest"}`), "out");
  assertEquals(bad.success, false);
});
