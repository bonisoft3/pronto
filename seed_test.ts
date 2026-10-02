import { strict as assert } from "node:assert";
import { oneHome, parseHeld, type SeedData, seedSql, vetHeld } from "./seed.ts";

const team: SeedData["entities"][number] = {
  name: "Team",
  table: "team",
  columns: [
    { name: "id", from: "public.portable_uuid_from_json" },
    { name: "name", from: "public.portable_string_from_json" },
    { name: "rank" },
    { name: "active" },
  ],
  rows: [],
};

// CUE's json.Marshal spellings, escapes included, which every 900_seed.sql
// already holds: a different spelling would move every seeded app's migration.
Deno.test("a row renders as the CUE renderer spelled it", () => {
  const sql = seedSql({ src: "seed.json", entities: [team] }, {
    Team: [{ name: "D'Ávila ", id: "06000000-0000-4000-8000-000000000001", active: true, rank: 3 }],
  });
  assert.equal(
    sql,
    "INSERT INTO team (id, name, rank, active) VALUES (" +
      `public.portable_uuid_from_json('"06000000-0000-4000-8000-000000000001"'::json), ` +
      `public.portable_string_from_json('"D''Ávila\\u2028"'::json), 3, true) ON CONFLICT (id) DO NOTHING;\n`,
  );
});

Deno.test("stated rows render without a seed file, and an entity with none renders nothing", () => {
  const stated = { ...team, rows: [{ id: "a" }] };
  const sql = seedSql({ entities: [{ ...team, name: "Empty", table: "empty" }, stated] }, {});
  assert.equal(sql, `INSERT INTO team (id) VALUES (public.portable_uuid_from_json('"a"'::json)) ON CONFLICT (id) DO NOTHING;\n`);
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
