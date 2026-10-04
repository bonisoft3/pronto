// How a browser syncs each server entity's table: whole before a screen reads
// it ("eager"), or only the rows its views ask for, each loaded as a subset of
// the shape ("on-demand"). Nothing authors it; it is read off what the screens'
// markup says (#Screen.reads and .writes, as the terminal routes them) and off
// what the program says the terminal reads outside any region.
//
// A table is on demand only when nothing could read its collection as if it
// were the table: the collection holds the rows some view asked for, so a read
// that is not one of those views would see a short list and render it as the
// whole. The terminal raises a ProgramError at each such read (data-sync.js
// `whole`), which is where a drift between this rule and the store shows.
package pronto

import (
	"list"
	"strings"
)

// Every let in this file has a name of its own: CUE 0.16.1 confuses two lets
// of one name in sibling comprehensions, and reads one's value as the other's.
#App: A={
	// The tables the terminal registers a collection for, each with its
	// entity: what a screen's markup reads and writes, what a form writes, and
	// each fold's private pair, which no region names and the terminal reads
	// on every projection. A table outside it has no collection, so a read
	// embedding one is computed by the server.
	#collections: {
		for _, s in A.surface.screens for r in list.Concat([s.reads, s.writes]) {(r.table): _syncByTable[r.table]}
		for _, s in A.surface.screens for f in s.forms {(A.state.entities[f.entity].table): f.entity}
		for _, p in A.state.pipelines if p.fold != _|_ {(p.fold.pair.table): _syncByTable[p.fold.pair.table]}
	}

	// Each server entity's mode, and the reason for it: the first reason it
	// is eager, or why it can be on demand. pronto's derive writes these rows
	// into the fact store as `sync_mode`.
	#sync: {for n, e in A.state.entities if e.server {(n): {
		table: e.table
		// Every field is stated whatever the answer: one a condition added
		// would arrive after the entity's `sync` had looked the row up, which
		// CUE refuses.
		let why = list.Concat([[for w in _syncEager if w.entity == n {w.why}], [if _syncRead[n] == _|_ {"no screen reads it"}]])
		mode: [if len(why) > 0 {"eager"}, "on-demand"][0]
		reason: [for w in why {w}, "every read of it is a view whose filter Electric compares, or the server's"][0]
	}}}

	// A pattern, not a comprehension over the entities: the rule reads the
	// entities, so a field set it added to would be one it had already read.
	// A browser tier has no mode, and no field to hold one (#Entity).
	state: entities: [N=string]: {sync?: A.#sync[N].mode}

	_syncByTable: {for n, e in A.state.entities {(e.table): n}}
	_syncKey: {for n, e in A.state.entities {(n): [for f in e.fields if f.pk {f.name}][0]}}
	// Per entity, the columns of each kind, a set so a test is one lookup. The
	// platform's txid is an int64. A column no field types keeps the engine's
	// own comparison and is in none of them.
	_syncTypes: {for n, e in A.state.entities {(n): {
		for f in e.fields let t = [if #typeAlias[f.type] != _|_ {#typeAlias[f.type]}, f.type][0] if #types[t] != _|_ {(f.name): #types[t]}
		txid: #types.int64
	}}}
	// Electric compares it (types.cue `subset`).
	_syncCompares: {for n, cols in _syncTypes {(n): {for c, t in cols if t.subset {(c): true}}}}
	// The view engine does not order by it.
	_syncUnordered: {for n, cols in _syncTypes {(n): {for c, t in cols if !list.Contains(["text", "number", "boolean"], t.order) {(c): true}}}}
	// A "text" type with no canonical spelling is free text, ordered by a
	// collation: Postgres's (the cluster's ICU root) in a subset, the reader's
	// locale in the view engine (TanStack's default localeCompare). A spelled
	// one (a uuid, a date) is digits, lowercase hex and fixed punctuation, which
	// every collation orders alike.
	_syncCollated: {for n, cols in _syncTypes {(n): {for c, t in cols if t.order == "text" && t.pattern == _|_ {(c): true}}}}
	// The columns that pin one row of it: its key, a unique field, a declared
	// unique holding over every row.
	_syncWitnesses: {for n, e in A.state.entities {(n): list.Concat([
		[for f in e.fields if f.pk {[f.name]}],
		[for f in e.fields if f.unique != _|_ if f.unique {[f.name]}],
		[for u in e.uniques if u.where == _|_ {u.cols}],
	])}}
	_syncRestricted: {for n, e in A.state.entities if e.access != _|_ if e.access.scope != "public" {(n): e.access.scope}}

	// Every read, judged as data-sync.js serves it. One the server computes
	// (an fts, an unparsed select, an embed of a table with no collection)
	// only watches its table. One the view engine maintains loads its rows,
	// and its embeds' by key, as subsets. Any other reads the collection
	// itself, and the collections of what it embeds.
	_syncReads: [for sn, s in A.surface.screens for r in s.reads {
		at:     "\(sn).html"
		read:   r
		entity: _syncByTable[r.table]
		let embeds = [if r.embeds != _|_ {r.embeds}, []][0]
		served: r.route == "server" || len([for t in embeds if #collections[t] == _|_ {t}]) > 0
		// The entities it joins: once it is not served, every table it embeds
		// has a collection, so an entity.
		joined: [for t in embeds if _syncByTable[t] != _|_ {_syncByTable[t]}]
		hidden: [for x in joined if _syncRestricted[x] != _|_ {x}]
		unsorted: [for c in r.orders if _syncUnordered[entity][c] != _|_ {c}]
		// isMaintainable's program half: a view keeps no row of a table it
		// cannot restate the visibility of, its own or a joined one's.
		restricted: _syncRestricted[entity] != _|_
		viewed:     !served && r.kind == "live" && r.route == "view" && !restricted && len(hidden) == 0 && len(unsorted) == 0
		scanned: !served && !viewed
		// Read once per row of a list stamping it, unless the list's filter
		// pins one row of its table with eq.
		perRow: len([for i in r.lists
			let stamper = s.reads[i]
			let stamperEq = {for c in [if stamper.clauses != _|_ {stamper.clauses}, []][0] if c.op == "eq" {(c.col): true}}
			let stamperKeys = [if _syncByTable[stamper.table] != _|_ {_syncWitnesses[_syncByTable[stamper.table]]}, []][0]
			if len([for w in stamperKeys if len(w) > 0 && len([for c in w if stamperEq[c] == _|_ {c}]) == 0 {w}]) == 0 {i}]) > 0
	}]
	_syncRead: {for v in _syncReads if !v.scanned {
		(v.entity): true
		if v.viewed for x in v.joined {(x): true}
	}}

	// The screens with a reduce, whatever event it is bound to.
	_syncReducing: [for sn, s in A.surface.screens if len([for w in s.writes if w.op == "reduce" {w}]) > 0 {sn}]

	// Every reason a table is eager, in the order the first one is given.
	_syncEager: list.Concat([
		// What the terminal reads whole outside any region.
		[for pn, p in A.state.pipelines if p.fold != _|_ {entity: p.from, why: "the fold \(pn) projects the reader's own contribution from it"}],
		[for pn, p in A.state.pipelines if p.fold != _|_ {entity: _syncByTable[p.fold.pair.table], why: "the fold \(pn) reads the reader's pair from it"}],
		[for n, e in A.state.entities for vn, _ in e.validations {entity: n, why: "validation \(vn) finds the row a write changes in it"}],
		// A validation walks forward along a ref field, or back along
		// "<Entity>.<field>" (validations.ts resolveEdges).
		[for n, e in A.state.entities for vn, v in e.validations for x in v.via {
			entity: [if strings.Contains(x, ".") {strings.Split(x, ".")[0]}, for f in e.fields if f.name == x if f.ref != _|_ {_syncByTable[f.ref]}][0]
			why: "validation \(n).\(vn) walks to it"
		}],
		[for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ {entity: _syncByTable[e.access.shared.via], why: "\(n)'s visibility is decided by its grants"}],
		[for n, e in A.state.entities if e.access != _|_ if e.access.scope == "folder" {entity: e.access.parent, why: "\(n)'s visibility is decided by its parent"}],
		[if A.capabilities.auth != _|_ if A.capabilities.auth.self != _|_ if A.capabilities.auth.self.name != _|_ {
			entity: _syncByTable[A.capabilities.auth.self.name.table]
			why:    "the strip reads the signed-in person's name from it"
		}],
		// Offline is the rung that keeps the table on the device.
		[for n, e in A.state.entities if e.durability == "offline" {entity: n, why: "offline keeps the whole table on the device"}],
		// A view keeps no row whose visibility it cannot restate.
		[for n, scope in _syncRestricted {entity: n, why: "\(n) is \(scope), and a view cannot restate its visibility"}],

		// The reads that take the collection for the table.
		list.Concat([for v in _syncReads if v.scanned {
			let blamed = [
				if v.read.kind == "reads" {"\(v.at) reads it whole for a reduce (data-reads)"},
				if v.read.kind == "named" {"\(v.at) reads it through a named read, which no view is proved to serve"},
				if v.read.route == "whole" {"\(v.at) reads the whole table"},
				if v.read.route == "snapshot" {
					let op = [for c in v.read.clauses if !list.Contains(["eq", "neq", "null", "notnull"], c.op) {c.op}][0]
					"\(v.at) filters it with \([if op == "true" || op == "false" {"is.\(op)"}, op][0]), which the view engine cannot state"
				},
				if v.restricted {"\(v.at) reads it, and a view cannot restate its visibility"},
				if len(v.hidden) > 0 {"\(v.at) embeds \(v.hidden[0]), whose visibility a join cannot restate"},
				"\(v.at) orders it by \(v.unsorted[0]), which the view engine does not order",
			][0]
			list.Concat([[{entity: v.entity, why: blamed}], [for x in v.joined {entity: x, why: "\(v.at) embeds it in a read of \(v.entity) the view engine does not maintain"}]])
		}]),

		// The views whose subsets Electric cannot state.
		list.Concat([for v in _syncReads if v.viewed {
			list.Concat([[for c in v.read.clauses if _syncCompares[v.entity][c.col] == _|_ {
				entity: v.entity
				why:    "\(v.at) filters it on \(c.col), which Electric cannot compare"
			}],
				// TanStack pushes an order down only with a cap, and pages past
				// the cap with a cursor comparing the order's columns.
				[if v.read.limit != _|_ for c in v.read.orders if _syncCompares[v.entity][c] == _|_ {
					entity: v.entity
					why:    "\(v.at) caps it ordered by \(c), and the cursor past the cap compares it, which Electric cannot"
				}],
				// Postgres picks the rows inside the cap by its order, and the
				// view shows them by its own: where the two differ, the view
				// holds rows an eager table would not show.
				[if v.read.limit != _|_ for c in v.read.orders if _syncCollated[v.entity][c] != _|_ {
					entity: v.entity
					why:    "\(v.at) caps it ordered by \(c), which Postgres orders by its collation and the view engine by the reader's locale"
				}],
				// A join loads the embedded rows by key, as a view of that table
				// would.
				[for x in v.joined if _syncCompares[x][_syncKey[x]] == _|_ {
					entity: x
					why:    "\(v.at) joins it on \(_syncKey[x]), which Electric cannot compare"
				}]])
		}]),

		// A view read once per row of a list asks for its rows, and its
		// joins' by key, once per row, where an eager table loads once. One
		// nested only in slots, or in a list whose filter pins one row, reads
		// once.
		list.Concat([for v in _syncReads if v.viewed && v.perRow {
			list.Concat([[{entity: v.entity, why: "\(v.at) reads it once per row of a list"}],
				[for x in v.joined {entity: x, why: "\(v.at) joins it in a read once per row of a list"}]])
		}]),

		// A reduce is code, whatever event it is bound to: each update it
		// returns and each effect names its own entity (screen.js applyUpdates,
		// applyEffects), so the markup cannot say which tables it writes, and a
		// put, an upsert and a delete by filter read the table to find the row.
		[if len(_syncReducing) > 0 for n, e in A.state.entities if e.server {
			entity: n
			why:    "\(_syncReducing[0]).html writes from a reduce, whose updates and effects may write any table"
		}],

		// The writes that find their row in the collection. One by key loads
		// a row no view loaded as a view of its key (data-sync.js `holding`),
		// whatever the screen shows: the key a form or an effect carries is
		// bound from anywhere.
		[for sn, s in A.surface.screens for w in s.writes
			let at = "\(sn).html"
			let wn = _syncByTable[w.table]
			let pk = _syncKey[wn]
			let refused = [
				if w.op == "upsert" {"\(at) upserts it, which finds the row by natural key in the table"},
				if w.op == "delete" && w.filter != _|_ {"\(at) deletes from it by filter, which finds the rows in the table"},
				if (w.op == "update" || w.op == "delete") && _syncCompares[wn][pk] == _|_ {"\(at) \(w.op)s a row of it by \(pk), which Electric cannot compare to load the row"},
			]
			if len(refused) > 0 {entity: wn, why: refused[0]}],
	])
}
