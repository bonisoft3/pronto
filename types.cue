// The type table: one statement of what each portable value is, read by
// everything that holds one. CUE unifies a seed row against `valid` here;
// #emit serves the same table to the terminal, whose client judges every value
// it canonicalizes by the entry rather than by a rule of its own. A holder
// still writes the transformations — Electric spells an interval `PT30M`,
// Postgres spells it `08:00:00` — and this says what their result must be.
//
// `beyond` is the honest half: what a pattern cannot say. A holder that meets
// a name it does not implement refuses the table, not the value, because the
// alternative is a check silently not run.
//
// Which standard each type obeys is SPEC.md's field types table; an entry
// states what a holder reads, and nothing reads prose.
package pronto

import "list"

let _year = "(000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})"
let _month = "(0[1-9]|1[0-2])"
let _day = "(0[1-9]|[12][0-9]|3[01])"
let _clock = "([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{6}"

#TypeEntry: {
	// The PostgreSQL type a column of it is built over.
	pg: string
	// How PostgreSQL holds it. PostgREST is liberal in what it accepts and
	// strict in what it sends, so a type needs a domain only where Postgres's
	// default JSON output is not the canonical spelling: the domain carries the
	// representation functions PostgREST calls as casts. Every other type
	// is a column of its `pg` type, under a CHECK where the type admits less
	// than `pg` does ("checked", the predicate portable_<type>_valid in
	// 004_types.sql) and bare where it does not ("plain").
	column: "domain" | "checked" | "plain"
	// Whether Electric's where-clause evaluator compares a column of it: in a
	// subset's `where`, and in the cursor a capped view pages past its cap on.
	// A domain is opaque to it ("Could not select an operator overload", and
	// no cast out of one parses), and a json value has no equality operator in
	// Postgres and no path operator in Electric. A table whose views filter on
	// a column that is not syncs whole (#App.#sync). Measured against Electric
	// 1.8.0, and held there by type-sql.integration.test.ts.
	subset: bool
	// The domain that holds it in PostgreSQL; type-sql.ts writes them and
	// type-sql.test.ts holds these names to those. Absent for a type with no
	// domain, and for the one domain type that has no single domain: a
	// decimal's is per precision and scale (portable_decimal_18_2), so a field
	// names it and the type cannot.
	sql?: string
	// The type names a transport may report a value of this type under.
	// Electric names a domain column by its base type, so a holder registers
	// its parser under each of these as well as under `sql`. This is not `pg`:
	// several are spellings of one type, and a type may be reported as any of
	// them.
	base: [...string]
	// What kind of JSON the value is on every wire.
	json: "string" | "number" | "boolean" | "value"
	// The canonical spelling, where it is regular. Anchored, and written in
	// the intersection of RE2 and JavaScript: no lookaround, no backreference.
	pattern?: string
	// A spelling the pattern admits and the type does not.
	refuse?: string
	// The range a number type admits, where it has one.
	min?: int
	max?: int
	// How two canonical values compare. "text" is the string's own order, so
	// a maintained view may order by a "text" type and by a number or a
	// boolean the engine orders natively — and by no other, because an int64,
	// a duration and a decimal are canonical STRINGS whose text order is not
	// their value order. A "text" type with a pattern is spelled in characters
	// every collation orders alike; one without is free text, which Postgres
	// orders by its collation and the view engine by the reader's locale
	// (#App.#sync). "none" is refused where a column asks for order, never
	// guessed.
	order: "text" | "number" | "boolean" | "integer" | "decimal" | "duration" | "none"
	// What the pattern cannot say, by name.
	beyond: [...#TypeCheck]
	// Filled by #TypeConstraint below, never by an entry: the table stays data.
	valid?: _
}

#CarrierEntry: #TypeEntry

// Every check a holder may be asked for beyond the pattern. The list is closed
// so that a table naming one is a table the holder either implements or
// refuses; an open vocabulary would let a new check pass as a no-op. It is a
// list rather than a disjunction so that a holder can read the vocabulary
// itself and hold its own to it.
#typeChecks: ["calendar", "int64-range", "duration-range", "tzdb",
	"decimal-profile", "scalar-values", "finite-numbers", "ring-closure"]
#carrierChecks: #typeChecks
#TypeCheck: or(#typeChecks)
#CarrierCheck: #TypeCheck

