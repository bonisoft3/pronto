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

compilerChecks: [for name in ["derive", "types", "facts"] {_loop.surface.checks[name].verb & "lint"}]
factsPriority:    _loop.surface.sayYaml.say.lint.rulemap.facts.priority & 1
// Every command finds pronto where mise puts it, never by a path into the
// monorepo, which a mirror receiving the same files has no copy of.
compilerFromMise: strings.Contains(_loop.surface.checks.types.cmds[0], "../../plugins") & false
externalBuild:    _loop.surface.sayYaml.say.build.do & "null"
_project:         dist.#Project
clientOnlyEdge: strings.Contains(_project.edge, "else { [] })") & true
nativeSsrEdge: strings.Contains((dist.#Project & {ssrOrigin: "https://example.com"}).edge, "else { [\"--ssr-origin\" \"https://example.com\"] })") & true
// Regression: the release's domain was written into the command, so one tree
// released to one deployment; the verb's --domain names another, and
// meta.domain is the default.
releaseDomain: strings.Contains((dist.#Project & {domain: "app.example"}).edge, "...(if ('SAY_RELEASE_ARGS_DOMAIN' in $env) { ['--domain' $env.SAY_RELEASE_ARGS_DOMAIN] } else { [\"--domain\" \"app.example\"] })") & true
verifyDomain: strings.Contains((dist.#Project & {domain: "app.example"}).verifyEdge, "...(if ('SAY_VERIFY_ARGS_DOMAIN' in $env) { [$'--default-domain=($env.SAY_VERIFY_ARGS_DOMAIN)'] } else { [\"--default-domain=app.example\"] })") & true
// Regression: every Worker, queue and bucket was named after the app, so a
// second deployment of the tree replaced the first; the verb's --name names
// another, and the app's name is the default.
releaseName: strings.Contains((dist.#Project & {workerName: "app"}).edge, "...(if ('SAY_RELEASE_ARGS_NAME' in $env) { ['--name' $env.SAY_RELEASE_ARGS_NAME] } else { [\"--name\" \"app\"] })") & true
verifyName: strings.Contains((dist.#Project & {workerName: "app"}).verifyEdge, "...(if ('SAY_VERIFY_ARGS_NAME' in $env) { [$'--name=($env.SAY_VERIFY_ARGS_NAME)'] } else { [\"--name=app\"] })") & true
terminalCommand:         (dist.#Project & terminalProject.#Project).say.say.generate.rulemap.omnishell.cmds[0].do & terminalProject.#Generate
sourcePin:                _project.mise.tools."github:bonisoft3/pronto" & dist.#Version
bootstrapHasNoTerminal:   strings.Contains(_project.write, "omnishell") & false
_externalBuild: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster, terminal: _terminal}).out.project
externalDirectory:   _externalBuild.dir & "."
externalProjectName: (_externalBuild.name == _code.meta.name) & true
externalVisualContext: (_externalBuild.targets.integrate.compose.build.additional_contexts.root == _|_) & true
// The app's whole tree is the build's input: a list of named files missed the
// subpackages, embeds and derived sources apps add, and the image refused the
// program. The module, config, .say.yaml and held seed rows all ride in on it,
// so what it excludes is pinned: an exclude that took one of them would refuse
// the program the same way.
// mise.local.lock records the checkout's absolute paths, which a container
// does not have.
externalTreeExcludes: [for _, e in _externalBuild.targets.generate.srcs.defaultExclude if e != null {e.glob}] & [".bayt/**", "tests/**", ".task/**", ".pronto/proto-baseline.json", ".pronto/live/**", "**/node_modules/**", "mise.local.lock", ".mise.host.toml", "mise.host.lock"]
// Installed apps verify releases as the monorepo's do: off, globally and per
// backend, since mise reads attestations from a rate-limited GitHub API.
_settings: _project.mise.settings
attestationsOff: [_settings.github_attestations, _settings.slsa, _settings.github.slsa, _settings.github.github_attestations, _settings.aqua.github_attestations, _settings.aqua.cosign, _settings.aqua.slsa, _settings.aqua.minisign] & [false, false, false, false, false, false, false, false]

externalLeafShell:          _externalBuild.targets.build.cmd.builtin.shell & "nu"
externalLeafIsWriter:       strings.Contains(_externalBuild.targets.generate.cmd.builtin.dockerfile.do, "write.ts") & true
externalLeafIsNotRecursive: strings.Contains(_externalBuild.targets.build.cmd.builtin.do, "saytw") & false

externalLintGate:                    strings.Contains(_externalBuild.files["say.yaml"].say.lint.rulemap.builtin.cmds[0].do, "bayt-task lint --generate") & true
externalTestGate:                    strings.Contains(_externalBuild.files["say.yaml"].say.test.rulemap.builtin.cmds[0].do, "bayt-task test --generate") & true
externalChecksKeepProto:             strings.Contains(_externalBuild.files["checks.yaml"].say.lint.rulemap.proto.cmds[0].do, "check-proto.ts") & true
externalLintCaches:                  _externalBuild.targets.lint.taskfile.incremental & true
externalLintReadsHistory:            (_externalBuild.targets.lint.srcs.defaultExclude["pronto-history"] == null) & true
externalLintRefreshesHistory:        _externalBuild.targets["lint-inputs"].taskfile.incremental & false
externalTestIncludesFixtures:        (_externalBuild.targets.test.srcs.defaultExclude["pronto-tests"] == null) & true
externalTestIncludesFacts:           list.Contains(_externalBuild.targets.test.srcs.globs, ".pronto/facts.json") & true
externalTestLeafDoesNotReenterGate:  strings.Contains(_externalBuild.targets.test.cmd.builtin.do, "task-leaf test") & true
// Its checkers are the runtime's, outside the app's source view in the
// monorepo, so a go-task stamp over the app alone would call it fresh.
externalTestRunsEveryTime:           (_externalBuild.targets.test.taskfile.incremental == false) & true
externalChecksCopyGeneratedConfig:   (_externalBuild.targets.lint.srcs.defaultExclude["pronto-bayt"] == null) & true
externalImageLintKeepsCompilerCheck: _externalBuild.targets.lint.cmd.builtin.dockerfile.do & "cue vet -c ./..."
externalImageTestUsesGeneratedInputs: _externalBuild.targets.test.cmd.builtin.dockerfile.do & "deno eval 0"
externalLintChecksConcreteCue: _externalBuild.files["checks.yaml"].say.lint.rulemap.cue.cmds[0].do & "mise exec -- cue vet -c ./..."
externalGenerateKeepsCheckerInputs: list.Contains(_externalBuild.targets.generate.state.globs, ".pronto/check-inputs.json") & true

// build, launch and integrate build omnishell's data-plane bundle in the
// monorepo (the switch set) and refuse a release without it, ahead of their
// builtin: a fresh checkout's integrate@host served a dead terminal and no
// error, and its launch --watch died copying the file.
_omnishellBundle: "use tools.nu [run-mise]; def --wrapped omnishell-bundle [...args] { let omnishell = (if ($env.OMNISHELL_DIR? | default '') != '' { $env.OMNISHELL_DIR } else { (run-mise where github:bonisoft3/omnishell | str trim) }); if (run-mise env --json | from json | get -o MONOREPO_COMPOSE_MODE | default '') != '' { run-mise tool-stub ((run-mise where github:bonisoft3/sayt | str trim) | path join task.toml) -t ($omnishell | path join .bayt Taskfile.yml) bayt:bundle } else if not ($omnishell | path join interpreter vendor mecha-client.js | path exists) { error make {msg: $\"($omnishell) carries no interpreter/vendor/mecha-client.js, the terminal's data-plane bundle an omnishell release ships\"} } }"
_hostVerb: {for verb in ["launch", "integrate"] {(verb): "def --wrapped host-verb [...args] { if (\"--watch\" in $args) or (\"-w\" in $args) { error make {msg: \"Native watch is disabled; use sayt launch --watch for Docker\"} }; with-env { MISE_ENV: 'host' } { ^mise install; bayt-task \(verb) --generate ...$args } }; host-verb"}}
_bundleGate: {priority: -2, cmds: [{do: "\(_omnishellBundle); omnishell-bundle"}]}
_bundleGates: {
	build:     {default: true, platforms: []}
	launch:    {default: true, platforms: ["host", "compose", "cloudflare"]}
	integrate: {default: true, platforms: ["host"]}
	release:   {default: false, platforms: ["pages", "cloudflare"]}
}
// The fixture releases nowhere; this one releases everywhere a release goes,
// and only the two ceremonies that bundle from omnishell's tree are gated.
_releasing: pronto.#App & {
	for k, v in _code if k != "meta" {(k): v}
	meta: {
		for k, v in _code.meta if k != "targets" {(k): v}
		targets: ["pages", "cloudflare", "docker"]
	}
}
_releasingBuild: (pronto.#DefaultBuild & {code: _releasing, loop: _loop, cluster: _cluster, terminal: _terminal}).out.project
// The app's own release and verify name its Worker after the app.
_releasingSay: (pronto.#DefaultLoop & {code: _releasing, terminal: _terminal, cluster: _cluster}).out.surface.sayYaml.say
emittedName: strings.Contains(strings.Join([for c in _releasingSay.release.rulemap.cloudflare.cmds {c.do}], "\n"), "[\"--name\" \"\(_code.meta.name)\"]") & strings.Contains(strings.Join([for c in _releasingSay.verify.rulemap.cloudflare.cmds {c.do}], "\n"), "[\"--name=\(_code.meta.name)\"]") & true
externalVerbsBuildTheBundle: {for verb, g in _bundleGates {(verb): {
	if g.default {default: _externalBuild.files["say.yaml"].say[verb].rulemap["omnishell-bundle"] & _bundleGate}
	for p in g.platforms {(p): _releasingBuild.files["say.yaml"].say[verb].rulemap["omnishell-bundle-\(p)"] & _bundleGate & {platform: p}}
}}}
externalReleaseGatesOnlyItsTargets: (_externalBuild.files["say.yaml"].say.release == _|_) & (_releasingBuild.files["say.yaml"].say.release.rulemap["omnishell-bundle"] == _|_) & (_releasingBuild.files["say.yaml"].say.release.rulemap["omnishell-bundle-docker"] == _|_) & true
// sayt keeps a rule without a platform at the verb's default alone: every
// platform a verb's rules name has its own gate, or that tier serves a dead
// terminal (integrate@host did, with the gate only on the default).
externalBundleReachesEveryPlatform: {for verb, _ in _bundleGates for name, r in _releasingBuild.files["say.yaml"].say[verb].rulemap if r.platform != _|_ {
	"\(verb)/\(name)": _releasingBuild.files["say.yaml"].say[verb].rulemap["omnishell-bundle-\(r.platform)"].platform & r.platform
}}
externalLaunchHostGate: _externalBuild.files["say.yaml"].say.launch.rulemap.host.cmds & [{use: "./bayt-task.nu", do: _hostVerb.launch}]
externalIntegrateAction: _externalBuild.files["say.yaml"].say.integrate.rulemap.builtin.cmds & [{use: "./bayt-task.nu", do: "bayt-task integrate-action --generate"}]
externalIntegrateHostGate: _externalBuild.files["say.yaml"].say.integrate.rulemap.host.cmds & [{use: "./bayt-task.nu", do: _hostVerb.integrate}]
externalIntegrateAlwaysRuns: _externalBuild.targets["integrate-action"].taskfile.incremental & false
externalVisualRunsTask:       _externalBuild.targets["ci-visual"].dockerfile.incremental & true
externalVisualKeepsInjection: len(_externalBuild.targets["ci-visual"].cmd.builtin.dockerfile.inject.secrets) > 0 & true

externalGenerateOwnsCompiler: strings.Contains(_externalBuild.targets.generate.cmd.builtin.do, "task-leaf generate") & true
externalBuildDependsOnGenerate: _externalBuild.targets.build.deps & [":generate"]
externalLintDependsOnGenerate: _externalBuild.targets.lint.deps & [":generate", ":lint-inputs"]
externalBuildRunsConsumerRules: strings.Contains(_externalBuild.targets.build.cmd.builtin.do, "task-leaf build") & true

frozenArchiveClock: strings.Contains((dist.#Project & {edgeClock: "disabled"}).edge, "--clock disabled") & true
defaultEdgeClock: strings.Contains(_project.edge, "--clock disabled") & false

// Explicit live targets keep the HTTP/browser runner; the default GCP check
// runs the app's integration drivers in Cloud Build.
gcpVerifyLiveTarget: strings.Contains(_project.verifyGcp, "SAY_VERIFY_ARGS_TARGET") & true
// A domain alone reaches the HTTP verifier, which refuses an empty one, rather than the plan's Cloud Run service.
gcpVerifyDomain:     strings.Contains(_project.verifyGcp, "'SAY_VERIFY_ARGS_DOMAIN' in $env") & true
gcpVerifyHttp:       strings.Contains(_project.verifyGcp, "verify verify.ts") & true
gcpVerifyDrivers:    strings.Contains(_project.verifyGcp, "gcp verify.nu") & true

_nativeApp: pronto.#App & {
	for k, v in _code if k != "capabilities" {(k): v}
	capabilities: {
		for k, v in _code.capabilities if k != "native" {(k): v}
		native: true
	}
}
_nativeBuild: (pronto.#DefaultBuild & {code: _nativeApp, loop: _loop, cluster: _cluster, terminal: _terminal}).out.project
nativeBuildPlatforms: [
	_nativeBuild.files["say.yaml"].say.build.rulemap.android.platform,
	_nativeBuild.files["say.yaml"].say.build.rulemap.ios.platform,
	_nativeBuild.files["say.yaml"].say.build.rulemap["omnishell-bundle-android"].platform,
	_nativeBuild.files["say.yaml"].say.build.rulemap["omnishell-bundle-ios"].platform,
] & ["android", "ios", "android", "ios"]
nativeBuildCommands: strings.Contains(_nativeBuild.files["say.yaml"].say.build.rulemap.android.cmds[0].do, "native.ts) . --platform android") &
	strings.Contains(_nativeBuild.files["say.yaml"].say.build.rulemap.ios.cmds[0].do, "native.ts) . --platform ios") & true
