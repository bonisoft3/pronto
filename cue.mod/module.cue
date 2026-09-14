// Mirror-only module declaration. Copybara stages this file from
// plugins/pronto/.mirror/cue.mod/ to the bonisoft3/pronto root as
// cue.mod/module.cue. The monorepo itself has no cue.mod here —
// in-monorepo CUE imports resolve against the root cue.mod
// (bonisoft.org). Copybara rewrites import paths from
// github.com/bonisoft3/pronto → github.com/bonisoft3/pronto during
// sync, and the sibling modules pronto's adapters import along with
// them, so the mirror is a self-contained CUE module.
module: "github.com/bonisoft3/pronto@v0"

language: {
	version: "v0.16.1"
}

source: {
	kind: "git"
}

// The adapters import one sibling each — terminals/omnishell.cue, clusters/
// mecha.cue, loops/sayt.cue — and emit.cue imports bayt's build vocabulary.
// The mirror resolves all four from the Central Registry. `cue mod publish`
// refuses an untidy module, and `cue mod tidy` writes this block by fetching
// the registry — a write the publish would then refuse as an unclean tree.
// Stating it here keeps the mirror publishable from a pure copy, and the
// `cue mod tidy --check` the mirror's cd.yml runs before publishing is what
// fails when one of these versions falls behind.
deps: {
	"github.com/bonisoft3/bayt@v0": {
		v:       "v0.52.1"
		default: true
	}
	"github.com/bonisoft3/mecha@v0": {
		v:       "v0.1.3"
		default: true
	}
	"github.com/bonisoft3/omnishell@v0": {
		v:       "v0.2.2"
		default: true
	}
	"github.com/bonisoft3/sayt@v0": {
		v:       "v0.39.1"
		default: true
	}
}
