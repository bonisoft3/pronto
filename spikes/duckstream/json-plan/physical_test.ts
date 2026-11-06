import { DuckDBInstance } from "@duckdb/node-api";
import {
  parse,
  type Plan,
  type Schema,
  translate,
  translatePhysical,
} from "./translator.ts";

const integer = { type: "INTEGER", nullable: true };
const text = { type: "VARCHAR", nullable: true };
const bigint = { type: "BIGINT", nullable: true };
const ref = (input: number) => ({ input });
const eq = (left: number, right: number) => ({
  op: { name: "=" },
  operands: [ref(left), ref(right)],
});
const scan = (id: number, table: string) => ({
  id,
  relOp: "LogicalTableScan",
  table: ["schema", table],
  inputs: [],
});
const project = (id: number, input: number, columns: number[]) => ({
  id,
  relOp: "LogicalProject",
  inputs: [input],
  fields: columns.map((_, i) => `f${i}`),
  exprs: columns.map(ref),
});
const relation = (
  name: string,
  types: { type: string; nullable: boolean }[],
) => ({
  name,
  materialized: false,
  fields: types.map((columntype, i) => ({ name: `f${i}`, columntype })),
});
const schema = (output: { type: string; nullable: boolean }[]): Schema => ({
  inputs: [
    relation("a", [integer, text, integer]),
    relation("b", [integer, text, integer]),
  ],
  outputs: [relation("result", output)],
});
const setup = `CREATE TABLE a(f0 INTEGER, f1 VARCHAR, f2 INTEGER);
  CREATE TABLE b(f0 INTEGER, f1 VARCHAR, f2 INTEGER);
  INSERT INTO a VALUES (1,'same',10),(1,'same',20),(2,'same',30),(3,NULL,NULL);
  INSERT INTO b VALUES (1,'keep',100),(1,'drop',200),(4,'keep',400);`;
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
  }
}
const bag = (rows: unknown[][]) =>
  rows.map((row) => JSON.stringify(row)).sort();

Deno.test("physical planning leaves all recorded logical SQL byte-identical", async () => {
  const root = new URL("results/", import.meta.url);
  let checked = 0;
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    const directory = new URL(entry.name + "/", root);
    const files = new Set<string>();
    for await (const file of Deno.readDir(directory)) files.add(file.name);
    if (!files.has("duckdb.sql")) continue;
    const plan = parse(
      await Deno.readTextFile(new URL("plan.json", directory)),
    ) as Plan;
    const types = parse(
      await Deno.readTextFile(new URL("schema.json", directory)),
    ) as Schema;
    equal(
      translate(plan, types),
      await Deno.readTextFile(new URL("duckdb.sql", directory)),
      entry.name,
    );
    checked++;
  }
  if (checked < 23) {
    throw new Error(`expected recorded compiler coverage, found ${checked}`);
  }
});

async function execute(
  plan: Plan,
  types: Schema,
  expected?: unknown[][],
  data = setup,
) {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  try {
    await c.run(data);
    const logical = (await c.runAndReadAll(translate(plan, types)))
      .getRowsJson();
    if (expected) equal(bag(logical), bag(expected), "logical regression rows");
    const physical = translatePhysical(
      plan,
      types,
      "result",
      "__duckstream_liveness",
    );
    const columns: string[][] = [];
    for (const stage of physical.stages) {
      equal(/^(SELECT|WITH)\b/.test(stage.sql), true, "stage admission prefix");
      await c.run(`CREATE TEMP TABLE "${stage.name}" AS ${stage.sql}`);
      columns.push(
        (await c.runAndReadAll(`SELECT * FROM "${stage.name}" LIMIT 0`))
          .columnNames(),
      );
    }
    equal(
      bag((await c.runAndReadAll(physical.sql)).getRowsJson()),
      bag(logical),
      "physical bag equals logical bag",
    );
    return { physical, columns };
  } finally {
    c.closeSync();
    db.closeSync();
  }
}

Deno.test("physical joins store only demanded outputs while preserving join predicates and outer nulls", async () => {
  for (const joinType of ["inner", "left", "right", "full"]) {
    const result = await execute({
      result: {
        rels: [
          scan(0, "a"),
          scan(1, "b"),
          {
            id: 2,
            relOp: "LogicalJoin",
            inputs: [0, 1],
            joinType,
            condition: eq(0, 3),
          },
          project(3, 2, [2, 4]),
        ],
      },
    }, schema([integer, text]));
    equal(result.columns[0], ["c2", "c4"], `${joinType} stored width`);
  }
});

