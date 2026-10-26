import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1.0.11";
import { compileMechaReducer } from "./mecha-reducer.ts";
import { ROOT, fixture, run, terminal } from "./testdata/hybrid-fixtures.ts";

Deno.test("SQL entropy omits UUID version and variant nibbles and fills byte boundaries", async () => {
  const { spec, rules } = await fixture();
  const sizes = [1, 15, 16, 31, 1024];
  const functions: string[] = [];
  for (const entropy of sizes) {
    const name = `entropy_${entropy}`;
    const compiled = await compileMechaReducer(
      { ...spec, name, entropy },
      rules, terminal,
    );
    const draw = compiled.sql.match(
      /CREATE OR REPLACE FUNCTION hybrid_\w+\.draw\(\)[\s\S]*?\$draw\$;/,
    )?.[0];
    assert(draw);
    functions.push(`CREATE SCHEMA hybrid_${name}; ${draw}`);
  }
  const result = await run(
    "deno",
    [
      "run",
      "-A",
      "--no-lock",
      "--config",
      fileURLToPath(new URL("libraries/mecha/packages/mecha-edge/deno.json", ROOT)),
      "-",
    ],
    `
    import { PGlite } from "@electric-sql/pglite";
    const db = await PGlite.create();
    try {
      await db.exec("CREATE SCHEMA entropy_source; CREATE FUNCTION entropy_source.gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT '01234567-89ab-4cde-8f01-23456789abcd'::uuid $$; SET search_path = entropy_source, pg_catalog;");
      await db.exec(${JSON.stringify(functions.join("\n"))});
      const results = [];
      for (const size of ${JSON.stringify(sizes)}) {
        const {rows} = await db.query('SELECT hybrid_entropy_' + size + '.draw() AS entropy');
        results.push(rows[0].entropy);
      }
      console.log(JSON.stringify(results));
    } finally {
      await db.close();
    }
  `,
  );
  assert(result.ok, result.err);
  const randomHex = "0123456789abcdef0123456789abcd";
  assertEquals(
    JSON.parse(result.out),
    sizes.map((bytes) =>
      randomHex.repeat(Math.ceil(bytes * 2 / 30)).slice(0, bytes * 2)
    ),
  );
});
