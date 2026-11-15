// A route rendered on request (#Screen.ssr): served by the terminal's
// renderer behind the door, and refused where its document could only be
// somebody's. #readCase's program, whose Note is private.
package emit

import pronto "github.com/bonisoft3/pronto"

#ssrCase: S={
	reads: [...pronto.#Read]
	child: *false | bool
	route: *"/jogo/:id" | string
	// Signed out but known: the renderer mints its guest from the auth plane.
	_app: (#readCase & {"reads": reads, "route": route}).app & {surface: screens: jogo: {ssr: "ssr", files: {handlers: [], adapters: []}}} & {capabilities: auth: {required: false, service: "/auth"}}
	if child {
		_app: surface: screens: editor: {title: "Editor", route: S.route + "/edit", ssr: "spa", access: "private", reads: [], writes: [], charts: [], forms: [], states: [], files: {handlers: [], adapters: []}}
	}
	_terminal: (pronto.#DefaultTerminal & {code: _app}).out
	_cluster: (pronto.#DefaultCluster & {code: _app, statics: _terminal.surface.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _app, terminal: _terminal, cluster: _cluster}).out
	_build: (pronto.#DefaultBuild & {code: _app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
	_files:    (pronto.#emit & {code: _app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}).files
	caddyfile: _files["docker/Caddyfile"].text
	brief:     _files["brief.html"].text
	render:    _cluster.surface.targets.render
	statics:   _cluster.meta.statics
}

#ssrView: #ssrCase & {reads: [_view]}
// The services beside the door a host launch runs: those the program names (a plugin's,
// code.meta.hostPeers); the renderer is a peer of the door's own variable, not listed here;
// an app whose plugin states the list itself, as one did before, keeps it.
#peersCase: {
	peers: [string]: int
	ssr: *true | bool
	stated: *null | [...string]
	_base: (#readCase & {reads: []}).app & {surface: screens: jogo: files: {handlers: [], adapters: []}}
	_ssr: #ssrCase & {reads: []}
	_app: [if ssr {_ssr._app}, _base][0] & {meta: hostPeers: peers}
	_statics: [if ssr {(pronto.#DefaultTerminal & {code: _app}).out.surface.statics}, []][0]
	_cluster: (pronto.#DefaultCluster & {code: _app, statics: _statics}).out & {if stated != null {meta: hostPeers: stated}}
	hostPeers: _cluster.meta.hostPeers
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
	_build: (pronto.#DefaultBuild & {code: _app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
	_emit: pronto.#emit & {code: _app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}
	_files: _emit.files
	pagesRedirects: _emit.pagesRedirects
	caddyfile: _files["docker/Caddyfile"].text
	entry: _terminal.surface.entry
	routes: {
		release: _files["shell/shell.json"].data.routes
		development: _files[".pronto/development/shell.json"].data.routes
	}

	document:  _files["documents/regras/index.html"]
	sitemap:   _files["sitemap.xml"].text
	robots:    _files["robots.txt"].text
	door:      ["sh", "-c", _cluster.surface.targets.caddy.entrypoint.dockerfile.do]
	// Installed, the terminal's statics are omnishell's image's, not the
	// cluster's (builders/bayt.cue).
	installedDoor: ["sh", "-c", (pronto.#DefaultCluster & {code: _app, statics: (_terminal & {surface: _installedSurface}).surface.statics}).out.surface.targets.caddy.entrypoint.dockerfile.do]
	doorEnv:   _cluster.surface.targets.caddy.compose.environment
	origin:    _cluster.surface.origin
}

// Screen-level access ("public" | "private") and its derived rendering
// strategy (#Screen.ssr) and sitemap visibility (#emit._crawlable).
#accessCase: {
	reads: [...pronto.#Read]
	extra?: {...}
	// An app behind a sign-in, where a public screen is one open to visitors.
	signIn: *false | bool
	_base: (#readCase & {
		"reads": reads
		route:   "/jogos"
		goal: {table: "goal", durability: "live", access: {scope: "public"}}
	}).app & {
		capabilities: auth: {required: signIn, service: "/auth"}
		surface: screens: jogo: {files: {handlers: [], adapters: []}, [if extra != _|_ {extra}, {}][0]}
	}
	_terminal: (pronto.#DefaultTerminal & {code: _base}).out
	_cluster: (pronto.#DefaultCluster & {code: _base, statics: _terminal.surface.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _base, terminal: _terminal, cluster: _cluster}).out
	_build: (pronto.#DefaultBuild & {code: _base, loop: _loop, cluster: _cluster, terminal: _terminal}).out
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
