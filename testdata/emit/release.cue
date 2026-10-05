package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
)

#releaseCase: R={
	terminal: _
	statics: *[] | [...{file: string, target: string}]
	_cluster: (pronto.#DefaultCluster & {code: _releaseCode, statics: R.statics}).out
	_loop: (pronto.#DefaultLoop & {code: _releaseCode, terminal: R.terminal, cluster: _cluster}).out
	release: (pronto.#emit & {
		code:     _releaseCode
		cluster:  _cluster
		terminal: R.terminal
		loop:     _loop
		build: (pronto.#DefaultBuild & {code: _releaseCode, loop: _loop, cluster: _cluster}).out
	}).release
}

_releaseCode: _code & {capabilities: auth: {required: false, service: "/auth"}}
_liveTerminal: (pronto.#DefaultTerminal & {code: _releaseCode, liveUpdates: true}).out
_liveRelease: (#releaseCase & {terminal: _liveTerminal}).release
releaseEnabled: _liveRelease.enabled & true
releaseEntry: list.Contains(_liveRelease.assets, {path: "shell/index.html", src: "shell/index.html"}) & true
releaseBoot: list.Contains(_liveRelease.assets, {path: "shell/boot.js", src: "shell/boot.js"}) & true
releaseRuntimeLocal: [for a in _liveRelease.runtimeAssets if a.path == "omnishell/interpreter/shell.js" {a}] & [{
	path: "omnishell/interpreter/shell.js"
	src:  "../../plugins/omnishell/interpreter/shell.js"
}]
_installedRelease: (#releaseCase & {terminal: _liveTerminal & {surface: _installedSurface}}).release
releaseRuntimeInstalled: [for a in _installedRelease.runtimeAssets if a.path == "omnishell/interpreter/shell.js" {a}] & [{
	path: "omnishell/interpreter/shell.js"
	src:  "interpreter/shell.js"
}]

_aliasedRelease: (#releaseCase & {terminal: _liveTerminal, statics: [
	{file: "branding/favicon.ico", target: "/srv/shell/favicon.ico"},
	{file: "branding/app.webmanifest", target: "/srv/shell/manifest.webmanifest"},
	{file: "branding/font.woff2", target: "/srv/shell/shared/font.woff2"},
	{file: "private.txt", target: "/srv/private.txt"},
]}).release
releaseAliasedIcon: [for a in _aliasedRelease.assets if a.path == "shell/favicon.ico" {a}] & [{path: "shell/favicon.ico", src: "branding/favicon.ico"}]
releaseAliasedManifest: [for a in _aliasedRelease.assets if a.path == "shell/manifest.webmanifest" {a}] & [{path: "shell/manifest.webmanifest", src: "branding/app.webmanifest"}]
releaseAliasedFont: [for a in _aliasedRelease.assets if a.path == "shell/shared/font.woff2" {a}] & [{path: "shell/shared/font.woff2", src: "branding/font.woff2"}]
releaseOwnedNamespaces: list.Contains([for a in _aliasedRelease.assets {a.path}], "private.txt") & false

_overriddenRelease: (#releaseCase & {terminal: _liveTerminal, statics: list.Concat([
	_liveTerminal.surface.statics,
	[
		{file: "branding/old-boot.js", target: "/srv/shell/boot.js"},
		{file: "branding/served-boot.js", target: "/srv/shell/boot.js"},
	],
])
}).release
releaseServedOverride: [for a in _overriddenRelease.assets if a.path == "shell/boot.js" {a}] & [{path: "shell/boot.js", src: "branding/served-boot.js"}]
