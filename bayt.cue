// plugins/pronto/bayt.cue — source-only bayt project for the pronto compiler.
//
// pronto ships no runtime image. It is a set of deno programs an app's verbs
// invoke from the app's own directory, so what this project exists to give is
// `plugins_pronto:setup:srcs` — the way a cross-project consumer pulls the
// compiler into a build context — and a build stage whose RUN is a typecheck
// of the programs themselves, against the context that consumer receives.
// Mirrors how omnishell exposes `plugins_omnishell:build:srcs`.
package pronto

import (
	bayt "github.com/bonisoft3/bayt/core:bayt"
	mise "github.com/bonisoft3/bayt/stacks/mise"
	sayt "github.com/bonisoft3/bayt/stacks/sayt"
)

_pronto: bayt.#project & {
	dir:      "plugins/pronto"
	activate: "mise x --"

	targets: {
		// Public so a project that emits an app can COPY the compiler beside
		// it. deno.lock is a source here: the programs resolve their imports
		// against it, and a context without it resolves something else.
		"setup": sayt.setup & mise.install & {
			visibility: "public"
			srcs: globs: ["*.ts", "scales/*.ts", "deno.json", "deno.lock"]
			dockerfile: bayt.nubox
		}
		"doctor": sayt.doctor & mise.doctor

		// Typecheck-only build, no emitted artifact: every consumer runs these
		// .ts files directly under deno, so the typecheck is what building
		// them means. `sh -c` because the glob is the shell's to expand, and
		// `mise.exec` wraps a single argv.
		"build": sayt.build & mise.exec & {
			srcs: globs: ["*.ts", "scales/*.ts", "deno.json", "deno.lock"]
			cmd: "builtin": {
				shell: "sh"
				do:    "sh -c 'deno check --config deno.json *.ts'"
			}
			dockerfile: from: ref: ":setup"
		}
	}
}

project: _pronto
