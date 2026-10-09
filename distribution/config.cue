package distribution

import (
	"encoding/json"
	"strings"
	saycfg "github.com/bonisoft3/sayt:say"
)

#Version:     "0.9.1"
#SaytVersion: "0.42.2"

// The mise tools that carry the three trees a browser bundle reads, for a
// checkout with no monorepo sibling to read them from.
#Runtimes: {
	pronto:    "github:bonisoft3/pronto"
	omnishell: "github:bonisoft3/omnishell"
	mecha:     "github:bonisoft3/mecha"
}

#Tools: {
	...
	"github:cue-lang/cue":     "0.16.1"
	"github:denoland/deno":    "v2.9.7"
	"github:bonisoft3/pronto": #Version
	"github:bonisoft3/sayt":   #SaytVersion
	// Compares every proto the app does not withhold against its own git
	// history (check-proto.ts).
	"github:bufbuild/buf": "1.73.0"
	// Reads every SQL file the app does not withhold (check-sql.ts). A single
	// binary per platform, windows included, so the lint runs wherever the
	// toolchain does.
	"github:sbdchd/squawk": "2.66.0"
	"http:duckdb": {
		version: "1.5.5"
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

// Commands resolve an installation at execution time, never into generated files.
#Run: {
	runtime: string
	args:    string
	root: [if runtime != "" {json.Marshal(runtime)}, "(run-mise where \(#Runtimes.pronto) | str trim)"][0]
	out: "use tools.nu [run-mise]; let pronto = \(root); \(args)"
}

#Project: P={
	_valid:  saycfg.say & P.say.say
	runtime: *"" | string
	domain:  *"" | string
	// The interpreter's root and mecha's, which the bundler reads from: a
	// sibling path in the monorepo, the installed distribution elsewhere.
	omnishell: *"" | string
	mecha:     *"" | string
	_omnishell: [if P.omnishell != "" {json.Marshal(P.omnishell)}, "(run-mise where \(#Runtimes.omnishell) | str trim)"][0]
	_mecha: [if P.mecha != "" {json.Marshal(P.mecha)}, "(run-mise where \(#Runtimes.mecha) | str trim)"][0]
	tools:   #Tools
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
	_run: #Run & {runtime: "\(P.runtime)"}
	write: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-write=. --allow-run --allow-env ($pronto | path join write.ts) ."}).out
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
	bundle: (_run & {args: "run-mise exec -- deno run -A --config ($pronto | path join bundle deno.json) ($pronto | path join bundle bundle.ts) . --omnishell \(P._omnishell) --mecha \(P._mecha) --out dist/browser --base ($env.SAY_RELEASE_ARGS_BASE? | default \"\")\([if len(P.derived.tables) > 0 {" --derived \(P._derivedOut)"}, ""][0])"}).out
	// The edge tier's artifact: the Cloudflare Worker + Durable Object cluster and assets in dist/cloudflare
	cloudflare: (_run & {args: "run-mise exec -- deno run -A --config ($pronto | path join bundle deno.json) ($pronto | path join bundle cloudflare.ts) . --omnishell \(P._omnishell) --mecha \(P._mecha) --out dist/cloudflare\([if P.domain != "" {" --domain \(P.domain)"}, ""][0])"}).out
	checks: {
		derive: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read=. ($pronto | path join derive.ts) --self-test"}).out
		// An installed pronto has no siblings, which its own tests import.
		types: (_run & {args: "let files = do { cd $pronto; [ ...(glob --no-dir \([if P.runtime == "" {"--exclude [*_test.ts *.test.ts] "}, ""][0])'*.ts') ...(glob --no-dir 'scales/*.ts') ] }; run-mise exec -- deno check --config ($pronto | path join deno.json) ...$files"}).out
		identity: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join identity.ts) check ."}).out
		facts: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-facts.ts) ."}).out
		sql: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-sql.ts) ."}).out
		proto: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-proto.ts) ."}).out
		// Under the compute service's own pins, as it runs them: queries over
		// DuckDB, the cage's workers, the wasm.
		computations: (_run & {args: "run-mise exec -- deno test --config (\(P._mecha) | path join services compute deno.json) --frozen --permit-no-files --unstable-worker-options --allow-read --allow-ffi --allow-env computations"}).out
		// Each module loaded as the service loads it at startup, so one it
		// would refuse fails here; the emitter appends the modules' paths.
		admit: (_run & {args: "run-mise exec -- deno run --config (\(P._mecha) | path join services compute deno.json) --frozen --unstable-worker-options --allow-read --allow-env (\(P._mecha) | path join services compute admit.ts)"}).out
	}
	say: say: {
		...
		self: version: "v\(#SaytVersion)"
		doctor: do:    "use tools.nu [run-mise]; run-mise exec -- cue version; run-mise exec -- deno --version; run-mise where github:bonisoft3/pronto"
		generate: rulemap: {
			...
			"auto-cue": cmds: [{use: "./tools.nu", do: "tools run-cue cmd generate ./pronto"}]
			"pronto": {
				priority: 1
				cmds: [{do: "if ('program.cue' | path exists) { let pkg = (open program.cue --raw | parse -r '(?m)^package\\s+(\\w+)\\s*$' | first | get capture0); $'package ($pkg)\nloop: surface: sources: pronto: \"\"\n' | save --force program_pronto.cue; \(P.write) }"}]
			}
		}
		build: do: P.write
	}
}
