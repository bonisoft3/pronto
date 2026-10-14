package pronto

import ("strings"
	"list")

#HybridShape: {
	type:      "string"
	maxLength: int & >=0 & <=65536
	values?: [...string]
} | {
	type: "integer"
	min:  int & >=-9007199254740991
	max:  int & <=9007199254740991 & >=min
} | {
	type: "boolean"
} | {
	type:     "array"
	maxItems: int & >=0 & <=1024
	items:    #HybridShape
} | {
	type: "object"
	fields: [string]: #HybridShape
}

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
	events: [string]: {
		tier: "omnishell" | "mecha"
		payload: #HybridShape & {type: "object"}
	}
	states: [string]: {
		final: *false | bool
		always?: [...{target: string, guard?: string, reduce: string}]
		on: [string]: {
			target?: string
			guard?:  string
			reduce:  string
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
            if M.ports.session != _|_ {session: {
                payload: (#MechaJsonSql & {fields: M.ports.session.renew.payload}).out
                select: (#MechaJsonSql & {fields: M.ports.session.select}).out
                routes: {for name, route in M.ports.session.routes {(name): [for arg in route.args {(#sqlLit & {v: arg}).out}]}}
            }}
        }}
		locks: strings.Join([if M.locks != _|_ for lockSpec in M.locks {(#mechaLockSql & {lock: lockSpec}).out}], "\n")
		transitions: [for phaseName, stateSpec in M.states for eventName, transition in stateSpec.on if transition.requires != _|_ || transition.actions != _|_ {
			phase: phaseName
			event: eventName
			if transition.requires != _|_ {requires: transition.requires}
			sql: strings.Join([if transition.actions != _|_ for actionSpec in transition.actions {(#mechaActionSql & {action: actionSpec, op: "UPDATE"}).out}], "\n")
		}]
	}
}
