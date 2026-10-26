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

const pushed = `{${["caddy", "crud", "auth", "electric", "database", "migrate"].map((s, i) => `${s}: {tag: "latest", digest: "${digest(String(i))}"}`).join(", ")}}`;
const release = (extra = "") => `{name: "battlechess", service: "bonk-chess", project: "brawl-chess", domain: "bonkchess.com", image: pushed: ${pushed}, database: tokenRoles: ["anon", "app_user", "service"]${extra}}`;

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
  // Cloud Run probes a container at the instance's address, not loopback: a
  // crud bound to 127.0.0.1 never answered /ready (found on a real revision).
  assertEquals(crud.env.find((e: { name: string }) => e.name === "PGRST_SERVER_HOST").value, "*");
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

Deno.test("initdb builds the schema once, and its re-runnable steps every release, over the Cloud SQL socket", async () => {
  const r = await built(release(), "job");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"], "brawl-chess:us-central1:battlechess-db");
  const c = r.value.spec.template.spec.template.spec.containers[0];
  assertStringIncludes(c.command[2], `if [ "$marker" = "pronto initdb" ]; then echo "initdb: already built"\n`);
  // A guard the app changed reaches a database built before it (a friend's
  // refused seat, found in production), and so does a new entity's table.
  assertStringIncludes(c.command[2], `for step in 005_create_tables 006_policies 007_txid 008_publication 016_mecha_actors; do`);
  assertStringIncludes(c.command[2], `if [ -f "$f" ]; then psql -v ON_ERROR_STOP=1 -Xq -f "$f"; fi\n  done\nelse`);
  // Cloud SQL's postgres is no superuser: without the roles granted, PostgREST
  // cannot switch into anon on the first request (found on a real instance).
  assertStringIncludes(c.command[2], "GRANT anon, app_user, service TO postgres WITH INHERIT FALSE, SET TRUE");
  assertEquals(c.env.find((e: { name: string }) => e.name === "PGHOST").value, "/cloudsql/brawl-chess:us-central1:battlechess-db");
});

Deno.test("the job grants the roles the schema has, and auth gets its statement bound", async () => {
  // An app without auth has no app_user; a literal grant would die on it.
  const job = (await built(release().replace('["anon", "app_user", "service"]', '["anon", "service"]'), "job")).value;
  assertStringIncludes(job.spec.template.spec.template.spec.containers[0].command[2], "GRANT anon, service TO postgres WITH INHERIT FALSE, SET TRUE");
  const auth = (await built(release(), "service")).value.spec.template.spec.containers[2];
  // The service refuses to start without it; the bound is resilience's client statement, in ms.
  assertEquals(auth.env.find((e: { name: string }) => e.name === "AUTH_STATEMENT_TIMEOUT_MS").value, "5000");
  // Compose's own, where it gives one.
  const own = (await built(release(`, auth: env: {AUTH_STATEMENT_TIMEOUT_MS: "9000"}`), "service")).value.spec.template.spec.containers[2];
  assertEquals(own.env.filter((e: { name: string }) => e.name === "AUTH_STATEMENT_TIMEOUT_MS").map((e: { value: string }) => e.value), ["9000"]);
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
  // Under mise's environment: nu, gcloud and cue are its tools, on no PATH
  // of their own where sayt runs a rule.
  assertStringIncludes(rule.cmds[0].do, "run-mise exec -- nu ($pronto | path join gcp release.nu)");
  const none = await cue(["export", "-", "-e", "_loop.surface.sayYaml.say.release.rulemap.gcp", "--out", "json"], paymentProgram());
  assertEquals(none.success, false);
});

// The smallest Cloud SQL tier admits about 25 connections, fewer than the
// pools' defaults together: electric met "remaining connection slots are
// reserved" on a real revision.
Deno.test("the pools fit the database's connections", async () => {
  const r = await built(release(), "service");
  assertEquals(r.success, true, r.stderr);
  const [, crud, , electric] = r.value.spec.template.spec.containers;
  assertEquals(crud.env.find((e: { name: string }) => e.name === "PGRST_DB_POOL").value, "5");
  assertEquals(electric.env.find((e: { name: string }) => e.name === "ELECTRIC_DB_POOL_SIZE").value, "5");
  const plan = await built(release(), "plan");
  assertEquals(plan.value.sqlFlags, "cloudsql.logical_decoding=on,max_connections=50");
});

