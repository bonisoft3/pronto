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

// The image of omnishell's runtime tree an app's images copy from,
// as pronto pins it: the consumer pins what it builds on, as with mecha's
// images (clusters/mecha.cue). From the pin line an omnishell release prints.
published: runtime: #RuntimePin

// A pin of omnishell's runtime image: upstream's, or the forks' prerelease
// (bsoneca/pronto forks/README.md), which an app on the fork's omnishell names
// as its build's omnishellRuntime (builders/bayt.cue).
#RuntimePin: =~"^(bonitao/omnishell|ghcr\\.io/bsoneca/omnishell):[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?@sha256:[0-9a-f]{64}$"
published: runtime: "bonitao/omnishell:0.21.7@sha256:300583571c8a5434d59c7ada9a3b5c2f6319d5768b3950a9f06504d96237d1a8"

// The build context an app's images copy omnishell's runtime tree from: that
// image, or in the monorepo the target building it.
#RuntimeImage: "plugins_omnishell-runtime-image"

// Re-exported beside #Terminal because the emitter reads it directly: CUE has
// no Intl, so the entry document's direction is resolved from the app's default
// tag against this list.
#RtlLanguages: impl.#RtlLanguages

// Re-exported because the cluster runs it: a route rendered on request is
// served by this target, which the emitter adds where a route asks for one.
#Render: impl.#Render
#Address: impl.#Address

#BkidCheck: impl.#BkidCheck

// Re-exported because pronto's every op is one of these: the one mutation
// grammar is defined where the author-facing chart lives, and a form's
// action, a write and mecha's relational effect each narrow it.
#MutationOp: impl.#Machine.#MutationOp

#Terminal: impl.#Terminal & {
	surface: {
		// Where mise puts omnishell, its release or a checkout's tree.
		runtime: ""
		verbs: omnishell: {
			verb: "generate"
			cmds: [#Generate]
			note: "terminal assets and source layout"
		}
	}
}
