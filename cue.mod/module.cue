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
