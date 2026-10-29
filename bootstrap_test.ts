import { fileURLToPath } from "node:url";
import { join } from "node:path";
import $ from "@david/dax";
import { projectSay } from "./project-config.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const decoder = new TextDecoder();

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

Deno.test("registry bootstrap seeds the default roster, regenerates, and preserves existing seeds", async () => {
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
      ["plugins/bayt", "bayt"],
      ["plugins/sayt", "sayt"],
      ["libraries/mecha", "mecha"],
      ["plugins/omnishell", "omnishell"],
      ["plugins/pronto", "pronto"],
    ].map(([local, name]) => [local, name, name === "sayt" ? Deno.env.get("PRONTO_SAYT_SOURCE") ?? join(repo, local) : join(repo, local)]);
    // Fixture module identity stays independent of the published tool self-pin.
    const prontoModule = JSON.parse(await cue(repo, ["export", join(repo, "plugins/pronto/.mirror/cue.mod/module.cue"), "--out", "json"])).module as string;
    const prontoMajor = prontoModule.match(/^github\.com\/bonisoft3\/pronto@(v\d+)$/)?.[1];
    assert(prontoMajor, `invalid Pronto module identity: ${prontoModule}`);
    const prontoVersion = `${prontoMajor}.0.0`;
    const versions = new Map<string, Set<string>>();
    // Transitive pins may intentionally lag the direct ones. Publish this
    // fixture's sources at every declared version into the isolated registry.
    for (const [, , source] of modules) {
      const module = JSON.parse(await cue(repo, ["export", join(source, ".mirror/cue.mod/module.cue"), "--out", "json"]));
      for (const [name, dependency] of Object.entries(module.deps ?? {}) as [string, {v: string}][]) {
        if (!versions.has(name)) versions.set(name, new Set());
        versions.get(name)!.add(dependency.v);
      }
    }
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
    for (const [, name, source] of modules) {
      const mirror = join(scratch, name);
      await copy(source, mirror);
      await Deno.mkdir(join(mirror, "cue.mod"), { recursive: true });
      await Deno.copyFile(join(source, ".mirror/cue.mod/module.cue"), join(mirror, "cue.mod/module.cue"));
      await cue(mirror, ["mod", "edit", "--source=self"]);
      await cue(mirror, ["mod", "tidy"]);
      if (name === "pronto") {
        versions.set(prontoModule, new Set([prontoVersion]));
      }
      const required = versions.get(name === "pronto" ? prontoModule : `github.com/bonisoft3/${name}@v0`);
      assert(required?.size, `no fixture version declared for ${name}`);
      for (const version of required) await cue(mirror, ["mod", "publish", version]);
    }
    const app = join(scratch, "consumer with spaces");
    await Deno.mkdir(app);
    await cue(app, ["mod", "init", "example.com/consumer@v0"]);
    await cue(app, ["mod", "get", `github.com/bonisoft3/pronto@${prontoVersion}`]);
    await cue(app, ["cmd", "bootstrap", `github.com/bonisoft3/pronto/bootstrap@${prontoMajor}`]);
    const mise = await Deno.readTextFile(join(app, ".mise.toml"));
    const say = await Deno.readTextFile(join(app, ".say.yaml"));
    const tools = JSON.parse(await cue(app, ["export", ".mise.toml", "--out", "json"])).tools;
    // The lock bootstrap ships is the roster's: a pin it does not cover would
    // send the first install to GitHub's API to resolve it.
    const lock = JSON.parse(await cue(app, ["export", "toml:", "mise.lock", "--out", "json"])).tools as Record<string, { version: string }[]>;
    const bare = (v: string) => v.replace(/^v/, "");
    for (const [tool, pin] of Object.entries(tools as Record<string, string | { version: string }>)) {
      const version = bare(typeof pin === "string" ? pin : pin.version);
      assert(lock[tool]?.some((entry) => bare(entry.version) === version), `${tool}@${version}: plugins/pronto/bootstrap/mise.lock has no entry; run plugins/pronto/bootstrap/relock.ts`);
    }
    const d2 = tools["github:terrastruct/d2"];
    assert(typeof d2 === "string" && /^v\d+\.\d+\.\d+$/.test(d2), "D2 must have an exact release pin");
    // A finish tag may update the CUE module while retaining an already
    // published tool self-pin; the source declarations own the runtime roster.
    const declaredPins = await Promise.all([
      ["mecha", "libraries/mecha/toolchain", '#Tools["github:bonisoft3/mecha"]'],
      ["omnishell", "plugins/omnishell/toolchain", '#Tools["github:bonisoft3/omnishell"]'],
      ["pronto", "plugins/pronto/distribution", "#Version"],
      ["sayt", "plugins/pronto/distribution", "#SaytVersion"],
      ["bayt", "plugins/pronto/builders:bayt", '#Toolchain.tools["github:bonisoft3/bayt"]'],
    ].map(async ([name, source, expression]) => {
      const version = (await cue(repo, ["export", `./${source}`, "-e", expression, "--out", "text"])).trim();
      return { name, source, expression, version };
    }));
    for (const { name, source, expression, version } of declaredPins) {
      assert(/^\d+\.\d+\.\d+$/.test(version), `${source} ${expression}: tool self-pin must be an exact release version`);
      assert(tools[`github:bonisoft3/${name}`] === version, `${name}: bootstrap tool version differs from ${source} ${expression}`);
    }
    const duckdb = tools["http:duckdb"];
    const assets: Record<string, string> = {
      "linux-x64": "linux-amd64",
      "linux-arm64": "linux-arm64",
      "linux-x64-musl": "linux-amd64-musl",
      "linux-arm64-musl": "linux-arm64-musl",
      "macos-x64": "osx-amd64",
      "macos-arm64": "osx-arm64",
      "windows-x64": "windows-amd64",
      "windows-arm64": "windows-arm64",
    };
    assert(duckdb.platforms, "DuckDB must declare its supported platforms");
    assert(!("url" in duckdb), "DuckDB must not fall back to a glibc URL on an unsupported platform");
    assert(JSON.stringify(Object.keys(duckdb.platforms).sort()) === JSON.stringify(Object.keys(assets).sort()), "DuckDB platform coverage differs");
    for (const [platform, asset] of Object.entries(assets)) {
      assert(duckdb.platforms[platform].url === `https://github.com/duckdb/duckdb/releases/download/v{{ version }}/duckdb_cli-${asset}.zip`, `DuckDB selects the wrong asset for ${platform}`);
    }
    assert(!/\/Users\/|\.\.\/plugins/.test(mise + say), "bootstrap leaked a battery or source path");
    // The seed carries the default roster, so the first lock and install
    // already see the whole toolchain: terminal omnishell, cluster mecha,
    // build bayt, with each seat's commands.
    for (const tool of ["github:bonisoft3/omnishell", "github:bonisoft3/mecha", "github:bonisoft3/bayt"]) {
      assert(mise.includes(tool), `bootstrap did not seed the default seat for ${tool}`);
    }
    assert(say.includes("omnishell mode"), "bootstrap did not seed the terminal's commands");
    assert(say.includes("do: auto-bayt"), "bootstrap did not seed the builder's commands");
    await cue(app, ["cmd", "generate", "./pronto"]);
    assert(mise === await Deno.readTextFile(join(app, ".mise.toml")), "Mise generation drifted");
    // Compared semantically, not by byte: the seed and the regeneration
    // compose the same roster two ways (one inline expression, one file),
    // and CUE orders the unified keys by composition, so the first
    // regeneration only reorders. Sayt reads the rules as data, and a
    // repeat generation is stable with itself.
    const sayJson = async (path: string): Promise<unknown> =>
      JSON.parse(await cue(app, ["export", path, "--out", "json"]));
    const norm = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(norm)
        : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
        : v;
    const sayNorm = JSON.stringify(norm(await sayJson(join(app, ".say.yaml"))));
    await cue(app, ["cmd", "generate", "./pronto"]);
    assert(sayNorm === JSON.stringify(norm(await sayJson(join(app, ".say.yaml")))), "Sayt generation drifted");
    const saySettled = await Deno.readTextFile(join(app, ".say.yaml"));
    await cue(app, ["cmd", "bootstrap", `github.com/bonisoft3/pronto/bootstrap@${prontoMajor}`], false);
    assert(saySettled === await Deno.readTextFile(join(app, ".say.yaml")), "bootstrap overwrote existing configuration");
    await Deno.writeTextFile(join(app, "pronto/terminal.cue"), 'package prontoproject\nimport terminal "github.com/bonisoft3/pronto/terminals:omnishell"\npronto: terminal.#Project\n');
    await cue(app, ["cmd", "generate", "./pronto"]);
    assert((await Deno.readTextFile(join(app, ".say.yaml"))).includes("omnishell mode"), "terminal did not contribute its commands");
    assert((await Deno.readTextFile(join(app, ".mise.toml"))).includes("github:bonisoft3/omnishell"), "terminal did not contribute its tool");
    // The cluster pins its own tree as the terminal does: the bundler an app
    // outside the monorepo runs finds mecha where mise put it, or not at all.
    await Deno.writeTextFile(join(app, "pronto/cluster.cue"), 'package prontoproject\nimport cluster "github.com/bonisoft3/pronto/clusters:mecha"\npronto: cluster.#Project\n');
    await cue(app, ["cmd", "generate", "./pronto"]);
    assert((await Deno.readTextFile(join(app, ".mise.toml"))).includes("github:bonisoft3/mecha"), "cluster did not contribute its tool");
    await Deno.writeTextFile(join(app, "pronto/builder.cue"), 'package prontoproject\nimport builder "github.com/bonisoft3/pronto/builders:bayt"\npronto: builder.#Toolchain\npronto: say: say: generate: rulemap: custom: {priority: 3, cmds: [{do: "print custom"}]}\n');
    const previousRegistry = Deno.env.get("CUE_REGISTRY");
    const previousCache = Deno.env.get("CUE_CACHE_DIR");
    try {
      for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
      for (let pass = 0; pass < 2; pass++) {
        await cue(app, ["cmd", "generate", "./pronto"]);
        const merged = await projectSay(app, { say: { generate: { rulemap: { pronto: { priority: 1 } } } } }) as {say: {generate: {rulemap: Record<string, {priority: number}>}}};
        assert(merged.say.generate.rulemap["auto-bayt"].priority === 2, "writer dropped builder ordering");
        assert((await Deno.readTextFile(join(app, ".say.yaml"))).includes("do: auto-bayt"), "builder ordering dropped bayt's generator");
        assert(merged.say.generate.rulemap.custom.priority === 3, "writer dropped the consumer rule");
      }
      const fixture = join(repo, "apps/jsfb");
      for await (const entry of Deno.readDir(fixture)) {
        if (entry.name.startsWith(".") || ["mise.lock", "mise.local.toml", "bayt.cue", "bayt.json", "program_terminal.cue"].includes(entry.name)) continue;
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
      // A prerendered route, whose document the writer renders through the
      // installed omnishell, as it reads markup through it.
      await Deno.writeTextFile(join(app, "program_document.cue"), 'package jsfb\ncode: surface: screens: about: {title: "About", route: "/about", prerender: true, reads: [], writes: [], forms: [], states: ["populated"], files: {handlers: [], adapters: []}}\n');
      await Deno.writeTextFile(join(app, "shell/screens/about.html"), '<section class="screen" data-screen="about"><h1>About</h1></section>\n');
      await Deno.writeTextFile(join(app, "shell/screens/about.css"), "");
      async function deno(script: string, args: string[], success = true): Promise<string> {
        const result = await new Deno.Command(Deno.execPath(), {
          args: ["run", "--no-check", "--config", join(scratch, "pronto/deno.json"), "--allow-read", "--allow-write=.", "--allow-run", "--allow-env", script, ...args],
          cwd: app, env, stdout: "piped", stderr: "piped",
        }).output();
        const text = decoder.decode(result.stderr);
        assert(result.success === success, text);
        return success ? decoder.decode(result.stdout) : text;
      }
      // The installed source runtimes are this tree's, as the monorepo's
      // mise.local.toml makes them: the writer and derive run them through
      // mise, and derive reads markup through omnishell's command.
      const local = ["omnishell", "pronto", "mecha"].map((name) => `"github:bonisoft3/${name}" = "path:${join(scratch, name).replaceAll("\\", "/")}"\n`);
      await Deno.writeTextFile(join(app, "mise.local.toml"), `[tools]\n${local.join("")}`);
      await $`mise trust -q ${app}`;
      const runMise = async (args: string[]): Promise<void> => {
        const result = await new Deno.Command("mise", { args, cwd: app, stdout: "piped", stderr: "piped" }).output();
        assert(result.success, `${args.join(" ")}: ${decoder.decode(result.stderr)}`);
      };
      // The released binaries it executes install from the lock bootstrap
      // wrote, as a consumer's first install does; local source stands in for
      // the other tools.
      const released = ["github:terrastruct/d2", "github:bonisoft3/bayt", "github:bonisoft3/sayt"];
      await runMise(["install", ...released.map((tool) => `${tool}@${tools[tool]}`)]);
      const terminal = join(scratch, "omnishell/runtime/cli.ts");
      await Deno.writeTextFile(join(app, "program_terminal.cue"), await deno(terminal, ["mode", "."]));
      let written = "";
      for (let pass = 0; pass < 2; pass++) {
        await cue(app, ["cmd", "generate", "./pronto"]);
        // Beside a program the writer alone owns .say.yaml. A bootstrap copy
        // standing until the writer ran is what a failed write left behind, and
        // in the monorepo its rules declared the installed pronto for good.
        if (pass === 1) assert(await Deno.readTextFile(join(app, ".say.yaml")) === written, "generate rewrote the writer's .say.yaml");
        if (pass === 1) {
          // A tightened grammar must judge the authored screen, not yesterday's output.
          await Deno.writeTextFile(join(app, "program_document.cue"), '\ncode: surface: screens: about: markup: "<section class=\\"screen\\" data-screen=\\"about\\"><h1>About</h1></section>"\n', { append: true });
          await Deno.writeTextFile(join(app, "shell/screens/about.html"), `<div data-live="row" data-filter="id=eq.the" data-machine='{"field":"phase","initial":"idle","context":{"old":true},"states":{"idle":{}}}'></div>`);
        }
        await deno(join(scratch, "pronto/write.ts"), ["."]);
        const build = JSON.parse(await Deno.readTextFile(join(app, "bayt.json")));
        assert(build.name === "jsfb", "standalone build has an invalid project name");
        const dockerfile = await cue(app, ["export", ".", "-e", "(_render & {depManifests: {}}).docker.dockerfiles.build", "--out", "text"]);
        assert(dockerfile.startsWith("FROM jsfb-generate AS build\n"), "standalone Dockerfile has an invalid setup context");
        const generated = await Deno.readTextFile(join(app, ".say.yaml"));
        assert(build.files["checks.yaml"].say.generate.rulemap.custom, "real writer lost the consumer rule");
        assert(!generated.includes("../../plugins"), "external writer emitted a monorepo command");
        assert((await Deno.readTextFile(join(app, "documents/about/index.html"))).includes("<h1>About</h1>"), "the installed omnishell rendered no document");
        if (pass === 1) assert(generated === written, "real writer did not settle");
        written = generated;
      }
      // A static the cluster serves but nothing holds fails at generate,
      // not minutes later in a docker build.
      const briefPath = join(app, "brief.html");
      const brief = await Deno.readTextFile(briefPath);
      await Deno.remove(briefPath);
      const missing = await deno(join(scratch, "pronto/write.ts"), ["."], false);
      assert(missing.includes("brief.html: no such file"), "the writer did not refuse the missing static");
      await Deno.writeTextFile(briefPath, brief);
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
