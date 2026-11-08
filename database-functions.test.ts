import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.11";
import { compileFunction } from "./database-functions.ts";
import { terminal } from "./mecha-fixtures.ts";
import { ROUND } from "./testdata/function-fixtures.ts";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

Deno.test("a function compiles to a plv8 engine behind a wrapper every tier declares", () => {
  const sql = compileFunction({ name: "round", fuel: 10000 }, ROUND, terminal);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION pronto_functions.round(input jsonb) RETURNS jsonb LANGUAGE plv8");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.fn_round(input jsonb)");
});

Deno.test("a function's declaration and module are refused before they compile", () => {
  const compile = (spec: { name: string; fuel: number; endowments?: string[] }, source = ROUND) => () => compileFunction(spec, source, terminal);
  assertThrows(compile({ name: "Round", fuel: 1 }), Error, "invalid function name");
  assertThrows(compile({ name: "round", fuel: 0 }), Error, "invalid fuel");
  assertThrows(compile({ name: "round", fuel: 1000001 }), Error, "invalid fuel");
  assertThrows(compile({ name: "round", fuel: 1, endowments: ["Cheerio"] }), Error, "endowments are not supported");
  assertThrows(compile({ name: "round", fuel: 1 }, "(x) => Date.now()"), Error, "reaches");
  assertThrows(compile({ name: "round", fuel: 1 }, "({ x: 1 })"), Error, "must end in an arrow");
});

Deno.test("a program's functions are one migration the writer compiles, and the schema refuses a bad declaration", async () => {
  const program = (decl: string) => paymentProgram().replace("    effects: charge: {", `    functions: ${decl}\n    effects: charge: {`);
  const files = await emitFiles(program(`round: {rules: "rules/round.js", fuel: 10000, note: "a provider's round"}`)) as unknown as Record<string, { format?: string; data?: unknown }>;
  assertEquals(files["services/database/migrations/009_functions.sql"], {
    format: "function-sql",
    data: { functions: { round: { rules: "rules/round.js", fuel: 10000, note: "a provider's round" } } },
  });
  await assertRejects(() => emitFiles(program(`Round: {rules: "rules/round.js", fuel: 10000, note: "n"}`)));
  await assertRejects(() => emitFiles(program(`round: {rules: "rules/round.js", fuel: 0, note: "n"}`)));
  await assertRejects(() => emitFiles(program(`round: {rules: "../round.js", fuel: 1, note: "n"}`)));
});
