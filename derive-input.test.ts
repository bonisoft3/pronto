import { dirname, join } from "node:path";
import { readDerivation } from "./derive.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const source = `package sample
_deriving: *false | bool @tag(derive,type=bool)
#Screen: {reads!: [..._], writes!: [..._], charts!: [..._], paths: {save: accepts: ["saved"]}, files: {handlers!: [...string], shared: ["theme.css"]}}
code: {
  state: entities: Item: {table: "item", durability: "persistent", fields: []}
  surface: {screens: home: #Screen, design: colors: ink: "#123456"}
  meta: {ir: source: "ir.html", decisions: save: ir: "save", tests: saved: ir: "saved", design: pendingLiterals: 0}
  #read: Item: {table: "item", mode: "lazy", reason: "screen"}
  capabilities: {vendored: {}, hatches: {}}
  extra: {preserved: true}
}
if !_deriving {code: meta: tests: uncited: ir: string}
out: {
  scale: [1, 2]
  files: {"shell/design.css": text: "authored design override", "shell/shell.css": text: "authored shell override"}
  terminal: surface: {entry: "home", markupReader: "reader.js", machineSchema: "machine.cue", sw: "sw.js", boot: "boot.js", assets: boot: "", interpreterRoot: "interpreter"}
  cluster: meta: statics: [{file: "asset.svg", target: "/authored-asset.svg"}]
}
deployment: string
`;

async function fixture(subdir: string, module: string, test: (app: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "derive input " });
  try {
    await Deno.mkdir(join(root, "cue.mod"));
    await Deno.writeTextFile(join(root, "cue.mod/module.cue"), `module: ${JSON.stringify(module)}\nlanguage: version: "v0.16.1"\n`);
    const app = join(root, subdir);
    await Deno.mkdir(app, { recursive: true });
    await Deno.writeTextFile(join(app, "program.cue"), source);
    await test(app);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function assertClean(app: string): Promise<void> {
  const files = await Array.fromAsync(Deno.readDir(app));
  const names = files.map((f) => f.name).filter((name) => name !== "cue.mod");
  assert(names.length === 1 && names[0] === "program.cue", `observer inputs leaked: ${names}`);
}

for (const [name, subdir, module] of [
  ["root module", "", "example.com/standalone@v1"],
  ["nested module package", "apps/card", "example.com/monorepo@v0"],
]) {
  Deno.test(`derive input preserves the canonical projection in a ${name}`, async () => {
    await fixture(subdir, module, async (app) => {
      const deployment = await new Deno.Command("cue", {
        args: ["export", ".", "-e", "deployment", "--out", "json"], cwd: app, stdout: "piped", stderr: "piped",
      }).output();
      assert(!deployment.success, "unrelated deployment root unexpectedly became concrete");
      const input = await readDerivation(app, "sample", true) as Record<string, unknown>;
      assert(Object.keys(input).length === 18, "canonical input fields changed");
      assert(input.designCss === "authored design override" && input.shellCss === "authored shell override", "emitted stylesheet overrides lost");
      assert(JSON.stringify(input.statics) === '[{"file":"asset.svg","target":"/authored-asset.svg"}]', "emitted static overrides lost");
      const program = input.program as {
        surface: { screens: { home: { reads: unknown[]; writes: unknown[]; charts: unknown[]; files: { handlers: unknown[] } } } };
        extra: { preserved: boolean };
      };
      assert(program.extra.preserved, "whole program was narrowed");
      // A first generate has no program_derived.cue, and every field it would hold is required of an assembly screen.
      const home = program.surface.screens.home;
      assert([home.reads, home.writes, home.charts, home.files.handlers].every((l) => l.length === 0), "missing derived projection was not bootstrapped");
      assert(JSON.stringify(input.read) === '{"Item":{"table":"item","mode":"lazy","reason":"screen"}}', "hidden read projection lost");
      await assertClean(app);
    });
  });
}

Deno.test("derive input refuses invalid selected values and cleans its temporary inputs", async () => {
  await fixture("app", "example.com/refusal", async (app) => {
    let error: unknown;
    try {
      await readDerivation(app, "sample", false);
    } catch (e) {
      error = e;
    }
    assert(error instanceof Error && error.message.includes("uncited"), `canonical export failure lost: ${error}`);
    await assertClean(app);
    await Deno.writeTextFile(join(app, "program.cue"), source.replace('"authored shell override"', "string"));
    error = undefined;
    try {
      await readDerivation(app, "sample", true);
    } catch (e) {
      error = e;
    }
    assert(error instanceof Error && error.message.includes("shell"), `selected emission failure lost: ${error}`);
    await assertClean(app);
  });
});

Deno.test("derive input keeps writes within the authorized caller path", async () => {
  await fixture("app", "example.com/scoped@v0", async (app) => {
    const alias = join(dirname(app), "consumer-alias");
    await Deno.symlink(app, alias, { type: "junction" });
    const script = join(dirname(app), "scoped.ts");
    await Deno.writeTextFile(script, `
import { join } from "node:path";
import { readDerivation } from ${JSON.stringify(new URL("./derive.ts", import.meta.url).href)};
let refused = false;
try {
  await Deno.writeTextFile(join(await Deno.realPath(Deno.args[0]), "unauthorized"), "");
} catch (error) {
  if (!(error instanceof Deno.errors.NotCapable)) throw error;
  refused = true;
}
if (!refused) throw new Error("physical path unexpectedly authorized");
await readDerivation(Deno.args[0], "sample", true);
`);
    const child = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-read", `--allow-write=${alias}`, "--allow-run=cue", script, alias],
      stdout: "piped", stderr: "piped",
    }).output();
    assert(child.success, new TextDecoder().decode(child.stderr));
    await assertClean(app);
  });
});
