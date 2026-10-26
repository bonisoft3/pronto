package distribution

import (
	"encoding/json"
	"strings"
	saycfg "github.com/bonisoft3/sayt:say"
)

#Version:     "0.24.0"
#SaytVersion: "0.45.0"

// Test-only modules: an app's tests import the hybrid oracle harnesses by URL,
// and the portable types are refreshed from the checkout's mecha client. An
// installed pronto neither type-checks nor runs them (installed_test.ts holds
// the rest to its own tree).
#TestModules: ["hybrid-local.ts", "hybrid-battery.ts", "refresh-portable-types.ts"]

// The mise tools that carry the three trees a browser bundle reads, for a
// checkout with no monorepo sibling to read them from.
#Runtimes: {
	pronto:    "github:bonisoft3/pronto"
	omnishell: "github:bonisoft3/omnishell"
	mecha:     "github:bonisoft3/mecha"
}

// The ICE servers a release's terminal hands an online race's
// RTCPeerConnection, by target (docs/release-targets.md#ice-servers): derived
// from where the app is released and never declared by it. A dev or CI stack
// writes none. An entry is an RTCIceServer, so a TURN relay's credentials fit.
#IceServer: {
	urls:        string | [string, ...string]
	username?:   string
	credential?: string
}
#IceServers: [string]: [...#IceServer]
#IceServers: {
	cloudflare: [{urls: "stun:stun.cloudflare.com:3478"}]
	// The images the container targets ship: docker, gcp and k8s.
	container: [{urls: "stun:stun.l.google.com:19302"}]
}

#Tools: {
	...
	"github:cue-lang/cue":     "0.16.1"
	"github:denoland/deno":    "v2.9.7"
	"github:go-task/task":     "v3.54.0"
	"github:nushell/nushell":  "0.116.1"
	"github:bonisoft3/pronto": #Version
	"github:bonisoft3/sayt":   #SaytVersion
	// Compares every proto the app does not withhold against its own git
	// history (check-proto.ts).
	"github:bufbuild/buf": "1.74.0"
	// Reads every SQL file the app does not withhold (check-sql.ts). A single
	// binary per platform, windows included, so the lint runs wherever the
	// toolchain does.
	"github:sbdchd/squawk": "2.66.0"
	// Draws an entity's machines into ir.html (ir-render.ts): one binary from
	// its GitHub release, never aqua (whose registry meets rate limits).
	"github:terrastruct/d2": "v0.9.0"
	"http:duckdb": {
		version: "1.5.6"
		platforms: {
			for platform, asset in {
				"linux-x64":        "linux-amd64"
				"linux-arm64":      "linux-arm64"
				"linux-x64-musl":   "linux-amd64-musl"
				"linux-arm64-musl": "linux-arm64-musl"
				"macos-x64":        "osx-amd64"
				"macos-arm64":      "osx-arm64"
				"windows-x64":      "windows-amd64"
				"windows-arm64":    "windows-arm64"
			} {
				"\(platform)": url: "https://github.com/duckdb/duckdb/releases/download/v{{ version }}/duckdb_cli-\(asset).zip"
			}
		}
	}
}

// Commands resolve an installation at execution time, never into generated
// files: where mise puts it, the pinned release or, under a checkout's
// mise.local.toml, its tree.
#Run: {
	args: string
	out:  "use tools.nu [run-mise]; let pronto = (run-mise where \(#Runtimes.pronto) | str trim); \(args)"
}

#Writer: {
	root: string
	out:  "deno run --config (\(root) | path join deno.json) --allow-read --allow-write=. --allow-run --allow-env (\(root) | path join write.ts) ."
}

