// cdc-types.blobl, run by the transform image the cluster pins, over the bus
// spellings conduit v0.14.0 was measured to produce: Postgres text for a
// domain column (2026-09-22, ponto, realworld and thenote stacks), and native
// JSON for a base-typed one (2026-10-03, a logrepl pipeline over int4, bool,
// float8, uuid, date and text columns). Conduit decodes a column whose type it
// knows and passes a domain, whose OID it does not, through as text.

import { typeTable } from "./type-table.ts";

const CLUSTER = new URL("../../libraries/mecha/cluster.cue", import.meta.url);
const ASSET = new URL("./assets/cdc-types.blobl", import.meta.url);

function fail(message: string): never {
  throw new Error(message);
}

const IMAGE = (await Deno.readTextFile(CLUSTER)).match(/"(redpandadata\/connect:[^"@]+@sha256:[0-9a-f]{64})"/)?.[1] ??
  fail("cluster.cue pins no redpandadata/connect image");

const types = {
  t: {
    ts: "timestamp", d: "duration", n: "int32", b: "int64", x: "decimal", ok: "bool",
    day: "date", u: "uuid", tm: "time", f: "double", s: "string",
  },
  g: { blob: "bytes" },
};
const carriers = types;

type Row = Record<string, unknown>;
const bus = (row: Row) => JSON.stringify({ data: JSON.stringify(row) });

const cases: { name: string; row: Row; want: Row | string }[] = [
  {
    name: "conduit's measured spellings",
    row: {
      __table: "t", ts: "2026-09-22 14:18:21.84623+00", d: "08:00:00", n: 1, b: "9007199254740993",
      x: "37.10", ok: true, day: "2031-03-19T00:00:00Z", u: "98bdd8ed-cccc-44c2-820c-11236fa5f63e", tm: "14:18:21.5",
      f: 1.5, s: "x", txid: 978, search: "'a':1",
    },
    want: {
      __table: "t", ts: "2026-09-22T14:18:21.846230Z", d: "PT28800S", n: 1, b: "9007199254740993",
      x: "37.1", ok: true, day: "2031-03-19", u: "98bdd8ed-cccc-44c2-820c-11236fa5f63e", tm: "14:18:21.500000",
      f: 1.5, s: "x", txid: 978, search: "'a':1",
    },
  },
  {
    name: "whole seconds, hours past a day, negative zero, extremes, nulls",
    row: {
      __table: "t", ts: "2026-09-22 14:18:23+00", d: "25:00:00.500000", n: -2147483648, b: "0", x: "-0.00", ok: false,
      day: "0001-01-01T00:00:00Z", u: null, tm: "00:00:00", f: 1e+300, s: "", txid: 979,
    },
    want: {
      __table: "t", ts: "2026-09-22T14:18:23.000000Z", d: "PT90000.5S", n: -2147483648, b: "0", x: "0", ok: false,
      day: "0001-01-01", u: null, tm: "00:00:00.000000", f: 1e+300, s: "", txid: 979,
    },
  },
  { name: "a table the map does not name", row: { __table: "other", at: "2026-09-22 14:18:23+00" }, want: { __table: "other", at: "2026-09-22 14:18:23+00" } },
  { name: "a duration with a day part", row: { __table: "t", d: "1 day 02:00:00" }, want: "duration is not clock text" },
  // An int64 is a domain, spelled as text. A JSON number is a spelling nobody
  // measured, and past 2^53 it would already have lost digits.
  { name: "an int64 as a JSON number", row: { __table: "t", b: 9007199254740993 }, want: "integer is not decimal text" },
  // A base-typed column's spelling is the native one; the text a domain had
  // is now a spelling nobody measured.
  { name: "a bool as Postgres text", row: { __table: "t", ok: "t" }, want: "bool is not a JSON boolean" },
  { name: "an int32 as Postgres text", row: { __table: "t", n: "1" }, want: "int32 is not a JSON integer" },
  { name: "an int32 with a fraction", row: { __table: "t", n: 1.5 }, want: "int32 is not a JSON integer" },
  { name: "a double as Postgres text", row: { __table: "t", f: "1.5" }, want: "double is not a JSON number" },
  { name: "a date as Postgres text", row: { __table: "t", day: "2031-03-19" }, want: "date is not RFC 3339 midnight UTC" },
  { name: "an uppercase uuid", row: { __table: "t", u: "98BDD8ED-CCCC-44C2-820C-11236FA5F63E" }, want: "uuid is not lowercase" },
  { name: "a row with no table stamp", row: { n: 1 }, want: "conduit stamped __table" },
  { name: "a type with no measured bus spelling", row: { __table: "g", blob: "\\x00ff" }, want: "no measured bus spelling for bytes" },
];

