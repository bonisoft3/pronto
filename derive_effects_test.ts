// The fact rows derive writes for an effect's handler, which lint's denylist
// joins: a denied name reached, and a grant the effect declared excepted.

import { assertEquals } from "jsr:@std/assert@1.0.11";
import { effectModules } from "./derive.ts";

async function app(handlers: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/effects`);
  for (const [name, source] of Object.entries(handlers)) await Deno.writeTextFile(`${dir}/effects/${name}.js`, source);
  return dir;
}

Deno.test("a handler's reach is a fact row in the effect role, its declared endowments excepted", async () => {
  const dir = await app({
    charge: `export const issue = async (input, sink) => ({ done: await Crypto.digest("SHA-256", new TextEncoder().encode(input.id)) });`,
    leak: `export const issue = async (input) => fetch(input.url);`,
  });
  try {
    assertEquals(await effectModules(dir, { charge: { endowments: ["Crypto", "TextEncoder"] }, leak: {} }), [
      { path: "effects/charge.js", references: [], completion: "exports", role: "effect" },
      { path: "effects/leak.js", references: ["fetch"], completion: "exports", role: "effect" },
    ]);
    assertEquals((await effectModules(dir, { charge: {} }))[0].references, ["Crypto", "TextEncoder"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
