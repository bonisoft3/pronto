import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

const source = fileURLToPath(new URL(".", import.meta.url));
const decoder = new TextDecoder();

Deno.test("generated type check expands portable globs without changing the consumer cwd", async () => {
  const scratch = await Deno.makeTempDir({ prefix: "pronto-types-" });
  try {
    const app = join(scratch, "consumer with spaces");
    const runtime = join(scratch, "distribution with spaces");
    await Deno.mkdir(app);
    await Deno.mkdir(join(runtime, "scales"), { recursive: true });
    await Deno.mkdir(join(runtime, "directory.ts"));
    await Deno.mkdir(join(runtime, "scales", "directory.ts"));
    const expected = ["entry point.ts", "other.ts", join("scales", "check.ts")]
      .map((path) => join(runtime, path)).sort();
    for (const path of [...expected, join(runtime, "ignored.txt")]) await Deno.writeTextFile(path, "");
    await Deno.writeTextFile(join(app, "runtime.txt"), runtime);
    // Capture the Mise boundary while executing the emitted Nushell unchanged.
    await Deno.writeTextFile(join(app, "tools.nu"), `export def --wrapped run-mise [...args: string] {
      if $args.0 == where { open runtime.txt --raw } else {
        {cwd: $env.PWD, args: $args} | to json --raw
      }
    }`);
    for (const root of ["../distribution with spaces", runtime, ""]) {
      const exported = await new Deno.Command("cue", {
        args: ["export", "./distribution", "-e", `(#Project & {runtime: ${JSON.stringify(root)}}).checks.types`, "--out", "text"],
        cwd: source, stdout: "piped", stderr: "piped",
      }).output();
      if (!exported.success) throw new Error(decoder.decode(exported.stderr));
      const result = await new Deno.Command("nu", {
        args: ["--no-config-file", "-c", decoder.decode(exported.stdout)],
        cwd: app, stdout: "piped", stderr: "piped",
      }).output();
      if (!result.success) throw new Error(decoder.decode(result.stderr));
      const { cwd, args } = JSON.parse(decoder.decode(result.stdout)) as { cwd: string; args: string[] };
      if (await Deno.realPath(cwd) !== await Deno.realPath(app)) throw new Error("Mise left the consumer cwd");
      if (JSON.stringify(args.slice(0, 5)) !== JSON.stringify(["exec", "--", "deno", "check", "--config"])) {
        throw new Error(`unexpected Mise arguments: ${JSON.stringify(args)}`);
      }
      if (resolve(app, args[5]) !== join(runtime, "deno.json")) throw new Error("wrong Deno config path");
      const files = args.slice(6);
      if (!files.every(isAbsolute)) throw new Error("glob returned relative paths");
      const actual = (await Promise.all(files.map((path) => Deno.realPath(path)))).sort();
      const canonical = (await Promise.all(expected.map((path) => Deno.realPath(path)))).sort();
      if (JSON.stringify(actual) !== JSON.stringify(canonical)) throw new Error(`wrong files: ${JSON.stringify(files)}`);
    }
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});
