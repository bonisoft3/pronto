// #emit derives the emitted-file bundle from an #App. `cue export -e out`
// yields the whole program surface: `manifest` is the list of files, `files`
// maps each path to its content or its source. Derived structure renders in
// CUE (strings for raw formats, structs for the writer to serialize — the
// bayt #render division of labor); assembly files (html, css, jessie,
// bloblang, complex sql) are never CUE strings — they live in the app tree
// and their entries carry `src`. Where a derived config's consumer cannot
// reference a file, the content is inlined via @embed at the reference site.
//
// Not emitted here: .mise.toml (scaffold-owned) and the ir view (ir.html is
// the pinned artifact itself). bayt.cue is emitted as a thin stub over
// bayt.json (the build seat's export), and the sayt verbs run on their
// builtins against emitted files (tasks.json, compose.yaml, .say.yaml lint
// rules).
@extern(embed)

package pronto

import (
	"encoding/json"
	"list"
	"regexp"
	"strconv"
	"strings"

	prontobuild "github.com/bonisoft3/pronto/builders:bayt"
	"github.com/bonisoft3/pronto/clusters:mecha"
	prontoloop "github.com/bonisoft3/pronto/loops:sayt"
	"github.com/bonisoft3/pronto/scales"
	"github.com/bonisoft3/pronto/terminals:omnishell"
)

#File: {
	format: "sql" | "yaml" | "json" | "caddyfile" | "html" | "css" | "cue" | "bloblang" | "jessie" | "js" | "text"
	text?:  string // raw formats, writer-materialized
	data?:  _      // structured formats, writer-serialized
	src?:   string // assembly file authored in place; writer verifies presence
}

_caddyfileAsset: _ @embed(file="assets/Caddyfile", type=text)

_sqlType: {uuid: "UUID", text: "TEXT", bool: "BOOLEAN", int: "INTEGER", bigint: "BIGINT", timestamptz: "TIMESTAMPTZ", tsvector: "TSVECTOR"}

