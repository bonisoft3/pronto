package pronto

import (
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
	terminal "github.com/bonisoft3/omnishell:terminal"
)

// XState control flow with host-specific source and effect implementations.
#CortexMachine: {
	config: mecha.#XState & {meta?: {host?: "mecha" | "omnishell", ...}}
	for _, actor in setup.actors if actor.via == "query" {config: meta: host: "mecha"}
	setup: {
		actors: [Name=string]: #CortexActor
		guards: [string]: {sql: string}
		actions: [string]: [...#MechaAction]
	}
}

// A fold Pronto composes from the app's Jessie module `handler` over the
// Mecha machine `machine`, emitted as the handler named for the actor; or a
// kinetic child, which hosts a race on its screen.
#CortexActor: #MachineActor | #KineticActor | #QueryActor | #ObservationActor | #NavigationActor | #HostedRowActor | #RowsActor

#HostedRowActor: {
	via:      "mecha"
	lifetime: "row"
	machine: #CortexMachine & {config: meta: host: "mecha"}
}

#RowsActor: {
	via:      "rows"
	lifetime: "attachment"
	screen:   string
	charts: [string]: terminal.#Machine | [...terminal.#Machine]
}

#MachineActor: {
	machine:  =~"^[a-z][a-z0-9_]{0,30}$"
	handler?: =~"^[a-z0-9_/-]+\\.js$"
	// Leased: the fold holds a lease row on the terminal's clock. Attached
	// (`sync`): the fold opens the instance the invoke's `input.instance`
	// names from the route, and leaving detaches. Local: played in the
	// terminal on the machine's own reducer.
	via: "session" | "sync" | "local"
}

// The kinetic plane's child (docs/decisions/2026-10-23-kinetic-machine.md):
// the terminal hosts `engine` on the screen's `data-kinetic` mount, voiced by
// the `sound` role and painted by the `presenter` unit. The car reads
// `bindings` (each of `seats` on one keyboard, for a hot-seat race); between
// races `menu`, and always `pause`, are presses the screen's reduce hears. Its
// handler is the reduce the mount's region names, a module of the screen's.
#KineticActor: {
	via:       "kinetic"
	handler:   =~"^[a-z0-9_/-]+\\.js$"
	engine:    string
	sound?:    string
	presenter: string
	bindings:  #Bindings
	seats?: [...#Bindings]
	menu: #Bindings
	pause: [...string]
}

// An action's keys as omnishell's input mapper reads them: a KeyboardEvent
// code or key, `gamepad:button:<n>` and `gamepad:axis:<n>:<sign>`, or
// `touch:<zone>`, a `data-touch-zone` on the screen (omnishell's
// docs/kinetic.md, "Touch").
#Bindings: [=~"^[a-z][a-z0-9_]*$"]: [...string]

// Sources provide facts; their receiving chart decides what follows.
#QueryActor: {
	via:    "query"
	event:  string
	select: string
}

#ObservationActor: O={
	via:       "observe"
	lifetime?: "attachment"
	table?:    string
	machine?:  string
	field?:    string
	match: [string]: string
	event?:   string
	suffix?:  bool
	missing?: string
	require?: [...string]
	if O.machine != _|_ {event!: string}
	if O.machine == _|_ {
		table!: string
		if O.field != _|_ {event!: string}
		if O.field == _|_ {missing!: string}
	}
}

// The terminal owns route resolution, screen activation and cancellation.
#NavigationActor: {via: "navigation"}

// Projection preserves independently hosted row charts without giving their
// browser attachments ownership of the durable instances.
#CortexComposition: C={
	root: #CortexMachine
	// Entity validations depend on compiled machines, so only their table names
	// cross back into the composition's inputs.
	entities: [string]: {table: string}
	_charts: {
		(C.root.config.id): C.root
		for name, actor in C.root.setup.actors if actor.via == "mecha" {
			(name): actor.machine
		}
	}
	_collisions: [for name, actor in C.root.setup.actors if actor.via == "mecha" if name == C.root.config.id {name}]
	_unique: len(_collisions) & 0
	_resolved: {for name, chart in C._charts {
		(name): (#ResolvedCortexMachine & {machine: chart, actors: C.root.setup.actors, entities: C.entities}).out
	}}
	out: {
		for name, chart in C._resolved {
			(name): {
				for key, value in chart if key != "setup" {(key): value}
				setup: {
					for key, value in chart.setup if key != "actors" {(key): value}
					actors: {for actorName, actor in chart.setup.actors {
						(actorName): {
							for key, value in actor if key != "machine" || actor.via != "mecha" {(key): value}
							if actor.via == "mecha" {machine: C._resolved[actorName]}
						}
					}}
				}
			}
		}
	}
}

#ResolvedCortexMachine: R={
	machine: #CortexMachine
	actors: [string]: #CortexActor
	entities: [string]: {table: string}
	out: {
		for key, value in R.machine if key != "setup" {(key): value}
		setup: {
			for key, value in R.machine.setup if key != "actors" {(key): value}
			actors: {for name, actor in R.machine.setup.actors {
				(name): actor
				if actor.via == "observe" if actor.machine != _|_ {
					let target = R.actors[actor.machine] & #HostedRowActor
					let meta = target.machine.config.meta
					(name): {
						table: R.entities[meta.entity].table
						field: meta.field
					}
				}
			}}
		}
	}
}
