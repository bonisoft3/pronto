import { strict as assert } from "node:assert";
import { generateProto } from "./type-proto.ts";
import { checkTypeSeeds } from "./type-check.ts";

Deno.test("protobuf uses scalar types, stable JSON names and explicit presence", () => {
  const proto = generateProto({ Row: { name: "Row", id: "0xc75ee275aaa2d971", fields: [
    { name: "amount", type: "decimal", precision: 18, scale: 6, ordinal: 1 },
    { name: "full_count", type: "int64", ordinal: 2 },
    { name: "created_at", type: "timestamp", ordinal: 3 },
    { name: "shape", type: "geojson", ordinal: 4 },
    { name: "old", type: "string", ordinal: 5, retired: true },
  ] } });
  assert.match(proto, /optional string amount = 1 \[json_name = "amount"\]/);
  assert.match(proto, /optional int64 full_count = 2 \[json_name = "full_count"\]/);
  assert.match(proto, /google.protobuf.Timestamp created_at = 3/);
  assert.match(proto, /google.protobuf.Value shape = 4/);
  assert.match(proto, /reserved 5;\n\x20\x20reserved "old";/);
  assert.doesNotMatch(proto, /google.type/);
});

Deno.test("protobuf refuses ambiguous or reserved identities", () => {
  for (const ordinal of [undefined, 0, 19000, 19999, 536870912]) {
    assert.throws(() => generateProto({ Row: { name: "Row", id: "0xc75ee275aaa2d971", fields: [{ name: "x", type: "string", ordinal }] } }));
  }
  assert.throws(() => generateProto({ Row: { name: "Row", id: "0xc75ee275aaa2d971", fields: [
    { name: "x", type: "string", ordinal: 1 }, { name: "y", type: "string", ordinal: 1 },
  ] } }));
});

Deno.test("protobuf omits legacy entities until identity mints their ordinals", () => {
  const proto = generateProto({ Legacy: { name: "Legacy", fields: [{ name: "label", type: "text" }] } });
  assert.doesNotMatch(proto, /message Legacy/);
  assert.throws(() => generateProto({ Minted: { name: "Minted", id: "0xc75ee275aaa2d971", fields: [{ name: "label", type: "text" }] } }), /ordinal/);
});

Deno.test("seed types reject impossible dates and noncanonical exact values", () => {
  const date = { name: "day", type: "date" as const };
  assert.throws(() => checkTypeSeeds({ Day: { fields: [date], seed: [{ day: "2026-02-30" }] } }));
  const decimal = { name: "rate", type: "decimal" as const, precision: 18, scale: 6 };
  assert.throws(() => checkTypeSeeds({ Rate: { fields: [decimal], seed: [{ rate: "37.10" }] } }));
  assert.throws(() => checkTypeSeeds({ Rate: { fields: [decimal], seed: [{ rate: "0.0000001" }] } }));
  checkTypeSeeds({ Rate: { fields: [decimal], seed: [{ rate: "37.125" }] } });
});
