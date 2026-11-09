package bootstrap

import (
	"github.com/bonisoft3/pronto/distribution"
	terminal "github.com/bonisoft3/pronto/terminals:omnishell"
	"github.com/bonisoft3/pronto/clusters:mecha"
	"github.com/bonisoft3/pronto/builders:bayt"
)

// The project every bootstrapped app composes (its pronto/ package), and the
// host roster generate writes for it.
#Host: distribution.#Project & terminal.#Project & mecha.#Project & bayt.#Toolchain

roster: (#Roster & {project: #Host}).out
