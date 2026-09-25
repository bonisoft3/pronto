package distribution

import (
	"encoding/json"
	saycfg "github.com/bonisoft3/sayt:say"
)

#Version:     "0.3.1"
#SaytVersion: "0.39.2"

#Tools: {
	...
	"github:cue-lang/cue":     "0.16.1"
	"github:denoland/deno":    "v2.3.7"
	"github:bonisoft3/pronto": #Version
	"github:bonisoft3/sayt":   #SaytVersion
	// Applies the schema changes an app declares, against a database that
	// already holds a schema (check-replay.ts). `bin` because the release
	// asset is a bare pgroll.win.amd64.exe / pgroll.macos.arm64, and mise
	// only strips dash-separated os/arch suffixes on its own.
	"github:xataio/pgroll": {version: "0.16.3", bin: "pgroll"}
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
	root: [if runtime != "" {json.Marshal(runtime)}, "(run-mise where github:bonisoft3/pronto | str trim)"][0]
	out: "use tools.nu [run-mise]; let pronto = \(root); \(args)"
}

#Project: P={
	_valid:  saycfg.say & P.say.say
	runtime: *"" | string
	tools:   #Tools
	mise: {
		...
		settings: {locked: true, lockfile: true}
		tools: P.tools
	}
	_run: #Run & {runtime: "\(P.runtime)"}
	write: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-write=. --allow-run --allow-env ($pronto | path join write.ts) ."}).out
	checks: {
		derive: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read=. ($pronto | path join derive.ts) --self-test"}).out
		types: (_run & {args: "let files = do { cd $pronto; [ ...(glob --no-dir '*.ts') ...(glob --no-dir 'scales/*.ts') ] }; run-mise exec -- deno check --config ($pronto | path join deno.json) ...$files"}).out
		identity: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join identity.ts) check ."}).out
		facts: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-facts.ts) ."}).out
		sql: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-sql.ts) ."}).out
		proto: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-run --allow-env ($pronto | path join check-proto.ts) ."}).out
		replay: (_run & {args: "run-mise exec -- deno run --config ($pronto | path join deno.json) --allow-read --allow-write --allow-run --allow-env ($pronto | path join check-replay.ts) ."}).out
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
