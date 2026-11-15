// What a crawler is told about the addresses an app answers: the entry's
// head spoken for each route only the terminal draws (#emit._spaDocument), over
// a program whose home is such a route in three locales beside a prerendered
// page and a route rendered on request.
package emit

import pronto "github.com/bonisoft3/pronto"

#indexingCase: {
	_app: (#readCase & {reads: []}).app & {
		meta: i18n: {
			default: "en"
			locales: {"en": path: "en", "pt-BR": path: "pt-br", "es": path: "es"}
			catalogues: {
				"messages/en.json": {}
				"messages/pt-BR.json": {}
				"messages/es.json": {}
			}
		}
		surface: screens: {
			jogo: files: {handlers: [], adapters: []}
			play: {
				title:  "Bonk & \"Chess\""
				route:  "/"
				reads:  []
				writes: []
				charts: []
				forms:  []
				states: []
				ssr:    "spa"
				files: {handlers: [], adapters: []}
			}
			regras: {
				title:     "Regras"
				route:     "/regras"
				reads:     []
				writes:    []
				charts:    []
				forms:     []
				states:    []
				prerender: true
				files: {handlers: [], adapters: []}
			}
		}
	}
	_terminal: (pronto.#DefaultTerminal & {code: _app}).out
	_cluster: (pronto.#DefaultCluster & {code: _app, statics: _terminal.surface.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _app, terminal: _terminal, cluster: _cluster}).out
	_build: (pronto.#DefaultBuild & {code: _app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
	_files: (pronto.#emit & {code: _app, cluster: _cluster, terminal: _terminal, loop: _loop, build: _build}).files
	out: {
		caddyfile: _files["docker/Caddyfile"].text
		entry:     _files[_terminal.surface.entry].text
		sitemap:   _files["sitemap.xml"].text
		robots:    _files["robots.txt"].text
	}
}
