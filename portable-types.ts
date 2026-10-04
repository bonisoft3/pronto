/** Portable, bounded values: the types a type table may name. */
export type PortableType =
  | "string"
  | "bool"
  | "int32"
  | "int64"
  | "double"
  | "bytes"
  | "uuid"
  | "timestamp"
  | "date"
  | "time"
  | "timezone"
  | "duration"
  | "decimal"
  | "json"
  | "geojson"

export type CarrierType = PortableType

export type TypeSource = "canonical" | "postgres" | "electric" | "duckdb" | "protojson"
export type CarrierSource = TypeSource

export type TypeField = {
  name: string
  type: PortableType | "text" | "int" | "bigint" | "timestamptz" | "tsvector"
  required?: boolean
  precision?: number
  scale?: number
}
export type CarrierField = TypeField

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** How two canonical values of one type compare. */
export type TypeOrder = "text" | "number" | "boolean" | "integer" | "decimal" | "duration" | "none"
export type CarrierOrder = TypeOrder

/**
 * What a type's pattern cannot say, by name. Every name is one this client
 * runs: a table naming another is refused whole, because the alternative is a
 * check the program states and nothing performs.
 */
export type TypeCheck =
  | "calendar"
  | "int64-range"
  | "duration-range"
  | "tzdb"
  | "decimal-profile"
  | "scalar-values"
  | "finite-numbers"
  | "ring-closure"
export type CarrierCheck = TypeCheck

/** One type entry, as the caller's type table states it. */
export type TypeEntry = {
  /** The PostgreSQL type a column of it is built over. */
  pg: string
  /** A PostgreSQL domain, a base column under a CHECK, or a bare base column. */
  column: "domain" | "checked" | "plain"
  /** Whether Electric's where-clause evaluator compares a column of it. */
  subset: boolean
  sql?: string
  base: string[]
  json: "string" | "number" | "boolean" | "value"
  pattern?: string
  refuse?: string
  min?: number
  max?: number
  order: TypeOrder
  beyond: TypeCheck[]
}
export type CarrierEntry = TypeEntry

/**
 * The type table a holder is handed, and the only statement of what
 * canonical is. This client writes the transformations a transport needs —
 * Electric spells an interval `PT30M`, PostgreSQL spells it `08:00:00` — and
 * judges every result by the entry rather than by a rule of its own.
 */
export type TypeTable = {
  types: Record<string, TypeEntry>
  aliases: Record<string, string>
}
export type CarrierTable = TypeTable

const MAX_DURATION_MICROS = 315_576_000_000_000_000n
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n

function fail(message: string): never {
  throw new TypeError(`invalid type value: ${message}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`)
  return value as Record<string, unknown>
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`)
  return value
}

/** Negative zero is one value spelled twice, so the type system keeps one. */
function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number") fail(`${label} must be a number`)
  return Object.is(value, -0) ? 0 : value
}

function transportDouble(value: unknown, source: TypeSource): number {
  if (typeof value !== "string" || (source !== "electric" && source !== "duckdb")) return asNumber(value, "double")
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(value)) fail("double transport value is not a number")
  return asNumber(Number(value), "double")
}

function integer(value: unknown, label: string): number {
  const numberValue = typeof value === "string" ? Number(value) : value
  if (typeof numberValue !== "number" || !Number.isInteger(numberValue)) fail(`${label} must be a whole number`)
  if (typeof value === "string" && !/^-?\d+$/.test(value)) fail(`${label} is not an integer`)
  return Object.is(numberValue, -0) ? 0 : numberValue
}

function canonicalInteger(value: unknown, label: string): string {
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value).toString()
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value).toString()
  return fail(`${label} must be an exact integer`)
}

function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  return [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

function calendarDay(year: number, month: number, day: number): boolean {
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

// Read before the "calendar" check rather than by it: a day the calendar does
// not have still converts — 30 February is 2 March once a zone is applied — so
// admitting one here would canonicalize it into a different day.
function dateParts(value: string, label: string): [number, number, number] {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!found) fail(`${label} must be YYYY-MM-DD`)
  const year = Number(found[1]), month = Number(found[2]), day = Number(found[3])
  if (!calendarDay(year, month, day)) fail(`${label} is not a calendar date`)
  return [year, month, day]
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function dayNumber(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(adjustedYear / 400)
  const yoe = adjustedYear - era * 400
  const mp = month + (month > 2 ? -3 : 9)
  return era * 146097 + Math.floor((153 * mp + 2) / 5) + day - 1 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) - 719468
}

function fromDayNumber(day: number): [number, number, number] {
  const z = day + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const year = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const dayOfMonth = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp + (mp < 10 ? 3 : -9)
  return [year + (month <= 2 ? 1 : 0), month, dayOfMonth]
}

function timeParts(value: string, label: string): [number, number, number, number] {
  const found = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value)
  if (!found) fail(`${label} must be HH:mm:ss[.ffffff]`)
  const hours = Number(found[1]), minutes = Number(found[2]), seconds = Number(found[3])
  if (hours > 23 || minutes > 59 || seconds > 59) fail(`${label} is outside one day`)
  const fraction = found[4] ?? ""
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) fail(`${label} exceeds microsecond precision`)
  return [hours, minutes, seconds, Number(fraction.slice(0, 6).padEnd(6, "0"))]
}

function formatTime(hours: number, minutes: number, seconds: number, micros: number): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(micros).padStart(6, "0")}`
}

