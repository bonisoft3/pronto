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
_externalBuild: (pronto.#DefaultBuild & {code: _code, loop: _external}).out.project
externalDirectory:   _externalBuild.dir & "."
externalProjectName: (_externalBuild.name == _code.meta.name) & true
localProjectName: ((pronto.#DefaultBuild & {code: _code, loop: _loop}).out.project.name == "apps_\(_code.meta.name)") & true
externalVisualContext: _externalBuild.targets.integrate.compose.build.additional_contexts.root & ".."
externalModuleSources: _externalBuild.targets.build.srcs.defaultGlobs["pronto-module"].glob & "cue.mod/**"
externalConfigSources: _externalBuild.targets.build.srcs.defaultGlobs["pronto-config"].glob & "pronto/**"
externalSaytSources:   _externalBuild.targets.build.srcs.defaultGlobs["pronto-sayt"].glob & ".say.yaml"
