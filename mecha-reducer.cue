package pronto

import (
	"list"
	"strings"
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
)

#HybridShape: mecha.#Shape

// A machine Mecha runs, as an app declares it (mecha.#Machine): XState's
// configuration and the setup beside it.
#Machine: mecha.#Machine

// Reducers execute in Mecha; incoming event tiers do not transfer write authority.
#MechaReducerMachine: M={
	name:    string & =~"^[a-z][a-z0-9_]{0,30}$"
	version: int & >0
	fuel:    *10000 | (int & >0 & <=1000000)
	entropy: *0 | (int & >=0 & <=1024)
	initial: string
	locks?: [...#MechaReadLock]
	initialize?: {reduce: string, input: #HybridShape & {type: "object"}}
	ports?: #MechaPorts
	state: #HybridShape & {type: "object"}
	view: #HybridShape & {type: "object"}
	// What anyone may read of an instance: `rules.publish(state)` returns it, or
	// null for an instance nobody else sees, into `<name>_public`.
	public?: #HybridShape & {type: "object"}
	contracts: [string]: {reads: [...string], writes?: [...string]}
	events: [string]: {
		tier: "omnishell" | "mecha"
		payload: #HybridShape & {type: "object"}
	}
	states: [string]: {
		final: *false | bool
		always?: [...{target: string, guard?: string, reduce?: string}]
		on: [string]: {
			target?: string
			guard?:  string
			reduce?: string
			requires?: {sql: string, reason: string & =~"^[a-z][a-z0-9_]{0,63}$"}
			actions?: [...(#MechaAction & {assign?: _|_, lock?: _|_, raise?: #NotifyRaise | [...#NotifyRaise]})]
		}
	}

	hatches: list.SortStrings([for name, _ in {
		for _, stateSpec in M.states for _, transition in stateSpec.on if transition.actions != _|_ for actionSpec in transition.actions if actionSpec.hatch != _|_
		for h in [if (actionSpec.hatch & [...]) != _|_ {actionSpec.hatch}, [actionSpec.hatch]][0] {(h.name): true}
	} {name}])
	mecha: {
        if M.ports != _|_ {ports: {
            if M.ports.admission != _|_ {admission: {
                input: (#MechaJsonSql & {fields: M.ports.admission.input}).out
                members: (#MechaJsonSql & {fields: M.ports.admission.members}).out
                locks: strings.Join([for lockSpec in M.ports.admission.locks {(#mechaLockSql & {lock: lockSpec}).out}], "\n")
            }}
        }}
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
// The compilers read this; nothing authors it.
#Reducer: R={
	machine: mecha.#Machine
	_c:      R.machine.config
	_s:      R.machine.setup
	_names: [for n, _ in _c.states {n}]
	_arrows: {for sn, st in _c.states {
		(sn): {
			on: {
				if st.on != _|_ for ev, tv in st.on {(ev): (#reducerArrow & {value: tv, setup: R._s}).out}
				// A final state takes no event, the machine's own included.
				if _c.on != _|_ if st.type == _|_ for ev, tv in _c.on if st.on == _|_ || st.on[ev] == _|_ {(ev): (#reducerArrow & {value: tv, setup: R._s}).out}
			}
			always: [if st.always != _|_ for t in [if (st.always & [...]) != _|_ {st.always}, [st.always]][0] {(#reducerArrow & {value: t, setup: R._s}).out}]
		}
	}}
	out: #MechaReducerMachine & {
		name:    _c.id
		version: _s.version
		fuel:    _s.fuel
		entropy: _s.entropy
		initial: _c.initial
		if _s.locks != _|_ {locks: _s.locks}
		if _s.ports != _|_ {ports: _s.ports}
		if _s.initialize != _|_ {initialize: {reduce: _s.initialize, input: _s.types.input}}
		// Copied rather than unified: an app's context is often a closed definition.
		state: {type: "object", fields: {
			for k, v in _s.types.context.fields {(k): v}
			phase: {type: "string", maxLength: [if len(_names) > 0 {list.Max([for n in _names {len(n)}])}, 0][0], values: _names}
		}}
		view: _s.types.view
		if _s.types.public != _|_ {public: _s.types.public}
		// Keyed by the rule the step runs: a database guard's contract is its
		// rules guard's.
		contracts: {
			for n, a in _s.actions if (a & [...]) == _|_ {(n): a}
			for n, g in _s.guards if g.sql == _|_ {(n): {reads: g.reads}}
			for _, g in _s.guards if g.sql != _|_ if g.rules != _|_ {(g.rules): {reads: [if g.reads != _|_ {g.reads}, []][0]}}
		}
		events: _s.types.events
		states: {for sn, st in _c.states {
			(sn): {
				final: [if st.type != _|_ {st.type == "final"}, false][0]
				on: _arrows[sn].on
				if len(_arrows[sn].always) > 0 {always: _arrows[sn].always}
			}
		}}
	}
}

// One XState transition as the reducer takes it. An event names one
// transition: a guarded alternative belongs in the guard.
#reducerArrow: A={
	value: _
	setup: _
	_t: [
		if (A.value & string) != _|_ {{target: A.value}},
		// Any other list is #App's to refuse (_hybridRefusal), by name.
		if (A.value & [...]) != _|_ {[if len(A.value) == 1 {A.value[0]}, {}][0]},
		A.value,
	][0]
	_actions: [if A._t.actions != _|_ {[if (A._t.actions & string) != _|_ {[A._t.actions]}, A._t.actions][0]}, []][0]
	_effect: {for a in A._actions if A.setup.actions[a] != _|_ if (A.setup.actions[a] & [...]) != _|_ {(a): A.setup.actions[a]}}
	_reduces: [for a in A._actions if A._effect[a] == _|_ {a}]
	_effects: list.Concat([for a in A._actions if A._effect[a] != _|_ {A._effect[a]}])
	_guard: [if A._t.guard != _|_ if A.setup.guards[A._t.guard] != _|_ if A.setup.guards[A._t.guard].sql != _|_ {A.setup.guards[A._t.guard]}, null][0]
	out: {
		if A._t.target != _|_ {target: A._t.target}
		if len(A._reduces) == 1 {reduce: A._reduces[0]}
		if len(A._reduces) > 1 {reduce: _|_ // an event updates the context once
		}
		if A._t.guard != _|_ if A._guard == null {guard: A._t.guard}
		if A._guard != null {
			if A._guard.rules != _|_ {guard: A._guard.rules}
			requires: {sql: A._guard.sql, reason: A._guard.reason}
		}
		if len(A._effects) > 0 {actions: A._effects}
	}
}