function timestamp(value: unknown): string {
  const text = asString(value, "timestamp")
  const found = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(text)
  if (!found) fail("timestamp must include a UTC offset")
  let [year, month, day] = dateParts(found[1], "timestamp date")
  const [hours, minutes, seconds, micros] = timeParts(found[2], "timestamp time")
  const zone = found[3]
  let offset = 0
  if (zone !== "Z") {
    const direction = zone[0] === "+" ? 1 : -1
    const pieces = /^[-+](\d{2})(?::?(\d{2}))?$/.exec(zone)!
    const offsetHours = Number(pieces[1]), offsetMinutes = Number(pieces[2] ?? "0")
    if (offsetHours > 23 || offsetMinutes > 59) fail("timestamp has an invalid UTC offset")
    offset = direction * (offsetHours * 60 + offsetMinutes)
  }
  let totalSeconds = hours * 3600 + minutes * 60 + seconds - offset * 60
  const dayShift = Math.floor(totalSeconds / 86400)
  totalSeconds -= dayShift * 86400
  ;[year, month, day] = fromDayNumber(dayNumber(year, month, day) + dayShift)
  if (year < 1 || year > 9999) fail("timestamp is outside year 0001..9999 after UTC conversion")
  return `${formatDate(year, month, day)}T${formatTime(Math.floor(totalSeconds / 3600), Math.floor(totalSeconds / 60) % 60, totalSeconds % 60, micros)}Z`
}

function canonicalDate(value: unknown): string {
  const text = asString(value, "date")
  const [year, month, day] = dateParts(text, "date")
  return formatDate(year, month, day)
}

function canonicalTime(value: unknown): string {
  const [hours, minutes, seconds, micros] = timeParts(asString(value, "time"), "time")
  return formatTime(hours, minutes, seconds, micros)
}

function tzdbName(text: string): boolean {
  if (/^(?:[+-]|UTC[+-]|GMT[+-])/.test(text)) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: text })
    return true
  } catch {
    return false
  }
}

function formatDuration(micros: bigint): string {
  const seconds = micros / 1_000_000n
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return `PT${seconds}${fraction ? `.${fraction}` : ""}S`
}

