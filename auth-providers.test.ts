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
  // A provider nobody offers meets the cluster's providers before the terminal's.
  for (const [providers, why] of [[`["myspace"]`, "signIn.myspace: field not allowed"], [`["google", "google"]`, "list.UniqueItems"], [`[]`, "app.capabilities.auth.providers: incompatible list lengths"]]) {
    const res = await exported(withAuth(`{required: false, service: "/auth", providers: ${providers}}`), "out");
    assertEquals(res.success, false, providers);
    assertStringIncludes(res.stderr, why, providers);
  }
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
