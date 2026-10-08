// builder-inputs.test.ts asks cue for #DefaultBuild over an installed loop,
// with and without its terminal.
package emit

import pronto "github.com/bonisoft3/pronto"

#installedBuild: {
	seats!: {...}
	out: (pronto.#DefaultBuild & {code: _code, loop: _external, cluster: _installedCluster} & seats).out
}
