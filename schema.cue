// Package pronto is the machine rung of the review ladder: the #App shape a
// program.cue instantiates, and #emit (emit.cue), which derives the emitted
// file bundle. Every object carries `ir`, the ir.html element id it realizes;
// the bijection checker matches these against the pinned IR.
package pronto

#Tier: "cli" | "container" | "k8s" | "cloud"

#Jessie: string & =~"\\.js$"

// Starting points for #Design. A preset is named rather than implicit so a
// reviewer can see which opinion an app took, and so adding a second is a data
// change rather than a fork.
//
// The token NAMES are the schema contract and the platform's; the hex is the
// designer's to evolve.
#designPresets: [Name=string]: {
	colors: [string]:  string
	dark: [string]:    string
	rounded: [string]: string
	spacing: [string]: string
	motion: [string]:  string
}
#designPresets: press: {
	// Identity for an editorial reading surface; the default an app takes
	// when it names no preset.
	colors: {
		primary:         "#16181A"
		secondary:       "#6B7076"
		accent:          "#1D6A4F"
		danger:          "#A93226"
		neutral:         "#FBFAF7"
		surface:         "#FFFFFF"
		border:          "#E4E1D9"
		"surface-muted": "#EFEDE6"
	}
	dark: {
		primary:         "#E9E7E2"
		secondary:       "#9AA0A6"
		accent:          "#63BE95"
		danger:          "#E2705F"
		neutral:         "#131414"
		surface:         "#1C1E1F"
		border:          "#2E3133"
		"surface-muted": "#24272A"
	}
	rounded: {sm: "4px", md: "8px", full: "999px"}
	spacing: {sm: "8px", md: "16px", lg: "24px", xl: "40px"}
	motion: {fast: "110ms", base: "180ms", ease: "cubic-bezier(.2, 0, 0, 1)", shift: "6px"}
}

// The design system's values, mirroring DESIGN.md's frontmatter — that file
// argues the identity and this carries it, the same division the ir and the
// program keep for behaviour. The emitter alone turns these into CSS;
// check-screens guards the fork.
#Design: D={
	// The starting set this app took. Naming a token below replaces that one
	// and leaves the rest, exactly as `motion` works.
	preset:  *"press" | string
	_preset: #designPresets[D.preset]

	colors: [string]: string
	colors: {for k, v in D._preset.colors {(k): *v | string}}
	// The dark twin declares the SAME names — appearance is a token
	// resolution, never a state. Emitted as the second argument of each
	// token's light-dark(), so the two palettes are one declaration and a
	// name can no longer appear in a single appearance: a missing twin and a
	// twin nothing reads are both errors here rather than a token that
	// silently stops changing, or never changed at all.
	dark: close({for k, _ in D.colors {(k): string}})
	dark: {for k, v in D._preset.dark {(k): *v | string}}
	rounded: [string]: string
	rounded: {for k, v in D._preset.rounded {(k): *v | string}}
	spacing: [string]: string
	spacing: {for k, v in D._preset.spacing {(k): *v | string}}
	// The motion vocabulary. The terminal ships no style at all — its
	// shell.css is the empty contract — so this is the only declaration;
	// the preset supplies the defaults and naming one here replaces it.
	motion: [string]: string
	motion: {for k, v in D._preset.motion {(k): *v | string}}
	// Which colour the terminal's own chrome resolves to; the shell has no
	// opinion about which swatch is a background.
	shell: {
		bg:   *"neutral" | string
		fg:   *"primary" | string
		rule: *"border" | string
	}
}

#Field: {
	name: string
	type: "uuid" | "text" | "bool" | "int" | "bigint" | "timestamptz" | "tsvector"
	pk:       *false | bool
	required: *true | bool
	ref?:     string // referenced table; DDL: REFERENCES <ref>(id) ON DELETE CASCADE
	unique?:  bool
	default?: string // SQL expression
	// SQL expression; DDL: GENERATED ALWAYS AS (<expr>) STORED. Generated
	// fields emit no NOT NULL/DEFAULT and never appear in forms.
	generated?: string
	cel?:       string // constraint, `this` bound to the field value
	check?:     string // SQL rendering of cel; the compiler owns their consistency
}

