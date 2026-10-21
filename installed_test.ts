// Installed runtimes contain this tree alone. Checkout-only test harnesses
// are classified by the distribution alongside the consumer type gate.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const classification = new Deno.Command("cue", {
  args: ["export", "./distribution", "-e", "#TestModules", "--out", "json"],
  cwd: ROOT,
  stdout: "piped",
  stderr: "piped",
}).outputSync();
assert.ok(classification.success, `cue export of test modules failed: ${new TextDecoder().decode(classification.stderr).trim()}`);
const testModules = new Set<string>(JSON.parse(new TextDecoder().decode(classification.stdout)));

const shipped = ["", "scales"].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith("_test.ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name))
    .filter((file) => !testModules.has(file))
);

Deno.test("no installed module imports outside pronto", () => {
  const escapes = shipped.flatMap((file) =>
    [...readFileSync(join(ROOT, file), "utf8").matchAll(/^\s*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/gm)]
      .map(([, from, call]) => from ?? call)
      .filter((spec) => spec.startsWith("../") && join(dirname(file), spec).startsWith(".."))
      .map((spec) => `${file}: ${spec}`)
  );
  assert.deepEqual(escapes, []);
});