// A page load asks for every hatch file at once while electric's live requests
// hold theirs open, and the one instance is all there is: at Cloud Run's
// default of 80 a reload met "Rate exceeded" (found on a real revision).
Deno.test("the one instance takes Cloud Run's most requests at once", async () => {
  const r = await built(release(), "service");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.spec.template.spec.containerConcurrency, 1000);
});

// Electric keeps its shape metadata in SQLite, which a GCS bucket mounted over
// FUSE cannot lock: a restarted instance failed its ShapeDb migration (found on
// a real revision). Its storage is the instance's; a new one rebuilds shapes
// from Postgres, and clients refetch.
Deno.test("electric's storage is the instance's, no bucket", async () => {
  const r = await built(release(), "service");
  assertEquals(r.success, true, r.stderr);
  const spec = r.value.spec.template.spec;
  assertEquals(spec.volumes, undefined);
  const electric = spec.containers[3];
  assertEquals(electric.volumeMounts, undefined);
  assertEquals(electric.env.find((e: { name: string }) => e.name === "ELECTRIC_STORAGE_DIR").value, "/tmp/electric");
});

// An alias (www) reaches the same service and is sent on to the origin: a
// passkey's relying party is the origin alone, so a reader signed in at www
// would be refused.
Deno.test("an alias is mapped and redirected to the origin", async () => {
  const r = await built(release(`, aliases: ["www.bonkchess.com"]`), "service");
  assertEquals(r.success, true, r.stderr);
  const caddy = r.value.spec.template.spec.containers[0];
  assertEquals(caddy.env.find((e: { name: string }) => e.name === "PRONTO_ALIASES").value, "www.bonkchess.com");
  const plan = await built(release(`, aliases: ["www.bonkchess.com"]`), "plan");
  assertEquals(plan.value.aliases, ["www.bonkchess.com"]);
  const none = await built(release(), "service");
  assertEquals(none.value.spec.template.spec.containers[0].env.some((e: { name: string }) => e.name === "PRONTO_ALIASES"), false);
  assertEquals((await built(`{name: "battlechess", project: "brawl-chess", aliases: ["www.bonkchess.com"]}`)).success, false, "an alias needs a domain to send readers to");
});

Deno.test("the door sends an alias host on to the origin", async () => {
  const caddyfile = await Deno.readTextFile(new URL("./assets/Caddyfile", import.meta.url));
  assertStringIncludes(caddyfile, "@alias host {$PRONTO_ALIASES:alias.invalid}");
  assertStringIncludes(caddyfile, "redir @alias {$ORIGIN}{uri} 308");
});

