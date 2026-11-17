// builder-inputs.test.ts asks cue for #DefaultBuild with and without its
// terminal. Seated from optional.cue's _code as definitions so file-mode
// `cue export` need not evaluate installed.cue or distribution.cue.
package emit

import pronto "github.com/bonisoft3/pronto"

_builderTerm: (pronto.#DefaultTerminal & {code: _code}).out & {surface: _installedSurface}
_builderCluster: (pronto.#DefaultCluster & {code: _code, statics: _builderTerm.surface.statics}).out
_builderLoop: (pronto.#DefaultLoop & {code: _code, terminal: (pronto.#DefaultTerminal & {code: _code}).out, cluster: (pronto.#DefaultCluster & {code: _code, statics: []}).out}).out

#installedBuild: {
	seats!: {...}
	out: (pronto.#DefaultBuild & {code: _code, loop: _builderLoop, cluster: _builderCluster} & seats).out
}

#installedWithTerminal: #installedBuild & {seats: {terminal: _builderTerm}}

#installedAuthored: (pronto.#DefaultBuild & {
	code: _code & {surface: screens: board: files: {html: "screens/board.html", css: "styles/board.css"}}
	loop: _builderLoop
	cluster: _builderCluster
	terminal: _builderTerm
}).out
