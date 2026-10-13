package emit

import (
	pronto "github.com/bonisoft3/pronto"
)

_batchedBuild: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out & {
	checks: {
		first: {priority: 1, cmds: ["check-first"], note: "first"}
		second: {priority: 1, cmds: ["check-second"], note: "second"}
		last: {priority: 2, cmds: ["check-last"], note: "last"}
	}
}
_batchedRules: (pronto.#emit & {code: _code, loop: _loop, cluster: _cluster, terminal: _terminal, build: _batchedBuild}).files[".say.yaml"].data.say.integrate.rulemap

integrationPreservesPriority:  _batchedRules["pronto-integrate-1"].priority & 1
integrationGroupsSamePriority: _batchedRules["pronto-integrate-1"].cmds[0].do & "use integrate.nu; integrate --bake --no-up --with-buildx --target ci-first,ci-second"
integrationKeepsLaterPriority: _batchedRules["pronto-integrate-2"].cmds[0].do & "use integrate.nu; integrate --bake --no-up --with-buildx --target ci-last"
