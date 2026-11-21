package pronto

import (
	"list"
	"strings"
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
)

#MechaShape: mecha.#Shape

// A machine Mecha runs, as an app declares it (mecha.#Machine): XState's
// configuration and the setup beside it.
#Machine: mecha.#Machine

// Reducers execute in Mecha; incoming event tiers do not transfer write authority.
#MechaReducerMachine: {
	let M = self
	name:        string & =~"^[a-z][a-z0-9_]{0,30}$"
	version:     int & >0
	fuel:        *10000 | (int & >0 & <=1000000)
	entropy:     *0 | (int & >=0 & <=1024)
	initial:     string
	locks?:      [...#MechaReadLock]
	initialize?: {reduce: string, input: #MechaShape & {type: "object"}}
	ports?:      #MechaPorts
	state:       #MechaShape & {type: "object"}
	view:        #MechaShape & {type: "object"}
	// What anyone may read of an instance: `rules.publish(state)` returns it, or
	// null for an instance nobody else sees, into `<name>_public`.
	public?: #MechaShape & {type: "object"}
	contracts: [string]: {reads: [...string], writes?: [...string], reason?: string}
	events: [string]: {
		tier:    "omnishell" | "mecha"
		payload: #MechaShape & {type: "object"}
	}
	// XState's `delays`: milliseconds, or the context field holding them.
	delays?: [string]: int | string
	// A state named `a.b` is the child `b` of the compound state `a`, whose
	// `initial` names the child (`a.b`) its entry lands in; a phase is atomic.
	states: [string]: {
		final:    *false | bool
		initial?: string
		// A guard or an action the database implements has no automatic form.
		always?: [...close({target: string, guard?: [...string], reduce?: string})]
		// Nor a delayed one: a timer's step is the rules' alone. A delay's
		// arrows are tried in order, as XState tries them.
		after?: [string]: [...close({target?: string, guard?: [...string], reduce?: string, reenter?: bool})]
		on: [string]: {
			target?:  string
			reenter?: bool
			guard?:   [...string]
			reduce?:  string
			// Tried in order: the first that is not true refuses the event with its reason.
			requires?: [...{sql: string, reason: string & =~"^[a-z][a-z0-9_]{0,63}$"}]
			actions?:  [...(#MechaAction & {assign?: _|_, lock?: _|_, raise?: #NotifyRaise | [...#NotifyRaise]})]
		}
	}

	hatches: list.SortStrings([for name, _ in {
		for _, stateSpec in M.states for _, transition in stateSpec.on if transition.actions != _|_ for actionSpec in transition.actions if actionSpec.hatch != _|_
		for h in [if (actionSpec.hatch & [...]) != _|_ {actionSpec.hatch}, [actionSpec.hatch]][0] {(h.name): true}
	} {name}])
	mecha: {
		if M.ports != _|_ {
			ports: {
				if M.ports.admission != _|_ {
					admission: {
						input:   (#MechaJsonSql & {fields: M.ports.admission.input}).out
						members: (#MechaJsonSql & {fields: M.ports.admission.members}).out
						locks:   strings.Join([for lockSpec in M.ports.admission.locks {(#mechaLockSql & {lock: lockSpec}).out}], "\n")
					}
				}
			}
		}
		locks: strings.Join([if M.locks != _|_ for lockSpec in M.locks {(#mechaLockSql & {lock: lockSpec}).out}], "\n")
		transitions: [for phaseName, stateSpec in M.states for eventName, transition in stateSpec.on if transition.requires != _|_ || transition.actions != _|_ {
			phase: phaseName
			event: eventName
			if transition.requires != _|_ {requires: transition.requires}
			sql: strings.Join([if transition.actions != _|_ for actionSpec in transition.actions {(#mechaActionSql & {action: actionSpec, op: "UPDATE", at: "now_ms"}).out}], "\n")
		}]
	}
}

// The internal form of a machine authored as XState (mecha.#Machine): its
// context with the state value as `phase`, and each transition's guard, its
// one context-updating action and the relational effects the setup lists.
// A nested state is named by its path, `a.b`, and its targets by theirs. The
// compilers read this; nothing authors it.
#Reducer: {
	let R = self
	machine: mecha.#Machine
	_c:      R.machine.config
	_s:      R.machine.setup
	// Each state by its path, beside the path of the state it is a child of.
	_flat: {
		for sn, st in _c.states {
			(sn): {node: st, parent: ""}
			if st.states != _|_ for cn, ct in st.states {"\(sn).\(cn)": {node: ct, parent: sn}}
		}
	}
	_names: [for n, _ in _flat {n}]
	_leaves: [for n, f in _flat if f.node.states == _|_ {n}]
	_arrows: {for sn, f in _flat {
		let st = f.node
		let at = {path: sn, parent: f.parent, id: _c.id}
		(sn): {
			on: {
				if st.on != _|_ for ev, tv in st.on {(ev): (#reducerArrow & {value: tv, setup: R._s, from: at}).out}

				// A final state takes no event, the machine's own included; a
				// child takes the machine's through the state it is a child of.
				if f.parent == "" if _c.on != _|_ if st.type == _|_ for ev, tv in _c.on if st.on == _|_ || st.on[ev] == _|_ {(ev): (#reducerArrow & {value: tv, setup: R._s, from: at}).out}
			}
			always: [if st.always != _|_ for t in [if (st.always & [...]) != _|_ {st.always}, [st.always]][0] {(#reducerArrow & {value: t, setup: R._s, from: at}).out}]
			after: {if st.after != _|_ for delay, tv in st.after {
				(delay): [for t in [if (tv & [...]) != _|_ {tv}, [tv]][0] {(#reducerArrow & {value: t, setup: R._s, from: at}).out}]
			}}
		}
	}}
	out: #MechaReducerMachine & {
		name:    _c.id
		version: _s.version
		fuel:    _s.fuel
		entropy: _s.entropy
		// The atomic state a new instance stands in.
		initial: [if _c.states[_c.initial].states != _|_ {"\(_c.initial).\(_c.states[_c.initial].initial)"}, _c.initial][0]
		if _s.locks != _|_ {locks: _s.locks}
		if _s.ports != _|_ {ports: _s.ports}
		if _s.delays != _|_ {delays: _s.delays}
		if _s.initialize != _|_ {initialize: {reduce: _s.initialize, input: _s.types.input}}

		// Copied rather than unified: an app's context is often a closed definition.
		state: {type: "object", fields: {
			for k, v in _s.types.context.fields {(k): v}
			phase: {type: "string", maxLength: [if len(_leaves) > 0 {list.Max([for n in _leaves {len(n)}])}, 0][0], values: _leaves}
		}}
		view: _s.types.view
		if _s.types.public != _|_ {public: _s.types.public}

		// Keyed by the rule the step runs: a database guard runs after the
		// rules' guards it names, each under its own contract.
		contracts: {
			for n, a in _s.actions if (a & [...]) == _|_ {(n): a}
			for n, g in _s.guards if g.sql == _|_ if g.checks == _|_ {(n): {
				reads: g.reads
				if g.reason != _|_ {reason: g.reason}
			}}
		}
		events: _s.types.events
		states: {for sn, f in _flat {
			let st = f.node
			(sn): {
				final: [if st.type != _|_ {st.type == "final"}, false][0]
				if st.initial != _|_ {initial: "\(sn).\(st.initial)"}
				on:    _arrows[sn].on
				if len(_arrows[sn].always) > 0 {always: _arrows[sn].always}
				if len(_arrows[sn].after) > 0 {after: _arrows[sn].after}
			}
		}}
	}
}

// One XState transition as the reducer takes it. An event names one
// transition: a guarded alternative is another of its guards. Its target is
// read as XState reads it from the state `from` names: a sibling's name, a
// child's as `.name`, or any state's as `#<machine id>.<path>`.
#reducerArrow: {
	let A = self
	value: _
	setup: _
	from: {path: string, parent: string, id: string}
	_t: [
		if (A.value & string) != _|_ {{target: A.value}},
		// Any other list is #App's to refuse (_mechaRefusal), by name.
		if (A.value & [...]) != _|_ {[if len(A.value) == 1 {A.value[0]}, {}][0]},
		A.value,
	][0]
	_actions: [if A._t.actions != _|_ {[if (A._t.actions & string) != _|_ {[A._t.actions]}, A._t.actions][0]}, []][0]
	_effect:  {for a in A._actions if A.setup.actions[a] != _|_ if (A.setup.actions[a] & [...]) != _|_ {(a): A.setup.actions[a]}}
	_reduces: [for a in A._actions if A._effect[a] == _|_ {a}]
	_effects: list.Concat([for a in A._actions if A._effect[a] != _|_ {A._effect[a]}])
	// The guards a transition names, in order. One the database implements
	// stands for the rules' guards it names and its own sql, one with its
	// reason or checks each with theirs; the rules' guards are tried first.
	_named: [if A._t.guard != _|_ {[if (A._t.guard & string) != _|_ {[A._t.guard]}, A._t.guard][0]}, []][0]
	_db: {for g in A._named if A.setup.guards[g] != _|_ if A.setup.guards[g].sql != _|_ || A.setup.guards[g].checks != _|_ {(g): A.setup.guards[g]}}
	_rules: list.Concat([for g in A._named {[if A._db[g] == _|_ {[g]}, if A._db[g].rules != _|_ {A._db[g].rules}, []][0]}])
	_requires: list.Concat([for g in A._named if A._db[g] != _|_ {[if A._db[g].checks != _|_ {[for c in A._db[g].checks {sql: c.sql, reason: c.reason}]}, [{sql: A._db[g].sql, reason: A._db[g].reason}]][0]}])
	out: {
		if A._t.target != _|_ {target: [
			if strings.HasPrefix(A._t.target, "#") {strings.TrimPrefix(A._t.target, "#\(A.from.id).")},
			if strings.HasPrefix(A._t.target, ".") {A.from.path + A._t.target},
			if A.from.parent != "" {"\(A.from.parent).\(A._t.target)"},
			A._t.target,
		][0]}
		if A._t.reenter != _|_ {reenter: A._t.reenter}
		if len(A._reduces) == 1 {reduce: A._reduces[0]}
		if len(A._reduces) > 1 {
			reduce: _|_ // an event updates the context once
		}
		if len(A._rules) > 0 {guard: A._rules}
		if len(A._requires) > 0 {requires: A._requires}
		if len(A._effects) > 0 {actions: A._effects}
	}
}
