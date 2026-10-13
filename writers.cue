// Who writes each entity's rows, read off every declaration that names it: a
// screen's forms and what its markup writes past them, the terminal charts it
// carries, a pipeline's sink and a fold's pair, a computation's outputs, a
// mecha machine's row and relational effects, a unit's memo. Nothing authors it. Two kinds
// of writer on one entity is a fact the card shows, not a refusal
// (PENDING.md, "Two kinds of writer on one entity").
package pronto

import "list"

#Writer: {
	by:   string
	kind: "form" | "screen" | "chart" | "pipeline" | "computation" | "machine" | "unit" | "hatch"
	// A navigate writes nothing.
	ops: [...#Write.op & !="navigate"]
}

// Every let in this file has a name of its own: CUE 0.16.1 confuses two lets
// of one name in sibling comprehensions, and reads one's value as the other's.
#App: A={
	_entityByTable: {for n, e in A.state.entities {(e.table): n}}
	// The distinct values of a list, first occurrence first.
	_distinct: {of: [...string], out: [for o, _ in {for x in of {(x): true}} {o}]}
	// Relational effects name the tables their operations write; hatches and
	// raises have no inferred write set.
	_machineEffects: {for x in A._machineActions {(x.machine): [
		for a in x.actions if a.effect != _|_
		for e in [if (a.effect & [...]) != _|_ {a.effect}, [a.effect]][0] if e.op != _|_ {table: e.table, op: e.op},
	]}}
	// Every chart every screen carries, named as the bijection claims it
	// (objects.ts chartDeclarations): one `<entity ir>-<field>` however many
	// screens run it. It moves its own row's field and performs its effects.
	_charts: [for _, s in A.surface.screens for c in s.charts {
		name:   "\(A.state.entities[A._entityByTable[c.table]].ir)-\(c.field)"
		writes: list.Concat([[{table: c.table, op: "update"}], c.writes])
	}]
	_chartNames: _distinct & {of: [for c in A._charts {c.name}]}

	// One entry per declaration naming the entity, kinds in the order above.
	#writers: {for n, e in A.state.entities {(n): list.Concat([
		[for sn, s in A.surface.screens
			let formOps = _distinct & {of: [for f in s.forms if f.entity == n {f.action}]}
			if len(formOps.out) > 0 {by: sn, kind: "form", ops: formOps.out}],
		// A reduce: the writes the markup states that no form and no chart of
		// the screen already said; a navigate writes nothing.
		[for sn, s in A.surface.screens
			let said = {
				for f in s.forms if f.entity == n {(f.action): true}
				for c in s.charts for w in c.writes if w.table == e.table {(w.op): true}
			}
			let markupOps = _distinct & {of: [for w in s.writes if w.table == e.table if w.op != "navigate" if said[w.op] == _|_ {w.op}]}
			if len(markupOps.out) > 0 {by: sn, kind: "screen", ops: markupOps.out}],
		[for cn in A._chartNames.out
			let chartOps = _distinct & {of: [for c in A._charts if c.name == cn for w in c.writes if w.table == e.table {w.op}]}
			if len(chartOps.out) > 0 {by: cn, kind: "chart", ops: chartOps.out}],
		// A sink is upserted on its key; a scheduled pipeline's action is its own.
		[for pn, p in A.state.pipelines if p.to == n {
			by: pn
			if p.raw != _|_ {kind: "hatch", ops: []}
			if p.raw == _|_ {kind: "pipeline", ops: [[if p.action != _|_ {p.action}, "upsert"][0]]}
		}],
		[for pn, p in A.state.pipelines if p.fold != _|_ if _entityByTable[p.fold.pair.table] == n if p.to != n {by: pn, kind: "pipeline", ops: ["upsert"]}],
		[for cn, c in A.state.computations if list.Contains(c.to, n) {by: cn, kind: "computation", ops: ["upsert"]}],
		// Its own row's field, moved in the write, and every relational effect
		// landing on this table.
		[for mn, m in [if A.state.machines != _|_ {A.state.machines}, {}][0]
			let machineOps = _distinct & {of: list.Concat([
				[if m.entity == n || m.entity == e.table if m.field != _|_ {"update"}],
				[for w in _machineEffects[mn] if w.table == e.table {w.op}],
			])}
			if len(machineOps.out) > 0 {by: mn, kind: "machine", ops: machineOps.out}],
		// A memo: the terminal upserts the agent's answer on the key.
		[for un, u in A.capabilities.vendored if u.memo != _|_ if u.memo.entity == n {by: un, kind: "unit", ops: ["upsert"]}],
	])}}

	// A pattern, not a comprehension over the entities: the rule reads the
	// entities, so a field set it added to would be one it had already read.
	state: entities: [N=string]: {writers: A.#writers[N]}
}