// A database built before a change is carried forward by the cluster's pgroll runner, as
// compose's migrate step and the k8s release's Job do, after initdb and before any reader starts.
Deno.test("an app with migrations gets a migrate job over the Cloud SQL socket", async () => {
  const r = await built(release(`, migrate: env: {REQUIRED_TABLES: "schedule"}`), "plan");
  assertEquals(r.success, true, r.stderr);
  const job = (await built(release(`, migrate: env: {REQUIRED_TABLES: "schedule"}`), "migrateJob")).value;
  assertEquals(job.metadata.name, "battlechess-migrate");
  assertEquals(job.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"], "brawl-chess:us-central1:battlechess-db");
  const c = job.spec.template.spec.template.spec.containers[0];
  assert(/battlechess-migrate@sha256:/.test(c.image), c.image);
  assertEquals(c.env.find((e: { name: string }) => e.name === "DATABASE_URL").valueFrom.secretKeyRef.name, "battlechess-migrate-database-url");
  assertEquals(c.env.find((e: { name: string }) => e.name === "REQUIRED_TABLES").value, "schedule");
  assert(!r.value.migrateJobYaml.includes("postgres://"));
  const none = await built(release(), "plan");
  assertEquals(none.value.migrateJobYaml, "");
});

// A provider is configured by the program for development, against a broker on the developer's
// machine; released as is it sends every reader to their own localhost, and switched off it
// leaves the terminal drawing a way in that answers 404 (bonkchess.com, before the broker ran).
Deno.test("a release refuses a provider at a developer's address, or one the program offers and production does not serve", async () => {
  const google = (issuer: string, internal = issuer) => `OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "origin", OIDC_GOOGLE_ISSUER: "${issuer}", OIDC_GOOGLE_INTERNAL: "${internal}"`;
  for (const [oidc, why] of [
    [google("http://localhost:28443", "http://host.docker.internal:28443"), "localhost"],
    [google("https://id.example.com", "http://host.docker.internal:28443"), "host.docker.internal"],
    [google("http://127.0.0.1:9000"), "127.0.0.1"],
  ]) {
    const r = await built(release(`, auth: {programProviders: "google", oidc: {${oidc}}}`));
    assertEquals(r.success, false, oidc);
    assertStringIncludes(r.stderr, why);
  }
  const off = await built(release(`, auth: {programProviders: "google", oidc: {OIDC_PROVIDERS: ""}}`));
  assertEquals(off.success, false);
  assertStringIncludes(off.stderr, "the terminal offers google");
  const served = await built(release(`, auth: {programProviders: "google", oidc: {${google("https://id.example.com")}}}`));
  assertEquals(served.success, true, served.stderr);
  // Google's own issuer, the preset, named by leaving the issuer unset.
  const preset = await built(release(`, auth: {programProviders: "google", oidc: {OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com", OIDC_GOOGLE_ISSUER: "", OIDC_GOOGLE_INTERNAL: ""}}`));
  assertEquals(preset.success, true, preset.stderr);
  const none = await built(release());
  assertEquals(none.success, true, none.stderr);
});

// A pull request's preview beside the released app: everything of its own
// that two releases could not share, at its run.app address.
Deno.test("a preview is its own service, instance, jobs and secrets, with no domain", async () => {
  const preview = await built(release(`, preview: "pr-32", runHost: "bonk-chess-pr-32-504479523278.us-central1.run.app"`), "plan");
  assertEquals(preview.success, true, preview.stderr);
  const p = preview.value;
  assertEquals(p.service, "bonk-chess-pr-32");
  assertEquals(p.preview, "pr-32");
  assertEquals(p.names.instance, "battlechess-pr-32-db");
  assertEquals([p.names.job, p.names.migrateJob], ["battlechess-pr-32-initdb", "battlechess-pr-32-migrate"]);
  for (const s of Object.values(p.names.secrets) as string[]) assert(s.startsWith("battlechess-pr-32-"), s);
  // Its own instance, so the database keeps the app's name.
  assertEquals(p.names.database, "battlechess");
  assertEquals(p.names.serviceAccount, "battlechess-preview@brawl-chess.iam.gserviceaccount.com");
  assertEquals(p.domain, undefined);
  assertEquals(p.aliases, []);
  const service = await built(release(`, aliases: ["www.bonkchess.com"], preview: "pr-32", runHost: "bonk-chess-pr-32-504479523278.us-central1.run.app"`), "service");
  assertEquals(service.success, true, service.stderr);
  assertEquals(service.value.metadata.name, "bonk-chess-pr-32");
  const [caddy, , auth] = service.value.spec.template.spec.containers;
  const env = (c: { env: { name: string; value?: string }[] }) => Object.fromEntries(c.env.filter((e) => e.value).map((e) => [e.name, e.value]));
  assertEquals(env(caddy).ORIGIN, "https://bonk-chess-pr-32-504479523278.us-central1.run.app");
  assertEquals(env(caddy).PRONTO_ALIASES, undefined);
  // A passkey made on a preview belongs to the preview's address alone.
  assertEquals(env(auth).WEBAUTHN_RP_ID, "bonk-chess-pr-32-504479523278.us-central1.run.app");
});

Deno.test("the released app's names are unchanged by previews", async () => {
  const r = await built(release(), "plan");
  assertEquals(r.success, true, r.stderr);
  assertEquals([r.value.service, r.value.names.instance, r.value.domain], ["bonk-chess", "battlechess-db", "bonkchess.com"]);
  assertEquals(r.value.names.serviceAccount, "battlechess-run@brawl-chess.iam.gserviceaccount.com");
  assertEquals(r.value.preview, undefined);
});

// Whoever deploys previews then holds no role where the release runs.
Deno.test("a preview in a project of previews names nothing in the release's", async () => {
  const preview = await built(release(`, previewProject: "brawl-chess-previews", preview: "pr-32"`), "plan");
  assertEquals(preview.success, true, preview.stderr);
  const p = preview.value;
  assertEquals(p.project, "brawl-chess-previews");
  assertEquals(p.registry, "us-central1-docker.pkg.dev/brawl-chess-previews/pronto");
  assertEquals(p.names.connection, "brawl-chess-previews:us-central1:battlechess-pr-32-db");
  assertEquals(p.names.serviceAccount, "battlechess-preview@brawl-chess-previews.iam.gserviceaccount.com");
  assert(!JSON.stringify(p).replaceAll("brawl-chess-previews", "").includes("brawl-chess"), "the release's project is named");
  const released = await built(release(`, previewProject: "brawl-chess-previews"`), "plan");
  assertEquals(released.success, true, released.stderr);
  assertEquals([released.value.project, released.value.names.serviceAccount], ["brawl-chess", "battlechess-run@brawl-chess.iam.gserviceaccount.com"]);
});

Deno.test("a preview name Cloud Run, Cloud SQL or a secret would refuse is refused here", async () => {
  for (const bad of ["PR-32", "pr_32", "-pr", "pr-", "a-preview-name-too-long"]) {
    const r = await built(release(`, preview: "${bad}"`), "plan");
    assertEquals(r.success, false, bad);
  }
});

// The blob plane (capabilities.blobs): rclone serves the release's bucket as the
// S3 bucket every app names, imgproxy reads only from it, and the door dials both.
Deno.test("the blob plane runs over the release's bucket, behind the door", async () => {
  const blobsPushed = `{${["caddy", "crud", "auth", "electric", "database", "migrate", "rclone-s3", "imgproxy"].map((s, i) => `"${s}": {tag: "latest", digest: "${digest(String(i))}"}`).join(", ")}}`;
  const r = await built(`{name: "battlechess", service: "bonk-chess", project: "brawl-chess", domain: "bonkchess.com", image: pushed: ${blobsPushed}, blobs: {}}`, "service");
  assertEquals(r.success, true, r.stderr);
  const containers = r.value.spec.template.spec.containers;
  const by = (n: string) => containers.find((c: { name: string }) => c.name === n);
  const env = (c: { env: { name: string; value?: string }[] }) => Object.fromEntries(c.env.filter((e) => e.value).map((e) => [e.name, e.value]));
  assertEquals(env(by("caddy")).PRONTO_UPSTREAM_RCLONE_S3, "127.0.0.1:3900");
  assertEquals(env(by("caddy")).PRONTO_UPSTREAM_IMGPROXY, "127.0.0.1:8081");
  assertEquals(env(by("rclone-s3")).RCLONE_CONFIG_OBJECTS_UPSTREAMS, "mecha-objects=gcs:brawl-chess-battlechess-blobs");
  assertEquals(env(by("imgproxy")).IMGPROXY_ALLOWED_SOURCES, "s3://mecha-objects/,https://lh3.googleusercontent.com/");
  assertEquals(env(by("imgproxy")).IMGPROXY_ONLY_PRESETS, "true");
  assertStringIncludes(env(by("imgproxy")).IMGPROXY_PRESETS ?? "", "avatar=rs:fill:256:256/f:webp");
  assertEquals(env(by("imgproxy")).IMGPROXY_S3_ENDPOINT, "http://127.0.0.1:3900");
  const deps = JSON.parse(r.value.spec.template.metadata.annotations["run.googleapis.com/container-dependencies"]);
  assertEquals(deps.caddy.includes("rclone-s3") && deps.caddy.includes("imgproxy"), true);
  assertEquals(deps.imgproxy, ["rclone-s3"]);
  const plain = await built(release(), "service");
  assertEquals(plain.value.spec.template.spec.containers.some((c: { name: string }) => c.name === "imgproxy"), false);
});

// An app's own containers (a plugin's collector): built and pushed as the
// cluster's images, dialed by the door, and, where one exports Prometheus
// metrics, scraped into Managed Service for Prometheus by its sidecar.
const sidecarPushed = `{${["caddy", "crud", "auth", "electric", "database", "migrate", "perf-collector"].map((s, i) => `"${s}": {tag: "latest", digest: "${digest(String(i))}"}`).join(", ")}}`;
const withSidecar = (sidecar: string) => `{name: "battlechess", service: "bonk-chess", project: "brawl-chess", domain: "bonkchess.com", image: pushed: ${sidecarPushed}, sidecars: "perf-collector": ${sidecar}}`;

Deno.test("a sidecar runs beside the cluster, by its pushed digest, behind the door", async () => {
  const r = await built(withSidecar(`{port: 8687}`), "plan");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.sidecars, ["perf-collector"]);
  assertEquals(r.value.scrapeConfig, "");
  const s = await built(withSidecar(`{port: 8687}`), "service");
  const containers = s.value.spec.template.spec.containers;
  const by = (n: string) => containers.find((c: { name: string }) => c.name === n);
  assertStringIncludes(by("perf-collector").image, `battlechess-perf-collector@${digest("6")}`);
  assertEquals(by("perf-collector").startupProbe.tcpSocket.port, 8687);
  const caddy = Object.fromEntries(by("caddy").env.filter((e: { value?: string }) => e.value).map((e: { name: string; value: string }) => [e.name, e.value]));
  assertEquals(caddy.PRONTO_UPSTREAM_PERF_COLLECTOR, "127.0.0.1:8687");
  // Unscraped: no collector of Google's, no volume.
  assertEquals(by("gmp-collector"), undefined);
  assertEquals(s.value.spec.template.spec.volumes, undefined);
  // The door does not wait on it: a collector down is no outage.
  const deps = JSON.parse(s.value.spec.template.metadata.annotations["run.googleapis.com/container-dependencies"]);
  assertEquals(deps.caddy.includes("perf-collector"), false);
});

