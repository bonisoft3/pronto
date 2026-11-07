package emit

import (
	"encoding/json"
	pronto "github.com/bonisoft3/pronto"
)

_developmentApp: (#readCase & {reads: [], writes: []}).app & {
	surface: {
		screens: {
			jogo: files: {handlers: *[] | [...string], adapters: *[] | [...string]}
			"another-screen": {title: "Other", route: "/other", reads: [], writes: [], charts: [], forms: [], states: [], files: {handlers: *[] | [...string], adapters: *[] | [...string]}}
		}
		handlers: inspect: {of: "another-screen", src: "shell/handlers/inspect.js", note: "Inspect an existing row"}
	}
}
_developmentConfig: (pronto.#shellConfig & {code: _developmentApp, development: true, migrations: [], floors: {}, hatch: {}, presenter: {policy: "", scripted: [], scripts: {}}, server: true, native: false}).out
_releaseConfig: (pronto.#shellConfig & {code: _developmentApp, migrations: [], floors: {}, hatch: {}, presenter: {policy: "", scripted: [], scripts: {}}, server: true, native: false}).out

// An unused capability must already be available when HTML first binds it.
developmentTables: json.Marshal(_developmentConfig.tables) & json.Marshal(["goal", "note", "player"])
developmentLocal: _developmentConfig.local.draft & "tab"
developmentHandlers: json.Marshal([for r in _developmentConfig.routes if r.screen == "jogo" {r}][0].files.handlers) & json.Marshal(["shell/handlers/inspect.js"])
developmentAccess: _developmentConfig.access.note & {scope: "private", owner: "player_id"}
releaseUnusedTables: json.Marshal(_releaseConfig.tables) & "[]"
releaseUnusedHandlers: json.Marshal([for r in _releaseConfig.routes if r.screen == "jogo" {r}][0].files.handlers) & "[]"

// Registration does not eagerly download unused public collections.
developmentLazy: json.Marshal(_developmentConfig.read) & json.Marshal({goal: "lazy", player: "lazy"})

// Development read modes stay stable when an existing table gains a binding.
developmentReadStability: json.Marshal(_developmentApp.#developmentRead) & json.Marshal((#readCase & {reads: [_view]}).app.#developmentRead)

_moduleApp: _developmentApp & {
	surface: screens: {
		jogo: files: {handlers: ["shell/handlers/zebra.js", "shell/handlers/alpha.js"], adapters: ["shell/handlers/zebra.js", "shell/handlers/wallclock.js"]}
		"another-screen": files: adapters: ["shell/other/wallclock.js", "shell/handlers/shared.js"]
	}
	state: cortex: root: {
		config: {id: "root", meta: host: "omnishell", initial: "idle", states: idle: {}, on: {"route:jogo": "idle", "route:another-screen": "idle", "route:unbound": "idle"}}
		setup: actors: compose: {via: "local", machine: "worker", handler: "machines/compose.js"}
	}
}
_moduleShell: pronto.#shellConfig & {code: _moduleApp, migrations: [], floors: {}, hatch: {}, presenter: {policy: "", scripted: [], scripts: {}}, server: true, native: false, adapters: ["/omnishell/components/wallclock.js", "/omnishell/components/builtin.js"]}
_moduleDev: (_moduleShell & {development: true}).out
_moduleRelease: _moduleShell.out
_moduleRoute: [for r in _moduleDev.routes if r.screen == "jogo" {r}][0]
_releaseRoute: [for r in _moduleRelease.routes if r.screen == "jogo" {r}][0]

// Basename lookup must keep the route's override ahead of a terminal module.
developmentAdapterPrecedence: json.Marshal(_moduleRoute.files.adapters) & json.Marshal(["shell/handlers/zebra.js", "shell/handlers/wallclock.js", "/omnishell/components/builtin.js", "shell/handlers/shared.js"])
developmentComposedHandler: json.Marshal(_moduleRoute.files.handlers) & json.Marshal(["shell/handlers/zebra.js", "shell/handlers/alpha.js", "shell/handlers/compose.js", "shell/handlers/inspect.js"])
releaseModuleOrder: {handlers: json.Marshal(_releaseRoute.files.handlers), adapters: json.Marshal(_releaseRoute.files.adapters)} & {handlers: json.Marshal(_moduleApp.surface.screens.jogo.files.handlers), adapters: json.Marshal(_moduleApp.surface.screens.jogo.files.adapters)}

_ambiguousApp: _moduleApp & {surface: screens: unbound: {title: "Unbound", route: "/unbound", reads: [], writes: [], charts: [], forms: [], states: [], files: {handlers: [], adapters: []}}}
_ambiguousShell: (pronto.#shellConfig & {code: _ambiguousApp, development: true, migrations: [], floors: {}, hatch: {}, presenter: {policy: "", scripted: [], scripts: {}}, server: true, native: false, adapters: ["/omnishell/components/wallclock.js"]}).out
// Another route's conflicting choice cannot silently choose a binding here.
developmentAmbiguousAdapter: json.Marshal([for r in _ambiguousShell.routes if r.screen == "unbound" {r}][0].files.adapters) & json.Marshal(["shell/handlers/shared.js", "shell/handlers/zebra.js"])

// A composed module with no current binding still has a development URL.
developmentComposedStatic: json.Marshal((pronto.#emit & {code: _moduleApp}).development.statics) & json.Marshal([{file: "shell/handlers/compose.js", target: "/srv/shell/handlers/compose.js"}])