// Row visibility, enforced as RLS policies (005_policies.sql). The four
// modes are the whole vocabulary; an entity without `access` gets no RLS.
// Column names (`owner`, `on`, `user`) are of the entity's own table;
// `via` is a table name, `parent` an entity name whose access is owned.
#Access: {
	mode:  "owned"
	owner: string
	shared?: {via: string, on: string, user: string}
} | {
	mode:   "through"
	parent: string
	on:     string
} | {
	mode: "public-read"
} | {
	mode: "service-only"
}

#Entity: {
	name:  string
	ir:    *name | string
	table: string
	// Durability, and it is monotonic in expense: `tab` lives in an in-memory
	// collection and survives navigation; `device` survives a restart; the
	// three server tiers survive device loss. The emitter derives everything
	// from this — table, trigger, publication entry, policy, outbox — so a
	// reviewer can see the cost someone chose.
	//
	// Visibility is a different axis. A tab or device entity is private by
	// construction, with no policy to write, which is why `access` is not
	// merely optional for them but meaningless: nothing else can reach it.
	path: "crud" | "live" | "offline" | "tab" | "device"
	if path == "tab" || path == "device" {
		access?: _|_
		// No table is ever emitted for these tiers, so a SQL rendering is dead
		// text written twice by hand; `cel` alone states the constraint.
		fields: [...{check?: _|_}]
	}
	if path != "tab" && path != "device" {
		access?: #Access
	}
	// "pipeline" entities are never mutated by forms; role-level enforcement
	// is an open question in SPEC.md.
	writers: *"forms" | "pipeline"
	fields: [...#Field]
	// DDL: CREATE INDEX IF NOT EXISTS idx_<table>_<on> ON <table>
	// USING <using> (<on>); emitted after the tables in 004.
	indexes?: [...{on: string, using: *"btree" | "gin"}]
	invariant?: {cel: string, check: string} // row-level
	// Composite uniques the per-field `unique` flag cannot express. Declared
	// rather than written as assembly SQL because the shell needs them too: a
	// row's natural key is what an upsert resolves against, and what an
	// optimistic contribution is collapsed on. The name is carried rather than
	// derived because a violation IS the app's duplicate refusal and the
	// constraint name is what reaches the screen.
	//
	// `where` makes the unique partial: it holds only over rows matching the
	// predicate, stated in the data-plane fragment grammar. A partial unique
	// is a slot's cardinality witness ("at most one row wears this flag"),
	// never a natural key — upserts cannot resolve against it. Browser tiers
	// only: its SQL rendering (a partial unique index) waits for a
	// server-tier consumer.
	uniques: *[] | [...{name: string, cols: [...string], where?: string}]
	if path != "tab" && path != "device" {
		uniques: [...{where?: _|_}]
	}

	// Bootstrap rows: the rows a store holds before anyone writes one. A
	// server tier renders them into 900_seed.sql; a `tab` entity has no
	// migration to render into, so the terminal writes them itself when it
	// first opens the collection (shell.yaml `seed:`).
	//
	// A pipeline-written singleton MUST seed its initial state: pipelines fire
	// on CDC events, so before the first mutation the derived row exists only
	// if the schema bootstrap made it.
	//
	// Both tiers keep the same rule — the rows are written once against an
	// empty store and never reconsidered — because at both tiers the store's
	// birth is what triggers them: a fresh database runs the migration, a
	// fresh tab collection is seeded at open. A row the reader deletes
	// therefore stays deleted for as long as its store lives.
	seed: [...{[string]: string | int | bool}]
	if path == "device" {
		// Not deferred — the tier is the wrong home for a stated row. A device
		// collection outlives the page, so its birth and the terminal's boot
		// are different moments and the rule above has nothing to hang on:
		// seeding at every open resurrects what the reader deleted, and
		// seeding once needs a ledger of what was already seeded that the
		// reader cannot delete.
		//
		// No such ledger is needed, because the program is already the durable
		// copy of anything it states. Rows the PROGRAM owns belong at `tab`,
		// re-stated on every load and therefore never stale; `device` is for
		// what the READER makes, which is exactly what a seed is not. An app
		// wanting both reads its stated rows from the tab entity and keeps the
		// reader's own at device.
		seed: []
	}
}