// A sidecar that talks to the cluster (a plugin's service): compose's environment, its peers at
// their loopback ports, the cluster's secrets from Secret Manager, and readers' origin.
Deno.test("a sidecar's environment: the cluster's secrets mounted, the origin the release's", async () => {
  const env = `{CRUD_URL: "http://127.0.0.1:3000", SERVICE_JWT: "the-development-token", ORIGIN: "https://localhost:28102", BILLING_DOCUMENT: "{\\"plans\\":{}}"}`;
  const s = await built(withSidecar(`{port: 8687, env: ${env}}`), "service");
  assertEquals(s.success, true, s.stderr);
  const c = s.value.spec.template.spec.containers.find((c: { name: string }) => c.name === "perf-collector");
  const by = Object.fromEntries(c.env.map((e: { name: string }) => [e.name, e]));
  assertEquals(by.SERVICE_JWT.valueFrom, { secretKeyRef: { name: "battlechess-service-jwt", key: "latest" } });
  assertEquals(by.SERVICE_JWT.value, undefined, "never compose's development token");
  assertEquals(by.ORIGIN.value, "https://bonkchess.com");
  assertEquals(by.CRUD_URL.value, "http://127.0.0.1:3000");
  assertEquals(by.BILLING_DOCUMENT.value, '{"plans":{}}');
  // Where the release finds each peer compose names, the sidecar's own among them.
  const plan = await built(withSidecar(`{port: 8687}`), "plan");
  assertEquals(plan.value.loopback["crud:3000"], "127.0.0.1:3000");
  assertEquals(plan.value.loopback["electric:3000"], "127.0.0.1:3002");
  assertEquals(plan.value.loopback["perf-collector:8687"], "127.0.0.1:8687");
  // A sidecar given none has none.
  const bare = await built(withSidecar(`{port: 8687}`), "service");
  assertEquals(bare.value.spec.template.spec.containers.find((c: { name: string }) => c.name === "perf-collector").env, undefined);
});

