// The Pronto language type system contract, exercised where its definition is: the table these
// transformations are judged by is types.cue, so the suite that holds them
// to it lives beside the table rather than beside the code. What a holder
// proves on its own is that it applies the table it was handed; that it
// applies THIS table is provable only here.
import { type TypeField } from "./portable-types.ts"
import { boundTypes } from "./type-table.ts"

const { canonicalType, compareType, compareCarrier, electricParsers, fromProtoJSONValue, normalizeRow, normalizeValue, toProtoJSONValue } = boundTypes()
const compare = compareType ?? compareCarrier

function equal(actual: unknown, expected: unknown) {
  if (!Object.is(actual, expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function deepEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function throws(work: () => unknown) {
  let thrown = false
  try {
    work()
  } catch {
    thrown = true
  }
  if (!thrown) throw new Error("expected an error")
}

const field = (type: TypeField["type"], extras: Partial<TypeField> = {}): TypeField => ({ name: "value", type, ...extras })

Deno.test("canonical aliases retain old schema labels", () => {
  equal(canonicalType("text"), "string")
  equal(canonicalType("int"), "int32")
  equal(canonicalType("bigint"), "int64")
  equal(canonicalType("timestamptz"), "timestamp")
  equal(canonicalType("tsvector"), "string")
})

Deno.test("scalar types normalize and reject invalid values", () => {
  equal(normalizeValue(field("string"), "hello"), "hello")
  equal(normalizeValue(field("bool"), "t", "electric"), true)
  equal(normalizeValue(field("int32"), "-2147483648", "postgres"), -2147483648)
  equal(normalizeValue(field("int64"), "9223372036854775807"), "9223372036854775807")
  equal(normalizeValue(field("int64"), "-9223372036854775808"), "-9223372036854775808")
  equal(normalizeValue(field("double"), -0), 0)
  equal(normalizeValue(field("double"), "1.25e2", "electric"), 125)
  equal(normalizeValue(field("double"), "-0", "duckdb"), 0)
  equal(normalizeValue(field("uuid"), "018F2A71-0000-4000-8000-000000000000"), "018f2a71-0000-4000-8000-000000000000")
  throws(() => normalizeValue(field("string"), "has\0nul"))
  throws(() => normalizeValue(field("string"), "\ud800"))
  throws(() => normalizeValue(field("bool"), "truth"))
  throws(() => normalizeValue(field("int32"), 2_147_483_648))
  throws(() => normalizeValue(field("int64"), "9223372036854775808"))
  throws(() => normalizeValue(field("int64"), Number.MAX_SAFE_INTEGER + 2))
  throws(() => normalizeValue(field("double"), Infinity))
  throws(() => normalizeValue(field("double"), "NaN", "electric"))
  throws(() => normalizeValue(field("double"), "Infinity", "duckdb"))
  throws(() => normalizeValue(field("uuid"), "not-a-uuid"))
})

Deno.test("bytes decode PostgreSQL hex bytes rather than their ASCII spelling", () => {
  equal(normalizeValue(field("bytes"), "\\x4d", "postgres"), "TQ==")
  equal(normalizeValue(field("bytes"), "TQ=="), "TQ==")
  throws(() => normalizeValue(field("bytes"), "\\x4d"))
  throws(() => normalizeValue(field("bytes"), "TQ"))
  throws(() => normalizeValue(field("bytes"), "\\x0", "postgres"))
  throws(() => normalizeValue(field("bytes"), "\\xabc", "postgres"))
  const large = new Uint8Array(256 * 1024)
  large[0] = 1
  large[large.length - 1] = 255
  const normalized = normalizeValue(field("bytes"), large)
  equal(atob(normalized as string).length, large.length)
})

Deno.test("time types retain all microseconds without Date conversion", () => {
  equal(normalizeValue(field("timestamp"), "0001-01-01T00:00:00.000001Z"), "0001-01-01T00:00:00.000001Z")
  equal(normalizeValue(field("timestamp"), "2026-09-21 10:00:00.5+00", "postgres"), "2026-09-21T10:00:00.500000Z")
  equal(normalizeValue(field("timestamp"), "2026-01-01T00:30:00+01:00"), "2025-12-31T23:30:00.000000Z")
  equal(normalizeValue(field("date"), "2024-02-29"), "2024-02-29")
  equal(normalizeValue(field("time"), "23:59:59.1"), "23:59:59.100000")
  equal(normalizeValue(field("timezone"), "America/Sao_Paulo"), "America/Sao_Paulo")
  equal(normalizeValue(field("timezone"), "America/Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires")
  throws(() => normalizeValue(field("timestamp"), "2026-01-01T00:00:00.0000001Z"))
  throws(() => normalizeValue(field("timestamp"), "0001-01-01T00:00:00+01:00"))
  throws(() => normalizeValue(field("date"), "2023-02-29"))
  throws(() => normalizeValue(field("time"), "24:00:00"))
  throws(() => normalizeValue(field("timezone"), "+01:00"))
})

Deno.test("duration has one bounded total-seconds form across sources", () => {
  equal(normalizeValue(field("duration"), "01:30:00", "postgres"), "PT5400S")
  equal(normalizeValue(field("duration"), "PT1H30M", "electric"), "PT5400S")
  equal(fromProtoJSONValue(field("duration"), "5400.123456s"), "PT5400.123456S")
  equal(toProtoJSONValue(field("duration"), "PT1.50S"), "1.5s")
  throws(() => normalizeValue(field("duration"), "P1D", "electric"))
  throws(() => normalizeValue(field("duration"), "PT315576000001S"))
})

Deno.test("decimal expands exponent exactly and enforces its field profile", () => {
  const decimal = field("decimal", { precision: 5, scale: 2 })
  equal(normalizeValue(decimal, "001.2300e1"), "12.3")
  equal(normalizeValue(decimal, "-0.00"), "0")
  throws(() => normalizeValue(decimal, "999.999"))
  throws(() => normalizeValue(decimal, "1000"))
  throws(() => normalizeValue(decimal, 1.25))
  throws(() => normalizeValue(field("decimal"), "1"))
})

Deno.test("json and geojson contain actual safe JSON values", () => {
  deepEqual(normalizeValue(field("json"), { zero: -0, list: [true, null] }), { zero: 0, list: [true, null] })
  const specialKey = normalizeValue(field("json"), JSON.parse('{"__proto__":{"kept":true}}')) as Record<string, unknown>
  if (!Object.hasOwn(specialKey, "__proto__")) throw new Error("json lost an own __proto__ key")
  deepEqual(normalizeValue(field("geojson"), {
    type: "Feature",
    properties: { name: "origin" },
    geometry: { type: "Point", coordinates: [0, 0] },
  }), {
    type: "Feature",
    properties: { name: "origin" },
    geometry: { type: "Point", coordinates: [0, 0] },
  })
  throws(() => normalizeValue(field("json"), { value: NaN }))
  throws(() => normalizeValue(field("geojson"), { type: "Point", coordinates: [181, 0] }))
  throws(() => normalizeValue(field("geojson"), { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }))
})

Deno.test("serialized JSON from a transport is decoded once without losing values", () => {
  const json = { name: "meta", type: "json" as const }
  deepEqual(normalizeValue(json, '{"enabled":true}', "electric"), { enabled: true })
  deepEqual(normalizeValue(json, '{"enabled":true}', "duckdb"), { enabled: true })
  equal(normalizeValue(json, '"meta"', "electric"), "meta")
  equal(normalizeValue(json, '"meta"'), '"meta"')
  deepEqual(normalizeValue(json, '{"fraction":0.1,"large":1e30}', "electric"), { fraction: 0.1, large: 1e30 })
  deepEqual(normalizeValue(field("geojson"), '{"type":"Point","coordinates":[0.1,0]}', "duckdb"), { type: "Point", coordinates: [0.1, 0] })
  const specialKey = normalizeValue(json, '{"__proto__":{"kept":true}}', "duckdb") as Record<string, unknown>
  if (!Object.hasOwn(specialKey, "__proto__")) throw new Error("transport json lost an own __proto__ key")
})

Deno.test("serialized transport JSON rejects lossy and ambiguous encodings before parsing", () => {
  const json = field("json")
  throws(() => normalizeValue(json, "9007199254740993", "electric"))
  throws(() => normalizeValue(json, '{"nested":[1e400]}', "duckdb"))
  throws(() => normalizeValue(json, '{"value":1.0000000000000001}', "electric"))
  throws(() => normalizeValue(json, '{"same":1,"same":2}', "duckdb"))
  throws(() => normalizeValue(json, '{"same":1,"\\u0073ame":2}', "electric"))
  throws(() => normalizeValue(json, '{"outer":{"same":1,"same":2}}', "electric"))
  throws(() => normalizeValue(json, '"\\u0000"', "electric"))
  throws(() => normalizeValue(json, '"\\ud800"', "duckdb"))
})

Deno.test("row normalization keeps partial-update absence, nulls, and platform keys", () => {
  const fields: TypeField[] = [field("int64"), { name: "name", type: "string" }]
  deepEqual(normalizeRow(fields, { value: null, platform_txid: 7 }, "electric"), { value: null, platform_txid: 7 })
  deepEqual(normalizeRow(fields, { name: "ok", platform_txid: 7 }, "electric"), { name: "ok", platform_txid: 7 })
  deepEqual(normalizeRow([{ name: "legacy", type: "bigint" }], { legacy: "not-an-int" }, "electric"), { legacy: "not-an-int" })
})

Deno.test("proto JSON and Electric parsers use type-specific normalizers", () => {
  const decimal = field("decimal", { precision: 5, scale: 2 })
  equal(fromProtoJSONValue(field("int64"), "9007199254740993"), "9007199254740993")
  equal(toProtoJSONValue(field("bytes"), "TQ=="), "TQ==")
  equal(toProtoJSONValue(field("duration"), null), null)
  const parsers = electricParsers([field("int64"), decimal])
  equal(parsers.int8("9007199254740993"), "9007199254740993")
  equal(parsers.portable_decimal_5_2("1.20"), "1.2")
})

Deno.test("compare orders values where their canonical strings do not", () => {
  equal(compare(field("int64"), "9", "10"), -1)
  equal(compare(field("int64"), "9223372036854775807", "9223372036854775806"), 1)
  equal(compare(field("int32"), 9, "10"), -1)
  equal(compare(field("double"), -0.5, "0"), -1)
  equal(compare(field("duration"), "PT90S", "PT100S"), -1)
  equal(compare(field("duration"), "PT5400S", "PT1H30M"), 0)
  equal(compare(field("decimal", { precision: 18, scale: 2 }), "9.5", "10"), -1)
  equal(compare(field("decimal", { precision: 18, scale: 2 }), "-10", "-9.99"), -1)
  equal(compare(field("decimal", { precision: 18, scale: 2 }), "1.50", "1.5"), 0)
  equal(compare(field("decimal", { precision: 18, scale: 2 }), "0", "-0"), 0)
  equal(compare(field("bool"), false, true), -1)
  equal(compare(field("timestamp"), "2026-09-21T10:00:00.500000Z", "2026-09-21T10:00:00Z"), 1)
  equal(compare(field("date"), "2026-02-28", "2026-10-01"), -1)
  // UTF-16 code units, not code points: U+FF61 sorts after U+1F600 here and
  // before it by code point. The view engine compares with a plain `<`
  // (db-ivm's compareKeys), and a maintained view disagreeing with the
  // snapshot the same region falls back to is the defect this pins.
  equal(compare(field("string"), "｡", "\u{1f600}"), 1)
  throws(() => compare(field("json"), "{}", "[]"))
  throws(() => compare(field("int64"), "1.5", "2"))
})
