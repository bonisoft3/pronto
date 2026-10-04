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
)

// bayt's own project schema, re-exported so a compiler (or anyone) can
// validate a build graph directly by unifying against it.
#Project: core.#project

#Toolchain: {
	...
	tools: {"github:bonisoft3/bayt": "0.58.2", ...}
	say: say: {
		...
		// The commands restated: a rule the config names replaces sayt's
		// builtin of that name, so the priority alone would leave bayt unrun.
		generate: rulemap: {"auto-bayt": {priority: 2, cmds: [{use: "./auto-bayt.nu", do: "auto-bayt"}]}, ...}
	}
}

// The canonical pronto build graph for one app, authored as the program's
// `build:` seat.
#Build: B={
	meta: {
		app:      string
		local:    *true | bool
		// Where the app sits under the workspace root, and where pronto sits
		// as the app sees it; program_pronto.cue states both where write.ts
		// finds them.
		dir:    *"apps/\(app)" | string
		pronto: *"../../plugins/pronto" | string
		buildCmd: string
		testCmd:  string
	}
	// The runtime, as the cluster states it: one bayt target per service,
	// with bare names, lowered into this project by mecha's own #Runtime.
	cluster: mecha.#Cluster

	// A stage that runs cue over the app: it starts from the image the program
	// evaluates in and reads the app's whole tree, since its subpackages, embeds
	// and derived sources are its own to add. The set sits in the
	// framework-side slot, so a stage-level `globs` adds to it.
	_program: {
		deps: [B._base]
		dockerfile: from: ref: B._base
		srcs: {
			defaultGlobs: "pronto-tree": {glob: "**"}
			// Generated, the checks' own, or local to a checkout.
			defaultExclude: {
				"pronto-bayt": *{glob: ".bayt/**"} | null
				"pronto-tests": {glob: "tests/**"}
				"pronto-task": {glob: ".task/**"}
				"pronto-node": {glob: "**/node_modules/**"}
			}
		}
	}

	// Where pronto's scripts sit as a target's command sees them: the
	// workspace's tree, or the mirror's installed release.
	_pronto: [if B.meta.local {B.meta.pronto}, "$$(mise where github:bonisoft3/pronto)"][0]
	// The image the program evaluates in.
	_base: [if B.meta.local {":program"}, ":setup"][0]
	// From the app up to the workspace root, the root as compose sees it from
	// .bayt/, and the runtime's directory under the root.
	_up: [if B.meta.dir != "" {strings.Repeat("../", len(strings.Split(B.meta.dir, "/")))}, ""][0]
	_root: strings.TrimSuffix("../\(_up)", "/")
	_runtime: strings.TrimPrefix(strings.TrimSuffix(B.meta.pronto, "plugins/pronto"), _up)
	// In the monorepo, workspace trees copied to where the app's relative paths
	// find them: `_top` from the root, `_paths` from the runtime's directory.
	// Compose resolves the root context from .bayt/, not the app directory.
	_fromRoot: {
		_top: *[] | [...string]
		_paths: [...string]
		_exclude: *[] | [...string]
		dockerfile: copy: [{
			from: name: "root"
			srcs: list.Concat([_top, [for p in _paths {B._runtime + p}]])
			dst:     "/monorepo/"
			parents: true
			exclude: _exclude
		}]
		compose: build: additional_contexts: root: B._root
	}
	// The trees an app's tests import.
	_testTrees: ["plugins/omnishell", "libraries/mecha"]

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
		// The loop's rule: the check's closure up under the runtime's own
		// compose project, so a stack already up is the one it reaches and one
		// that is not comes up first. The closure holds the whole runtime, so
		// --remove-orphans takes down only what the closure does not name.
		rule: {
			verb: "integrate"
			if C.priority != _|_ {priority: C.priority}
			note: C.note
			cmds: [(omnishell.#ClosureUp & {project: (omnishell.#ComposeProject & {app: B.meta.app}).out, target: "check-\(Name)"}).out]
		}
	}
	_browser: len([for _, c in B.checks if c.browser {c}]) > 0

	// An installed app takes mecha's images by name (#DefaultCluster), and each
	// build that starts from one resolves the name through a context switch:
	// the pinned release, unless MONOREPO_COMPOSE_MODE says to build it from
	// mecha's sources, whose fragments mecha/service.yaml includes from where
	// MONOREPO_MECHA_PATH says. Neither variable is set outside the monorepo.
	_mechaContexts: {for s, pin in mecha.published {
		"libraries_mecha-\(s)-image": "${MONOREPO_COMPOSE_MODE:-docker-image://\(pin)}${MONOREPO_COMPOSE_MODE:+:libraries_mecha-\(s)-image}"
	}}
	_mechaRuntime: mecha.#Runtime & {"project": project.name, "cluster": B.cluster}

	// omnishell reaches an installed app's images the same way, as one image of
	// its runtime tree (omnishell's runtime-image target), named here and
	// switched by the same mode; mecha/ and omnishell/ hold the fragments.
	_omnishell: "plugins_omnishell-runtime-image"
	_omnishellContext: "${MONOREPO_COMPOSE_MODE:-docker-image://\(omnishell.published.runtime)}${MONOREPO_COMPOSE_MODE:+:\(_omnishell)}"
	// The terminal's statics served from omnishell's tree (target /omnishell/),
	// which an installed app's caddy copies from that image; the cluster serves
	// the app's own (#DefaultCluster). Named from omnishell's root.
	terminalStatics: *[] | [...{file: string, target: string, ...}]
	// Without them an installed caddy would serve no interpreter: an installed
	// app hands its terminal to #DefaultBuild.
	if !B.meta.local {terminalStatics: [_, ...]}
	_runtimeStatics: [for s in B.terminalStatics if strings.HasPrefix(s.target, "/omnishell/") {s}]

	project: core.#project & {
		dir: [if B.meta.local {B.meta.dir}, "."][0]
		if !B.meta.local {name: B.meta.app}
		// At a mirror's root, the monorepo's name, which its images and
		// compose project keep.
		if B.meta.local && B.meta.dir == "" {name: "apps_\(B.meta.app)"}

		targets: B._mechaRuntime.targets
		if !B.meta.local {
			compose: includes: ["mecha/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml", "omnishell/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"]
			if len(B._runtimeStatics) > 0 {
				targets: caddy: {
					dockerfile: defaultCopy: {for s in B._runtimeStatics {
						(s.target): {from: name: B._omnishell, srcs: [s.file], dst: s.target}
					}}
					compose: build: additional_contexts: (B._omnishell): B._omnishellContext
				}
			}
			targets: {for k, t in B._mechaRuntime.targets
				if t != null && t.dockerfile != _|_ && t.dockerfile.from != null
				if t.dockerfile.from.name != _|_
				if B._mechaContexts[t.dockerfile.from.name] != _|_ {
					(k): compose: build: additional_contexts: (t.dockerfile.from.name): B._mechaContexts[t.dockerfile.from.name]
				}
			}
		}
		targets: {
			// The app's pinned toolchain, on the workspace's setup in the
			// monorepo.
			"setup": sayt.setup & mise.install & {
				if B.meta.local {dockerfile: from: ref: "workspaceroot:setup"}
				if !B.meta.local {dockerfile: core.nubox}
			}
			// The module the program evaluates in, after the toolchain so an edit
			// to it leaves the install cached. A mirror's setup carries its own.
			if B.meta.local {
				"program": sayt.setup & (B._fromRoot & {
					_top: ["cue.mod"]
					_paths: ["plugins/pronto", "plugins/omnishell", "plugins/bayt", "plugins/sayt", "libraries/mecha"]
					_exclude: ["**/docs/**", "**/testdata/**", "**/*_test.*", "**/*.test.*"]
				}) & {
					deps: [":setup"]
					dockerfile: from: ref: ":setup"
					// A build stage, never a container.
					compose: scale: 0
				}
			}
			// lint and test carry their check as the RUN, so a bake runs them and
			// an unchanged one is a cache hit.
			"lint": sayt.lint & mise.exec & B._program & {
				cmd: builtin: do: "cue vet ./..."
			}
			"build": sayt.build & mise.exec & B._program & {
				cmd: builtin: do: B.meta.buildCmd
			}
			"test": sayt.test & mise.exec & {
				cmd: builtin: do:      B.meta.testCmd
				dockerfile: from: ref: ":build"
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
				// on its own — the dindbox tier runs it that way.
				deps: [":launch:outs"]
				srcs: globs: ["shell/shell.yaml", "shell/screens/**"]
				dockerfile: {
					from: name: core.lock.images.playwright
					preamble: [
						"COPY --from=\(core.lock.images.deno_bin) /deno /usr/local/bin/deno",
						"ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
						"ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
						"ENV DENO_DIR=/deno-cache",
						[if B.meta.local {"COPY --from=root \(B._runtime)plugins/omnishell /omnishell"}, "COPY --from=\(B._omnishell) / /omnishell"][0],
						"RUN deno install --node-modules-dir=auto --entrypoint /omnishell/check-visual.ts",
					]
				}
				cmd: "builtin": null
				compose: {
					// Compose resolves this from .bayt/, not the app directory.
					build: additional_contexts: [if B.meta.local {{root: B._root}}, {(B._omnishell): B._omnishellContext}][0]
					// The TLS door, so the browser speaks h2 as a reader's does (see
					// the Caddyfile's door), whose certificate Caddy's own CA signs.
					environment: APP_URL: "https://caddy:8443"
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
			// The migration replay starts throwaway databases from the images the
			// runtime was built into, so it drives the host's daemon through its
			// socket; a daemon of its own would hold none of those images. The
			// image is the program's plus the docker CLI. Not yet for an installed
			// app, which the loop does not replay either.
			if B.cluster.capabilities.server && B.meta.local {
				// The generated compose names the images and the database's
				// settings, and the app's includes the root's.
				"replay": sayt.integrate & B._program & B._fromRoot & {
					_paths: [".bayt"]
					srcs: defaultExclude: "pronto-bayt": null
					cmd: "builtin": null
					dockerfile: {
						defaultPreamble: {
							"docker": {priority: -10, copy: {
								from: {name: core.lock.images.docker}
								srcs: ["/usr/local/bin/docker"]
								dst:  "/usr/local/bin/docker"
							}}
							"docker-compose": {priority: -9, copy: {
								from: {name: core.lock.images.docker}
								srcs: ["/usr/local/libexec/docker/cli-plugins/docker-compose"]
								dst:  "/usr/local/libexec/docker/cli-plugins/docker-compose"
							}}
							// Ahead of setup's lazybox, whose `docker` is a stub that
							// fetches a CLI through mise on every run.
							"docker-path": {priority: -8, line: "ENV PATH=/usr/local/bin:$PATH"}
						}
					}
					compose: {
						volumes: ["//var/run/docker.sock:/var/run/docker.sock"]
						// The tag the host's images carry, which the compose the
						// replay reads interpolates into their names.
						environment: BAYT_IMAGE_TAG: "${BAYT_IMAGE_TAG:-latest}"
						// `$$` so compose leaves the substitution to the container's shell.
						command: ["mise", "x", "--", "sh", "-c", "deno run --config \"\(B._pronto)/deno.json\" --allow-read --allow-write --allow-run --allow-env \"\(B._pronto)/check-replay.ts\" ."]
					}
				}
			}
			// Playwright's base with mise: its browsers need the libraries of the
			// distribution they were built for, so the toolchain comes to them.
			if B._browser {
				"browser": sayt.setup & mise.install & {
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
				// The image is the base, which carries the toolchain, plus, in the
				// monorepo, the trees the tests import.
				"check-\(name)": sayt.integrate & {
					if B.meta.local {B._fromRoot & {_paths: B._testTrees}}
					// The plane is an image-only dep, as visual lint's is.
					deps: [base, ":launch:outs"]
					srcs: globs: list.Concat([["tests/**"], c.srcs])
					dockerfile: {
						from: ref: base
						// An installed app's tests import omnishell from /omnishell
						// (tests/deno.json maps `omnishell/` there).
						if !B.meta.local {
							copy: [{from: name: B._omnishell, srcs: ["/"], dst: "/omnishell"}]
						}
					}
					compose: {
						if !B.meta.local {build: additional_contexts: (B._omnishell): B._omnishellContext}
						environment: {
							// The TLS door, whose certificate Caddy's own CA signs.
							APP_URL: "https://caddy:8443"
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
			}
		}
	}
}