#Pipeline: {
	name:    string
	ir:      *name | string
	trigger: *"cdc" | "schedule"
	// Complex pipelines are assembly: `src` (under pipelines/) holds the whole
	// rpk stream YAML, copied verbatim to docker/<app>-<name>.yaml. The file
	// owns input, transform, and output alike — aggregate/bloblang/key/shim do
	// not apply, and loop prevention is the author's burden (the emitter
	// cannot see inside).
	raw?: true
	if raw != _|_ {
		src: *"pipelines/\(name).yaml" | string
		transform?: _|_
		key?:       _|_
	}
	from?:   string // source entity name (CDC events); cdc pipelines set it
	to:      string // sink entity name (upsert, or scheduled mutation target)
	group?:  string // bus consumer group; cdc pipelines set it
	// Keyed aggregate: the transform groups source rows by this column and
	// emits an ARRAY of sink rows; the sink upsert conflicts on the sink pk.
	// Unset = singleton transform emitting one row.
	key?: string
	transform?: {
		aggregate: string // PostgREST query the transform reads from the source table
		src: *"pipelines/\(name).blobl" | string // assembly file holding the mapping
		bloblang: string // its content — inlined where the consumer cannot reference files
	}
	// The BROWSER-side transform, written as a fold: empty(key), step(acc, row),
	// combine(a, b), result(acc), with `harden` supplied by SES. It replaces
	// `shim` — the shim contract is (rows) => one row on id, which cannot state
	// a keyed aggregate — and it additionally lets the terminal project the
	// sink optimistically, resuming the fold over rows the sink has not counted.
	//
	// The container keeps its bloblang. rpk can run this module (it embeds
	// goja), and an earlier revision did, but nothing lints a JavaScript string
	// inside a pipeline YAML while `redpanda-connect lint` does catch a broken
	// mapping — so the sharing bought less than the lost build-time check cost.
	// Convert a container transform only where the aggregate is substantial
	// enough that two expressions of it could genuinely diverge.
	//
	// Two laws no type states: combine is associative with empty(key) as its
	// identity, so a fold splits; and the ACCUMULATOR IS THE SINK ROW, so a
	// sink can be read back as a partial fold. The second is why the sink
	// carries `watermark` below, and why an average would have to store sum
	// and n rather than the quotient.
	fold?: {
		src: *"pipelines/\(name).js" | string
		// Sink column holding the newest source txid the count includes. NOT
		// the sink's own txid, which is stamped when the sink row is written —
		// strictly after the read, so it counts rows it never saw.
		watermark: string
		// Source columns uniquely identifying one contribution (the table's
		// composite unique). The reader's rows are collapsed on it: the server
		// holds one, so counting duplicates shows a total that cannot exist.
		dedupe: [...string]
		// Source column that, when set, means the row has been retracted.
		retracted: string
		// The reader's own private answer to "did the count include me".
		//
		// A public aggregate mixes this reader's row with everyone else's, and
		// the difference is not recoverable from the reader's own row: it is a
		// property of the READ that produced the total, not of the data now. So
		// the pipeline emits it, per reader, into a table RLS keeps private —
		// a count discloses nobody, and each browser syncs only its own row.
		//
		// What the terminal actually maintains is `others`, which no write of
		// this reader's can change; their intent applies on top of it, live and
		// offline alike. `total` is carried beside `counted` so the pair is one
		// row from one read, and `asOf` names the version of the reader's row it
		// describes.
		pair: {
			table:   string
			counted: string
			total:   string
			asOf:    string
		}
	}
	if fold != _|_ {
		shim?: _|_
		key:   string // a fold groups; the singleton case has no key to seed empty() with
	}
	// Scheduled pipelines: a generate input ticks every `interval` and the
	// action mutates `to` rows matched by `filter` (PostgREST fragment;
	// tokens {cutoff} and {nowts} resolve to bloblang metadata at runtime).
	interval?: string
	action?:   "delete" | "update"
	filter?:   string
	// Go-style duration of h/m/s units (e.g. "168h", "30m"); required when
	// filter uses {cutoff}: cutoff = now - window.
	window?: string
	set?: {[string]: bool | int | string} // PATCH body for action "update"
	// Browser tier cannot run bloblang; per the escape-hatch doctrine a cdc
	// pipeline binds to a declared shim there: a pure ES module, rows → sink
	// row. Scheduled and raw pipelines have no shim (no browser analogue), and
	// a fold needs none — it already runs at every tier.
	if trigger == "cdc" if raw == _|_ if fold == _|_ {
		shim: *"pipelines/\(name).browser.js" | string
	}
}

