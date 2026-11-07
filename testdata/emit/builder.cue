// builder-inputs.test.ts asks cue for #DefaultBuild with and without its
// terminal. Seated from optional.cue's _code as definitions so file-mode
// `cue export` need not evaluate installed.cue or distribution.cue.
package emit

import pronto "github.com/bonisoft3/pronto"

#builderTerm: (pronto.#DefaultTerminal & {code: _code}).out & {surface: _installedSurface}
#builderCluster: (pronto.#DefaultCluster & {code: _code, statics: #builderTerm.surface.statics}).out
#builderLoop: (pronto.#DefaultLoop & {code: _code, terminal: (pronto.#DefaultTerminal & {code: _code}).out, cluster: (pronto.#DefaultCluster & {code: _code, statics: []}).out}).out

#installedBuild: {
	seats!: {...}
	out: (pronto.#DefaultBuild & {code: _code, loop: #builderLoop, cluster: #builderCluster} & seats).out
}

#installedWithTerminal: #installedBuild & {seats: {terminal: #builderTerm}}
