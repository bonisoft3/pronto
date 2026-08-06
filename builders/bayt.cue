// Pronto's builder roster, by indirection: each file here re-exports one
// build-graph implementation from its product home. Pronto owns the list;
// the implementations own themselves (bayt's lives in bonisoft3/bayt).
// Consumers import github.com/bonisoft3/pronto/builders:<name>.
//
// The build graph reaches bayt the way .say.yaml reaches sayt: the
// program's `build:` seat is authored here as #Build, `cue export` lands
// the resolved value as concrete bayt.json, and the app's bayt.cue is a
// thin stub that embeds that file and unifies it back through
// bayt.#project — bayt's schema stays live at generate time, and stack
// staleness is bounded by one build cycle (the writer re-exports on every
// loop turn). Ownership: bayt.json is the do-not-edit artifact; the stub
// is the human seam — escape-hatch overrides unify there, after the embed.
package bayt

import (
	core "github.com/bonisoft3/bayt/core:bayt"
	sayt "github.com/bonisoft3/bayt/stacks/sayt"
	mise "github.com/bonisoft3/bayt/stacks/mise"
)

// bayt's own project schema, re-exported so a compiler (or anyone) can
// validate a build graph directly by unifying against it.
#Project: core.#project

// The canonical pronto build graph for one app, authored as the program's
// `build:` seat.
#Build: B={
	meta: {
		app:      string
		buildCmd: string
		testCmd:  string
	}

	project: core.#project & {
		dir: "apps/\(B.meta.app)"
		targets: {
			"setup": sayt.setup & {
				dockerfile: from: ref: "workspaceroot:setup"
			}
			"lint": sayt.lint & mise.exec & {
				srcs: globs: ["brief.html", "ir.html", "acceptance.md", "program.cue"]
				cmd: builtin: do: "cue vet ./..."
			}
			"build": sayt.build & mise.exec & {
				srcs: globs: ["program.cue", "shell/**", "pipelines/**"]
				cmd: builtin: do: B.meta.buildCmd
				dockerfile: from: ref: ":setup"
			}
			"test": sayt.test & mise.exec & {
				srcs: globs: ["program.cue"]
				cmd: builtin: do: B.meta.testCmd
			}
			"launch": sayt.launch & {
				dockerfile: from: ref: ":build"
			}
			"integrate": sayt.integrate & {
				dockerfile: from: ref: ":build"
			}
		}
	}
}
