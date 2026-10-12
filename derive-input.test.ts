import { join } from "node:path";
import { readDerivation } from "./derive.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const source = `package sample
_deriving: *false | bool @tag(derive,type=bool)
#Screen: {charts!: [..._], paths: {save: accepts: ["saved"]}, files: shared: ["theme.css"]}
code: {
  state: entities: Item: {table: "item", durability: "persistent", fields: []}
  surface: {screens: home: #Screen, design: colors: ink: "#123456"}
  meta: {ir: source: "ir.html", decisions: save: ir: "save", tests: saved: ir: "saved", design: pendingLiterals: 0}
  #read: Item: {table: "item", mode: "lazy", reason: "screen"}
  extra: {preserved: true}
}
if !_deriving {code: meta: tests: uncited: ir: string}
out: {
  scale: [1, 2]
  files: {"shell/design.css": text: "authored design override", "shell/shell.css": text: "authored shell override"}
  terminal: surface: {entry: "home", runtime: "runtime", markupReader: "reader.js", machineSchema: "machine.cue"}
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
      const input = await readDerivation(app, "sample", true) as Record<string, unknown>;
      assert(Object.keys(input).length === 18, "canonical input fields changed");
      assert(input.designCss === "authored design override" && input.shellCss === "authored shell override", "emitted stylesheet overrides lost");
      assert(JSON.stringify(input.statics) === '[{"file":"asset.svg","target":"/authored-asset.svg"}]', "emitted static overrides lost");
      const program = input.program as { surface: { screens: { home: { charts: unknown[] } } }; extra: { preserved: boolean } };
      assert(program.extra.preserved, "whole program was narrowed");
      assert(program.surface.screens.home.charts.length === 0, "missing chart projection was not bootstrapped");
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
