// #emit derives the emitted-file bundle from an #App. `cue export -e out`
// yields the whole program surface: `manifest` is the list of files, `files`
// maps each path to its content or its source. Derived structure renders in
// CUE (strings for raw formats, structs for the writer to serialize — the
// bayt #render division of labor); assembly files (html, css, jessie,
// bloblang, complex sql) are never CUE strings — they live in the app tree
// and their entries carry `src`. Where a derived config's consumer cannot
// reference a file, the content is inlined via @embed at the reference site.
//
// Not emitted here: .mise.toml (bootstrap CUE-owned) and the ir view (ir.html is
// the pinned artifact itself). bayt.cue is emitted as a thin stub over
// bayt.json (the build seat's export), and the sayt verbs run on their
// builtins against emitted files (tasks.json, compose.yaml, .say.yaml lint
// rules).
@extern(embed)

package pronto

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"list"
	"regexp"
	"strconv"
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	prontobuild "github.com/bonisoft3/pronto/builders:bayt"
	"github.com/bonisoft3/pronto/clusters:mecha"
	prontoloop "github.com/bonisoft3/pronto/loops:sayt"
	"github.com/bonisoft3/pronto/scales"
	"github.com/bonisoft3/pronto/resilience"
	"github.com/bonisoft3/pronto/distribution"
	"github.com/bonisoft3/pronto/terminals:omnishell"
)

#File: {
	format: "sql" | "local-handler" | "hybrid-sql" | "type-sql" | "carrier-sql" | "seed-sql" | "proto" | "yaml" | "json" | "caddyfile" | "html" | "css" | "cue" | "bloblang" | "jessie" | "js" | "text" | "toml" | "document"
	text?:  string // raw formats, writer-materialized
	data?:  _      // structured formats, writer-serialized
	src?:   string // assembly file authored in place; writer verifies presence
}

_caddyfileAsset:   _ @embed(file="assets/Caddyfile", type=text)
_cdcTypesAsset:    _ @embed(file="assets/cdc-types.blobl", type=text)
_cdcCarriersAsset: _cdcTypesAsset

// The type a bus row's column is converted to, by its label: the physical
// labels a program may still use name their type, and a tsvector is an
// index, not a value anyone states, so it passes through.
_busType: {for k, v in #typeAlias if k != "tsvector" {(k): v}, for k, _ in #types {(k): k}}
_busCarrier: _busType

// The types cdc-types.blobl has a measured bus spelling for — the
// asset's own dispatch, stated once here beside it and held equal to it by
// cdc-types.integration.test.ts. A server column of any other type would
// wedge its whole table at runtime, every change to it dropped by every
// pipeline and visible only in a log, so it is refused where the app is built.
_busTypes: ["string", "bool", "int32", "int64", "double", "uuid", "timestamp", "date", "time", "timezone", "duration", "decimal", "json", "geojson"]
_busCarriers:    _busTypes
_busConvertible: or(_busTypes)

// The one address a route answers at in one locale: the locale's prefix, empty
// for the default, ahead of that locale's own pattern. Three emitted artifacts
// read it — the Caddyfile's matcher list, the sitemap's <loc> and its hreflang
// alternates — and they must agree, because a sitemap naming an address the
// door does not route is a 404 handed to a crawler on purpose.
#address: A={
	route: _
	i18n?: _
	_prefix: [
		if A.i18n != _|_ if A.tag != A.i18n.default {"/" + A.i18n.locales[A.tag].path},
		"",
	][0]
	_pattern: [if A.i18n != _|_ if A.route.paths != _|_ {A.route.paths[A.tag]}, A.route.path][0]
	// The bare prefix reads /es rather than /es/, and the default locale's root
	// keeps the slash it cannot drop.
	_joined: strings.TrimSuffix(A._prefix+A._pattern, "/")
	tag:     string | *""
	out: [if A._joined == "" {"/"}, A._joined][0]
}

// A pattern's :params in the order it holds them. A translated spelling may
// order them differently from the default's, so a capture is read back by
// name and never by position.
#params: P={
	pattern: string
	out: [for seg in strings.Split(P.pattern, "/") if strings.HasPrefix(seg, ":") {strings.TrimPrefix(seg, ":")}]
}

// A route's pattern in one locale, WITHOUT the locale prefix — routeHref
// composes that from i18n.locales[tag].path. Only the first segment
// translates; the rest, literal or `:param`, are carried verbatim. An
// unslugged route keeps its authored pattern in every locale.
//
// The one place a catalogue's value is held to the URL-safe shape: the
// authored pattern constrains the default locale's address alone, and a
// translated value is an address in exactly the same way.
#localePattern: P={
	screen: _
	i18n:   _
	tag:    string
	_segment: [if P.screen.slug != _|_ {P.i18n._msg[P.tag][P.screen.slug] & =~"^[a-z0-9]+(-[a-z0-9]+)*$"}]
	out: [
		for seg in P._segment {"/" + strings.Join(list.Concat([[seg], strings.Split(P.screen.route, "/")[2:]]), "/")},
		P.screen.route,
	][0]
}

// A column's PostgreSQL type: its domain where the type keeps one (types.cue
// `column`), else the base type itself. decimal's domain is per field.
_sqlType: {
	text: "TEXT", int: "INTEGER", bigint: "BIGINT", timestamptz: "TIMESTAMPTZ", tsvector: "TSVECTOR"
	for k, c in #Carrier if k != "decimal" {(k): [if c.column == "domain" {c.sql}, c.pg][0]}
}

#colSql: C={
	f:     #Field
	table: string
	_type: [if C.f.type == "decimal" {"portable_decimal_\(C.f.precision)_\(C.f.scale)"}, _sqlType[C.f.type]][0]
	// The column's derived CHECK body; absent where the field states no cel.
	check?: string
	// What a checked type admits beyond its base type, named so a refusal
	// says which column's type it was.
	_typeCheck: [
		if #Carrier[C.f.type] != _|_ if #Carrier[C.f.type].column == "checked" {
			"CONSTRAINT \"\(C.table)_\(C.f.name)_type\" CHECK (\"\(C.f.name)\" IS NULL OR public.portable_\(C.f.type)_valid(\"\(C.f.name)\") IS TRUE)"
		},
	]
	_frags: list.Concat([
		["\"\(C.f.name)\"", C._type],
		[if C.f.generated != _|_ {"GENERATED ALWAYS AS (\(C.f.generated)) STORED"}],
		[if C.f.pk {"PRIMARY KEY"}],
		[if C.f.generated == _|_ if C.f.default != _|_ {"DEFAULT \(C.f.default)"}],
		[if C.f.generated == _|_ if !C.f.pk && C.f.required {"NOT NULL"}],
		[if C.f.unique != _|_ if C.f.unique {"UNIQUE"}],
		[if C.f.ref != _|_ {"REFERENCES \(C.f.ref)(id) ON DELETE CASCADE"}],
		C._typeCheck,
		[if C.check != _|_ {"CHECK (\(C.check))"}],
	])
	out: strings.Join(_frags, " ")
}

#indexSql: I={
	e: #Entity
	out: [for ix in I.e.indexes {
		"CREATE INDEX IF NOT EXISTS idx_\(I.e.table)_\(ix.on) ON \(I.e.table) USING \(ix.using) (\(ix.on));"
	}]
}

// Go-style duration composed of h/m/s integer units ("168h", "30m", "1h30m").
#durationSeconds: D={
	d:  string
	_m: regexp.FindNamedSubmatch(#"^(?:(?P<h>\d+)h)?(?:(?P<m>\d+)m)?(?:(?P<s>\d+)s)?$"#, D.d)
	_hours: [if D._m.h != "" {strconv.Atoi(D._m.h)}, 0][0]
	_mins: [if D._m.m != "" {strconv.Atoi(D._m.m)}, 0][0]
	_secs: [if D._m.s != "" {strconv.Atoi(D._m.s)}, 0][0]
	out: D._hours*3600 + D._mins*60 + D._secs
}

// SQL expressions and payload casts stay with the store; the terminal receives canonical literals.
#literalDefault: D={
	sql: string
	type: #Type | #LegacyType
	_type: [if #typeAlias[D.type] != _|_ {#typeAlias[D.type]}, D.type][0]
	_expr: strings.TrimSpace(D.sql)
	if D._expr =~ "^'(?:[^']|'')*'$" if !list.Contains(["bytes", "json", "geojson"], D._type) {
		value: strings.Replace(strings.TrimSuffix(strings.TrimPrefix(D._expr, "'"), "'"), "''", "'", -1)
	}
	if D._expr =~ #"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"# {
		if D._type == "int64" || D._type == "decimal" {
			value: (#exactNumericLiteral & {sql: D._expr}).out
		}
		if D._type == "int32" {
			let exact = (#exactNumericLiteral & {sql: D._expr}).out
			if exact =~ #types.int64.pattern {value: strconv.Atoi(exact)}
		}
		if D._type != "int64" && D._type != "decimal" && D._type != "int32" {value: strconv.ParseFloat(D._expr, 64)}
	}
	if strings.ToLower(D._expr) == "true" {value: true}
	if strings.ToLower(D._expr) == "false" {value: false}
	if strings.ToLower(D._expr) == "null" {value: null}
	if D.value != _|_ {admitted: D.value == null || (#TypeConstraint[D._type].valid & D.value) != _|_}
}

// String carriers must keep every digit and expand exponents without float64.
#exactNumericLiteral: N={
	sql: string
	_parts: strings.Split(strings.ToLower(N.sql), "e")
	_mantissa: strings.TrimPrefix(strings.TrimPrefix(N._parts[0], "-"), "+")
	_decimal: strings.Split(N._mantissa, ".")
	_digits: strings.Join(N._decimal, "")
	_digitList: strings.Split(N._digits, "")
	_exponent: [if len(N._parts) == 2 {strconv.Atoi(N._parts[1])}, 0][0]
	_point: len(N._decimal[0]) + N._exponent
	_expanded: [
		if N._point <= 0 {"0." + strings.Repeat("0", -N._point) + N._digits},
		if N._point >= len(N._digits) {N._digits + strings.Repeat("0", N._point-len(N._digits))},
		if N._point > 0 && N._point < len(N._digits) {strings.Join(N._digitList[:N._point], "") + "." + strings.Join(N._digitList[N._point:], "")},
	][0]
	_fields: strings.Split(N._expanded, ".")
	_integer: [if strings.TrimLeft(N._fields[0], "0") != "" {strings.TrimLeft(N._fields[0], "0")}, "0"][0]
	_fraction: [if len(N._fields) == 2 {strings.TrimRight(N._fields[1], "0")}, ""][0]
	_sign: [if strings.HasPrefix(N.sql, "-") if N._integer != "0" || N._fraction != "" {"-"}, ""][0]
	out: N._sign + N._integer + [if N._fraction != "" {"." + N._fraction}, ""][0]
}

// The column contract owned by a cluster chart; reducers have no state field.
#machineColumn: C={
	columns: [string]: [string]: _
	entityName: string
	entityTable: string
	fieldName: string
	if C.columns[C.entityName][C.fieldName] != _|_ {C.columns[C.entityName][C.fieldName]}
	if C.entityTable != C.entityName if C.columns[C.entityTable][C.fieldName] != _|_ {C.columns[C.entityTable][C.fieldName]}
}

// The server entities in the order 005 creates their tables: each after
// every table its fields reference, the declared order kept wherever it
// already is one. A table is keyed by the latest declared position among it
// and what it reaches, then by how much it reaches, then by its own
// position, which puts a referenced table first and leaves a declared order
// that is already valid as it is. A cycle across tables is refused: no CREATE
// order satisfies it. ume-rental's request table was declared before the
// app_user it references, and its database refused the file.
#tableOrder: O={
	entities: [...]
	_index: {for i, e in O.entities {(e.table): i}}
	// What each table references directly; a reference to itself or to a
	// table no server entity holds asks nothing of the order.
	_r0: {for e in O.entities {(e.table): {for f in e.fields if f.ref != _|_ if f.ref != e.table if O._index[f.ref] != _|_ {(f.ref): true}}}}
	// Squared seven times, so a chain of up to 128 references is closed: a
	// path through 128 tables, or a ring of 128, has at most 128.
	_r1: {for t, ds in O._r0 {(t): {for d, _ in ds {(d): true}, for d, _ in ds for d2, _ in O._r0[d] {(d2): true}}}}
	_r2: {for t, ds in O._r1 {(t): {for d, _ in ds {(d): true}, for d, _ in ds for d2, _ in O._r1[d] {(d2): true}}}}
	_r3: {for t, ds in O._r2 {(t): {for d, _ in ds {(d): true}, for d, _ in ds for d2, _ in O._r2[d] {(d2): true}}}}
	_r4: {for t, ds in O._r3 {(t): {for d, _ in ds {(d): true}, for d, _ in ds for d2, _ in O._r3[d] {(d2): true}}}}
	_r5: {for t, ds in O._r4 {(t): {for d, _ in ds {(d): true}, for d, _ in ds for d2, _ in O._r4[d] {(d2): true}}}}
	_r6: {for t, ds in O._r5 {(t): {for d, _ in ds {(d): true}, for d, _ in ds for d2, _ in O._r5[d] {(d2): true}}}}
	_r7: {for t, ds in O._r6 {(t): {for d, _ in ds {(d): true}, for d, _ in ds for d2, _ in O._r6[d] {(d2): true}}}}
	_reach: O._r7
	_cycles: [for t, ds in O._reach if ds[t] != _|_ {t}]
	_keyed: [for t, i in O._index {
		index: i
		key:   list.Max(list.Concat([[i], [for d, _ in O._reach[t] {O._index[d]}]]))
		reach: len([for d, _ in O._reach[t] {d}])
	}]
	_sorted: list.Sort(O._keyed, {x: _, y: _, less: x.key < y.key || (x.key == y.key && (x.reach < y.reach || (x.reach == y.reach && x.index < y.index)))})
	// The refusals are `out` itself, so every reader of the order fails with
	// them: a guard on a sibling field is dropped where a caller selects
	// `out` from the helper inline, as 005 does.
	out: [
		if len(O.entities) > 128 {error("#tableOrder closes chains of at most 128 tables, and this program has \(len(O.entities)) server tables")},
		if len(O._cycles) > 0 {error("the references among \(strings.Join(O._cycles, ", ")) form a cycle: no table can be created before the others")},
		[for k in O._sorted {O.entities[k.index]}],
	][0]
}

