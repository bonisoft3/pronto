package emit

import pronto "github.com/bonisoft3/pronto"

#routeSegmentsCase: {
	_app: (#readCase & {reads: [], route: "/campeonato/:championship/equipe/:team/jogador/:slug"}).app & {
		meta: i18n: {
			default: "pt-BR"
			locales: {"pt-BR": path: "pt-br", "en-US": path: "en"}
			catalogues: {
				"messages/pt-BR.json": {route_championship: "campeonato", route_team: "equipe", route_player: "jogador"}
				"messages/en-US.json": {route_championship: "championship", route_team: "team", route_player: "player"}
			}
		}
		surface: screens: {
			jogo: {slug: "route_championship", segments: {equipe: "route_team", jogador: "route_player"}, files: {handlers: [], adapters: []}}
		}
	}
	_terminal: (pronto.#DefaultTerminal & {code: _app}).out
	_cluster: (pronto.#DefaultCluster & {code: _app, statics: _terminal.surface.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _app, terminal: _terminal, cluster: _cluster}).out
	_build: (pronto.#DefaultBuild & {code: _app, loop: _loop, cluster: _cluster, terminal: _terminal}).out
	out: {
		routes: (pronto.#shellConfig & {code: _app}).out.routes
		caddyfile: (pronto.#emit & {code: _app, terminal: _terminal, cluster: _cluster, loop: _loop, build: _build}).files["docker/Caddyfile"].text
	}
}

routeSegments: #routeSegmentsCase.out
