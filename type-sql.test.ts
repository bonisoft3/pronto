import { TYPE_SQL, generateTypeSQL } from "./type-sql.ts";
import { typeTable } from "./type-table.ts";

function match(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`expected ${pattern} in generated SQL`);
}

function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function throws(run: () => unknown, pattern: RegExp): void {
  try {
    run();
  } catch (error) {
    if (pattern.test(String(error))) return;
    throw error;
  }
  throw new Error("expected generator to throw");
}

Deno.test("type migration defines a representation for every domain type", () => {
  const sql = generateTypeSQL();
  for (const type of ["int64", "bytes", "timestamp", "time", "duration"]) {
    match(sql, new RegExp(`CREATE DOMAIN public\\.portable_${type} AS`));
    // OR REPLACE, so a corrected representation reaches a database that already
    // holds the old one. The domain above cannot say it — see type-sql.ts.
    match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.portable_${type}_from_json`));
    match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.portable_${type}_from_text`));
    match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.portable_${type}_to_json`));
  }
  match(sql, /CREATE CAST \(json AS public\.portable_int64\)/);
  match(sql, /CREATE CAST \(text AS public\.portable_timestamp\)/);
  match(sql, /\^PT\(0\|\[1-9\]\[0-9\]\*\)/);
});

Deno.test("decimal profiles are bounded, unique, and emitted deterministically", () => {
  const sql = generateTypeSQL([{ precision: 18, scale: 6 }, { precision: 18, scale: 2 }]);
  match(sql, /CREATE DOMAIN public\.portable_decimal_18_2 AS numeric/);
  match(sql, /CREATE DOMAIN public\.portable_decimal_18_6 AS numeric/);
  if (!(sql.indexOf("portable_decimal_18_2") < sql.indexOf("portable_decimal_18_6"))) throw new Error("profiles were not sorted");
  match(sql, /portable_decimal_valid\(VALUE, 18, 6\)/);
  throws(() => generateTypeSQL([{ precision: 39, scale: 2 }]), /precision/);
  equal((generateTypeSQL([{ precision: 18, scale: 2 }, { precision: 18, scale: 2 }]).match(/CREATE DOMAIN public\.portable_decimal_18_2/g) ?? []).length, 1);
});

Deno.test("base source keeps the boundary hazards explicit", () => {
  match(TYPE_SQL, /portable_base64/);
  match(TYPE_SQL, /portable_double_valid/);
  match(TYPE_SQL, /value <> 'NaN'::double precision/);
  match(TYPE_SQL, /portable_reject\(message text\)[\s\S]*?VOLATILE/);
  match(TYPE_SQL, /portable_geojson_valid/);
  match(TYPE_SQL, /VALUE IS NULL OR COALESCE/);
  match(TYPE_SQL, /extract\(year FROM value\) = 0/);
  match(TYPE_SQL, /\[0-5\]\[0-9\]/);
  match(TYPE_SQL, /315576000000/);
  match(TYPE_SQL, /\[0-9\]\{6\}/);
});

// A domain is what PostgREST's representation functions hang on, and it is
// opaque to Electric's where clause, so the table says which types have one
// and this holds the migration to it in both directions: a domain the table
// does not name would be a column type no reader expects.
Deno.test("a type has a domain exactly when the table says it does", () => {
  const table = typeTable();
  const domains = new Set([...TYPE_SQL.matchAll(/CREATE DOMAIN public\.(\w+) AS /g)].map((m) => m[1]));
  for (const [name, entry] of Object.entries(table.types)) {
    if (entry.column !== "domain") {
      equal(entry.sql, undefined);
      if (domains.has(`portable_${name}`)) throw new Error(`${name} is ${entry.column}, and 004_types.sql still makes it a domain`);
      continue;
    }
    // decimal is the one parameterized type, so it names no domain and its
    // per-profile ones are generated beside the base source.
    if (entry.sql === undefined) {
      equal(name, "decimal");
      match(generateTypeSQL([{ precision: 18, scale: 2 }]), /CREATE DOMAIN public\.portable_decimal_18_2 AS numeric/);
      continue;
    }
    if (!domains.delete(entry.sql)) throw new Error(`${name} names domain ${entry.sql}, which 004_types.sql does not create`);
  }
  equal([...domains].join(","), "");
});

// emit.cue's column CHECK calls public.portable_<type>_valid on the column's
// base type, so each checked type needs exactly that function over its `pg`.
Deno.test("every checked type has the predicate its column CHECK calls", () => {
  const table = typeTable();
  for (const [name, entry] of Object.entries(table.types)) {
    if (entry.column !== "checked") continue;
    const pg = entry.pg.replace(/\(.*\)$/, "").replace(/ /g, "\\s+");
    match(TYPE_SQL, new RegExp(`CREATE OR REPLACE FUNCTION public\\.portable_${name}_valid\\(value ${pg}\\)\\s+RETURNS boolean`));
  }
});

// PostgreSQL is a holder too, and it states the spelling in its own language:
// a regex inside a domain's representation function, beside a cast that
// refuses what no regex can (a calendar day, a year Postgres has no zero for).
// Where the two say the same thing they say it in the same characters, and
// this holds them there. The rest — timestamp and time — carry a looser
// pre-filter with the cast behind it, and what they accept is held to the
// table by type-sql.integration.test.ts, against a running database.
//
// The generator does not read the table: its output is a migration each app
// has committed and applied, so a tightened pattern is a new migration rather
// than a rewrite of one already run.
Deno.test("the domains spell the patterns the table states, where they state the same one", () => {
  const table = typeTable();
  for (const name of ["duration", "int64"]) {
    const pattern = table.types[name].pattern;
    if (pattern === undefined) throw new Error(`${name} states no pattern`);
    if (!TYPE_SQL.includes(pattern)) throw new Error(`${name}: the table spells ${pattern}, which the domains do not`);
  }
});
