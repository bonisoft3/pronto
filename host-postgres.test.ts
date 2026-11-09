// mise runs a postinstall only when it installs, and a host that installed
// PostgreSQL 18.6.1 before #2308 kept the pljs.so whose exported
// unicode_normalize bound to the backend's: normalize() answered garbage or
// killed the backend, and `mise install` saw the version installed. The host
// tool's name is its recipe's digest, so a changed recipe installs anew.
import { assertEquals } from "jsr:@std/assert@1.0.11";

const dir = new URL("./clusters", import.meta.url);

async function exported(expr: string): Promise<unknown> {
  const out = await new Deno.Command("cue", { args: ["export", ".", "-e", expr, "--out", "json"], cwd: dir, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

Deno.test("the host's PostgreSQL is named by the digest of the recipe its postinstall runs", async () => {
  const aliases = await exported("#HostToolAliases") as Record<string, string>;
  const [name] = Object.entries(aliases).find(([, backend]) => backend === "github:theseus-rs/postgresql-binaries")!;
  const tools = await exported("#HostTools") as Record<string, { postinstall: string }>;
  const encoded = tools[name].postinstall.match(/'([A-Za-z0-9+/=]+)' \| decode base64/)![1];
  const script = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", script)), (b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(name, `postgres-${digest.slice(0, 12)}`);
});
