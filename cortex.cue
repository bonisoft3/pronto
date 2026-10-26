package pronto

import mecha "github.com/bonisoft3/pronto/clusters:mecha"

// The app's screens over its Mecha machines (docs/cortex.md), as XState v5
// writes a machine: `config` is its configuration, each state hosted by the
// screen its `meta.screen` names, so navigating there enters the state and
// mounts the child that state's `invoke.src` names; `setup.actors`
// implements each child: a fold the terminal runs over a Mecha machine, or a
// race it hosts.
#CortexMachine: {
	config: mecha.#XState
	setup: actors: [Name=string]: #CortexActor
}

// A fold Pronto composes from the app's Jessie module `handler` over the
// Mecha machine `machine`, emitted as the handler named for the actor; or a
// kinetic child, which hosts a race on its screen.
#CortexActor: #MachineActor | #KineticActor

#MachineActor: {
	machine: =~"^[a-z][a-z0-9_]{0,30}$"
	handler: =~"^[a-z0-9_/-]+\\.js$"
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
	via:        "kinetic"
	handler:    =~"^[a-z0-9_/-]+\\.js$"
	engine:     string
	sound?:     string
	presenter:  string
	bindings:   #Bindings
	seats?:     [...#Bindings]
	menu:       #Bindings
	pause:      [...string]
}

// An action's keys as omnishell's input mapper reads them: a KeyboardEvent
// code or key, `gamepad:button:<n>` and `gamepad:axis:<n>:<sign>`, or
// `touch:<zone>`, a `data-touch-zone` on the screen (omnishell's
// docs/kinetic.md, "Touch").
#Bindings: [=~"^[a-z][a-z0-9_]*$"]: [...string]
