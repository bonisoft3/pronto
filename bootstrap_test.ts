import { fileURLToPath } from "node:url";
import { join } from "node:path";
import $ from "@david/dax";
import { projectSay } from "./project-config.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const decoder = new TextDecoder();

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

Deno.test("registry bootstrap is terminal-independent, regenerates, and preserves existing seeds", async () => {
  const scratch = await Deno.makeTempDir({ prefix: "pronto-distribution-" });
  const registry = new Deno.Command("cue", {
    args: ["mod", "registry", "localhost:0"], stdout: "piped", stderr: "piped",
  }).spawn();
  const stdout = registry.stdout.getReader();
  const stderr = registry.stderr.getReader();
  try {
    const first = await Promise.race([stdout.read(), stderr.read()]);
    const address = decoder.decode(first.value).match(/listening on (\S+)/)?.[1];
    assert(address, "registry did not announce its address");
    const env = { CUE_REGISTRY: `${address}+insecure`, CUE_CACHE_DIR: join(scratch, "cache") };
    async function cue(cwd: string, args: string[], success = true): Promise<string> {
      const result = await new Deno.Command("cue", { args, cwd, env, stdout: "piped", stderr: "piped" }).output();
      assert(result.success === success, `${args.join(" ")}: ${decoder.decode(result.stderr)}`);
      return decoder.decode(result.stdout);
    }
    const modules = [
      ["plugins/bayt", "bayt", "0.52.1"],
      ["plugins/sayt", "sayt", "0.39.1"],
      ["libraries/mecha", "mecha", "0.1.3"],
      ["plugins/omnishell", "omnishell", "0.2.2"],
      ["plugins/pronto", "pronto", "0.3.1"],
    ];
    async function copy(source: string, target: string): Promise<void> {
      await Deno.mkdir(target, { recursive: true });
      for await (const entry of Deno.readDir(source)) {
        if ([".git", ".github", ".mirror", "node_modules", "dist", "zig-out", ".zig-cache"].includes(entry.name)) continue;
        const from = join(source, entry.name), to = join(target, entry.name);
        if (entry.isDirectory) await copy(from, to);
        else if (entry.isFile) {
          if (entry.name.endsWith(".cue")) {
            let content = await Deno.readTextFile(from);
            for (const [local, name] of modules) content = content.replaceAll(`bonisoft.org/${local}`, `github.com/bonisoft3/${name}`);
            await Deno.writeTextFile(to, content);
          } else await Deno.copyFile(from, to);
        }
      }
    }
    for (const [local, name, version] of modules) {
      const source = name === "sayt" ? Deno.env.get("PRONTO_SAYT_SOURCE") ?? join(repo, local) : join(repo, local);
      const mirror = join(scratch, name);
      await copy(source, mirror);
      await Deno.mkdir(join(mirror, "cue.mod"), { recursive: true });
      await Deno.copyFile(join(source, ".mirror/cue.mod/module.cue"), join(mirror, "cue.mod/module.cue"));
      await cue(mirror, ["mod", "edit", "--source=self"]);
      await cue(mirror, ["mod", "tidy"]);
      await cue(mirror, ["mod", "publish", `v${version}`]);
    }
    const app = join(scratch, "consumer with spaces");
    await Deno.mkdir(app);
    await cue(app, ["mod", "init", "example.com/consumer@v0"]);
    await cue(app, ["mod", "get", "github.com/bonisoft3/pronto@v0.3.1"]);
    await cue(app, ["cmd", "bootstrap", "github.com/bonisoft3/pronto/bootstrap@v0"]);
    const mise = await Deno.readTextFile(join(app, ".mise.toml"));
    const say = await Deno.readTextFile(join(app, ".say.yaml"));
    assert(!/omnishell|mecha|\/Users\/|\.\.\/plugins/.test(mise + say), "bootstrap leaked a battery or source path");
    await cue(app, ["cmd", "generate", "./pronto"]);
    assert(mise === await Deno.readTextFile(join(app, ".mise.toml")), "Mise generation drifted");
    assert(say === await Deno.readTextFile(join(app, ".say.yaml")), "Sayt generation drifted");
    await cue(app, ["cmd", "bootstrap", "github.com/bonisoft3/pronto/bootstrap@v0"], false);
    assert(say === await Deno.readTextFile(join(app, ".say.yaml")), "bootstrap overwrote existing configuration");
    await Deno.writeTextFile(join(app, "pronto/terminal.cue"), 'package prontoproject\nimport terminal "github.com/bonisoft3/pronto/terminals:omnishell"\npronto: terminal.#Project\n');
    await cue(app, ["cmd", "generate", "./pronto"]);
    assert((await Deno.readTextFile(join(app, ".say.yaml"))).includes("omnishell materialize"), "terminal did not contribute its commands");
    assert((await Deno.readTextFile(join(app, ".mise.toml"))).includes("github:bonisoft3/omnishell"), "terminal did not contribute its tool");
    await Deno.writeTextFile(join(app, "pronto/builder.cue"), 'package prontoproject\nimport builder "github.com/bonisoft3/pronto/builders:bayt"\npronto: builder.#Toolchain\npronto: say: say: generate: rulemap: custom: {priority: 3, cmds: [{do: "print custom"}]}\n');
    const previousRegistry = Deno.env.get("CUE_REGISTRY");
    const previousCache = Deno.env.get("CUE_CACHE_DIR");
    try {
      for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
      for (let pass = 0; pass < 2; pass++) {
        await cue(app, ["cmd", "generate", "./pronto"]);
        const merged = await projectSay(app, { say: { generate: { rulemap: { pronto: { priority: 1 } } } } }) as {say: {generate: {rulemap: Record<string, {priority: number}>}}};
        assert(merged.say.generate.rulemap["auto-bayt"].priority === 2, "writer dropped builder ordering");
        assert(merged.say.generate.rulemap.custom.priority === 3, "writer dropped the consumer rule");
      }
      const fixture = join(repo, "apps/jsfb");
      for await (const entry of Deno.readDir(fixture)) {
        if (entry.name.startsWith(".") || ["mise.lock", "bayt.cue", "bayt.json", "program_terminal.cue", "program_pronto.cue"].includes(entry.name)) continue;
        const source = join(fixture, entry.name), target = join(app, entry.name);
        if (entry.isDirectory) await copy(source, target);
        else if (entry.isFile) {
          let content = await Deno.readTextFile(source);
          if (entry.name.endsWith(".cue")) {
            for (const [local, name] of modules) content = content.replaceAll(`bonisoft.org/${local}`, `github.com/bonisoft3/${name}`);
          }
          await Deno.writeTextFile(target, content);
        }
      }
      await Deno.writeTextFile(join(app, "program_pronto.cue"), 'package jsfb\nloop: surface: sources: pronto: ""\n');
      async function deno(script: string, args: string[]): Promise<string> {
        const result = await new Deno.Command(Deno.execPath(), {
          args: ["run", "--no-check", "--config", join(scratch, "pronto/deno.json"), "--allow-read", "--allow-write=.", "--allow-run", "--allow-env", script, ...args],
          cwd: app, env, stdout: "piped", stderr: "piped",
        }).output();
        assert(result.success, decoder.decode(result.stderr));
        return decoder.decode(result.stdout);
      }
      const terminal = join(scratch, "omnishell/runtime/cli.ts");
      await deno(terminal, ["materialize", "."]);
      await Deno.writeTextFile(join(app, "program_terminal.cue"), await deno(terminal, ["mode", "."]));
      let written = "";
      for (let pass = 0; pass < 2; pass++) {
        await cue(app, ["cmd", "generate", "./pronto"]);
        await deno(join(scratch, "pronto/write.ts"), ["."]);
        const build = JSON.parse(await Deno.readTextFile(join(app, "bayt.json")));
        assert(build.name === "jsfb", "standalone build has an invalid project name");
        const dockerfile = await cue(app, ["export", ".", "-e", "(_render & {depManifests: {}}).docker.dockerfiles.build", "--out", "text"]);
        assert(dockerfile.startsWith("FROM jsfb-setup AS build\n"), "standalone Dockerfile has an invalid setup context");
        const generated = await Deno.readTextFile(join(app, ".say.yaml"));
        assert(generated.includes("custom:"), "real writer lost the consumer rule");
        assert(!generated.includes("../../plugins"), "external writer emitted a monorepo command");
        if (pass === 1) assert(generated === written, "real writer did not settle");
        written = generated;
      }
    } finally {
      if (previousRegistry === undefined) Deno.env.delete("CUE_REGISTRY"); else Deno.env.set("CUE_REGISTRY", previousRegistry);
      if (previousCache === undefined) Deno.env.delete("CUE_CACHE_DIR"); else Deno.env.set("CUE_CACHE_DIR", previousCache);
    }
    await Deno.writeTextFile(join(app, "pronto/conflict.cue"), 'package prontoproject\npronto: tools: "github:denoland/deno": "0.0.0"\n');
    await cue(app, ["cmd", "generate", "./pronto"], false);
  } finally {
    registry.kill("SIGTERM");
    await registry.status;
    await stdout.cancel();
    await stderr.cancel();
    async function writable(dir: string): Promise<void> {
      await $.path(dir).chmod(0o700);
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory) await writable(join(dir, entry.name));
        else if (entry.isFile) await $.path(join(dir, entry.name)).chmod(0o600);
      }
    }
    await writable(scratch);
    await $`rm -rf ${scratch}`;
  }
});
