// A check the build seat runs beside the stack. Its rule runs the check's bkid
// runner, whose inner stack is the closure of the target that carries it under
// a project of its own, so a check never touches the stack a person launched.
// Only a browser check brings the browser base, and a `$` in a command reaches
// the container's shell rather than compose's interpolation.
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

besideRule: _besideRules.plain.cmds[0].do & "use integrate.nu; integrate --bake --no-up --with-buildx --target ci-plain"
besideRunner: _besideTargets["ci-plain"] & {#closure: "check-plain", #check: "plain"}
besidePriority: _besideRules.plain.priority & 2
besideWaits:    _besideTargets["check-plain"].compose.depends_on["apps_emit-launch"].condition & "service_healthy"
besideDoor:     _besideTargets["check-plain"].compose.environment.APP_URL & "https://caddy:8443"
besideEscaped: _besideTargets["check-plain"].compose.command & ["mise", "x", "--", "sh", "-c", "deno run tests/plain.ts $$HOME"]
besidePlainBase: _besideTargets["check-plain"].dockerfile.from.ref & ":setup"
besideBrowser:   _besideTargets["check-painted"].dockerfile.from.ref & ":browser"
besideSources: _besideTargets["check-painted"].srcs.globs & ["tests/**", "fixtures/**"]
besideNoBrowser: ((pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out.project.targets.browser == _|_) & true
// The tests import omnishell and mecha by relative path, which resolve in the
// image only where the trees sit beside the app as they do in the monorepo.
for check in ["check-plain", "check-painted"] {
	besideTrees: (check): _besideTargets[check].dockerfile.copy[0] & {from: name: "root", srcs: ["plugins/omnishell", "libraries/mecha"], dst: "/monorepo/", parents: true}
}

// A check reaches the database only when it asks to: the URL carries the
// superuser's credentials.
besideNoDatabase: (_besideTargets["check-plain"].compose.environment.DATABASE_URL == _|_) & true

sourceCheckRuntimeAlias: _besideBuild.project.targets["check-plain"].dockerfile.epilogue & ["RUN ln -s /monorepo/plugins/omnishell /omnishell"]