Deno.test("physical liveness retains filter-only columns until their predicate is evaluated", async () => {
  const result = await execute(
    {
      result: {
        rels: [
          scan(0, "a"),
          scan(1, "b"),
          {
            id: 2,
            relOp: "LogicalJoin",
            inputs: [0, 1],
            joinType: "left",
            condition: eq(0, 3),
          },
          {
            id: 3,
            relOp: "LogicalFilter",
            inputs: [2],
            condition: {
              op: { name: "=" },
              operands: [ref(4), { literal: "keep", type: text }],
            },
          },
          project(4, 3, [2]),
        ],
      },
    },
    schema([integer]),
    [[10], [20]],
  );
  equal(result.columns[0], ["c2", "c4"], "filter-only column retained");
});

Deno.test("physical aggregates keep hidden grouping keys and preserve duplicate visible groups", async () => {
  const result = await execute(
    {
      result: {
        rels: [
          scan(0, "a"),
          {
            id: 1,
            relOp: "LogicalAggregate",
            inputs: [0],
            group: [0],
            aggs: [
              {
                agg: { name: "SUM" },
                type: bigint,
                distinct: false,
                operands: [2],
                name: "total",
              },
            ],
          },
          project(2, 1, [1]),
        ],
      },
    },
    schema([bigint]),
    [["30"], ["30"], [null]],
  );
  for (const columns of result.columns.slice(1, 17)) {
    equal(
      columns,
      ["c1"],
      "group key omitted only after partition aggregation",
    );
  }
});

Deno.test("physical COUNT preserves cardinality when no intermediate column remains live", async () => {
  const result = await execute(
    {
      result: {
        rels: [
          scan(0, "a"),
          {
            id: 1,
            relOp: "LogicalAggregate",
            inputs: [0],
            group: [0, 1],
            aggs: [],
          },
          {
            id: 2,
            relOp: "LogicalAggregate",
            inputs: [1],
            group: [],
            aggs: [
              {
                agg: { name: "COUNT" },
                type: bigint,
                distinct: false,
                operands: [],
                name: "n",
              },
            ],
          },
        ],
      },
    },
    schema([bigint]),
    [["3"]],
  );
  equal(
    result.columns[1],
    ["__row"],
    "cardinality marker replaces dead payload",
  );
});

Deno.test("physical UNION DISTINCT retains hidden discriminator columns in materialized local inputs", async () => {
  const plan: Plan = {
    left_rows: { rels: [scan(0, "a"), project(1, 0, [0, 1])] },
    right_rows: { rels: [scan(0, "a"), project(1, 0, [0, 1])] },
    result: {
      rels: [
        scan(0, "left_rows"),
        scan(1, "right_rows"),
        { id: 2, relOp: "LogicalUnion", inputs: [0, 1], all: false },
        project(3, 2, [1]),
      ],
    },
  };
  const distinct = await execute(plan, schema([text]), [["same"], ["same"], [
    null,
  ]]);
  equal(
    distinct.columns.slice(0, 2),
    [["c0", "c1"], ["c0", "c1"]],
    "distinct discriminator retained",
  );
  plan.result.rels[2].all = true;
  const all = await execute(plan, schema([text]), [
    ["same"],
    ["same"],
    ["same"],
    [null],
    ["same"],
    ["same"],
    ["same"],
    [null],
  ]);
  equal(
    all.columns.slice(0, 2),
    [["c1"], ["c1"]],
    "bag union prunes hidden columns",
  );
});

Deno.test("physical shared-view demand unions all consumers without renumbering ordinals", async () => {
  const result = await execute({
    shared: { rels: [scan(0, "a")] },
    left_rows: { rels: [scan(0, "shared"), project(1, 0, [0])] },
    right_rows: { rels: [scan(0, "shared"), project(1, 0, [2])] },
    result: {
      rels: [
        scan(0, "left_rows"),
        scan(1, "right_rows"),
        {
          id: 2,
          relOp: "LogicalJoin",
          inputs: [0, 1],
          joinType: "inner",
          condition: {
            literal: true,
            type: { type: "BOOLEAN", nullable: false },
          },
        },
      ],
    },
  }, schema([integer, integer]));
  equal(result.columns[0], ["c0", "c2"], "shared-view union of demand");
});

Deno.test("physical liveness does not admit unsupported ordering or discarded scalar operators", () => {
  for (
    const node of [
      { id: 1, relOp: "LogicalSort", inputs: [0] },
      {
        id: 1,
        relOp: "LogicalProject",
        inputs: [0],
        fields: ["good", "bad"],
        exprs: [ref(0), { op: { name: "now" }, operands: [] }],
      },
    ]
  ) {
    let failure: unknown;
    try {
      translatePhysical(
        { result: { rels: [scan(0, "a"), node, project(2, 1, [0])] } },
        schema([integer]),
        "result",
        "__duckstream_liveness",
      );
    } catch (error) {
      failure = error;
    }
    if (
      !(failure instanceof Error) ||
      !failure.message.includes("OUTSIDE_EXPORT_PROFILE")
    ) throw new Error("unsupported plan admitted");
  }
});

