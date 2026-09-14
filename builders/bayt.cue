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

	core "github.com/bonisoft3/bayt/core:bayt"
	sayt "github.com/bonisoft3/bayt/stacks/sayt"
	mise "github.com/bonisoft3/bayt/stacks/mise"
)

// bayt's own project schema, re-exported so a compiler (or anyone) can
// validate a build graph directly by unifying against it.
#Project: core.#project

#Toolchain: {
	...
	tools: {"github:bonisoft3/bayt": "0.52.1", ...}
	say: say: {
		...
		generate: rulemap: {"auto-bayt": priority: 2, ...}
	}
}

// The canonical pronto build graph for one app, authored as the program's
// `build:` seat.
#Build: B={
	meta: {
		app:      string
		local:    *true | bool
		buildCmd: string
		testCmd:  string
	}

	// What the program itself reads: every cue file of the package, the
	// bayt.json its bayt.cue embeds, and the DESIGN.md program.cue embeds. Each
	// stage that runs cue over the app carries this set in the framework-side
	// slot, so a stage-level `globs` adds to it rather than replacing it.
	_program: srcs: defaultGlobs: {
		// Ordered, so the emitted COPY line does not follow the key names.
		"pronto-cue": {glob: "*.cue", priority: 1}
		"pronto-bayt": {glob: "bayt.json", priority: 2}
		"pronto-design": {glob: "DESIGN.md", priority: 3}
		if !B.meta.local {
			"pronto-module": {glob: "cue.mod/**", priority: 4}
			"pronto-config": {glob: "pronto/**", priority: 5}
			"pronto-sayt": {glob: ".say.yaml", priority: 6}
		}
	}

	project: core.#project & {
		dir: [if B.meta.local {"apps/\(B.meta.app)"}, "."][0]
		if !B.meta.local {name: B.meta.app}

		// The app's runtime is pronto's own compose.yaml. Including it puts the
		// runtime services and the bayt targets in ONE compose project, which is
		// what lets a target declare depends_on against a service.
		compose: includes: ["compose.yaml"]
		targets: {
			"setup": sayt.setup & {
				if B.meta.local {dockerfile: from: ref: "workspaceroot:setup"}
				if !B.meta.local {
					mise.install
					dockerfile: core.nubox
				}
			}
			"lint": sayt.lint & mise.exec & B._program & {
				srcs: globs: ["brief.html", "ir.html", "acceptance.md"]
				cmd: builtin: do: "cue vet ./..."
			}
			"build": sayt.build & mise.exec & B._program & {
				// ir.html and acceptance.md are build inputs: derive.ts reads the
				// diagrams and the ledger into .pronto/facts.json. Both are listed
				// because the fingerprint is what decides a rebuild, and the ledger
				// is pinned by nothing else — ir.html at least moves program.cue's
				// meta.ir.sha256 when it changes.
				srcs: globs: ["ir.html", "acceptance.md", "shell/**", "pipelines/**", "services/**", if !B.meta.local {".omnishell/**"}]
				cmd: builtin: do:      B.meta.buildCmd
				dockerfile: from: ref: ":setup"
			}
			"test": sayt.test & mise.exec & B._program & {
				cmd: builtin: do: B.meta.testCmd
			}
			"launch": sayt.launch & {
				dockerfile: from: ref: ":build"
			}
			// The visual battery. `sayt.integrate` is already `up: true, manual:
			// true` — a load-by-name point kept off the bare-up stack — which is
			// the shape this needs: a browser cannot reach a running caddy from a
			// build RUN, so the check is the container's CMD and the verdict is
			// its exit code.
			"integrate": sayt.integrate & {
				// No :build dep. The screens this photographs are checked-in
				// artifacts the srcs below carry, and the ladder regenerates them
				// at the build rung before ever reaching integrate — depending on
				// the build image would couple the battery to a toolchain it does
				// not use.
				deps: []
				srcs: globs: ["shell/shell.yaml", "shell/screens/**"]
				dockerfile: {
					from: name: core.lock.images.playwright
					preamble: [
						"COPY --from=\(core.lock.images.deno_bin) /deno /usr/local/bin/deno",
						"ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
						"ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
						"ENV DENO_DIR=/deno-cache",
						[if B.meta.local {"COPY --from=root plugins/omnishell /omnishell"}, "COPY --from=root .omnishell /omnishell"][0],
						"RUN deno install --node-modules-dir=auto --entrypoint /omnishell/check-visual.ts",
					]
				}
				cmd: "builtin": null
				compose: {
					// Compose resolves this from .bayt/, not the app directory.
					build: additional_contexts: root: [if B.meta.local {"../../.."}, ".."][0]
					// Plain HTTP, so the checker measures no secure context and
					// anything gated on one is uncovered. Nothing in the battery
					// reads such an API.
					environment: APP_URL: "http://caddy:8080"
					// caddy and not launch, though launch is the aggregate the whole
					// runtime hangs off: bayt mirrors every depends_on key as a
					// build context, and launch declares no build, which compose
					// rejects. The verb brings the runtime up first and this
					// closure joins the same project, so the plane is already
					// there — see the visual check in omnishell/terminal.cue.
					depends_on: caddy: condition: "service_healthy"
					command: [
						"deno", "run", "--node-modules-dir=auto",
						"--allow-read", "--allow-write", "--allow-net",
						"--allow-env", "--allow-run", "--allow-sys",
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
		}
	}
}
