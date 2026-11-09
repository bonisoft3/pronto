import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.11";
import { cue } from "./effects-fixtures.ts";
import { bindBoundary } from "../../libraries/mecha/services/compute/portable-contract.ts";

function program(columns?: string[]) {
  return `package test
import "bonisoft.org/plugins/pronto"
app: pronto.#App & {
  meta: {name: "projected", targets: []}
  state: {
    entities: {
      Source: {table: "source", durability: "offline", fields: [{name: "id", type: "uuid", pk: true}]}
      Result: {table: "result", durability: "offline", fields: [
        {name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
        {name: "count", type: "bigint"},
        {name: "amount", type: "decimal", precision: 18, scale: 6, required: false},
        {name: "rating", type: "double", required: false},
        {name: "stamp", type: "string", default: "'kept'"},
        {name: "search_key", type: "string", generated: "lower(stamp)"},
        {name: "retired", type: "string", retired: true},
      ]}
    }
    duckstreams: recount: {
      backend: "compute", src: "recount.js"
      sources: rows: {entities: ["Source"], read: "snapshot"}
      sinks: totals: {entity: "Result", write: "replace", version: "latest", transaction: "recount"
        ${columns === undefined ? "" : `columns: ${JSON.stringify(columns)}`}
      }
    }
  }
}
out: (pronto.#DefaultCluster & {code: app, statics: []}).out.state.computations
`;
}

Deno.test("compute sink columns derive exact portable types and preserve omitted-column defaults", async () => {
  const projected = await cue(
    ["export", "-", "-e", "out"],
    program(["amount", "count", "id"]),
  );
  assertEquals(projected.success, true, projected.stderr);
  const [computation] = JSON.parse(projected.stdout);
  assertEquals(computation.sinkTypes.result, [
    { name: "id", type: "uuid", required: true },
    { name: "count", type: "int64", required: true },
    {
      name: "amount",
      type: "decimal",
      required: false,
      precision: 18,
      scale: 6,
    },
  ]);
  assertEquals(computation.sinkWrites, { result: "replace" });
  assertEquals("sinkColumns" in computation, false);
  const boundary = bindBoundary({
    fields: computation.sinkTypes.result,
    types: computation.types,
  });
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    count: "9007199254740993",
    amount: null,
  };
  assertEquals(boundary.rows([row], "canonical"), [row]);
  assertThrows(
    () => boundary.rows([{ ...row, rating: 1 }], "canonical"),
    Error,
    "columns differ",
  );
  assertThrows(
    () => boundary.rows([{ id: row.id, count: row.count }], "canonical"),
    Error,
    "columns differ",
  );
  const complete = await cue(["export", "-", "-e", "out"], program());
  assertEquals(complete.success, true, complete.stderr);
  assertEquals(
    JSON.parse(complete.stdout)[0].sinkTypes.result.map((
      field: { name: string },
    ) => field.name),
    ["id", "count", "amount", "rating", "stamp"],
  );
});

Deno.test("column projection is per sink and the remaining sinks retain complete schemas", async () => {
  const result = await cue(
    ["export", "-", "-e", "out"],
    program(["id", "count"]) + `
app: state: {
  entities: Other: {table: "other", durability: "offline", fields: [
    {name: "id", type: "uuid", pk: true}, {name: "active", type: "bool"},
  ]}
  duckstreams: recount: sinks: other: {entity: "Other", write: "upsert", version: "latest", transaction: "recount"}
}`,
  );
  assertEquals(result.success, true, result.stderr);
  const [computation] = JSON.parse(result.stdout);
  assertEquals(
    computation.sinkTypes.result.map((field: { name: string }) => field.name),
    ["id", "count"],
  );
  assertEquals(computation.sinkTypes.other, [
    { name: "id", type: "uuid", required: true },
    { name: "active", type: "bool", required: true },
  ]);
});

Deno.test("internal computation column maps cannot select an undeclared sink", async () => {
  const result = await cue(
    ["export", "-", "-e", "app"],
    program() + `
app: state: computations: recount: sinkColumns: Missing: ["id"]`,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.stderr, "_sinkColumnTargets");
});

for (const column of ["unknown", "search_key", "retired"]) {
  Deno.test(`compute sink columns reject non-writable ${column}`, async () => {
    const result = await cue(
      ["export", "-", "-e", "app"],
      program(["id", "count", column]),
    );
    assertEquals(result.success, false);
    assertStringIncludes(
      result.stderr,
      `column ${column} is not a writable entity field`,
    );
  });
}

for (const columns of [["id"], ["count"], ["id", "count", "count"], []]) {
  Deno.test(`compute sink columns reject incomplete or repeated projection ${JSON.stringify(columns)}`, async () => {
    const result = await cue(["export", "-", "-e", "app"], program(columns));
    assertEquals(result.success, false);
    if (columns.length === 1 && columns[0] === "id") {
      assertStringIncludes(result.stderr, "requires insert column count");
    }
  });
}
