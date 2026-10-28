// jessie.ts's ENDOWABLE against what each cage actually grants and what each
// schema admits: a name one list gained and another did not would pass lint
// and fail in the cage, or be refused by the schema and allowed by the scan.

import { assertEquals } from "jsr:@std/assert@1.0.11";
import { ENDOWABLE, jessieFacts } from "./jessie.ts";
import { SAFE_ENDOWMENTS } from "../omnishell/interpreter/jessie.js";
import { ENDOWABLE as MECHA } from "../../libraries/mecha/services/compute/language.ts";

const sorted = (xs: Iterable<string>) => [...xs].sort();
const candidates = sorted(new Set([...Object.values(ENDOWABLE).flat(), ...Object.keys(SAFE_ENDOWMENTS), ...MECHA]));

async function admitted(expr: string): Promise<string[]> {
  const { code, stdout, stderr } = await new Deno.Command("cue", {
    args: ["export", ".", "--out", "json", "-e", `[for n in ${JSON.stringify(candidates)} if ${expr} {n}]`],
    cwd: new URL(".", import.meta.url),
  }).output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return sorted(JSON.parse(new TextDecoder().decode(stdout)));
}

Deno.test("a terminal module may be granted what the terminal's cage endows and the schema admits", async () => {
  const terminal = sorted(Object.keys(SAFE_ENDOWMENTS));
  for (const role of ["handler", "adapter", "renderer", "validation", "fold"]) assertEquals(sorted(ENDOWABLE[role]), terminal, role);
  assertEquals(await admitted("(n & #SafeEndowment) != _|_"), terminal);
});

// An engine steps on its state and its commands alone: its cage
// (evaluateEngine) and the scan both grant nothing.
Deno.test("an engine may be granted nothing", () => {
  assertEquals(ENDOWABLE.engine, []);
});

Deno.test("a mecha module may be granted what mecha's cages endow and the schema admits", async () => {
  const mecha = sorted(MECHA);
  for (const role of ["computation", "effect"]) assertEquals(sorted(ENDOWABLE[role]), mecha, role);
  assertEquals(await admitted("([n] & #Computation.endowments) != _|_"), mecha);
  const effect = `{name: "x", sink: {origin: "https://api.example.com", idempotent: true}, note: "x", endowments: [n]}`;
  assertEquals(await admitted(`(#ExternalEffect & ${effect}) != _|_`), mecha);
});

Deno.test("Cheerio requires opt-in in each Mecha seat and is unavailable in terminal seats", () => {
  const source = '(input) => Cheerio.load(input.html)("a").text()';
  for (const role of ["computation", "effect"]) {
    assertEquals(jessieFacts(source, role).references, ["Cheerio"], role);
    assertEquals(jessieFacts(source, role, ["Cheerio"]).references, [], role);
  }
  for (const role of ["handler", "adapter", "renderer", "validation", "fold", "engine"]) {
    assertEquals(jessieFacts(source, role, ["Cheerio"]).references, ["Cheerio"], role);
  }
});
