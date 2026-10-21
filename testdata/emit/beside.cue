// A check the build seat runs beside the stack. Its rule runs the check's bkid
// runner, whose inner stack is the closure of the target that carries it under
// a project of its own, so a check never touches the stack a person launched.
// Only a browser check brings the browser base, and a `$` in a command reaches
// the container's shell rather than compose's interpolation.
package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
)

_besideBuild: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster, terminal: _terminal}).out & {
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

besideRule: _besideRules["pronto-integrate-2"].cmds[0].do & "use integrate.nu; integrate --bake --no-up --with-buildx --target ci-plain"
besideRunner: _besideTargets["ci-plain"] & {#closure: "check-plain", #check: "plain"}
besidePriority: _besideRules["pronto-integrate-2"].priority & 2
besideWaits:    _besideTargets["check-plain"].compose.depends_on["\(_code.meta.name)-launch"].condition & "service_healthy"
besideDoor:     _besideTargets["check-plain"].compose.environment.APP_URL & "https://caddy:8443"
besideEscaped: _besideTargets["check-plain"].compose.command & ["mise", "x", "--", "sh", "-c", "deno run tests/plain.ts $$HOME"]
besidePlainBase: _besideTargets["check-plain"].dockerfile.from.ref & ":setup"
besideBrowser:   _besideTargets["check-painted"].dockerfile.from.ref & ":browser"
besideSources: _besideTargets["check-painted"].srcs.globs & ["tests/**", "fixtures/**"]
besideNoBrowser: ((pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster, terminal: _terminal}).out.project.targets.browser == _|_) & true
// The tests import omnishell from /omnishell, its runtime image, whichever
// repository the app is built in; the browser base installs the toolchain as
// setup does, so it carries the runtime's tree in the monorepo too.
for check in ["check-plain", "check-painted"] {
	besideImportRoot: (check): _besideTargets[check].dockerfile.copy & [{from: name: "plugins_omnishell-runtime-image", srcs: ["/"], dst: "/omnishell"}]
}
besideBrowserToolchain: list.Contains(_besideTargets.browser.dockerfile.epilogue, "COPY --from=workspaceroot-pronto-sources_srcs /monorep[o] /monorepo/") & true

// A check reaches the database only when it asks to: the URL carries the
// superuser's credentials.
besideNoDatabase: (_besideTargets["check-plain"].compose.environment.DATABASE_URL == _|_) & true