#FormField: {
	name: string
	// "file" (blobs on): the shell PUTs the picked file to
	// /blobs/mecha-objects/<uuid><ext> and submits the field's name with the
	// resulting key string.
	// "date" submits day precision: empty → JSON null, else the picked day
	// pinned to 00:00:00Z — the one-clock day convention.
	control:  "text" | "checkbox" | "textarea" | "select" | "hidden" | "datetime" | "date" | "file"
	required: *false | bool
	maxLength?:      int
	placeholder?:    string
	invalidMessage?: string
	options?: [...string] // select controls
	// hidden controls; resolved at submit: `{param.x}`, `{now}`, and the
	// literal `null` meaning SQL NULL.
	value?: string
}

#Form: {
	id:     string
	entity: string
	action: "create" | "update" | "delete" | "upsert"
	// Delete forms only: a PostgREST filter fragment ({param.x} interpolates)
	// scoping a bulk delete of every matching row, instead of the row context.
	filter?: string
	// ir flow id this form realizes; unset when the form realizes no single
	// flow (row-scoped deletes, or one form serving several flows).
	flow?: string
	fields: [...#FormField]
}

#Screen: S={
	name:  string
	ir:    *name | string
	title: string
	route: string // may contain one `:param` segment; params reach filters, hidden values, and `{param.x}` interpolation
	// filter/select are PostgREST query fragments passed through verbatim;
	// `{param.x}` placeholders resolve in the interpreter.
	// Derived from the markup (program_derived.cue). An assembly screen's html
	// exists before any derivation, so a screen the derived file misses is a
	// stale generation and the export fails incomplete rather than shipping a
	// screen whose reads and handlers are silently empty. A CUE-authored
	// screen alone carries the bootstrap default: its html does not exist
	// before the first export, so the first derivation cannot see it —
	// write.ts's fixpoint re-derives after writing and re-exports until the
	// derived file holds what the emitted markup says.
	reads!: [...{entity: string, order?: string, filter?: string, select?: string}]
	if S.markup != _|_ {
		reads: *[] | [...{entity: string, order?: string, filter?: string, select?: string}]
	}
	// A component-bearing screen is authored HERE, in CUE: `markup` is the
	// screen's whole HTML, composed by interpolating component definitions
	// (their tags survive in it as inert wrappers), and files.html becomes an
	// emitted file rather than an assembly source. Absent, the screen is
	// assembly authored at files.html as ever.
	markup?: string
	forms: [...#Form]
	states: [...string] // ir frame ids are "\(name)-\(state)"
	// How many instances of this screen the terminal's navigation stack holds
	// once the user leaves it: the DOM stays, the subscriptions stop, and
	// coming back repaints before it refreshes. A parametrized route would
	// otherwise accumulate one held screen per id ever visited. 0 rebuilds on
	// every visit — the right answer for a screen whose entry animation or
	// first-run state is the point.
	keep: *1 | int & >=0
	// Whether the terminal lists this screen in the strip it draws. A screen
	// reached from somewhere more specific than "everywhere" — a person's own
	// page, a row — declares false, so the strip keeps to the places a reader
	// starts from. Parametrized routes are never listed: they have no static
	// href.
	strip: *true | bool
	paths: [Name=string]: {states: [...string], accepts: [...string]}
	// Assembly files (app-relative): the screen's semantics live in these
	// directly generated artifacts, not in CUE. reads/forms above are the
	// structured source they are generated from — the compiler owns their
	// consistency with the markup.
	//
	// Open, and load-bearingly so: this block is copied verbatim into the
	// route's entry in shell.yaml, where the TERMINAL is the authority on
	// which file kinds a route may carry. Closing it here would mean every
	// vocabulary the terminal grows — renderers today, whatever follows —
	// has to be mirrored into this compiler before an app can name it.
	files: {
		...
		html: *"shell/screens/\(name).html" | string
		css:  *"shell/screens/\(name).css" | string
		// Jessie handlers, SES-compartment-loaded. Derived from the markup;
		// required or bootstrap-defaulted exactly as #Screen.reads is.
		handlers!: [...string]
		if S.markup != _|_ {
			handlers: *[] | [...string]
		}
		// Stylesheets under shell/shared/ this screen imports. Screen CSS is
		// injected as a <style> in the document head, so an @import inside it
		// resolves against /shell/ — `@import url("shared/screen.css")`.
		//
		// Naming it here is what builds it: the served set is the union of what
		// screens actually reference, so a shared file nobody imports is never
		// copied into the image and cannot sit there looking load-bearing.
		shared: [...string & =~"^shell/shared/.*\\.css$"]
	}
}

