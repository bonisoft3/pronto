// Pronto's loop roster, by indirection: each file here re-exports one loop
// implementation from its product home. Pronto owns the list; the
// implementations own themselves (sayt's lives in bonisoft3/sayt).
// Consumers import github.com/bonisoft3/pronto/loops:<name>.
//
// The seam pronto relies on: #Loop authors the loop's file surface
// (.say.yaml, tasks.json) from the program; the doctrine — builtins, argv,
// the launch gate, agent-driven verify — rides the contract header in
// plugins/sayt/loop.cue.
package sayt

import (
	impl "github.com/bonisoft3/sayt:loop"
	saycfg "github.com/bonisoft3/sayt:say"
)

#Loop: impl.#Loop

// sayt's own .say.yaml/.say.cue/.say.json schema, re-exported so a compiler
// (or anyone) can validate a say file directly by unifying against it.
#Say: saycfg.say