Deno.test("a sidecar's metrics are scraped into Managed Prometheus, its config a mounted secret", async () => {
  const r = await built(withSidecar(`{port: 8687, metrics: port: 9599}`), "plan");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.names.scrapeConfig, "battlechess-gmp-config");
  assertStringIncludes(r.value.scrapeConfig, "kind: RunMonitoring");
  assertStringIncludes(r.value.scrapeConfig, "port: 9599");
  assertStringIncludes(r.value.scrapeConfig, "path: /metrics");
  const s = await built(withSidecar(`{port: 8687, metrics: port: 9599}`), "service");
  const spec = s.value.spec.template.spec;
  const gmp = spec.containers.find((c: { name: string }) => c.name === "gmp-collector");
  assert(/cloud-run-gmp-sidecar:[0-9.]+@sha256:[0-9a-f]{64}$/.test(gmp.image), gmp.image);
  assertEquals(gmp.volumeMounts, [{ name: "gmp-config", mountPath: "/etc/rungmp" }]);
  assertEquals(spec.volumes, [{ name: "gmp-config", secret: { secretName: "battlechess-gmp-config", items: [{ key: "latest", path: "config.yaml" }] } }]);
  const deps = JSON.parse(s.value.spec.template.metadata.annotations["run.googleapis.com/container-dependencies"]);
  assertEquals(deps["gmp-collector"], ["perf-collector"]);
  // A preview runs the sidecar but scrapes nothing.
  const preview = await built(withSidecar(`{port: 8687, metrics: port: 9599}`).replace(/}$/, `, preview: "pr-9"}`), "plan");
  assertEquals(preview.success, true, preview.stderr);
  assertEquals(preview.value.scrapeConfig, "");
  assertStringIncludes(preview.value.serviceYaml, "name: perf-collector");
  assert(!preview.value.serviceYaml.includes("gmp-collector"));
});