Deno.test("physical ASOF match keys and HOP/TUMBLE descriptors survive across local materializations", async () => {
  for (const fixture of ["asof", "hop", "tumble"]) {
    const plan = parse(
      await Deno.readTextFile(
        new URL(`results/${fixture}/plan.json`, import.meta.url),
      ),
    ) as Plan;
    const types = parse(
      await Deno.readTextFile(
        new URL(`results/${fixture}/schema.json`, import.meta.url),
      ),
    ) as Schema;
    for (const view of Object.values(plan)) {
      for (const node of view.rels) {
        if (
          node.relOp === "LogicalTableScan" &&
          types.inputs.some((input) => input.name === node.table?.[1])
        ) {
          node.table![1] += "_local";
        }
      }
    }
    for (const input of types.inputs) {
      plan[input.name + "_local"] = { rels: [scan(0, input.name)] };
    }
    const result = await execute(
      plan,
      types,
      undefined,
      fixture === "asof"
        ? `
      CREATE TABLE fixtures_game(id INTEGER, team VARCHAR, moment TIMESTAMP);
      CREATE TABLE fixtures_rating(team VARCHAR, moment TIMESTAMP, power DOUBLE);
      INSERT INTO fixtures_game VALUES (1,'a','2026-01-02'),(2,'a','2026-01-03'),(3,'b','2026-01-01'),(4,NULL,NULL);
      INSERT INTO fixtures_rating VALUES ('a','2026-01-01',1.0),('a','2026-01-03',3.0),('b','2026-01-02',2.0);`
        : `CREATE TABLE events(id INTEGER, ts TIMESTAMP NOT NULL, amount BIGINT);
         INSERT INTO events VALUES (1,make_timestamp(-1),5),(2,make_timestamp(0),NULL),(3,make_timestamp(5000000),7);`,
    );
    if (fixture !== "asof") {
      equal(
        result.columns[0],
        ["c1", "c2"],
        "window descriptor retained, unused id pruned",
      );
    } else {equal(
        result.columns.at(-2),
        ["c0", "c5"],
        "ASOF result retains only selected columns",
      );}
  }
});

Deno.test("physical ASOF partitions preserve composite equality, signed zero, nulls and duplicate left bags", async () => {
  const double = { type: "DOUBLE", nullable: true };
  const timestamp = { type: "TIMESTAMP", nullable: true, precision: 6 };
  const types: Schema = {
    inputs: [
      relation("a", [integer, double, text, timestamp]),
      relation("b", [double, text, timestamp, integer]),
    ],
    outputs: [relation("result", [integer, integer])],
  };
  const plan: Plan = {
    result: {
      rels: [
        scan(0, "a"),
        scan(1, "b"),
        {
          id: 2,
          relOp: "LogicalAsofJoin",
          inputs: [0, 1],
          joinType: "left_asof",
          condition: { op: { name: "AND" }, operands: [eq(1, 4), eq(2, 5)] },
          matchCondition: { op: { name: ">=" }, operands: [ref(3), ref(6)] },
        },
        project(3, 2, [0, 7]),
      ],
    },
  };
  const result = await execute(
    plan,
    types,
    [
      [1, 30],
      [2, 30],
      [2, 30],
      [3, null],
      [4, null],
      [5, null],
      [6, null],
    ],
    `
    CREATE TABLE a(f0 INTEGER,f1 DOUBLE,f2 VARCHAR,f3 TIMESTAMP);
    CREATE TABLE b(f0 DOUBLE,f1 VARCHAR,f2 TIMESTAMP,f3 INTEGER);
    INSERT INTO a VALUES (1,0.0,'a','2026-01-03'),(2,CAST('-0.0' AS DOUBLE),'a','2026-01-03'),
      (2,CAST('-0.0' AS DOUBLE),'a','2026-01-03'),(3,2,'a','2026-01-03'),(4,NULL,'a','2026-01-03'),
      (5,1,'b',NULL),(6,0,'A','2026-01-03');
    INSERT INTO b VALUES (CAST('-0.0' AS DOUBLE),'a','2026-01-01',10),(0.0,'a','2026-01-03',30),
      (NULL,'a','2026-01-03',40),(1,'b',NULL,50);`,
  );
  equal(
    result.physical.stages.filter((stage) =>
      stage.sql.includes("ASOF LEFT JOIN")
    ).length,
    64,
    "each hash bucket is a separate materialization",
  );
});