#tableSql: T={
	e: #Entity
	columns: [string]: [string]: _
	_lines: list.Concat([
		[for fld in T.e.fields {
			let column = #machineColumn & {columns: T.columns, entityName: T.e.name, entityTable: T.e.table, fieldName: fld.name}
			"  " + (#colSql & {
				f: fld
				if fld.default == _|_ if column.initial != _|_ {f: default: (#sqlLit & {v: column.initial}).out}
				table: T.e.table
				if T.e.cel.checks[fld.name] != _|_ {check: T.e.cel.checks[fld.name]}
				if fld.cel == _|_ if column.states != _|_ {
					check: "\"\(fld.name)\" IN (" + strings.Join([for n in column.states {(#sqlLit & {v: n}).out}], ", ") + ")"
				}
			}).out
		}],
		// Platform column, never a #Field: the write's transaction id, returned
		// via Prefer: return=representation so clients can awaitTxId against
		// the shape stream (007_txid.sql restamps it on UPDATE).
		["  \"txid\" BIGINT DEFAULT pg_current_xact_id()::text::bigint"],
		// Platform column, never a #Field: the tenancy floor's scope. GENERATED
		// so Postgres refuses a client-supplied value — the derivation cannot be
		// made to lie without a trigger defending it. NOT NULL because a NULL
		// scope fails `= ANY()`, which would make the row invisible to every
		// role while the audit reported the table protected.
		//
		// Carrying a scope and being floored are separate. A per-object share
		// cannot be floored -- the floor is restrictive, so it ANDs, and a sharee
		// holds no scope the owner's row carries -- but the column is still what
		// a shape predicate names and what a child's trigger copies. So `shared`
		// gets the column and stays out of `rls_protect`; the exemption below
		// says so, and the permissive share policies keep governing CRUD.
		[if T.e.access != _|_ if T.e.access.scope == "private" {
			"  \"scope_id\" TEXT GENERATED ALWAYS AS ('user:' || \"\(T.e.access.owner)\") STORED NOT NULL"
		}],
		// A child of a composition takes its parent's scope. Not GENERATED: a
		// generated column cannot reach another table, so a trigger defends it
		// instead (emitted beside the policies). NOT NULL holds because Postgres
		// checks it after BEFORE triggers, so a child of no parent is refused.
		[if T.e.access != _|_ if T.e.access.scope == "folder" {
			"  \"scope_id\" TEXT NOT NULL"
		}],
		// A constant: every subject holds `public:` (subject_scopes in rls.sql
		// says what a public row reached by scope rather than by exemption buys).
		// Writes stay with the permissive policies below and the table grants.
		[if T.e.access != _|_ if T.e.access.scope == "public" {
			"  \"scope_id\" TEXT GENERATED ALWAYS AS ('public:') STORED NOT NULL"
		}],
		// The identity table under `internal`, which is the one place a
		// person reads their own row (the self-select policy below says why).
		// Its own id IS its scope, so `user:<me>` matches exactly that row --
		// the policy and the shape predicate come out as the same statement.
		[if T.e.access != _|_ if T.e.access.scope == "internal" if T.e.table == "app_user" {
			"  \"scope_id\" TEXT GENERATED ALWAYS AS ('user:' || \"id\") STORED NOT NULL"
		}],
		[if T.e.invariant.check != _|_ {"  CHECK (\(T.e.invariant.check))"}],
	])
	// A database built before a field was added has the table, which CREATE
	// TABLE IF NOT EXISTS leaves as it was: each field is added where it is
	// missing, so a release (gcp's schema job replays this file) brings a built
	// database to the program's columns. A required field with no default
	// cannot be added to a table holding rows, and says so then.
	_added: [for fld in T.e.fields if !fld.pk {
		let column = #machineColumn & {columns: T.columns, entityName: T.e.name, entityTable: T.e.table, fieldName: fld.name}
		"ALTER TABLE \(T.e.table) ADD COLUMN IF NOT EXISTS " + (#colSql & {
			f: fld
			if fld.default == _|_ if column.initial != _|_ {f: default: (#sqlLit & {v: column.initial}).out}
			table: T.e.table
			if T.e.cel.checks[fld.name] != _|_ {check: T.e.cel.checks[fld.name]}
			if fld.cel == _|_ if column.states != _|_ {
				check: "\"\(fld.name)\" IN (" + strings.Join([for n in column.states {(#sqlLit & {v: n}).out}], ", ") + ")"
			}
		}).out + ";"
	}]
	// A built database's column keeps the CHECK it was made with, which a field
	// whose cel (or a machine's states) changed since no longer says: Bonk
	// Chess's seat views refused the `arm` action added after its database was
	// built, so no game online could begin. Each checked field's CHECK is set
	// again as the program says it, under the name Postgres gives a column's
	// own (<table>_<field>_check), NOT VALID so rows written before are kept.
	_reasserted: [for fld in T.e.fields if !fld.pk
		let column = #machineColumn & {columns: T.columns, entityName: T.e.name, entityTable: T.e.table, fieldName: fld.name}
		for check in [
			if T.e.cel.checks[fld.name] != _|_ {T.e.cel.checks[fld.name]},
			if fld.cel == _|_ if column.states != _|_ {"\"\(fld.name)\" IN (" + strings.Join([for n in column.states {(#sqlLit & {v: n}).out}], ", ") + ")"},
		] {
			"ALTER TABLE \(T.e.table) DROP CONSTRAINT IF EXISTS \"\(T.e.table)_\(fld.name)_check\", ADD CONSTRAINT \"\(T.e.table)_\(fld.name)_check\" CHECK (\(check)) NOT VALID;"
		}]
	out: "CREATE TABLE IF NOT EXISTS \(T.e.table) (\n" + strings.Join(_lines, ",\n") + "\n);" + strings.Join([for a in _added {"\n" + a}], "") + strings.Join([for a in _reasserted {"\n" + a}], "")
}

#sqlLit: L={
	v: _
	out: [
		if (L.v & null) != _|_ if (L.v & (string | bool | number | {...} | [...])) == _|_ {"NULL"},
		if (L.v & {raw: string}) != _|_ {(L.v & {raw: string}).raw},
		if (L.v & string) != _|_ {"'" + strings.Replace((L.v & string), "'", "''", -1) + "'"},
		if (L.v & bool) != _|_ {[if (L.v & bool) {"true"}, "false"][0]},
		if (L.v & {...}) != _|_ {"'" + strings.Replace(json.Marshal(L.v), "'", "''", -1) + "'"},
		if (L.v & [...]) != _|_ {"'" + strings.Replace(json.Marshal(L.v), "'", "''", -1) + "'"},
		"\(L.v)",
	][0]
}

// What the writer renders 900_seed.sql from (seed.ts): a seeded server entity's
// columns, each with its type and, for a domain type, the function that reads
// a JSON literal into it, and the rows the program states; the rows state.seed
// holds the writer reads from `src` itself. Every server entity is listed
// where a seed file is declared, because which of them it holds rows for is
// the file's to say.
#seedData: S={
	code!: _
	_held: S.code.state.seed != _|_
	out: {
		if S._held {src: S.code.state.seed.src}
		entities: [for _, e in S.code.state.entities if e.server if S._held || len(e.seed) > 0 {
			name:  e.name
			table: e.table
			columns: [for f in e.fields {
				name: f.name
				if #Carrier[f.type] != _|_ {
					type: f.type
					if #Carrier[f.type].column == "domain" {
						from: "public.\([if f.type == "decimal" {"portable_decimal_\(f.precision)_\(f.scale)"}, #Carrier[f.type].sql][0])_from_json"
					}
				}
			}]
			rows: e.seed
		}]
	}
}

// A SECURITY DEFINER read under FORCE ROW LEVEL SECURITY is still scoped by
// the caller's app.scopes unless the definer itself bypasses RLS, so the role
// that owns these functions decides whether the server seat judges against the
// truth or against one caller's slice.
#validationPrecondition: """
	DO $$ BEGIN
	  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
	    RAISE EXCEPTION 'validation triggers require a migration role that bypasses RLS (superuser or BYPASSRLS): %', current_user;
	  END IF;
	END $$;
	"""

// Predicate function identities survive the move into the lifecycle
// interpreter. Its AFTER trigger receives generated columns and runs only
// after RLS accepted the write, before making privileged related-row reads.
#validationSql: V={
	e: #Entity
	_fn: {for n, _ in V.e.validations {(n): "\(V.e.table)_validation_\(strings.Replace(n, "-", "_", -1))"}}
	// The statements carry their own line break, so a module that is a bare
	// arrow function leaves no blank line above the completion.
	_statements: {for n, v in V.e.validations {
		(n): [if v.module.statements != "" {v.module.statements + "\n"}, ""][0]
	}}
	// text, not boolean: a predicate that answers neither is the app's program
	// error, and only a value the wrapper can tell apart from a verdict lets it
	// raise a different ERRCODE for it. REVOKE, because PostgREST publishes
	// every function the anon role may execute as an /rpc/ endpoint.
	_functions: [for n, v in V.e.validations {
		"""
		CREATE OR REPLACE FUNCTION \(V._fn[n])(state jsonb, event jsonb) RETURNS text
		LANGUAGE plv8 IMMUTABLE AS $validation$
		\(V._statements[n])const verdict = (\(v.module.completion))(state, event);
		return verdict === true ? "true" : verdict === false ? "false" : "answered " + typeof verdict;
		$validation$;

		REVOKE EXECUTE ON FUNCTION \(V._fn[n])(jsonb, jsonb) FROM PUBLIC;
		"""
	}]
	out: strings.Join(list.Concat([V._functions, [
		"DROP TRIGGER IF EXISTS \(V.e.table)_validate ON \(V.e.table);",
		"DROP FUNCTION IF EXISTS \(V.e.table)_validate();",
	]]), "\n\n")
}

#lifecycleGuardSql: G={
	e: #Entity
	guards: [...string]
	row: "NEW" | "OLD"
	out: strings.Join([for n in G.guards {
		let v = G.e.validations[n]
		let reads = strings.Join([for ed in v.edges {
			"'\(ed.table)', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM \(ed.table) r WHERE r.\"\(ed.key)\" = \(G.row).\"\(ed.from)\")"
		}], ", ")
		"""
		  v := \(G.e.table)_validation_\(strings.Replace(n, "-", "_", -1))(jsonb_build_object('items', items, 'rows', jsonb_build_object(\(reads))), event);
		  IF v = 'false' THEN
		    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'validation \(G.e.table).\(n)';
		  ELSIF v IS DISTINCT FROM 'true' THEN
		    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'predicate \(G.e.table).\(n) ' || coalesce(v, 'answered nothing');
		  END IF;
		"""
	}], "\n")
}

#mechaEffectSql: EF={
	effect: #RelationalEffect
	op:     *"INSERT" | "UPDATE" | "DELETE"

	_rel: EF.effect
	_table: [if _rel.schema != _|_ {"\"\(_rel.schema)\".\"\(_rel.table)\""}, "\"\(_rel.table)\""][0]
	_cols: [if _rel["values"] != _|_ {[for c, _ in _rel.values {"\"\(c)\""}]}, []][0]
	_rawKeys: [{[if _rel["key"] != _|_ {_rel.key}, ["id"]][0]}, []][0]
	_keys: [{[for k in _rawKeys {"\"\(k)\""}]}, []][0]
	_vals: [if _rel["values"] != _|_ {[for _, val in _rel.values {(#sqlLit & {v: val}).out}]}, []][0]
	_updates: [if _rel["values"] != _|_ {[for c, _ in _rel.values if !list.Contains(_rawKeys, c) {"\"\(c)\" = EXCLUDED.\"\(c)\""}]}, []][0]
	_setClauses: [if _rel["values"] != _|_ {[for c, _ in _rel.values if (_rel["where"] != _|_ || !list.Contains(_rawKeys, c)) {"\"\(c)\" = \((#sqlLit & {v: _rel.values[c]}).out)"}]}, []][0]
	_customUpdates: [if _rel["updateValues"] != _|_ {[for c, val in _rel.updateValues {"\"\(c)\" = \((#sqlLit & {v: val}).out)"}]}, []][0]
	_accUpdates: [if _rel["values"] != _|_ {[for c, _ in _rel.values if !list.Contains(_rawKeys, c) {
		if _rel["accumulate"] != _|_ {
			if list.Contains(_rel.accumulate, c) {
				"\"\(c)\" = \"\(_rel.table)\".\"\(c)\" + EXCLUDED.\"\(c)\""
			}
			if !list.Contains(_rel.accumulate, c) {
				"\"\(c)\" = EXCLUDED.\"\(c)\""
			}
		}
		if _rel["accumulate"] == _|_ {
			"\"\(c)\" = \"\(_rel.table)\".\"\(c)\" + EXCLUDED.\"\(c)\""
		}
	}]}, []][0]

	_wherePreds: [if _rel["where"] != _|_ {[for c, val in _rel.where {"\"\(c)\" = \((#sqlLit & {v: val}).out)"}]}, []][0]
	_rawWherePred: [if _rel["rawWhere"] != _|_ {[_rel.rawWhere]}, []][0]
	_keyPreds: [if _rel["values"] != _|_ {[for k in _rawKeys if _rel.values[k] != _|_ {"\"\(k)\" = \((#sqlLit & {v: _rel.values[k]}).out)"}]}, []][0]
	_explicitPreds: list.Concat([_wherePreds, _rawWherePred])
	_preds: [{[if len(_explicitPreds) > 0 {_explicitPreds}, _keyPreds][0]}, []][0]

	_relBranches: [
		if _rel["op"] != _|_ if _rel.op == "create" {"        INSERT INTO \(_table) (\(strings.Join(_cols, ", "))) VALUES (\(strings.Join(_vals, ", ")));"},
		if _rel["op"] != _|_ if _rel.op == "ensure" {"        INSERT INTO \(_table) (\(strings.Join(_cols, ", "))) VALUES (\(strings.Join(_vals, ", "))) ON CONFLICT (\(strings.Join(_keys, ", "))) DO NOTHING;"},
		if _rel["op"] != _|_ if _rel.op == "upsert" {
			[if len(_customUpdates) > 0 {
				"        INSERT INTO \(_table) (\(strings.Join(_cols, ", "))) VALUES (\(strings.Join(_vals, ", "))) ON CONFLICT (\(strings.Join(_keys, ", "))) DO UPDATE SET \(strings.Join(_customUpdates, ", "));"
			}, {
				"        INSERT INTO \(_table) (\(strings.Join(_cols, ", "))) VALUES (\(strings.Join(_vals, ", "))) ON CONFLICT (\(strings.Join(_keys, ", "))) DO UPDATE SET \(strings.Join(_updates, ", "));"
			}][0]
		},
		if _rel["op"] != _|_ if _rel.op == "accumulate" {
			[if len(_customUpdates) > 0 {
				"        INSERT INTO \(_table) (\(strings.Join(_cols, ", "))) VALUES (\(strings.Join(_vals, ", "))) ON CONFLICT (\(strings.Join(_keys, ", "))) DO UPDATE SET \(strings.Join(_customUpdates, ", "));"
			}, {
				"        INSERT INTO \(_table) (\(strings.Join(_cols, ", "))) VALUES (\(strings.Join(_vals, ", "))) ON CONFLICT (\(strings.Join(_keys, ", "))) DO UPDATE SET \(strings.Join(_accUpdates, ", "));"
			}][0]
		},
		if _rel["op"] != _|_ if _rel.op == "update" {
			if len(_preds) > 0 {
				"        UPDATE \(_table) SET \(strings.Join(_setClauses, ", ")) WHERE \(strings.Join(_preds, " AND "));"
			}
			if len(_preds) == 0 {
				"        UPDATE \(_table) SET \(strings.Join(_setClauses, ", "));"
			}
		},
		if _rel["op"] != _|_ if _rel.op == "delete" {"        DELETE FROM \(_table) WHERE \(strings.Join(_preds, " AND "));"},
	]
	// Every #RelationalOp has a branch; an op with none is a spelling the
	// schema admits and this file does not.
	_relSql: [if _rel["op"] != _|_ {[if len(_relBranches) > 0 {_relBranches[0]}, error("effect on \(_rel.table): no SQL for op \(_rel.op)")][0]}, ""][0]

	out: _relSql
}

#mechaHatchSql: H={
	hatch: #SqlHatchCall
	_args: [if H.hatch.args != _|_ {[for _, a in H.hatch.args {(#sqlLit & {v: a}).out}]}, []][0]
	out: "        PERFORM \(H.hatch.call)(\(strings.Join(_args, ", ")));"
}

#mechaRaiseSql: R={
	value:     #MechaRaise
	op:        *"INSERT" | "UPDATE" | "DELETE"
	_isNotify: (R.value & #NotifyRaise) != _|_
	_isStream: (R.value & #StreamRaise) != _|_

	_notifySql: [if _isNotify if R.value["notify"] != _|_ {"        PERFORM pg_notify(\((#sqlLit & {v: R.value.notify}).out), \((#sqlLit & {v: R.value.payload}).out));"}, ""][0]

	_defaultKey: [if R.op == "DELETE" {"OLD.id::text"}, "NEW.id::text"][0]

	_streamSignal: [if _isStream if R.value["signal"] != _|_ {R.value.signal}, "refresh"][0]
	_rawStreamKey: [
		if _isStream if R.value["key"] != _|_ {
			[
				if (R.value.key & {raw: string}) != _|_ {
					(R.value.key & {raw: string}).raw + "::text"
				},
				if (R.value.key & string) != _|_ {
					[
						if strings.HasPrefix((R.value.key & string), "NEW.") || strings.HasPrefix((R.value.key & string), "OLD.") {
							(R.value.key & string) + "::text"
						},
						"'" + strings.Replace((R.value.key & string), "'", "''", -1) + "'",
					][0]
				},
				_defaultKey,
			][0]
		},
		_defaultKey,
	][0]
	_streamSql: [if _isStream {
		"""
		        PERFORM pg_notify('duckstream_\(R.value.stream)', jsonb_build_object('signal', '\(_streamSignal)', 'table', TG_TABLE_NAME, 'id', \(_rawStreamKey))::text);
		"""
	}, ""][0]

	out: [if _isNotify {_notifySql}, _streamSql][0]
}

#mechaLockSql: L={
	lock: #MechaReadLock
	_table: [if L.lock.schema != _|_ {"\"\(L.lock.schema)\".\"\(L.lock.table)\""}, "\"\(L.lock.table)\""][0]
	_statement: "PERFORM 1 FROM \(_table) WHERE \"\(L.lock.key)\" IN (\(strings.Join([for value in L.lock.values {(#sqlLit & {v: value}).out}], ", "))) ORDER BY \"\(L.lock.key)\" FOR UPDATE;"
	out: [if L.lock.when != _|_ {"IF (\(L.lock.when)) THEN\n\(_statement)\nEND IF;"}, _statement][0]
}

#mechaActionSql: AC={
	action: #MechaAction
	op:     *"INSERT" | "UPDATE" | "DELETE"
	// The time a machine's step runs at, which the machines it spawns or
	// sends to run at too; outside a step, each reads its own clock().
	at: *"NULL" | string

	_spawns: [if AC.action.spawn != _|_ {
        let call = AC.action.spawn
        "PERFORM hybrid_\(call.machine).spawn(\((#sqlLit & {v: call.id}).out), \((#MechaJsonSql & {fields: call.input}).out), \((#MechaJsonSql & {fields: call.members}).out), \(AC.at));"
    }]
    _sends: [if AC.action.send != _|_ {
        let call = AC.action.send
        "PERFORM hybrid_\(call.machine).deliver(\((#sqlLit & {v: call.id}).out), jsonb_build_object('kind', \((#sqlLit & {v: call.event}).out), 'payload', \((#MechaJsonSql & {fields: call.payload}).out)), \(AC.at));"
    }]
	_locks: [if AC.action.lock != _|_ {(#mechaLockSql & {lock: AC.action.lock}).out}]
	_effList: [if AC.action["effect"] != _|_ {
		[if (AC.action.effect & [...]) != _|_ {AC.action.effect}, [AC.action.effect]][0]
	}, []][0]

	_assigns: [if AC.action["assign"] != _|_ {[
		for col, val in AC.action.assign {
			"        NEW.\"\(col)\" := \((#sqlLit & {v: val}).out);"
		},
	]}, []][0]

	_effects: [
		for eff in _effList {
			(#mechaEffectSql & {effect: eff, op: AC.op}).out
		},
	]

	_hatches: [if AC.action.hatch != _|_ for h in [if (AC.action.hatch & [...]) != _|_ {AC.action.hatch}, [AC.action.hatch]][0] {
		(#mechaHatchSql & {hatch: h}).out
	}]
	_raises: [if AC.action.raise != _|_ for r in [if (AC.action.raise & [...]) != _|_ {AC.action.raise}, [AC.action.raise]][0] {
		(#mechaRaiseSql & {value: r, op: AC.op}).out
	}]
	_reject: [if AC.action.reject != _|_ {
		"        RAISE EXCEPTION USING MESSAGE = \((#sqlLit & {v: AC.action.reject}).out), ERRCODE = 'check_violation';"
	}]

	out: strings.Join(list.Concat([_locks, _assigns, _effects, _spawns, _sends, _hatches, _raises, _reject]), "\n")
}

#mechaStateSql: ST={
	table: string
	field: string
	name:  string
	state: #MechaState
	states: [string]: #MechaState
	timed: *false | bool
	// The effect each invoking state of the machine claims on entry.
	invokes: [string]: #ExternalEffect
	pk: [...string]

	_type: [if ST.state["type"] != _|_ {ST.state["type"]}, "normal"][0]
	_isFinal: _type == "final"

	_finalBlock: """
		    IF OLD."\(ST.field)" = '\(ST.name)' THEN
		      RAISE EXCEPTION 'cannot transition from final state % on %', OLD."\(ST.field)", '\(ST.table)' USING ERRCODE = 'check_violation';
		    END IF;
		"""

	_onTransitions: [if ST.state["on"] != _|_ {[
		for ev, tr in ST.state.on
		for t in [if (tr & string) != _|_ {[{target: tr}]}, if (tr & [...]) != _|_ {tr}, [tr]][0] {
			if t["target"] != _|_ {target: t.target}
			event: ev
			if t["guard"] != _|_ {guard: t.guard}
			actions: [if t["actions"] != _|_ {[if (t.actions & [...]) != _|_ {t.actions}, [t.actions]][0]}, []][0]
		},
	]}, []][0]

	_afterTransitions: [if ST.state["after"] != _|_ {[
		for d, tr in ST.state.after
		for idx, t in [if (tr & string) != _|_ {[{target: tr}]}, if (tr & [...]) != _|_ {tr}, [tr]][0] {
			if t["target"] != _|_ {target: t.target}
			event:   "after"
			delayMs: d
			branch: idx
			if t["guard"] != _|_ {guard: t.guard}
			actions: [if t["actions"] != _|_ {[if (t.actions & [...]) != _|_ {t.actions}, [t.actions]][0]}, []][0]
		},
	]}, []][0]

	_invoking: ST.state["invoke"] != _|_
	_invokeTransitions: [if _invoking for tr in [ST.state.invoke.onDone, ST.state.invoke.onError] {
		[if (tr & string) != _|_ {{target: tr, actions: []}}, {
			target:  tr.target
			actions: [if tr["actions"] != _|_ {[if (tr.actions & [...]) != _|_ {tr.actions}, [tr.actions]][0]}, []][0]
		}][0]
	}]

	_allTransitions: list.Concat([_onTransitions, _afterTransitions, _invokeTransitions])

	_transitionBranches: [for t in _allTransitions {
		_guardLine: [if t["guard"] != _|_ if t.delayMs == _|_ {
			"""
			        IF (\(t.guard)) IS NOT TRUE THEN
			          RAISE EXCEPTION 'guard failed on % transition from % to %', '\(ST.table)', '\(ST.name)', '\(t.target)' USING ERRCODE = 'check_violation';
			        END IF;
			"""
		}, ""][0]
		_timerGate: [if ST.timed {
			[if t.delayMs != _|_ {" AND timer_delay = '\(t.delayMs)' AND timer_branch = \(t.branch)"}, " AND timer_delay IS NULL"][0]
		}, ""][0]
		_actionLines: [for a in t.actions {(#mechaActionSql & {action: a, op: "UPDATE"}).out}]
		_exitActions: [if ST.state.exit != _|_ for a in [if (ST.state.exit & [...]) != _|_ {ST.state.exit}, [ST.state.exit]][0] {
			(#mechaActionSql & {action: a, op: "UPDATE"}).out
		}]
		_entryActions: [if ST.states[t.target].entry != _|_ for a in [if (ST.states[t.target].entry & [...]) != _|_ {ST.states[t.target].entry}, [ST.states[t.target].entry]][0] {
			(#mechaActionSql & {action: a, op: "UPDATE"}).out
		}]
		_enterLines: [if ST.invokes[t.target] != _|_ {(#invokeEnterSql & {effect: ST.invokes[t.target], state: t.target, pk: ST.pk}).out}]
		"""
		      IF NEW."\(ST.field)" = '\(t.target)'\(_timerGate) THEN
		\(_guardLine)\(strings.Join(list.Concat([_exitActions, _actionLines, _entryActions, _enterLines]), "\n"))
		        RETURN NEW;
		      END IF;
		"""
	}]

	// Only the outcome the airlock recorded leaves an invoking state, so no other
	// writer can forge one.
	_outcomeCheck: [if _invoking {
		_key: (#ledgerKeySql & {effect: ST.invokes[ST.name], rec: "OLD"}).out
		"""
		      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = \(_key);
		      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."\(ST.field)" THEN
		        RAISE EXCEPTION '% leaves \(ST.name) only by the recorded outcome of %', '\(ST.table)', \(_key) USING ERRCODE = 'check_violation';
		      END IF;
		"""
	}, ""][0]

	_normalBlock: """
		    IF OLD."\(ST.field)" = '\(ST.name)' THEN
		\(_outcomeCheck)
		\(strings.Join(_transitionBranches, "\n"))
		      RAISE EXCEPTION 'invalid transition on % from % to %', '\(ST.table)', OLD."\(ST.field)", NEW."\(ST.field)" USING ERRCODE = 'check_violation';
		    END IF;
		"""

	out: [if _isFinal {_finalBlock}, _normalBlock][0]
}

#mechaMachineSql: S={
	machine: #MechaMachine
	entities: [string]: #Entity
	effects: [string]: #ExternalEffect

	_table: [if S.entities[S.machine.entity] != _|_ {S.entities[S.machine.entity].table}, S.machine.entity][0]

	_stateMachineSql: [if S.machine["states"] != _|_ {
		_field:  S.machine.field
		_fnName: "trg_\(_table)_\(_field)_machine"

		_stateNames: [for s, _ in S.machine.states {s}]
		_stateLitList: [for s in _stateNames {"'\(s)'"}]
		_checkConstraint: """
			ALTER TABLE "\(_table)" DROP CONSTRAINT IF EXISTS "\(_table)_\(_field)_check";
			ALTER TABLE "\(_table)" ADD CONSTRAINT "\(_table)_\(_field)_check" CHECK ("\(_field)" IN (\(strings.Join(_stateLitList, ", ")))) NOT VALID;
			"""

		_invokes: {for sName, sBody in S.machine.states if sBody["invoke"] != _|_ {(sName): S.effects[sBody.invoke.src]}}
		_hasInvoke: len([for _, _ in _invokes {true}]) > 0
		_hasTimers: S.machine._timed
		_declare: [if _hasInvoke || _hasTimers {"DECLARE\n" + strings.Join([if _hasInvoke {"  outcome jsonb;\n"}, if _hasTimers {"  timer_delay text;\n  timer_branch integer;\n"}], "")}, ""][0]
		_timerContext: [if _hasTimers {"  IF TG_OP = 'UPDATE' THEN\n" + (#TimerContextSql & {machine: S.machine.name, field: _field, pk: _pk, rec: "OLD"}).out + "\n  END IF;\n"}, ""][0]
		_sameStateGate: [if _hasTimers {" AND timer_delay IS NULL"}, ""][0]
		_pk: [for e in S.entities if e.table == _table for f in e.fields if f.pk != _|_ if f.pk {f.name}]
		_initialEnter: [if _invokes[S.machine.initial] != _|_ {(#invokeEnterSql & {effect: _invokes[S.machine.initial], state: S.machine.initial, pk: _pk}).out + "\n"}, ""][0]
		_initialActions: [if S.machine.states[S.machine.initial].entry != _|_
			for a in [if (S.machine.states[S.machine.initial].entry & [...]) != _|_ {S.machine.states[S.machine.initial].entry}, [S.machine.states[S.machine.initial].entry]][0] {
			(#mechaActionSql & {action: a, op: "INSERT"}).out + "\n"
		}]
		// A row in an invoking state is the ledger's instance until its outcome
		// lands: its key fields and primary key stay as the ledger holds them,
		// and it is not deleted, or the outcome could never be delivered.
		_held: [for sName, x in _invokes {
			_cols: list.SortStrings([for c, _ in {for f in list.Concat([x.key, _pk]) {(f): true}} {c}])
			_key:  (#ledgerKeySql & {effect: x, rec: "OLD"}).out
			"""
			  IF TG_OP = 'UPDATE' AND OLD."\(_field)" = '\(sName)' AND (\(strings.Join([for c in _cols {"OLD.\"\(c)\" IS DISTINCT FROM NEW.\"\(c)\""}], " OR "))) THEN
			    RAISE EXCEPTION '% in \(sName) keeps its key until the outcome of %', '\(_table)', \(_key) USING ERRCODE = 'check_violation';
			  END IF;
			"""
		}]
		_deleteBlock: [if _hasInvoke {
			"""
			  IF TG_OP = 'DELETE' THEN
			    IF OLD."\(_field)" IN (\(strings.Join([for sName, _ in _invokes {"'\(sName)'"}], ", "))) THEN
			      RAISE EXCEPTION '% in % awaits an outcome and is not deleted', '\(_table)', OLD."\(_field)" USING ERRCODE = 'check_violation';
			    END IF;
			    RETURN OLD;
			  END IF;

			"""
		}, ""][0]
		_ops: [if _hasInvoke {"INSERT OR UPDATE OR DELETE"}, "INSERT OR UPDATE"][0]
		// A ledger key is a field's text, which for a date or time is the
		// session's to spell; pinned, so the claim's key and the outcome
		// check's are one.
		_locale: [if _hasInvoke || _hasTimers {"\nSET TimeZone = 'UTC'\nSET DateStyle = 'ISO, YMD'"}, ""][0]

		_stateBlocks: [for sName, sBody in S.machine.states {
			(#mechaStateSql & {
				table:   _table
				field:   _field
				name:    sName
				state:   sBody
				states: S.machine.states
				timed: _hasTimers
				invokes: _invokes
				pk:      _pk
			}).out
		}]

		_triggerBody: """
			CREATE OR REPLACE FUNCTION "\(_fnName)"() RETURNS trigger
			LANGUAGE plpgsql
			SECURITY DEFINER
			SET search_path = public, pg_catalog\(_locale) AS $$
			\(_declare)BEGIN
			\(_deleteBlock)\(_timerContext)\(strings.Join([for h in _held {h + "\n"}], ""))  IF TG_OP = 'UPDATE' AND OLD."\(_field)" = NEW."\(_field)"\(_sameStateGate) THEN
			    RETURN NEW;
			  END IF;

			  IF TG_OP = 'INSERT' THEN
			    IF NEW."\(_field)" <> '\(S.machine.initial)' THEN
			      RAISE EXCEPTION 'new % must start in initial state % (got %)', '\(_table)', '\(S.machine.initial)', NEW."\(_field)" USING ERRCODE = 'check_violation';
			    END IF;
			\(strings.Join(_initialActions, ""))\(_initialEnter)    RETURN NEW;
			  END IF;

			  IF TG_OP = 'UPDATE' THEN
			\(strings.Join(_stateBlocks, "\n"))
			  END IF;

			  RETURN NEW;
			END $$;

			DROP TRIGGER IF EXISTS "\(_fnName)" ON "\(_table)";
			CREATE TRIGGER "\(_fnName)"
			  BEFORE \(_ops) ON "\(_table)"
			  FOR EACH ROW
			  EXECUTE FUNCTION "\(_fnName)"();
			"""

		_checkConstraint + "\n\n" + _triggerBody + [if _hasTimers {"\n\n" + (#MachineTimerSql & {machine: S.machine, table: _table, pk: _pk}).out}, ""][0]
	}, ""][0]

	_lifecycleMachineSql: [if S.machine["on"] != _|_ {
		_fnName: "trg_\(_table)_\(S.machine.name)_reducer"
		_entity: [for en, e in S.entities if en == S.machine.entity || e.table == S.machine.entity {e}][0]
		_branches: [for op, tr in S.machine._on {
			let row = [if op == "delete" {"OLD"}, "NEW"][0]
			"""
			  IF TG_OP = '\(strings.ToUpper(op))' THEN
			\((#lifecycleGuardSql & {e: _entity, guards: tr.guard, "row": row}).out)
			\(strings.Join([for a in tr.actions {(#mechaActionSql & {action: a, "op": strings.ToUpper(op)}).out}], "\n"))
			    RETURN \(row);
			  END IF;
			"""
		}]
		_timing: [if S.machine["timing"] != _|_ {S.machine.timing}, "AFTER"][0]
		"""
		CREATE OR REPLACE FUNCTION "\(_fnName)"() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
		DECLARE
		  items jsonb;
		  event jsonb;
		  v text;
		BEGIN
		  items := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END;
		  event := jsonb_build_object('type', lower(TG_OP), 'row', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END);
		\(strings.Join(_branches, "\n"))
		  RETURN COALESCE(NEW, OLD);
		END $$;

		REVOKE EXECUTE ON FUNCTION "\(_fnName)"() FROM PUBLIC;
		DROP TRIGGER IF EXISTS "\(_fnName)" ON "\(_table)";
		CREATE TRIGGER "\(_fnName)"
		  \(_timing) INSERT OR UPDATE OR DELETE ON "\(_table)"
		  FOR EACH ROW EXECUTE FUNCTION "\(_fnName)"();
		"""
	}, ""][0]

	_compiledSql: [if S.machine["states"] != _|_ {_stateMachineSql}, _lifecycleMachineSql][0]
	_signature: hex.Encode(sha256.Sum256(_compiledSql))
	_timerFunction: [if S.machine._timed {"trg_\(_table)_\(S.machine.field)_timer_arm"}, ""][0]
	_timerCheck: [if S.machine._timed {
		"""
		DO $$ BEGIN
		  IF obj_description(to_regprocedure('"\(_timerFunction)"()'), 'pg_proc') IS DISTINCT FROM '\(_signature)' THEN
		    RAISE EXCEPTION 'machine \(S.machine.name) timer interpreter differs from the program: migrate 010_machines.sql and existing state-entry deadlines before starting';
		  END IF;
		END $$;
		"""
	}, ""][0]
	out: _compiledSql + [if S.machine._timed {"\nCOMMENT ON FUNCTION \"\(_timerFunction)\"() IS '\(_signature)';"}, ""][0]
	_effectUpgradeSql: strings.Join([if S.machine._timed {_timerCheck}, out], "\n\n")
}

// A jsonb_build_object over a map of input values: "NEW.<col>"/"OLD.<col>"
// read the row, {raw: sql} is an expression, anything else a literal.
#jsonbObjectSql: J={
	values: {[string]: _}
	out: [if len(J.values) > 0 {
		"jsonb_build_object(" + strings.Join([for k, v in J.values {
			_valSql: [
				if (v & {raw: string}) != _|_ {(v & {raw: string}).raw},
				if (v & string) != _|_ if strings.HasPrefix((v & string), "NEW.") || strings.HasPrefix((v & string), "OLD.") {strings.SplitN((v & string), ".", 2)[0] + ".\"" + strings.SplitN((v & string), ".", 2)[1] + "\""},
				if (v & string) != _|_ if !strings.HasPrefix((v & string), "NEW.") && !strings.HasPrefix((v & string), "OLD.") {"'" + strings.Replace((v & string), "'", "''", -1) + "'"},
				if (v & bool) != _|_ {[if (v & bool) {"true"}, "false"][0]},
				if (v & number) != _|_ {"\(v)"},
				if (v & {...}) != _|_ {"'" + strings.Replace(json.Marshal(v), "'", "''", -1) + "'::jsonb"},
				if (v & [...]) != _|_ {"'" + strings.Replace(json.Marshal(v), "'", "''", -1) + "'::jsonb"},
				"null",
			][0]
			"'" + strings.Replace(k, "'", "''", -1) + "', " + _valSql
		}], ", ") + ")"
	}, "'{}'::jsonb"][0]
}

// The instance's primary key, which the airlock's outcome UPDATE names.
#ledgerRowSql: R={
	pk: [...string]
	out: "jsonb_build_object(" + strings.Join([for f in R.pk {"'\(f)', NEW.\"\(f)\""}], ", ") + ")"
}

// The ledger key of an effect for the row `rec` (NEW or OLD) names.
#ledgerKeySql: K={
	effect: #ExternalEffect
	rec:    "NEW" | "OLD"
	// One field is the key as it is; several are JSON-encoded, so a ':' in a
	// value cannot make two instances read as one.
	_fields: [for f in K.effect.key {"\(K.rec).\"\(f)\"::text"}]
	out: [
		if len(K.effect.key) == 1 {"'\(K.effect.name):' || \(_fields[0])"},
		"'\(K.effect.name):' || jsonb_build_array(" + strings.Join(_fields, ", ") + ")::text",
	][0]
}

// Entering an invoking state: claim the ledger and enqueue the airlock's job in the
// transition's own commit, and re-arm the ticker's one-shot `airlock` row, so a
// cluster scaled to zero is woken for the job rather than owing it to a later
// schedule (mecha's airlock.sql seeds the row). The re-arm writes only a row not
// yet armed and never waits on one another transaction holds, so claims do not
// queue on the one row; a claim that skips the row while the ticker is ticking
// it is woken by that tick. A key already claimed was performed, so entering
// again under it is an error, never a second performance.
// What Graphile may retry beyond an effect's attempts: the ledger's `entered`
// decides when an effect runs out (mecha's airlock.ts), and a run that fails
// before it counts, or a crash Graphile counted, must not exhaust the queue
// first. Graphile's own default.
#QueueHeadroom: 25

#invokeEnterSql: I={
	effect: #ExternalEffect
	state:  string
	pk: [...string]
	_key:   (#ledgerKeySql & {effect: I.effect, rec: "NEW"}).out
	out: """
		        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
		        VALUES (\(_key), '\(I.effect.name)', \((#ledgerRowSql & {pk: I.pk}).out), \((#jsonbObjectSql & {values: I.effect.input}).out))
		        ON CONFLICT ("key") DO NOTHING;
		        IF NOT FOUND THEN
		          RAISE EXCEPTION 'external effect % was already performed: entering \(I.state) again needs a new key', \(_key) USING ERRCODE = 'unique_violation';
		        END IF;
		        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', \(_key)), job_key => \(_key), max_attempts => \(I.effect.attempts + #QueueHeadroom));
		        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
		         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
		           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
		"""
}

// The app_user USING clause of a private entity. `qual` prefixes the row's
// own columns: the table name in the entity's policies, the parent alias
// when a folder-scope child inlines this clause. `table` is the private
// entity's table regardless of qual — it names the shared-arm helper.
#ownedUsing: U={
	a:     #Access
	qual:  string
	table: string
	// The membership test is a SECURITY DEFINER helper (emitted with the
	// owned entity's policies), not an inline EXISTS: the via table's own
	// policy references this table back, and inlining would recurse
	// (Postgres aborts with "infinite recursion detected in policy").
	_shared: [
		if U.a.shared != _|_ {" OR \(U.table)_shared(\(U.qual).id)"},
		"",
	][0]
	out: "\(U.qual).\(U.a.owner) = auth_uid()" + U._shared
}

// One policy, restated rather than created. Postgres has no CREATE POLICY IF
// NOT EXISTS, so the drop is how a migration carrying a corrected rule reaches
// a database that already holds the old one — the same restatement rls_protect
// does for the tenancy policy it owns. Inside the migration's transaction the
// drop and the create are one step, so no window exists in which the table is
// enabled for RLS with this policy missing.
#policy: {
	name:  string
	table: string
	rest:  string
	out:   "DROP POLICY IF EXISTS \(name) ON \(table);\nCREATE POLICY \(name) ON \(table) \(rest);"
}

// One entity's RLS block. Policy names are deterministic:
// <table>_<role>_<action>. Every mode grants service ALL; the floor binds
// PUBLIC and 001 exempts service from it by role attribute.
#policySql: P={
	// These reasons are read by a person out of rls_exempt, so each says why
	// rather than naming a code. Empty means floored. The one that is not
	// self-evident from the string: a per-object share is unfloorable because
	// there is no scope both parties hold that does not also grant everything
	// else the owner has.
	_exempt: string
	if P.e.access.scope == "private" if P.e.access.shared != _|_ {
		_exempt: "private with a per-object share via \(P.e.access.shared.via): finer than tenancy, guarded by its own policies"
	}
	if P.e.access.scope == "private" if P.e.access.shared == _|_ {_exempt: ""}
	if P.e.access.scope == "public" {_exempt: ""}
	if P.e.access.scope == "internal" if P._t != "app_user" {
		_exempt: "internal: no app_user reaches it"
	}
	if P.e.access.scope == "internal" if P._t == "app_user" {
		_exempt: "internal except a person reading their own row, which the self-select policy alone allows"
	}
	if P.e.access.scope == "folder" {
		// A child is exactly as floorable as its parent: floored under a floored
		// one, exempt under a shared one, whose share it inherits. A parent
		// that carries no scope -- internal, unless it is app_user -- has
		// none to hand down, and the composition is a schema error.
		_p:        P.entities[P.e.access.parent]
		_pFloored: bool
		if P._p.access.scope == "private" {_pFloored: P._p.access.shared == _|_}
		if P._p.access.scope == "public" {_pFloored: true}
		if P._p.access.scope == "folder" {_pFloored: false}
		if P._p.access.scope == "internal" {_pFloored: false}
		_pScoped: bool & (P._p.access.scope != "folder" && (P._p.access.scope != "internal" || P._p.table == "app_user")) & true
		if P._pFloored {_exempt: ""}
		if !P._pFloored {
			_exempt: "folder \(P.e.access.parent), which is itself exempt: the child inherits its visibility"
		}
	}

	// A composition's scope is its parent's, written by mecha.scope_from_parent
	// (rls.sql says why a trigger and not a generated column). Called, never
	// restated, like the floor.
	_scopeTrigger: [...string]
	if P.e.access.scope != "folder" {_scopeTrigger: []}
	if P.e.access.scope == "folder" {
		_parentTable: P.entities[P.e.access.parent].table
		_scopeTrigger: [
			"""
			DROP TRIGGER IF EXISTS \(P._t)_scope ON \(P._t);
			CREATE TRIGGER \(P._t)_scope BEFORE INSERT OR UPDATE ON \(P._t)
			  FOR EACH ROW EXECUTE FUNCTION mecha.scope_from_parent('\(P._parentTable)', 'id', '\(P.e.access.on)');
			""",
		]
	}

	e: #Entity
	entities: [string]: #Entity // parent lookup for folder scope
	_t: P.e.table
	if P.e.access.scope == "private" {
		_using: (#ownedUsing & {a: P.e.access, qual: P._t, table: P._t}).out
		// The helper runs as the migration superuser, so its read of the via
		// table bypasses RLS — the cycle-break #ownedUsing relies on. auth_uid()
		// still reads the caller's session GUC (set_config is role-independent).
		_pkType: [for f in P.e.fields if f.pk {f.type}][0]
		_pre: [
			if P.e.access.shared != _|_ {
				"""
					CREATE OR REPLACE FUNCTION \(P._t)_shared(row_id \(_sqlType[P._pkType])) RETURNS boolean
					LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
					  SELECT EXISTS (SELECT 1 FROM \(P.e.access.shared.via) s WHERE s.\(P.e.access.shared.on) = row_id AND s.\(P.e.access.shared.user) = auth_uid())
					$$;
					"""
			},
		]
		_appUser: [
			(#policy & {name: "\(P._t)_app_user_select", table: P._t, rest: "FOR SELECT TO app_user USING (\(P._using))"}).out,
			(#policy & {name: "\(P._t)_app_user_insert", table: P._t, rest: "FOR INSERT TO app_user WITH CHECK (\(P._t).\(P.e.access.owner) = auth_uid())"}).out,
			(#policy & {name: "\(P._t)_app_user_update", table: P._t, rest: "FOR UPDATE TO app_user USING (\(P._using))"}).out,
			(#policy & {name: "\(P._t)_app_user_delete", table: P._t, rest: "FOR DELETE TO app_user USING (\(P._using))"}).out,
		]
	}
	if P.e.access.scope == "folder" {
		// The parent's private USING is inlined one level, its row columns
		// re-qualified by the alias p; a folder parent is a schema error.
		_parent: P.entities[P.e.access.parent]
		// The join casts the child's on-column when it differs in type from
		// the parent pk (a live-path child keys the parent's uuid as text);
		// Postgres has no cross-type = operator for uuid. The child's side, so
		// the parent's key index serves the lookup.
		_onType: [for f in P.e.fields if f.name == P.e.access.on {f.type}][0]
		_pkType: [for f in P._parent.fields if f.pk {f.type}][0]
		_onCast: [if P._onType == P._pkType {""}, "::\(_sqlType[P._pkType])"][0]
		_pre: []
		_expr: "EXISTS (SELECT 1 FROM \(P._parent.table) p WHERE p.id = \(P._t).\(P.e.access.on)\(P._onCast) AND (\((#ownedUsing & {a: P._parent.access, qual: "p", table: P._parent.table}).out)))"
		_appUser: [
			(#policy & {name: "\(P._t)_app_user_all", table: P._t, rest: "FOR ALL TO app_user USING (\(P._expr)) WITH CHECK (\(P._expr))"}).out,
		]
	}
	if P.e.access.scope == "public" {
		_pre: []
		_appUser: list.Concat([
			[(#policy & {name: "\(P._t)_app_user_select", table: P._t, rest: "FOR SELECT TO app_user USING (true)"}).out],
			[if P.e.access["write"] != _|_ if P.e.access.write == true {
				(#policy & {name: "\(P._t)_app_user_write", table: P._t, rest: "FOR ALL TO app_user USING (true) WITH CHECK (true)"}).out
			}],
		])
	}
	if P.e.access.scope == "internal" {
		_pre: []
		// The one exception, and it is the terminal's: at boot the shell reads
		// the signed-in row back out of app_user to tell a live account from a
		// token naming one that is gone (interpreter/shell.js accountLives).
		// It reads with the person's own token, so an internal app_user
		// answers zero rows, the shell concludes the account is gone, drops
		// the session and shows the door — on every reload, to everybody. A
		// person reading their own row discloses nobody; resolving anyone
		// else's still needs the SECURITY DEFINER path.
		if P._t == "app_user" {
			_appUser: [
				(#policy & {name: "app_user_self_select", table: "app_user", rest: "FOR SELECT TO app_user USING (id = auth_uid())"}).out,
			]
		}
		if P._t != "app_user" {
			_appUser: []
		}
	}

	// A row the floor does not deliver reaches the sync path one shape at a
	// time, keyed on a column mecha.shape_key declares (rls.sql says what
	// declaring one asserts). Three edges, each a fact the policies above
	// encode: a shared entity by its own key, its grant table by the sharee,
	// a composition by its parent. Only where the parent is shared: a floored
	// parent's children already carry its scope.
	_pkName: [for f in P.e.fields if f.pk {f.name}][0]
	_isShared: bool
	if P.e.access.scope == "private" {_isShared: P.e.access.shared != _|_}
	if P.e.access.scope != "private" {_isShared: false}
	_underShared: bool
	if P.e.access.scope == "folder" {_underShared: P._p.access.scope == "private" && P._p.access.shared != _|_}
	if P.e.access.scope != "folder" {_underShared: false}
	_shapeKeys: [...string]
	if P._isShared {
		_shapeKeys: [
			"INSERT INTO mecha.shape_key VALUES ('public.\(P._t)', '\(P._pkName)', 'public.\(P._t)', '\(P._pkName)') ON CONFLICT DO NOTHING;",
			"INSERT INTO mecha.shape_key VALUES ('public.\(P.e.access.shared.via)', '\(P.e.access.shared.user)', 'subject', 'id') ON CONFLICT DO NOTHING;",
		]
	}
	if P._underShared {
		_shapeKeys: [
			"INSERT INTO mecha.shape_key VALUES ('public.\(P._t)', '\(P.e.access.on)', 'public.\(P._p.table)', '\([for f in P._p.fields if f.pk {f.name}][0])') ON CONFLICT DO NOTHING;",
		]
	}
	if !P._isShared if !P._underShared {_shapeKeys: []}

	out: strings.Join(list.Concat([
		P._pre,
		P._scopeTrigger,
		// The floor's text lives in mecha's rls.sql and is called, never
		// restated, so a generator cannot emit a subtly wrong one.
		// Floored is what `_exempt` empty means, and this is the one place it
		// is read for that.
		[if P._exempt == "" {"CALL rls_protect('\(P._t)');"}],
		P._shapeKeys,
		// Everything the floor does not cover says so, because an audit that is
		// permanently non-empty is one nobody reads. Two kinds of reason live
		// here: a permanent one, where the visibility is genuinely not tenancy,
		// and a `pending:` one, where the derivation is simply not built.
		[if P._exempt != "" {
			"INSERT INTO mecha.rls_exempt VALUES ('public.\(P._t)', '\(P._exempt)') ON CONFLICT DO NOTHING;"
		}],
		["ALTER TABLE \(P._t) ENABLE ROW LEVEL SECURITY;"],
		P._appUser,
		[(#policy & {name: "\(P._t)_service_all", table: P._t, rest: "FOR ALL TO service USING (true) WITH CHECK (true)"}).out],
	]), "\n")
}

// A publication over a table list, brought up to the list and its options
// whoever made it: a database outliving its volume would publish every table
// but the newest, and a WAL reader that arrives first makes it without the
// generated columns. The options sit outside the DO block, where squawk sees them.
#publication: P={
	name: string
	tables: [...string]
	out: """
		DO $$ DECLARE t text; BEGIN
		  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = '\(P.name)') THEN
		    CREATE PUBLICATION \(P.name) FOR TABLE \(strings.Join(P.tables, ","));
		  END IF;
		  FOREACH t IN ARRAY ARRAY[\(strings.Join([for t in P.tables {"'\(t)'"}], ","))] LOOP
		    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
		                   WHERE pubname = '\(P.name)' AND schemaname = 'public' AND tablename = t) THEN
		      EXECUTE format('ALTER PUBLICATION \(P.name) ADD TABLE %I', t);
		    END IF;
		  END LOOP;
		END $$;
		ALTER PUBLICATION \(P.name) SET (publish_generated_columns = stored);
		"""
}

// The feed's transaction markers (mecha.txn_trace, mecha's rls.sql): the
// table joins the feed's publication and not Electric's, which would sync it
// to no reader, and every published table marks the transaction writing it.
// Not in conduit's `tables`, which does not filter logrepl and resolves each
// entry's key as one quoted identifier, so a schema-qualified name fails it.
// Conduit names a collection without its schema, so the marker reaches the
// bus as `__table: txn_trace`, which an app table must not also be.
#txnMarker: M={
	pub: string
	tables: [...string]
	_unshadowed: true & !list.Contains(M.tables, "txn_trace")
	out: strings.Join(list.Concat([[
		"""
		DO $$ BEGIN
		  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
		                 WHERE pubname = '\(M.pub)' AND schemaname = 'mecha' AND tablename = 'txn_trace') THEN
		    ALTER PUBLICATION \(M.pub) ADD TABLE mecha.txn_trace;
		  END IF;
		END $$;
		""",
	], [for t in M.tables {
		"""
		CREATE OR REPLACE TRIGGER mark_txn BEFORE INSERT OR UPDATE OR DELETE ON \(t)
		  FOR EACH STATEMENT EXECUTE FUNCTION mecha.mark_txn();
		"""
	}]]), "\n")
}

// Column conduit stamps onto every bus row naming the table it came from. Not
// a database column: it exists only on the wire, so it must not collide with
// one, hence the reserved prefix.
_cdcTableField: "__table"
_cdcBeforeField: "__before"

// A cdc-events stream's input processors: mecha's cdc_trace_join (the
// transform's -r cdc-trace.yaml) consumes the transaction markers and stamps
// each row's @traceparent, keyed by a name unique to the stream.
#cdcTraceJoin: J={
	consumer: string
	out: [{mutation: "meta cdc_consumer = \(json.Marshal(J.consumer))"}, {resource: "cdc_trace_join"}]
}

// Sent with each call a stream makes for a row, so the call joins the row's
// transaction's trace and, through mecha.mark_txn, the write it makes is
// marked with that trace too. Unset metadata sends no header.
_traceHeader: include_patterns: ["^traceparent$"]

#rpkPipeline: R={
	p:           #Pipeline
	sourceTable: string
	sinkTable:   string
	sinkPk:      string
	// {table: {column: carrier}} over the publication; see cdc-carriers.blobl.
	carriers: [string]: [string]: string
	// Auth'd clusters put every table behind RLS, so the transform's reads
	// and writes carry the service token; ${SERVICE_JWT} is benthos env
	// interpolation, resolved from the transform service's environment.
	authOn: *false | bool
	// A keyed transform posts an array of sink rows, one per key, so the
	// upsert must conflict on the sink pk; the singleton path conflicts on id.
	_onConflict: [if R.p.key != _|_ {R.sinkPk}, "id"][0]
	// The read is absolute, which is what makes the sink idempotent under
	// at-least-once delivery. The branch grafts the fetched aggregate rows onto
	// the event as root.rows, keeping the opencdc event (payload.before/after
	// as JSON-encoded row strings) beside the rows so a delete's key stays
	// reachable for delete-to-zero emissions.
	_fetch: branch: {
		processors: [{http: {
			url:      "${CRUD_URL}/\(R.sourceTable)?\(R.p.transform.aggregate)"
			verb:     "GET"
			metadata: _traceHeader
			if R.authOn {
				headers: Authorization: "Bearer ${SERVICE_JWT}"
			}
		}}]
		result_map: "root.rows = this"
	}
	out: {
		input: redis_streams: {
			url: "${REDIS_URL}"
			streams: ["cdc-events"]
			body_key:       "data"
			consumer_group: R.p.group
		}
		input: processors: (#cdcTraceJoin & {consumer: R.p.group}).out
		pipeline: processors: [
			// Ahead of the fetch on purpose: cdc-events carries every table and
			// each stream reads all of it, so a message the mapping will discard
			// otherwise costs a PostgREST GET first. Which messages are its own
			// is the mapping's decision — this only spares the malformed.
			{mapping: "root = if this.exists(\"data\") && this.data.type() == \"string\" && this.data.length() > 0 { this } else { deleted() }"},
			// The bus row in carrier form, so a mapping reads the values
			// PostgREST and the client hold rather than conduit's text
			// spellings. Inside a `try` with the fetch and the transform: a
			// failed processor does not stop the ones after it, so without this
			// a refused row still pays a PostgREST GET, still runs the app's
			// mapping over unconverted values, and reaches the catch with the
			// transform's output in hand instead of the row that refused.
			{"try": [
				{bloblang: "let carriers = \(json.Marshal(R.carriers))\n" + _cdcTypesAsset},
				R._fetch,
				{bloblang: R.p.transform.bloblang},
			]},
			// A failed processor leaves the message untouched and carries on, so
			// without this a throwing mapping silently POSTs the CloudEvent
			// envelope and the only trace is PostgREST rejecting a column named
			// `data`. Name the pipeline and the input, then drop: the read is
			// absolute, so the next event for that key repairs the sink.
			{catch: [
				{log: {
					level:   "ERROR"
					message: "\(R.p.name): transform failed (${! error() }) on ${! content() }"
				}},
				{mapping: "root = deleted()"},
			]},
		]
		output: retry: {
			max_retries: 3
			backoff: {initial_interval: "2s", max_interval: "30s", max_elapsed_time: "3m"}
			output: http_client: {
				// CRUD_URL is PostgREST direct, never the gateway: Caddy's
				// client-facing Prefer injection would clobber the
				// merge-duplicates upsert below.
				url:      "${CRUD_URL}/\(R.sinkTable)?on_conflict=\(R._onConflict)"
				verb:     "POST"
				metadata: _traceHeader
				headers: {
					"Content-Type": "application/json"
					Prefer:         "resolution=merge-duplicates"
					if R.authOn {
						Authorization: "Bearer ${SERVICE_JWT}"
					}
				}
				successful_on: [200, 201]
			}
		}
	}
}

// Scheduled pipeline: a generate input ticks, one bloblang processor stamps
// the filter's time tokens as metadata (and the PATCH body as root), and the
// http_client mutates the sink rows the filter matches. Derived entirely —
// no .blobl assembly, no browser shim.
#rpkScheduled: R={
	p:          #Pipeline
	sinkTable:  string
	authOn:     *false | bool // same service-token contract as #rpkPipeline
	_hasCutoff: strings.Contains(R.p.filter, "{cutoff}")
	_hasNowts:  strings.Contains(R.p.filter, "{nowts}")
	if R._hasCutoff {
		_windowSeconds: (#durationSeconds & {d: R.p.window}).out
	}
	_metaLines: list.Concat([
		[if R._hasCutoff {"meta cutoff = (timestamp_unix() - \(R._windowSeconds)).ts_format(\"2006-01-02T15:04:05.000000Z\", \"UTC\")"}],
		[if R._hasNowts {"meta nowts = now().ts_format(\"2006-01-02T15:04:05.000000Z\", \"UTC\")"}],
	])
	_rootLine: [if R.p.set != _|_ {"root = " + json.Marshal(R.p.set)}, "root = {}"][0]
	_url: "${CRUD_URL}/\(R.sinkTable)?" + strings.Replace(
		strings.Replace(R.p.filter, "{cutoff}", "${! meta(\"cutoff\") }", -1),
		"{nowts}", "${! meta(\"nowts\") }", -1)
	out: {
		input: generate: {interval: R.p.interval, mapping: "root = {}"}
		pipeline: processors: [{bloblang: strings.Join(list.Concat([R._metaLines, [R._rootLine]]), "\n")}]
		output: retry: {
			max_retries: 3
			backoff: {initial_interval: "2s", max_interval: "30s", max_elapsed_time: "3m"}
			output: http_client: {
				url: R._url
				verb: [if R.p.action == "delete" {"DELETE"}, "PATCH"][0]
				if R.p.action == "update" || R.authOn {
					headers: {
						if R.p.action == "update" {
							"Content-Type": "application/json"
						}
						if R.authOn {
							Authorization: "Bearer ${SERVICE_JWT}"
						}
					}
				}
				successful_on: [200, 204]
			}
		}
	}
}

// A drain's stream: a change to one of its tables and the stream's start
// become the same call, and anything else is dropped, a message that is not
// JSON included. Whatever arrives within a second of
// the first is one batch and one call, so a burst of queue rows, and the
// deletes the call itself makes of them, cost a call per batch rather than per
// row. Those deletes are what wake it again while work remains, and the call
// that finds none changes nothing, so an idle stack calls nothing.
#rpkDrain: R={
	d:      #Drain
	app:    string
	authOn: *false | bool // same service-token contract as #rpkPipeline
	out: {
		input: broker: inputs: [
			{redis_streams: {
				url: "${REDIS_URL}"
				streams: ["cdc-events"]
				body_key:       "data"
				consumer_group: "\(R.app)-\(R.d.name)"
			}},
			// Rows queued before change capture began, or while the stream was
			// down past the bus's retention, were never heard.
			{generate: {count: 1, interval: "", mapping: "root = {\"wake\": \"start\"}"}},
		]
		input: processors: (#cdcTraceJoin & {consumer: "\(R.app)-\(R.d.name)"}).out
		pipeline: {
			threads: 1
			processors: [{mapping: """
				let row = this.catch({})
				let table = $row.data.or("").parse_json().catch({}).\(_cdcTableField).or("")
				root = if $row.exists("wake") || \(json.Marshal(R.d.on)).contains($table) { {"body": \(json.Marshal(R.d.body)), "trace": @traceparent.or("")} } else { deleted() }
				"""}]
		}
		output: http_client: {
			// PostgREST direct, as every stream reaches it.
			url:           "${CRUD_URL}/rpc/\(R.d.call)"
			verb:          "POST"
			timeout:       R.d.timeout
			max_in_flight: 1
			headers: {
				"Content-Type": "application/json"
				if R.authOn {
					Authorization: "Bearer ${SERVICE_JWT}"
				}
			}
			metadata:      _traceHeader
			successful_on: [200, 204]
			batching: {
				period: "1s"
				// The bodies are equal, so the batch's is one of them.
				processors: [{archive: format: "json_array"}, {resource: "cdc_trace_batch"}, {mapping: "root = this.index(0).body"}]
			}
		}
	}
}

// Every stream the transform runs, by name. A pipeline and a drain share the
// file docker/<app>-<name>.yaml, so one name for both is a conflict here.
#streams: S={
	code: _
	out: {
		for n, _ in S.code.state.pipelines {(n): "pipeline"}
		for n, _ in S.code.state.drains {(n): "drain"}
	}
}

// The shell config is a file map, not a DSL: screen semantics live in the
// generated HTML/CSS/Jessie themselves; this only wires routes, data files,
// and pipeline topology to the filesystem. All paths are app-relative — the
// same path language as the manifest.
#shellConfig: S={
	code!: _
	migrations: [...string]
	// The terminal's measured floors, carried into the file visual lint
	// reads. #scale publishes the same struct as --min-*, so the rung an author
	// is sent to and the threshold a tap target is held to are one declaration.
	floors: [string]: int
	// The terminal's hatch seats, for the detail grammar an answer crosses in.
	hatch: [string]: {detail: {keys: int, ...}, ...}
	// The terminal's presenter offer: the pinned scripts' integrity, the
	// policy both doors send with the presenter's worker script, and the
	// fetch destinations they answer from static files only.
	presenter: {policy: string, scripted: [...string], scripts: [string]: string}
	// Whether the cluster runs an auth and a crud service: #serverOn, the
	// predicate that emits them, carried into the file visual lint reads.
	server: bool
	// Whether the app claims a native host beside the web one, carried into the
	// file the parity check reads to know a route's affordances are owed a peer.
	native: bool
	// The tables the terminal registers, each with the durability it builds
	// the collection from (#App.#collections says which).
	_tables: {for t, _ in S.code.#collections {(t): true}}
	_tablePath: {for t, n in S.code.#collections {(t): S.code.state.entities[n].durability}}

	// Browser-only durabilities. They are collections like any other — read by a
	// data-live region, mutated by a form — but the terminal builds them from
	// a local factory instead of an Electric shape, so they cannot be listed
	// among the tables it subscribes.
	_localTables: {for _, e in S.code.state.entities if !e.server {(e.table): true}}
	_local: {for t, p in S._tablePath if S._localTables[t] != _|_ {(t): p}}
	_tableKeys: {for t, n in S.code.#collections {(t): S.code._readKey[n]}}
	_nonIdKeys: {for t, k in S._tableKeys if k != "id" {(t): k}}
	// Natural keys only: a partial unique (`where:`) witnesses a slot's
	// cardinality but cannot resolve an upsert, so it stays out of `uniques:`.
	_naturalKeys: {for _, e in S.code.state.entities {(e.table): [for u in e.uniques if u.where == _|_ {u.cols}]}}
	_uniqueTables: [for t, ks in S._naturalKeys if len(ks) > 0 {t}]
	// Partial uniques travel apart, as the whole invariant: the terminal
	// reconciles surviving browser-durability rows against them at first load.
	_partialUniques: {for _, e in S.code.state.entities {(e.table): [for u in e.uniques if u.where != _|_ {cols: u.cols, where: u.where}]}}
	_partialTables: [for t, ps in S._partialUniques if len(ps) > 0 {t}]
	// A local table's `required: false` columns and their types, which the
	// terminal fills on stored rows that predate them (data-sync.js fill).
	// Server tables are left out: Postgres answers a missing value as null.
	_optional: {for _, e in S.code.state.entities if S._local[e.table] != _|_ {(e.table): [for f in e.fields if !f.required && !f.retired {name: f.name, type: f.type}]}}
	_optionalTables: [for t, cs in S._optional if len(cs) > 0 {t}]
	// What the terminal's own checks judge an app against: the columns a filter
	// may name, the pk, unique field or declared unique that witnesses a slot's
	// cardinality, the durability and type a machine region's writes are held to, the
	// values a data-when may state (check-markup.ts), and the domain a generated row's
	// column is drawn from (check-battery.ts). Scoped to the
	// tables the terminal registers, and to the field attributes those checks
	// read — shell.yaml carries one projection of the program per reader, and
	// this is the terminal's.
	//
	// `enum` and `bounds` are the two halves of one answer, apart because they
	// are read apart: the closed set a markup rule holds a data-when to, and
	// everything an open constraint still says about a value — which only the
	// battery asks for, and which it takes as one object.
	_schema: {for _, e in S.code.state.entities if S._tables[e.table] != _|_ {
		(e.table): {
			durability: e.durability
			// A retired field is a column the database keeps and an ordinal the
			// program remembers; the bundle is told of neither.
			fields: [for f in e.fields if !f.retired {
				name:     f.name
				type:     f.type
				required: f.required
				if f.type == "decimal" {precision: f.precision, scale: f.scale}
				if f.pk {pk: true}
				if f.ref != _|_ {ref: f.ref}
				if f.unique != _|_ {unique: f.unique}
				let column = #machineColumn & {entityName: e.name, entityTable: e.table, fieldName: f.name, columns: S.code._machineColumns}
				if f.default != _|_ {
					defaulted: true
					let literal = #literalDefault & {sql: f.default, type: f.type}
					if literal.admitted != _|_ if literal.admitted {default: literal.value}
				}
				if f.default == _|_ if column.initial != _|_ {defaulted: true, default: column.initial}
				if f.cel == _|_ if column.states != _|_ {enum: column.states}
				if e.cel.enums[f.name] != _|_ {enum: e.cel.enums[f.name]}
				if e.cel.bounds[f.name] != _|_ {bounds: e.cel.bounds[f.name]}
			}]
			if len(e.uniques) > 0 {
				uniques: [for u in e.uniques {
					name: u.name
					cols: u.cols
					if u.where != _|_ {where: u.where}
				}]
			}
		}
	}}
	_validatedTables: [for _, e in S.code.state.entities if S._tables[e.table] != _|_ if len([for n, _ in e.validations {n}]) > 0 {e.table}]
	// A browser tier has no read mode to compare.
	_lazy: {for _, e in S.code.state.entities if S._tables[e.table] != _|_ if e.server if e.read == "lazy" {(e.table): "lazy"}}
	// The seeds #appMigrations.seeded leaves out: a browser durability has no
	// migration to render into, so the terminal is told the rows instead.
	_localSeeds: {for _, e in S.code.state.entities if S._local[e.table] != _|_ if len(e.seed) > 0 {(e.table): e.seed}}
	_seededLocal: [for t, _ in S._localSeeds {t}]
	_unitNames: [for n, _ in S.code.capabilities.vendored {n}]
	_access: {for _, e in S.code.state.entities if S._tables[e.table] != _|_ if e.access != _|_ {
		(e.table): {
			scope: e.access.scope
			if e.access.scope == "private" {
				owner: e.access.owner
				if e.access.shared != _|_ {shared: e.access.shared}
			}
			if e.access.scope == "folder" {
				parent: S.code.state.entities[e.access.parent].table
				on:     e.access.on
			}
		}
	}}
	if S.code.meta.i18n != _|_ {
		// Every route's pattern in every declared locale, WITHOUT the locale
		// prefix — routeHref composes that from i18n.locales[tag].path. Only
		// the first segment translates; the rest, literal or `:param`, are
		// carried verbatim. An unslugged route keeps its authored pattern in
		// every locale, which is what the default says.
		_pattern: {for n, s in S.code.surface.screens {
			(n): {for tag, _ in S.code.meta.i18n.locales {
				(tag): (#localePattern & {screen: s, i18n: S.code.meta.i18n, "tag": tag}).out
			}}
		}}
		// The routes of one locale, keyed by the pattern they resolve to, which
		// is what makes two decidable constraints cue errors at emission rather
		// than live 404s: within a locale no two routes may share a pattern,
		// and no default-locale pattern may be a declared locale's own prefix —
		// or /es is both the Spanish home and the route whose Portuguese slug
		// is `es`. Both hold over ALL routes, slugged and not, because after
		// the prefix is stripped they are matched from one table.
		//
		// `routes` reads each address back out of here rather than off
		// `_pattern`, so emitting a route is what runs the checks.
		_seen: {for tag, _ in S.code.meta.i18n.locales {
			(tag): {
				for n, _ in S.code.surface.screens {(S._pattern[n][tag]): n}
				if tag == S.code.meta.i18n.default {
					for t, l in S.code.meta.i18n.locales {("/" + l.path): "\(t) prefix"}
				}
			}
		}}
		_addressOf: {for n, _ in S.code.surface.screens {
			(n): {for tag, t in S._seen {(tag): [for p, sn in t if sn == n {p}][0]}}
		}}
	}
	out: {
		app:    S.code.meta.name
		floors: S.floors
		server: S.server
		if S.native {
			native: true
		}
		if S.code.capabilities.auth != _|_ {
			// A provider's settings are the cluster's (#signIn); the auth image and env files too.
			auth: {for k, v in S.code.capabilities.auth if k != "image" && k != "envFiles" && k != "provider" {(k): v}}
		}

		// Projected, not copied: the catalogues are the emitter's input and the
		// resolved patterns on each route are what survives them.
		if S.code.meta.i18n != _|_ {
			i18n: {default: S.code.meta.i18n.default, locales: S.code.meta.i18n.locales}
		}

		// Optional keys are emitted only where they differ from the default,
		// so shell.yaml stays stable for the ordinary screen.
		routes: [for n, s in S.code.surface.screens {
			path:   s.route
			screen: s.name
			// `path` IS the default locale's pattern, not a second spelling
			// beside it: unifying the two makes a slugged route whose authored
			// first segment disagrees with the default catalogue's value a cue
			// error rather than a live 404. An unslugged route resolves to what
			// it authored, so the unification is an identity.
			if S.code.meta.i18n != _|_ {
				path: S._addressOf[n][S.code.meta.i18n.default]
			}

			// Emitted iff a slug is declared: every declared tag, the default
			// included, and each pattern WITHOUT the locale prefix.
			if s.slug != _|_ {
				slug:  s.slug
				paths: S._addressOf[n]
			}
			if s.prerender {
				prerender: true
			}
			if [if S.code.capabilities.auth != _|_ if S.code.capabilities.auth.required {false}, true][0] if s.access == "private" {
				access: "private"
			}
			if s.ssr != _|_ {
				ssr: s.ssr
			}

			// `label` is the default-language spelling and the whole of what an
			// app with no catalogues carries; `key` names the word in each
			// catalogue, which the strip reads as a screen reads one.
			nav: {
				label: s.title
				if s.label != _|_ {key: s.label}
				if !s.strip {strip: false}
			}
			if len(s.hatches) > 0 {hatches: s.hatches}
			files:  s.files
			states: s.states // storybook frame list; semantics stay in the ir storyboard
			if s.keep != 1 {
				keep: s.keep
			}
		}]
		tables: list.SortStrings([for t, _ in S._tables if S._local[t] == _|_ {t}])
		if len(S._local) > 0 {
			local: S._local
		}

		// Unguarded, unlike the optional keys below: a markup rule's schema is
		// what makes its findings true, and a checker reading an absent key
		// would grade every screen against an app that declares nothing.
		schema: S._schema

		// The type table (types.cue), served rather than restated. The
		// client canonicalizes a value with code — Electric hands it an
		// interval as `PT30M` — and judges the result by the entry here, so
		// what canonical IS has one statement and the transformations have no
		// say in it. A holder meeting a `beyond` name it does not implement
		// refuses the table.
		types: {
			types:   #types
			aliases: #typeAlias
		}
		carriers: types

		// Primary key per table, only where it is not "id": the terminal's
		// synced collections key rows by it (a pipeline sink like note_progress
		// keys on its subject column, and keying such a table on the missing
		// "id" collapses every row onto one key).
		if len(S._nonIdKeys) > 0 {
			keys: S._nonIdKeys
		}

		// The tables the terminal reads lazily (#Entity.read): it opens their
		// shapes from now and loads each view's rows as a subset. Every other
		// table is read whole, so only these are named.
		if len(S._lazy) > 0 {
			read: S._lazy
		}

		// RLS mirror for the terminal, in table-name space (through-parents
		// resolved). The Electric sync plane is unscoped in the dev cluster,
		// so the terminal must re-apply row visibility on every collection
		// read — without this map, every browser renders every user's rows.
		if len(S._access) > 0 {
			access: S._access
		}

		// Natural keys, so the terminal can resolve a row the way the database
		// would: an upsert writes "the row for this key", which is a local
		// question the collection already answers. Guarded on a LIST: len() over
		// the struct a comprehension builds reads as incomplete in cue 0.16.
		if len(S._uniqueTables) > 0 {
			uniques: {
				for t, ks in S._naturalKeys if len(ks) > 0 {
					(t): ks
				}
			}
		}
		if len(S._partialTables) > 0 {
			partialUniques: {
				for t, ps in S._partialUniques if len(ps) > 0 {
					(t): ps
				}
			}
		}
		if len(S._optionalTables) > 0 {
			optional: {
				for t, cs in S._optional if len(cs) > 0 {
					(t): cs
				}
			}
		}
		if len(S._validatedTables) > 0 {
			validations: {
				for _, e in S.code.state.entities if S._tables[e.table] != _|_ for n, v in e.validations {
					(e.table): {(n): {src: v.src, edges: v.edges, on: v.on, order: v.order, machine: v.machine}}
				}
			}
		}
		if len(S._seededLocal) > 0 {
			seed: S._localSeeds
		}

		if len([for h in S.code.capabilities.hatches if h.kind == "host-dom" {h}]) > 0 {
			hostDom: {for hn, h in S.code.capabilities.hatches if h.kind == "host-dom" {(hn): {src: h.src, note: h.note}}}
		}

		// The units a data-hatch may name, and what the terminal is allowed to
		// do for each: the boundary to mount it behind, its ports as the
		// terminal speaks them — the tables whose row it may be fed, the events
		// it may raise — and the entry point to load. The rest of `files` is
		// served, not declared — a unit fetches its own siblings by name.
		if len(S._unitNames) > 0 {
			units: {
				for n, v in S.code.capabilities.vendored {
					(n): {
						isolation: v.isolation
						ports: {
							reads: [for r in v.ports.reads {S.code.state.entities[r].table}]
							raises: v.ports.raises
						}
						// The memo as the terminal performs it: the table, the key
						// and every column an answer fills — in one event, whose
						// detail is the seat's offer: at most `keys` columns, each
						// named by `key`, each value at most `value` characters,
						// held here as far as the program states it (a column's
						// declared size bound); the alphabet, and the length of a
						// column the program leaves unbounded, are the seat's
						// refusal at runtime.
						if v.memo != _|_ {
							memo: {
								let _me = S.code.state.entities[v.memo.entity]
								table: _me.table
								key:   v.memo.key
								let _columns = [for f in _me.fields if !f.pk if !f.retired {f.name}]
								let _detail = S.hatch[v.isolation].detail
								let _unfit = list.Concat([
									[if len(_columns) > _detail.keys {"unit \(n) memo on \(v.memo.entity) has \(len(_columns)) columns, and the \(v.isolation) seat carries an answer of at most \(_detail.keys)"}],
									[for c in _columns if c !~ _detail.key {"unit \(n) memo on \(v.memo.entity): column \(c) is not a name the \(v.isolation) seat's detail carries (\(_detail.key))"}],
									[for c in _columns if _me.cel.bounds[c].sizeMax != _|_ if _me.cel.bounds[c].sizeMax > _detail.value {"unit \(n) memo on \(v.memo.entity): column \(c) admits \(_me.cel.bounds[c].sizeMax) characters, and the \(v.isolation) seat carries a value of at most \(_detail.value)"}],
								])
								columns: [if len(_unfit) == 0 {_columns}, _unfit[0]][0] & [...string]
							}
						}
						if v.role == "presenter" && v.isolation == "agent" {
							role: "presenter"
							scripts: [for u in v.scripts {url: u, integrity: S.presenter.scripts[u]}]
							// What it may read through the seat: its own files, and
							// the objects a blob seed ships by content address.
							files: v.files
							seed:  S.code.capabilities.blobSeed != _|_
						}
						src: v.src
					}
				}
			}
		}
		// Each kinetic child the terminal mounts on a data-kinetic, as it
		// loads them: the linked graphs, the presenter unit, the mappers.
		let _kinetic = {if S.code.state.cortex != _|_ for _, c in S.code.state.cortex for n, a in c.setup.actors if a.via == "kinetic" {(n): a}}
		if len(_kinetic) > 0 {
			kinetic: {for n, a in _kinetic {(n): {
				engine: "shell/engines/\(a.engine).json"
				if a.sound != _|_ {sound: "shell/engines/\(a.sound).json"}
				presenter: a.presenter
				bindings:  a.bindings
				if a.seats != _|_ {seats: a.seats}
				menu:  a.menu
				pause: a.pause
			}}}
			// The ICE servers its online race gathers over: none in a dev or
			// CI stack, the release target's in a release (distribution's
			// #IceServers, written as the tree is addressed).
			iceServers: []
		}
		// The worker script's own policy, which an edge door sends as a
		// header the way the container door's Caddyfile does, and the
		// destinations its Worker refuses.
		if len([for _, v in S.code.capabilities.vendored if v.role == "presenter" && v.isolation == "agent" {v}]) > 0 {
			presenter: policy:   S.presenter.policy
			presenter: scripted: S.presenter.scripted
		}
		if S.code.surface.endowments != _|_ {
			endowments: S.code.surface.endowments
		}
		"migrations": S.migrations
		pipelines: [for _, p in S.code.state.pipelines {
			if p.trigger == "cdc" if p.raw == _|_ {
				name:      p.name
				from:      S.code.state.entities[p.from].table
				to:        S.code.state.entities[p.to].table
				aggregate: p.transform.aggregate
				if p.fold == _|_ {shim: p.shim}

				// A fold names its module rather than a shim. The terminal's
				// projection of the synced sink counts contributions and does not
				// run the module (docs/pipelines-and-schedules.md#below-the-cluster).
				if p.fold != _|_ {
					fold:      p.fold.src
					projects:  p.fold.projects
					watermark: p.fold.watermark
					dedupe:    p.fold.dedupe
					retracted: p.fold.retracted
					pair:      p.fold.pair
				}
				if p.key != _|_ {key: p.key}
			}
			if p.trigger == "schedule" {
				name:    p.name
				to:      S.code.state.entities[p.to].table
				trigger: "schedule"
			}

			// Raw pipelines have no shim: the terminal lists them and skips.
			if p.raw != _|_ {
				name: p.name
				to:   S.code.state.entities[p.to].table
				raw:  true
			}
		}]
	}
}

// The providers the cluster's auth service signs in through, each with the
// settings the app gives it as the deployment's defaults.
#signIn: S={
	auth: _
	out: {for p in S.auth.providers {
		(p): {}
		if S.auth.provider != _|_ if S.auth.provider[p] != _|_ {
			(p): S.auth.provider[p]
		}
	}}
}

// Whether an app's cluster keeps server-side state: an entity of a cluster durability,
// or auth, which is identity the cluster keeps. The one predicate the cluster's
// services, its migrations and the emitted shell.yaml all follow.
#serverOn: S={
	// Only what the answer reads, so a caller hands over no seed rows.
	servers: [...bool]
	auth: bool
	out:  list.Contains(S.servers, true) || S.auth
}

#appMigrations: M={
	code!: _
	_validatedTables: [for _, e in M.code.state.entities if e.server if len([for n, _ in e.validations {n}]) > 0 {e.table}]
	seeded: [for _, e in M.code.state.entities if len(e.seed) > 0 if e.server {e}]
	_seedFile: len(M.seeded) > 0 || M.code.state.seed != _|_
	accessed: [for _, e in M.code.state.entities if e.access != _|_ {e}]
	machines: [if M.code.state.machines != _|_ {[for _, m in M.code.state.machines for en, e in M.code.state.entities if en == m.entity || e.table == m.entity if e.server {m}]}, []][0]
	raw: [if M.code.state.rawMigrations != _|_ {M.code.state.rawMigrations}, []][0]
	// The cluster copies this list into its database image, so it follows the
	// predicate that emits the database: a migration named without one would be
	// a copy into a target that was never emitted.
	_server: (#serverOn & {servers: [for _, e in M.code.state.entities {e.server}], auth: M.code.capabilities.auth != _|_}).out
	list: [for f in M._all if M._server {f}]
	_all: [
		"services/database/migrations/000_extensions.sql",
		"services/database/migrations/001_roles.sql",
		"services/database/migrations/002_grants.sql",
		"services/database/migrations/004_types.sql",
		"services/database/migrations/005_create_tables.sql",
		if len(M.accessed) > 0 {"services/database/migrations/006_policies.sql"},
		"services/database/migrations/007_txid.sql",
		"services/database/migrations/008_publication.sql",
		if len(M._validatedTables) > 0 {"services/database/migrations/009_validations.sql"},
		if len(M.machines) > 0 {"services/database/migrations/010_machines.sql"},
		if M.code.state.hybrids != _|_ {"services/database/migrations/016_mecha_actors.sql"},
		for r in M.raw {"services/database/migrations/\(r.name)"},
		if len(M.code.state.schedules) > 0 {"services/database/migrations/801_schedule_seed.sql"},
		if M._seedFile {"services/database/migrations/900_seed.sql"},
		if M.code.state.fixture != _|_ {"services/database/migrations/950_fixture.sql"},
	]
}

// The blob plane's gate (assets/Caddyfile's /blobs), which caddy asks through
// the REST gateway before a request reaches the store, since the store
// authorizes nothing (mecha's docs/capabilities.md#the-blob-plane). A signed-in
// account may PUT a picture under its own id, and nothing else passes: the store
// is never listed, read, emptied or written under another's name through the
// door, and pictures are read through /img, which transcodes them. A refusal is
// the gateway's own status: 401 without an account, 403 for the rest.
#blobGateSql: """
	CREATE OR REPLACE FUNCTION public.blob_gate() RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $gate$
	DECLARE
	  h jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
	  guest boolean := coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'guest')::boolean, false);
	BEGIN
	  IF auth_uid() IS NULL OR guest THEN
	    RAISE SQLSTATE 'PT401' USING MESSAGE = 'an account uploads';
	  END IF;
	  IF h->>'x-forwarded-method' IS DISTINCT FROM 'PUT'
	    OR coalesce(h->>'x-forwarded-uri', '') !~ ('^/blobs/mecha-objects/' || auth_uid()::text || '/[0-9a-f-]{36}[.](png|jpg|jpeg|webp)$')
	    -- S3's own headers would make the PUT something else: a copy of another object
	    -- (x-amz-copy-source) past the size bound, say. Only a request's signing ones pass.
	    OR EXISTS (SELECT FROM jsonb_object_keys(h) k WHERE k LIKE 'x-amz-%' AND k NOT IN ('x-amz-content-sha256', 'x-amz-date')) THEN
	    RAISE SQLSTATE 'PT403' USING MESSAGE = 'an account writes a picture under its own id, and nothing else';
	  END IF;
	  RETURN true;
	END $gate$;
	REVOKE ALL ON FUNCTION public.blob_gate() FROM PUBLIC;
	GRANT EXECUTE ON FUNCTION public.blob_gate() TO anon, app_user;
	"""

// Default runtime instances, parameterized by the code. program.cue wires
// them; overrides land in bayt.cue by unification.
//
// An input its caller built against its definition (code, cluster, loop,
// terminal, build) is taken as `_` here, in #emit and in the helpers above:
// restating the definition unifies the whole value again in each consumer.
// #emit keeps cluster and loop typed because it declares fields into them.
#DefaultLoop: D={
	code!:     _
	cluster!:  _
	terminal!: _
	out: prontoloop.#Loop & {
		meta: app: D.code.meta.name
		surface: {
			_distribution: distribution.#Project & {
				if D.code.meta.domain != _|_ {
					domain: "\(D.code.meta.domain)"
				}
				if D.code.meta.edgeClock != _|_ {
					edgeClock: D.code.meta.edgeClock
				}
				if D.code.meta.ssrOrigin != _|_ {
					ssrOrigin: D.code.meta.ssrOrigin
				}
				// What only the cluster's streams and computations write lands in
				// live tables, which the page ships as they stood at bundling.
				if len(D.code.state.pipelines)+len(D.code.state.drains)+len(D.code.state.computations) > 0 {
					derived: {
						tables: list.SortStrings([for _, e in D.code.state.entities if e.durability == "live" {e.table}])
						streams: list.SortStrings([for n, _ in (#streams & {code: D.code}).out {"\(D.code.meta.name)-\(n)"}])
					}
				}
			}
			buildCmd: "./saytw build"
			testCmd: "deno eval 0"
			pipelineFiles: [for n, _ in (#streams & {code: D.code}).out {"docker/\(D.code.meta.name)-\(n).yaml"}]
			// Both runtimes declare checks about their own surfaces; the loop
			// routes each to the verb it names. A name collision across the two
			// is a conflict here rather than a silent overwrite.
			verbs: {
				for name, c in D.cluster.surface.verbs {(name): c}
				for name, c in D.terminal.surface.verbs {(name): c}

				// The pages target: the bundle is the artifact, and the tag pushed
				// is what makes the app's mirror bundle it again and deploy it.
				// The tags on HEAD under this app's prefix are release.nu's own
				// reading of what it just created.
				if list.Contains(D.code.meta.targets, "pages") {
					pages: {
						verb:     "release"
						platform: "pages"
						cmds: [if len(_distribution.derived.tables) > 0 {_distribution.derive}, _distribution.bundle]
						publish: ["use semver.nu [tag-on-head]; let tag = (tag-on-head); if ($tag | is-empty) { error make {msg: \"no release tag on HEAD to push\"} }; git push origin $tag"]
						note: "Pronto release@pages"
					}
				}
				// The edge target: mecha's edge cluster in one Durable Object,
				// where the app's machines step and their deadlines are its alarm.
				if list.Contains(D.code.meta.targets, "cloudflare") {
					cloudflare: {
						verb:     "release"
						platform: "cloudflare"
						note:     "Pronto release@cloudflare"
						cmds: [if len(_distribution.derived.tables) > 0 {_distribution.edgeDerive}, _distribution.edge]
						publish: [_distribution.publishEdge]
					}
				}
				if list.Contains(D.code.meta.targets, "docker") {
					docker: {
						verb:     "release"
						platform: "docker"
						note:     "Pronto release@docker"
						cmds: [_distribution.docker]
						publish: [_distribution.publishDocker]
					}
				}
			}
			checks: {
				for name, c in D.cluster.surface.checks {(name): c}
				for name, c in D.terminal.surface.checks {(name): c}
				for name in ["derive", "types", "proto"] {
					(name): {verb: "lint", cmds: [_distribution.checks[name]], note: "Pronto compiler \(name)"}
				}
				facts: {verb: "lint", priority: 1, cmds: [_distribution.checks.facts], note: "Pronto compiler facts"}
				// Only where there is SQL to read: an app whose every entity is
				// a browser durability emits no migration and authors none, so the
				// pass would grade an empty set.
				if len([for _, e in D.code.state.entities if e.server {e}]) > 0 {
					sql: {verb: "lint", cmds: [_distribution.checks.sql], note: "Pronto compiler sql"}
					replay: {
						verb: "integrate"
						cmds: [(omnishell.#BkidCheck & {runner: "ci-replay"}).out]
						note: "Pronto compiler replay"
					}
				}

				// Only where something was minted: an app with no identities has
				// none to lose, and the check would grade an empty snapshot.
				if len([for _, e in D.code.state.entities if e.id != _|_ {e}]) > 0 {
					identity: {verb: "lint", cmds: [_distribution.checks.identity], note: "Pronto compiler identity"}
				}

				// What a Mecha machine can do, over its declarations.
				if D.code.state.hybrids != _|_ {
					hybrids: {verb: "lint", cmds: [_distribution.checks.hybrids], note: "Pronto Mecha machines"}
				}

				// A computation's tests run it as mecha's compute service does.
				if len(D.code.state.computations) > 0 {
					computations: {verb: "test", cmds: [_distribution.checks.computations], note: "Pronto computations"}
					admit: {
						verb: "lint"
						cmds: [strings.Join([_distribution.checks.admit, for _, c in D.code.state.computations {
							json.Marshal([if len(c.endowments) > 0 {"\(c.src)=\(strings.Join(c.endowments, ","))"}, c.src][0])
						}], " ")]
						note: "Pronto computations admitted"
					}
				}
				if D.code.state.effects != _|_ if len(D.code.state.effects) > 0 {
					admitEffects: {verb: "lint", cmds: [_distribution.checks.admitEffects], note: "Pronto effect handlers admitted"}
				}
			}
			// A deploy, not a published version: its rule is the release
			// engine alone, so it carries none of release.nu's versioning
			// and its flags (--dry-run, --snapshot) reach that engine.
			if list.Contains(D.code.meta.targets, "k8s") {
				sayYaml: say: release: rulemap: k8s: {platform: "k8s", cmds: [{do: _distribution.k8s}]}
			}
			// The same for the cloud tier on GCP: a deploy, not a version. The
			// release goes behind its integration tests, run against a preview of
			// what it deploys rather than a stack on this machine (release.nu):
			// the drivers integrate runs that read APP_URL, which verify@gcp runs
			// alone against the release or a named preview (verify.nu).
			if list.Contains(D.code.meta.targets, "gcp") {
				sayYaml: say: release: rulemap: gcp: {platform: "gcp", cmds: [{do: _distribution.gcp}]}
				sayYaml: say: verify: rulemap: gcp: {platform: "gcp", cmds: [{do: _distribution.gcpVerify}]}
			}
			// The cluster on this machine, each service a process
			// (.bayt/process-compose.yaml), where `launch` alone runs it in
			// containers.
			sayYaml: say: launch: rulemap: local: {platform: "local", priority: -1, stop: true, cmds: [{do: (_distribution.launchLocal & {prepare: D.cluster.surface.hostPrepare}).out}]}
			// Post-release verification across live deployments.
			if list.Contains(D.code.meta.targets, "pages") {
				sayYaml: say: verify: rulemap: pages: {platform: "pages", cmds: [{do: _distribution.verifyPages}]}
			}
			if list.Contains(D.code.meta.targets, "cloudflare") {
				sayYaml: say: verify: rulemap: cloudflare: {platform: "cloudflare", cmds: [{do: _distribution.verifyEdge}]}
			}
			if list.Contains(D.code.meta.targets, "k8s") {
				sayYaml: say: verify: rulemap: k8s: {platform: "k8s", cmds: [{do: _distribution.verifyK8s}]}
			}
			// verify@gcp is the fork's own (above): the drivers against a deployed copy, which
			// release@gcp's gate runs. Upstream's live check for gcp (verifyGcp) is not wired.
			sayYaml: say: {
				lint: rulemap: cue: cmds: [{do: "mise exec -- cue vet -c ./..."}]
				build: _distribution.say.say.build
				generate: rulemap: {
					pronto: _distribution.say.say.generate.rulemap.pronto
					"auto-bayt": {priority: 2, cmds: [{use: "./auto-bayt.nu", do: "auto-bayt"}]}
				}
			}
			sayYaml: _distribution.say
		}
	}
}

#DefaultBuild: D={
	code!:    _
	loop!:    _
	cluster!: _
	// The terminal, whose own statics the build serves from omnishell's image.
	terminal!: _
	out: prontobuild.#Build & {
		"cluster":       D.cluster
		terminalStatics: [for s in D.terminal.surface.statics {file: s.file, target: s.target}]
		project: files: "checks.yaml": D.loop.surface.sayYaml
		// The compose files sit in .bayt/, one level under the app.
		if D.code.capabilities.auth != _|_ if D.code.capabilities.auth.envFiles != _|_ {
			project: targets: auth: compose: env_file: [for f in D.code.capabilities.auth.envFiles {path: "../\(f)", required: false}]
		}
		meta: {
			app:         D.code.meta.name
			generateCmd: distribution.#Project.compiler
			testCmd:     D.loop.surface.testCmd
			targets:     D.code.meta.targets
		}
	}
}

#DefaultTerminal: D={
	code!:       _
	boot?:       string
	// An adapter the terminal serves is the terminal's file and not the app's,
	// so only an app's own module joins the set. A declared handler is served
	// whether or not markup binds it: an app module may fetch one itself.
	_handlerSet: {
		for _, h in D.code.surface.handlers {(h.src): true}
		for _, s in D.code.surface.screens for i in s.files.handlers {(i): true}
		for _, s in D.code.surface.screens for i in s.files.adapters if !strings.HasPrefix(i, "/") {(i): true}
	}
	_sharedSet: {for _, s in D.code.surface.screens for i in s.files.shared {(i): true}}
	_rendererSet: {for _, s in D.code.surface.screens if s.files.renderers != _|_ for i in s.files.renderers {(i): true}}
	_unitSet: {for _, v in D.code.capabilities.vendored for f in v.files {(f): true}}
	_validationSet: {for _, e in D.code.state.entities for _, v in e.validations {(v.src): true}}
	// The prerendered screens, each refused where its first view reads rows
	// the server holds: its document is drawn before any read lands, so those
	// rows push down whatever follows them when they do, and one rendered on
	// request draws them in place. A tab or device read is the browser's, and
	// its region the terminal's renderer judges: one that names the row it
	// shows until its read lands (data-empty-row) is drawn from it, and one
	// that draws nothing until then is refused there (render-documents.ts).
	_prerendered: [
		for n, s in D.code.surface.screens if s.prerender
		let rows = list.SortStrings([for e, _ in {for r in s.reads let en = D.code._entityByTable[r.table] if D.code.state.entities[en].server {(en): true}} {e}]) {
			[
				if len(rows) > 0 {error("screen \(n) is prerendered over rows the server holds (\(strings.Join(rows, ", "))): its document is drawn before they land and moves when they do; declare ssr: \"ssr\" (plugins/pronto/docs/screens.md#how-a-routes-first-document-is-rendered)")},
				if s.access == "private" {error("screen \(n) is private and declares prerender; a document written at generate is served to everyone")},
				s,
			][0]
		},
	]
	out: omnishell.#Terminal & {
		app:         D.code.meta.name
		description: D.code.meta.description
		if D.code.meta.i18n != _|_ {
			language: D.code.meta.i18n.default
			// The base language decides, because a tag's region never does.
			if list.Contains(omnishell.#RtlLanguages, strings.Split(D.code.meta.i18n.default, "-")[0]) {
				direction: "rtl"
			}
		}
		surface: {
			if D.boot != _|_ {
				assets: boot: D.boot
			}
			screens: [for _, s in D.code.surface.screens {name: s.name, html: s.files.html, css: s.files.css, shared: s.files.shared}]
			handlers: list.SortStrings([for i, _ in D._handlerSet {i}])
			renderers: list.SortStrings([for i, _ in D._rendererSet {i}])
			// The union of what screens import, so the served set is exactly what
			// something references — an unreferenced file under shell/shared/ is
			// never built and cannot pretend to be part of the app.
			shared: list.SortStrings([for i, _ in D._sharedSet {i}])
			folds: list.SortStrings([
				for _, pl in D.code.state.pipelines if pl.fold != _|_ {pl.fold.src},
			])
			validations: list.SortStrings([for s, _ in D._validationSet {s}])
			hostDom: list.SortStrings([for f, _ in {for _, h in D.code.capabilities.hatches if h.kind == "host-dom" for f in h.files {(f): true}} {f}])
			engines: list.SortStrings([for n, _ in D.code.surface.engines {"shell/engines/\(n).json"}])
			// A unit's whole directory, not just its src: the wrapper's own
			// imports are files the browser fetches by name.
			units: list.SortStrings([for f, _ in D._unitSet {f}])
			messages: [
				if D.code.meta.i18n != _|_ for tag, _ in D.code.meta.i18n.locales {
					"messages/\(tag).json"
				},
			]
			// Every address a prerendered route answers at, in every locale.
			// An app behind a sign-in serves every address its login wall, so
			// it renders none.
			if !D._walled {
				documents: list.SortStrings([
					for s in D._prerendered if D.code.meta.i18n == _|_ {s.route},
					for s in D._prerendered if D.code.meta.i18n != _|_
					for tag, _ in D.code.meta.i18n.locales {
						(#address & {route: path: (#localePattern & {screen: s, i18n: D.code.meta.i18n, "tag": tag}).out, i18n: D.code.meta.i18n, "tag": tag}).out
					},
				])
			}
		}
	}
	_walled: [if D.code.capabilities.auth != _|_ if D.code.capabilities.auth.required {true}, false][0]
}

#DefaultCluster: D={
	code!: _
	statics: [...mecha.#Static]

	// The review ladder's artifacts, served beside the app by caddy's catch-all
	// /srv root. One directory is load-bearing, not tidiness: brief.html links
	// `ir.html`, its wikilinks render as `ir.html#Id`, and its transclusions
	// `fetch` their target by bare relative path — all three resolve only if the
	// four files are siblings. Served, the transclusion inlines instead of
	// degrading to the boxed link it shows on file://.
	//
	// These are caddy statics, so they sit outside the terminal's auth gate by
	// construction. Intended: reviewing a design doc is not using the app, and
	// requiring a sign-in to read one would put the ladder behind the thing it
	// exists to review.
	_ladder: [for f in ["brief.html", "ir.html", "ir/card.css", "acceptance.md", "DESIGN.md"] {
		file:   f
		target: "/srv/docs/\(f)"
		watch:  true
	}]

	// What a crawler asks for by name. Served from the root, not under the
	// terminal's shell/ prefix: neither file is read anywhere else.
	_crawl: [
		for f in [
			"robots.txt",
			if _envelope.sitemap.enabled {"sitemap.xml"},
		] {
			file:   f
			target: "/srv/\(f)"
			watch:  true
		},
	]

	_envelope: #envelopePlan & {
		meta:         D.code.meta
		surface:      D.code.surface
		state:        D.code.state
		capabilities: D.code.capabilities
	}

	out: mecha.#Cluster & {
		meta: {
			app: D.code.meta.name
			// The database runs PLV8 where a server entity's validation or a
			// hybrid machine's rules need it (000_extensions.sql, 016's).
			plv8: len([for _, e in D.code.state.entities if e.server if len([for n, _ in e.validations {n}]) > 0 {e}]) > 0 || len([if D.code.state.hybrids != _|_ for n, _ in D.code.state.hybrids {n}]) > 0
			// The app is its build's root, and its runtime sits where mise put
			// it, outside the app: every static the cluster serves is then the
			// app's own file, fingerprinted and copied from the build context.
			root:    ""
			runtime: "../"
			// The caddy takes omnishell's own statics from its image, which the
			// build adds (builders/bayt.cue), and a host launch from the
			// omnishell mise installs; the cluster serves the app's.
			statics: list.Concat([[for s in D.statics if !strings.HasPrefix(s.target, "/omnishell/") {s}], D._ladder, D._crawl, _envelope.statics])
			toolStatics: [for s in D.statics if strings.HasPrefix(s.target, "/omnishell/") {file: s.file, target: s.target, tool: distribution.#Runtimes.omnishell}]
			// mecha's images by name, which the build resolves to the pinned
			// release or, in the monorepo, to mecha's sources; the auth
			// service's is the program's when it names one (#App
			// capabilities.auth.image).
			images: {for s in ["database", "mesh", "conduit", "auth", "ticker", "clock", "compute", "airlock"] {
				(s): [
					if s == "auth" if D.code.capabilities.auth != _|_ if D.code.capabilities.auth.image != _|_ {D.code.capabilities.auth.image},
					{name: "libraries_mecha-\(s)-image"},
				][0]
			}}
			bounds: {
				authStatementMs: resilience.resilience.timeouts.statement.client * 1000
				tickerCallMs:    resilience.resilience.timeouts.tickerCall * 1000
			}
			// Stated only where there are any: an app whose plugins still state
			// the list themselves (pronto-billing's, -flags', -perf's before
			// code.meta.hostPeers) keeps theirs.
			if len(D._hostPeers) > 0 {
				hostPeers: [for n, p in D._hostPeers {"\(n)=\(p)"}]
			}
		}
		// The cluster's auth service and JWT envs follow the program's auth
		// block; the blob plane follows the program's flag; the data plane
		// follows #serverOn, so an app with no server-side state is served by
		// caddy alone. Set here, where the instance is built, because the
		// same instance reaches the build seat and the emitter; #emit restates
		// them as constraints.
		capabilities: {
			auth:  D.code.capabilities.auth != _|_
			if D.code.capabilities.auth != _|_ if D.code.capabilities.auth.providers != _|_ {
				signIn: (#signIn & {auth: D.code.capabilities.auth}).out
			}
			blobs: D.code.capabilities.blobs
			server: (#serverOn & {servers: [for _, e in D.code.state.entities {e.server}], auth: D.code.capabilities.auth != _|_}).out
		}
		state: {
			migrations: (#appMigrations & {"code": D.code}).list
			if D.code.state.migrations != _|_ {pgroll: D.code.state.migrations}
			if D.code.state.effects != _|_ if len(D.code.state.effects) > 0 {
				effectInterpreters: strings.Join([for _, m in D.code.state.machines if m.states != _|_ if len([for _, st in m.states if st.invoke != _|_ {true}]) > 0 {
					(#mechaMachineSql & {machine: m, entities: D.code.state.entities, effects: D.code.state.effects})._effectUpgradeSql
				}], "\n\n")
			}
			pipelines: [for n, _ in (#streams & {code: D.code}).out {
				name: "\(D.code.meta.name)-\(n)"
				file: "docker/\(D.code.meta.name)-\(n).yaml"
			}]
			schedules: [for _, sc in D.code.state.schedules {sc.name}]
			(#MachineTimerState & {code: D.code}).out
			// The emitted manifest, endpoints and handlers sit where the
			// cluster looks for them by default.
			effects: [if D.code.state.effects != _|_ for n, x in D.code.state.effects {
				name: n
				if x.sink.origin != _|_ {origin: x.sink.origin}
				if x.sink.bridge != _|_ {bridge: x.sink.bridge}
				// The credential's variable is required of the environment with
				// the handler's secrets, and handed to the airlock alone.
				_secrets: [for s, _ in {for s in list.Concat([[if x.secrets != _|_ {x.secrets}, []][0], [if x.sink.credential != _|_ {[x.sink.credential.secret]}, []][0]]) {(s): true}} {s}]
				if len(_secrets) > 0 {secrets: _secrets}
			}]
			bridges: [if D.code.state.bridges != _|_ for _, b in D.code.state.bridges {b}]
			computations: [for _, c in D.code.state.computations {
				name:  "\(D.code.meta.name)-\(c.name)"
				file:  c.src
				to: [for t in c.to {D.code.state.entities[t].table}]
				wasm: c.wasm
				endowments: c.endowments
				if c.onComplete != _|_ {onComplete: c.onComplete}
				// A sink in the publication would feed the change it answers.
				_live: [for t in c.to {D.code.state.entities[t].durability & "live"}]
			}]
		}
		// The door's tree as a release (omnishell.#Address): omnishell's tree
		// from its runtime image, which the monorepo's switch builds from the
		// checkout, every static placed at its URL's path, then addressed in
		// place. The door and the renderer copy what it wrote.
		if D._terminal {
			let _served = {
				// The release target's ICE servers, for a tree a release ships.
				_iceServers: *null | [...]
				cmd: "builtin": null
				activate: ""
				let own = [for s in meta.statics if !strings.HasPrefix(s.target, "/omnishell/") {s}]
				let runtime = [for s in D.statics if strings.HasPrefix(s.target, "/omnishell/") {s}]
				srcs: globs: [for s in own {s.file}]
				dockerfile: {
					from: name: omnishell.#Address.image
					// Where bayt copies the srcs, each at its path in the app.
					workdir: "/app"
					copy: [{from: {name: omnishell.#RuntimeImage}, srcs: ["/"], dst: omnishell.#Address.home}]
					let place = [for s in list.Concat([runtime, own]) {
						let source = [
							if strings.HasPrefix(s.target, "/omnishell/") {"\(omnishell.#Address.home)/\(strings.TrimPrefix(s.target, "/omnishell/"))"},
							"/app/\(s.file)",
						][0]
						let url = [
							if strings.HasPrefix(s.target, "/srv/") {strings.TrimPrefix(s.target, "/srv")},
							s.target,
						][0]
						"install -D -m 644 '\(source)' '\(omnishell.#Address.tree)\(url)'"
					}]
					let ice = [if _iceServers != null {" --ice-servers '\(json.Marshal(_iceServers))'"}, ""][0]
					epilogue: ["RUN set -e; \(strings.Join(place, "; ")); \(omnishell.#Address.cache) && \(omnishell.#Address.run)\(ice)"]
				}
				compose: {}
			}
			surface: targets: served: _served
			meta: served: {ref: ":served", tree: omnishell.#Address.tree, scripts: omnishell.#Address.scripts}
			// The tree a container target's door serves: the door's, with the
			// target's ICE servers. release@docker's image copies it
			// (builders/bayt.cue); gcp and k8s bake the door over it
			// (k8s/release.nu release-tree).
			if len([for t in D.code.meta.targets if t == "docker" || t == "gcp" || t == "k8s" {t}]) > 0 {
				surface: targets: "served-release": _served & {
					_iceServers: distribution.#IceServers.container
					compose: manual: true
				}
			}
		}
		// The terminal's server half, where a route asks to be rendered on
		// request (#Screen.ssr; #emit decides which routes may). It reads the
		// app through the door, so it waits on the door, and the aggregate
		// waits on it: a launch is up when its documents can be answered.
		if D._rendersOnRequest {
			// A host launch runs it beside the cluster's own processes, and the
			// door proxies to it at its host address (_hostPeers).
			surface: targets: {
				render: bayt.healthcheck.http & {
					cmd: "builtin": null
					activate: ""
					// As the cluster's own processes run under process-compose: the
					// renderer from the omnishell mise installs, the entry the app's own.
					"process-compose": activate: "mise x --"
					expose: http: {port: omnishell.#Render.port, env: "PORT"}
					entrypoint: {
						do:    "entry=\"$PWD/\(omnishell.#Render.entry.source)\"; cd \"$(mise where \(distribution.#Runtimes.omnishell))\" && ENTRY=\"$entry\" ORIGIN=\"${ORIGIN:-\(D.out.meta.door.scheme)://localhost:${HOST_DOOR##*:}}\" exec deno run --frozen --config server/deno.json --allow-net --allow-env --allow-read server/render.ts"
						shell: "sh"
						dockerfile: {
							do:    strings.Join(omnishell.#Render.command, " ")
							shell: "exec"
						}
						// The origin readers reach the door at: ORIGIN where the caller
						// sets it, else the door's port on this host, which the host
						// writes for a peer's address (HOST_DOOR).
						env: {
							for k, v in compose.environment if k != "PORT" && k != "ENTRY" && k != "ORIGIN" {(k): v}
							HOST_DOOR: "caddy:\(D.out.meta.door.port)"
						}
						after: {caddy: "healthy", crud: "healthy", electric: "healthy"}
					}
					// The release it takes its entry from (a `from.ref` copy).
					deps: [":served:outs"]
					healthcheck: {
						url: omnishell.#Render.health
						// Healthy once every table has synced.
						start_period: "120s"
					}
					// It reads the app once, as it starts: its routes, screens and
					// catalogues through the door, its entry off this image. The door
					// restarting restarts it (bayt's depends_on), and holding what it
					// reads rebuilds it with them, so a deploy rolling the door's
					// files rolls it too.
					srcs: globs: list.Concat([
						[omnishell.#Render.entry.source],
						[for s in meta.statics if s.file != omnishell.#Render.entry.source if strings.HasPrefix(s.target, "/srv/shell/") || strings.HasPrefix(s.target, "/srv/messages/") {s.file}],
					])
					dockerfile: {
						from: name: omnishell.#Render.image
						workdir: omnishell.#Render.workdir
						// The renderer's tree, from omnishell's runtime image, whose
						// root is omnishell's.
						copy: list.Concat([
							[for d in omnishell.#Render.dirs {
								from: {name: omnishell.#RuntimeImage}
								srcs: ["/\(strings.TrimPrefix(d, omnishell.#Render.home+"/"))"]
								dst: "\(omnishell.#Render.workdir)/\(d)"
							}],
							// The entry as the release wrote it, carrying its map.
							[{from: ref: ":served", srcs: ["\(omnishell.#Address.tree)/\(omnishell.#Render.entry.source)"], dst: omnishell.#Render.entry.target}],
						])
						epilogue: ["RUN \(omnishell.#Render.cache)"]
					}
					compose: {
						// The door, and what answers behind it: a guest is minted
						// and every table synced before the renderer is ready.
						depends_on: {
							caddy:    {condition: "service_healthy"}
							crud:     {condition: "service_healthy"}
							electric: {condition: "service_healthy"}
							auth:     {condition: "service_started"}
						}
						environment: {
							DOOR:            "http://caddy:8080"
							DOOR_TIMEOUT_MS: "\(resilience.resilience.timeouts.renderDoor*1000)"
							ENTRY:           omnishell.#Render.entry.target
							ORIGIN:          D.out.surface.origin
							PORT:            "\(omnishell.#Render.port)"
						}
						restart: "on-failure"
						// An edit to the entry reaches the door, which the renderer
						// restarts with, and this copy of it.
						develop: watch: [{action: "sync+restart", path: "../\(omnishell.#Render.entry.source)", target: omnishell.#Render.entry.target}]
					}
				}
				launch: compose: depends_on: render: {condition: "service_healthy"}
			}
		}
	}
	_rendersOnRequest: list.Contains([for _, s in D.code.surface.screens {s.ssr}], "ssr")
	// The services beside the door a host launch runs too: the program's
	// (code.meta.hostPeers, a plugin's) and the renderer, pronto's own.
	_hostPeers: {
		if D.code.meta.hostPeers != _|_ {D.code.meta.hostPeers}
		if D._rendersOnRequest {render: omnishell.#Render.port}
	}
	_terminal:         list.Contains([for s in D.statics {s.target}], "/srv/shell/index.html")
}

// The components of an app package — code, cluster, terminal, loop, build —
// are inputs; program.cue wires the defaults (#DefaultCluster and the rest)
// and bayt.cue redeclares cluster, terminal and loop as the escape-hatch seams.
#emit: E={
	_uniqueLines: [
		for ent in E._serverEntities for u in ent.uniques {
			"CREATE UNIQUE INDEX IF NOT EXISTS \(u.name) ON \(ent.table) (\(strings.Join(u.cols, ", ")));"
		},
	]
	code!:     _
	cluster:   mecha.#Cluster
	terminal!: _
	// The vocabulary this bundle was emitted against, restated so the literal
	// lint reads both sides of its join out of ONE export: a rule whose step set
	// can arrive empty reports zero findings, which reads as green. Concrete and
	// closed, so this is not an app seam — an app naming a step differently
	// conflicts rather than overrides.
	scale: #scale
	// Every vocabulary REGISTERED under scales/. An imported package's
	// unreferenced fields are never evaluated, so scales/vocabulary.cue would
	// grade a tree only on the day #scale drew a bucket from it; dereferencing
	// them here puts a registration under every app's own `cue export` on the day
	// build.ts writes it. Non-hidden for the reason #Scale's prefixes and sourced
	// are: a guard nothing evaluates is a guard nothing has.
	registered: {for n, v in scales {(n): v}}

	// DDL emits parents first (a `ref` REFERENCES needs its target); the
	// order comes from #App.entityOrder or declaration order.
	_entities: [...#Entity]
	if E.code.state.entityOrder != _|_ {
		_entities: [for n in E.code.state.entityOrder {E.code.state.entities[n]}]
	}
	if E.code.state.entityOrder == _|_ {
		_entities: [for _, e in E.code.state.entities {e}]
	}

	// The target terminal's published doctrine is a compile-time constraint:
	// an app cannot demand an auth mode or a provider its terminal does not
	// offer.
	if E.code.capabilities.auth != _|_ {
		_authModeOffered: true & list.Contains(E.terminal.capabilities.auth.modes, E.code.capabilities.auth.mode)
		// A provider the terminal names is offered as it is. One it does not
		// name (an identity broker's phone sign-in) is drawn as any other, a
		// link to the auth service labelled by the app's chrome_signin_<name>,
		// so it is offered where the program names the issuer that stands in
		// its place.
		let issuerNamed = [if E.code.capabilities.auth.provider != _|_ for n, v in E.code.capabilities.auth.provider if v.issuer != _|_ {n}]
		if E.code.capabilities.auth.providers != _|_ for p in E.code.capabilities.auth.providers {
			_authProviderOffered: (p): true & (list.Contains(E.terminal.capabilities.auth.providers, p) || list.Contains(issuerNamed, p))
		}
	}

	for _, v in E.code.capabilities.vendored {
		_vendoredIsolationBuildable: true & list.Contains(E.terminal.capabilities.isolation, v.isolation)
		// The unit's own entry point has to be one of the files the terminal
		// serves, or the mount fetches a path nothing published.
		_vendoredSrcServed: true & list.Contains(v.files, v.src)
	}

	// The cluster stores these. tab and device live only in the browser, so
	// nothing server-side is derived for them at all: no table, no restamp
	// trigger, no publication entry, no policy, no seed — which is the whole
	// point of separating durability from visibility.
	_serverEntities: [for e in E._entities if e.server {e}]
	// Server entities with validations, as a list so len() is decidable in
	// cue 0.16 (see #shellConfig's guard note).
	_validated: [for e in E._serverEntities if len([for n, _ in e.validations {n}]) > 0 {e}]
	_localEntities: [for e in E._entities if !e.server {e}]
	// Derived rows can be another computation's inputs. Consumers select their
	// dependencies; publication membership does not decide execution cycles.
	_cdcEntities: E._serverEntities
	_cdcTables: strings.Join([for e in E._cdcEntities {e.table}], ",")
	// Every table the publication carries, column by column, as the carrier
	// cdc-carriers.blobl converts a bus row into before a pipeline reads it.
	_cdcCarriers: {for e in E._cdcEntities {
		(e.table): {for f in e.fields if _busCarrier[f.type] != _|_ {(f.name): _busCarrier[f.type] & _busConvertible}}
	}}
	_syncTables: [for e in E._serverEntities {e.table}]

	// The refusal that would have caught the original bug: a target whose
	// schedules nothing wakes. At compose the cluster emits its own clock and
	// the cloudflare release its Cron Trigger (edge.ts); at a cloud target the
	// clock lives in a deploy tree this emitter does not write, and the
	// failure is silent — the pipelines simply never run. Declaring the clock
	// is what makes the absence loud, and `meta.clocks` is where the app says
	// so. The page runs its own clock while it is open (mecha-browser's
	// clock.ts), so only an effect asks it for one; `edgeClock: "disabled"` is
	// a frozen archive saying in as many words that its schedules do not run
	// there.
	_timedMachines: (#TimedMachines & {code: E.code}).out
	_clockDeclared: {
		for t in E.code.meta.targets {
			if (t != "pages" && t != "cloudflare" && len([for _, s in E.code.state.schedules if !s.suspend {s}]) > 0) || (E.code.state.effects != _|_ && len(E.code.state.effects) > 0) {
				(t): true & list.Contains(E.code.meta.clocks, t)
			}
		}
	}

	// A unit is a worker the browser fetches past the bundled document's shim,
	// so a program with one cannot be bundled yet; one user shares with nobody,
	// while the client opens a keyed shape per grant that the page's cluster
	// does not serve; and a validation runs in plv8, which PGlite has none of.
	// The pages target is refused rather than released broken.
	_pagesBundle: {
		if list.Contains(E.code.meta.targets, "pages") {
			units: true & (len(E.code.capabilities.vendored) == 0)
			shared: true & (len([for _, e in E.code.state.entities if e.access != _|_ if e.access.shared != _|_ {e}]) == 0)
			validations: true & (len(E._validated) == 0)
			providers: true & (E.code.capabilities.auth == _|_ || E.code.capabilities.auth.providers == _|_ || len(E.code.capabilities.auth.providers) == 0)
		}
	}

	// A schedule's two entities, checked here because #Schedule cannot see them.
	// A tick is a request-only authoritative input. Its outcome is a live
	// derived output, excluded from the additional CDC input set.
	// Unifying against the enum is not vacuous — `durability` carries no default.
	_scheduleShape: {
		for _, sc in E.code.state.schedules {
			(sc.name): {
				emits: E.code.state.entities[sc.emits.entity].durability & "server"
				if sc.done != _|_ {
					done:     E.code.state.entities[sc.done.entity].durability & "live"
					distinct: true & (sc.emits.entity != sc.done.entity)
				}
			}
		}
	}
	_pkg: strings.Replace(E.code.meta.name, "-", "_", -1)
	_pub: "\(_pkg)_cdc"
	// The loop is the fourth component (see #DefaultLoop); it owns the verb
	// surface and the argv doctrine.
	loop: prontoloop.#Loop

	// The build graph is the fifth (see #DefaultBuild); its resolved value
	// is emitted as bayt.json for the bayt.cue stub to embed.
	build!: _
	_integrationPriorities: {for _, c in E.build.checks {
		let p = [if c.priority != _|_ {c.priority}, 0][0]
		("\(p)"): p
	}}
	// Share orchestration within a priority; each runner still owns its stack.
	loop: surface: checks: {for _, p in _integrationPriorities {
		let names = list.SortStrings([for name, c in E.build.checks
			if [if c.priority != _|_ {c.priority}, 0][0] == p {name}])
		("pronto-integrate-\(p)"): {
			verb: "integrate"
			priority: p
			cmds: [(omnishell.#BkidCheck & {
				runner: strings.Join([for name in names {"ci-\(name)"}], ",")
			}).out]
			note: strings.Join([for name in names {E.build.checks[name].note}], "; ")
		}
	}}

	_hatchSeam: [
		if len(E.code.capabilities.hatches) > 0 {
			"""
				// Compiled escape hatches (ir.html: \(strings.Join(list.SortStrings([for hn, _ in E.code.capabilities.hatches {hn}]), ", ")))
				// live in program.cue's cluster unification; this redeclaration
				// is the out-of-band human override seam (add a cluster target,
				// modify one, null to drop one; extend the terminal).
				"""
		},
		"""
			// Escape hatches: none (ir.html) — the default runtime,
			// redeclared unchanged. A program whose ir declares a hatch
			// unifies its overrides right here (add a cluster target,
			// modify one, null to drop one; extend the terminal).
			""",
	][0]

	// The design block becomes CSS here and only here.
	_design: E.code.surface.design
	// The scale block, read straight off #scale — platform data with no app
	// seam, so this text is the same in every app. :where(html) is specificity
	// (0,0,0) against :root's (0,1,0), which is what makes a role beat a rung
	// by construction: an app naming --sp-md wins over --size-3 without an
	// ordering argument, and a screen may shadow a step from its own :root
	// without a specificity war. It is also the selector Open Props ships with.
	//
	// One comprehension over the buckets, so a bucket added to the vocabulary is
	// emitted with no edit here and the emitted name is prefix + key by
	// construction. The order is #scale.buckets' declaration order, which is
	// where that decision is stated.
	_scaleCss: """
		/* The value vocabulary, composed from several sources, each bucket under
		   its own source's upstream names. #scale says which sources those are;
		   naming them here too would make this sentence false at the next
		   registration. A rung, unlike a role, means only
		   "the Nth one": it is what an author reaches for when no role fits,
		   which is exactly the case that otherwise produces a number. Nothing
		   here has an appearance, so nothing here has a dark twin — what
		   changes with the appearance is which rung a role points at, one
		   namespace up, where the twin is closed. */
		:where(html) {
		\(strings.Join(list.Concat([
			for _, b in #scale.buckets {[for k, v in b.steps {"  \(b.prefix)\(k): \(v);"}]},
	]), "\n"))
		}
		"""
	_designCss: """

		\(E._scaleCss)

		/* Design system values, from DESIGN.md's frontmatter, which the program
		   reads as its design block: the roles the preset publishes, each colour
		   carrying both appearances. A screen that redeclares one of these has
		   forked the system — the shared layer is the only declaration. */
		:root {
		\(strings.Join(list.Concat([
			// One declaration per colour, both appearances inside it. The dark
			// palette is not a second :root to keep in step — it is the other
			// half of this value, resolved against whatever colour-scheme is in
			// force at the point of use.
			[for k, v in E._design.colors {"  --\(k): light-dark(\(v), \(E._design.dark[k]));"}],
			[for k, v in E._design.rounded {"  --r-\(k): \(v);"}],
			[for k, v in E._design.spacing {"  --sp-\(k): \(v);"}],
			[for k, v in E._design.motion {"  --motion-\(k): \(v);"}],
			[for k, v in E._design.control {"  --control-\(k): \(v);"}],
			[for k, v in E._design.measures {"  --measure-\(k): \(v);"}],
			[for k, v in E._design.type {"  --type-\(k): \(v);"}],
			[for k, v in E._design.component {"  --c-\(k): \(v);"}],
			[
				"  --shell-bg: var(--\(E._design.shell.bg));",
				"  --shell-fg: var(--\(E._design.shell.fg));",
				"  --shell-rule: var(--\(E._design.shell.rule));",
				"  color-scheme: light dark;",
			],
	]), "\n"))
		}
		/* The storybook stamps -dark frames as data-state values. colour-scheme
		   is inherited and light-dark() reads it at the point of use, so
		   flipping it on the frame resolves every token inside to its twin —
		   both appearances reviewable on one device, with no second palette to
		   drift from this one. */
		.screen[data-state$="-dark"] {
		  color-scheme: dark;
		}

		/* The terminal's chrome, styled here because the terminal ships no
		   style: its markup carries stable classes and attributes, and this
		   emission — program-owned, preset-derived, app-overridable — is the
		   only stylesheet they have. Aesthetic values stay behind --shell-*
		   variables so an app can retheme without repeating structure. */
		/* The scrollbar's room is kept whether or not the page overflows: a
		   screen swapping in is as short as its loading state until its data
		   lands, and with a classic scrollbar the whole page would jump
		   sideways and back on every navigation. */
		html { scrollbar-gutter: stable; }
		body { margin: 0; font: var(--shell-font, 1rem/1.5 system-ui, sans-serif);
		  background: var(--shell-bg); color: var(--shell-fg); }
		/* Sticky, because the navigation stack restores a screen's scroll
		   position on return — without it the way back to the primary
		   navigation is scrolling up. A sticky element is transparent, so it
		   needs its own background or content runs under it.

		   One line, always: a wrapped strip is as tall as its rows and pushes
		   the masthead below the fold, and any app with more routes than a
		   phone's width holds would wrap at its natural size. It scrolls
		   instead, and the scrollbar is hidden because a horizontal bar across
		   the chrome reads as a second rule under the strip. */
		body > nav { position: sticky; top: 0; z-index: 10;
		  background: var(--shell-bg);
		  display: flex; gap: var(--shell-nav-gap, 20px);
		  flex-wrap: nowrap; align-items: center;
		  overflow-x: auto; scrollbar-width: none;
		  padding: var(--shell-nav-pad, 14px 24px);
		  font-weight: var(--shell-nav-weight, 600);
		  border-bottom: 1px solid var(--shell-rule); }
		body > nav::-webkit-scrollbar { display: none; }
		body > nav a { color: inherit; text-decoration: none; }
		body > nav a:hover { text-decoration: var(--shell-nav-hover, underline); }
		/* The routes carry their own width — shrinking them is what would make
		   the strip fit by breaking words, which is the wrap this avoids. The
		   identity beside them keeps flex's default shrink, so it is the part
		   that gives and ellipsises. 24px is check-visual's touch-target floor:
		   nav labels are small type, so the box grows to the floor rather than
		   the type growing with it. */
		body > nav > a { white-space: nowrap; flex: none;
		  display: inline-flex; align-items: center; min-height: 24px; }
		/* The signed-in person at the strip's far end, name-then-handle as a
		   byline. All four ellipsis rules are load-bearing: nowrap alone
		   cannot shrink, and min-width: 0 is what lets a flex item shrink
		   below its content width at all. */
		body > nav .shell-me { margin-inline-start: auto; display: flex; align-items: center; gap: var(--shell-nav-gap, 20px); min-width: 0; }
		body > nav .shell-who { display: flex; align-items: center; gap: 5px; min-width: 0; min-height: 24px; }
		body > nav .shell-who .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		body > nav .shell-who .name:empty { display: none; }
		body > nav .shell-who .name:not(:empty)::after { content: " ·"; }
		body > nav .shell-who .handle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
		/* De-emphasis comes from weight alone: layered opacity on --shell-fg
		   lands below 4.5:1 contrast on both themes' nav ground. */
		/* A short word is still a target: "sair" sets 23px of text, under the
		   24px minimum a finger needs, so the box keeps the floor the label
		   does not. */
		body > nav .shell-signout { font-weight: 400;
		  display: inline-flex; align-items: center; justify-content: center;
		  min-height: 24px; min-width: 24px; }

		/* Not a preference to weigh against the design: durations collapse
		   and the interpreter's exit path, which waits on running animations,
		   finds none and removes immediately. */
		@media (prefers-reduced-motion: reduce) {
		  :root { --motion-fast: 0s; --motion-base: 0s; --motion-shift: 0px; }
		}

		/* Lifecycle slots the interpreter stamps at moments no screen can
		   observe. Keyframes, not transitions: screens style rows with
		   transition, and the cascade would hand them the whole shorthand.
		   These bindings are deliberately rebindable — a screen may point
		   them at its own keyframes; the interpreter waits on whatever
		   animations actually run. */
		@keyframes shell-item-enter {
		  from { opacity: 0; transform: translateY(var(--motion-shift)); }
		}
		@keyframes shell-item-exit {
		  to { opacity: 0; transform: scale(.98); }
		}
		[data-id][data-enter] { animation: shell-item-enter var(--motion-base) var(--motion-ease); }
		/* forwards holds the departed row invisible for the frames between
		   the animation ending and the interpreter removing the node. */
		[data-id][data-exit] { animation: shell-item-exit var(--motion-base) var(--motion-ease) forwards; }
		@keyframes shell-reveal {
		  from { opacity: 0; transform: translateY(calc(var(--motion-shift) * -1)); }
		}
		.empty, .invalid, .store-error {
		  animation: shell-reveal var(--motion-base) var(--motion-ease);
		}
		/* A screen arriving on the navigation stack; the one it replaces is
		   hidden at once — overlapping two live screens would need a stacking
		   layout the terminal does not own. */
		.shell-screen { transition: opacity var(--motion-fast) var(--motion-ease); }
		.shell-screen[data-entering] { opacity: 0; }

		/* The login ceremony — the one full surface the terminal renders,
		   on the same tokens as everything else. */
		body:has(.shell-login) { background: var(--login-surface, var(--surface)); }
		.shell-login {
		  box-sizing: border-box; min-height: 100svh; display: grid;
		  grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr);
		  align-items: center; gap: clamp(48px, 8vw, 128px);
		  max-width: 1160px; margin: auto; padding: clamp(32px, 7vw, 96px);
		  color: var(--primary, var(--shell-fg));
		}
		.shell-login .login-intro { padding-block: 32px; }
		.shell-login .login-mark {
		  display: grid; place-items: center; width: 56px; height: 56px;
		  margin-block-end: 48px; color: var(--accent, var(--shell-fg));
		  border: 1px solid var(--shell-rule); border-radius: var(--r-md, 8px);
		  font: 400 32px/1 var(--shell-heading-font, ui-serif, Georgia, serif);
		}
		.shell-login h1 {
		  margin: 0; font-family: var(--shell-heading-font, ui-serif, Georgia, serif);
		  font-size: clamp(48px, 6.5vw, 88px); font-weight: 400; line-height: 1.05;
		  letter-spacing: -.055em; overflow-wrap: anywhere;
		}
		.shell-login .login-hint {
		  margin: 28px 0 0; max-width: 32ch; font-size: 1.125rem; line-height: 1.65;
		  color: var(--secondary, var(--shell-fg));
		}
		.shell-login form {
		  box-sizing: border-box; width: 100%; margin: 0; padding-block: 40px;
		  border-block: 1px solid var(--shell-rule);
		}
		.shell-login .login-actions { display: grid; gap: 12px; }
		.shell-login button, .shell-login .login-provider {
		  box-sizing: border-box; display: flex; align-items: center; justify-content: center;
		  width: 100%; min-height: 56px; padding: 14px 20px; font: inherit;
		  font-size: .9375rem; font-weight: 600; text-align: center; text-decoration: none;
		  line-height: 1.5; border: 1px solid var(--shell-rule); border-radius: var(--r-sm, 6px);
		  background: var(--surface); color: var(--primary, var(--shell-fg)); cursor: pointer;
		  transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
		}
		.shell-login .login-provider { background: var(--primary, var(--shell-fg)); color: var(--surface); border-color: transparent; }
		.shell-login .login-provider ~ .login-passkey { background: var(--surface); color: var(--primary, var(--shell-fg)); border-color: var(--shell-rule); }
		.shell-login .login-passkey { background: var(--primary, var(--shell-fg)); color: var(--surface); border-color: transparent; }
		.shell-login .login-guest { margin-block-start: 12px; border-color: transparent; background: transparent; color: var(--secondary, var(--shell-fg)); font-weight: 400; }
		.shell-login button:hover, .shell-login .login-provider:hover { transform: translateY(-1px); }
		.shell-login .login-provider:hover { filter: brightness(1.15); }
		.shell-login .login-guest:hover { color: var(--primary, var(--shell-fg)); background: var(--surface-muted, var(--surface)); }
		.shell-login :is(button, a):focus-visible { outline: 3px solid var(--accent, var(--shell-fg)); outline-offset: 4px; }
		.shell-login .login-error { color: var(--danger); margin: 0 0 20px; font-size: .9375rem; }
		@media (max-width: 700px) {
		  .shell-login { grid-template-columns: minmax(0, 1fr); align-content: center; gap: 40px; padding: 48px 28px; }
		  .shell-login .login-intro { padding: 0; }
		  .shell-login .login-mark { margin-block-end: 32px; }
		  .shell-login h1 { font-size: clamp(48px, 13vw, 72px); }
		  .shell-login .login-hint { margin-block-start: 20px; font-size: 1rem; }
		  .shell-login form { padding-block: 28px; }
		}
		@media (prefers-reduced-motion: reduce) {
		  .shell-login button, .shell-login .login-provider { transition: none; }
		  .shell-login button:hover, .shell-login .login-provider:hover { transform: none; }
		}

		"""

	_appMigrations: #appMigrations & {"code": E.code}
	_seedFile: _appMigrations._seedFile

	_migrations: _appMigrations.list

	_accessed: _appMigrations.accessed
	_raw:      _appMigrations.raw
	// The auth plane switches on as one: declaring #App.auth or any entity
	// access implies the roles and service-token plumbing — policies without
	// tokens (or vice versa) is not a supported state. The auth_uid() the
	// policies call is the database image's (mecha's tenancy floor).
	_authOn: E.code.capabilities.auth != _|_ || len(E._accessed) > 0
	// The `service` role alone also stands where a schedule or an effect is
	// declared: the ticker writes its ticks as it, through crud, which mecha's
	// cluster has verify the token wherever something wakes (its _serviceToken).
	_serviceOn: len(E._timedMachines) > 0 || E._authOn || len(E.code.state.schedules) > 0 || [if E.code.state.effects != _|_ {len(E.code.state.effects) > 0}, false][0]

	// The cluster handed in must be the program's: #DefaultCluster derives
	// these from the code, and a cluster that disagrees conflicts here.
	cluster: state: (#MachineTimerState & {code: E.code}).out
	cluster: capabilities: auth:  E.code.capabilities.auth != _|_
	if E.code.capabilities.auth != _|_ if E.code.capabilities.auth.providers != _|_ {
		cluster: capabilities: signIn: (#signIn & {auth: E.code.capabilities.auth}).out
	}
	cluster: capabilities: blobs: E.code.capabilities.blobs
	_serverOn: (#serverOn & {servers: [for _, e in E.code.state.entities {e.server}], auth: E.code.capabilities.auth != _|_}).out
	// The served route table, resolved once: shell.yaml IS this, and the
	// Caddyfile's own matcher list is read out of the same addresses, so the
	// door and the router cannot disagree about what a route is.
	_shell: (#shellConfig & {"code": E.code, migrations: E._migrations, floors: E.terminal.capabilities.floors, hatch: E.terminal.capabilities.hatch, presenter: E.terminal.capabilities.presenter, server: E._serverOn, native: E.code.capabilities.native}).out
	// The locales in one order, so every artifact that lists them lists them the
	// same way and a regenerated file has no spurious diff.
	_locales: list.SortStrings([if E._shell.i18n != _|_ for tag, _ in E._shell.i18n.locales {tag}])
	// Every address a route answers at, flattened for the door's matcher list.
	_addressed: list.FlattenN([for r in E._shell.routes {E._spellings[r.screen]}], 1)
	// The locales a reader can be sent TO. The default is where they already
	// are, so it names no redirect — only the captures that mean "stay".
	_others: [for tag in E._locales if E._shell.i18n != _|_ if tag != E._shell.i18n.default {tag}]
	// Every declared tag, plus the bare language of each, which is the whole of
	// what negotiateLocale will look at: it tries the exact tag, then the first
	// declared tag sharing its language. Longest first, because Go's alternation
	// is leftmost-FIRST and `pt` would otherwise swallow `pt-BR`.
	_alternatives: list.Concat([(E._byLength & {of: E._localeOrder}).out, (E._byLength & {of: E._baseOrder}).out])
	// Down from the longest actually declared, rather than from a guessed
	// ceiling: a tag is a BCP 47 subtag chain with no length a compiler may
	// assume, and one left out of the alternation is a language the door
	// cannot see at all.
	_byLength: B={
		of: [...string]
		out: [
			for n in list.Range(list.Max(list.Concat([[0], [for s in B.of {len(s)}]])), 0, -1)
			for s in B.of if len(s) == n {s},
		]
	}
	// Declaration order, not sorted: negotiateLocale resolves a bare language to
	// the FIRST declared tag carrying it, and shell.yaml's order is that one.
	_localeOrder: [if E._shell.i18n != _|_ for tag, _ in E._shell.i18n.locales {tag}]
	_baseOf: {for tag in E._localeOrder {(tag): strings.Split(tag, "-")[0]}}
	// A language already spelled as a tag needs no second alternative.
	_baseOrder: [
		for i, tag in E._localeOrder
		let b = E._baseOf[tag]
		if b != tag
		if len([for j, o in E._localeOrder if j < i if E._baseOf[o] == b {o}]) == 0 {b},
	]
	// What a capture means. A bare language means the first declared tag that
	// carries it, which is what makes `pt-PT` read as `pt-BR`.
	_meansLocale: {
		for tag in E._localeOrder {(tag): tag}
		for b in E._baseOrder {(b): [for tag in E._localeOrder if E._baseOf[tag] == b {tag}][0]}
	}
	// An app whose every route is behind a session has nothing to offer a
	// crawler but its login wall, so it offers nothing and says so in robots.
	// A comprehension rather than `==`, which errors on a field an app without
	// an auth block never declares instead of reading as false.
	_public: [
		if E._shell.auth != _|_ if E._shell.auth.required {false},
		true,
	][0]
	// The routes rendered on request (#Screen.ssr), each refused where a
	// document rendered for no one in particular could not show what the
	// route shows: an app behind a sign-in, a private route, or a route whose
	// top-level regions are all restricted. A mixed route with public access
	// renders its public regions and leaves restricted regions to their empty
	// slot until a session arrives.
	_onRequest: [
		for r in E._shell.routes if r.ssr == "ssr"
		let n = r.screen
		let s = E.code.surface.screens[n]
		let restricted = s._topRestricted
		let purelyRestricted = len(s._topLive) > 0 && len(restricted) == len(s._topLive) {
			[
				if !E._public {error("screen \(n) declares ssr: \"ssr\" in an app behind a sign-in; a document rendered per session is not built (plugins/pronto/PENDING.md#screens)")},
				if purelyRestricted {error("screen \(n) declares ssr: \"ssr\" over \(strings.Join(restricted, ", ")); a document rendered on request is rendered for no one in particular, and one rendered per session is not built (plugins/pronto/PENDING.md#screens)")},
				if s.access == "private" {error("screen \(n) is private and declares ssr: \"ssr\"; a document rendered on request is rendered for no one in particular")},
				n,
			][0]
		},
	]
	// A presenter's pinned scripts are fetched by the terminal against their
	// integrity, so the page connects to each file and to nothing else there.
	_resources: list.Concat([
		[if E.code.capabilities.resources != _|_ for _, r in E.code.capabilities.resources {kind: r.kind, source: r.source}],
		[for _, v in E.code.capabilities.vendored for u in v.scripts {kind: "connect", source: u}],
	])
	_resourceSources: {for r in _resources {(r.kind): (r.source): true}}
	_browserPolicy: [if E.terminal.surface.contentSecurityPolicy != _|_ {
		[if len(_resources) == 0 {E.terminal.surface.contentSecurityPolicy},
			if len(_resources) > 0 {strings.Join([for part in strings.Split(E.terminal.surface.contentSecurityPolicy, "; ") {
				let kind = strings.TrimSuffix(strings.Split(part, " ")[0], "-src")
				let sources = list.SortStrings([if _resourceSources[kind] != _|_ for src, _ in _resourceSources[kind] {src}])
				strings.Join(list.Concat([[part], sources]), " ")
			}], "; ")}][0]
	}, ""][0]
	_envelope: #envelopePlan & {
		meta:         E.code.meta
		surface:      E.code.surface
		state:        E.code.state
		capabilities: E.code.capabilities
	}
	_isScreenExcluded: {
		for r in E._shell.routes {
			let scr = E.code.surface.screens[r.screen]
			let route = [if scr != _|_ if scr.route != _|_ { scr.route }, (r.screen)][0]
			(r.screen): len([
				for ex in _envelope.sitemap.exclude
				if route == ex || (ex != "/" && strings.HasPrefix(route, strings.TrimSuffix(ex, "/") + "/"))
				{ ex }
			]) > 0
		}
	}
	_sitemapRoutes: {
		for r in E._shell.routes {
			let scr = E.code.surface.screens[r.screen]
			let isRoot = (#address & {route: r}).out == "/"
			let hasReads = scr != _|_ && scr.reads != _|_ && len(scr.reads) > 0
			let isPrerender = scr != _|_ && scr.prerender == true
			let authoredPriority = [
				if scr != _|_ if scr.priority != _|_ {
					[
						if "\(scr.priority)" == "1" { "1.0" },
						if "\(scr.priority)" == "0" { "0.0" },
						"\(scr.priority)"
					][0]
				},
				""
			][0]
			let inferredPriority = [if isRoot { "1.0" }, if hasReads { "0.8" }, "0.6"][0]
			let priority = [if authoredPriority != "" { authoredPriority }, inferredPriority][0]
			let authoredFreq = [if scr != _|_ if scr.changefreq != _|_ { scr.changefreq }, ""][0]
			let inferredFreq = [if isPrerender && !hasReads { "monthly" }, if isRoot || hasReads { "daily" }, "weekly"][0]
			let freq = [if authoredFreq != "" { authoredFreq }, inferredFreq][0]

			(r.screen): {
				"priority": priority
				"freq":     freq
			}
		}
	}
	// A crawler is offered the routes it can actually reach: a `:param` segment
	// holds a row id, and an address invented for one is a 404 or, worse,
	// somebody's row. Naming only the static routes is not a hedge — it is the
	// whole of what the app can promise exists without reading the database.
	// Every locale's spelling is asked, not only the default's: nothing makes a
	// route's params the same in each, which is why the prerender check walks
	// them one by one too.
	_crawlable: [
		if E._public && _envelope.sitemap.enabled for r in E._shell.routes
		if E.code.surface.screens[r.screen].access == "public"
		if !_isScreenExcluded[r.screen]
		if len([for a in E._spellings[r.screen] if strings.Contains(a, ":") {a}]) == 0 {r},
	]
	// Every address one route answers at, per route, so both the flat list the
	// door reads and the per-route grouping the sitemap needs come from one
	// composition.
	_spellings: {
		for r in E._shell.routes {
			(r.screen): [
				if E._shell.i18n == _|_ {(#address & {route: r}).out},
				if E._shell.i18n != _|_ for tag in E._locales {
					(#address & {route: r, i18n: E._shell.i18n, "tag": tag}).out
				},
			]
		}
	}
	// A server entity syncs through a gate the auth service answers, so a
	// cluster with one and no auth plane would 502 every shape.
	_gated: bool & (E._serverOn == false || E._authOn) & true
	cluster: capabilities: server: E._serverOn

	// The handlers Pronto composes rather than copies: a Cortex state's child,
	// the app's module over the Mecha machine it reaches — run by the terminal
	// for a local child — and the declarations of every machine it may write to.
	_composedHandlers: {
		if E.code.state.cortex != _|_ for _, cortexMachine in E.code.state.cortex for name, actor in cortexMachine.setup.actors if actor.via != "kinetic" if actor.handler != _|_ {
			"shell/handlers/\(name).js": {
				machine:  {machine: E.code.state.hybrids[actor.machine].reducer, rules: E.code.state.hybrids[actor.machine].rules}
				local:    actor.via == "local"
				machines: {for n, h in E.code.state.hybrids {(n): h.reducer}}
				src:      actor.handler
			}
		}
	}
	files: [string]: #File
	checkout: [string]: #File
	files: {
		if E.code._timerRefusal {}
		if E.code._hostDomRefusal {}
		if E.code._lifecycleRefusal {}
		if E.code._screenAccessRefusal {}
		for _, h in E.code.capabilities.hatches if h.kind == "host-dom" {if E.terminal.capabilities.hostDom != true {_unsupportedHostDom: error("terminal does not offer host-dom")}}
	}
	// The compose file every closure includes, one per MONOREPO_COMPOSE_MODE
	// (builders/bayt.cue): `service` declares the monorepo's targets the
	// switch names, at the paths the checkout and its images keep them;
	// unset, the pinned images need none. `service` is the checkout's own,
	// as mise.local.toml is: the writer writes it only there, and records
	// it nowhere a mirror reads.
	let up = strings.Repeat("../", len(strings.Split(E.build.meta.dir, "/"))+1)
	checkout: "monorepo/service.yaml": {
		format: "yaml"
		data: include: list.Concat([
			[for s, _ in mecha.published {"\(up)libraries/mecha/.bayt/compose.\(s)-image.yaml"}],
			["\(up)plugins/omnishell/.bayt/compose.runtime-image.yaml", "\(up).bayt/compose.pronto-sources.yaml"],
		])
	}
	files: "monorepo/docker-image.yaml": {
		format: "yaml"
		data: {}
	}
	files: {
		// What tools outside CUE read of the cluster, evaluated here once:
		// evaluating a program takes gigabytes, too much to repeat in
		// ci-replay or in a release. The
		// token roles are those 001_roles.sql grants authenticator, which a
		// Kubernetes release's operator would otherwise revoke. The drains are
		// what the page's and the edge's clusters call (mecha-browser's
		// drains.ts), where no stream runs them.
		".pronto/cluster.json": {
			format: "json"
			data: {
				server: E.cluster.capabilities.server
				if E.cluster.capabilities.server {
					schema:     E.cluster.surface.schema
					tokenRoles: E.files["services/database/migrations/001_roles.sql"]._tokenRoles
					// The app's own migrations, replayed on a built database with the
					// framework's re-runnable steps (gcp's schema job): each is
					// idempotent, as initdb replays it on a fresh volume.
					replays: [for r in [if E.code.state.rawMigrations != _|_ {E.code.state.rawMigrations}, []][0] {r.name}]
					drains: [for _, d in E.code.state.drains {name: d.name, on: d.on, call: d.call, body: d.body}]
				}
			}
		}
		".pronto/check-inputs.json": {
			format: "json"
			data: {
				version: 1
				types: {types: #types, aliases: #typeAlias}
				entities: E.code.state.entities
				hybrids: {if E.code.state.hybrids != _|_ for n, h in E.code.state.hybrids {(n): h.reducer}}
				hatches: E.code.capabilities.hatches
				rawMigrations: [if E.code.state.rawMigrations != _|_ {E.code.state.rawMigrations}, []][0]
				duckstreams: [if E.code.state.duckstreams != _|_ {E.code.state.duckstreams}, {}][0]
			}
		}
		"schema/entities.proto": {
			format: "proto"
			data:   E.code.state.entities
		}
		// The app's own buf module, so `buf breaking` runs inside the app and
		// reaches for nothing above it: an app copybara'd into a repo of its
		// own carries this file and compares the same way there, where the
		// path from the repo root to the app is no longer the one it is here.
		//
		// `path: .` and not the schema directory, because the set is meant to
		// be discovered: every proto the app holds is read — the emitted one
		// and any a hatch brought with it — so adding a proto cannot quietly
		// escape the comparison. A hatch withholds its own by path on the
		// command line (check-proto.ts), which leaves this file the same
		// whatever an app declares.
		//
		// WIRE_JSON rather than WIRE: the emitter writes json_name on every
		// field, so the JSON a holder reads is keyed by name, and a rename
		// that binary decoding would survive breaks it.
		"buf.yaml": {
			format: "yaml"
			data: {
				version: "v2"
				modules: [{path: "."}]
				breaking: use: ["WIRE_JSON"]
			}
		}
		// The server-side surface, emitted only where there is a server to run
		// it: an app whose every entity is a browser durability has no schema, no
		// publication, no bus wiring and no pipeline file, and the cluster it
		// targets instantiates none of the services these configure.
		if E._serverOn {
			"services/database/migrations/004_types.sql": {
				format: "type-sql"
				data: [for _, e in E.code.state.entities if e.server for f in e.fields if f.type == "decimal" {precision: f.precision, scale: f.scale}]
			}
			"services/database/migrations/000_extensions.sql": {
				format: "sql"
				// plv8 is required exactly when a server entity declares
				// validations: it is the language their predicates run in.
				// gen_random_uuid() is core since PostgreSQL 13, so an app
				// without validations needs no extension at all.
				//
				// IF NOT EXISTS because a migration is restated, not replayed
				// once: a correction below it reaches a database that already
				// holds the extension, and CREATE EXTENSION alone would abort
				// the whole file before the correction ran.
				text: [
					if len(E._validated) > 0 {"CREATE EXTENSION IF NOT EXISTS plv8;\n"},
					if len(E._validated) == 0 {"-- no extensions required\n"},
				][0]
			}
			"services/database/migrations/001_roles.sql": {
				format: "sql"
				_roles: list.Concat([["anon"], [if E._authOn {"app_user"}, if E._serviceOn {"service"}], [if E._serverOn {"electric"}]])
				text: "DO $$ BEGIN\n" + strings.Join([for r in _roles {
					"""
					  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '\(r)') THEN
					    CREATE ROLE \(r) NOLOGIN;
					  END IF;
					"""
				}], "\n") + "\n" + _authenticator + "END $$;\n" + _login + strings.Join(_bypass, "") + strings.Join(_timeouts, "")

				// PostgREST's login, which switches to the role a request's token
				// names; it applies that role's settings (the bounds below) only
				// when the role is granted to it. No password, as electric's: the
				// deployment's secret sets it (mecha's #RolePasswordsStep).
				_tokenRoles: [for r in _roles if r != "electric" {r}]
				_authenticator: """
					  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
					    CREATE ROLE authenticator NOINHERIT;
					  END IF;

					"""
				_login: "\nALTER ROLE authenticator LOGIN;\nGRANT \(strings.Join(_tokenRoles, ", ")) TO authenticator;\n"

				// The tenancy floor binds PUBLIC, which includes service. A pipeline
				// and the auth service read every tenant's rows by definition, so
				// their exemption is a role attribute — visible in pg_roles, and so
				// auditable — rather than an absence from a TO list.
				//
				// Electric is the same case and the dangerous one: it reads the WAL
				// for every tenant, and a role without BYPASSRLS gets `{}` from
				// current_scopes(), so every shape yields an empty snapshot with no
				// error.
				_bypass: [
					if E._serviceOn {"\nALTER ROLE service BYPASSRLS;\n"},
					// No password: the deployment's secret sets it (mecha's
					// #RolePasswordsStep), and a schema that set one would
					// overwrite it whenever it ran.
					if E._serverOn {"\nALTER ROLE electric BYPASSRLS REPLICATION LOGIN;\n" +
						"GRANT USAGE ON SCHEMA public TO electric;\n" +
						"GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;\n" +
						"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;\n" +
						""
					},
				]

				// The innermost timeouts of a request (plugins/pronto/resilience), per token role.
				_timeouts: list.Concat([["\n-- Finite machine bounds: statement, lock, and idle timeouts.\n"], [
					for r in _tokenRoles
					let tier = [if r == "service" {"service"}, "client"][0] {
						"ALTER ROLE \(r) SET statement_timeout = '\(resilience.resilience.timeouts.statement[tier])s';\n" +
						"ALTER ROLE \(r) SET lock_timeout = '\(resilience.resilience.timeouts.lock[tier])s';\n" +
						"ALTER ROLE \(r) SET idle_in_transaction_session_timeout = '\(resilience.resilience.timeouts.idleInTransaction[tier])s';\n"
					},
				]])
			}
			"services/database/migrations/002_grants.sql": {
				format: "sql"
				if !E._authOn {
					// The service role beside anon where only a wake brings it:
					// the schedule tables, which anon never reaches, are its.
					_grantees: [if E._serviceOn {"anon, service"}, "anon"][0]
					text: """
						GRANT USAGE ON SCHEMA public TO \(_grantees);
						GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \(_grantees);
						ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \(_grantees);

						"""
				}

				// Auth'd grants: anon can connect (USAGE) but touches no table —
				// every row read or written goes through app_user or service,
				// where 006's policies decide.
				if E._authOn {
					text: """
						GRANT USAGE ON SCHEMA public TO anon, app_user, service;
						GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service;
						ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, service;

						"""
				}
			}
			"services/database/migrations/008_publication.sql": {
				format: "sql"
				// Runs after 005_create_tables: FOR TABLE fails on missing tables
				// and initdb aborts on the first error. The explicit list limits CDC
				// to application entities; Conduit's tables setting does not filter
				// logrepl events.
				// publish_generated_columns = stored: Electric sets REPLICA IDENTITY
				// FULL, and a publication excluding generated columns from a FULL
				// identity refuses UPDATE/DELETE (42P10). Slots belong to consumers,
				// created on first connect.
				// REPLICA IDENTITY FULL is declared here, not inherited. Under the
				// DEFAULT identity a DELETE replicates only the primary key, so a
				// pipeline keyed on any other column reads its own key as empty and
				// cannot recount the group the row left — the count freezes at its
				// last value and a junk sink row keyed on "" accumulates beside it.
				// Electric sets FULL on the tables it syncs, which made this work by
				// accident on any cluster it had already reached and fail on a fresh
				// one until it did; delete-to-zero must not depend on that.
				// An app whose entities all live in the browser (tab, device) has no
				// crud table at all, and `FOR TABLE` with an empty list is a syntax
				// error that aborts initdb — so the publication is emitted only when
				// there is something to publish.
				// The publications and the replica identity need a WAL reader, so
				// they go inside the fence (libraries/mecha/docs/browser.md#the-fence).
				_wal: #Tier & "container"
				// Marked only where the feed runs: with nothing reading the WAL,
				// a marker is a write per statement for nobody.
				_marker: [if E.cluster.capabilities.capture {"\n" + (#txnMarker & {pub: E._pub, tables: strings.Split(E._cdcTables, ",")}).out}, ""][0]
				text: [
					if len(E._syncTables) > 0 {
						"""
				\([if len(E._cdcTables) > 0 {"-- tier: \(_wal)\n" + (#publication & {name: E._pub, tables: strings.Split(E._cdcTables, ",")}).out + _marker + "\n-- tier: any"}, "-- No authoritative source entity: nothing for the bus to read."][0])

				-- Electric's own publication, declared rather than left to it.
				-- ELECTRIC_MANUAL_TABLE_PUBLISHING makes it validate this instead of
				-- building one, which is what lets its role hold only REPLICATION and
				-- SELECT: creating a publication needs CREATE on the database, and
				-- adding a table to one needs ownership of that table. A sync service
				-- that owns the app's tables can drop them.
				-- tier: \(_wal)
				\((#publication & {name: "electric_publication_default", tables: E._syncTables}).out)

				\(strings.Join([for t in E._syncTables {"ALTER TABLE \(t) REPLICA IDENTITY FULL;"}], "\n"))
				-- tier: any
				GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;

				"""
					},
					"""
						-- No synced entity: nothing to publish, nothing to grant.

						""",
				][0]
			}
			// Tables, their indexes and their composite uniques in one step. A
			// unique index belongs to the transaction that creates its table:
			// the constraint is then never briefly absent, and an index built
			// over a table the same transaction created blocks no writer, which
			// is what makes plain CREATE INDEX — rather than CONCURRENTLY, which
			// cannot run in a transaction — the right statement here.
			//
			// Composite unique names are uq_<table>_<cols>, and a violation is
			// what the app's duplicate refusal reads: the Caddyfile injects
			// resolution=ignore-duplicates, which PostgREST targets at the
			// PRIMARY KEY — a client-minted uuid that never collides — so a
			// repeated pair reaches this index and comes back 23505 rather than
			// merging silently.
			"services/database/migrations/005_create_tables.sql": {
				format: "sql"
				_indexLines: list.Concat([for ent in E._serverEntities if ent.indexes != _|_ {(#indexSql & {e: ent}).out}])
				text: strings.Join(list.Concat([
					[for ent in (#tableOrder & {entities: E._serverEntities}).out {(#tableSql & {e: ent, columns: E.code._machineColumns}).out}],
					[if len(_indexLines) > 0 {strings.Join(_indexLines, "\n")}],
					[if len(E._uniqueLines) > 0 {strings.Join(E._uniqueLines, "\n")}],
				]), "\n\n") + "\n"
			}
			if len(E._accessed) > 0 {
				"services/database/migrations/006_policies.sql": {
					format: "sql"
					text: strings.Join(list.Concat([[for ent in E._entities if ent.access != _|_ {
						(#policySql & {e: ent, entities: E.code.state.entities}).out
					}], [if E.code.capabilities.blobs && E.code.capabilities.auth != _|_ {#blobGateSql}]]), "\n\n") + "\n"
				}
			}
			if len(E._validated) > 0 {
				"services/database/migrations/009_validations.sql": {
					format: "sql"
					text: strings.Join(list.Concat([
						[#validationPrecondition],
						[for ent in E._validated {(#validationSql & {e: ent}).out}],
					]), "\n\n") + "\n"
				}
			}

			_machines: [if E.code.state.machines != _|_ {[for _, m in E.code.state.machines for en, e in E.code.state.entities if en == m.entity || e.table == m.entity if e.server {m}]}, []][0]
			// A Mecha machine a Cortex state runs locally is the terminal's: a
			// handler composing the app's module over the machine's own rules.
			for path, local in E._composedHandlers {
				"\(path)": {format: "local-handler", data: local}
			}
			if E.code.state.hybrids != _|_ {
				// Each machine's surface is entities the app declares; the writer
				// checks them against the machine before compiling.
				"services/database/migrations/016_mecha_actors.sql": {format: "hybrid-sql", data: {
					hybrids: {for n, h in E.code.state.hybrids {(n): {machine: h.reducer, rules: h.rules}}}
					entities: E.code.state.entities
					timers: [if len([for _, h in E.code.state.hybrids if h.reducer.ports != _|_ if h.reducer.ports.wake != _|_ {h}]) > 0 {mecha.#MachineTimersSql}, ""][0]
				}}
			}
			if len(_machines) > 0 {
				"services/database/migrations/010_machines.sql": {
					format: "sql"
					text: [if len(E._timedMachines) > 0 {mecha.#MachineTimersSql + "\n\n"}, ""][0] + strings.Join([for m in _machines {(#mechaMachineSql & {machine: m, entities: E.code.state.entities, effects: [if E.code.state.effects != _|_ {E.code.state.effects}, {}][0]}).out}], "\n\n") + "\n"
				}
			}

			// What the airlock runs (libraries/mecha/services/airlock): one entry
			// per effect, naming the state that invokes it and where its outcome
			// lands; the sink as a Dapr output binding; and the handler the program
			// authors in place.
			_invoking: [
				if E.code.state.machines != _|_
				for _, m in E.code.state.machines if m.states != _|_
				for sName, st in m.states if st.invoke != _|_
				let x = E.code.state.effects[st.invoke.src]
				let ent = [for en, e in E.code.state.entities if en == m.entity || e.table == m.entity {e}][0] {
					effect: x
					table:  ent.table
					field:  m.field
					state:  sName
					onDone:  [if (st.invoke.onDone & string) != _|_ {st.invoke.onDone}, st.invoke.onDone.target][0]
					onError: [if (st.invoke.onError & string) != _|_ {st.invoke.onError}, st.invoke.onError.target][0]
					row: [for f in ent.fields if f.pk != _|_ if f.pk {f.name}]
				},
			]
			if len(_invoking) > 0 {
				"services/airlock/effects.json": {
					format: "json"
					data: effects: {for i in _invoking {
						(i.effect.name): {
							table:      i.table
							field:      i.field
							state:      i.state
							onDone:     i.onDone
							onError:    i.onError
							row:        i.row
							idempotent: i.effect.sink.idempotent
							if !i.effect.sink.idempotent {reentry: i.effect.reentry}
							attempts: i.effect.attempts
							handler:  "effects/\(i.effect.name).js"
							if i.effect.secrets != _|_ {secrets: i.effect.secrets}
							if i.effect.sink.credential != _|_ {credential: i.effect.sink.credential}
							if i.effect.endowments != _|_ {endowments: i.effect.endowments}
						}
					}}
				}
			}
			for i in _invoking {
				"services/airlock/dapr/\(i.effect.name).yaml": {
					format: "yaml"
					data: {
						apiVersion: "dapr.io/v1alpha1"
						kind:       "Component"
						metadata: name: i.effect.name
						spec: {
							type:    "bindings.http"
							version: "v1"
							metadata: [
								// A bridge is the cluster's own, reached in plain HTTP on the
								// airlock's outbound network.
								{name: "url", value: [if i.effect.sink.bridge != _|_ {"http://bridge-\(i.effect.sink.bridge):\(mecha.#BridgePort)"}, i.effect.sink.origin][0]},
								// The sink's own status comes back to the handler, a refusal
								// being an answer rather than a binding error.
								{name: "errorIfNot2XX", value: "false"},
							]
						}
					}
				}
				"effects/\(i.effect.name).js": {format: "jessie", src: "effects/\(i.effect.name).js"}
			}

			if len(E.code.state.schedules) > 0 {
				// The table is mecha's: the cluster, handed the schedules' names,
				// places it in the database as 800_schedule.sql, and this seeds it
				// after, one row per declaration. An upsert on the name, which keeps
				// a watermark a schedule has earned; but initdb runs once per volume,
				// so nothing restates a schedule on an existing one. The page's and
				// the edge's builds place the table before it (bundle/edge-scripts.ts).
				"services/database/migrations/801_schedule_seed.sql": {
					format: "sql"
					text: strings.Join([for _, sc in E.code.state.schedules {
						"""
						INSERT INTO schedule (name, cron, time_zone, suspended, max_lateness_seconds,
						                      concurrency_policy, done_entity, done_filter,
						                      emits_entity, emits_values)
						VALUES (\((#sqlLit & {v: sc.name}).out), \((#sqlLit & {v: sc.cron}).out), \((#sqlLit & {v: sc.timeZone}).out), \(sc.suspend), \(sc.maxLatenessSeconds),
						        \((#sqlLit & {v: sc.concurrency}).out), \([if sc.done != _|_ {(#sqlLit & {v: E.code.state.entities[sc.done.entity].table}).out}, "NULL"][0]), \([if sc.done != _|_ {(#sqlLit & {v: sc.done.filter}).out}, "NULL"][0]),
						        \((#sqlLit & {v: E.code.state.entities[sc.emits.entity].table}).out), \((#sqlLit & {v: json.Marshal(sc.emits.values)}).out))
						ON CONFLICT (name) DO UPDATE SET
						  cron = EXCLUDED.cron, time_zone = EXCLUDED.time_zone,
						  suspended = EXCLUDED.suspended,
						  max_lateness_seconds = EXCLUDED.max_lateness_seconds,
						  concurrency_policy = EXCLUDED.concurrency_policy,
						  done_entity = EXCLUDED.done_entity, done_filter = EXCLUDED.done_filter,
						  emits_entity = EXCLUDED.emits_entity, emits_values = EXCLUDED.emits_values;
						"""
					}], "\n") + "\n"
				}
			}
			"services/database/migrations/007_txid.sql": {
				format: "sql"
				// A column DEFAULT only fires on INSERT; updates restamp here so
				// every write's response row carries the txid that committed it.
				text: """
					CREATE OR REPLACE FUNCTION restamp_txid() RETURNS trigger
					LANGUAGE plpgsql AS $$
					BEGIN
					  NEW.txid := pg_current_xact_id()::text::bigint;
					  RETURN NEW;
					END $$;

					""" + strings.Join([for ent in E._serverEntities {
					"""
					DROP TRIGGER IF EXISTS restamp_txid ON \(ent.table);
					CREATE TRIGGER restamp_txid BEFORE UPDATE ON \(ent.table)
					  FOR EACH ROW EXECUTE FUNCTION restamp_txid();
					"""
				}], "\n") + "\n"
			}
			for rm in E._raw {
				"services/database/migrations/\(rm.name)": {format: "sql", src: rm.src}
			}
			if E._seedFile {
				"services/database/migrations/900_seed.sql": {
					format: "seed-sql"
					data:   (#seedData & {code: E.code}).out
				}
			}
			// Tests' rows (#App.state.fixture), which a release's initdb skips.
			if E.code.state.fixture != _|_ {
				"services/database/migrations/950_fixture.sql": {format: "sql", src: E.code.state.fixture.src}
			}

			// Only a cluster whose change feed runs has a conduit to configure.
			if E.cluster.capabilities.capture {
				"docker/conduit-pipeline.yaml": {
					format: "yaml"
					data: {
						version: "2.2"
						pipelines: [{
							id:     "cdc-to-bus"
							status: "running"
							connectors: [{
								id:     "postgres-source"
								type:   "source"
								plugin: "builtin:postgres"
								settings: {
									url:                       "${DATABASE_URL}"
									tables:                    E._cdcTables
									cdcMode:                   "logrepl"
									snapshotMode:              "never"
									"logrepl.publicationName": E._pub
									"logrepl.slotName":        (mecha.#ConduitSlot & {app: E.code.meta.name}).name
									// Without this the http connector re-decodes the payload
									// against the captured Avro schema and chokes post-encode.
									"logrepl.withAvroSchema": "false"
								}
							}, {
								id:     "bus-destination"
								type:   "destination"
								plugin: "standalone:http"
								settings: {
									url: "http://mesh-events:3500/v1.0/publish/redis-streams/cdc-events"
									// The probe is a HEAD, which dapr's publish endpoint 404s.
									validateConnection: "false"
								}
							}]
							processors: [{
								// A delete from a table of default replica identity carries
								// no before-image, only its key: the key becomes the image,
								// or restore-deleted-row would put `%!s(<nil>)` on the bus.
								id:        "key-as-before"
								plugin:    "builtin:field.set"
								condition: "{{ if or .Payload.After .Payload.Before }}false{{ else }}true{{ end }}"
								settings: {
									field: ".Payload.Before"
									value: "{{ toJson .Key }}"
								}
							}, {
								// field.set writes a string; only the key it wrote is one.
								id:        "decode-key-before"
								plugin:    "builtin:json.decode"
								condition: "{{ if eq (printf \"%T\" .Payload.Before) \"opencdc.RawData\" }}true{{ else }}false{{ end }}"
								settings: field: ".Payload.Before"
							}, {
								// Which table changed, carried in the row itself. The bus
								// is one topic for every table and each pipeline reads all
								// of it, so a consumer has to tell its own source's events
								// apart; column shape cannot do it (favorite and bookmark
								// are column-identical, and inferring from a witness column
								// silently mis-fires the moment a sibling table grows one).
								// Both sides are stamped because a delete's After is empty
								// and restore-deleted-row back-fills it from Before.
								id:     "stamp-collection-after"
								plugin: "builtin:field.set"
								// Guarded, and the guard is the whole point: a delete carries an
								// EMPTY After, and setting a field on it CREATES one — which makes
								// restore-deleted-row believe there is a row worth keeping, so it
								// skips the back-fill and the delete reaches the bus as {__table}
								// and nothing else. Every un-favourite then fails to recount and
								// the sink only ratchets up.
								condition: "{{ if .Payload.After }}true{{ else }}false{{ end }}"
								settings: {
									field: ".Payload.After.\(_cdcTableField)"
									value: "{{ index .Metadata \"opencdc.collection\" }}"
								}
							}, {
								id:        "stamp-collection-before"
								plugin:    "builtin:field.set"
								condition: "{{ if .Payload.Before }}true{{ else }}false{{ end }}"
								settings: {
									field: ".Payload.Before.\(_cdcTableField)"
									value: "{{ index .Metadata \"opencdc.collection\" }}"
								}
							}, {
								id:     "stringify-before"
								plugin: "builtin:json.encode"
								settings: field: ".Payload.Before"
							}, {
								id:        "retain-before"
								plugin:    "builtin:field.set"
								condition: "{{ if and .Payload.After .Payload.Before }}true{{ else }}false{{ end }}"
								settings: {
									field: ".Payload.After.\(_cdcBeforeField)"
									value: "{{ printf \"%s\" .Payload.Before }}"
								}
							}, {
								id:     "stringify-after"
								plugin: "builtin:json.encode"
								settings: field: ".Payload.After"
							}, {
								// The http destination posts only Payload.After, and a
								// delete's After is empty — back-fill from Before so every
								// bus message carries the changed row.
								id:     "restore-deleted-row"
								plugin: "builtin:field.set"
								settings: {
									field: ".Payload.After"
									value: "{{ if .Payload.After }}{{ printf \"%s\" .Payload.After }}{{ else }}{{ printf \"%s\" .Payload.Before }}{{ end }}"
								}
							}]
						}]
					}
				}
			}
			for _, pl in E.code.state.pipelines if pl.trigger == "cdc" if pl.raw == _|_ {
				"docker/\(E.code.meta.name)-\(pl.name).yaml": {
					format: "yaml"
					data: (#rpkPipeline & {
						p:           pl
						sourceTable: E.code.state.entities[pl.from].table
						sinkTable:   E.code.state.entities[pl.to].table
						sinkPk: [for fld in E.code.state.entities[pl.to].fields if fld.pk {fld.name}][0]
						carriers: E._cdcCarriers
						authOn:   E._authOn
					}).out
				}
			}
			for _, pl in E.code.state.pipelines if pl.trigger == "schedule" {
				"docker/\(E.code.meta.name)-\(pl.name).yaml": {
					format: "yaml"
					data: (#rpkScheduled & {
						p:         pl
						sinkTable: E.code.state.entities[pl.to].table
						authOn:    E._authOn
					}).out
				}
			}

			for _, dr in E.code.state.drains {
				"docker/\(E.code.meta.name)-\(dr.name).yaml": {
					format: "yaml"
					data: (#rpkDrain & {d: dr, app: E.code.meta.name, authOn: E._authOn}).out
				}
			}

			// Raw pipelines: the assembly rpk stream is copied verbatim beside the
			// derived ones, so the transform image and the rpk lint list treat all
			// pipelines alike.
			for _, pl in E.code.state.pipelines if pl.raw != _|_ {
				"docker/\(E.code.meta.name)-\(pl.name).yaml": {format: "yaml", src: pl.src}
				"\(pl.src)": {format: "yaml", src: pl.src}
			}

			_duckstreams: [if E.code.state.duckstreams != _|_ {[for _, d in E.code.state.duckstreams {d}]}, []][0]
			for _, ds in _duckstreams {
				"pipelines/duckstream/\(ds.name).sql": {
					format: "sql"
					text:   ds.sql + "\n"
				}
			}
		}
		"docker/Caddyfile": {
			format: "caddyfile"
			// The asset's last block, recomposed here because both halves are
			// per-app. A route is a real path now — the router reads
			// location.pathname — so this is what lets a deep link reach a document
			// at all: the prerendered one where the build wrote it, the terminal's
			// entry otherwise, and a 404 for a path that is neither.
			_anchor: """
				  handle {
				    root * /srv
				    header Cache-Control "no-cache"
				    import files
				  }
				"""
			// The default locale is served unprefixed, so its prefixed spelling is an
			// alias and answers 301 rather than a second copy of the document.
			// handle_path strips the matched prefix, leaving {uri} as path AND query —
			// /pt-br/regras?lang=es becomes /regras?lang=es, and `lang` is a wire
			// parameter the redirect has no business dropping. The bare prefix matches
			// no wildcard, so it is rewritten into one rather than redirected on its
			// own: a second `redir` could only name a literal target and would lose
			// the query there (measured, caddy 2.10.0).
			// The entry document lives under shell/ and answers at every route,
			// so its own directory is a location rather than an address: a
			// reader who lands there is served the document and told by the
			// router that /shell/ is no route of this app. It is the app's root
			// they meant.
			_entry: """
			    @entry path /\(E.terminal.surface.entry) /\(strings.TrimSuffix(E.terminal.surface.entry, "index.html"))
			    redir @entry / permanent

			"""
			_alias: [
				if E._shell.i18n != _|_ {"""
				    @unprefixed path /\(E._shell.i18n.locales[E._shell.i18n.default].path)
				    rewrite @unprefixed /\(E._shell.i18n.locales[E._shell.i18n.default].path)/
				    handle_path /\(E._shell.i18n.locales[E._shell.i18n.default].path)/* {
				      redir {uri} permanent
				    }

				"""},
				"",
			][0]
			// The reader's language decided at the door, so a reader whose
			// language is not the address's is answered with the document of
			// their own address rather than one that boots and throws itself
			// away. Answered, not redirected: a 302 is a round trip ahead of
			// every byte of the page, and the terminal restates the address it
			// was answered for (shell.js show) without one. Vary says the
			// unprefixed address is one document per language.
			//
			// This is not a second implementation of negotiateLocale. That
			// function reads navigator.languages — an ordered list with no
			// q-values — and takes the first declared tag, exact before bare
			// language. The capture below is that same rule compiled: one
			// alternation of the declared tags and their languages, longest
			// first, matched leftmost against the header the browser builds from
			// the same ordered list. negotiation_test.ts runs a corpus
			// through both and refuses a disagreement.
			//
			// `?lang=` is excluded: it is the wire's own parameter and the
			// terminal answers it, on the terms a plain route's language gets.
			_defaultAddress: {for r in E._shell.routes {(r.screen): (#address & {route: r, i18n: E._shell.i18n, tag: E._shell.i18n.default}).out}}
			// Caddy path matchers are exact, so a :param segment widens to `*`
			// the way the served matcher list does.
			_widened: {for s, a in _defaultAddress {(s): "/" + strings.Join([
				for seg in strings.Split(strings.TrimPrefix(a, "/"), "/") {
					[if strings.HasPrefix(seg, ":") {"*"}, seg][0]
				},
			], "/")
			}}
			_branches: [
				for r in E._shell.routes for tag in E._others
				let here = _defaultAddress[r.screen]
				let there = (#address & {route: r, i18n: E._shell.i18n, "tag": tag}).out
				let names = (#params & {pattern: here}).out
				// Segment by segment, because a :param is a whole segment and
				// replacing the "/:" that introduces it would leave its name
				// behind in the pattern.
				let at = [
					if len(names) == 0 {"          path \(here)"},
					"          path_regexp \(r.screen) ^/" + strings.Join([
						for seg in strings.Split(strings.TrimPrefix(here, "/"), "/") {
							[if strings.HasPrefix(seg, ":") {"([^/]+)"}, seg][0]
						},
					], "/") + "$",
				][0]
				// Read back by name: a translated spelling is free to put the
				// same :params in another order.
				let target = [
					if len(names) == 0 {there},
					strings.Join([
						for seg in strings.Split(there, "/") {
							[
								if strings.HasPrefix(seg, ":") {"{re.\(r.screen).\([for i, n in names if n == strings.TrimPrefix(seg, ":") {i + 1}][0])}"},
								seg,
							][0]
						},
					], "/"),
				][0]
				let captures = [for c, l in E._meansLocale if l == tag {c}] {"""
				        @\(r.screen)_\(E._shell.i18n.locales[tag].path) {
				\(at)
				          not query lang=*
				          vars_regexp {re.lang.1} (?i)^(\(strings.Join(captures, "|")))$
				        }
				        rewrite @\(r.screen)_\(E._shell.i18n.locales[tag].path) \(target)
				"""},
			]
			// Caddy refuses an empty path matcher at provision, so a program with
			// no route emits neither this block nor `_rewrite` below.
			_routeless: len(E._shell.routes) == 0
			_negotiate: [
				if E._shell.i18n == _|_ {""},
				if len(E._others) == 0 {""},
				if _routeless {""},
				"""
				    route {
				      @negotiable path \(strings.Join(list.SortStrings([for _, w in _widened {w}]), " "))
				      header @negotiable Vary Accept-Language
				      @lang header_regexp lang Accept-Language (?i)(?:^|,)\\s*(\(strings.Join(E._alternatives, "|")))\\b
				      handle @lang {
				\(strings.Join(_branches, "\n"))
				      }
				    }

				""",
			][0]
			_addressed: E._addressed
			// The same addresses as caddy path matchers. A `:param` segment widens to
			// `*`: its value is a row id the door cannot know. The trailing slash is
			// trimmed so a locale's bare prefix reads `/es` rather than `/es/`; both
			// spellings are then listed, because a caddy path matcher is exact and a
			// reader who types the slash is at the same route.
			_matcher: {for a in _addressed {
				let widened = strings.TrimSuffix("/"+strings.Join([
					for seg in strings.Split(strings.TrimPrefix(a, "/"), "/") {
						[if strings.HasPrefix(seg, ":") {"*"}, seg][0]
					},
				], "/"), "/")
				([if widened == "" {"/"}, widened][0]): true
			}}
			_matchers: list.SortStrings([
				for a, _ in _matcher {a},
				for a, _ in _matcher if a != "/" {a + "/"},
			])
			// `route`, because caddy orders directives by its own table and the
			// catch-all `handle` sorts ahead of both `handle_path` and `route`:
			// written outside one, the alias is answered 200 by the file server
			// before its redirect is ever reached (measured, caddy 2.10.0). Inside,
			// these run as written, and the path-scoped `handle` blocks above still
			// take their requests first.
			//
			// `@file` ahead of `@route`, and not one `try_files` over both: try_files
			// rewrites to its LAST candidate when none exist, so a single directive
			// naming the entry answers every missing asset with the entry document at
			// 200 instead of 404 (measured, caddy 2.10.0). Here a request that names
			// no file and no route reaches file_server unrewritten, which is the 404
			// a crawler is owed.
			_rewrite: [
				if _routeless {""},
				"""
					      @route path \(strings.Join(_matchers, " "))
					      rewrite @route /\(E.terminal.surface.entry)

					""",
			][0]
			// The addresses of the routes rendered on request, widened and in
			// both slash spellings as `@route` below, and answered by the
			// terminal's renderer after the door has chosen the language: what
			// reaches it is always a locale's own address. A file the app serves
			// is not one, for the reason `@file` precedes `@route`: a route whose
			// first segment is a :param widens to `/*/*`, which every file under
			// shell/ and messages/ matches.
			_renderedAt: list.SortStrings([
				for n in E._onRequest for a in E._spellings[n]
				let widened = "/" + strings.Join([
					for seg in strings.Split(strings.TrimPrefix(a, "/"), "/") {
						[if strings.HasPrefix(seg, ":") {"*"}, seg][0]
					},
				], "/")
				for w in [widened, widened + "/"] {w},
			])
			_render: [
				if len(E._onRequest) == 0 {""},
				"""
				    @rendered {
				      path \(strings.Join(_renderedAt, " "))
				      not file {
				        root /srv
				        try_files {path} {path}/index.html
				      }
				    }
				    handle @rendered {
				      reverse_proxy {$PRONTO_UPSTREAM_RENDER:render:\(omnishell.#Render.port)} {
				        header_up dapr-app-id render
				        import bounded-render
				      }
				    }

				""",
			][0]
			// The documents rendered before any request, in both slash spellings
			// as `@route` below. Each is a template naming the deployment's
			// origin (`_origin` below), which is what its canonical and
			// alternates are absolute against, answered with its file's
			// validator as the crawler files are (the asset's `templated`).
			_documentAt: list.SortStrings([
				for a in E.terminal.surface.documents
				let bare = strings.TrimSuffix(a, "/")
				for w in [if bare == "" {"/"}, if bare != "" {bare}, if bare != "" {bare + "/"}] {w},
			])
			_document: [
				if len(_documentAt) == 0 {""},
				"""
				    @document path \(strings.Join(_documentAt, " "))
				    handle @document {
				      root * /srv
				      header Cache-Control "no-cache"
				      try_files {path}/index.html
				      import templated text/html
				    }

				""",
			][0]
			_served: """
				  route {
				\(_entry)\(_alias)\(_negotiate)\(_render)\(_document)    handle {
				      root * /srv
				      header Cache-Control "no-cache"
				      @file file {path} {path}/index.html
				      rewrite @file {http.matchers.file.relative}
				\(_rewrite)      import files
				    }
				  }
				"""
			// An asset the anchor is absent from indexes out of range here, rather
			// than emitting a proxy that silently 404s every deep link.
			_split: strings.SplitN(_caddyfileAsset, _anchor, 2)
			// Units execute in their declared realm or agent; the terminal's
			// Trusted Types policies belong only to its own runtime.
			_unitPaths: list.SortStrings([for f, _ in {
				for _, v in E.code.capabilities.vendored if v.isolation != "compartment"
				for f in v.files {(f): true}
			} {"/\(f)"}])
			// A presenter's worker script answers with the presenter's own
			// policy, which governs the worker it starts.
			_presenterAt: [if E._shell.presenter != _|_ {"/omnishell/interpreter/presenter.js"}]
			// A container hatch's pages that post a form to another site
			// (#Capabilities.hatches.forms): their own policy, the door's with
			// those origins added to form-action alone.
			_forms: [for _, h in E.code.capabilities.hatches if h.forms != _|_ for p, origins in h.forms {path: p, to: origins}]
			_fenced: list.Concat([_unitPaths, _presenterAt, [for f in _forms {f.path}]])
			_security: [if E.terminal.surface.contentSecurityPolicy != _|_ {
				let matcher = [if len(_fenced) > 0 {"  @terminal not path \(strings.Join(_fenced, " "))\n  header @terminal"}, "  header"][0]
				let presenter = [for p in _presenterAt {"  @presenter path \(p)\n  header @presenter Content-Security-Policy \(json.Marshal(E._shell.presenter.policy))\n"}]
				// What the presenter's script-src 'self' admits is answered
				// from a file the door holds, never by an upstream.
				let scripted = [for p in _presenterAt {"  @scripted {\n    header_regexp Sec-Fetch-Dest ^(\(strings.Join(E._shell.presenter.scripted, "|")))$\n    not file {\n      root /srv\n    }\n  }\n  handle @scripted {\n    respond \"\" 403\n  }\n"}]

				// A door built as a release names the inline scripts its documents
				// run; an addressed file never changes, so it is never revalidated.
				let policy = [if E.cluster.meta.served != _|_ {strings.Replace(E._browserPolicy, "script-src 'self'", "script-src 'self' {$PRONTO_RELEASE_SCRIPTS}", 1)}, E._browserPolicy][0]
				let immutable = [if E.cluster.meta.served != _|_ {"  @immutable path_regexp /_immutable-[0-9a-f]{64}-[^/]*$\n  header @immutable >Cache-Control \"public, max-age=31536000, immutable\"\n"}, ""][0]
				let forms = [for i, f in _forms {"  @form\(i) path \(f.path)\n  header @form\(i) Content-Security-Policy \(json.Marshal(strings.Replace(policy, "form-action 'self'", strings.Join(list.Concat([["form-action 'self'"], f.to]), " "), 1)))\n"}]
				"\(matcher) Content-Security-Policy \(json.Marshal(policy))\n\(strings.Join(presenter, ""))\(strings.Join(forms, ""))\(strings.Join(scripted, ""))\(immutable)"
			}, ""][0]
			text: resilience.caddySnippets + strings.Replace(_split[0] + _served + _split[1], "(app) {\n", "(app) {\n" + _security, 1)
		}
		// The crawler files and the documents are caddy templates. `$o` is the
		// deployment's origin, which the door holds — see the Caddyfile for why
		// the build cannot write one instead — and `_o` is how a file names it.
		// Only a file that names an address declares it, so a refusal carries no
		// unread variable.
		_origin: "{{- $o := placeholder \"http.vars.origin\" -}}"
		_o:      "{{$o}}"
		"robots.txt": {
			format: "text"
			// An app behind a session is not a site: every address answers with
			// the same login wall, and inviting a crawler in only puts that wall
			// in search results under the app's own name. It names no origin
			// either — the whole of what it has to say is the refusal.
			text: [
				if E._public {"""
					\(_origin)
					# generated by pronto from program.cue — do not edit
					User-agent: *
					Allow: /
					""" + [if E._envelope.sitemap.enabled { "\n\nSitemap: {{$o}}/sitemap.xml\n" }, "\n"][0]},
				"""
					# generated by pronto from program.cue — do not edit
					User-agent: *
					Disallow: /

					""",
			][0]
		}
		// The terminal renders these, from the files this emission writes
		// beside them (write.ts): a document is the screen the shell would
		// draw first, so only the terminal can say what it holds.
		// Their canonical and alternates are absolute, so each is spelled
		// after `_o` and declares it, as the sitemap does.
		for a in E.terminal.surface.documents {
			"documents\(strings.TrimSuffix(a, "/"))/index.html": {format: "document", data: {address: a, origin: _o, declare: _origin}}
		}
		if E._envelope.sitemap.enabled {
			"sitemap.xml": {
				format: "text"
				_isAdvanced: E._envelope.sitemap.declared
				// One <url> per crawlable route per locale, each carrying the whole
				// alternate set including itself — which is what the protocol asks
				// for: a crawler reaching any one address learns every other, and
				// the three spellings of a page are read as one page rather than as
				// near-duplicates competing with each other.
				_urls: [
					if !_isAdvanced && E._shell.i18n == _|_ for r in E._crawlable {
						"  <url><loc>\(_o)\((#address & {route: r}).out)</loc></url>"
					},
					if _isAdvanced && E._shell.i18n == _|_ for r in E._crawlable {
						let meta = _sitemapRoutes[r.screen]
						let addr = (#address & {route: r}).out
						strings.Join([
							"  <url>",
							"    <loc>\(_o)\(addr)</loc>",
							"    <changefreq>\(meta.freq)</changefreq>",
							"    <priority>\(meta.priority)</priority>",
							"  </url>",
						], "\n")
					},
					if E._shell.i18n != _|_ for r in E._crawlable for tag in E._locales {
						let meta = _sitemapRoutes[r.screen]
						let locAddr = (#address & {route: r, i18n: E._shell.i18n, "tag": tag}).out
						strings.Join(list.Concat([
							[
								"  <url>",
								"    <loc>\(_o)\(locAddr)</loc>",
							],
							[
								if _isAdvanced { "    <changefreq>\(meta.freq)</changefreq>" },
								if _isAdvanced { "    <priority>\(meta.priority)</priority>" },
							],
							[for other in E._locales {
								"    <xhtml:link rel=\"alternate\" hreflang=\"\(other)\" href=\"\(_o)\((#address & {route: r, i18n: E._shell.i18n, tag: other}).out)\"/>"
							}],
							[
								"    <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"\(_o)\((#address & {route: r, i18n: E._shell.i18n, tag: E._shell.i18n.default}).out)\"/>",
								"  </url>",
							],
						]), "\n")
					},
					if _isAdvanced for ext in E._envelope.sitemap.extra {
						let loc = [
							if strings.HasPrefix(ext, "http://") || strings.HasPrefix(ext, "https://") { ext },
							"\(_o)\(ext)"
						][0]
						let locEsc = strings.Replace(
							strings.Replace(
								strings.Replace(
									strings.Replace(
										strings.Replace(loc, "&", "&amp;", -1),
										"<", "&lt;", -1),
									">", "&gt;", -1),
								"\"", "&quot;", -1),
							"'", "&apos;", -1)
						strings.Join([
							"  <url>",
							"    <loc>\(locEsc)</loc>",
							"    <changefreq>monthly</changefreq>",
							"    <priority>0.5</priority>",
							"  </url>",
						], "\n")
					},
				]
				text: strings.Join(list.Concat([
					[
						if len(_urls) > 0 {_origin},
						"<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
						"<!-- generated by pronto from program.cue — do not edit -->",
						// The xhtml namespace is what the alternates are spelled in,
						// so a single-locale app declares no namespace it never uses.
						[
							if E._shell.i18n != _|_ {"<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">"},
							"<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
						][0],
					],
					_urls,
					["</urlset>", ""],
				]), "\n")
			}
		}
		"shell/shell.yaml": {
			format: "yaml"
			data:   E._shell
		}
		"shell/shell.json": {
			format: "json"
			data:   E._shell
		}
		"\(E.terminal.surface.entry)": {
			let _parts = strings.Split(E.terminal.surface.assets.html, "<link rel=\"icon\" href=\"data:,\">")
			_markerCheck: [if !E._envelope._hasEnvelopeInjections || len(_parts) == 2 { true }, "omnishell html asset must contain exactly one <link rel=\"icon\" href=\"data:,\"> marker, found \(len(_parts) - 1)"][0] & true
			format: "text"
			_html: [
				if E._envelope._hasEnvelopeInjections if len(_parts) == 2 {
					_parts[0] + E._envelope.headLinks + _parts[1]
				},
				E.terminal.surface.assets.html,
			][0]
			// The meta travels in the release's hashed bytes, including offline
			// navigation, so changing resource authority changes its identity.
			_escaped: strings.Replace(strings.Replace(E._browserPolicy, "&", "&amp;", -1), "\"", "&quot;", -1)
			text: [if E._browserPolicy != "" {
				strings.Replace(_html, "<head>", "<head>\n<meta http-equiv=\"Content-Security-Policy\" content=\"\(_escaped)\">", 1)
			}, _html][0]
		}
		"\(E.terminal.surface.css)": {
			format: "text"
			text:   E.terminal.surface.assets.css
		}
		"\(E.terminal.surface.boot)": {
			format: "text"
			text:   E.terminal.surface.assets.boot
		}
		"\(E.terminal.surface.sw)": {
			format: "text"
			text:   E.terminal.surface.assets.sw
		}
		"shell/design.css": {
			format: "css"
			text:   E._designCss
		}
		for k, f in E._envelope.files {
			(k): f
		}
		for _, s in E.code.surface.screens {
			// A CUE-authored screen (markup) emits its html; an assembly screen
			// is authored at the served path itself.
			if s.markup != _|_ {
				"\(s.files.html)": {format: "html", text: s.markup}
			}
			if s.markup == _|_ {
				"\(s.files.html)": {format: "html", src: s.files.html}
			}
			"\(s.files.css)": {format: "css", src: s.files.css}
			for i in s.files.handlers if E._composedHandlers[i] == _|_ {"\(i)": {format: "jessie", src: i}}
			for i in s.files.adapters if !strings.HasPrefix(i, "/") {"\(i)": {format: "jessie", src: i}}
			if s.files.renderers != _|_ {
				for i in s.files.renderers {"\(i)": {format: "jessie", src: i}}
			}
		}
		for _, pl in E.code.state.pipelines if pl.trigger == "cdc" if pl.raw == _|_ {
			if pl.fold == _|_ {
				"\(pl.transform.src)": {format: "bloblang", src: pl.transform.src}
				"\(pl.shim)": {format: "js", src: pl.shim}
			}
			if pl.fold != _|_ {
				"\(pl.fold.src)": {format: "js", src: pl.fold.src}
			}
		}
		for _, h in E.code.surface.handlers {
			"\(h.src)": {format: "jessie", src: h.src}
		}
		for _, e in E.code.state.entities for _, v in e.validations {
			"\(v.src)": {format: "jessie", src: v.src}
		}
		"tests/pairs.yaml": {
			format: "yaml"
			data: pairs: [for _, t in E.code.meta.tests {t}]
		}
		// The runtime is fixed by default, and its pieces are owned by their
		// implementations: mecha publishes the virtual cluster as bayt targets,
		// omnishell the virtual terminal, and the build seat is their fixed
		// composition — so the runtime compose is bayt's, under .bayt/. This
		// root exists for what resolves a project by its nearest compose file:
		// sayt's project-dir walk, and every `docker compose up launch` run
		// from the app directory with no -f.
		"compose.yaml": {
			format: "yaml"
			// bayt's aggregate holds no closure, so the project's own includes,
			// mecha's mode file among them, are restated here.
			data: include: [{path: "./.bayt/compose.yaml"}, for i in E.build.project.compose.includes {path: i}]
		}
		// The networks the cluster's targets join, which bayt declares nowhere:
		// the project includes this in every closure, and the root above
		// includes it beside bayt's tree.
		if E.cluster.surface.networks != _|_ {
			"compose.networks.yaml": {
				format: "yaml"
				data: networks: E.cluster.surface.networks
			}
		}
		"bayt.json": {
			format: "json"
			data:   E.build.project
		}
		"bayt.cue": {
			format: "cue"
			text:   """
				// The build graph is authored in program.cue (the build seat) and
				// lands here as bayt.json; unifying it back through bayt.#project
				// keeps bayt's schema live at generate time.
				@extern(embed)

				package \(E._pkg)

				import (
					bayt "github.com/bonisoft3/bayt/core:bayt"
					mecha "github.com/bonisoft3/pronto/clusters:mecha"
					omnishell "github.com/bonisoft3/pronto/terminals:omnishell"
					prontoloop "github.com/bonisoft3/pronto/loops:sayt"
				)

				\(E._hatchSeam)
				cluster:  mecha.#Cluster
				terminal: omnishell.#Terminal
				loop:     prontoloop.#Loop

				_baytData: _ @embed(file="bayt.json")

				project: _\(E._pkg)
				_\(E._pkg): bayt.#project & _baytData

				depManifestsIn: {[string]: _}
				_render: (bayt.#render & {project: _\(E._pkg), depManifests: depManifestsIn})

				"""
		}
		// Only lint carries rules: the other verbs use their builtins against
		// the files they expect — build/test read .vscode/tasks.json, launch
		// drives compose.yaml's `launch` service convention.
		".say.yaml": {
			format: "yaml"
			data:   E.loop.surface.sayYaml
		}
		".vscode/tasks.json": {
			format: "json"
			data:   E.loop.surface.tasksJson
		}

		// The pages, cloudflare and docker ceremonies run release.nu (the
		// loop's release rule), which refuses to run without a goreleaser
		// file: this one is the shim iris uses, builds skipped and the GitHub
		// release disabled, so there is a file to run and nothing to publish.
		// Inert here. k8s releases by its own engine and carries none of it.
		if len([for t in E.code.meta.targets if t == "pages" || t == "cloudflare" || t == "docker" {t}]) > 0 {
			".goreleaser.yaml": {
				format: "yaml"
				data: {version: 2, project_name: E.code.meta.name, dist: "dist/goreleaser", builds: [{builder: "zig", skip: true}], release: {disable: true}, changelog: {disable: true}}
			}
		}
		// The mirror release: the workflow bundles and deploys the app on its
		// mirror, where copybara moves it to the root GitHub reads.
		let hasPages = list.Contains(E.code.meta.targets, "pages")
		let hasCloudflare = list.Contains(E.code.meta.targets, "cloudflare")
		if hasPages || hasCloudflare {
			// An app at the mirror's root releases from there.
			let pagesDir = [if E.build.project.dir != "" {"\n        working-directory: \(E.build.project.dir)"}, ""][0]
			let pagesPrefix = [if E.build.project.dir != "" {"\(E.build.project.dir)/"}, ""][0]
			// The app's tools, the runtime among them, are its pinned releases,
			// which setup installs.
			let pagesSetup = "\n      - run: sayt setup"

			let pagesJob = """
				  pages:
				    runs-on: ubuntu-24.04
				    environment:
				      name: github-pages
				      url: ${{ steps.deploy.outputs.page_url }}
				    steps:
				      - uses: actions/checkout@v7
				      # The released sayt at the version the toolchain pins, its mise cached.
				      - uses: bonisoft3/sayt/.github/actions/sayt/install@v\(distribution.#SaytVersion)
				        with:
				          version: v\(distribution.#SaytVersion)\(pagesSetup)
				      - run: sayt release@pages --snapshot --base="/${GITHUB_REPOSITORY##*/}"\(pagesDir)
				      - uses: actions/configure-pages@v5
				      - uses: actions/upload-pages-artifact@v4
				        with:
				          path: \(pagesPrefix)dist/browser
				      - id: deploy
				        uses: actions/deploy-pages@v4
				      - run: sayt verify@pages --target="${{ steps.deploy.outputs.page_url }}"\(pagesDir)
				"""

			let cloudflareJob = """
				  cloudflare:
				    runs-on: ubuntu-24.04
				    env:
				      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
				      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
				      JWT_SECRET: ${{ secrets.JWT_SECRET }}
				    steps:
				      - uses: actions/checkout@v7
				      # The released sayt at the version the toolchain pins, its mise cached.
				      - uses: bonisoft3/sayt/.github/actions/sayt/install@v\(distribution.#SaytVersion)
				        with:
				          version: v\(distribution.#SaytVersion)\(pagesSetup)
				      - if: "${{ env.CLOUDFLARE_API_TOKEN != '' }}"
				        run: sayt release@cloudflare\(pagesDir)
				      - if: "${{ env.CLOUDFLARE_API_TOKEN != '' }}"
				        run: |
				          TARGET=$(cat \(pagesPrefix)dist/cloudflare/origin.txt 2>/dev/null || cat dist/cloudflare/origin.txt 2>/dev/null || echo "$PRONTO_DEPLOYED_URL")
				          if [ -n "$TARGET" ]; then
				            sayt verify@cloudflare --target="$TARGET"
				          else
				            sayt verify@cloudflare
				          fi\(pagesDir)
				"""

			let jobsList = [
				if hasPages { pagesJob },
				if hasCloudflare { cloudflareJob },
			]
			let jobsBody = strings.Join(jobsList, "\n")

			".github/workflows/cd.yml": {
				format: "yaml"
				text:   """
					# Release the app: bundle it into one document and deploy it.
					#
					# GitHub reads workflows only from a repository's root .github/, so this
					# file is inert in the monorepo and active in the mirror, where copybara
					# moves it to the root. The trigger is the plain `v*` tag the monorepo's
					# cd.yml creates here once the mirror holds the tagged commit; nothing
					# publishes from a branch, and a dispatch redeploys what main holds.
					#
					# The release verb builds the document as a developer would, a snapshot
					# since the tag is the release already. The site is a project site, so
					# the document is bundled for the repository's path prefix and doubles
					# as the site's 404.html, which is what makes a deep link boot.

					name: cd

					on:
					  push:
					    tags:
					      - 'v*'
					  workflow_dispatch:

					permissions:
					  contents: read
					  pages: write
					  id-token: write

					concurrency:
					  group: cd
					  cancel-in-progress: false

					jobs:
					\(jobsBody)
					"""
			}
		}

		// The terminal's own toolchain stanza, in the drop-in directory mise
		// merges beside the hand-owned config rather than in it: a contributor
		// that writes its own file can be withdrawn by deleting one, and the
		// config a person authors stays a thing a person authored.
		if E.terminal.surface.miseConf != "" {
			".config/mise/conf.d/omnishell.toml": {
				format: "toml"
				text:   E.terminal.surface.miseConf
			}
		}
	}

	manifest: list.SortStrings([for p, _ in files {p}])
}