#colSql: C={
	f: #Field
	// The column's derived CHECK body; absent where the field states no cel.
	check?: string
	_frags: list.Concat([
		["\"\(C.f.name)\"", _sqlType[C.f.type]],
		[if C.f.generated != _|_ {"GENERATED ALWAYS AS (\(C.f.generated)) STORED"}],
		[if C.f.pk {"PRIMARY KEY"}],
		[if C.f.generated == _|_ if C.f.default != _|_ {"DEFAULT \(C.f.default)"}],
		[if C.f.generated == _|_ if !C.f.pk && C.f.required {"NOT NULL"}],
		[if C.f.unique != _|_ if C.f.unique {"UNIQUE"}],
		[if C.f.ref != _|_ {"REFERENCES \(C.f.ref)(id) ON DELETE CASCADE"}],
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

#tableSql: T={
	e: #Entity
	_lines: list.Concat([
		[for fld in T.e.fields {
			"  " + (#colSql & {f: fld, if T.e.checks[fld.name] != _|_ {check: T.e.checks[fld.name]}}).out
		}],
		// Platform column, never a #Field: the write's transaction id, returned
		// via Prefer: return=representation so clients can awaitTxId against
		// the shape stream (006_txid.sql restamps it on UPDATE).
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
		[if T.e.access != _|_ if T.e.access.mode == "owned" {
			"  \"scope_id\" TEXT GENERATED ALWAYS AS ('user:' || \"\(T.e.access.owner)\") STORED NOT NULL"
		}],
		// A child of a composition takes its parent's scope. Not GENERATED: a
		// generated column cannot reach another table, so a trigger defends it
		// instead (emitted beside the policies). NOT NULL holds because Postgres
		// checks it after BEFORE triggers, so a child of no parent is refused.
		[if T.e.access != _|_ if T.e.access.mode == "through" {
			"  \"scope_id\" TEXT NOT NULL"
		}],
		// A constant: every subject holds `public:` (subject_scopes in rls.sql
		// says what a public row reached by scope rather than by exemption buys).
		// Writes stay with the permissive policies below and the table grants.
		[if T.e.access != _|_ if T.e.access.mode == "public-read" {
			"  \"scope_id\" TEXT GENERATED ALWAYS AS ('public:') STORED NOT NULL"
		}],
		// The identity table under `service-only`, which is the one place a
		// person reads their own row (the self-select policy below says why).
		// Its own id IS its scope, so `user:<me>` matches exactly that row --
		// the policy and the shape predicate come out as the same statement.
		[if T.e.access != _|_ if T.e.access.mode == "service-only" if T.e.table == "app_user" {
			"  \"scope_id\" TEXT GENERATED ALWAYS AS ('user:' || \"id\") STORED NOT NULL"
		}],
		[if T.e.invariant.check != _|_ {"  CHECK (\(T.e.invariant.check))"}],
	])
	out: "CREATE TABLE IF NOT EXISTS \(T.e.table) (\n" + strings.Join(_lines, ",\n") + "\n);"
}

#sqlLit: L={
	v: string | int | bool
	out: [
		if (L.v & string) != _|_ {"'" + strings.Replace(L.v, "'", "''", -1) + "'"},
		if (L.v & bool) != _|_ {[if L.v {"true"}, "false"][0]},
		"\(L.v)",
	][0]
}

#seedSql: S={
	e: #Entity
	_rows: [for r in S.e.seed {
		_cols: [for f in S.e.fields if r[f.name] != _|_ {f.name}]
		out: "INSERT INTO \(S.e.table) (" + strings.Join(_cols, ", ") + ") VALUES (" +
			strings.Join([for c in _cols {(#sqlLit & {v: r[c]}).out}], ", ") +
			") ON CONFLICT (id) DO NOTHING;"
	}]
	out: strings.Join([for r in S._rows {r.out}], "\n")
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

// A validated table's plv8 predicates and the trigger that hands them their
// world. The trigger is SECURITY DEFINER so the server seat judges against
// the truth, and it refuses with check_violation because PostgREST maps a
// bare plv8 exception to 500, which the client outbox would retry forever.
// AFTER, so a row the caller's RLS refuses never reaches the definer's read:
// the predicate cannot be used as an oracle for rows the caller cannot write.
// It also puts stored generated columns and the restamped txid in `event.row`.
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
	_reads: {for n, v in V.e.validations {
		(n): strings.Join([for ed in v.edges {
			"'\(ed.table)', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM \(ed.table) r WHERE r.\"\(ed.key)\" = NEW.\"\(ed.from)\")"
		}], ", ")
	}}
	// IS DISTINCT FROM, so a null answer takes the program-error arm rather
	// than passing: an unanswered predicate refuses.
	_checks: [for n, _ in V.e.validations {
		"""
		  v := \(V._fn[n])(jsonb_build_object('items', items, 'rows', jsonb_build_object(\(V._reads[n]))), event);
		  IF v = 'false' THEN
		    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'validation \(V.e.table).\(n)';
		  ELSIF v IS DISTINCT FROM 'true' THEN
		    RAISE EXCEPTION USING ERRCODE = 'raise_exception', MESSAGE = 'predicate \(V.e.table).\(n) ' || coalesce(v, 'answered nothing');
		  END IF;
		"""
	}]
	out: strings.Join(list.Concat([V._functions, [
		"""
		CREATE OR REPLACE FUNCTION \(V.e.table)_validate() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
		DECLARE
		  items jsonb;
		  event jsonb;
		  v text;
		BEGIN
		  items := CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END;
		  event := jsonb_build_object('type', lower(TG_OP), 'row', to_jsonb(NEW));
		\(strings.Join(V._checks, "\n"))
		  RETURN NULL;
		END $$;

		DROP TRIGGER IF EXISTS \(V.e.table)_validate ON \(V.e.table);
		CREATE TRIGGER \(V.e.table)_validate AFTER INSERT OR UPDATE ON \(V.e.table)
		  FOR EACH ROW EXECUTE FUNCTION \(V.e.table)_validate();
		"""
	]]), "\n\n")
}

// The app_user USING clause of an owned entity. `qual` prefixes the row's
// own columns: the table name in the entity's policies, the parent alias
// when a through-mode child inlines this clause. `table` is the owned
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
	if P.e.access.mode == "owned" if P.e.access.shared != _|_ {
		_exempt: "owned with a per-object share via \(P.e.access.shared.via): finer than tenancy, guarded by its own policies"
	}
	if P.e.access.mode == "owned" if P.e.access.shared == _|_ {_exempt: ""}
	if P.e.access.mode == "public-read" {_exempt: ""}
	if P.e.access.mode == "service-only" if P._t != "app_user" {
		_exempt: "service-only: no app_user reaches it"
	}
	if P.e.access.mode == "service-only" if P._t == "app_user" {
		_exempt: "service-only except a person reading their own row, which the self-select policy alone allows"
	}
	if P.e.access.mode == "through" {
		// A child is exactly as floorable as its parent: floored under a floored
		// one, exempt under a shared one, whose share it inherits. A parent
		// that carries no scope -- service-only, unless it is app_user -- has
		// none to hand down, and the composition is a schema error.
		_p: P.entities[P.e.access.parent]
		_pFloored: bool
		if P._p.access.mode == "owned" {_pFloored: P._p.access.shared == _|_}
		if P._p.access.mode == "public-read" {_pFloored: true}
		if P._p.access.mode == "through" {_pFloored: false}
		if P._p.access.mode == "service-only" {_pFloored: false}
		_pScoped: bool & (P._p.access.mode != "through" && (P._p.access.mode != "service-only" || P._p.table == "app_user")) & true
		if P._pFloored {_exempt: ""}
		if !P._pFloored {
			_exempt: "through \(P.e.access.parent), which is itself exempt: the child inherits its visibility"
		}
	}

	// A composition's scope is its parent's, written by mecha.scope_from_parent
	// (rls.sql says why a trigger and not a generated column). Called, never
	// restated, like the floor.
	_scopeTrigger: [...string]
	if P.e.access.mode != "through" {_scopeTrigger: []}
	if P.e.access.mode == "through" {
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
	entities: [string]: #Entity // parent lookup for through mode
	_t: P.e.table
	if P.e.access.mode == "owned" {
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
			"CREATE POLICY \(P._t)_app_user_select ON \(P._t) FOR SELECT TO app_user USING (\(P._using));",
			"CREATE POLICY \(P._t)_app_user_insert ON \(P._t) FOR INSERT TO app_user WITH CHECK (\(P._t).\(P.e.access.owner) = auth_uid());",
			"CREATE POLICY \(P._t)_app_user_update ON \(P._t) FOR UPDATE TO app_user USING (\(P._using));",
			"CREATE POLICY \(P._t)_app_user_delete ON \(P._t) FOR DELETE TO app_user USING (\(P._using));",
		]
	}
	if P.e.access.mode == "through" {
		// The parent's owned USING is inlined one level, its row columns
		// re-qualified by the alias p; a through parent is a schema error.
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
			"CREATE POLICY \(P._t)_app_user_all ON \(P._t) FOR ALL TO app_user USING (\(P._expr)) WITH CHECK (\(P._expr));",
		]
	}
	if P.e.access.mode == "public-read" {
		_pre: []
		_appUser: [
			"CREATE POLICY \(P._t)_app_user_select ON \(P._t) FOR SELECT TO app_user USING (true);",
		]
	}
	if P.e.access.mode == "service-only" {
		_pre: []
		// The one exception, and it is the terminal's: at boot the shell reads
		// the signed-in row back out of app_user to tell a live account from a
		// token naming one that is gone (interpreter/shell.js accountLives).
		// It reads with the person's own token, so a service-only app_user
		// answers zero rows, the shell concludes the account is gone, drops
		// the session and shows the door — on every reload, to everybody. A
		// person reading their own row discloses nobody; resolving anyone
		// else's still needs the SECURITY DEFINER path.
		if P._t == "app_user" {
			_appUser: [
				"CREATE POLICY app_user_self_select ON app_user FOR SELECT TO app_user USING (id = auth_uid());",
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
	if P.e.access.mode == "owned" {_isShared: P.e.access.shared != _|_}
	if P.e.access.mode != "owned" {_isShared: false}
	_underShared: bool
	if P.e.access.mode == "through" {_underShared: P._p.access.mode == "owned" && P._p.access.shared != _|_}
	if P.e.access.mode != "through" {_underShared: false}
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
		["CREATE POLICY \(P._t)_service_all ON \(P._t) FOR ALL TO service USING (true) WITH CHECK (true);"],
	]), "\n")
}

// A publication over a table list. Created when absent, and brought up to the
// list when present: this file replays on a fresh volume only, and a database
// that outlives one would otherwise publish every table but the newest.
#publication: P={
	name:   string
	tables: [...string]
	out: """
		DO $$ DECLARE t text; BEGIN
		  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = '\(P.name)') THEN
		    CREATE PUBLICATION \(P.name) FOR TABLE \(strings.Join(P.tables, ",")) WITH (publish_generated_columns = stored);
		  END IF;
		  FOREACH t IN ARRAY ARRAY[\(strings.Join([for t in P.tables {"'\(t)'"}], ","))] LOOP
		    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
		                   WHERE pubname = '\(P.name)' AND schemaname = 'public' AND tablename = t) THEN
		      EXECUTE format('ALTER PUBLICATION \(P.name) ADD TABLE %I', t);
		    END IF;
		  END LOOP;
		END $$;
		"""
}

// Column conduit stamps onto every bus row naming the table it came from. Not
// a database column: it exists only on the wire, so it must not collide with
// one, hence the reserved prefix.
_cdcTableField: "__table"

#rpkPipeline: R={
	p:           #Pipeline
	sourceTable: string
	sinkTable:   string
	sinkPk:      string
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
			url:  "${CRUD_URL}/\(R.sourceTable)?\(R.p.transform.aggregate)"
			verb: "GET"
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
		pipeline: processors: [
			// Ahead of the fetch on purpose: cdc-events carries every table and
			// each stream reads all of it, so a message the mapping will discard
			// otherwise costs a PostgREST GET first. Which messages are its own
			// is the mapping's decision — this only spares the malformed.
			{mapping: "root = if this.exists(\"data\") && this.data.type() == \"string\" && this.data.length() > 0 { this } else { deleted() }"},
			R._fetch,
			{bloblang: R.p.transform.bloblang},
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
				url:  "${CRUD_URL}/\(R.sinkTable)?on_conflict=\(R._onConflict)"
				verb: "POST"
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
		[if R._hasCutoff {"meta cutoff = (timestamp_unix() - \(R._windowSeconds)).ts_format(\"2006-01-02T15:04:05Z\", \"UTC\")"}],
		[if R._hasNowts {"meta nowts = now()"}],
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

// The shell config is a file map, not a DSL: screen semantics live in the
// generated HTML/CSS/Jessie themselves; this only wires routes, data files,
// and pipeline topology to the filesystem. All paths are app-relative — the
// same path language as the manifest.
#shellConfig: S={
	code: #App
	migrations: [...string]
	// The terminal's measured floors, carried into the file the visual battery
	// reads. #scale publishes the same struct as --min-*, so the rung an author
	// is sent to and the threshold a tap target is held to are one declaration.
	floors: [string]: int
	// Whether the cluster runs an auth and a crud service: #serverOn, the
	// predicate that emits them, carried into the file the visual battery reads.
	server: bool
	_tables: {for _, s in S.code.surface.screens for r in s.reads {(S.code.state.entities[r.entity].table): true}}
	_tablePath: {for _, s in S.code.surface.screens for r in s.reads {
		(S.code.state.entities[r.entity].table): S.code.state.entities[r.entity].durability
	}}
	// A form's entity joins the registry even when no screen reads it: a
	// write-only table — one a form appends to and only a pipeline reads back —
	// must still be known to the store or create() refuses the table id.
	_tables: {for _, s in S.code.surface.screens for f in s.forms {(S.code.state.entities[f.entity].table): true}}
	_tablePath: {for _, s in S.code.surface.screens for f in s.forms {
		(S.code.state.entities[f.entity].table): S.code.state.entities[f.entity].durability
	}}
	// A fold's private pair joins the registry the same way: no region names it
	// and no form writes it, but the terminal reads it on every projection, and
	// a table the store does not know has no collection to read.
	_tables: {for _, p in S.code.state.pipelines if p.fold != _|_ {(p.fold.pair.table): true}}
	_tablePath: {for _, p in S.code.state.pipelines if p.fold != _|_ {
		(p.fold.pair.table): [for _, e in S.code.state.entities if e.table == p.fold.pair.table {e.durability}][0]
	}}

	// Browser-only tiers. They are collections like any other — read by a
	// data-live region, mutated by a form — but the terminal builds them from
	// a local factory instead of an Electric shape, so they cannot be listed
	// among the tables it subscribes.
	_localTables: {for _, e in S.code.state.entities if !e.server {(e.table): true}}
	_local: {for t, p in S._tablePath if S._localTables[t] != _|_ {(t): p}}
	_tableKeys: {for _, s in S.code.surface.screens for r in s.reads {
		(S.code.state.entities[r.entity].table): [for f in S.code.state.entities[r.entity].fields if f.pk {f.name}][0]
	}}
	_nonIdKeys: {for t, k in S._tableKeys if k != "id" {(t): k}}
	// Natural keys only: a partial unique (`where:`) witnesses a slot's
	// cardinality but cannot resolve an upsert, so it stays out of `uniques:`.
	_naturalKeys: {for _, e in S.code.state.entities {(e.table): [for u in e.uniques if u.where == _|_ {u.cols}]}}
	_uniqueTables: [for t, ks in S._naturalKeys if len(ks) > 0 {t}]
	// Partial uniques travel apart, as the whole invariant: the terminal
	// reconciles surviving browser-tier rows against them at first load.
	_partialUniques: {for _, e in S.code.state.entities {(e.table): [for u in e.uniques if u.where != _|_ {cols: u.cols, where: u.where}]}}
	_partialTables: [for t, ps in S._partialUniques if len(ps) > 0 {t}]
	// A local table's `required: false` columns and their types, which the
	// terminal fills on stored rows that predate them (data-crud.js fill).
	// Server tables are left out: Postgres answers a missing value as null.
	_optional: {for _, e in S.code.state.entities if S._local[e.table] != _|_ {(e.table): [for f in e.fields if !f.required {name: f.name, type: f.type}]}}
	_optionalTables: [for t, cs in S._optional if len(cs) > 0 {t}]
	// What the terminal's markup rules judge a screen against (check-markup.ts):
	// the columns a filter may name, the pk, unique field or declared unique
	// that witnesses a slot's cardinality, the tier and type a machine region's
	// writes are held to, and the values a data-when may state. Scoped to the
	// tables the terminal registers, and to the field attributes those rules
	// read — shell.yaml carries one projection of the program per reader, and
	// this is the checker's.
	_schema: {for _, e in S.code.state.entities if S._tables[e.table] != _|_ {
		(e.table): {
			durability: e.durability
			fields: [for f in e.fields {
				name: f.name
				type: f.type
				if f.pk {pk: true}
				if f.unique != _|_ {unique: f.unique}
				if f.default != _|_ {default: f.default}
				if e.enums[f.name] != _|_ {enum: e.enums[f.name]}
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
	// The seeds #appMigrations.seeded leaves out: a browser tier has no
	// migration to render into, so the terminal is told the rows instead.
	_localSeeds: {for _, e in S.code.state.entities if S._local[e.table] != _|_ if len(e.seed) > 0 {(e.table): e.seed}}
	_seededLocal: [for t, _ in S._localSeeds {t}]
	_unitNames: [for n, _ in S.code.capabilities.vendored {n}]
	_access: {for _, e in S.code.state.entities if S._tables[e.table] != _|_ if e.access != _|_ {
		(e.table): {
			mode: e.access.mode
			if e.access.mode == "owned" {
				owner: e.access.owner
				if e.access.shared != _|_ {shared: e.access.shared}
			}
			if e.access.mode == "through" {
				parent: S.code.state.entities[e.access.parent].table
				on:     e.access.on
			}
		}
	}}
	out: {
		app:    S.code.meta.name
		floors: S.floors
		server: S.server
		if S.code.capabilities.auth != _|_ {
			auth: S.code.capabilities.auth
		}

		// Optional keys are emitted only where they differ from the default,
		// so shell.yaml stays stable for the ordinary screen.
		routes: [for _, s in S.code.surface.screens {
			path:   s.route
			screen: s.name
			nav: {
				label: s.title
				if !s.strip {strip: false}
			}
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

		// Primary key per table, only where it is not "id": the terminal's
		// synced collections key rows by it (a pipeline sink like note_progress
		// keys on its subject column, and keying such a table on the missing
		// "id" collapses every row onto one key).
		if len(S._nonIdKeys) > 0 {
			keys: S._nonIdKeys
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
					(e.table): {(n): {src: v.src, edges: v.edges}}
				}
			}
		}
		if len(S._seededLocal) > 0 {
			seed: S._localSeeds
		}

		// The units a data-hatch may name, and what the terminal is allowed to
		// do for each: the boundary to mount it behind, the capabilities it
		// asked for (checked against the terminal's offer at compile time), and
		// the entry point to load. The rest of `files` is served, not declared —
		// a unit fetches its own siblings by name.
		if len(S._unitNames) > 0 {
			units: {
				for n, v in S.code.capabilities.vendored {
					(n): {isolation: v.isolation, capabilities: v.capabilities, src: v.src}
				}
			}
		}
		"migrations": S.migrations
		pipelines: [for _, p in S.code.state.pipelines {
			if p.trigger == "cdc" if p.raw == _|_ {
				name:      p.name
				from:      S.code.state.entities[p.from].table
				to:        S.code.state.entities[p.to].table
				aggregate: p.transform.aggregate
				if p.fold == _|_ {shim: p.shim}

				// A fold names its module rather than a shim, and the terminal
				// runs it at both browser tiers: the PGlite sink, and the
				// optimistic projection over the synced sink. The watermark and
				// dedupe key travel with it — the projection cannot be sound
				// without either (decision-optimistic-fold).
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

			// Raw pipelines have no shim: the browser tier lists them and skips.
			if p.raw != _|_ {
				name: p.name
				to:   S.code.state.entities[p.to].table
				raw:  true
			}
		}]
	}
}

// Whether an app's cluster keeps server-side state: an entity on a server tier,
// or auth, which is identity the cluster keeps. The one predicate the cluster's
// services, its migrations and the emitted shell.yaml all follow.
#serverOn: S={
	// Only what the answer reads, so a caller hands over no seed rows.
	servers: [...bool]
	auth:    bool
	out:     list.Contains(S.servers, true) || S.auth
}

#appMigrations: M={
	code: #App
	// Gates 010 on the same set _uniqueLines renders: server-tier uniques
	// (where the schema admits no `where`), so the list never names a
	// migration the bundle does not hold.
	_uniqueTables: [for _, e in M.code.state.entities if e.server if len(e.uniques) > 0 {e.table}]
	_validatedTables: [for _, e in M.code.state.entities if e.server if len([for n, _ in e.validations {n}]) > 0 {e.table}]
	seeded: [for _, e in M.code.state.entities if len(e.seed) > 0 if e.server {e}]
	accessed: [for _, e in M.code.state.entities if e.access != _|_ {e}]
	raw: [if M.code.state.rawMigrations != _|_ {M.code.state.rawMigrations}, []][0]
	// The cluster mounts this list as configs, so it follows the predicate that
	// emits the database: a migration named without one would be a compose file
	// referring to a service that was never emitted.
	_server: (#serverOn & {servers: [for _, e in M.code.state.entities {e.server}], auth: M.code.capabilities.auth != _|_}).out
	list: [for f in M._all if M._server {f}]
	_all: [
		"services/database/migrations/000_extensions.sql",
		"services/database/migrations/001_roles.sql",
		"services/database/migrations/002_grants.sql",
		"services/database/migrations/003_publication.sql",
		"services/database/migrations/004_create_tables.sql",
		if len(M.accessed) > 0 {"services/database/migrations/005_policies.sql"},
		"services/database/migrations/006_txid.sql",
		"services/database/migrations/007_publication.sql",
		if len(M._validatedTables) > 0 {"services/database/migrations/008_validations.sql"},
		if len(M._uniqueTables) > 0 {"services/database/migrations/010_composite_uniques.sql"},
		if len(M.code.state.schedules) > 0 {"services/database/migrations/020_schedule.sql"},
		for r in M.raw {"services/database/migrations/\(r.name)"},
		if len(M.seeded) > 0 {"services/database/migrations/900_seed.sql"},
	]
}

// Default runtime instances, parameterized by the code. program.cue wires
// them; overrides land in bayt.cue by unification.
#DefaultLoop: D={
	code:     #App
	cluster:  mecha.#Cluster
	terminal: omnishell.#Terminal
	out: prontoloop.#Loop & {
		meta: app: D.code.meta.name
		surface: {
			// --allow-env is mermaid's: the diagram parse reads the environment as it
			// initialises, where the CEL parse beside it does not.
			// Two spawns, both named: `cue` for the export the emission is read
			// from and the vet each chart is held to, `deno` for the terminal's
			// markup reader — the grammar's readings are the terminal's, and a
			// compiler published on its own reaches them over a pipe rather than
			// through an import (derive.ts).
			buildCmd: "deno run --allow-read=. --allow-write=. --allow-run=cue,deno --allow-env ../../plugins/pronto/write.ts ."
			testCmd:  "cue vet -c ./..."
			pipelineFiles: [for _, p in D.code.state.pipelines {"docker/\(D.code.meta.name)-\(p.name).yaml"}]
			// Both runtimes declare checks about their own surfaces; the loop
			// routes each to the verb it names. A name collision across the two
			// is a conflict here rather than a silent overwrite.
			verbs: {
				for name, c in D.cluster.surface.verbs {(name): c}
				for name, c in D.terminal.surface.verbs {(name): c}
			}
			checks: {
				for name, c in D.cluster.surface.checks {(name): c}
				for name, c in D.terminal.surface.checks {(name): c}
				fuel: {
					verb: "test"
					cmds: [
						"deno run --allow-read=.,../../plugins --allow-env ../../plugins/pronto/battery.ts --self-test",
					]
					note: "fuel metering and deterministic chaos testing battery"
				}
			}
		}
	}
}

#DefaultBuild: D={
	code: #App
	loop: prontoloop.#Loop
	out: prontobuild.#Build & {
		meta: {
			app:      D.code.meta.name
			buildCmd: D.loop.surface.buildCmd
			testCmd:  D.loop.surface.testCmd
		}
	}
}

#DefaultTerminal: D={
	code: #App
	_handlerSet: {for _, s in D.code.surface.screens for i in s.files.handlers {(i): true}}
	_sharedSet: {for _, s in D.code.surface.screens for i in s.files.shared {(i): true}}
	_unitSet: {for _, v in D.code.capabilities.vendored for f in v.files {(f): true}}
	out: omnishell.#Terminal & {
		app:         D.code.meta.name
		description: D.code.meta.description
		surface: {
			screens: [for _, s in D.code.surface.screens {name: s.name, html: s.files.html, css: s.files.css}]
			handlers: list.SortStrings([for i, _ in D._handlerSet {i}])
			// The union of what screens import, so the served set is exactly what
			// something references — an unreferenced file under shell/shared/ is
			// never built and cannot pretend to be part of the app.
			shared: list.SortStrings([for i, _ in D._sharedSet {i}])
			folds: list.SortStrings([
				for _, pl in D.code.state.pipelines if pl.fold != _|_ {pl.fold.src},
			])
			// A unit's whole directory, not just its src: the wrapper's own
			// imports are files the browser fetches by name.
			units: list.SortStrings([for f, _ in D._unitSet {f}])
		}
	}
}

