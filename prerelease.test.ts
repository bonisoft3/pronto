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

// The adapters' `#Version` pins, rewritten at publish: the `def pin` helper and its two calls, as prerelease.sh has them.
function extractPinScript(): string {
  const lines = Deno.readTextFileSync(`${repo}/prerelease.sh`).split("\n");
  const defIdx = lines.findIndex((l) => l.trim() === "def pin(p, v):");
  const lastIdx = lines.findIndex((l) => l.includes("pin('terminals/omnishell.cue'"));
  if (defIdx < 0 || lastIdx < 0) throw new Error("prerelease.sh's adapter pins moved; update this test's extraction");
  return ["import re", "mecha_v, omnishell_v = '0.25.1-host.2', '0.25.0-fork.2'", ...lines.slice(defIdx, lastIdx + 1)].join("\n");
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

Deno.test("prerelease.sh pins each adapter's #Version to the prerelease's own mecha and omnishell", async () => {
  const work = await Deno.makeTempDir({ prefix: "prerelease-pins-" });
  try {
    for (const f of ["clusters/mecha.cue", "terminals/omnishell.cue"]) {
      await Deno.mkdir(`${work}/${f.split("/")[0]}`, { recursive: true });
      await Deno.copyFile(`${repo}/${f}`, `${work}/${f}`);
    }
    const run = async (script: string) => {
      const child = new Deno.Command("python3", { args: ["-I", "-"], cwd: work, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(script));
      await writer.close();
      return await child.output();
    };
    const done = await run(extractPinScript());
    assertEquals(done.success, true, decoder.decode(done.stderr));
    assertEquals(Deno.readTextFileSync(`${work}/clusters/mecha.cue`).match(/^#Version: .*$/m)?.[0], '#Version: "0.25.1-host.2"');
    assertEquals(Deno.readTextFileSync(`${work}/terminals/omnishell.cue`).match(/^#Version: .*$/m)?.[0], '#Version: "0.25.0-fork.2"');
    // A pin that moved out of the file fails the publish rather than going unedited.
    await Deno.writeTextFile(`${work}/terminals/omnishell.cue`, "package omnishell\n");
    const missing = await run(extractPinScript());
    assertEquals(missing.success, false);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});
