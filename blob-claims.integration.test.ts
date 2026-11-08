// A write to the blob plane through what a container release runs: the door's own
// routes, the real PostgREST and the real rclone-s3. Regression rationale: the plane
// authorized nothing, so anyone reaching the door could list, overwrite and delete
// every object; and a provider fetching an order's artwork must get the very bytes
// written, so the raw read stays and returns them unchanged.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const cluster = await Deno.readTextFile(new URL("../../libraries/mecha/cluster.cue", import.meta.url));
const pinned = (name: string) => {
  const found = cluster.match(new RegExp(`"(${name}:[^"@]+@sha256:[0-9a-f]{64})"`))?.[1];
  if (!found) throw new Error(`cluster.cue pins no ${name} image`);
  return found;
};
const SECRET = "blob-claims-test-secret-of-32-characters";

async function run(cmd: string, args: string[], stdin?: string) {
  const child = new Deno.Command(cmd, { args, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const res = await child.output();
  return { ok: res.success, out: new TextDecoder().decode(res.stdout).trim(), err: new TextDecoder().decode(res.stderr) };
}

async function token(sub: string): Promise<string> {
  const b64 = (t: string | Uint8Array) => btoa(typeof t === "string" ? t : String.fromCharCode(...t)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const body = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify({ role: "app_user", sub, guest: true }))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}

async function doorRoutes(): Promise<string> {
  const door = await Deno.readTextFile(new URL("./assets/Caddyfile", import.meta.url));
  const route = (name: string) => {
    const found = door.match(new RegExp(`  handle /${name}/\\* \\{\\n[\\s\\S]*?\\n  \\}\\n`))?.[0];
    if (!found) throw new Error(`the door has no ${name} route`);
    return found;
  };
  return `{\n  admin off\n  auto_https off\n}\n(bounded-crud) {\n}\n(bounded-blobs) {\n}\n:8080 {\n${route("blob-claim")}${route("blobs")}\n}\n`;
}

Deno.test({ name: "a session writes only the keys it claimed, once, and reads back the same bytes", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const files = await emitFiles(paymentProgram({ vendored: "" }).replace("capabilities: {hatches: {},", "capabilities: {blobs: true, hatches: {},"));
  const tag = crypto.randomUUID().slice(0, 8);
  const network = `blobs-${tag}`, db = `blobs-pg-${tag}`, rest = `blobs-rest-${tag}`, store = `blobs-s3-${tag}`, door = `blobs-door-${tag}`;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/Caddyfile`, await doorRoutes());
  const psql = (sql: string) => run("docker", ["exec", "-i", db, "psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], sql);
  const must = async (r: Promise<{ ok: boolean; err: string }>) => {
    const done = await r;
    if (!done.ok) throw new Error(done.err);
  };
  try {
    await must(run("docker", ["network", "create", network]));
    await must(run("docker", ["run", "-d", "--rm", "--name", db, "--network", network, "--network-alias", "database", "-e", "POSTGRES_PASSWORD=pw", POSTGRES]));
    for (let i = 0; !(await run("docker", ["exec", db, "pg_isready", "-qh", "127.0.0.1", "-U", "postgres"])).ok; i++) {
      if (i > 60) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    await must(psql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE app_user NOLOGIN;
      ${await Deno.readTextFile(new URL("../../libraries/mecha/services/database/rls/rls.sql", import.meta.url)).then((s) => s.match(/CREATE OR REPLACE FUNCTION public\.auth_uid\(\)[\s\S]*?;\n/)?.[0] ?? "")}
      ${files["services/database/migrations/803_blob_claims.sql"].text}`));
    await must(run("docker", ["run", "-d", "--rm", "--name", rest, "--network", network, "--network-alias", "crud",
      "-e", "PGRST_DB_URI=postgres://postgres:pw@database:5432/postgres", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${SECRET}`, pinned("postgrest/postgrest")]));
    await must(run("docker", ["run", "-d", "--rm", "--name", store, "--network", network, "--network-alias", "rclone-s3", "--entrypoint", "sh", pinned("rclone/rclone"),
      "-c", "mkdir -p /data/mecha-objects && exec rclone serve s3 --addr=0.0.0.0:3900 --vfs-cache-mode=off /data"]));
    await must(run("docker", ["run", "-d", "--rm", "--name", door, "--network", network, "-p", "127.0.0.1::8080", "-v", `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
      pinned("caddy"), "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]));
    const port = (await run("docker", ["port", door, "8080"])).out.split(":").pop();
    const at = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
    const status = async (path: string, init: RequestInit = {}) => {
      const res = await at(path, init);
      await res.body?.cancel();
      return res.status;
    };
    const one = { authorization: `Bearer ${await token("00000000-0000-0000-0000-000000000001")}` };
    const two = { authorization: `Bearer ${await token("00000000-0000-0000-0000-000000000002")}` };
    const key = `${crypto.randomUUID()}.jpg`;
    for (let i = 0; (await status(`/blob-claim/${key}`, { method: "POST", body: "{}" }).catch(() => 0)) !== 401; i++) {
      if (i > 120) throw new Error("the door or PostgREST did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    // Every byte value, so an image re-encoded or a body read as text would differ.
    const bytes = new Uint8Array(65536).map((_, i) => i % 251);

    await t.step("no session claims nothing and writes nothing", async () => {
      assertEquals(await status(`/blob-claim/${key}`, { method: "POST", body: "{}" }), 401);
      assertEquals(await status(`/blobs/mecha-objects/${key}`, { method: "PUT", body: bytes }), 403);
    });
    await t.step("a guest's session claims, another session cannot claim or write the same key", async () => {
      assertEquals((await status(`/blob-claim/${key}`, { method: "POST", body: "{}", headers: one })) < 300, true);
      assertEquals((await status(`/blob-claim/${key}`, { method: "POST", body: "{}", headers: one })) < 300, true, "a repeat by its holder is no refusal");
      assertEquals(await status(`/blob-claim/${key}`, { method: "POST", body: "{}", headers: two }), 409);
      assertEquals(await status(`/blobs/mecha-objects/${key}`, { method: "PUT", body: bytes, headers: two }), 403);
    });
    await t.step("the claimant's body survives the check, and the raw read returns those bytes", async () => {
      assertEquals(await status(`/blobs/mecha-objects/${key}`, { method: "PUT", body: bytes, headers: { ...one, "content-type": "image/jpeg" } }), 200);
      const read = await at(`/blobs/mecha-objects/${key}`);
      assertEquals(read.status, 200);
      assertEquals(new Uint8Array(await read.arrayBuffer()), bytes);
    });
    await t.step("written bytes stay out of another session's reach", async () => {
      // rclone serve s3 ignores If-None-Match, so the claimant may replace its own.
      assertEquals(await status(`/blobs/mecha-objects/${key}`, { method: "PUT", body: new Uint8Array([1]), headers: two }), 403);
      assertEquals((await (await at(`/blobs/mecha-objects/${key}`)).arrayBuffer()).byteLength, bytes.length);
    });
    await t.step("no listing and no delete", async () => {
      assertEquals(await status("/blobs/mecha-objects/"), 405);
      assertEquals(await status("/blobs/"), 405);
      assertEquals(await status(`/blobs/mecha-objects/${key}`, { method: "DELETE", headers: one }), 405);
    });
    await t.step("a read may name a nested key, as an effect's stowed bytes are", async () => {
      assertEquals(await status("/blobs/mecha-objects/effects/absent.png"), 404);
      assertEquals(await status("/blobs/other-bucket/absent.pdf"), 404);
    });
    await t.step("a key that is no key is refused, and the budget holds", async () => {
      assertEquals(await status("/blob-claim/no-extension", { method: "POST", body: "{}", headers: one }), 400);
      await must(psql(`INSERT INTO blob_plane.claim (key, owner) SELECT 'k' || g || '.jpg', '00000000-0000-0000-0000-000000000002' FROM generate_series(1, 1000) g`));
      assertEquals(await status(`/blob-claim/${crypto.randomUUID()}.jpg`, { method: "POST", body: "{}", headers: two }), 429);
    });
    // No opt-out exists: an app whose database has no claim functions gets no writes.
    await t.step("without the claim functions the door still refuses every write", async () => {
      await must(psql("DROP FUNCTION public.upload_allowed(text)"));
      const refused = await status(`/blobs/mecha-objects/${key}`, { method: "PUT", body: new Uint8Array([1]), headers: one });
      assertEquals(refused >= 400 && refused < 500, true, `answered ${refused}`);
      assertEquals((await (await at(`/blobs/mecha-objects/${key}`)).arrayBuffer()).byteLength, bytes.length);
    });
  } finally {
    for (const name of [door, store, rest, db]) await run("docker", ["rm", "-f", name]);
    await run("docker", ["network", "rm", network]);
    await Deno.remove(dir, { recursive: true });
  }
} });
