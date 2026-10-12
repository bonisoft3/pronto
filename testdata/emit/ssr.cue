// A route rendered on request (#Screen.ssr): served by the terminal's
// renderer behind the door, and refused where its document could only be
// somebody's. #syncCase's program, whose Note is private.
package emit

import pronto "github.com/bonisoft3/pronto"

#ssrCase: {
	reads: [...pronto.#Read]
	route: *"/jogo/:id" | string
	// Signed out but known: the renderer mints its guest from the auth plane.
	_app: (#syncCase & {"reads": reads, "route": route}).app & {surface: screens: jogo: {ssr: "ssr", files: {handlers: [], adapters: []}}} & {capabilities: auth: {required: false, service: "/auth"}}
	_terminal: (pronto.#DefaultTerminal & {code: _app}).out
	_cluster: (pronto.#DefaultCluster & {code: _app, statics: _terminal.surface.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _app, terminal: _terminal, cluster: _cluster}).out
	_build: (pronto.#DefaultBuild & {code: _app, loop: _loop, cluster: _cluster}).out
	caddyfile: (pronto.#emit & {code: _app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}).files["docker/Caddyfile"].text
	render:  _cluster.surface.targets.render
	statics: _cluster.meta.statics
}

// A route rendered before any request (#Screen.prerender): a document per
// address, which the door answers as a template naming the origin, and
// refused over rows the server holds.
#ssgCase: {
	reads: *[] | [...pronto.#Read]
	_app: (#syncCase & {reads: []}).app & {surface: screens: jogo: files: {handlers: [], adapters: []}} & {surface: screens: regras: {
		title:   "Regras"
		route:   "/regras"
		"reads": reads
		writes: []
		forms: []
		states: []
		prerender: true
		files: {handlers: [], adapters: []}
	}}
	_terminal: (pronto.#DefaultTerminal & {code: _app}).out
	_cluster: (pronto.#DefaultCluster & {code: _app, statics: _terminal.surface.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _app, terminal: _terminal, cluster: _cluster}).out
	_build: (pronto.#DefaultBuild & {code: _app, loop: _loop, cluster: _cluster}).out
	_files: (pronto.#emit & {code: _app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}).files
	caddyfile: _files["docker/Caddyfile"].text
	document:  _files["documents/regras/index.html"]
	sitemap:   _files["sitemap.xml"].text
	robots:    _files["robots.txt"].text
	door:      _cluster.surface.targets.caddy.compose.command
	// Installed, the terminal's statics are omnishell's image's, not the
	// cluster's (builders/bayt.cue).
	installedDoor: (pronto.#DefaultCluster & {code: _app, statics: ((pronto.#DefaultTerminal & {code: _app}).out & {surface: _installedSurface}).surface.statics, local: false}).out.surface.targets.caddy.compose.command
	doorEnv:   _cluster.surface.targets.caddy.compose.environment
	origin:    _cluster.surface.origin
}
