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

const shipped = ["", "scales", "bundle"].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith("_test.ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name))
    .filter((file) => !testModules.has(file))
);

// A module reaches outside by an import specifier or by a file it reads
// beside itself (`new URL("../…", import.meta.url)`): mecha-reducer.ts read
// omnishell's SES that way and an installed pronto died on it (NotFound) on
// the first clean runner that ran it.
Deno.test("no installed module imports or reads outside pronto", () => {
  const escapes = shipped.flatMap((file) =>
    [...readFileSync(join(ROOT, file), "utf8").matchAll(/^\s*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']|\bnew URL\(\s*["']([^"']+)["']/gm)]
      .map(([, from, call, url]) => from ?? call ?? url)
      .filter((spec) => spec.startsWith("../") && join(dirname(file), spec).startsWith(".."))
      .map((spec) => `${file}: ${spec}`)
  );
  assert.deepEqual(escapes, []);
});
