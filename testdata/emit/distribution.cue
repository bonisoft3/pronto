package emit

import (
	"strings"
	pronto "github.com/bonisoft3/pronto"
	dist "github.com/bonisoft3/pronto/distribution"
)

_terminal: (pronto.#DefaultTerminal & {code: _code}).out
_cluster: (pronto.#DefaultCluster & {code: _code, statics: []}).out
_loop: (pronto.#DefaultLoop & {code: _code, terminal: _terminal, cluster: _cluster}).out
_external: _loop & {surface: sources: pronto: ""}

compilerChecks: [for name in ["derive", "types", "facts"] {_loop.surface.checks[name].verb & "lint"}]
factsPriority:          _external.surface.sayYaml.say.lint.rulemap.facts.priority & 1
localCompiler:          strings.Contains(_loop.surface.checks.types.cmds[0], "../../plugins/pronto") & true
externalCompiler:       strings.Contains(_external.surface.checks.types.cmds[0], "../../plugins") & false
externalBuild:          _external.surface.sayYaml.say.build.do & dist.#Project.write
_project:               dist.#Project
sourcePin:              _project.mise.tools."github:bonisoft3/pronto" & dist.#Version
bootstrapHasNoTerminal: strings.Contains(_project.write, "omnishell") & false
_externalBuild: (pronto.#DefaultBuild & {code: _code, loop: _external, cluster: _cluster, terminal: _terminal}).out.project
externalDirectory:   _externalBuild.dir & "."
externalProjectName: (_externalBuild.name == _code.meta.name) & true
localProjectName: ((pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out.project.name == "apps_\(_code.meta.name)") & true
externalVisualContext: (_externalBuild.targets.integrate.compose.build.additional_contexts.root == _|_) & true
// The app's whole tree is the build's input: a list of named files missed the
// subpackages, embeds and derived sources apps add, and the image refused the
// program. The module, config, .say.yaml and held seed rows all ride in on it,
// so what it excludes is pinned: an exclude that took one of them would refuse
// the program the same way.
externalTreeExcludes: [for _, e in _externalBuild.targets.build.srcs.defaultExclude if e != null {e.glob}] & [".bayt/**", "tests/**", ".task/**", "**/node_modules/**"]
// Installed apps verify releases as the monorepo's do: off, globally and per
// backend, since mise reads attestations from a rate-limited GitHub API.
_settings: _project.mise.settings
attestationsOff: [_settings.github_attestations, _settings.slsa, _settings.github.slsa, _settings.github.github_attestations, _settings.aqua.github_attestations, _settings.aqua.cosign, _settings.aqua.slsa, _settings.aqua.minisign] & [false, false, false, false, false, false, false, false]