#Flow: {
	name:   string
	ir:     *name | string
	of:     string // screen
	entity: string
	// "navigate" flows end in a read, not a store call (a navigate form's hash
	// change); entity names the entity the landing read targets.
	action: "create" | "update" | "delete" | "upsert" | "navigate"
}

#Test: {
	id: string
	ir: *id | string
	of: string
	accepts: [...string]
	says:  string
	given: _
	when:  string
	then:  string // CEL over injected input/output/error
}

#App: {
	state: {
		entities: [Name=string]: #Entity & {name: Name}
		// DDL table-order override: must list every entity, parents before
		// children (a `ref` REFERENCES needs its target table emitted first).
		// Unset = entity declaration order, which must itself be parents-first.
		entityOrder?: [...string]
		// Hand-authored SQL beyond the schema vocabulary, as assembly files; the
		// writer copies each src into services/database/migrations/<name>, and
		// the name's numeric prefix orders it among the emitted migrations.
		rawMigrations?: [...{name: string, src: string}]
		pipelines: [Name=string]: #Pipeline & {name: Name}
	}

	capabilities: {
		// Passed through to shell.yaml verbatim: the terminal owns the login
		// chrome, keyed on `required`, and calls the auth service at `service`.
		// Presence also switches the cluster's auth plane on (#emit).
		// `self` names the signed-in person's own page for the strip the
		// terminal draws: `path` is a route whose :params it fills from the
		// session user, and `name` the table and column the name they chose
		// lives in, read live so a rename reaches the strip as it reaches a
		// byline. Omitted by an app that has no page for a person — and then
		// the one identity always on screen leads nowhere.
		auth?: {
			required: bool
			service:  string
			mode:     *"passkey" | string
			self?: {path: string, name?: {table: string, column: string}}
		}
		// Switches the cluster's blob plane on (#emit): rclone-s3 object store
		// and imgproxy behind the caddy /blobs and /img routes.
		blobs: *false | bool
		// Escape hatches, bijection surface only (ir kind "hatch"): the actual
		// service definition is the program's cluster unification beside it.
		hatches: [Name=string]: {ir: *Name | string, kind: "container", note: string}
		// Terminal-tier hatch: a vendored unit running inside the terminal, under
		// one of `isolation`'s boundaries, requesting a subset of the terminal's
		// capability vocabulary (`"group.name"` strings). Checked against
		// #Terminal.capabilities' offer in #emit, not here.
		//
		// `ir` here is deliberately outside the bijection surface: no app
		// declares a vendored unit yet, so it is not registered in
		// check-bijection.ts's KINDS/COLLECTIONS (or SPEC.md's kind
		// vocabulary) pending a real consumer — same deferral as
		// `isolation`/`transports` and the iframe/worker transports.
		vendored: [Name=string]: {
			ir: *Name | string
			isolation: "compartment" | "iframe" | "worker"
			capabilities: [...string]
			src: string
			note: string
		}
	}

	surface: {
		screens: [Name=string]: #Screen & {name: Name}
		// Jessie handlers, bijection surface (ir kind "handler"): `of` is the
		// screen, `src` the assembly module — also listed in that screen's
		// files.handlers, which is what the loader resolves.
		handlers: [Name=string]: {ir: *Name | string, of: string, src: #Jessie, note: string}
		design: #Design
		flows: [Name=string]: #Flow & {name: Name}
	}

	meta: {
		name: string
		// One line for the entry page's meta description. The hash router gives
		// every route this same description, so it names the app, not a screen.
		description: string
		ir: {source: *"ir.html" | string, sha256: string} // the pinned IR this program was compiled from
		tiers: [...#Tier]
		decisions: [Id=string]: {ir: *Id | string, note: string}
		tests: [Id=string]: #Test & {id: Id}
	}
}