function durationMicros(text: string): bigint {
  let found = /^PT(\d+)(?:\.(\d+))?S$/i.exec(text)
  if (found) {
    const fraction = found[2] ?? ""
    if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) fail("duration exceeds microsecond precision")
    return BigInt(found[1]) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0") || "0")
  }
  found = /^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text)
  if (found) {
    const hours = BigInt(found[1] ?? "0"), minutes = Number(found[2]), seconds = Number(found[3]), fraction = found[4] ?? ""
    if (minutes > 59 || seconds > 59) fail("duration clock value is invalid")
    if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) fail("duration exceeds microsecond precision")
    return (hours * 3600n + BigInt(minutes * 60 + seconds)) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0") || "0")
  }
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(text)
  if (!iso || (!iso[1] && !iso[2] && !iso[3])) fail("duration must contain total seconds, clock time, or PT hours/minutes/seconds")
  const parse = (part: string | undefined, multiplier: bigint) => {
    if (!part) return 0n
    const [whole, fraction = ""] = part.split(".")
    if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) fail("duration exceeds microsecond precision")
    return BigInt(whole) * multiplier * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0") || "0") * multiplier
  }
  return parse(iso[1], 3600n) + parse(iso[2], 60n) + parse(iso[3], 1n)
}

function canonicalDuration(value: unknown, source: TypeSource): string {
  const text = asString(value, "duration")
  const proto = source === "protojson" && /s$/.test(text) ? `PT${text.slice(0, -1)}S` : text
  return formatDuration(durationMicros(proto))
}

function decimalParts(text: string): { negative: boolean; integer: string; fraction: string } {
  const found = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!found) fail("decimal is not a number")
  const exponent = Number(found[5] ?? "0")
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) fail("decimal exponent is too large")
  const digits = (found[2] ?? "") + (found[3] ?? found[4] ?? "")
  const point = (found[2] ?? "").length + exponent
  let integer: string, fraction: string
  if (point <= 0) {
    integer = "0"
    fraction = "0".repeat(-point) + digits
  } else if (point >= digits.length) {
    integer = digits + "0".repeat(point - digits.length)
    fraction = ""
  } else {
    integer = digits.slice(0, point)
    fraction = digits.slice(point)
  }
  integer = integer.replace(/^0+(?=\d)/, "") || "0"
  fraction = fraction.replace(/0+$/, "")
  return { negative: found[1] === "-", integer, fraction }
}

function canonicalDecimal(value: unknown): string {
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value))) fail("decimal number input is not exact; use a string")
  if (typeof value !== "string" && typeof value !== "number") fail("decimal must be a string or safe integer")
  const { negative, integer, fraction } = decimalParts(String(value))
  const rendered = `${integer}${fraction ? `.${fraction}` : ""}`
  return rendered === "0" ? "0" : `${negative ? "-" : ""}${rendered}`
}

function bytes(value: unknown, source: TypeSource, base64: RegExp): string {
  if (value instanceof Uint8Array) {
    const chunks: string[] = []
    for (let start = 0; start < value.length; start += 0x8000) chunks.push(String.fromCharCode(...value.subarray(start, start + 0x8000)))
    return btoa(chunks.join(""))
  }
  const text = asString(value, "bytes")
  if (source !== "canonical" && source !== "protojson" && /^\\x[0-9a-fA-F]*$/.test(text)) {
    const hex = text.slice(2)
    if (hex.length % 2 !== 0) fail("bytes hex must contain whole bytes")
    return btoa(Array.from({ length: hex.length / 2 }, (_, index) => String.fromCharCode(Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))).join(""))
  }
  if (!base64.test(text)) fail("bytes must be padded base64")
  try {
    return btoa(atob(text))
  } catch {
    fail("bytes must be base64")
  }
}

function jsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return asNumber(value, "json number")
  if (typeof value === "string") return asString(value, "json string")
  if (typeof value !== "object") fail("json must contain only JSON values")
  if (ancestors.has(value)) fail("json cannot be cyclic")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => jsonValue(item, ancestors))
    const object = record(value, "json")
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [asString(key, "json key"), jsonValue(item, ancestors)]))
  } finally {
    ancestors.delete(value)
  }
}

function normalizedJsonDecimal(token: string): string {
  const found = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (!found) fail("transport json number is malformed")
  const digits = `${found[2]}${found[3] ?? ""}`.replace(/^0+/, "")
  if (!digits) return "0"
  const significant = digits.replace(/0+$/, "")
  const trailingZeros = digits.length - significant.length
  const exponent = BigInt(found[4] ?? "0") - BigInt((found[3] ?? "").length) + BigInt(trailingZeros)
  return `${found[1]}${significant}e${exponent}`
}