#types: [Name=string]: #TypeEntry
#types: {
	string: {pg: "text", column: "plain", subset: true, base: ["text", "varchar", "bpchar", "tsvector"], json: "string", refuse: "\\x00", order: "text", beyond: ["scalar-values"]}
	bool: {pg: "boolean", column: "plain", subset: true, base: ["bool", "boolean"], json: "boolean", order: "boolean", beyond: []}
	int32: {pg: "integer", column: "plain", subset: true, base: ["int2", "int4", "integer", "smallint"], json: "number", min: -2147483648, max: 2147483647, order: "number", beyond: []}
	int64: {pg: "bigint", column: "domain", subset: false, sql: "portable_int64", base: ["int8", "bigint"], json: "string", pattern: "^(0|-?[1-9][0-9]*)$", order: "integer", beyond: ["int64-range"]}
	double: {pg: "double precision", column: "checked", subset: true, base: ["float4", "float8", "double precision", "real"], json: "number", order: "number", beyond: []}
	bytes: {pg: "bytea", column: "domain", subset: false, sql: "portable_bytes", base: ["bytea"], json: "string", pattern: "^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$", order: "none", beyond: []}
	uuid: {pg: "uuid", column: "plain", subset: true, base: ["uuid"], json: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", order: "text", beyond: []}
	timestamp: {pg: "timestamptz", column: "domain", subset: false, sql: "portable_timestamp", base: ["timestamptz", "timestamp with time zone"], json: "string", pattern: "^\(_year)-\(_month)-\(_day)T\(_clock)Z$", order: "text", beyond: ["calendar"]}
	duration: {pg: "interval", column: "domain", subset: false, sql: "portable_duration", base: ["interval"], json: "string", pattern: "^PT(0|[1-9][0-9]*)(\\.[0-9]{0,5}[1-9])?S$", order: "duration", beyond: ["duration-range"]}
	decimal: {pg: "numeric", column: "domain", subset: false, base: ["numeric", "decimal"], json: "string", pattern: "^(0|-?[1-9][0-9]*|-?(0|[1-9][0-9]*)\\.[0-9]*[1-9])$", order: "decimal", beyond: ["decimal-profile"]}
	date: {pg: "date", column: "checked", subset: true, base: ["date"], json: "string", pattern: "^\(_year)-\(_month)-\(_day)$", order: "text", beyond: ["calendar"]}
	time: {pg: "time(6)", column: "domain", subset: false, sql: "portable_time", base: ["time", "time without time zone"], json: "string", pattern: "^\(_clock)$", order: "text", beyond: []}
	timezone: {pg: "text", column: "checked", subset: true, base: ["text"], json: "string", pattern: "^[A-Za-z0-9+_/-]+$", order: "none", beyond: ["tzdb"]}
	// RFC 8259 and not RFC 8785: the column is `json`, which keeps the text it
	// was given, and no holder reorders keys. Two spellings of one
	// value therefore both stand, which is why a json column has no order.
	json: {pg: "json", column: "checked", subset: false, base: ["json", "jsonb"], json: "value", order: "none", beyond: ["scalar-values", "finite-numbers"]}
	geojson: {pg: "json", column: "checked", subset: false, base: ["json", "jsonb", "geometry", "geography"], json: "value", order: "none", beyond: ["scalar-values", "finite-numbers", "ring-closure"]}
}
#carriers: #types

// The physical labels an older program still spells, and the type each one
// is. A holder maps a field's type through this before it reads the table.
#typeAlias: {text: "string", int: "int32", bigint: "int64", timestamptz: "timestamp", tsvector: "string"}
#carrierAlias: #typeAlias

// #TypeConstraint's own fields are named for their types, so inside it `string`
// and `bool` resolve to those fields rather than to the types. These are the
// types under names nothing shadows.
#TypeString: string
#TypeBool:   bool
#CarrierString: #TypeString
#CarrierBool:   #TypeBool

#Position: [number & >=-180 & <=180, number & >=-90 & <=90, ...number]
#Ring: list.MinItems(4) & [...#Position]
#Line: list.MinItems(2) & [...#Position]

#Geometry: {type!: "Point", coordinates!: #Position, ...} |
	{type!: "MultiPoint", coordinates!: list.MinItems(1) & [...#Position], ...} |
	{type!: "LineString", coordinates!: #Line, ...} |
	{type!: "MultiLineString", coordinates!: list.MinItems(1) & [...#Line], ...} |
	{type!: "Polygon", coordinates!: list.MinItems(1) & [...#Ring], ...} |
	{type!: "MultiPolygon", coordinates!: list.MinItems(1) & [...list.MinItems(1) & [...#Ring]], ...} |
	{type!: "GeometryCollection", geometries!: [...#Geometry], ...}

#GeoJSON: #Geometry |
	{type!: "Feature", geometry!: #Geometry | null, properties!: {...} | null, ...} |
	{type!: "FeatureCollection", features!: [...{type!: "Feature", geometry!: #Geometry | null, properties!: {...} | null, ...}], ...}

// The table as a constraint, for the one holder that unifies rather than
// checks: a seed row states its values here, where CUE reads the pattern.
// Written out rather than built by a comprehension, because a comprehension
// leaves the seed row's optional fields incomplete instead of absent, and an
// entity whose seed omits an optional type column then fails to export.
#TypeConstraint: {
	string: {#types.string, valid: #TypeString & !~#types.string.refuse}
	bool: {#types.bool, valid: #TypeBool}
	int32: {#types.int32, valid: (int & >=#types.int32.min & <=#types.int32.max)}
	int64: {#types.int64, valid: #TypeString & =~#types.int64.pattern}
	double: {#types.double, valid: number}
	bytes: {#types.bytes, valid: #TypeString & =~#types.bytes.pattern}
	uuid: {#types.uuid, valid: #TypeString & =~#types.uuid.pattern}
	timestamp: {#types.timestamp, valid: #TypeString & =~#types.timestamp.pattern}
	duration: {#types.duration, valid: #TypeString & =~#types.duration.pattern}
	decimal: {#types.decimal, valid: #TypeString & =~#types.decimal.pattern}
	date: {#types.date, valid: #TypeString & =~#types.date.pattern}
	time: {#types.time, valid: #TypeString & =~#types.time.pattern}
	timezone: {#types.timezone, valid: #TypeString & =~#types.timezone.pattern}
	json: {#types.json, valid: _}
	geojson: {#types.geojson, valid: #GeoJSON}
}
#Carrier: #TypeConstraint
