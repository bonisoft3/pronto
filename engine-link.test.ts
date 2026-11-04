// An engine's graph, linked here and imported by the terminal's own cage: what
// links runs as the same modules would as one file, and every way out of the
// graph is refused at the link, naming the module that tried.

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.11";
import { join } from "node:path";
import { LinkError, linkEngine, resolveSpecifier } from "./engine-link.ts";

// The vendored SES, installed the way a host that pre-installs Compartment
// does, so evaluateEngine skips the browser's script injection.
(0, eval)(await Deno.readTextFile(new URL("../omnishell/interpreter/vendor/ses.umd.min.js", import.meta.url)));
const { evaluateEngine, evaluateCaged } = await import("../omnishell/interpreter/jessie.js");

async function app(files: Record<string, string>, test: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "engine-link " });
  try {
    for (const [path, text] of Object.entries(files)) {
      await Deno.mkdir(join(dir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, path), text);
    }
    await test(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const prng = `export const mix = (s) => (s * 1103515245 + 12345) % 2147483648;\n`;
const table = `export const GRIP = 3;\nexport const STAGES = Object.freeze([1, 2, 3]);\n`;
const step = `import { mix } from "../shared/prng.js";\nimport { GRIP } from "./table.js";\nexport const step = (s, c) => ({ seed: mix(s.seed), x: s.x + (c.up ? GRIP : 0) });\n`;
const engine = `import { step } from "./step.js";
import * as table from "./table.js";
export const initState = (seed) => ({ seed, x: table.STAGES[0] });
export const advanceFrame = step;
export const saveState = (s) => JSON.stringify(s);
export const loadState = (t) => JSON.parse(t);
`;
const graph = { "sim/engine.js": engine, "sim/step.js": step, "sim/table.js": table, "shared/prng.js": prng };

Deno.test("a graph of relative imports links, and steps as the same code in one file does", async () => {
  await app(graph, async (dir) => {
    const linked = await linkEngine(dir, "sim/engine.js");
    assertEquals(linked.entry, "./sim/engine.js");
    assertEquals(Object.keys(linked.modules).sort(), ["./shared/prng.js", "./sim/engine.js", "./sim/step.js", "./sim/table.js"]);
    const eng = await evaluateEngine(linked);
    const one = await evaluateCaged(`${prng}${table}${step}${engine}`.replace(/^import .*$/gm, "").replace(/^export /gm, "") +
      "\nconst table = { STAGES };\n({ initState, advanceFrame, saveState, loadState });");
    let a = eng.initState(7);
    let b = one.initState(7);
    for (let i = 0; i < 50; i++) {
      a = eng.advanceFrame(a, { up: i % 3 === 0 });
      b = one.advanceFrame(b, { up: i % 3 === 0 });
    }
    assertEquals(eng.saveState(a), one.saveState(b));
    assertEquals(eng.loadState(eng.saveState(a)), a);
  });
});

Deno.test("a cycle links: it is what ES modules make of it", async () => {
  await app({
    "a.js": `import { b } from "./b.js";\nexport const a = () => 1;\nexport const initState = () => b();\nexport const advanceFrame = (s) => s;\nexport const saveState = (s) => s;\nexport const loadState = (s) => s;\n`,
    "b.js": `import { a } from "./a.js";\nexport const b = () => a() + 1;\n`,
  }, async (dir) => {
    const eng = await evaluateEngine(await linkEngine(dir, "a.js"));
    assertEquals(eng.initState(), 2);
  });
});

Deno.test("an entry that does not export the engine contract is refused where it loads", async () => {
  await app({ "e.js": `export const initState = () => 0;\n` }, async (dir) => {
    await assertRejects(async () => evaluateEngine(await linkEngine(dir, "e.js")), Error, "must export advanceFrame, saveState, loadState");
  });
});

const refusals: [string, Record<string, string>, string][] = [
  ["a dynamic import", { "e.js": `export const initState = () => import("./x.js");\n` }, "e.js reaches import"],
  ["import.meta", { "e.js": `export const initState = () => import.meta.url;\n` }, "e.js reaches import"],
  ["a package specifier", { "e.js": `import { x } from "lodash";\nexport const initState = () => x;\n` }, `imports "lodash"`],
  ["a URL specifier", { "e.js": `import { x } from "https://example.com/x.js";\nexport const initState = () => x;\n` }, `imports "https://example.com/x.js"`],
  ["a path out of the app", { "sim/e.js": `import { x } from "../../x.js";\nexport const initState = () => x;\n` }, "which leaves the app"],
  ["a file that is no Jessie module", { "e.js": `import { x } from "./data.json";\nexport const initState = () => x;\n` }, "which is no Jessie module path"],
  ["a module that is not there", { "e.js": `import { x } from "./gone.js";\nexport const initState = () => x;\n` }, "gone.js is not a file of the app"],
  ["an imported module reaching a denied name", { "e.js": `import { x } from "./x.js";\nexport const initState = () => x();\n`, "x.js": `export const x = () => Math.random();\n` }, "x.js reaches Math.random"],
  ["an imported module reaching an endowment", { "e.js": `import { x } from "./x.js";\nexport const initState = () => x();\n`, "x.js": `export const x = () => new Intl.NumberFormat("en");\n` }, "x.js reaches Intl"],
];
for (const [name, files, message] of refusals) {
  Deno.test(`the link refuses ${name}`, async () => {
    await app(files, async (dir) => {
      await assertRejects(() => linkEngine(dir, Object.keys(files)[0]), LinkError, message);
    });
  });
}

// The scan is the link's; the cage holds without it. A graph that never went
// through the link — written by hand, or edited after — reaches Intl by name
// and is told why it cannot.
Deno.test("an engine reaching an endowment at runtime is told it is endowed with nothing", async () => {
  const { ModuleSource } = await import("npm:@endo/module-source@1.4.0");
  const text = `export const initState = () => Intl;\nexport const advanceFrame = (s) => s;\nexport const saveState = (s) => s;\nexport const loadState = (s) => s;\n`;
  const eng = await evaluateEngine({ entry: "./e.js", modules: { "./e.js": JSON.parse(JSON.stringify(new ModuleSource(text, "e.js"))) } });
  let thrown = "";
  try {
    eng.initState();
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown, "engine: Intl is not endowed; an engine is endowed with nothing");
});

Deno.test("module keys use URL separators and refuse native backslash traversal", () => {
  assertEquals(resolveSpecifier("sim/engine.js", "../shared/prng.js"), "shared/prng.js");
  assertThrows(() => resolveSpecifier("sim/engine.js", "./..\\..\\outside.js"), LinkError, "no Jessie module path");
});
