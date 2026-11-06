import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import {
  checkCompiledProgram,
  compileProgram,
} from "../../../duckstream/compiler.ts";
import {
  checkDiagnostics,
  type Diagnostic,
  readDiagnostics,
} from "../../../duckstream/diagnostics.ts";
import {
  admitSchema,
  parse,
  type Plan,
  require,
  type Schema,
  translate,
  type as sqlType,
} from "./translator.ts";

Deno.chdir(new URL(".", import.meta.url));
const hash = "d08430de8b34ae997b72c44eb9a9274b25955a41af35e7c6997e7e459d3283ab";
const jar = Deno.env.get("FELDERA_JAR") ??
  new URL("../compiler/.cache/feldera-0.367.0.jar", import.meta.url).pathname;
const decoder = new TextDecoder();
const filtered = ["filtered_aggregate", "filtered_case"];
const accepted = [
  "aggregate",
  "aliases",
  "aliases_identity",
  "hop",
  "join_aggregate",
  "tumble",
  "window_count",
  "distinct_aggregate",
  "default_min",
  "ordinary",
  "extrema",
  "full_join",
  "right_join",
  "arithmetic",
  "decimal_boundary",
  "typed_case",
  "timestamp_math",
  "calendar_year",
  "timestamp_corpus",
  "dashboard_scalars",
  "union_values",
  "string_search",
  "dynamic_substring",
  "asof",
];
const rejected: Record<string, string> = {
  lateness: "LATENESS",
  append_only: "properties",
  emit_final: "LATENESS",
  default_value: "default",
  large_literal: "unsafe JSON integer",
  column_case: "case collision",
  output_case: "case collision",
  table_case: "case collision",
  view_table_case: "case collision",
  unused_lateness: "LATENESS",
  decimal_arithmetic: "arithmetic INTEGER/BIGINT/DOUBLE",
  decimal_narrowing: "lossless DECIMAL cast",
  bounded_varchar_numeric: "bounded VARCHAR cast",
  bounded_varchar_text: "bounded VARCHAR cast",
  live_now: "operator now",
  window_offset: "window offset",
  nullable_timestamp: "non-null TIMESTAMP",
  window_analytic: "node LogicalWindow",
  calendar_interval: "fixed interval literal",
  timestamp_literal_micros:
    "TIMESTAMP literal with exact exported milliseconds",
  dynamic_divisor: "integer division/modulo by positive literal",
  substring_negative: "SUBSTRING positive literal start",
};
async function digest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
async function command(cmd: string, args: string[], diagnostics = false) {
  const p = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!p.success) {
    throw new Error(
      `${cmd} exited ${p.code}\n${decoder.decode(p.stdout)}\n${
        decoder.decode(p.stderr)
      }`,
    );
  }
  return decoder.decode(p.stdout) +
    (diagnostics ? "\n" + decoder.decode(p.stderr) : "");
}
async function doctor() {
  require(
    await digest(await Deno.readFile(jar)) === hash,
    "compiler artifact hash",
  );
  const version = (await command("java", ["-jar", jar, "--version"])).trim();
  require(version.includes("0.367.0"), "compiler version");
  return {
    feldera: version,
    jar_sha256: hash,
    deno: Deno.version.deno,
    duckdb_package: "@duckdb/node-api@1.4.3-r.3",
  };
}
async function json(path: string, value: unknown) {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}
async function load(name: string): Promise<{ plan: Plan; schema: Schema }> {
  return {
    plan: parse(await Deno.readTextFile(`results/${name}/plan.json`)) as Plan,
    schema: parse(
      await Deno.readTextFile(`results/${name}/schema.json`),
    ) as Schema,
  };
}
async function compile(name: string, verbosity = 1, destination = name) {
  const dir = `results/${destination}`;
  await Deno.mkdir(dir, { recursive: true });
  const output = await command("java", [
    "-jar",
    jar,
    "-i",
    "--alltables",
    "-v",
    String(verbosity),
    ...(filtered.includes(name) ? ["-T", "SqlToRelCompiler=2"] : []),
    "--noRust",
    "--plan",
    `${dir}/plan.json`,
    "--js",
    `${dir}/schema.json`,
    `fixtures/${name}.sql`,
  ], filtered.includes(name));
  if (filtered.includes(name)) {
    const start = output.indexOf("CREATE VIEW `result` AS\n");
    require(start >= 0, "filter diagnostic source anchor");
    await Deno.writeTextFile(
      `${dir}/diagnostics.json`,
      JSON.stringify(output.slice(start)) + "\n",
    );
  }
}
async function build() {
  const tools = await doctor();
  const sources: Record<string, string> = {};
  const files = Array.from(Deno.readDirSync("fixtures")).filter((f) =>
    f.name.endsWith(".sql")
  ).sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files) {
    const name = f.name.slice(0, -4);
    sources[name] = await digest(await Deno.readFile(`fixtures/${f.name}`));
    await compile(name);
    if (accepted.includes(name)) {
      const { plan, schema } = await load(name);
      await Deno.writeTextFile(
        `results/${name}/duckdb.sql`,
        translate(plan, schema),
      );
    }
  }
  await compile("default_sum", 0, "quiet_sum");
  await compile("default_min", 0, "quiet_min");
  await compileProgram({
    sourcePath: "fixtures/timestamp_math.sql",
    outputDirectory: "results/compiler_driver",
    views: ["result"],
    jarPath: jar,
  });
  for (const name of filtered) {
    await refuses(
      () =>
        compileProgram({
          sourcePath: `fixtures/${name}.sql`,
          outputDirectory: `results/${name}`,
          views: ["result"],
          jarPath: jar,
        }),
      "aggregate FILTER",
    );
  }
  await Deno.mkdir("results/alternatives", { recursive: true });
  await command("java", [
    "-jar",
    jar,
    "-i",
    "--jit",
    "--dataflow",
    "results/alternatives/dataflow.json",
    "-o",
    "results/alternatives/jit.json",
    "fixtures/default_sum.sql",
  ]);
  await json("results/build.json", {
    ...tools,
    flags: ["-i", "--alltables", "-v", "1", "--noRust", "--plan", "--js"],
    sources,
  });
  console.log(
    `Built ${files.length} stock export fixtures and ${accepted.length} DuckDB queries`,
  );
}
function equal(actual: unknown, expected: unknown, message: string) {
  require(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nactual=${JSON.stringify(actual)}\nexpected=${
      JSON.stringify(expected)
    }`,
  );
}
function bag(rows: unknown[][]) {
  return rows.map((r) => JSON.stringify(r)).sort();
}
async function refuses(
  action: () => unknown | Promise<unknown>,
  message: string,
) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  require(
    failure instanceof Error && failure.message.includes(message),
    `expected refusal containing ${message}; got ${failure}`,
  );
}
type Event = [number, bigint, bigint | null];
const cases: Record<string, Event[]> = {
  empty: [],
  boundaries: [
    [1, -10000001n, 3n],
    [2, -10000000n, null],
    [3, -1n, 7n],
    [4, 0n, 11n],
    [5, 4999999n, 13n],
    [6, 5000000n, null],
    [7, 9999999n, -2n],
    [8, 10000000n, 19n],
  ],
  duplicates: [[1, 1000000n, 7n], [2, 1000000n, 7n], [3, 1000000n, null]],
  exact_bigint: [[1, 1n, 9007199254740993n], [2, 2n, 2n]],
  all_null: [[1, -1n, null], [2, 1n, null]],
};
function windowRows(events: Event[], slide: bigint, size: bigint): unknown[][] {
  const groups = new Map<
    string,
    { start: bigint; n: bigint; total: bigint | null }
  >();
  for (const [, ts, amount] of events) {
    const bucket = ts - ((ts % slide + slide) % slide);
    for (let start = bucket - size + slide; start <= bucket; start += slide) {
      const key = String(start);
      const g = groups.get(key) ?? { start, n: 0n, total: null };
      g.n++;
      if (amount !== null) g.total = (g.total ?? 0n) + amount;
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((
    g,
  ) => [
    String(g.start),
    String(g.start + size),
    String(g.n),
    g.total === null ? null : String(g.total),
  ]);
}
async function query(c: DuckDBConnection, name: string) {
  return await c.runAndReadAll(
    await Deno.readTextFile(`results/${name}/duckdb.sql`),
  );
}
async function test() {
  const tools = await doctor();
  const built = JSON.parse(await Deno.readTextFile("results/build.json")) as {
    sources: Record<string, string>;
  };
  for (const [name, sha] of Object.entries(built.sources)) {
    equal(
      await digest(await Deno.readFile(`fixtures/${name}.sql`)),
      sha,
      `stale fixture ${name}; run build`,
    );
  }
  for (const name of accepted) {
    const { plan, schema } = await load(name);
    equal(
      await Deno.readTextFile(`results/${name}/duckdb.sql`),
      translate(plan, schema),
      `stale translation ${name}; run build`,
    );
  }
  const refused: Record<string, string> = {};
  for (const [name, reason] of Object.entries(rejected)) {
    await refuses(async () => {
      const { plan, schema } = await load(name);
      translate(plan, schema);
    }, reason);
    refused[name] = reason;
  }
  const quietSum = await load("quiet_sum");
  const quietMin = await load("quiet_min");
  equal(quietSum, quietMin, "default verbosity SUM/MIN export collision");
  await refuses(
    () => translate(quietSum.plan, quietSum.schema),
    "aggregate calls",
  );
  const ordinary = await load("aliases_identity");
  const materialized = structuredClone(ordinary.schema);
  materialized.outputs.find((r) => r.name === "result")!.materialized = true;
  equal(
    translate(ordinary.plan, materialized),
    translate(ordinary.plan, ordinary.schema),
    "materializing a result does not change snapshot relational semantics",
  );
  materialized.inputs[0].materialized = true;
  await refuses(() => admitSchema(materialized), "materialized input relation");
  const search = await load("string_search");
  const searchExpression = search.plan.result.rels.map((node) => node.condition)
    .find((expression) => expression?.op?.name === "SEARCH");
  require(searchExpression?.operands, "stock singleton SEARCH expression");
  const ranges = searchExpression.operands[1].literal as {
    nullAs: string;
    rangeSet: string[][];
  };
  ranges.nullAs = "FALSE";
  await refuses(
    () => translate(search.plan, search.schema),
    "SEARCH unknown null",
  );
  ranges.nullAs = "UNKNOWN";
  const item = JSON.parse(ranges.rangeSet[0][1]);
  item.collation.locale = "tr_TR";
  ranges.rangeSet[0][1] = JSON.stringify(item);
  await refuses(
    () => translate(search.plan, search.schema),
    "SEARCH default collation",
  );
  const deadNow = await load("dead_now");
  equal(
    ordinary,
    deadNow,
    "optimized NOW source policy is absent from both exports",
  );
  equal(
    ordinary,
    await load("declaration_only"),
    "unused UDF declaration is absent from both exports",
  );
  const emit = (await load("emit_final")).schema;
  require(
    emit.outputs.find((r) => r.name === "result")?.properties?.emit_final,
    "emit_final retained",
  );
  const withoutLateness = structuredClone(emit);
  for (const r of withoutLateness.inputs) {
    for (const f of r.fields) delete f.lateness;
  }
  await refuses(() => admitSchema(withoutLateness), "emit_final");
  for (
    const text of [
      "9007199254740993",
      "9007199254740992",
    ]
  ) {
    await refuses(
      () => parse(text),
      "unsafe JSON integer",
    );
  }
  for (const token of ["9007199254740991.1", "1e3", "0.125", "2.0"]) {
    equal(
      JSON.stringify(parse(token)),
      JSON.stringify({ source: token }),
      "fractional/exponent numeric token retained before JS rounding",
    );
  }
  for (
    const [precision, scale] of [[29, 2], [38, 2], [18, 19], [18, -1], [0, 0]]
  ) {
    await refuses(
      () => sqlType({ type: "DECIMAL", nullable: true, precision, scale }),
      "DECIMAL precision",
    );
  }
  const db = await DuckDBInstance.create(":memory:");
  for (const name of filtered) {
    const { plan } = await load(name);
    const diagnostics = JSON.parse(
      await Deno.readTextFile(
        `results/${name}/diagnostics.json`,
      ),
    );
    await refuses(() => readDiagnostics(diagnostics, plan), "aggregate FILTER");
    await refuses(
      () =>
        readDiagnostics(
          diagnostics.replace("CREATE VIEW", "CREATE MATERIALIZED VIEW"),
          plan,
        ),
      "aggregate FILTER",
    );
  }
  const driverPlan = parse(
    await Deno.readTextFile("results/compiler_driver/plan.json"),
  ) as Plan;
  const driverDiagnostics = JSON.parse(
    await Deno.readTextFile("results/compiler_driver/diagnostics.json"),
  ) as Diagnostic[];
  await refuses(
    () => checkDiagnostics([], driverPlan),
    "complete final-plan diagnostics",
  );
  const truncated = structuredClone(driverDiagnostics);
  truncated[0].final.pop();
  await refuses(
    () => checkDiagnostics(truncated, driverPlan),
    "complete final-plan diagnostic tree",
  );
  await refuses(
    () => readDiagnostics("", driverPlan),
    "complete final-plan diagnostics",
  );
  const missingDiagnostics = await Deno.makeTempDir({
    prefix: "duckstream-admission-",
  });
  try {
    for await (const file of Deno.readDir("results/compiler_driver")) {
      if (file.isFile && file.name !== "diagnostics.json") {
        await Deno.copyFile(
          `results/compiler_driver/${file.name}`,
          `${missingDiagnostics}/${file.name}`,
        );
      }
    }
    await refuses(() =>
      checkCompiledProgram({
        sourcePath: "fixtures/timestamp_math.sql",
        outputDirectory: missingDiagnostics,
        views: ["result"],
      }), "diagnostics.json");
  } finally {
    await Deno.remove(missingDiagnostics, { recursive: true });
  }
  const c = await db.connect();
  const evidence: unknown[] = [];
  try {
    const version = (await c.runAndReadAll("SELECT version()")).getRowsJson();
    equal(version, [["v1.4.3"]], "native engine");
    await checkCompiledProgram({
      sourcePath: "fixtures/timestamp_math.sql",
      outputDirectory: "results/compiler_driver",
      views: ["result"],
    });
    equal(
      (await c.runAndReadAll(
        "SELECT CAST(123 AS VARCHAR(2)), CAST('longer' AS VARCHAR(2))",
      )).getRowsJson(),
      [["123", "longer"]],
      "DuckDB ignores VARCHAR cast widths, so bounded exported casts must refuse",
    );
    await c.run(
      "CREATE TABLE events(id INTEGER NOT NULL, ts TIMESTAMP NOT NULL, amount BIGINT); CREATE TABLE accounts(id INTEGER NOT NULL, region VARCHAR NOT NULL); CREATE TABLE t(x INTEGER, y BIGINT)",
    );
    for (const [caseName, events] of Object.entries(cases)) {
      await c.run("DELETE FROM events");
      if (events.length) {
        await c.run(
          `INSERT INTO events VALUES ${
            events.map(([id, ts, a]) =>
              `(${id},make_timestamp(${ts}),${a ?? "NULL"})`
            ).join(",")
          }`,
        );
      }
      for (const name of ["hop", "tumble", "aggregate", "window_count"]) {
        const result = await query(c, name);
        const raw = result.getRowsJson();
        const schema = (await load(name)).schema.outputs.find((r) =>
          r.name === "result"
        )!;
        equal(
          result.columnNames(),
          schema.fields.map((f) => f.name),
          `${name} declared names`,
        );
        equal(
          result.columnTypes().map((t) => String(t)),
          schema.fields.map((f) => f.columntype.type),
          `${name} declared types`,
        );
        const sum = events.reduce<bigint | null>(
          (s, [, , a]) => a === null ? s : (s ?? 0n) + a,
          null,
        );
        let actual: unknown[][] = raw;
        let expected: unknown[][];
        if (name === "aggregate") {
          expected = [[
            String(events.length),
            sum === null ? null : String(sum),
          ]];
        } else if (name === "window_count") {
          expected = [[String(events.length)]];
        } else {
          const sql = (await Deno.readTextFile(`results/${name}/duckdb.sql`))
            .trim().replace(/;$/, "");
          actual = (await c.runAndReadAll(
            `SELECT epoch_us(window_start),epoch_us(window_end),n,total FROM (${sql})`,
          )).getRowsJson();
          expected = windowRows(
            events,
            name === "hop" ? 5000000n : 10000000n,
            10000000n,
          );
        }
        equal(bag(actual), bag(expected), `${name}/${caseName}`);
        evidence.push({
          fixture: name,
          snapshot: caseName,
          rows: actual,
          types: result.columnTypes().map(String),
        });
      }
    }
    await c.run(
      "DELETE FROM events; INSERT INTO events VALUES (1,make_timestamp(0),7),(2,make_timestamp(0),7),(3,make_timestamp(0),NULL),(4,make_timestamp(0),-1),(5,make_timestamp(0),7); INSERT INTO accounts VALUES (1,'north'),(2,'north'),(3,'south'),(4,'south'),(5,'north')",
    );
    equal(
      bag((await query(c, "join_aggregate")).getRowsJson()),
      bag([["north", "3", "21"]]),
      "join duplicates/null/filter",
    );
    await c.run(
      "INSERT INTO t VALUES (3,9007199254740993),(3,9007199254740993),(NULL,NULL)",
    );
    equal(
      (await query(c, "distinct_aggregate")).getRowsJson(),
      [["1"]],
      "optimized DISTINCT is ordinary grouped relational computation",
    );
    for (const name of ["aliases", "aliases_identity"]) {
      const result = await query(c, name);
      equal(
        result.columnNames(),
        name === "aliases"
          ? ["renamed", "Other", "again"]
          : ["renamed", "Other"],
        `${name} names`,
      );
      equal(
        bag(result.getRowsJson()),
        bag(
          name === "aliases"
            ? [["9007199254740993", 3, 3], ["9007199254740993", 3, 3], [
              null,
              null,
              null,
            ]]
            : [[3, "9007199254740993"], [3, "9007199254740993"], [null, null]],
        ),
        `${name} aliases, duplicates, nulls, bigint`,
      );
      evidence.push({
        fixture: name,
        rows: result.getRowsJson(),
        types: result.columnTypes().map(String),
      });
    }
    equal(
      (await c.runAndReadAll(
        "SELECT SUM(x)::BIGINT, MIN(x)::BIGINT FROM (VALUES(2::BIGINT),(3::BIGINT)) t(x)",
      )).getRowsJson(),
      [["5", "2"]],
      "colliding quiet exports represent different results",
    );
    await c.run(
      "DROP TABLE t; CREATE TABLE t(x BIGINT); INSERT INTO t VALUES (9007199254740993),(NULL),(-2)",
    );
    equal(
      (await query(c, "default_min")).getRowsJson(),
      [["-2"]],
      "MIN admitted with verbose calls",
    );
    await c.run(`
      CREATE TABLE teams(id UUID NOT NULL, day DATE, rating DOUBLE, score INTEGER, price DECIMAL(18,2));
      CREATE TABLE standings(id UUID NOT NULL, position INTEGER);
      INSERT INTO teams VALUES
        ('00000000-0000-0000-0000-000000000001','2024-02-29',1.25,3,9007199254740991.01),
        ('00000000-0000-0000-0000-000000000002',NULL,NULL,NULL,NULL);
      INSERT INTO standings VALUES
        ('00000000-0000-0000-0000-000000000001',2),
        ('00000000-0000-0000-0000-000000000001',2);
      CREATE TABLE metrics(g INTEGER, value DOUBLE, exact_value DECIMAL(18,2));
      INSERT INTO metrics VALUES (1,1.25,9007199254740991.01),(1,2.75,9007199254740991.02),(1,NULL,NULL),(2,NULL,NULL);
      CREATE TABLE a(id INTEGER NOT NULL); CREATE TABLE b(id INTEGER NOT NULL);
      INSERT INTO a VALUES (1),(2),(2); INSERT INTO b VALUES (2),(3);
      CREATE TABLE numbers(i INTEGER,n BIGINT,d DOUBLE);
      INSERT INTO numbers VALUES (-2,9007199254740993,1.25),(NULL,NULL,NULL);
      CREATE TABLE money(amount DECIMAL(28,8));
      INSERT INTO money VALUES (99999999999999999999.99999999),(-99999999999999999999.99999999),(NULL);
      CREATE TABLE typed_values(i INTEGER);
      INSERT INTO typed_values VALUES (2147483647),(NULL);
      CREATE TABLE calendar_inputs(id INTEGER NOT NULL,instant TIMESTAMP);
      INSERT INTO calendar_inputs VALUES
        (1,TIMESTAMP '2024-02-29 23:59:59.999999'),
        (2,TIMESTAMP '2024-03-01 00:00:00'),
        (3,TIMESTAMP '2027-01-01 00:00:00'),
        (4,TIMESTAMP '1969-12-31 23:59:59.999999'),(5,NULL);
      CREATE TABLE instants(id INTEGER NOT NULL,a TIMESTAMP NOT NULL,b TIMESTAMP);
      INSERT INTO instants VALUES
        (1,make_timestamp(900000),make_timestamp(1100000)),
        (2,make_timestamp(1100000),make_timestamp(900000)),
        (3,make_timestamp(-1100000),make_timestamp(1100000)),
        (4,make_timestamp(1100000),make_timestamp(-1100000)),
        (5,make_timestamp(0),NULL);
      CREATE TABLE scalar_inputs(id INTEGER NOT NULL, amount BIGINT, haystack VARCHAR, needle VARCHAR, ts TIMESTAMP);
      INSERT INTO scalar_inputs VALUES
        (1,-86401,'is:abc','abc',make_timestamp(-1100000)),
        (2,-1,'is:é😀z','😀',make_timestamp(-1)),
        (3,0,'','',make_timestamp(0)),
        (4,86401,'not:x','missing',make_timestamp(1100000)),
        (5,NULL,NULL,NULL,NULL);
      CREATE TABLE union_source(id INTEGER, label VARCHAR);
      INSERT INTO union_source VALUES (1,'one'),(1,'one'),(NULL,NULL);
      CREATE TABLE search_source(label VARCHAR);
      INSERT INTO search_source VALUES ('day'),('week'),('é😀'),('DAY'),('missing'),(NULL);
      CREATE TABLE substring_source(id INTEGER NOT NULL, s VARCHAR, first BIGINT, width INTEGER);
      INSERT INTO substring_source VALUES
        (1,'aé😀|tail',2,2),(2,'aé😀|tail',4,0),(3,'short',20,3),
        (4,NULL,1,2),(5,'abc',NULL,2),(6,'abc',1,NULL);
    `);
    const timestampSql =
      (await Deno.readTextFile("results/timestamp_math/duckdb.sql")).trim()
        .replace(/;$/, "");
    const timestampRows = (await c.runAndReadAll(
      `SELECT id,epoch_us(next_epoch),seconds,label FROM (${timestampSql})`,
    )).getRowsJson();
    equal(
      bag(timestampRows),
      bag([
        [1, "1860900000", 0, "tick1"],
        [2, "1861100000", 0, "tick2"],
        [3, "1858900000", 2, "tick3"],
        [4, "1861100000", -2, "tick4"],
        [5, "1860000000", null, "tick5"],
      ]),
      "timestamp difference truncates elapsed microseconds toward zero across second and epoch boundaries",
    );
    evidence.push({ fixture: "timestamp_math", rows: timestampRows });
    const corpusSql =
      (await Deno.readTextFile("results/timestamp_corpus/duckdb.sql")).trim()
        .replace(/;$/, "");
    const corpus = async () =>
      (await c.runAndReadAll(
        `SELECT hits,visitors,epoch_us(first_epoch),epoch_us(last_epoch) FROM (${corpusSql})`,
      )).getRowsJson();
    equal(
      await corpus(),
      [["5", "5", "-1100000", "1100000"]],
      "nullable timestamp extrema and COUNT DISTINCT rewrite",
    );
    await c.run("DELETE FROM instants");
    equal(
      await corpus(),
      [["0", "0", null, null]],
      "SUM0 count rewrite preserves empty corpus",
    );
    await c.run(
      "INSERT INTO instants VALUES (1,make_timestamp(0),NULL),(1,make_timestamp(0),NULL)",
    );
    equal(
      await corpus(),
      [["2", "1", "0", null]],
      "COUNT DISTINCT preserves duplicate and all-null extrema",
    );
    evidence.push({ fixture: "timestamp_corpus", rows: await corpus() });
    await c.run(
      "DELETE FROM instants; INSERT INTO instants VALUES (1,make_timestamp(0),make_timestamp(2147483648000000))",
    );
    await refuses(() => query(c, "timestamp_math"), "out of range");
    await c.run(
      "DELETE FROM instants; INSERT INTO instants VALUES (1,'infinity',NULL)",
    );
    await refuses(
      () => query(c, "timestamp_math"),
      "finite TIMESTAMP required",
    );
    await c.run(`
      CREATE TABLE fixtures_game(id INTEGER NOT NULL, team VARCHAR, moment TIMESTAMP);
      CREATE TABLE fixtures_rating(team VARCHAR NOT NULL, moment TIMESTAMP NOT NULL, power DOUBLE NOT NULL);
      INSERT INTO fixtures_rating VALUES ('a',make_timestamp(1),2),('a',make_timestamp(1000001),3),('b',make_timestamp(1),9);
      INSERT INTO fixtures_game VALUES (1,'a',make_timestamp(0)),(2,'a',make_timestamp(1)),(3,'a',make_timestamp(1000000)),(4,'a',make_timestamp(1000001)),(5,'b',make_timestamp(1)),(6,'missing',make_timestamp(1)),(7,NULL,make_timestamp(1)),(8,'a',NULL),(2,'a',make_timestamp(1));
    `);
    const asof = await load("asof");
    const asofNode = asof.plan.result.rels.find((node) =>
      node.relOp === "LogicalAsofJoin"
    )!;
    for (
      const mutate of [
        () => {
          asofNode.matchCondition!.op!.name = ">";
        },
        () => {
          asofNode.matchCondition!.operands![0].input = 0;
        },
        () => {
          asofNode.condition!.op!.name = "OR";
        },
        () => {
          asofNode.joinType = "asof";
        },
      ]
    ) {
      const original = structuredClone(asofNode);
      mutate();
      await refuses(() => translate(asof.plan, asof.schema), "ASOF");
      Object.assign(asofNode, original);
    }
    const calendar = (await query(c, "calendar_year")).getRowsJson();
    equal(
      calendar,
      (await c.runAndReadAll(`SELECT id,
      CAST(month_start AS TIMESTAMP), CAST(history_start AS TIMESTAMP), CAST(prior_year AS TIMESTAMP)
      FROM (VALUES
        (1,'2024-02-01','2017-02-01','2023-02-28 23:59:59.999999'),
        (2,'2024-03-01','2017-03-01','2023-03-01'),
        (3,'2027-01-01','2020-01-01','2026-01-01'),
        (4,'1969-12-01','1962-12-01','1968-12-31 23:59:59.999999'),
        (5,NULL,NULL,NULL)) expected(id,month_start,history_start,prior_year)`))
        .getRowsJson(),
      "calendar month and year boundaries, null propagation and microseconds",
    );
    evidence.push({ fixture: "calendar_year", rows: calendar });
    const calendarPlan = await load("calendar_year");
    const operators: Record<string, unknown>[] = [];
    const walkCalendar = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(walkCalendar);
        return;
      }
      operators.push(value as Record<string, unknown>);
      Object.values(value).forEach(walkCalendar);
    };
    walkCalendar(calendarPlan.plan);
    for (
      const [node, replacement, reason] of [
        [
          operators.find((node) => node.literal === "MONTH")!,
          "DAY",
          "timestamp FLOOR TO MONTH",
        ],
        [
          operators.find((node) => node.literal === -84)!,
          -83,
          "exact calendar year interval",
        ],
      ] as const
    ) {
      const before = node.literal;
      node.literal = replacement;
      await refuses(
        () => translate(calendarPlan.plan, calendarPlan.schema),
        reason,
      );
      node.literal = before;
    }
    await c.run("INSERT INTO calendar_inputs VALUES (6,TIMESTAMP 'infinity')");
    await refuses(() => query(c, "calendar_year"), "finite TIMESTAMP required");
    await c.run("DELETE FROM calendar_inputs WHERE id=6");
    const measured: Record<string, unknown[][]> = {
      asof: [[1, null], [2, 2], [2, 2], [3, 2], [4, 3], [5, 9], [6, null], [
        7,
        null,
      ], [8, null]],
      dynamic_substring: [
        [1, "é😀|tail", "é😀"],
        [2, "|tail", ""],
        [3, "", ""],
        [4, null, null],
        [5, null, null],
        [6, "abc", null],
      ],
      union_values: [[1, "one"], [1, "one"], [null, null], [0, "zero"], [
        1,
        "one",
      ]],
      string_search: [
        ["day"],
        ["week"],
        ["é😀"],
      ],
      dashboard_scalars: [
        [1, "-28800", -1, "-2", 4, "abc", "is:", -1],
        [2, "0", -1, "-1", 5, "é😀z", "is:", 0],
        [3, "0", 0, "0", 1, "", "", 0],
        [4, "28800", 1, "1", 0, ":x", "not", 1],
        [5, null, null, null, null, null, null, null],
      ],
      ordinary: [
        [
          "00000000-0000-0000-0000-000000000001",
          "2024-02-29",
          "9007199254740991.01",
          1.25,
          "5",
          2.5,
          2,
          3,
        ],
        [
          "00000000-0000-0000-0000-000000000001",
          "2024-02-29",
          "9007199254740991.01",
          1.25,
          "5",
          2.5,
          2,
          3,
        ],
        [
          "00000000-0000-0000-0000-000000000002",
          null,
          null,
          null,
          null,
          null,
          0,
          0,
        ],
      ],
      extrema: [[
        1,
        1.25,
        2.75,
        2,
        "9007199254740991.01",
        "9007199254740991.02",
      ], [2, null, null, null, null, null]],
      full_join: [[1, null], [2, 2], [2, 2], [null, 3]],
      right_join: [[2, 2], [2, 2], [null, 3]],
      arithmetic: [[0, -5, -8, "9007199254740994", 1.375, -2], [
        null,
        null,
        null,
        null,
        null,
        null,
      ]],
      decimal_boundary: [["99999999999999999999.99999999"], [
        "-99999999999999999999.99999999",
      ], [null]],
      typed_case: [["2147483648"], ["1"]],
    };
    for (const [name, expected] of Object.entries(measured)) {
      const result = await query(c, name);
      const schema = (await load(name)).schema.outputs.find((r) =>
        r.name === "result"
      )!;
      equal(
        bag(result.getRowsJson()),
        bag(expected),
        `${name} independently specified rows`,
      );
      equal(
        result.columnNames(),
        schema.fields.map((f) => f.name),
        `${name} declared names`,
      );
      equal(
        result.columnTypes().map(String),
        schema.fields.map((f) => sqlType(f.columntype)),
        `${name} declared types`,
      );
      evidence.push({
        fixture: name,
        rows: result.getRowsJson(),
        types: result.columnTypes().map(String),
      });
    }
    await c.run(
      "DELETE FROM numbers; INSERT INTO numbers VALUES (2147483647,1,1)",
    );
    for (const [first, width] of [[0, 2], [-1, 2], [1, -1]]) {
      await c.run(
        `DELETE FROM substring_source; INSERT INTO substring_source VALUES (1,'abc',${first},${width})`,
      );
      await refuses(
        () => query(c, "dynamic_substring"),
        "SUBSTRING bounds outside",
      );
    }
    await refuses(() => query(c, "arithmetic"), "Overflow");
    await refuses(
      () => c.run("INSERT INTO money VALUES (100000000000000000000.00000000)"),
      "range",
    );
    await c.run(
      "DELETE FROM events; INSERT INTO events VALUES (1,make_timestamp(0),9223372036854775807),(2,make_timestamp(0),1)",
    );
    await refuses(() => query(c, "aggregate"), "out of range");
    await c.run(
      "DELETE FROM events; INSERT INTO events VALUES (1,'infinity',1)",
    );
    for (const name of ["hop", "tumble", "window_count"]) {
      await refuses(() => query(c, name), "finite TIMESTAMP required");
    }
    const typeSchema = (await load("aggregate")).schema.outputs.find((r) =>
      r.name === "result"
    )!;
    equal(
      typeSchema.fields.map((f) => f.columntype.nullable),
      [false, true],
      "COUNT/SUM nullability",
    );
    await json("results/tests.json", {
      ...tools,
      engine: version[0][0],
      comparisons: evidence.length + 2,
      rejected: refused,
      checks: [
        "quiet SUM/MIN identical exports; native results differ",
        "-v 1 restores aggregate calls",
        "optimized NOW identical to plain source",
        "unused UDF declaration identical to plain source",
        "optimized DISTINCT uses supported grouped operators",
        "emit_final retained and independently refused",
        "unsafe numeric JSON rejected before rounding",
        "noninteger numeric tokens retained verbatim for typed DOUBLE literals",
        "outer joins preserve unmatched rows and duplicate matches",
        "UUID DATE DOUBLE and DECIMAL native projection with declared types",
        "MIN MAX AVG DOUBLE groups and all-null groups",
        "DECIMAL(28,8) exact limits and overflow; invalid precision/scale rejected",
        "decimal arithmetic and narrowing casts refused",
        "bounded numeric/text VARCHAR casts refused; native widths do not constrain longer values",
        "integer arithmetic overflow fails before final projection",
        "overflow fails",
        "nonfinite timestamp fails including COUNT-only query",
        "COUNT/SUM declared nullability retained",
        "shared local-view CTEs and selected output translation",
        "timestamp arithmetic uses exact micros and signed truncation, nullable extrema, overflow and nonfinite refusal",
        "SUM0 preserves empty COUNT DISTINCT rewrite and duplicate bags",
        "positive literal integer division/modulo, negative epoch floor arithmetic, Unicode POSITION/SUBSTRING and nulls",
        "dynamic integer SUBSTRING bounds preserve nulls and Unicode; nonpositive starts and negative lengths fail",
        "sub-millisecond TIMESTAMP literals refused because stock JSON truncates them",
        "diagnostic-only LogicalWindow and calendar intervals refused",
        "stock explicit and optimizer-created aggregate FILTER refused through complete final-plan diagnostic guard",
        "missing and truncated final-plan diagnostics fail closed",
      ],
      evidence,
    });
  } finally {
    c.closeSync();
    db.closeSync();
  }
  console.log(
    "Native DuckDB relation/schema/window comparisons and stock-export refusal checks passed",
  );
}
const mode = Deno.args[0];
if (mode === "doctor") console.log(await doctor());
else if (mode === "build") await build();
else if (mode === "test") await test();
else if (mode === "extract") {
  await command("bash", ["../compiler/extract-jar.sh", jar]);
  console.log(await doctor());
} else throw new Error("Expected doctor, build, test, or extract");