#DefaultCluster: D={
	code: #App
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
	_ladder: [for f in ["brief.html", "ir.html", "acceptance.md", "DESIGN.md"] {
		source: "ladder-\(f)"
		file:   f
		target: "/srv/docs/\(f)"
		watch:  true
	}]

	out: mecha.#Cluster & {
		meta: {
			app: D.code.meta.name
			statics: list.Concat([D.statics, D._ladder])
		}
		state: {
			migrations: (#appMigrations & {"code": D.code}).list
			pipelines: [for _, pl in D.code.state.pipelines {
				name: "\(D.code.meta.name)-\(pl.name)"
				file: "docker/\(D.code.meta.name)-\(pl.name).yaml"
			}]
			schedules: [for _, sc in D.code.state.schedules {sc.name}]
		}
	}
}

// The three components of an app package — code, cluster, terminal — are
// inputs; program.cue wires the defaults (#DefaultCluster/#DefaultTerminal)
// and bayt.cue redeclares the runtime pair as the escape-hatch seams.
#emit: E={
	_uniqueLines: [
		for ent in E._serverEntities for u in ent.uniques {
			"CREATE UNIQUE INDEX IF NOT EXISTS \(u.name) ON \(ent.table) (\(strings.Join(u.cols, ", ")));"
		},
	]
	code:     #App
	cluster:  mecha.#Cluster
	terminal: omnishell.#Terminal
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
	// an app cannot demand an auth mode its terminal does not offer.
	if E.code.capabilities.auth != _|_ {
		_authModeOffered: true & list.Contains(E.terminal.capabilities.auth.modes, E.code.capabilities.auth.mode)
	}

	for _, v in E.code.capabilities.vendored {
		_vendoredIsolationBuildable: true & list.Contains(E.terminal.capabilities.isolation, v.isolation)
		// The unit's own entry point has to be one of the files the terminal
		// serves, or the mount fetches a path nothing published.
		_vendoredSrcServed: true & list.Contains(v.files, v.src)
		for cap in v.capabilities {
			let parts = strings.Split(cap, ".")
			_vendoredCapabilityOffered: true & (E.terminal.capabilities[parts[0]][parts[1]] != _|_)
		}
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
	_cdcTables: strings.Join([for e in _entities if e.durability == "server" {e.table}], ",")
	_syncTables: [for e in E._serverEntities {e.table}]

	// The refusal that would have caught the original bug: a cloud-tier app
	// whose schedules nothing wakes. At compose the cluster emits its own clock,
	// so the tier is self-evidently covered; above it the clock lives in a
	// deploy tree this emitter does not write, and the failure is silent — the
	// pipelines simply never run. Declaring the clock is what makes the absence
	// loud, and `meta.clocks` is where the app says so.
	_clockDeclared: {
		for t in E.code.meta.tiers if t != "container" if t != "cli" {
			if len(E.code.state.schedules) > 0 {
				(t): true & list.Contains(E.code.meta.clocks, t)
			}
		}
	}

	// A schedule's two entities, checked here because #Schedule cannot see them.
	// Both rules are the publication's: it carries "server" and excludes "live",
	// so a tick has to be the first to be read at all, and an outcome has to be
	// the second or the pipeline answering a tick would feed itself the answer.
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
	build: prontobuild.#Build

	_hatchSeam: [
		if len(E.code.capabilities.hatches) > 0 {
			"""
				// Compiled escape hatches (ir.html: \(strings.Join(list.SortStrings([for hn, _ in E.code.capabilities.hatches {hn}]), ", ")))
				// live in program.cue's cluster unification; this redeclaration
				// is the out-of-band human override seam (add a cluster service,
				// modify one, null to drop one; extend the terminal).
				"""
		},
		"""
			// Escape hatches: none (ir.html) — the default runtime,
			// redeclared unchanged. A program whose ir declares a hatch
			// unifies its overrides right here (add a cluster service,
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
		body > nav .shell-me { margin-left: auto; display: flex; align-items: center; gap: var(--shell-nav-gap, 20px); min-width: 0; }
		body > nav .shell-who { display: flex; align-items: center; gap: 5px; min-width: 0; min-height: 24px; }
		body > nav .shell-who .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		body > nav .shell-who .name:empty { display: none; }
		body > nav .shell-who .name:not(:empty)::after { content: " ·"; }
		body > nav .shell-who .handle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
		/* De-emphasis comes from weight alone: layered opacity on --shell-fg
		   lands below 4.5:1 contrast on both themes' nav ground. */
		body > nav .shell-signout { font-weight: 400;
		  display: inline-flex; align-items: center; min-height: 24px; }

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
		.shell-login { display: grid; place-items: center; min-height: 70vh; }
		.shell-login form { display: grid; gap: 12px; width: min(320px, 90vw);
		  padding: var(--sp-lg, 24px); border: 1px solid var(--shell-rule);
		  border-radius: var(--r-md, 8px); background: var(--surface); }
		.shell-login h1 { margin: 0; font-size: 1.25rem; }
		.shell-login label { display: grid; gap: 4px; font-weight: 600; }
		.shell-login input { font: inherit; padding: 8px 10px;
		  border-radius: var(--r-sm, 6px); border: 1px solid var(--shell-rule);
		  background: var(--surface); color: var(--shell-fg); }
		.shell-login button { font: inherit; font-weight: 600; padding: 8px 10px;
		  border-radius: var(--r-sm, 6px); border: 1px solid var(--shell-rule);
		  background: var(--shell-fg); color: var(--shell-bg);
		  cursor: pointer; }
		.shell-login .login-hint { margin: 0; font-weight: 400; font-size: .875rem;
		  color: var(--shell-fg); }
		.shell-login .login-guest { background: var(--surface);
		  color: var(--shell-fg); font-weight: 400; }
		.shell-login .login-error { color: var(--danger); margin: 0; }

		"""

	_seeded: (#appMigrations & {"code": E.code}).seeded

	_migrations: (#appMigrations & {"code": E.code}).list

	_accessed: (#appMigrations & {"code": E.code}).accessed
	_raw: (#appMigrations & {"code": E.code}).raw
	// The auth plane switches on as one: declaring #App.auth or any entity
	// access implies the roles, auth_uid(), and service-token plumbing —
	// policies without tokens (or vice versa) is not a supported state.
	_authOn: E.code.capabilities.auth != _|_ || len(E._accessed) > 0

	// The cluster's auth service and JWT envs follow the program's auth block;
	// the blob plane follows the program's flag.
	cluster: capabilities: auth:  E.code.capabilities.auth != _|_
	cluster: capabilities: blobs: E.code.capabilities.blobs
	// The data plane follows #serverOn: an app with no server-side state is
	// served by caddy alone.
	_serverOn: (#serverOn & {servers: [for _, e in E.code.state.entities {e.server}], auth: E.code.capabilities.auth != _|_}).out
	// A server entity syncs through a gate the auth service answers, so a
	// cluster with one and no auth plane would 502 every shape.
	_gated: bool & (E._serverOn == false || E._authOn) & true
	cluster: capabilities: server: E._serverOn

	files: [string]: #File
	files: {
		// The server-side surface, emitted only where there is a server to run
		// it: an app whose every entity is a browser tier has no schema, no
		// publication, no bus wiring and no pipeline file, and the cluster it
		// targets instantiates none of the services these configure.
		if E._serverOn {
			"services/database/migrations/000_extensions.sql": {
				format: "sql"
				// plv8 is required exactly when a server entity declares
				// validations: it is the language their predicates run in.
				// gen_random_uuid() is core since PostgreSQL 13, so an app
				// without validations needs no extension at all. No
				// IF NOT EXISTS: these migrations run once, at initdb, on a
				// fresh data directory.
				// auth_uid() reads the sub claim PostgREST stashes in
				// request.jwt.claims; NULL outside a request or for tokens
				// without a sub (anon).
				_prelude: [
					if len(E._validated) > 0 {"CREATE EXTENSION plv8;\n"},
					if len(E._validated) == 0 {"-- no extensions required\n"},
				][0]
				if !E._authOn {
					text: _prelude
				}
				if E._authOn {
					text: _prelude + "\n" + """
						CREATE OR REPLACE FUNCTION auth_uid() RETURNS uuid LANGUAGE sql STABLE AS $$
						  SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid
						$$;

						"""
				}
			}
			"services/database/migrations/001_roles.sql": {
				format: "sql"
				_roles: list.Concat([["anon"], [if E._authOn {"app_user"}, if E._authOn {"service"}], [if E._serverOn {"electric"}]])
				text: "DO $$ BEGIN\n" + strings.Join([for r in _roles {
					"""
					  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '\(r)') THEN
					    CREATE ROLE \(r) NOLOGIN;
					  END IF;
					"""
				}], "\n") + "\nEND $$;\n" + strings.Join(_bypass, "")

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
					if E._authOn {"\nALTER ROLE service BYPASSRLS;\n"},
					// A dev credential; cluster.cue, at the URL naming this role, says
					// what a deployment does with both.
					if E._serverOn {"\nALTER ROLE electric BYPASSRLS REPLICATION LOGIN PASSWORD 'electric';\n" +
						"GRANT USAGE ON SCHEMA public TO electric;\n" +
						"GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;\n" +
						"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;\n" +
						""},
				]
			}
			"services/database/migrations/002_grants.sql": {
				format: "sql"
				if !E._authOn {
					text: """
						GRANT USAGE ON SCHEMA public TO anon;
						GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
						ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon;

						"""
				}

				// Auth'd grants: anon can connect (USAGE) but touches no table —
				// every row read or written goes through app_user or service,
				// where 005's policies decide.
				if E._authOn {
					text: """
						GRANT USAGE ON SCHEMA public TO anon, app_user, service;
						GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service;
						ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, service;

						"""
				}
			}
			// Names and order match the set baked into mecha's database image, so
			// compose config mounts shadow the baked files one-for-one.
			// 003 must shadow the baked conduit_pub: FOR ALL TABLES re-opens the
			// pipeline feedback loop and trips 42P10 (mechanism at 007).
			"services/database/migrations/003_publication.sql": {
				format: "sql"
				text: """
					-- Shadows the baked FOR ALL TABLES publication. The app publication
					-- is created in 007_publication.sql, after the tables it names exist.

					"""
			}
			"services/database/migrations/007_publication.sql": {
				format: "sql"
				// Runs after 004_create_tables: FOR TABLE fails on missing tables
				// and initdb aborts on the first error. FOR TABLE <crud tables>,
				// never FOR ALL TABLES — derived-table upserts must not re-feed the
				// pipelines that wrote them, and conduit's `tables` setting does not
				// filter logrepl events, so the publication is the loop breaker.
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
				text: [
					if len(E._syncTables) > 0 {
						"""
				\([if len(E._cdcTables) > 0 {(#publication & {name: E._pub, tables: strings.Split(E._cdcTables, ",")}).out}, "-- No server-durability entity: nothing for the bus to read."][0])

				-- Electric's own publication, declared rather than left to it.
				-- ELECTRIC_MANUAL_TABLE_PUBLISHING makes it validate this instead of
				-- building one, which is what lets its role hold only REPLICATION and
				-- SELECT: creating a publication needs CREATE on the database, and
				-- adding a table to one needs ownership of that table. A sync service
				-- that owns the app's tables can drop them.
				\((#publication & {name: "electric_publication_default", tables: E._syncTables}).out)

				\(strings.Join([for t in E._syncTables {"ALTER TABLE \(t) REPLICA IDENTITY FULL;"}], "\n"))
				GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;

				"""
					},
					"""
						-- No synced entity: nothing to publish, nothing to grant.

						""",
				][0]
			}
			"services/database/migrations/004_create_tables.sql": {
				format: "sql"
				_indexLines: list.Concat([for ent in E._serverEntities if ent.indexes != _|_ {(#indexSql & {e: ent}).out}])
				text: strings.Join(list.Concat([
					[for ent in E._serverEntities {(#tableSql & {e: ent}).out}],
					[if len(_indexLines) > 0 {strings.Join(_indexLines, "\n")}],
				]), "\n\n") + "\n"
			}
			if len(E._accessed) > 0 {
				"services/database/migrations/005_policies.sql": {
					format: "sql"
					text: strings.Join([for ent in E._entities if ent.access != _|_ {
						(#policySql & {e: ent, entities: E.code.state.entities}).out
					}], "\n\n") + "\n"
				}
			}
			if len(E._validated) > 0 {
				"services/database/migrations/008_validations.sql": {
					format: "sql"
					text: strings.Join(list.Concat([
						[#validationPrecondition],
						[for ent in E._validated {(#validationSql & {e: ent}).out}],
					]), "\n\n") + "\n"
				}
			}

			// Composite uniques, from the entities' own declarations. Names are
			// uq_<table>_<cols>, and a violation is what the app's duplicate refusal
			// reads: the Caddyfile injects resolution=ignore-duplicates, which
			// PostgREST targets at the PRIMARY KEY — a client-minted uuid that never
			// collides — so a repeated pair reaches this index and comes back 23505
			// rather than merging silently.
			if len(E._uniqueLines) > 0 {
				"services/database/migrations/010_composite_uniques.sql": {
					format: "sql"
					text:   strings.Join(E._uniqueLines, "\n") + "\n"
				}
			}
			if len(E.code.state.schedules) > 0 {
				// mecha's mechanism, never authored by an app: the DDL is fixed
				// and only the seed varies. One row per declaration, and the
				// seed is an upsert on the name so a redeploy restates the
				// schedule without resetting the watermark it has earned.
				"services/database/migrations/020_schedule.sql": {
					format: "sql"
					text: """
						CREATE TABLE IF NOT EXISTS schedule (
						  name                 TEXT PRIMARY KEY,
						  cron                 TEXT NOT NULL,
						  time_zone            TEXT NOT NULL DEFAULT 'UTC',
						  suspended            BOOLEAN NOT NULL DEFAULT FALSE,
						  max_lateness_seconds INTEGER NOT NULL DEFAULT 300,
						  concurrency_policy   TEXT NOT NULL DEFAULT 'Allow'
						                         CHECK (concurrency_policy IN ('Allow', 'Forbid')),
						  done_entity          TEXT,
						  done_filter          TEXT,
						  emits_entity         TEXT NOT NULL,
						  emits_values         JSONB NOT NULL DEFAULT '{}',
						  last_tick_at         TIMESTAMPTZ,
						  CHECK (concurrency_policy <> 'Forbid'
						         OR (done_entity IS NOT NULL AND done_filter IS NOT NULL))
						);

						-- 002_grants' ALTER DEFAULT PRIVILEGES reaches every table made after
						-- it, this one included, so without this a logged-in user can read and
						-- rewrite the mechanism. That is not a disclosure, it is an escalation:
						-- the ticker reads emits_entity and emits_values from here and writes
						-- them as `service`, which bypasses RLS, so whoever can repoint the
						-- column has rows inserted wherever they choose, once per poke — and
						-- `suspended` stops every schedule in the app. No policy is declared
						-- because none is wanted: `service` holds BYPASSRLS and nothing else
						-- has any business here.
						-- RLS is what denies them: 002 grants to the roles by name, not to
						-- PUBLIC, so revoking PUBLIC would leave every one of them in place.
						-- The revoke below is belt to that brace, and is conditional because
						-- which roles exist depends on whether the app has auth.
						ALTER TABLE schedule ENABLE ROW LEVEL SECURITY;
						DO $$
						DECLARE r TEXT;
						BEGIN
						  FOREACH r IN ARRAY ARRAY['anon', 'app_user'] LOOP
						    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
						      EXECUTE format('REVOKE ALL ON schedule FROM %I', r);
						    END IF;
						  END LOOP;
						END
						$$;

						\(strings.Join([for _, sc in E.code.state.schedules {
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
						}], "\n"))
						"""
				}
			}
			"services/database/migrations/006_txid.sql": {
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
			if len(E._seeded) > 0 {
				"services/database/migrations/900_seed.sql": {
					format: "sql"
					text: strings.Join([for se in E._seeded {(#seedSql & {e: se}).out}], "\n") + "\n"
				}
			}
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
								tables:                    E._cdcTables // derived tables are excluded: no CDC loops
								cdcMode:                   "logrepl"
								snapshotMode:              "never"
								"logrepl.publicationName": E._pub
								"logrepl.slotName":        "\(E._pkg)_conduit_slot"
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
							id:     "stringify-after"
							plugin: "builtin:json.encode"
							settings: field: ".Payload.After"
						}, {
							id:     "stringify-before"
							plugin: "builtin:json.encode"
							settings: field: ".Payload.Before"
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
			for _, pl in E.code.state.pipelines if pl.trigger == "cdc" if pl.raw == _|_ {
				"docker/\(E.code.meta.name)-\(pl.name).yaml": {
					format: "yaml"
					data: (#rpkPipeline & {
						p:           pl
						sourceTable: E.code.state.entities[pl.from].table
						sinkTable:   E.code.state.entities[pl.to].table
						sinkPk: [for fld in E.code.state.entities[pl.to].fields if fld.pk {fld.name}][0]
						authOn: E._authOn
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

			// Raw pipelines: the assembly rpk stream is copied verbatim beside the
			// derived ones, so the transform image and the rpk lint list treat all
			// pipelines alike.
			for _, pl in E.code.state.pipelines if pl.raw != _|_ {
				"docker/\(E.code.meta.name)-\(pl.name).yaml": {format: "yaml", src: pl.src}
				"\(pl.src)": {format: "yaml", src: pl.src}
			}
		}
		"docker/Caddyfile": {
			format: "caddyfile"
			text:   _caddyfileAsset
		}
		"shell/shell.yaml": {
			format: "yaml"
			data: (#shellConfig & {"code": E.code, migrations: E._migrations, floors: E.terminal.capabilities.floors, server: E._serverOn}).out
		}
		"\(E.terminal.surface.entry)": {
			format: "text"
			text:   E.terminal.surface.assets.html
		}
		"\(E.terminal.surface.css)": {
			format: "text"
			text:   E.terminal.surface.assets.css
		}
		"\(E.terminal.surface.boot)": {
			format: "text"
			text:   E.terminal.surface.assets.boot
		}
		"shell/design.css": {
			format: "css"
			text:   E._designCss
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
			for i in s.files.handlers {"\(i)": {format: "jessie", src: i}}
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
		// implementations: mecha publishes the virtual cluster, omnishell the
		// virtual terminal, and this emitter is their fixed composition.
		"compose.yaml": {
			format: "yaml"
			data:   E.cluster.compose
		}
		"docker/shell.Dockerfile": {
			format: "text"
			text:   E.cluster.shellDockerfile
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
	}

	manifest: list.SortStrings([for p, _ in files {p}])
}
