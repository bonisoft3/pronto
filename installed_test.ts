// An installed pronto is this directory alone, under mise's installs, with no
// omnishell or mecha beside it: v0.13.0 shipped mecha-reducer.ts importing
// ../omnishell/instrument.ts, and write.ts died loading it in every consumer.
// A module the installed type gate checks (distribution/config.cue: top-level
// and scales/ .ts, tests excluded) reaches a sibling only through the paths the
// app's terminal names, never by import.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

const shipped = ["", "scales"].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith("_test.ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name))
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
