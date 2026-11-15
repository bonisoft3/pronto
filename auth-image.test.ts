// A program may name the image its auth service runs, one its cluster
// unification builds FROM mecha's: the service is still mecha's (entrypoint,
// environment, route), so the image answers mecha's token contract. Naming
// none keeps mecha's own, and the terminal never sees the choice. Env files
// reach the service the same way, beside mecha's closed environment.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const withAuth = (image = "", envFiles = "") => paymentProgram() + `
app: capabilities: auth: {required: false, service: "/auth", promote: true${image ? `, image: ${image}` : ""}${envFiles ? `, envFiles: ${envFiles}` : ""}}
`;

async function images(code: string): Promise<Record<string, unknown>> {
  const res = await cue(["export", "-", "-e", "_cluster.meta.images", "--out", "json"], code);
  if (!res.success) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

Deno.test("the auth service runs the program's image when it names one", async () => {
  const named = await images(withAuth(`{ref: ":google-auth-image"}`));
  assertEquals(named.auth, { ref: ":google-auth-image" });
  assertEquals(named.database, { name: "libraries_mecha-database-image" });
  const pinned = await images(withAuth(`{name: "registry.example/auth@sha256:0123"}`));
  assertEquals(pinned.auth, { name: "registry.example/auth@sha256:0123" });
});

Deno.test("naming none keeps mecha's auth image", async () => {
  assertEquals((await images(withAuth())).auth, { name: "libraries_mecha-auth-image" });
});

Deno.test("the terminal's config carries the auth block without the image", async () => {
  const files = await emitFiles(withAuth(`{ref: ":google-auth-image"}`, `["google/client.env"]`)) as unknown as Record<string, { data: { auth: unknown } }>;
  for (const f of ["shell/shell.yaml", "shell/shell.json"]) {
    assertEquals(files[f].data.auth, { required: false, service: "/auth", promote: true, mode: "passkey" }, f);
  }
});

Deno.test("an image is a target of this program's cluster or a name", async () => {
  for (const image of [`{ref: "libraries_mecha:auth-image"}`, `{ref: ":Bad"}`, `{name: ""}`, `":google-auth-image"`]) {
    const res = await cue(["export", "-", "-e", "app"], withAuth(image));
    assertEquals(res.success, false, image);
  }
});

Deno.test("env files reach the auth service's compose, optional and from .bayt/", async () => {
  const files = await emitFiles(withAuth(`{ref: ":google-auth-image"}`, `["google/client.env", "google/google.env"]`)) as unknown as Record<string, { data: { targets: Record<string, { compose: { env_file?: unknown } }> } }>;
  assertEquals(files["bayt.json"].data.targets.auth.compose.env_file, [
    { path: "../google/client.env", required: false },
    { path: "../google/google.env", required: false },
  ]);
  const none = await emitFiles(withAuth()) as unknown as Record<string, { data: { targets: Record<string, { compose: { env_file?: unknown } }> } }>;
  assertEquals(none["bayt.json"].data.targets.auth.compose.env_file, undefined);
});

Deno.test("an env file stays inside the app", async () => {
  for (const f of [`["../secrets.env"]`, `["/etc/app.env"]`, `["google/a/../../x.env"]`, `["google/client.txt"]`]) {
    const res = await cue(["export", "-", "-e", "app"], withAuth("", f));
    assertEquals(res.success, false, f);
  }
});
