import { strict as assert } from "node:assert";
import { oneHome, parseHeld, type SeedData, seedSql, vetHeld } from "./seed.ts";

const team: SeedData["entities"][number] = {
  name: "Team",
  table: "team",
  columns: [
    { name: "id", type: "uuid" },
    { name: "name", type: "string" },
    { name: "rank", type: "int32" },
    { name: "active", type: "bool" },
    { name: "motto", type: "int64", from: "public.portable_int64_from_json" },
    { name: "rating", type: "double" },
    { name: "crest", type: "json" },
    { name: "ground", type: "geojson" },
  ],
  rows: [],
};

// A domain column reads CUE's json.Marshal spelling, escapes included, through
// its representation function; a base-typed column reads the SQL literal, and
// its CHECK judges it as the domain's function would have.
Deno.test("a row renders each column the way its type is held", () => {
  const sql = seedSql({ src: "seed.json", entities: [team] }, {
    Team: [{
      name: "D'Ávila\u2028", id: "06000000-0000-4000-8000-000000000001", active: true, rank: 3,
      motto: "9007199254740993\u2028", rating: 1.5, crest: { a: [1, "\u2028"] }, ground: { type: "Point", coordinates: [1, 2] },
    }],
  });
  assert.equal(
    sql,
    "INSERT INTO team (id, name, rank, active, motto, rating, crest, ground) VALUES (" +
      `'06000000-0000-4000-8000-000000000001', 'D''Ávila\u2028', 3, true, ` +
      `public.portable_int64_from_json('"9007199254740993\\u2028"'::json), 1.5, ` +
      `'{"a":[1,"\\u2028"]}'::json, '{"type":"Point","coordinates":[1,2]}'::json) ON CONFLICT (id) DO NOTHING;\n`,
  );
});

// Regression: a seeded JSON null was the json value null while PostgREST stores
// one as SQL NULL, so a seeded row and an API write disagreed. A JSON null is
// absence, of a json column as of every other.
Deno.test("a json column's null is SQL NULL", () => {
  const sql = seedSql({ entities: [{ ...team, rows: [{ id: "a", crest: null }] }] }, {});
  assert.equal(sql, `INSERT INTO team (id, crest) VALUES ('a', NULL) ON CONFLICT (id) DO NOTHING;\n`);
});

Deno.test("stated rows render without a seed file, and an entity with none renders nothing", () => {
  const stated = { ...team, rows: [{ id: "a" }] };
  const sql = seedSql({ entities: [{ ...team, name: "Empty", table: "empty" }, stated] }, {});
  assert.equal(sql, `INSERT INTO team (id) VALUES ('a') ON CONFLICT (id) DO NOTHING;\n`);
});

Deno.test("a held row is refused where nothing would judge or render it", () => {
  const data = { src: "seed.json", entities: [team] };
  assert.throws(() => seedSql(data, { Tab: [{ id: "a" }] }), /Tab is not a server entity/);
  assert.throws(() => seedSql(data, { Team: [{ id: "a", colour: "red" }] }), /Team\[0\]: colour is not a field/);
  // JSON.parse rounds it, so what reached the database would not be what the file says.
  assert.throws(() => seedSql(data, { Team: [{ id: "a", rank: 2 ** 53 }] }), /Team\[0\]\.rank/);
  assert.throws(() => seedSql({ src: "seed.json", entities: [{ ...team, rows: [{ id: "a" }] }] }, { Team: [{ id: "b" }] }), /one/);
});

Deno.test("an entity's rows have one home", () => {
  assert.throws(() => oneHome("seed.json", { Team: { seed: [{ id: "a" }] } }, { Team: [{ id: "b" }] }), /in the program and in seed\.json/);
  oneHome("seed.json", { Team: { seed: [] } }, { Team: [{ id: "b" }] });
});

Deno.test("a seed file is entity names to lists of rows", () => {
  assert.throws(() => parseHeld("seed.json", "[]"), /not an object/);
  assert.throws(() => parseHeld("seed.json", '{"Team": {}}'), /Team is not a list of rows/);
  assert.throws(() => parseHeld("seed.json", '{"Team": [1]}'), /Team is not a list of rows/);
  assert.throws(() => parseHeld("seed.json", "{"), /seed\.json/);
});

Deno.test("held rows are judged by cue against #Seed, then by the beyond checks", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/p.cue`, "package p\ncode: #Seed: {Team?: [...{rank?: int & <10, day?: string}]}\n");
    const entities = { Team: { fields: [{ name: "rank", type: "int32" as const }, { name: "day", type: "date" as const }] } };
    const vet = async (held: object) => {
      await Deno.writeTextFile(`${dir}/seed.json`, JSON.stringify(held));
      await vetHeld(dir, "seed.json", held as never, entities);
    };
    await vet({ Team: [{ rank: 3, day: "2026-02-28" }] });
    await assert.rejects(vet({ Team: [{ rank: 12 }] }), /a row does not satisfy its entity/);
    await assert.rejects(vet({ Team: [{ day: "2026-02-30" }] }), /Team\.seed\[0\]\.day: .*calendar date/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