Deno.test("a sidecar on a port the cluster holds, or two on one port, is refused", async () => {
  for (const bad of [`{port: 3000}`, `{port: 8080}`, `{port: 8687, metrics: port: 8687}`, `{port: 80}`]) {
    const r = await built(withSidecar(bad), "plan");
    assertEquals(r.success, false, bad);
  }
});

// Cloud Run caps an instance's containers at 8 CPUs together, and gives one
// with no limit a whole CPU: the light ones ask for a share.
Deno.test("the whole cluster, scraped sidecar and all, fits Cloud Run's 8 CPUs", async () => {
  const all = `{${["caddy", "crud", "auth", "electric", "database", "migrate", "ticker", "rclone-s3", "imgproxy", "perf-collector"].map((s, i) => `"${s}": {tag: "latest", digest: "${digest(String(i))}"}`).join(", ")}}`;
  const full = (sidecar: string) => `{name: "battlechess", service: "bonk-chess", project: "brawl-chess", domain: "bonkchess.com", image: pushed: ${all}, ticker: {}, blobs: {}, sidecars: "perf-collector": ${sidecar}}`;
  const s = await built(full(`{port: 8687, metrics: port: 9599}`), "service");
  assertEquals(s.success, true, s.stderr);
  const cpu = s.value.spec.template.spec.containers.map((c: { name: string; resources?: { limits?: { cpu?: string } } }) => [c.name, c.resources?.limits?.cpu ?? "1000m"]);
  const total = cpu.reduce((n: number, [, c]: string[]) => n + Number(c.replace(/m$/, "")), 0);
  assert(total <= 8000, JSON.stringify(cpu));
  assertEquals(Object.fromEntries(cpu)["perf-collector"], "250m");
  const r = await built(full(`{port: 8687, cpu: 4000}`), "plan");
  assertEquals(r.success, false, "a sidecar asking for more than is left is refused");
  assertStringIncludes(r.stderr, "over Cloud Run's 8000");
});