Deno.test("physical ASOF retaining all columns emits admissible union stages", async () => {
  const timestamp = { type: "TIMESTAMP", nullable: true, precision: 6 };
  const types: Schema = {
    inputs: [
      relation("a", [integer, timestamp]),
      relation("b", [integer, timestamp]),
    ],
    outputs: [relation("result", [integer, timestamp, integer, timestamp])],
  };
  await execute(
    {
      result: {
        rels: [scan(0, "a"), scan(1, "b"), {
          id: 2,
          relOp: "LogicalAsofJoin",
          inputs: [0, 1],
          joinType: "left_asof",
          condition: eq(0, 2),
          matchCondition: { op: { name: ">=" }, operands: [ref(1), ref(3)] },
        }],
      },
    },
    types,
    undefined,
    `
    CREATE TABLE a(f0 INTEGER,f1 TIMESTAMP);
    CREATE TABLE b(f0 INTEGER,f1 TIMESTAMP);
    INSERT INTO a VALUES(1,'2026-01-02'),(2,NULL);
    INSERT INTO b VALUES(1,'2026-01-01');`,
  );
});

Deno.test("physical ASOF source barriers retain duplicate timestamp validation", async () => {
  const root = new URL("results/asof/", import.meta.url);
  const plan = parse(
    await Deno.readTextFile(new URL("plan.json", root)),
  ) as Plan;
  const types = parse(
    await Deno.readTextFile(new URL("schema.json", root)),
  ) as Schema;
  const physical = translatePhysical(
    plan,
    types,
    "result",
    "__duckstream_guard",
  );
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  try {
    await c.run(`
      CREATE TABLE fixtures_game(id INTEGER,team VARCHAR,moment TIMESTAMP);
      INSERT INTO fixtures_game VALUES(1,'a','2026-01-02');
      CREATE TABLE raw_rating(team VARCHAR,moment TIMESTAMP,power DOUBLE);
      INSERT INTO raw_rating VALUES('a','2026-01-01',1),('a','2026-01-01',2);
      CREATE VIEW fixtures_rating AS SELECT CASE WHEN count(*) OVER(PARTITION BY team,moment)>1
        THEN error('ambiguous team/day') ELSE team END AS team,moment,power FROM raw_rating;`);
    let rejected = false;
    for (const stage of physical.stages) {
      try {
        await c.run(`CREATE TABLE "${stage.name}" AS ${stage.sql}`);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("ambiguous team/day")
        ) throw error;
        rejected = true;
        break;
      }
    }
    equal(rejected, true, "source validation must run before partitioned ASOF");
  } finally {
    c.closeSync();
    db.closeSync();
  }
});

Deno.test("physical aggregate partitions keep complete composite/null groups and empty global rows", async () => {
  const aggs = [
    {
      name: "value",
      agg: { name: "COUNT" },
      type: bigint,
      distinct: false,
      operands: [],
    },
    {
      name: "value",
      agg: { name: "SUM" },
      type: bigint,
      distinct: false,
      operands: [2],
    },
    {
      name: "value",
      agg: { name: "MIN" },
      type: integer,
      distinct: false,
      operands: [2],
    },
    {
      name: "value",
      agg: { name: "MAX" },
      type: integer,
      distinct: false,
      operands: [2],
    },
  ];
  for (const empty of [false, true]) {
    for (const group of [[0, 1], []]) {
      const types = schema([
        ...group.map((i) => i === 0 ? integer : text),
        bigint,
        bigint,
        integer,
        integer,
      ]);
      const plan: Plan = {
        result: {
          rels: [scan(0, "a"), {
            id: 1,
            relOp: "LogicalAggregate",
            inputs: [0],
            group,
            aggs,
          }],
        },
      };
      const { physical } = await execute(
        plan,
        types,
        undefined,
        setup +
          (empty
            ? "DELETE FROM a;"
            : "INSERT INTO a VALUES(NULL,NULL,4),(NULL,NULL,5),(1,'same',NULL),(1,'other',7);"),
      );
      equal(
        physical.stages.filter((stage) => stage.sql.includes(" WHERE hash("))
          .length,
        group.length ? 16 : 0,
        "partition complete groups only",
      );
    }
  }
});

Deno.test("partitioned AVG retains whole groups with signed-zero and NaN keys", async () => {
  const double = { type: "DOUBLE", nullable: true };
  await execute(
    {
      result: {
        rels: [scan(0, "a"), {
          id: 1,
          relOp: "LogicalAggregate",
          inputs: [0],
          group: [0],
          aggs: [
            {
              name: "mean",
              agg: { name: "AVG" },
              type: double,
              distinct: false,
              operands: [1],
            },
            {
              name: "n",
              agg: { name: "COUNT" },
              type: bigint,
              distinct: false,
              operands: [],
            },
          ],
        }],
      },
    },
    {
      inputs: [relation("a", [double, double])],
      outputs: [relation("result", [double, double, bigint])],
    },
    undefined,
    "CREATE TABLE a(f0 DOUBLE,f1 DOUBLE); INSERT INTO a VALUES(-0.0,1),(0.0,5),('NaN',2),('NaN',8),(NULL,4),(NULL,NULL);",
  );
});