class TransportJsonScanner {
  #index = 0

  constructor(readonly text: string) {}

  scan(): void {
    this.whitespace()
    this.value()
    this.whitespace()
    if (this.#index !== this.text.length) fail("transport json is malformed")
  }

  private whitespace(): void {
    while (this.text[this.#index] === " " || this.text[this.#index] === "\n" || this.text[this.#index] === "\r" || this.text[this.#index] === "\t") this.#index++
  }

  private value(): void {
    switch (this.text[this.#index]) {
      case "{": return this.object()
      case "[": return this.array()
      case "\"": this.string(); return
      case "t": return this.literal("true")
      case "f": return this.literal("false")
      case "n": return this.literal("null")
      default: return this.number()
    }
  }

  private object(): void {
    this.#index++
    this.whitespace()
    const keys = new Set<string>()
    if (this.text[this.#index] === "}") {
      this.#index++
      return
    }
    while (true) {
      if (this.text[this.#index] !== "\"") fail("transport json object key is malformed")
      const key = this.string()
      if (keys.has(key)) fail("transport json contains a duplicate object key")
      keys.add(key)
      this.whitespace()
      if (this.text[this.#index++] !== ":") fail("transport json object is malformed")
      this.whitespace()
      this.value()
      this.whitespace()
      const separator = this.text[this.#index++]
      if (separator === "}") return
      if (separator !== ",") fail("transport json object is malformed")
      this.whitespace()
    }
  }

  private array(): void {
    this.#index++
    this.whitespace()
    if (this.text[this.#index] === "]") {
      this.#index++
      return
    }
    while (true) {
      this.value()
      this.whitespace()
      const separator = this.text[this.#index++]
      if (separator === "]") return
      if (separator !== ",") fail("transport json array is malformed")
      this.whitespace()
    }
  }

  private string(): string {
    const start = this.#index++
    while (this.#index < this.text.length) {
      const code = this.text.charCodeAt(this.#index++)
      if (code === 0x22) return asString(JSON.parse(this.text.slice(start, this.#index)), "transport json string")
      if (code <= 0x1f) fail("transport json string is malformed")
      if (code !== 0x5c) continue
      const escape = this.text[this.#index++]
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.#index, this.#index + 4))) fail("transport json string is malformed")
        this.#index += 4
      } else if (!"\"\\/bfnrt".includes(escape)) {
        fail("transport json string is malformed")
      }
    }
    fail("transport json string is malformed")
  }

  private literal(literal: string): void {
    if (!this.text.startsWith(literal, this.#index)) fail("transport json is malformed")
    this.#index += literal.length
  }

  private number(): void {
    const found = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
    found.lastIndex = this.#index
    const token = found.exec(this.text)?.[0]
    if (!token) fail("transport json number is malformed")
    this.#index += token.length
    const parsed = Number(token)
    if (!Number.isFinite(parsed) || normalizedJsonDecimal(token) !== normalizedJsonDecimal(parsed.toString())) fail("transport json number is not lossless")
  }
}

function transportJson(value: string, source: "duckdb" | "electric"): JsonValue {
  asString(value, `${source} json`)
  new TransportJsonScanner(value).scan()
  return JSON.parse(value) as JsonValue
}

function sourceJson(value: unknown, source: TypeSource): JsonValue {
  if ((source === "duckdb" || source === "electric") && typeof value === "string") {
    return jsonValue(transportJson(value, source))
  }
  return jsonValue(value)
}

function position(value: unknown): void {
  if (!Array.isArray(value) || value.length < 2 || !value.every((part) => typeof part === "number" && Number.isFinite(part))) fail("geojson position must contain finite longitude and latitude")
  if (value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) fail("geojson longitude or latitude is out of range")
}

function positions(value: unknown, minimum: number, rings = false): void {
  if (!Array.isArray(value) || value.length < minimum) fail("geojson coordinate array is too short")
  for (const item of value) rings ? positions(item, 4, false) : position(item)
}

function geometry(value: unknown): void {
  const object = record(value, "geojson geometry")
  const type = object.type
  if (typeof type !== "string") fail("geojson geometry needs a type")
  if (type === "GeometryCollection") {
    if (!Array.isArray(object.geometries)) fail("geojson geometry collection needs geometries")
    for (const child of object.geometries) geometry(child)
    return
  }
  const coordinates = object.coordinates
  switch (type) {
    case "Point": position(coordinates); return
    case "MultiPoint": positions(coordinates, 1); return
    case "LineString": positions(coordinates, 2); return
    case "MultiLineString":
      if (!Array.isArray(coordinates) || coordinates.length < 1) fail("geojson multi-line needs lines")
      for (const line of coordinates) positions(line, 2)
      return
    case "Polygon": positions(coordinates, 1, true); return
    case "MultiPolygon":
      if (!Array.isArray(coordinates) || coordinates.length < 1) fail("geojson multi-polygon needs polygons")
      for (const polygon of coordinates) positions(polygon, 1, true)
      return
    default: fail(`unknown geojson geometry type ${type}`)
  }
}

function geojson(value: unknown, source: TypeSource): JsonValue {
  const normalized = sourceJson(value, source)
  const object = record(normalized, "geojson")
  switch (object.type) {
    case "Feature":
      if (object.geometry !== null) geometry(object.geometry)
      if (!(object.properties === null || (object.properties && typeof object.properties === "object" && !Array.isArray(object.properties)))) fail("geojson feature properties must be an object or null")
      return normalized
    case "FeatureCollection":
      if (!Array.isArray(object.features)) fail("geojson feature collection needs features")
      for (const feature of object.features) {
        if (record(feature, "geojson feature").type !== "Feature") fail("geojson feature collection contains a non-feature")
        geojson(feature, source)
      }
      return normalized
    default:
      geometry(object)
      return normalized
  }
}

/**
 * Every named check this client runs, keyed as the table names it. Each is
 * asked of a value already in canonical form, so a check may read the spelling
 * the pattern guarantees.
 */
const CHECKS: Record<TypeCheck, (value: JsonValue, field: TypeField) => void> = {
  "calendar": (value) => {
    const text = value as string
    if (!calendarDay(Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10)))) fail("value is not a calendar date")
  },
  "int64-range": (value) => {
    const parsed = BigInt(value as string)
    if (parsed < INT64_MIN || parsed > INT64_MAX) fail("int64 is outside signed 64-bit range")
  },
  "duration-range": (value) => {
    if (durationMicros(value as string) > MAX_DURATION_MICROS) fail("duration is too large")
  },
  "tzdb": (value) => {
    if (!tzdbName(value as string)) fail("timezone must be an IANA name")
  },
  "decimal-profile": (value, field) => {
    const { precision, scale } = field
    if (!Number.isInteger(precision) || !Number.isInteger(scale) || precision! < 1 || precision! > 38 || scale! < 0 || scale! > precision!) {
      fail("decimal field requires precision 1..38 and scale 0..precision")
    }
    const [integer, fraction = ""] = (value as string).replace("-", "").split(".")
    if (fraction.length > scale!) fail("decimal exceeds field scale")
    if ((integer === "0" ? 0 : integer.length) > precision! - scale!) fail("decimal exceeds field precision")
  },
  "scalar-values": (value) => {
    walk(value, (text) => {
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
          if (++i >= text.length || text.charCodeAt(i) < 0xdc00 || text.charCodeAt(i) > 0xdfff) fail("value has an unpaired surrogate")
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          fail("value has an unpaired surrogate")
        } else if (code === 0) {
          fail("value contains U+0000")
        }
      }
    }, () => {})
  },
  "finite-numbers": (value) => {
    walk(value, () => {}, (number) => {
      if (!Number.isFinite(number)) fail("value must contain finite numbers")
    })
  },
  "ring-closure": (value) => rings(value),
}

/** Every string and number a value holds, keys included. */
function walk(value: JsonValue, onString: (text: string) => void, onNumber: (number: number) => void): void {
  if (typeof value === "string") onString(value)
  else if (typeof value === "number") onNumber(value)
  else if (Array.isArray(value)) for (const item of value) walk(item, onString, onNumber)
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      onString(key)
      walk(item, onString, onNumber)
    }
  }
}

function rings(value: JsonValue): void {
  if (value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) rings(item)
    return
  }
  const object = value as Record<string, JsonValue>
  if (object.type === "GeometryCollection") return rings(object.geometries ?? null)
  if (object.type === "Feature") return rings(object.geometry ?? null)
  if (object.type === "FeatureCollection") return rings(object.features ?? null)
  if (object.type !== "Polygon" && object.type !== "MultiPolygon") return
  const polygons = (object.type === "Polygon" ? [object.coordinates] : object.coordinates) as JsonValue[][][]
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const first = ring[0] as JsonValue[], last = ring[ring.length - 1] as JsonValue[]
      if (first.length !== last.length || first.some((part, index) => part !== last[index])) fail("geojson polygon rings must close")
    }
  }
}

function sign(n: number | bigint): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0
}

function compareDecimals(a: string, b: string): number {
  const x = decimalParts(a), y = decimalParts(b)
  const zero = (p: typeof x) => p.integer === "0" && p.fraction === ""
  const sx = zero(x) ? 0 : x.negative ? -1 : 1
  const sy = zero(y) ? 0 : y.negative ? -1 : 1
  if (sx !== sy) return sign(sx - sy)
  // Digits before the point decide first: padding to a fixed width would make
  // a magnitude wider than the pad compare as a prefix.
  if (x.integer.length !== y.integer.length) return sx * sign(x.integer.length - y.integer.length)
  const width = Math.max(x.fraction.length, y.fraction.length)
  const magnitude = (p: typeof x) => p.integer + p.fraction.padEnd(width, "0")
  const wide = magnitude(x), narrow = magnitude(y)
  return sx * (wide < narrow ? -1 : wide > narrow ? 1 : 0)
}

/**
 * The checks that judge a value against its FIELD rather than its type. A
 * column's precision and scale bound what it stores; a filter literal is not
 * stored, so comparing against one out of profile is a comparison and not an
 * error.
 */
const FIELD_CHECKS: readonly TypeCheck[] = ["decimal-profile"]

/** One type entry, with its patterns compiled once. */
type Held = { entry: TypeEntry; pattern?: RegExp; refuse?: RegExp }

/**
 * The types this client writes transformations for. A record and not a
 * list: a type added to `PortableType` and to `convert` and forgotten here
 * would otherwise refuse a table that names it, saying this client does not
 * write it, which would not be true.
 */
const IMPLEMENTED: Record<PortableType, true> = {
  string: true, bool: true, int32: true, int64: true, double: true, bytes: true,
  uuid: true, timestamp: true, date: true, time: true, timezone: true,
  duration: true, decimal: true, json: true, geojson: true,
}

function convert(type: PortableType, field: TypeField, value: unknown, source: TypeSource, held: Held): JsonValue {
  switch (type) {
    case "string": return asString(value, "string")
    case "bool":
      if (typeof value === "boolean") return value
      if (value === "true" || ((source === "postgres" || source === "electric") && value === "t")) return true
      if (value === "false" || ((source === "postgres" || source === "electric") && value === "f")) return false
      return fail("bool must be true or false")
    case "int32": return integer(value, "int32")
    case "int64": return canonicalInteger(value, "int64")
    case "double": return transportDouble(value, source)
    case "bytes": return bytes(value, source, held.pattern!)
    case "uuid": return asString(value, "uuid").toLowerCase()
    case "timestamp": return timestamp(value)
    case "date": return canonicalDate(value)
    case "time": return canonicalTime(value)
    case "timezone": return asString(value, "timezone")
    case "duration": return canonicalDuration(value, source)
    case "decimal": return canonicalDecimal(value)
    case "json": return sourceJson(value, source)
    case "geojson": return geojson(value, source)
  }
}

/** The spelling the table states, over the value a transformation produced. */
function assertCanonical(held: Held, value: JsonValue, label: string): void {
  switch (held.entry.json) {
    case "string":
      if (typeof value !== "string") return fail(`${label} must be a string`)
      if (held.pattern !== undefined && !held.pattern.test(value)) fail(`${label} is not canonical`)
      if (held.refuse !== undefined && held.refuse.test(value)) fail(`${label} is not canonical`)
      return
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${label} must be a finite number`)
      if (held.entry.min !== undefined && (!Number.isInteger(value) || value < held.entry.min || value > held.entry.max!)) fail(`${label} is out of range`)
      return
    case "boolean":
      if (typeof value !== "boolean") fail(`${label} must be a boolean`)
      return
    case "value":
      return
  }
}

export type Types = {
  canonicalType(type: string): PortableType
  /**
   * The types a maintained view may order by. The view engine compares with
   * a plain `<` (db-ivm's compareKeys), which is the type's own order where
   * the table says a value's order IS its text, and where a number or a
   * boolean orders natively. An int64, a duration and a decimal are canonical
   * strings whose text order is not their value order, and a type with no
   * order has none to fall back to. The physical labels an older program
   * spells are here too, under their type's answer.
   */
  engineOrders(): Set<string>
  normalizeValue(field: TypeField, value: unknown, source?: TypeSource): JsonValue
  normalizeRow(fields: readonly TypeField[], row: Record<string, unknown>, source?: TypeSource): Record<string, unknown>
  compareCarrier(field: TypeField, a: unknown, b: unknown): number
  compareType(field: TypeField, a: unknown, b: unknown): number
  electricParsers(fields: readonly TypeField[]): Record<string, (value: unknown) => JsonValue>
  toProtoJSONValue(field: TypeField, value: unknown): JsonValue
  fromProtoJSONValue(field: TypeField, value: unknown): JsonValue
}
export type Carriers = Types

/**
 * Binds this client's transformations to one type table. The table decides
 * what canonical is and which checks a type owes; a table that names a
 * type this client cannot write, or a check it does not run, is refused
 * here rather than applied in part.
 */
export function types(table: TypeTable): Types {
  if (table === undefined || table === null) fail("a type table is required, as `carriers` or `types`")
  record(table.types, "the type table's types")
  record(table.aliases, "the type table's aliases")
  const held = new Map<PortableType, Held>()
  for (const [name, entry] of Object.entries(table.types)) {
    if (!Object.hasOwn(IMPLEMENTED, name)) fail(`the type table names ${name}, which this client does not write`)
    for (const check of entry.beyond) {
      if (!Object.hasOwn(CHECKS, check)) fail(`type ${name} asks for the ${check} check, which this client does not run`)
    }
    held.set(name as PortableType, {
      entry,
      pattern: entry.pattern === undefined ? undefined : new RegExp(entry.pattern),
      refuse: entry.refuse === undefined ? undefined : new RegExp(entry.refuse),
    })
  }
  // No completeness check the other way: a table that omits a type is a
  // table no column of that type can be read through, which `canonicalType`
  // says exactly where it happens. Requiring all fifteen would also oblige
  // every caller with two types in hand to spell thirteen it never uses.

  const canonicalType = (type: string): PortableType => {
    const name = table.aliases[type] ?? type
    if (!held.has(name as PortableType)) fail(`unknown type ${type}`)
    return name as PortableType
  }
  const read = (field: TypeField, value: unknown, source: TypeSource, fieldChecks: boolean): JsonValue => {
    if (value === null) return null
    const type = canonicalType(field.type)
    const entry = held.get(type)!
    const converted = convert(type, field, value, source, entry)
    assertCanonical(entry, converted, type)
    for (const check of entry.entry.beyond) {
      if (fieldChecks || !FIELD_CHECKS.includes(check)) CHECKS[check](converted, field)
    }
    return converted
  }

  const normalizeValue = (field: TypeField, value: unknown, source: TypeSource = "canonical"): JsonValue =>
    read(field, value, source, true)

  const normalizeRow = (fields: readonly TypeField[], row: Record<string, unknown>, source: TypeSource = "canonical"): Record<string, unknown> => {
    const input = record(row, "row")
    const output: Record<string, unknown> = { ...input }
    for (const field of fields) {
      // A column still declared by a physical label holds whatever that label
      // held; only a canonical type has a canonical form to put it in.
      if (table.aliases[field.type] !== undefined || !Object.hasOwn(input, field.name)) continue
      output[field.name] = normalizeValue(field, input[field.name], source)
    }
    return output
  }

  const compareType = (field: TypeField, a: unknown, b: unknown): number => {
    const type = canonicalType(field.type)
    // Either side may be a canonical value or the literal a filter spells
    // (`gt.10`, `lt.PT90S`), so both are read as a transport value: that is
    // the source which admits every text spelling a URL can carry, and a
    // type whose canonical form is already text reads the same either way.
    const readSide = (value: unknown) => read(field, value, "electric", false)
    switch (held.get(type)!.entry.order) {
      case "text": {
        // UTF-16 order, because that is what the view engine compares with
        // (db-ivm's compareKeys is a plain `<`). A code-point order here would
        // sort a supplementary-plane character one way in a maintained view and
        // the other way in the snapshot the same region falls back to. The
        // server is a third order again: its text columns carry no COLLATE, so
        // they take the cluster's ICU root locale.
        const x = readSide(a) as string, y = readSide(b) as string
        return x < y ? -1 : x > y ? 1 : 0
      }
      case "number": return sign((readSide(a) as number) - (readSide(b) as number))
      case "boolean": return sign((readSide(a) ? 1 : 0) - (readSide(b) ? 1 : 0))
      case "integer": return sign(BigInt(readSide(a) as string) - BigInt(readSide(b) as string))
      case "duration": return sign(durationMicros(readSide(a) as string) - durationMicros(readSide(b) as string))
      case "decimal": return compareDecimals(readSide(a) as string, readSide(b) as string)
      case "none": return fail(`${type} has no order`)
    }
  }

  const toProtoJSONValue = (field: TypeField, value: unknown): JsonValue => {
    const normalized = normalizeValue(field, value, "canonical")
    if (normalized === null) return null
    if (canonicalType(field.type) === "duration") return `${(normalized as string).slice(2, -1)}s`
    return normalized
  }

  const electricParsers = (fields: readonly TypeField[]): Record<string, (value: unknown) => JsonValue> => {
    const parsers: Record<string, (value: unknown) => JsonValue> = {}
    for (const field of fields) {
      const type = canonicalType(field.type)
      const entry = held.get(type)!.entry
      const parser = (value: unknown) => normalizeValue(field, value, "electric")
      for (const base of entry.base) parsers[base] ??= parser
      if (entry.sql !== undefined) parsers[entry.sql] ??= parser
      if (type === "decimal") {
        // The field's own domain, and the profile check it has to pass before
        // a row arrives rather than after.
        CHECKS["decimal-profile"]("0", field)
        parsers[`portable_decimal_${field.precision}_${field.scale}`] = parser
      }
    }
    return parsers
  }

  const engineOrders = (): Set<string> => {
    const carried = new Set<string>()
    for (const [name, entry] of Object.entries(table.types)) {
      if (entry.order === "text" || entry.order === "number" || entry.order === "boolean") carried.add(name)
    }
    for (const [label, targetType] of Object.entries(table.aliases)) if (carried.has(targetType)) carried.add(label)
    return carried
  }

  const compareCarrier = compareType

  return {
    canonicalType,
    engineOrders,
    normalizeValue,
    normalizeRow,
    compareCarrier,
    compareType,
    electricParsers,
    toProtoJSONValue,
    fromProtoJSONValue: (field, value) => normalizeValue(field, value, "protojson"),
  }
}

export const carriers = types

