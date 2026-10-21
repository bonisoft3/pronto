package pronto

import mecha "github.com/bonisoft3/pronto/clusters:mecha"

// The app's screens over its Mecha machines (docs/cortex.md), as XState v5
// writes a machine: `config` is its configuration, each state hosted by the
// screen its `meta.screen` names, so navigating there enters the state and
// mounts the child that state's `invoke.src` names; `setup.actors`
// implements each child as a fold the terminal runs over a Mecha machine.
#CortexMachine: {
	config: mecha.#XState
	setup: actors: [Name=string]: #CortexActor
}

// A fold Pronto composes from the app's Jessie module `handler` over the
// Mecha machine `machine`, emitted as the handler named for the actor.
#CortexActor: {
	machine: =~"^[a-z][a-z0-9_]{0,30}$"
	handler: =~"^[a-z0-9_/-]+\\.js$"
	// Leased: the fold holds a lease row on the terminal's clock. Attached
	// (`sync`): the fold opens the instance the invoke's `input.instance`
	// names from the route, and leaving detaches. Local: played in the
	// terminal on the machine's own reducer.
	via: "session" | "sync" | "local"
}
