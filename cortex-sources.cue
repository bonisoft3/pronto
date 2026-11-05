package pronto

import "list"

// Translate named XState implementations to the existing row-machine actions.
#CortexMechaTransition: T={
	transition: string | {target?: string, guard?: string, actions?: string | [...string]}
	event: *false | bool
	guards: [string]: {sql: string}
	actions: [string]: [...#MechaAction]
	out: [if (T.transition & string) != _|_ {{target: T.transition}}, {
		if T.transition.target != _|_ {target: T.transition.target}
		if T.transition.guard != _|_ {guard: T.guards[T.transition.guard].sql}
		if T.transition.actions != _|_ {
			actions: list.Concat([for name in [if (T.transition.actions & string) != _|_ {[T.transition.actions]}, T.transition.actions][0] {
				[if T.event {T.actions[name] & [...#MechaAction & {spawn?: _|_, send?: _|_, lock?: _|_, hatch?: _|_, raise?: _|_, reject?: _|_}]}, T.actions[name]][0]
			}])
		}
	}][0]
}

#CortexMechaOutcome: O={
	transition: _
	guards: [string]: {sql: string}
	actions: [string]: [...#MechaAction]
	out: [if (O.transition & [...]) != _|_ {
		[for branch in O.transition {(#CortexMechaTransition & {transition: branch, guards: O.guards, actions: O.actions}).out}]
	}, (#CortexMechaTransition & {transition: O.transition, guards: O.guards, actions: O.actions}).out][0]
}