// A sidecar apart: a Cloud Run service of its own, since one revision holds at most 10
// containers. The door dials it at its run.app address, and it reaches the gateway through
// the door.
const apartPushed = `{${["caddy", "crud", "auth", "electric", "database", "migrate", "billing", "perf-collector"].map((s, i) => `"${s}": {tag: "latest", digest: "${digest(String(i))}"}`).join(", ")}}`;
const withApart = (perf: string, extra = "") => `{name: "battlechess", service: "bonk-chess", project: "brawl-chess", domain: "bonkchess.com", runHost: "bonk-chess-123.us-central1.run.app", image: pushed: ${apartPushed}, sidecars: {billing: {port: 8688}, "perf-collector": ${perf}}${extra}}`;

Deno.test("a sidecar apart runs as its own service, dialed by the door at its address", async () => {
  const r = await built(withApart(`{port: 8687, apart: {}}`), "plan");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.sidecars, ["billing", "perf-collector"]);
  assertEquals(r.value.names.sidecarServices, { "perf-collector": "bonk-chess-perf-collector" });
  assertEquals(Object.keys(r.value.sidecarServicesYaml), ["perf-collector"]);
  const s = await built(withApart(`{port: 8687, apart: {}}`), "service");
  const names = s.value.spec.template.spec.containers.map((c: { name: string }) => c.name);
  assert(names.includes("billing") && !names.includes("perf-collector"), names.join(","));
  const caddy = Object.fromEntries(s.value.spec.template.spec.containers[0].env.filter((e: { value?: string }) => e.value).map((e: { name: string; value: string }) => [e.name, e.value]));
  assertEquals(caddy.PRONTO_UPSTREAM_BILLING, "127.0.0.1:8688");
  assertEquals(caddy.PRONTO_UPSTREAM_PERF_COLLECTOR, "https://bonk-chess-perf-collector-123.us-central1.run.app");
  const own = (await built(withApart(`{port: 8687, apart: {}}`), "sidecarServices")).value["perf-collector"];
  assertEquals(own.metadata.name, "bonk-chess-perf-collector");
  const [c] = own.spec.template.spec.containers;
  assertStringIncludes(c.image, `battlechess-perf-collector@${digest("7")}`);
  assertEquals(c.ports, [{ name: "http1", containerPort: 8687 }]);
  assertEquals(own.spec.template.spec.serviceAccountName, "battlechess-run@brawl-chess.iam.gserviceaccount.com");
  // None at rest, as the cluster: it wakes on the door's requests.
  assertEquals(own.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"], "0");
  assertEquals(own.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"], undefined);
  // A preview's is named for it.
  const preview = await built(withApart(`{port: 8687, apart: {}}`, `, preview: "rc"`), "plan");
  assertEquals(preview.value.names.sidecarServices, { "perf-collector": "bonk-chess-rc-perf-collector" });
});

Deno.test("a sidecar apart reaches the gateway through the door, one inside at loopback", async () => {
  const r = await built(withApart(`{port: 8687, apart: {}}`), "plan");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.peers["perf-collector"]["http://crud:3000"], "https://bonk-chess-123.us-central1.run.app/crud");
  assertEquals(r.value.peers["perf-collector"]["http://perf-collector:8687"], "https://bonk-chess-perf-collector-123.us-central1.run.app");
  assertEquals(r.value.peers.billing["crud:3000"], "127.0.0.1:3000");
  assertEquals(r.value.peers.billing["perf-collector:8687"], undefined, "one apart is no peer at loopback");
});

