// prerelease.sh stamps distribution/config.cue's #Project.mise with the fork's default
// CUE_REGISTRY (its mise.env edit()). The stamp must stay open: an app importing the
// published module still sets its own mise env vars (pronto.mise.env.<VAR>). Runs the
// real edit, extracted from prerelease.sh, against a git-archive snapshot — prerelease.sh's
// own isolation — so nothing here touches the working tree.
import { assertEquals } from "jsr:@std/assert@1.0.11";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const decoder = new TextDecoder();

// Pulls the `def edit` helper and the registry/mise.env edit() call out of prerelease.sh,
// so this test runs the maintained script rather than a copy that can drift from it.
function extractStampScript(): string {
  const lines = Deno.readTextFileSync(`${repo}/prerelease.sh`).split("\n");
  const defIdx = lines.findIndex((l) => l.trim() === "def edit(p, f):");
  const registryIdx = lines.findIndex((l) => l.trim().startsWith("registry = "));
  const stampIdx = lines.findIndex((l) => l.includes("edit('distribution/config.cue', lambda s: s.replace('\\tmise:"));
  if (defIdx < 0 || registryIdx < 0 || stampIdx < 0) {
    throw new Error("prerelease.sh's mise.env stamp moved; update this test's extraction");
  }
  return [lines[defIdx], lines[defIdx + 1], lines[registryIdx], lines[stampIdx]].join("\n");
}

async function sh(cwd: string, cmd: string, ...args: string[]) {
  const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")}: ${decoder.decode(out.stderr)}`);
}

Deno.test("prerelease.sh's mise.env stamp stays open: an app may still set another mise env var", async () => {
  const work = await Deno.makeTempDir({ prefix: "prerelease-stamp-" });
  try {
    await sh(repo, "git", "archive", "HEAD", "--output", `${work}.tar`);
    await Deno.mkdir(work, { recursive: true });
    await sh(work, "tar", "x", "-f", `${work}.tar`, "-C", work);
    await Deno.remove(`${work}.tar`);

    const child = new Deno.Command("python3", { args: ["-I", "-"], cwd: work, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(extractStampScript()));
    await writer.close();
    const stampResult = await child.output();
    if (!stampResult.success) throw new Error(decoder.decode(stampResult.stderr));

    await Deno.mkdir(`${work}/probe`);
    await Deno.writeTextFile(
      `${work}/probe/probe.cue`,
      `package probe\nimport "github.com/bonisoft3/pronto/distribution"\npronto: distribution.#Project & {\n\tmise: env: FOO: "bar"\n}\n`,
    );
    const vet = await new Deno.Command("cue", { args: ["vet", "./probe/..."], cwd: work, stdout: "piped", stderr: "piped" }).output();
    assertEquals(vet.success, true, decoder.decode(vet.stderr));
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});
