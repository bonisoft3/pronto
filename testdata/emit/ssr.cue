// A route rendered on request (#Screen.ssr): served by the terminal's
// renderer behind the door, and refused where its document could only be
// somebody's. #readCase's program, whose Note is private.
package emit

import pronto "github.com/bonisoft3/pronto"

#ssrCase: {
	reads: [...pronto.#Read]
	route: *"/jogo/:id" | string
	// Signed out but known: the renderer mints its guest from the auth plane.
	_app: (#readCase & {"reads": reads, "route": route}).app & {surface: screens: jogo: {ssr: "ssr", files: {handlers: [], adapters: []}}} & {capabilities: auth: {required: false, service: "/auth"}}
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
	_app: (#readCase & {reads: []}).app & {surface: screens: jogo: files: {handlers: [], adapters: []}} & {surface: screens: regras: {
		title:   "Regras"
		route:   "/regras"
		"reads": reads
		writes: []
		charts: []
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
	door:      ["sh", "-c", _cluster.surface.targets.caddy.entrypoint.do]
	// Installed, the terminal's statics are omnishell's image's, not the
	// cluster's (builders/bayt.cue).
	installedDoor: ["sh", "-c", (pronto.#DefaultCluster & {code: _app, statics: ((pronto.#DefaultTerminal & {code: _app}).out & {surface: _installedSurface}).surface.statics, local: false}).out.surface.targets.caddy.entrypoint.do]
	doorEnv:   _cluster.surface.targets.caddy.compose.environment
	origin:    _cluster.surface.origin
}

// Screen-level access ("public" | "private") and its derived rendering
// strategy (#Screen.ssr) and sitemap visibility (#emit._crawlable).
#accessCase: {
	reads: [...pronto.#Read]
	extra?: {...}
	_base: (#readCase & {
		"reads": reads
		route:   "/jogos"
		goal: {table: "goal", durability: "live", access: {scope: "public"}}
	}).app & {
		capabilities: auth: {required: false, service: "/auth"}
		surface: screens: jogo: {files: {handlers: [], adapters: []}, [if extra != _|_ {extra}, {}][0]}
	}
	_terminal: (pronto.#DefaultTerminal & {code: _base}).out
	_cluster: (pronto.#DefaultCluster & {code: _base, statics: _terminal.surface.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _base, terminal: _terminal, cluster: _cluster}).out
	_build: (pronto.#DefaultBuild & {code: _base, loop: _loop, cluster: _cluster}).out
	_files: (pronto.#emit & {code: _base, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}).files
	out: {
		screen: {
			access: _base.surface.screens.jogo.access
			ssr:    _base.surface.screens.jogo.ssr
		}
		shellRoute: (pronto.#shellConfig & {code: _base}).out.routes[0]
		caddyfile:  _files["docker/Caddyfile"].text
		sitemap:    _files["sitemap.xml"].text
	}
}
