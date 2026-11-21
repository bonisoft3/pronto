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

Deno.test("pages release target refuses social sign-in providers", async () => {
  const program = signin(BROKER).replace("targets: []", `targets: ["pages"]`);
  const res = await cue(["export", "-", "-e", "out", "--out", "json"], program);
  assertEquals(res.success, false, "expected target pages to fail");
  assertStringIncludes(res.stderr, "pages release target does not support social sign-in providers");
});

Deno.test("cloudflare, gcp, k8s and docker targets admit social sign-in providers", async () => {
  for (const target of ["cloudflare", "gcp", "k8s", "docker"]) {
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
