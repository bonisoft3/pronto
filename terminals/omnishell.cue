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

#Generate: "if ('program.cue' | path exists) { use tools.nu [run-mise]; run-mise exec -- omnishell mode . | save --force program_terminal.cue }"

// The image of omnishell's runtime tree an installed app's images copy from,
// as pronto pins it: the consumer pins what it builds on, as with mecha's
// images (clusters/mecha.cue). From the pin line an omnishell release prints.
published: runtime: =~"^bonitao/omnishell:[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?@sha256:[0-9a-f]{64}$"
published: runtime: "bonitao/omnishell:0.5.0@sha256:63d6d0cd5aefe274828e096301423de0adf9d1411ff151bfc1201e6c2ec178d1"

// The build context an image of an installed app copies omnishell's runtime
// tree from: that image, or in the monorepo the target building it.
#RuntimeImage: "plugins_omnishell-runtime-image"

// Re-exported beside #Terminal because the emitter reads it directly: CUE has
// no Intl, so the entry document's direction is resolved from the app's default
// tag against this list.
#RtlLanguages: impl.#RtlLanguages

// Re-exported because the cluster runs it: a route rendered on request is
// served by this target, which the emitter adds where a route asks for one.
#Render: impl.#Render

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