// The bus is the third holder that converts — the client and the domains are
// the others — so what it produces is held to the same statement they are:
// every value this file expects is one the program's pattern admits.
Deno.test("the expected rows are canonical by the table's own reading", () => {
  const table = typeTable();
  const wrong: string[] = [];
  for (const { name, want } of cases) {
    if (typeof want === "string") continue;
    for (const [column, value] of Object.entries(want)) {
      const typeName = (types as Record<string, Record<string, string>>)[String(want.__table)]?.[column];
      const entry = typeName === undefined ? undefined : table.types[typeName];
      if (entry?.pattern === undefined || value === null) continue;
      if (!new RegExp(entry.pattern).test(String(value))) wrong.push(`${name}: ${column} is ${JSON.stringify(value)}, which ${typeName} does not admit`);
    }
  }
  if (wrong.length > 0) fail(wrong.join("\n"));
});

// What the asset dispatches on, against what the emitter refuses an app for
// (_busTypes). A type added to the asset and not there is refused at
// build though the bus handles it; the reverse wedges a table at runtime,
// which is the whole reason the emitter refuses anything.
Deno.test("the asset handles exactly the types the emitter admits", async () => {
  const dispatch = [...(await Deno.readTextFile(ASSET)).matchAll(/this\.type == "([a-z0-9]+)"/g)].map((m) => m[1]);
  const exported = new Deno.Command("cue", {
    args: ["export", ".", "-e", "_busTypes"],
    cwd: new URL(".", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!exported.success) fail(`cue export of _busTypes failed: ${new TextDecoder().decode(exported.stderr).trim()}`);
  const admitted: string[] = JSON.parse(new TextDecoder().decode(exported.stdout));
  const shown = (names: string[]) => [...names].sort().join(", ");
  if (shown(dispatch) !== shown(admitted)) fail(`the asset handles ${shown(dispatch)}; the emitter admits ${shown(admitted)}`);
});

Deno.test({ name: "cdc-types.blobl converts conduit's spellings into canonical form", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const scratch = await Deno.makeTempDir({ prefix: "pronto-cdc-types-" });
  try {
    const mapping = `let carriers = ${JSON.stringify(carriers)}\n${await Deno.readTextFile(ASSET)}`;
    // One message per case, each tagged so the output order does not matter.
    const config = {
      input: { stdin: {} },
      pipeline: {
        processors: [
          { mapping: "meta case = this.case\nroot = this.event" },
          { bloblang: mapping },
          { catch: [{ mapping: 'root = {"error": error()}' }] },
          { mapping: 'root = {"case": @case, "out": this}' },
        ],
      },
      output: { stdout: {} },
      logger: { level: "ERROR" },
    };
    await Deno.writeTextFile(`${scratch}/config.json`, JSON.stringify(config));
    const input = cases.map((c, i) => JSON.stringify({ case: i, event: JSON.parse(bus(c.row)) })).join("\n") + "\n";
    const child = new Deno.Command("docker", {
      args: ["run", "--rm", "-i", "-v", `${scratch}:/w:ro`, "--entrypoint", "/redpanda-connect", IMAGE, "run", "/w/config.json"],
      stdin: "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const result = await child.output();
    if (!result.success) fail(`redpanda-connect: ${new TextDecoder().decode(result.stderr)}`);
    const outs = new TextDecoder().decode(result.stdout).trim().split("\n").map((l) => JSON.parse(l));
    if (outs.length !== cases.length) fail(`${outs.length} messages out for ${cases.length} in`);
    const wrong: string[] = [];
    for (const { case: i, out } of outs) {
      const c = cases[Number(i)];
      if (typeof c.want === "string") {
        if (!String(out.error ?? "").includes(c.want)) wrong.push(`${c.name}: wanted a refusal naming "${c.want}", got ${JSON.stringify(out)}`);
      } else if (out.error !== undefined) {
        wrong.push(`${c.name}: refused: ${out.error}`);
      } else {
        const got = JSON.parse(out.data);
        if (JSON.stringify(got, Object.keys(got).sort()) !== JSON.stringify(c.want, Object.keys(c.want).sort())) {
          wrong.push(`${c.name}: got ${JSON.stringify(got)}`);
        }
      }
    }
    if (wrong.length > 0) fail(wrong.join("\n"));
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
} });
