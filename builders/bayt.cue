// Pronto's builder roster, by indirection: each file here re-exports one
// build-graph implementation from its product home. Pronto owns the list;
// the implementations own themselves (bayt's lives in bonisoft3/bayt).
// Consumers import github.com/bonisoft3/pronto/builders:<name>.
//
// The build graph reaches bayt the way .say.yaml reaches sayt: the
// program's `build:` seat is authored here as #Build, `cue export` lands
// the resolved value as concrete bayt.json, and the app's bayt.cue is a
// thin stub that embeds that file and unifies it back through
// bayt.#project — bayt's schema stays live at generate time, and stack
// staleness is bounded by one build cycle (the writer re-exports on every
// loop turn). Ownership: bayt.json is the do-not-edit artifact; the stub
// is the human seam — escape-hatch overrides unify there, after the embed.
package bayt

import (
	"list"
	"strings"

	core "github.com/bonisoft3/bayt/core:bayt"
	sayt "github.com/bonisoft3/bayt/stacks/sayt"
	mise "github.com/bonisoft3/bayt/stacks/mise"
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
	omnishell "github.com/bonisoft3/pronto/terminals:omnishell"
	"github.com/bonisoft3/pronto/resilience"
	zypper "github.com/bonisoft3/bayt/distros/zypper"
)

// bayt's own project schema, re-exported so a compiler (or anyone) can
// validate a build graph directly by unifying against it.
#Project: core.#project

#Toolchain: {
	...
	tools: {"github:bonisoft3/bayt": "0.66.0", ...}
	say: say: {
		...

		// The commands restated: a rule the config names replaces sayt's
		// builtin of that name, so the priority alone would leave bayt unrun.
		generate: rulemap: {"auto-bayt": {priority: 2, cmds: [{use: "./auto-bayt.nu", do: "auto-bayt"}]}, ...}
	}
}

#CompilerSources: {
	paths: ["cue.mod", "plugins/pronto", "plugins/omnishell", "plugins/bayt", "plugins/sayt", "libraries/mecha"]
	exclude: ["**/docs/**", "**/testdata/**", "**/*_test.*", "**/*.test.*", "**/.bayt/**", "**/.task/**", "**/node_modules/**"]
}

