// The gcp target's resources (gcp/schema): one Cloud Run service whose
// containers share localhost, beside Cloud SQL, and the Job that builds its
// schema. Rendered here as release@gcp renders them, so no project is touched.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, paymentProgram } from "./effects-fixtures.ts";

const digest = (c: string) => "sha256:" + c.repeat(64);

async function built(release: string, field = "plan") {
  const code = `package probe\nimport "github.com/bonisoft3/pronto/gcp/schema"\nout: (schema.#Build & {release: ${release}}).${field}\n`;
  const res = await cue(["export", "-", "-e", "out", "--out", "json"], code);
  return { ...res, value: res.success ? JSON.parse(res.stdout) : undefined };
}

const pushed = `{${["caddy", "crud", "auth", "electric", "database"].map((s, i) => `${s}: {tag: "latest", digest: "${digest(String(i))}"}`).join(", ")}}`;
const release = (extra = "") => `{name: "battlechess", service: "bonk-chess", project: "brawl-chess", domain: "bonkchess.com", image: pushed: ${pushed}${extra}}`;

Deno.test("the door dials each upstream at its own port in the shared instance", async () => {
  const r = await built(release(), "service");
  assertEquals(r.success, true, r.stderr);
  const [caddy, crud, , electric] = r.value.spec.template.spec.containers;
  const env = Object.fromEntries(caddy.env.filter((e: { value?: string }) => e.value).map((e: { name: string; value: string }) => [e.name, e.value]));
  assertEquals(env.PRONTO_UPSTREAM_CRUD, "127.0.0.1:3000");
  assertEquals(env.PRONTO_UPSTREAM_AUTH, "127.0.0.1:9999");
  // Not compose's 3000, which crud holds in the shared instance.
  assertEquals(env.PRONTO_UPSTREAM_ELECTRIC, "127.0.0.1:3002");
  assertEquals(electric.env.find((e: { name: string }) => e.name === "ELECTRIC_PORT").value, "3002");
  assertEquals(crud.env.find((e: { name: string }) => e.name === "PGRST_SERVER_PORT").value, "3000");
  assertEquals(env.ORIGIN, "https://bonkchess.com");
});

// A revision resolves a tag once (mecha's docs/deployment.md, what bites).
Deno.test("every image is named by the digest the release pushed", async () => {
  const r = await built(release(), "service");
  assertEquals(r.success, true, r.stderr);
  for (const c of r.value.spec.template.spec.containers) assert(/@sha256:[0-9a-f]{64}$/.test(c.image), c.image);
  assertStringIncludes(r.value.spec.template.spec.containers[0].image, "us-central1-docker.pkg.dev/brawl-chess/pronto/battlechess-caddy@");
});

Deno.test("no secret is a literal: each comes from Secret Manager", async () => {
  const r = await built(release(), "plan");
  assertEquals(r.success, true, r.stderr);
  for (const doc of [r.value.serviceYaml, r.value.jobYaml]) {
    assert(!doc.includes("postgres://"), doc);
    assert(!/PASSWORD\n\s+value:/.test(doc), doc);
  }
  assertStringIncludes(r.value.serviceYaml, "name: battlechess-crud-db-uri");
  assertStringIncludes(r.value.jobYaml, "name: battlechess-postgres-password");
});

// electric is one instance (mecha's docs/deployment.md#clouds-as-built), and so
// is the service it shares; none while nobody plays.
Deno.test("the service is one instance at most and none at rest", async () => {
  const r = await built(release(), "service");
  assertEquals(r.success, true, r.stderr);
  const a = r.value.spec.template.metadata.annotations;
  assertEquals([a["autoscaling.knative.dev/minScale"], a["autoscaling.knative.dev/maxScale"]], ["0", "1"]);
  assertEquals(JSON.parse(a["run.googleapis.com/container-dependencies"]).caddy, ["crud", "auth", "electric"]);
});

Deno.test("initdb builds the schema once, over the Cloud SQL socket", async () => {
  const r = await built(release(), "job");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"], "brawl-chess:us-central1:battlechess-db");
  const c = r.value.spec.template.spec.template.spec.containers[0];
  assertStringIncludes(c.command[2], `if [ "$marker" = "pronto initdb" ]; then echo "initdb: already built"; else`);
  // Cloud SQL's postgres is no superuser: without the roles granted, PostgREST
  // cannot switch into anon on the first request (found on a real instance).
  assertStringIncludes(c.command[2], "GRANT anon, app_user, service TO postgres WITH INHERIT FALSE, SET TRUE");
  assertEquals(c.env.find((e: { name: string }) => e.name === "PGHOST").value, "/cloudsql/brawl-chess:us-central1:battlechess-db");
});

Deno.test("a passkey's relying party is the domain, else the run.app host the release fills", async () => {
  const withDomain = await built(release(), "service");
  const auth = withDomain.value.spec.template.spec.containers[2];
  assertEquals(auth.env.find((e: { name: string }) => e.name === "WEBAUTHN_RP_ID").value, "bonkchess.com");
  const bare = await built(`{name: "battlechess", project: "brawl-chess", runHost: "battlechess-504479523278.us-central1.run.app"}`, "service");
  assertEquals(bare.success, true, bare.stderr);
  const env = bare.value.spec.template.spec.containers[2].env;
  assertEquals(env.find((e: { name: string }) => e.name === "WEBAUTHN_ORIGIN").value, "https://battlechess-504479523278.us-central1.run.app");
});

Deno.test("a provider's settings are values and its client secret a reference", async () => {
  const r = await built(release(`, auth: {oidc: {OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "abc"}, oidcSecrets: {OIDC_GOOGLE_CLIENT_SECRET: "battlechess-google-client-secret"}}`), "service");
  assertEquals(r.success, true, r.stderr);
  const env = r.value.spec.template.spec.containers[2].env;
  assertEquals(env.find((e: { name: string }) => e.name === "OIDC_GOOGLE_CLIENT_ID").value, "abc");
  assertEquals(env.find((e: { name: string }) => e.name === "OIDC_GOOGLE_CLIENT_SECRET").valueFrom.secretKeyRef.name, "battlechess-google-client-secret");
});

Deno.test("a name Cloud SQL or Cloud Run would refuse is refused here", async () => {
  for (const bad of [`{name: "Battle", project: "brawl-chess"}`, `{name: "battlechess", project: "x"}`, `{name: "battlechess", project: "brawl-chess", domain: "https://bonkchess.com"}`]) {
    assertEquals((await built(bad)).success, false, bad);
  }
});

Deno.test("an app targeting gcp gets release@gcp, a deploy as k8s's is", async () => {
  const code = paymentProgram().replace("targets: []", 'targets: ["gcp"]');
  const res = await cue(["export", "-", "-e", "_loop.surface.sayYaml.say.release.rulemap", "--out", "json"], code);
  assertEquals(res.success, true, res.stderr);
  const rule = JSON.parse(res.stdout).gcp;
  assertEquals(rule.platform, "gcp");
  assertStringIncludes(rule.cmds[0].do, "path join gcp release.nu");
  const none = await cue(["export", "-", "-e", "_loop.surface.sayYaml.say.release.rulemap.gcp", "--out", "json"], paymentProgram());
  assertEquals(none.success, false);
});
