// identity.#Signin embedded in a program puts the broker in each provider's
// place on mecha's own auth service, and, for the broker a local launch runs,
// brings Hydra and the front up with the app's cluster. No secret of a
// provider's reaches the program: the app is a public client named by its
// origin.
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

// The local broker's port, hashed from the app's name (the fixture's meta.name) as
// identity/signin.cue's #LocalPort does: one per app.
const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pronto-identity/test-effects")));
const port = 10000 + parseInt(Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join(""), 16) % 22768;

async function exported(code: string, expression: string) {
  const res = await cue(["export", "-", "-e", expression, "--out", "json"], code);
  return { ...res, value: res.success ? JSON.parse(res.stdout) : undefined };
}

Deno.test("the broker stands in each provider's place, as defaults a deployment overrides", async () => {
  const env = await exported(signin(), "_cluster.surface.targets.auth.compose.environment");
  assertEquals(env.success, true, env.stderr);
  assertEquals(env.value.OIDC_PROVIDERS, "google");
  assertEquals(env.value.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-http://localhost:" + port + "}");
  assertEquals(env.value.OIDC_GOOGLE_CLIENT_ID, "${OIDC_GOOGLE_CLIENT_ID:-origin}");
  assertEquals(env.value.OIDC_GOOGLE_AUTHORIZE_PARAMS, "${OIDC_GOOGLE_AUTHORIZE_PARAMS:-provider=google}");
  // A public client: the program gives no secret, only the deployment's slot for one.
  assertEquals(env.value.OIDC_GOOGLE_CLIENT_SECRET, "${OIDC_GOOGLE_CLIENT_SECRET:-}");
});

Deno.test("a local launch brings the broker up: Hydra, then the front waiting on it, both pinned", async () => {
  const targets = await exported(signin(), "_cluster.surface.targets");
  assertEquals(targets.success, true, targets.stderr);
  const hydra = targets.value["identity-hydra"];
  const front = targets.value.identity;
  assertStringIncludes(hydra.dockerfile.from.name, "oryd/hydra:v26.2.0@sha256:");
  assertStringIncludes(front.dockerfile.from.name, "denoland/deno:distroless-2.5.0@sha256:");
  assertEquals(front.entrypoint.after, { "identity-hydra": "healthy" });
  // Ports of the app's own: the front's hashed from its name, Hydra's moved by bayt as any other.
  assertEquals(front.expose.http.port, port);
  assertEquals(front.compose.environment.PORT, String(port));
  assertEquals(hydra.expose.public.env, "SERVE_PUBLIC_PORT");
  assertEquals(hydra.expose.admin.env, "SERVE_ADMIN_PORT");
  assertEquals(targets.value.launch.compose.depends_on.identity.condition, "service_healthy");
  // The auth service reaches the front by its service name, which the host projection reads as loopback.
  assertEquals(targets.value.auth.compose.environment.OIDC_GOOGLE_INTERNAL, "${OIDC_GOOGLE_INTERNAL:-http://identity:" + port + "/}");
});

Deno.test("an operator's broker elsewhere is theirs to run: no local broker", async () => {
  const targets = await exported(signin(`broker: "https://id.example.com"`), "_cluster.surface.targets");
  assertEquals(targets.success, true, targets.stderr);
  assertEquals("identity-hydra" in targets.value, false);
  assertEquals("identity" in targets.value, false);
  assertEquals(targets.value.auth.compose.environment.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-https://id.example.com}");
});

Deno.test("the terminal draws the way in and never sees the broker's settings", async () => {
  const files = await exported(signin(), "out");
  assertEquals(files.success, true, files.stderr);
  const auth = files.value["shell/shell.json"].data.auth;
  assertEquals(auth.providers, ["google"]);
  assertEquals("provider" in auth, false);
});

Deno.test("a provider name or broker address that is not one is refused", async () => {
  for (const settings of [`providers: ["Google"]`, `providers: []`, `broker: "id.example.com"`, `broker: "https://id.example.com/path"`]) {
    const res = await exported(signin(settings), "_cluster.surface.targets.auth");
    assert(!res.success, settings);
  }
});

Deno.test("the pages release target refuses social sign-in providers", async () => {
  for (const [target, reason] of [
    ["pages", "pages release target does not support social sign-in providers"],
  ]) {
    const program = signin().replace("targets: []", `targets: ["${target}"]`);
    const res = await cue(["export", "-", "-e", "out", "--out", "json"], program);
    assertEquals(res.success, false, `expected target ${target} to fail`);
    assertStringIncludes(res.stderr, reason);
  }
});

// The edge cluster runs the auth service's provider sign-in in its object
// (bundle/edge-signin.ts carries the settings to the Worker).
Deno.test("gcp, k8s, docker and cloudflare targets admit social sign-in providers", async () => {
  for (const target of ["gcp", "k8s", "docker", "cloudflare"]) {
    const program = signin().replace("targets: []", `targets: ["${target}"]`);
    const res = await cue(["export", "-", "-e", "out", "--out", "json"], program);
    assertEquals(res.success, true, res.stderr);
  }
});