#Project: P={
	_valid:    saycfg.say & P.say.say
	domain:    *"" | string
	ssrOrigin: *"" | string
	edgeClock: *"ticker" | "disabled"
	// The interpreter's root and mecha's, which the bundler reads from.
	_omnishell: "(run-mise where \(#Runtimes.omnishell) | str trim)"
	_mecha:     "(run-mise where \(#Runtimes.mecha) | str trim)"
	tools: #Tools
	mise: {
		...
		settings: {
			locked:   true
			lockfile: true
			// Releases are not verified against GitHub's attestation API, which
			// is rate-limited unauthenticated, as in every monorepo app. The
			// global toggles go alongside the backend-scoped ones, which do not
			// override them.
			github_attestations: false
			slsa:                false
			github: {slsa: false, github_attestations: false}
			aqua: {github_attestations: false, cosign: false, slsa: false, minisign: false}
		}
		tools: P.tools
	}
	_run: #Run
	compiler: "^\((#Writer & {root: "(^mise where \(#Runtimes.pronto) | str trim)"}).out)"
	write: (_run & {args: "run-mise exec -- \((#Writer & {root: "$pronto"}).out)"}).out
	// The live tables a pages release fills from the settled container
	// cluster, and the streams that cluster runs; none where the app runs no
	// stream and no computation.
	derived: {
		tables: *[] | [...string]
		streams: *[] | [...string]
	}
	_derivedOut: "dist/derived.sql"
	derive: (_run & {args: "run-mise exec -- deno run -A --config ($pronto | path join bundle deno.json) ($pronto | path join bundle derived.ts) . --tables \(strings.Join(P.derived.tables, ","))\([if len(P.derived.streams) > 0 {" --streams \(strings.Join(P.derived.streams, ","))"}, ""][0]) --out \(P._derivedOut)"}).out
	// The browser tier's artifact: the app bundled into dist/browser/index.html,
	// under the path prefix `sayt release@pages --base=/<prefix>` names.
	bundle: (_run & {args: "run-mise exec -- deno run -A --config ($pronto | path join bundle deno.json) ($pronto | path join bundle bundle.ts) . --omnishell \(P._omnishell) --mecha \(P._mecha) --out dist/browser --base ($env.SAY_RELEASE_ARGS_BASE? | default \"\")\([if len(P.derived.tables) > 0 {" --derived \(P._derivedOut)"}, ""][0])\([if P.edgeClock == "disabled" {" --clock disabled"}, ""][0])"}).out
	// The edge tier's artifact, dist/cloudflare (bundle/edge.ts): the page, the
	// Worker on mecha's edge cluster and the data directory its object loads.
	// `--from`, given to `sayt release@cloudflare`, starts that directory from
	// an archive built elsewhere instead of the migrations and derived rows;
	// derive then has nothing to do.
	_edgeData: "let data = if ($env.SAY_RELEASE_ARGS_FROM? | is-not-empty) { ['--from' $env.SAY_RELEASE_ARGS_FROM] } else { [\([if len(P.derived.tables) > 0 {"'--derived' '\(P._derivedOut)'"}, ""][0])] }"
	edge: (_run & {args: "\(P._edgeData); run-mise exec -- deno run -A --config ($pronto | path join bundle deno.json) ($pronto | path join bundle edge.ts) . --omnishell \(P._omnishell) --mecha \(P._mecha) --out dist/cloudflare ...$data --ice-servers '\(json.Marshal(#IceServers.cloudflare))'\([if P.edgeClock == "disabled" {" --clock disabled"}, ""][0])\([if P.domain != "" {" --domain \(P.domain)"}, ""][0])\([if P.ssrOrigin != "" {" --ssr-origin \(json.Marshal(P.ssrOrigin))"}, ""][0])"}).out
	edgeDerive: "if ($env.SAY_RELEASE_ARGS_FROM? | is-empty) { \(P.derive) }"
	// `--reset` replaces the object's data with this release's; `--temporary`
	// deploys to a throwaway account when none is logged in.
	publishEdge: (_run & {args: "run-mise exec -- deno run -A --config ($pronto | path join bundle deno.json) ($pronto | path join bundle publish-edge.ts) dist/cloudflare --mecha \(P._mecha) ...(if ($env.SAY_RELEASE_ARGS_RESET? | is-empty) { [] } else { ['--reset'] }) ...(if ($env.SAY_RELEASE_ARGS_TEMPORARY? | is-empty) { [] } else { ['--temporary'] })"}).out
	// The container tier's artifact: the self-contained appliance image.
	docker:        "docker compose build release-docker"
	publishDocker: "use semver.nu [tag-on-head]; let tag = (tag-on-head); if ($tag | is-empty) { error make {msg: \"no release tag on HEAD to push\"} }; git push origin $tag; let image_tag = ($tag | path basename); with-env { BAYT_IMAGE_TAG: $image_tag } { docker compose build release-docker; docker compose push release-docker }"
	// The kubernetes tier: cloud or kind cluster release using verified operators and Gateway API.
	k8s: (_run & {args: "run-mise exec -- nu ($pronto | path join k8s release.nu)"}).out
	// The cloud tier on GCP: Cloud Run beside Cloud SQL, with gcloud alone.
	gcp: (_run & {args: "run-mise exec -- nu ($pronto | path join gcp release.nu)"}).out
	checks: {
		derive: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read=. ($pronto | path join derive.ts) --self-test"}).out
		// Its own tests import siblings a release of it does not carry.
		types: (_run & {args: "let files = do { cd $pronto; [ ...(glob --no-dir --exclude [*_test.ts *.test.ts \(strings.Join(#TestModules, " "))] '*.ts') ...(glob --no-dir 'scales/*.ts') ] }; run-mise exec -- deno check --config ($pronto | path join deno.json) ...$files"}).out
		identity: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join identity.ts) check ."}).out
		facts: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-facts.ts) ."}).out
		sql: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-sql.ts) ."}).out
		proto: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-proto.ts) ."}).out
		hybrids: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read ($pronto | path join check-hybrids.ts) ."}).out
		// Under the compute service's own pins, as it runs them: queries over
		// DuckDB, the cage's workers, the wasm.
		computations: (_run & {args: "run-mise exec -- deno test --config (\(P._mecha) | path join services compute deno.json) --frozen --permit-no-files --unstable-worker-options --allow-read --allow-ffi --allow-env computations"}).out
		// Each module loaded as the service loads it at startup, so one it
		// would refuse fails here; the emitter appends the modules' paths.
		admit: (_run & {args: "run-mise exec -- deno run --config (\(P._mecha) | path join services compute deno.json) --frozen --unstable-worker-options --allow-read --allow-env (\(P._mecha) | path join services compute admit.ts)"}).out
		// Each effect's handler admitted as the airlock admits it at startup,
		// against the manifest write emits beside it.
		admitEffects: (_run & {args: "run-mise exec -- deno run --config (\(P._mecha) | path join services airlock deno.json) --frozen --unstable-worker-options --allow-read --allow-env (\(P._mecha) | path join services airlock admit.ts) services/airlock/effects.json ."}).out
	}
	say: say: {
		...
		self: version: "v\(#SaytVersion)"
		doctor: do:    "use tools.nu [run-mise]; run-mise exec -- cue version; run-mise exec -- deno --version; run-mise where github:bonisoft3/pronto"
		generate: rulemap: {
			...
			// An app that bootstraps its repository's root from pronto keeps that
			// project in pronto/, with the command that writes it; a pronto/
			// holding only an app's own rules has nothing to write.
			"auto-cue": cmds: [{use: "./tools.nu", do: "if ('pronto/generate_tool.cue' | path exists) { tools run-cue cmd generate ./pronto }"}]
			"pronto": {
				priority: 1
				// Joined, not interpolated: cue v0.16.1 panics interpolating P.write
				// into a program that fails, where it should say why it fails.
				cmds: [{do: strings.Join(["if ('program.cue' | path exists) { ", P.write, " }"], "")}]
			}
		}
		build: do: "null"
	}
}