Deno.test("a worker apart keeps an instance, its CPU unthrottled between requests", async () => {
  const own = (await built(withApart(`{port: 8687, apart: minScale: 1}`), "sidecarServices")).value["perf-collector"];
  assertEquals(own.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"], "1");
  assertEquals(own.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"], "false");
});

Deno.test("a sidecar apart's metrics are scraped by a collector in its own service", async () => {
  const r = await built(withApart(`{port: 8687, metrics: port: 9599, apart: {}}`), "plan");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.scrapeConfig, "", "the cluster's instance scrapes nothing");
  assertEquals(r.value.names.sidecarScrapeConfigs, { "perf-collector": "battlechess-perf-collector-gmp-config" });
  assertStringIncludes(r.value.sidecarScrapeConfigs["battlechess-perf-collector-gmp-config"], "port: 9599");
  const own = (await built(withApart(`{port: 8687, metrics: port: 9599, apart: {}}`), "sidecarServices")).value["perf-collector"];
  const spec = own.spec.template.spec;
  assertEquals(spec.containers.map((c: { name: string }) => c.name), ["perf-collector", "gmp-collector"]);
  assertEquals(spec.volumes[0].secret.secretName, "battlechess-perf-collector-gmp-config");
  assertEquals(JSON.parse(own.spec.template.metadata.annotations["run.googleapis.com/container-dependencies"]), { "gmp-collector": ["perf-collector"] });
  const main = await built(withApart(`{port: 8687, metrics: port: 9599, apart: {}}`), "service");
  assert(!main.value.spec.template.spec.containers.some((c: { name: string }) => c.name === "gmp-collector"));
});

Deno.test("a revision of more than 10 containers is refused, and fits with sidecars apart", async () => {
  const many = ["s1", "s2", "s3", "s4"];
  const pushedAll = `{${["caddy", "crud", "auth", "electric", "database", "migrate", "ticker", "rclone-s3", "imgproxy", ...many].map((s, i) => `"${s}": {tag: "latest", digest: "${digest(String(i % 10))}"}`).join(", ")}}`;
  const full = (apart: string[]) => `{name: "battlechess", service: "bonk-chess", project: "brawl-chess", runHost: "bonk-chess-123.us-central1.run.app", image: pushed: ${pushedAll}, ticker: {}, blobs: {}, sidecars: {${many.map((n, i) => `${n}: {port: ${8700 + i}, cpu: 100${apart.includes(n) ? ", apart: {}" : ""}}`).join(", ")}}}`;
  const over = await built(full([]), "plan");
  assertEquals(over.success, false, "12 containers in one revision");
  assertStringIncludes(over.stderr, "over Cloud Run's 10");
  const fits = await built(full(["s1", "s2"]), "plan");
  assertEquals(fits.success, true, fits.stderr);
});

// An app that acts for its owner alone (Pronto Studio, which drives Claude and git for them):
// Identity-Aware Proxy in front, so only the people the project's owner admits reach it.
Deno.test("an app behind IAP is the owner's alone; a preview of it is not, so its drivers reach it", async () => {
  const r = await built(release(", iap: true"), "plan");
  assertEquals(r.success, true, r.stderr);
  assertEquals(r.value.iap, true);
  const s = await built(release(", iap: true"), "service");
  assertEquals(s.value.metadata.annotations["run.googleapis.com/iap-enabled"], "true");
  const p = await built(release(", iap: true, preview: \"pr-7\""), "plan");
  assertEquals(p.value.iap, false);
  const ps = await built(release(", iap: true, preview: \"pr-7\""), "service");
  assertEquals(ps.value.metadata.annotations["run.googleapis.com/iap-enabled"], undefined);
  const plain = await built(release(), "plan");
  assertEquals(plain.value.iap, false);
});

Deno.test("an app always on keeps its CPU between requests; by default it is throttled", async () => {
  const on = await built(release(", alwaysOn: true"), "service");
  assertEquals(on.success, true, on.stderr);
  assertEquals(on.value.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"], "false");
  const off = await built(release(), "service");
  assertEquals(off.value.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"], undefined);
});

Deno.test("a sidecar's memory is its container's, inside the instance or apart", async () => {
  const s = await built(withSidecar(`{port: 8687, memory: "4Gi"}`), "service");
  assertEquals(s.success, true, s.stderr);
  const inside = s.value.spec.template.spec.containers.find((c: { name: string }) => c.name === "perf-collector");
  assertEquals(inside.resources.limits, { cpu: "250m", memory: "4Gi" });
  const apart = (await built(withApart(`{port: 8687, memory: "2Gi", apart: {}}`), "sidecarServices")).value["perf-collector"];
  assertEquals(apart.spec.template.spec.containers[0].resources.limits.memory, "2Gi");
  const bad = await built(withSidecar(`{port: 8687, memory: "lots"}`), "service");
  assertEquals(bad.success, false);
});
