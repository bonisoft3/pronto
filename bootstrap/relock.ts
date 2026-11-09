// Writes mise.lock beside this file: the lock bootstrap ships for the default
// roster, every platform's artifact URL and checksum, so a consumer's first
// install fetches each artifact directly and asks GitHub's API nothing.
//
//   GITHUB_TOKEN=$(gh auth token) deno run -A plugins/pronto/bootstrap/relock.ts
//
// Run it whenever a roster pin moves; bootstrap_test fails on a pin the lock
// does not cover. `mise lock` reads release metadata from GitHub's API, so it
// wants a token. A release that publishes no checksums (mkcert, caddy, an
// http: tool) is downloaded once here to checksum it.
import { join } from "node:path";

const PLATFORMS = [
  "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl",
  "macos-x64", "macos-arm64", "windows-x64", "windows-arm64",
];
const HOST_PLATFORMS = PLATFORMS.filter((p) => p !== "windows-arm64");

const here = import.meta.dirname!;
const repo = join(here, "../../..");
// Sayt's pinned mise, the one a consumer's install runs: another mise writes
// another lock (2026.9 drops http: tools' platform entries).
const tools = join(repo, "plugins/sayt/tools.nu");

async function run(cmd: string, args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}): Promise<string> {
  const child = new Deno.Command(cmd, { args, cwd: opts.cwd, env: opts.env, stdin: opts.stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" }).spawn();
  if (opts.stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const out = await child.output();
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout);
}

const checksumCache = new Map<string, string>();
async function sha256Url(url: string): Promise<string> {
  const cached = checksumCache.get(url);
  if (cached !== undefined) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await res.arrayBuffer()));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  checksumCache.set(url, hex);
  return hex;
}

async function lockConfig(field: "mise" | "miseHost", configFile: string, lockFile: string, platforms: string[], miseEnv?: string): Promise<void> {
  const roster = await run("cue", ["export", "-", "-e", "out", "--out", "text"], {
    cwd: repo,
    stdin: `package roster

import (
	"encoding/toml"
	"bonisoft.org/plugins/pronto/distribution"
	terminal "bonisoft.org/plugins/pronto/terminals:omnishell"
	"bonisoft.org/plugins/pronto/clusters:mecha"
	"bonisoft.org/plugins/pronto/builders:bayt"
)

out: toml.Marshal((distribution.#Project & terminal.#Project & mecha.#Project & bayt.#Toolchain).${field})
`,
  });

  const work = await Deno.makeTempDir({ prefix: "pronto-relock-" });
  try {
    try {
      const prev = await Deno.readTextFile(join(here, lockFile));
      for (const b of prev.split(/^(?=\[)/m)) {
        const cs = b.match(/^checksum = "sha256:([0-9a-f]{64})"/m)?.[1];
        const u = b.match(/^url = "([^"]+)"/m)?.[1];
        if (cs && u) checksumCache.set(u, cs);
      }
    } catch { /* no existing lock */ }
    await Deno.writeTextFile(join(work, configFile), roster);
    await Deno.writeTextFile(join(work, lockFile), "");
    const env: Record<string, string> = {
      MISE_LOCKED: "0",
      MISE_TRUSTED_CONFIG_PATHS: work,
      MISE_GLOBAL_CONFIG_FILE: join(work, "none.toml"),
    };
    const args = [tools, "mise", ...(miseEnv ? ["-E", miseEnv] : []), "lock", "--platform", platforms.join(",")];
    await run("nu", args, { cwd: work, env });

    let lock = (await Deno.readTextFile(join(work, lockFile))).replace(/^provenance = .*\n/gm, "");
    const blocks = lock.split(/^(?=\[)/m);
    for (const [i, block] of blocks.entries()) {
      if (!/^\[tools\."[^"]+"\."platforms\.[^"]+"\]\n/.test(block) || /^checksum = /m.test(block)) continue;
      const url = block.match(/^url = "([^"]+)"/m)?.[1];
      if (url === undefined) throw new Error(`a lock entry carries no url:\n${block}`);
      const hex = await sha256Url(url);
      blocks[i] = block.replace(`url = "${url}"`, `checksum = "sha256:${hex}"\nurl = "${url}"`);
    }
    lock = blocks.join("");
    for (const tool of lock.matchAll(/^\[\[tools\."([^"]+)"\]\]$/gm)) {
      if (!lock.includes(`[tools."${tool[1]}"."platforms.`)) throw new Error(`${tool[1]}: mise lock wrote no platform entry`);
    }
    await Deno.writeTextFile(join(here, lockFile), lock);
    console.log(`wrote ${join(here, lockFile)}`);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

await lockConfig("mise", ".mise.toml", "mise.lock", PLATFORMS);
await lockConfig("miseHost", ".mise.host.toml", "mise.host.lock", HOST_PLATFORMS, "host");
