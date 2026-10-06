// How a browser syncs each server entity's table: whole before a screen reads
// it ("eager"), or only the rows its views ask for, each loaded as a subset of
// the shape ("on-demand"). Nothing authors it; it is read off what the screens'
// markup says (#Screen.reads and .writes, as the terminal routes them) and off
// what the program says the terminal reads outside any region.
//
// Whole-collection requirements outside a query remain eager. A region or
// named read acquires its own subset or complete snapshot while active, so
// one broad read does not dictate how another screen loads the same table.
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
		if A.capabilities.auth != _|_ if A.capabilities.auth.self != _|_ if A.capabilities.auth.self.name != _|_ {
			(A.capabilities.auth.self.name.table): _syncByTable[A.capabilities.auth.self.name.table]
		}
		// A server join's dependencies may never be read as regions themselves.
		for _, s in A.surface.screens for r in s.reads if r.embeds != _|_ for t in r.embeds {
			if _syncByTable[t] != _|_ {(t): _syncByTable[t]}
			for _, e in A.state.entities for f in e.fields if f.name == t if f.ref != _|_ {(f.ref): _syncByTable[f.ref]}
		}
		for _, s in A.surface.screens for f in s.forms {(A.state.entities[f.entity].table): f.entity}
		for _, p in A.state.pipelines if p.fold != _|_ {(p.fold.pair.table): _syncByTable[p.fold.pair.table]}
		for _, p in A.state.pipelines if p.fold != _|_ {(A.state.entities[p.from].table): p.from}
		// Visibility walks through parents and grants even when markup names
		// only a child. Register every edge so ancestor metadata travels too.
		for _, e in A.state.entities if e.access != _|_ {
			if e.access.scope == "folder" {(A.state.entities[e.access.parent].table): e.access.parent}
			if e.access.scope == "private" if e.access.shared != _|_ {(e.access.shared.via): _syncByTable[e.access.shared.via]}
		}
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
		reason: [for w in why {w}, "each active query demands its own subset or complete snapshot"][0]
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
	_syncRestricted: {for n, e in A.state.entities if e.access != _|_ if e.access.scope != "public" {(n): e.access.scope}}

	_syncRead: {
		for _, screen in A.surface.screens for read in screen.reads {
			(_syncByTable[read.table]): true
			if read.embeds != _|_ for table in read.embeds if _syncByTable[table] != _|_ {(_syncByTable[table]): true}
		}
	}

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

		// An opaque keyed effect may name a row no view holds. Whole-table
		// mutations demand their snapshot at runtime; keyed effects still need
		// a key Electric can compare to load that row.
		[if len(_syncReducing) > 0 for n, e in A.state.entities if e.server
			if _syncCompares[n][_syncKey[n]] == _|_ {
				entity: n
				why:    "\(_syncReducing[0]).html writes from a reduce, and Electric cannot compare \(n)'s key to load a row it targets"
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
				if (w.op == "update" || w.op == "delete") && _syncCompares[wn][pk] == _|_ {"\(at) \(w.op)s a row of it by \(pk), which Electric cannot compare to load the row"},
			]
			if len(refused) > 0 {entity: wn, why: refused[0]}],
	])
}
