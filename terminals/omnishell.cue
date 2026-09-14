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
	"path"
	"encoding/json"
	impl "github.com/bonisoft3/omnishell:terminal"
	toolchain "github.com/bonisoft3/omnishell/toolchain"
	dist "github.com/bonisoft3/pronto/distribution"
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

#Terminal: impl.#Terminal & {
	surface: {
		runtime: string
		verbs: omnishell: {
			verb: "generate"
			cmds: [if runtime == "" {#Generate}, if runtime != "" {_localGenerate}]
			note: "terminal assets and source layout"
		}
		checks: fuel: {
			verb: "test"
			cmds: [(dist.#Run & {
				runtime: _prontoRuntime
				args:    "let cage = \(_cage); with-env {PRONTO_CAGE_MODULE: $cage} { run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-env ($pronto | path join battery.ts) --self-test }"
			}).out]
			note: "fuel metering against the terminal's compartment"
		}
		_prontoRuntime: [if runtime != "" {path.Join([runtime, "../../pronto"])}, ""][0]
		_cage: [if runtime != "" {"(" + json.Marshal(path.Join([runtime, "../interpreter/jessie.js"])) + " | path expand)"}, "(run-mise exec -- omnishell where cage | str trim)"][0]
		_localGenerate: "if $nu.os-info.name == 'windows' { ^pwsh -NoProfile -File \(runtime)/omnishell.ps1 mode . --local } else { ^\(runtime)/omnishell mode . --local } | save --force program_terminal.cue"
	}
}
