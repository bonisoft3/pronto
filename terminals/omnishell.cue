// Pronto's terminal roster, by indirection: each file here re-exports one
// virtual-terminal implementation from its product home. Pronto owns the
// list; the implementations own themselves (omnishell's lives in
// bonisoft3/omnishell). Consumers import github.com/bonisoft3/pronto/terminals:<name>.
//
// The seam pronto relies on: #Terminal is the entry page and static wiring
// against omnishell's default entrypoints. Screens reach the terminal as
// files — HTML/CSS/Jessie plus shell/shell.yaml, a route → files map the
// shell interprets at runtime; there is no build step.
package omnishell

import (
	impl "github.com/bonisoft3/omnishell:terminal"
	toolchain "github.com/bonisoft3/omnishell/toolchain"
)

#Project: {
	...
	tools: toolchain.#Tools
	say: say: {
		...
		generate: rulemap: {
			...
			omnishell: {priority: 0, cmds: [{do: #Generate}]}
		}
	}
}

#Generate: "if ('program.cue' | path exists) { use tools.nu [run-mise]; run-mise exec -- omnishell materialize .; run-mise exec -- omnishell mode . | save --force program_terminal.cue }"

// Re-exported beside #Terminal because the emitter reads it directly: CUE has
// no Intl, so the entry document's direction is resolved from the app's default
// tag against this list.
#RtlLanguages: impl.#RtlLanguages

#ComposeProject: impl.#ComposeProject
#ClosureUp:      impl.#ClosureUp

#Terminal: impl.#Terminal & {
	surface: {
		runtime: string
		verbs: omnishell: {
			verb: "generate"
			cmds: [if runtime == "" {#Generate}, if runtime != "" {_localGenerate}]
			note: "terminal assets and source layout"
		}
		_localGenerate: "mise run omnishell -- mode . --local | save --force program_terminal.cue"
	}
}
