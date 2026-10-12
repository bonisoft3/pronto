package emit

import (
	"strings"
	"list"
	pronto "github.com/bonisoft3/pronto"
	dist "github.com/bonisoft3/pronto/distribution"
	terminalProject "github.com/bonisoft3/pronto/terminals:omnishell"
)

_terminal: (pronto.#DefaultTerminal & {code: _code}).out
_cluster: (pronto.#DefaultCluster & {code: _code, statics: []}).out
_loop: (pronto.#DefaultLoop & {code: _code, terminal: _terminal, cluster: _cluster}).out
_external: _loop & {surface: sources: pronto: ""}

compilerChecks: [for name in ["derive", "types", "facts"] {_loop.surface.checks[name].verb & "lint"}]
factsPriority:    _external.surface.sayYaml.say.lint.rulemap.facts.priority & 1
localCompiler:    strings.Contains(_loop.surface.checks.types.cmds[0], "../../plugins/pronto") & true
externalCompiler: strings.Contains(_external.surface.checks.types.cmds[0], "../../plugins") & false
externalBuild:    _external.surface.sayYaml.say.build.do & "null"
_project:         dist.#Project
sourceTerminalCommand: (dist.#Project & terminalProject.#Project & {omnishell: "../../plugins/omnishell"}).say.say.generate.rulemap.omnishell.cmds[0].do & terminalProject.#LocalGenerate
installedTerminalCommand: (dist.#Project & terminalProject.#Project).say.say.generate.rulemap.omnishell.cmds[0].do & terminalProject.#Generate
sourcePin:                _project.mise.tools."github:bonisoft3/pronto" & dist.#Version
bootstrapHasNoTerminal:   strings.Contains(_project.write, "omnishell") & false
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
externalTreeExcludes: [for _, e in _externalBuild.targets.generate.srcs.defaultExclude if e != null {e.glob}] & [".bayt/**", "tests/**", ".task/**", "**/node_modules/**"]
// Installed apps verify releases as the monorepo's do: off, globally and per
// backend, since mise reads attestations from a rate-limited GitHub API.
_settings: _project.mise.settings
attestationsOff: [_settings.github_attestations, _settings.slsa, _settings.github.slsa, _settings.github.github_attestations, _settings.aqua.github_attestations, _settings.aqua.cosign, _settings.aqua.slsa, _settings.aqua.minisign] & [false, false, false, false, false, false, false, false]

localBuild:                 _loop.surface.sayYaml.say.build.do & externalBuild
externalLeafShell:          _externalBuild.targets.build.cmd.builtin.shell & "nu"
externalLeafIsWriter:       strings.Contains(_externalBuild.targets.generate.cmd.builtin.dockerfile.do, "write.ts") & true
externalLeafIsNotRecursive: strings.Contains(_externalBuild.targets.build.cmd.builtin.do, "saytw") & false

externalLintGate:                    strings.Contains(_externalBuild.files["say.yaml"].say.lint.rulemap.builtin.cmds[0].do, "bayt-task lint --generate") & true
externalTestGate:                    strings.Contains(_externalBuild.files["say.yaml"].say.test.rulemap.builtin.cmds[0].do, "bayt-task test --generate") & true
externalChecksKeepProto:             strings.Contains(_externalBuild.files["checks.yaml"].say.lint.rulemap.proto.cmds[0].do, "check-proto.ts") & true
externalLintReadsHistory:            _externalBuild.targets.lint.taskfile.incremental & false
externalTestIncludesFixtures:        (_externalBuild.targets.test.srcs.defaultExclude["pronto-tests"] == null) & true
externalTestIncludesFacts:           list.Contains(_externalBuild.targets.test.srcs.globs, ".pronto/facts.json") & true
externalTestLeafDoesNotReenterGate:  strings.Contains(_externalBuild.targets.test.cmd.builtin.do, "task-leaf test") & true
externalTestCachesPinnedRuntime:     _externalBuild.targets.test.taskfile.incremental & true
externalChecksCopyGeneratedConfig:   (_externalBuild.targets.lint.srcs.defaultExclude["pronto-bayt"] == null) & true
externalImageLintKeepsCompilerCheck: _externalBuild.targets.lint.cmd.builtin.dockerfile.do & "cue vet ./..."
externalImageTestKeepsCompilerCheck: _externalBuild.targets.test.cmd.builtin.dockerfile.do & "cue vet -c ./..."

externalLaunchAction: _externalBuild.files["say.yaml"].say.launch.rulemap.builtin.cmds & [{use: "./bayt-task.nu", do: "bayt-task launch-action --generate"}]
externalIntegrateAction: _externalBuild.files["say.yaml"].say.integrate.rulemap.builtin.cmds & [{use: "./bayt-task.nu", do: "bayt-task integrate-action --generate"}]
externalLaunchAlwaysRuns:     _externalBuild.targets["launch-action"].taskfile.incremental & false
externalIntegrateAlwaysRuns:  _externalBuild.targets["integrate-action"].taskfile.incremental & false
externalVisualRunsTask:       _externalBuild.targets["ci-visual"].dockerfile.incremental & true
externalVisualKeepsInjection: len(_externalBuild.targets["ci-visual"].cmd.builtin.dockerfile.inject.secrets) > 0 & true

externalGenerateOwnsCompiler: strings.Contains(_externalBuild.targets.generate.cmd.builtin.do, "task-leaf generate") & true
externalBuildDependsOnGenerate: _externalBuild.targets.build.deps & [":generate"]
externalLintDependsOnGenerate: _externalBuild.targets.lint.deps & [":generate"]
externalBuildRunsConsumerRules: strings.Contains(_externalBuild.targets.build.cmd.builtin.do, "task-leaf build") & true
