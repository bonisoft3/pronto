// A check the build seat runs beside the stack. Its rule names the closure of
// the target that carries it, under the runtime's own project: under one of
// its own, the closure would bring up a second runtime beside the first. Only a
// browser check brings the browser base, and a `$` in a command reaches the
// container's shell rather than compose's interpolation.
package emit

import pronto "github.com/bonisoft3/pronto"

_besideBuild: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out & {
	checks: plain: {priority: 2, cmds: ["deno run tests/plain.ts $HOME"], note: "plain"}
	checks: painted: {browser: true, srcs: ["fixtures/**"], cmds: ["deno run tests/painted.ts ."], note: "painted"}
}
_besideTargets: _besideBuild.project.targets
_besideRules: (pronto.#emit & {
	code:     _code
	cluster:  _cluster
	terminal: _terminal
	loop:     _loop
	build:    _besideBuild
}).files[".say.yaml"].data.say.integrate.rulemap

besideRule: _besideRules.plain.cmds[0].do & "mise exec -- docker compose -p (^mise exec -- printenv COMPOSE_PROJECT_NAME | complete | get stdout | str trim | str replace -r '^$' 'emit') --profile '*' -f .bayt/compose.check-plain.closure.yaml up bayt --abort-on-container-failure --exit-code-from bayt --build --remove-orphans --attach-dependencies"
besidePriority:  _besideRules.plain.priority & 2
besideWaits:     _besideTargets["check-plain"].compose.depends_on["apps_emit-launch"].condition & "service_healthy"
besideDoor:      _besideTargets["check-plain"].compose.environment.APP_URL & "https://caddy:8443"
besideEscaped:   _besideTargets["check-plain"].compose.command & ["mise", "x", "--", "sh", "-c", "deno run tests/plain.ts $$HOME"]
besidePlainBase: _besideTargets["check-plain"].dockerfile.from.ref & ":setup"
besideBrowser:   _besideTargets["check-painted"].dockerfile.from.ref & ":browser"
besideSources:   _besideTargets["check-painted"].srcs.globs & ["tests/**", "fixtures/**"]
besideNoBrowser: ((pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out.project.targets.browser == _|_) & true
// The tests import omnishell and mecha by relative path, which resolve in the
// image only where the trees sit beside the app as they do in the monorepo.
for check in ["check-plain", "check-painted"] {
	besideTrees: (check): _besideTargets[check].dockerfile.copy[0] & {from: name: "root", srcs: ["plugins/omnishell", "libraries/mecha"], dst: "/monorepo/", parents: true}
}
// A check reaches the database only when it asks to: the URL carries the
// superuser's credentials.
besideNoDatabase: (_besideTargets["check-plain"].compose.environment.DATABASE_URL == _|_) & true
