import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.11";
import { renderFunctions } from "./edge-functions.ts";
import { compileFunction } from "../database-functions.ts";
import { browserTier } from "../../../libraries/mecha/packages/mecha-browser/fence.ts";
import { terminal } from "../mecha-fixtures.ts";
import { declared, functionApp, ROUND, round, reshaped } from "../testdata/function-fixtures.ts";

const omnishell = new URL("../../omnishell", import.meta.url).pathname;

Deno.test("the edge's migration declares the wrapper and carries no plv8", () => {
  const edge = browserTier(compileFunction({ name: "round", fuel: 10000 }, ROUND, terminal));
  assert(!/LANGUAGE plv8|EXTENSION IF NOT EXISTS plv8/.test(edge), "the edge's migration carries no plv8");
  assertStringIncludes(edge, "public.fn_round");
});

Deno.test("the edge runs the same module, metered, and refuses what is not JSON", async () => {
  const app = await functionApp();
  const out = await Deno.makeTempDir();
  await Deno.writeTextFile(`${out}/functions.js`, await renderFunctions("proof", app, omnishell, declared));
  const { default: functions } = await import(`file://${out}/functions.js`);
  assertEquals(functions.round.execute(round), reshaped);
  assertThrows(() => functions.spin.execute({}), RangeError, "function spin: fuel exhausted");
  assertThrows(() => functions.fail.execute({ kind: "round" }), Error, "unparsable round");
  assertThrows(() => functions.loose.execute({ n: 1 }), TypeError, "answer.value is not a finite number");
  // The argument is the function's to read, never to change.
  await Deno.writeTextFile(`${app}/rules/mutate.js`, "(input) => { input.events.push(1); return input; }");
  await Deno.writeTextFile(`${out}/mutate.js`, await renderFunctions("proof", app, omnishell, { mutate: { fuel: 100, rules: "rules/mutate.js" } }));
  const { default: mutating } = await import(`file://${out}/mutate.js`);
  assertThrows(() => mutating.mutate.execute({ events: [] }), TypeError);
  await assertRejects(() => renderFunctions("proof", app, omnishell, { round: { fuel: 1, rules: "../round.js" } }), Error, "unsafe rules path");
});
