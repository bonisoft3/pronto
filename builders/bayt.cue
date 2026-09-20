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
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
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
	// The runtime, as the cluster states it: one bayt target per service,
	// with bare names. Lowered into this project below.
	cluster: mecha.#Cluster

	// A cluster target lowered into this project. bayt names a service
	// `<project>-<target>`, so `depends_on` keys take the prefix; the bare
	// name stays as the service's network alias, which is what the
	// Caddyfile, the pipelines and every `@database:5432` URL address. Each
	// dependency is also an image-only dep, so the entry closures carry the
	// fragments of what they wait on. Rebuilt field by field rather than
	// unified: unifying a qualified `depends_on` onto the bare one would keep
	// both key sets.
	_lower: L={
		name: string
		in:   _
		out: {
			for f, v in L.in if f != "compose" && f != "deps" {(f): v}
			deps: [for k, _ in (B._waits & {t: L.in}).out {":\(k):outs"}]
			compose: {
				for f, v in L.in.compose if f != "depends_on" {(f): v}
				depends_on: {for k, v in (B._waits & {t: L.in}).out {("\(B.project.name)-\(k)"): v}}
				networks: default: aliases: [L.name]
			}
		}
	}
	// What a target waits on; a target that waits on nothing has no field.
	_waits: W={
		t: _
		out: [if W.t.compose.depends_on != _|_ {W.t.compose.depends_on}, {}][0]
	}
	_clusterTargets: {for n, t in B.cluster.surface.targets if t != null {(n): t}}
	// Every key a cluster target waits on names a cluster target. A hatch
	// that nulls a service leaves the aggregate waiting on a name no service
	// answers to, which compose would report at `up` and this reports at
	// export.
	_dangling: [
		for n, t in B._clusterTargets for k, _ in (B._waits & {"t": t}).out
		if !list.Contains([for m, _ in B._clusterTargets {m}], k) {"\(n) waits on \(k)"},
	]
	_dangling: []

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

		targets: {
			for n, t in B._clusterTargets {(n): (B._lower & {"name": n, "in": t}).out}
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
			// The cluster's aggregate; the sayt template gives it the entry
			// flags and the profile `skaffold dev` fires on.
			"launch": sayt.launch
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
					// The aggregate the whole runtime hangs off, healthy: loaded on its
					// own the closure brings the plane up, and under the verb, which
					// brought it up first, this is a health check — see the visual
					// check in omnishell/terminal.cue. Qualified, as bayt names it.
					depends_on: "\(project.name)-launch": condition: "service_healthy"
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