// The canonical pronto build graph for one app, authored as the program's
// `build:` seat.
#Build: B={
	meta: {
		app: string
		// Where the app sits under the monorepo's root, which its images take
		// under the switch (project.imageDir); write.ts holds it to the
		// checkout.
		dir:         *"apps/\(app)" | string
		generateCmd: string
		testCmd:     string
		targets:     *[] | [...string]
	}
	// The runtime, as the cluster states it: one bayt target per service,
	// with bare names, lowered into this project by mecha's own #Runtime.
	cluster: mecha.#Cluster

	// A stage that runs cue over the app: it starts from the image the program
	// evaluates in and reads the app's whole tree, since its subpackages, embeds
	// and derived sources are its own to add. The set sits in the
	// framework-side slot, so a stage-level `globs` adds to it.
	_program: {
		deps: *[B._base] | [...string]
		dockerfile: from: ref: *B._base | string
		srcs: {
			defaultGlobs: "pronto-tree": {glob: "**"}
			// Generated, the checks' own, or local to a checkout.
			defaultExclude: {
				"pronto-bayt": *{glob: ".bayt/**"} | null
				"pronto-tests": *{glob: "tests/**"} | null
				"pronto-task": {glob: ".task/**"}
				"pronto-history": *{glob: ".pronto/proto-baseline.json"} | null
				"pronto-node": {glob: "**/node_modules/**"}
				// A checkout's mise lock records its absolute paths.
				"pronto-local-lock": {glob: "mise.local.lock"}
			}
		}
	}

	_sayt:     "(^mise where github:bonisoft3/sayt | str trim)"
	_prontoNu: "(run-mise where github:bonisoft3/pronto | str trim)"
	_actions: {for verb in ["generate", "build", "lint", "test", "launch", "integrate"] {
		(verb): [if verb == "lint" {
			"^nu -I \(B._sayt) -c 'use task-leaf.nu; with-env {PRONTO_PROTO_BASELINE: (open --raw .pronto/proto-baseline.json)} { task-leaf lint }'"
		}, "^nu -I \(B._sayt) -c 'use task-leaf.nu; task-leaf \(verb)'"][0]
	}}

	_ciTask: {
		taskfile: incremental:   false
		dockerfile: incremental: true
	}

	// Where pronto's scripts sit as a target's command sees them: where mise
	// resolves it, the pinned release or, under mise.local.toml, the monorepo's.
	_pronto: "$(mise where github:bonisoft3/pronto)"
	// The image the program evaluates in.
	_base: ":setup"

	// The app's own integrate checks that run beside the stack: a container on
	// the runtime's compose network, reaching the app at the TLS door, whose
	// exit code is the verdict. One container per check rather than one per
	// app, so each keeps its own rule, priority and verdict on the loop.
	checks: [Name=string]: C={
		// Run in order from the app's directory, under its toolchain's mise.
		cmds: [string, ...string]
		note:      string
		priority?: int
		// Playwright's base, with its browsers; without, setup's image.
		browser: *false | true
		// The cluster's database and the secret its sessions are signed under,
		// for a check that grades or seeds what the app stores. Only a cluster
		// with a database publishes them.
		database: *false | true
		// What the commands read beyond tests/**, which every check carries.
		srcs: *[] | [...string]
		// The loop's rule: the check's bkid runner (omnishell.#BkidCheck).
		rule: {
			verb: "integrate"
			if C.priority != _|_ {priority: C.priority}
			note: C.note
			cmds: [(omnishell.#BkidCheck & {runner: "ci-\(Name)"}).out]
		}
	}
	_browser: len([for _, c in B.checks if c.browser {c}]) > 0

	// One switch decides what is the monorepo's: MONOREPO_COMPOSE_MODE, which
	// mise.local.toml sets and a mirror never has. Its value is the context
	// scheme itself, so a context it switches reads the monorepo's service, or
	// else the pinned image. The app's images take the monorepo's layout under
	// it (project.imageDir), so whatever a view brings lands where the
	// checkout keeps it, and mise.local.toml's relative paths hold inside.
	_switch: S={
		service: string
		pin:     string
		out:     "${MONOREPO_COMPOSE_MODE:-docker-image://\(S.pin)}${MONOREPO_COMPOSE_MODE:+:\(S.service)}"
	}
	// mecha's images, named by #DefaultCluster.
	_mechaContexts: {for s, pin in mecha.published {
		"libraries_mecha-\(s)-image": (_switch & {service: "libraries_mecha-\(s)-image", "pin": pin}).out
	}}
	// omnishell's runtime tree, as one image.
	_omnishell:        omnishell.#RuntimeImage
	_omnishellContext: (_switch & {service: _omnishell, pin: omnishell.published.runtime}).out
	_omnishellCopy:    "COPY --from=\(B._omnishell) / /omnishell"
	// Monorepo trees a stage carries in the monorepo: views of the siblings'
	// targets, which in a mirror switch to an image with no /monorepo, and
	// so copy nothing.
	_views: V={
		#views: [...string]
		dockerfile: defaultCopy: {for v in V.#views {
			(v): {
				from: name: v
				srcs: ["/monorep[o]"]
				dst: "/monorepo/"
			}
		}}
		compose: build: additional_contexts: {for v in V.#views {(v): (_switch & {service: v, pin: core.lock.images.busybox}).out}}
	}
	// The runtime's toolchain, which mise.local.toml names: brought in after
	// the pinned install, so an edit to the tree leaves that layer cached, and
	// resolved by a second install, which fetches nothing for a `path:` tool.
	// In a mirror nothing is copied and the second install has nothing to do.
	_toolchainViews: ["workspaceroot-pronto-sources_srcs"]
	_toolchain: {
		// Not a source: a source lands ahead of the pinned install, which would
		// then resolve the trees before they are copied.
		dockerfile: epilogue: list.Concat([
			[for v in _toolchainViews {"COPY --from=\(v) /monorep[o] /monorepo/"}],
			["COPY [m]ise.local.toml ./", "RUN mise install"],
		])
		compose: build: additional_contexts: {for v in _toolchainViews {(v): (_switch & {service: v, pin: core.lock.images.busybox}).out}}
	}
	// What a stack builds its images from beyond the app: mecha's and
	// omnishell's targets, with the compose files that declare them.
	_imageViews: list.Concat([
		[for s, _ in mecha.published {"libraries_mecha-\(s)-image_bayt"}],
		[for s in mecha.#Sourced {"libraries_mecha-\(s)-image_srcs"}],
		[for v in ["srcs", "bayt"] {"\(_omnishell)_\(v)"}],
		["workspaceroot-pronto-sources_bayt"],
	])

	_mechaRuntime: mecha.#Runtime & {"project": project.name, "cluster": B.cluster}
	// A runner rebuilds the stack its closure brings up, from the sources the
	// runtime's images are built from. Launch reaches them through `:outs`
	// edges, which a `:srcs` view does not follow, so each is named.
	_stackSrcs: [for k, _ in B._mechaRuntime.targets
		let t = project.targets[k]
		if t != null if t.dockerfile != _|_
		if len(t.srcs.globs) > 0 || t.srcs.defaultGlobs != null {":\(k):srcs"}]
	// A runner's RUN builds its stack inside, where only what its image holds
	// and its build args reach: the switch, bayt's runtime the host names, the
	// siblings' views, and every mode's file, since the views carry only the
	// one the outer build's mode named.
	_runner: (_views & {#views: list.Concat([_toolchainViews, _imageViews])}) & {
		dockerfile: {
			preamble: [
				"ARG MONOREPO_COMPOSE_MODE",
				"ENV MONOREPO_COMPOSE_MODE=$MONOREPO_COMPOSE_MODE",
				"ARG BAYT_RUNTIME",
				"ENV BAYT_RUNTIME=$BAYT_RUNTIME",
			]
			copy: [{srcs: ["monorepo/*.yaml"], dst: "./", parents: true}]
		}
		compose: build: args: {
			MONOREPO_COMPOSE_MODE: "${MONOREPO_COMPOSE_MODE:-}"
			BAYT_RUNTIME:          "${BAYT_RUNTIME:-}"
		}
	}

	_processComposeAdd: [{
		platforms: {
			amd64: {
				url:      "https://github.com/F1bonacc1/process-compose/releases/download/v1.122.0/process-compose_linux_amd64.tar.gz"
				checksum: "sha256:9b6dbc38324c0b0481f1cd1dd828ffdc78117129ec797678f4bf8c4023311281"
			}
			arm64: {
				url:      "https://github.com/F1bonacc1/process-compose/releases/download/v1.122.0/process-compose_linux_arm64.tar.gz"
				checksum: "sha256:52fa7d5a2d5e0db470faec5976204fc215ed7e3d13689e930cf522becfb63778"
			}
		}
		dest:   "/usr/local/bin/process-compose"
		unpack: true
	}]

	// The terminal's statics served from omnishell's tree (target /omnishell/),
	// which the caddy copies from that image; the cluster serves the app's
	// own (#DefaultCluster). Named from omnishell's root, and never none: a
	// caddy without them would serve no interpreter.
	terminalStatics: [_, ...{file: string, target: string, ...}]
	_runtimeStatics: [for s in B.terminalStatics if strings.HasPrefix(s.target, "/omnishell/") {s}]

	project: core.#project & sayt.gate & {
		files: "say.yaml": say: {for verb in ["launch", "integrate"] {
			(verb): rulemap: builtin: {
				stop: true
				cmds: [{use: "./bayt-task.nu", do: "bayt-task \(verb)-action --generate"}]
			}
		}}
		// The app is its repository's root, in its mirror and in the monorepo
		// alike: the files it commits are its mirror's. Its images take the
		// monorepo's layout where the switch is on.
		dir:      "."
		name:     B.meta.app
		imageDir: "${MONOREPO_COMPOSE_MODE:+\(B.meta.dir)}"

		targets: B._mechaRuntime.targets
		// What every up closure includes: the switch's file, and the networks
		// the cluster's targets join, declared in a file of the app's (emit.cue
		// writes both). One list, since two declarations of it would conflict
		// where both apply.
		compose: includes: [
			"monorepo/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml",
			if B.cluster.surface.networks != _|_ {"compose.networks.yaml"},
		]
		// A door built as a release takes them from the release.
		if len(B._runtimeStatics) > 0 if B.cluster.meta.served == _|_ {
			targets: caddy: {
				dockerfile: defaultCopy: {for s in B._runtimeStatics {
					(s.target): {from: name: B._omnishell, srcs: [s.file], dst: s.target}
				}}
				compose: build: additional_contexts: (B._omnishell): B._omnishellContext
			}
		}

		// A cluster target copying from omnishell's tree (the renderer)
		// resolves it through the same switch.
		targets: {for k, t in B._mechaRuntime.targets
			if t != null && t.dockerfile != _|_ && t.dockerfile.copy != _|_
			if len([for c in t.dockerfile.copy if c.from != _|_ if c.from.name != _|_ if c.from.name == B._omnishell {c}]) > 0 {
				(k): compose: build: additional_contexts: (B._omnishell): B._omnishellContext
			}
		}
		targets: {for k, t in B._mechaRuntime.targets
			if t != null && t.dockerfile != _|_ && t.dockerfile.from != null
			if t.dockerfile.from.name != _|_
			if B._mechaContexts[t.dockerfile.from.name] != _|_ {
				(k): compose: build: additional_contexts: (t.dockerfile.from.name): B._mechaContexts[t.dockerfile.from.name]
			}
		}
		targets: {
			// The app's pinned toolchain, and in the monorepo the runtime's tree,
			// which mise.local.toml names (_toolchain).
			"setup": sayt.setup & mise.install & B._toolchain & {
				dockerfile: core.nubox
			}

			// Git refs are outside the app tree; sample them before lint's cache check.
			"lint-inputs": mise.exec & {
				deps: [":generate"]
				taskfile: incremental: false
				cmd: builtin: {
					shell: "nu"
					do:    "^nu -I \(B._sayt) -c 'use tools.nu [run-mise]; let pronto = \(B._prontoNu); run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-write=.pronto --allow-run --allow-env ($pronto | path join check-proto.ts) --baseline .'"
				}
			}
			// lint and test carry their check as the RUN, so a bake runs them and
			// an unchanged one is a cache hit.
			"lint": sayt.lint & mise.exec & B._program & {
				deps: [":generate", ":lint-inputs"]
				cache: full: false
				dockerfile: from: ref: ":generate"
				srcs: {
					globs: [".bayt/checks.yaml", ".pronto/facts.json"]
					defaultExclude: {"pronto-tests": null, "pronto-bayt": null, "pronto-history": null}
				}
				cmd: builtin: {do: B._actions.lint, shell: "nu", dockerfile: do: "cue vet -c ./..."}
			}
			"generate": sayt.generate & mise.exec & B._program & {
				state: globs: [".bayt/checks.yaml", ".bayt/say.yaml", ".bayt/Taskfile.yml", ".bayt/Taskfile.bayt.yml", ".pronto/check-inputs.json"]
				dockerfile: {}
				cmd: builtin: {do: B._actions.generate, shell: "nu", dockerfile: do: B.meta.generateCmd}
			}
			"build": sayt.build & mise.exec & B._program & {
				deps: [":generate"]
				dockerfile: from: ref: ":generate"
				srcs: {globs: [".bayt/checks.yaml"], defaultExclude: "pronto-bayt": null}
				cmd: builtin: {do: B._actions.build, shell: "nu"}
			}
			"test": sayt.test & mise.exec & {
				// Its checkers are the runtime's, whose tree in the monorepo sits
				// outside this project's source view.
				taskfile: incremental: false
				srcs: B._program.srcs & {
					globs: [".bayt/checks.yaml", ".pronto/facts.json"]
					defaultExclude: {"pronto-tests": null, "pronto-bayt": null}
				}
				cmd: builtin: {do: B._actions.test, shell: "nu", dockerfile: do: B.meta.testCmd}
				dockerfile: from: ref: ":build"
			}
			for verb in ["launch", "integrate"] {
				"\(verb)-action": {
					deps: [":build"]
					taskfile: {incremental: false, run: "always"}
					cmd: builtin: {do: B._actions[verb], shell: "nu"}
				}
			}

			// The cluster's aggregate; the sayt template gives it the entry
			// flags and the profile `skaffold dev` fires on.
			"launch": sayt.launch
			// Visual lint. `sayt.integrate` is already `up: true, manual:
			// true` — a load-by-name point kept off the bare-up stack — which is
			// the shape this needs: a browser cannot reach a running caddy from a
			// build RUN, so the check is the container's CMD and the verdict is
			// its exit code.
			"integrate": sayt.integrate & {
				// No :build dep. The screens this photographs are checked-in
				// artifacts the srcs below carry, and the ladder regenerates them
				// at the build rung before ever reaching integrate — depending on
				// the build image would couple visual lint to a toolchain it does
				// not use. The plane it drives is an image-only dep, so the entry
				// closure carries every fragment the aggregate waits on and loads
				// on its own — the bkid tier runs it that way.
				deps: [":launch:outs"]
				srcs: globs: ["shell/shell.yaml", "shell/screens/**"]
				dockerfile: {
					from: name: core.lock.images.playwright
					preamble: [
						"COPY --from=\(core.lock.images.deno_bin) /deno /usr/local/bin/deno",
						"ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
						"ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
						"ENV DENO_DIR=/deno-cache",
						B._omnishellCopy,
						"RUN deno install --node-modules-dir=auto --entrypoint /omnishell/check-visual.ts",
					]
				}
				cmd: "builtin": null
				compose: {
					// Compose resolves this from .bayt/, not the app directory.
					build: additional_contexts: (B._omnishell): B._omnishellContext
					// The TLS door, so the browser speaks h2 as a reader's does (see
					// the Caddyfile's door), whose certificate Caddy's own CA signs.
					environment: {
						APP_URL: "https://caddy:8443"
						// A screen settles once its guest and its reads have
						// answered, each inside its door's bound.
						let door = resilience.resilience.timeouts.door
						SETTLE_TIMEOUT_MS: "\((door.auth + door.crud) * 1000)"
					}
					// The aggregate the whole runtime hangs off, healthy: loaded on its
					// own the closure brings the plane up, and under the verb, which
					// brought it up first, this is a health check — see the visual
					// check in omnishell/terminal.cue. Qualified, as bayt names it.
					depends_on: "\(project.name)-launch": condition: "service_healthy"
					command: [
						"deno", "run", "--node-modules-dir=auto",
						"--allow-read", "--allow-write", "--allow-net",
						"--allow-env", "--allow-run", "--allow-sys",
						"--unsafely-ignore-certificate-errors=caddy",
						"/omnishell/check-visual.ts", ".",
					]
				}
				// The container's exit code IS the verdict, and `cmd: builtin:
				// null` leaves the image carrying only the playwright base's own
				// CMD — so a command that lost the checker would exit 0 having
				// photographed nothing. Stated as a constraint, dropping it is a
				// generate-time error instead.
				_runsChecker: list.Contains(compose.command, "/omnishell/check-visual.ts")
				_runsChecker: true
			}
			"ci-visual": sayt.ci & B._ciTask & B._runner & {
				#closure: "integrate"
				#check:   "visual"
				deps: list.Concat([[":integrate:srcs", ":integrate:bayt"], B._stackSrcs])
			}
			if B.cluster.capabilities.server {
				let schema = B.cluster.surface.schema
				"replay": core.#target & {
					activate: "mise x --"
					entrypoint: {
						do:    "deno run --config \"\(B._pronto)/deno.json\" --allow-read --allow-write --allow-run --allow-env \"\(B._pronto)/check-replay.ts\" ."
						shell: "sh"
						env: {
							for k, v in B.cluster.surface.targets[schema.target].compose.environment {(k): v}
							if schema.pgroll != _|_ for k, v in B.cluster.surface.targets[schema.pgroll.target].compose.environment if k != "DATABASE_URL" {(k): v}
						}
						after: (schema.target): "healthy"
					}
				}
				"ci-replay": core.#target & {
					activate: ""
					taskfile: incremental: false
					deps: list.Concat([
						[B._base, ":\(schema.target)"],
						[if schema.pgroll != _|_ {":\(schema.pgroll.target)"}],
					])
					srcs: globs: [
						".bayt/process-compose.yaml",
						".pronto/cluster.json",
						"services/database/migrations/**",
						"tests/[r]eplay.json",
						"tests/[r]eplay/**",
					]
					dockerfile: {
						from: ref: ":\(schema.target)"
						add: B._processComposeAdd
						copy: list.Concat([
							[
								{from: {ref: B._base}, srcs: ["/root/.local"], dst: "/root/.local"},
								{from: {ref: B._base}, srcs: ["/monorep[o]"], dst: "/monorepo/"},
							],
							[if schema.pgroll != _|_ {{from: {ref: ":\(schema.pgroll.target)"}, srcs: [schema.pgroll.dir], dst: schema.pgroll.dir}}],
						])
						preamble: [
							"ENV PATH=/root/.local/bin:/root/.local/share/lazybox/bin:$PATH",
							"ENV MISE_TRUSTED_CONFIG_PATHS=/monorepo",
							"ENV \(B.cluster.meta.door.env)=\(B.cluster.meta.door.port)",
						]
					}
					cmd: builtin: {
						shell: "sh"
						do:    "process-compose --no-server -f .bayt/process-compose.yaml run replay"
					}
				}
			}

			// Playwright's base with mise: its browsers need the libraries of the
			// distribution they were built for, so the toolchain comes to them.
			if B._browser {
				"browser": sayt.setup & mise.install & B._toolchain & {
					dockerfile: {
						from: name: core.lock.images.playwright
						defaultPreamble: {
							"lazybox-copy": {priority: -10, line: "COPY --from=\(core.lock.images.lazybox) /lazybox/ /root/.local/share/lazybox/"}
							"path-env": {priority: -9, line: "ENV PATH=/root/.local/bin:/root/.local/share/lazybox/bin:$PATH"}
							"mise-trusted": {priority: -8, line: "ENV MISE_TRUSTED_CONFIG_PATHS=/monorepo"}
						}
					}
				}
			}

			for name, c in B.checks {
				let base = [if c.browser {":browser"}, ":setup"][0]

				// The image is the base, which carries the toolchain, and omnishell's
				// tree, which the tests import from /omnishell (tests/deno.json
				// maps `omnishell/` there).
				"check-\(name)": sayt.integrate & {
					// The plane is an image-only dep, as visual lint's is.
					deps: [base, ":launch:outs"]
					srcs: globs: list.Concat([["tests/**"], c.srcs])
					dockerfile: {
						from: ref: base
						copy: [{from: name: B._omnishell, srcs: ["/"], dst: "/omnishell"}]
					}
					compose: {
						build: additional_contexts: (B._omnishell): B._omnishellContext
						environment: {
							// The TLS door, whose certificate Caddy's own CA signs.
							APP_URL: "https://caddy:8443"
							// What the app's absolute addresses are spelled against.
							ORIGIN: B.cluster.surface.origin
							// A browser check waits on screens as visual lint does.
							if c.browser {
								let door = resilience.resilience.timeouts.door
								SETTLE_TIMEOUT_MS: "\((door.auth + door.crud) * 1000)"
							}
							if c.database {
								DATABASE_URL:     B.cluster.surface.databaseUrl
								PGRST_JWT_SECRET: B.cluster.surface.jwtSecret
							}
						}
						depends_on: "\(project.name)-launch": condition: "service_healthy"
						// `$$` so compose leaves a variable to the container's shell.
						command: ["mise", "x", "--", "sh", "-c", strings.Join([for x in c.cmds {strings.Replace(x, "$", "$$", -1)}], " && ")]
					}
				}
				// The check's bkid runner (omnishell.#BkidCheck).
				"ci-\(name)": sayt.ci & B._ciTask & B._runner & {
					#closure: "check-\(name)"
					#check:   name
					deps: list.Concat([[":check-\(name):srcs", ":check-\(name):bayt"], B._stackSrcs])
				}
			}
			// Every suite in one runner, in turn: the target a CI with one
			// build per app runs (sayt/depot's `ci`). Each suite brings its own
			// stack up on the runner's daemon, so they run one at a time.
			"ci": sayt.ci & B._ciTask & B._runner & {
				_suites: [for n, _ in project.targets if strings.HasPrefix(n, "ci-") {n}]
				deps: [for n in _suites for v in ["srcs", "bayt"] {":\(n):\(v)"}]
				srcs: defaultGlobs: graph: {glob: ".bayt/**"}
				cmd: builtin: do: #"""
					set -eu
					export DOCKER_HOST_TCP="$DOCKER_HOST"
					export DEPOT_DISABLE_OTEL=1
					docker compose --profile '*' config -o /tmp/ci-compose.yaml
					docker buildx bake --allow=fs.read=/ -f /tmp/ci-compose.yaml --print \#(strings.Join(_suites, " ")) > /tmp/ci-bake.json
					for target in \#(strings.Join(_suites, " ")); do
					 docker buildx bake -f /tmp/ci-bake.json --progress plain --set '*.output=type=cacheonly' ${SAYT_NO_CACHE:+--no-cache --set "*.cache-from=" --set "*.cache-to="} ${SAYT_NO_CACHE_FROM:+--set "*.cache-from="} ${SAYT_NO_CACHE_TO:+--set "*.cache-to="} "$target"
					done
					"""#
			}
			if list.Contains(B.meta.targets, "docker") && B.cluster.capabilities.server {
				"release-docker": core.#target & {
					activate: ""
					deps: list.Concat([
						[":database", ":crud", ":caddy"],
						if B.cluster.meta.served != _|_ {[":served-release"]},
						if B.cluster.capabilities.auth {[":auth"]},
					])
					srcs: globs: [".bayt/process-compose.yaml"]
					compose: {
						manual: true
						ports: ["${PORT:-8080}:${PORT:-8080}"]
						image: "${BAYT_DOCKER_REPOSITORY:-ghcr.io/bonisoft3/\(B.meta.app)}:${BAYT_IMAGE_TAG:-latest}"
					}
					dockerfile: core.nubox & {
						defaultPreamble: "zypper-postgres": (zypper.#install & {
							pkgs: [
								"postgresql18-server=18.6-160000.1.1",
								"postgresql18-contrib=18.6-160000.1.1",
								"libopenssl3=3.5.0-160000.10.1",
							]
							then: [
								"rm -rf /usr/lib/locale/*",
								"mkdir -p /run/postgresql && chown -R postgres:postgres /run/postgresql",
							]
						}).out
						add: B._processComposeAdd
						copy: list.Concat([
							[
								{from: {name: core.lock.images.microcheck}, srcs: ["/bin/httpcheck"], dst: "/usr/local/bin/httpcheck"},
								{from: {name: core.lock.images.microcheck}, srcs: ["/bin/portcheck"], dst: "/usr/local/bin/portcheck"},
								{from: {ref: ":database"}, srcs: ["/docker-entrypoint-initdb.d"], dst: "/docker-entrypoint-initdb.d"},
								{from: {ref: ":crud"}, srcs: ["/usr/bin/postgrest"], dst: "/usr/local/bin/postgrest"},
								{from: {ref: ":caddy"}, srcs: ["/usr/bin/caddy"], dst: "/usr/bin/caddy"},
								{from: {ref: ":caddy"}, srcs: ["/etc/caddy/Caddyfile"], dst: "/etc/caddy/Caddyfile"},
								{srcs: [".bayt/process-compose.yaml"], dst: "/.bayt/process-compose.yaml"},
							],
							// The door's tree as this target releases it (emit.cue's
							// served-release), and the inline scripts its policy names.
							if B.cluster.meta.served != _|_ {[
								{from: {ref: ":served-release"}, srcs: ["\(omnishell.#Address.tree)/omnishell/"], dst: "/omnishell/"},
								{from: {ref: ":served-release"}, srcs: ["\(omnishell.#Address.tree)/"], dst: "/srv/"},
								{from: {ref: ":served-release"}, srcs: [omnishell.#Address.scripts], dst: "/etc/caddy/release-scripts"},
							]},
							if B.cluster.meta.served == _|_ {[
								{from: {ref: ":caddy"}, srcs: ["/srv"], dst: "/srv"},
								{from: {ref: ":caddy"}, srcs: ["/omnishell"], dst: "/omnishell"},
							]},
							if B.cluster.capabilities.auth {[
								{from: {name: core.lock.images.deno_bin}, srcs: ["/deno"], dst: "/usr/local/bin/deno"},
								{from: {ref: ":auth"}, srcs: ["/app"], dst: "/app"},
								{from: {ref: ":auth"}, srcs: ["/deno-dir"], dst: "/deno-dir"},
							]},
						])
						preamble: list.Concat([
							[
								"ENV PATH=/usr/lib/postgresql18/bin:/usr/local/bin:$PATH",
								"ENV PGDATA=/var/lib/pgsql/data",
								"ENV PORT=8080",
								"ENV ORIGIN=http://localhost:8080",
								"ENV CADDY_TLS_HOST_PORT=8080",
							],
							if B.cluster.capabilities.auth {[
								"ENV DENO_DIR=/deno-dir",
							]},
						])
						epilogue: [
							#"RUN printf '%s\n' '#!/bin/sh' 'set -e' 'export PGDATA="${PGDATA:-/var/lib/pgsql/data}"' 'export POSTGRES_DB="${POSTGRES_DB:-\#(B.meta.app)}"' 'export PATH="/usr/lib/postgresql18/bin:$PATH"' 'q=$(printf "\047")' 'if [ ! -s "$PGDATA/PG_VERSION" ]; then' '  mkdir -p "$PGDATA" /run/postgresql' '  chown -R postgres:postgres "$PGDATA" /run/postgresql' '  setpriv --reuid=postgres --regid=postgres --clear-groups initdb -D "$PGDATA" --no-sync --encoding=UTF8 --auth=trust --locale-provider=icu --icu-locale=und --locale=C' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -w -o "-c listen_addresses='\'''\''" start' '  if [ "$POSTGRES_DB" != "postgres" ]; then setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\""; fi' '  setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS _pronto_migrations (name text primary key, applied_at timestamptz default now())"' '  for f in /docker-entrypoint-initdb.d/*.sql; do' '    if [ -f "$f" ]; then' '      echo "Applying $f..."' '      setpriv --reuid=postgres --regid=postgres --clear-groups psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -f "$f"' '      base=$(basename "$f")' '      setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "INSERT INTO _pronto_migrations (name) VALUES ($q$base$q) ON CONFLICT DO NOTHING"' '    fi' '  done' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -m fast -w stop' 'else' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -w -o "-c listen_addresses='\'''\''" start' '  setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS _pronto_migrations (name text primary key, applied_at timestamptz default now())"' '  for f in /docker-entrypoint-initdb.d/*.sql; do' '    if [ -f "$f" ]; then' '      base=$(basename "$f")' '      case "$base" in *seed*) continue;; esac' '      applied=$(setpriv --reuid=postgres --regid=postgres --clear-groups psql -t -A -U postgres -d "$POSTGRES_DB" -c "SELECT count(*) FROM _pronto_migrations WHERE name = $q$base$q")' '      if [ "$applied" = "0" ]; then' '        echo "Applying pending migration $f..."' '        setpriv --reuid=postgres --regid=postgres --clear-groups psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -f "$f"' '        setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "INSERT INTO _pronto_migrations (name) VALUES ($q$base$q)"' '      fi' '    fi' '  done' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -m fast -w stop' 'fi' 'if [ "$1" = "postgres" ]; then shift; fi' 'exec setpriv --reuid=postgres --regid=postgres --clear-groups postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 "$@"' > /usr/local/bin/docker-entrypoint.sh && chmod 755 /usr/local/bin/docker-entrypoint.sh"#,
							#"RUN printf '%s\n' '#!/bin/sh' 'if [ "$1" = "microcheck" ]; then' '  shift' '  exec "$@"' 'fi' 'exec "$@"' > /usr/local/bin/bayt && chmod 755 /usr/local/bin/bayt"#,
							#"RUN printf '%s\n' '#!/bin/sh' 'set -e' 'if ! grep -q "crud" /etc/hosts 2>/dev/null; then' '  echo "127.0.0.1 crud database auth" >> /etc/hosts 2>/dev/null || true' 'fi' 'export PORT="${PORT:-8080}"' 'export CADDY_TLS_HOST_PORT="${PORT}"' 'if [ -n "$ORIGIN" ]; then' '  if [ -z "$WEBAUTHN_RP_ID" ]; then' '    h="${ORIGIN#*://}"' '    h="${h%%/*}"' '    h="${h%%:*}"' '    if [ -n "$h" ] && [ "$h" != "localhost" ]; then export WEBAUTHN_RP_ID="$h"; fi' '  fi' '  if [ -z "$WEBAUTHN_ORIGIN" ] && [ -n "$WEBAUTHN_RP_ID" ] && [ "$WEBAUTHN_RP_ID" != "localhost" ]; then export WEBAUTHN_ORIGIN="$ORIGIN"; fi' 'fi' 'exec "$@"' > /usr/local/bin/appliance-entrypoint.sh && chmod 755 /usr/local/bin/appliance-entrypoint.sh"#,
							"RUN sed -i 's|http://127.0.0.1:8080/health|http://127.0.0.1:${PORT:-8080}/health|g' /.bayt/process-compose.yaml",
							"RUN sed -i '/handle @rendered {/,/^[[:space:]]*}[[:space:]]*$/d' /etc/caddy/Caddyfile",
							#"RUN awk '/handle \/electric\/\* \{/{p=1; print "  handle /electric/* {\n    header Content-Type application/json\n    header electric-handle stub\n    header electric-offset 0_0\n    header electric-cursor 0\n    header electric-schema `{\"id\":{\"type\":\"text\"}}`\n    header electric-up-to-date true\n    header Access-Control-Allow-Origin *\n    header Access-Control-Expose-Headers \"electric-handle, electric-offset, electric-cursor, electric-schema, electric-up-to-date, content-type, cache-control, x-txid\"\n\n    @subset query subset__where=*\n    handle @subset {\n      respond `{\"metadata\":{\"xmin\":\"1\",\"xmax\":\"1\",\"xip_list\":[],\"snapshot_mark\":0,\"database_lsn\":\"0\"},\"data\":[]}` 200\n    }\n    handle {\n      respond `[{\"headers\":{\"control\":\"up-to-date\"}}]` 200\n    }\n  }"; next} p && /^  \}/{p=0; next} !p{print}' /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.tmp && mv /etc/caddy/Caddyfile.tmp /etc/caddy/Caddyfile"#,
						]
						entrypoint: ["/usr/local/bin/appliance-entrypoint.sh"]
						cmd: list.Concat([
							["/usr/local/bin/process-compose", "up", "-f", "/.bayt/process-compose.yaml", "-t=false", "--no-server", "caddy"],
							[if B.cluster.capabilities.auth {"auth"}],
						])
					}
				}
			}
		}
	}
}
