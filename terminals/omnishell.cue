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

import impl "github.com/bonisoft3/omnishell:terminal"

#Terminal: impl.#Terminal
