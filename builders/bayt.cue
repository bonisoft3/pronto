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
	"encoding/yaml"
	"list"
	"strings"

	core "github.com/bonisoft3/bayt/core:bayt"
	deno "github.com/bonisoft3/bayt/stacks/deno"
	sayt "github.com/bonisoft3/bayt/stacks/sayt"
	mise "github.com/bonisoft3/bayt/stacks/mise"
	"github.com/bonisoft3/pronto/distribution"
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
	tools: {"github:bonisoft3/bayt": "0.71.0", ...}
	hostTools: {"github:F1bonacc1/process-compose": "v1.122.0", ...}
	say: say: {
		...

		// The commands restated: a rule the config names replaces sayt's
		// builtin of that name, so the priority alone would leave bayt unrun.
		generate: rulemap: {"auto-bayt": {priority: 2, cmds: [{use: "./auto-bayt.nu", do: "auto-bayt"}]}, ...}
	}
}

// The platform trees mise.local.toml resolves an app's toolchain to in the
// monorepo (docs/monorepo.md).
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

	// The omnishell runtime image the app's served image copies: pronto's pin,
	// unless the app runs another omnishell (a fork's prerelease, whose copy
	// the pinned runtime lacks) and names that one's image here.
	omnishellRuntime: *omnishell.published.runtime | omnishell.#RuntimePin

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
				"pronto-live": *{glob: ".pronto/live/**"} | null
				"pronto-node": {glob: "**/node_modules/**"}
				// A checkout's mise lock records its absolute paths.
				"pronto-local-lock": {glob: "mise.local.lock"}
				"pronto-host-mise": {glob: ".mise.host.toml"}
				"pronto-host-lock": {glob: "mise.host.lock"}
			}
		}
	}

	_sayt:     "(^mise where github:bonisoft3/sayt | str trim)"
	_prontoNu: "(run-mise where github:bonisoft3/pronto | str trim)"
	// Generate and lint run cue a dozen times, each a short-lived process that
	// evaluates the whole program: its garbage collector, left to its default,
	// is a third of that CPU for a heap that peaks near 4 GiB either way.
	_cueGC: "GOGC: off, GOMEMLIMIT: 4294967296"
	_actions: {for verb in ["generate", "build", "lint", "test", "launch", "integrate"] {
		(verb): [if verb == "lint" {
			"^nu -I \(B._sayt) -c 'use task-leaf.nu; with-env {\(B._cueGC), PRONTO_PROTO_BASELINE: (open --raw .pronto/proto-baseline.json)} { task-leaf lint }'"
		}, if verb == "generate" {
			"^nu -I \(B._sayt) -c 'use task-leaf.nu; with-env {\(B._cueGC)} { task-leaf generate }'"
		}, "^nu -I \(B._sayt) -c 'use task-leaf.nu; task-leaf \(verb)'"][0]
	}}

	_ciTask: {
		taskfile: incremental:   false
		dockerfile: incremental: true
	}

	// Where pronto's scripts sit as a target's command sees them: where mise
	// resolves it, the pinned release or, under mise.local.toml, the monorepo's.
	_pronto: "${PRONTO_DIR:-$(mise where github:bonisoft3/pronto)}"
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
	_installBrowser: #"""
		let os = (match $nu.os-info.name { "macos" => "macos", "windows" => "windows", _ => "linux" })
		let home = ($env.HOME? | default ($env.USERPROFILE? | default ('~' | path expand)))
		let default_pw = (match $os {
		  "macos" => ($home | path join "Library/Caches/ms-playwright")
		  "windows" => (($env.LOCALAPPDATA? | default ($home | path join "AppData/Local")) | path join "ms-playwright")
		  _ => ($home | path join ".cache/ms-playwright")
		})
		let pw_dir = (if (($env.PLAYWRIGHT_BROWSERS_PATH? | default "") != "") { $env.PLAYWRIGHT_BROWSERS_PATH } else { $default_pw })
		mkdir $pw_dir
		let marker = ($pw_dir | path join ".playwright-chromium-1.61.1")
		let has_chromium = ((glob ($pw_dir | path join "chromium-*" | str replace -a (char -u 5c) "/") | length) > 0)
		if (not ($marker | path exists)) or (not $has_chromium) {
		  if $os == "linux" {
		    ^mise x -- deno run -A --node-modules-dir=none npm:playwright@1.61.1 install --with-deps chromium
		  } else {
		    ^mise x -- deno run -A --node-modules-dir=none npm:playwright@1.61.1 install chromium
		  }
		  "" | save -f $marker
		}
		let omnishell = (if (($env.OMNISHELL_DIR? | default "") != "") { $env.OMNISHELL_DIR } else { (^mise where github:bonisoft3/omnishell | str trim) })
		let check_visual = ($omnishell | path join "check-visual.ts")
		let nm_marker = ($omnishell | path join "node_modules/.omnishell-visual-nm-v1")
		if ($check_visual | path exists) and (not ($nm_marker | path exists)) {
		  let deno_bin = (which deno | get 0.path)
		  do { cd $omnishell; ^$deno_bin install --node-modules-dir=auto --entrypoint $check_visual }
		  "" | save -f $nm_marker
		}
		"""#
	_checkOrder: [for item in list.Sort([for n, c in B.checks {
		name: n
		p:    [if c.priority != _|_ {c.priority}, 0][0]
	}], {x: _, y: _, less: (x.p < y.p) || (x.p == y.p && x.name < y.name)}) {item.name}]
	_localSuites: strings.Join([for s in list.Concat([
		[if B.cluster.capabilities.server {"replay"}],
		[for _, name in B._checkOrder {"check-\(name)"}],
		["visual"],
	]) {"'\(s)'"}], " ")
	_prepareHostWork: """
		if (not (".certs/localhost.pem" | path exists)) or (not (".certs/localhost-key.pem" | path exists)) {
		  mkdir .certs
		  with-env { CAROOT: (".certs" | path expand) } {
		    ^mise x -- mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost caddy 127.0.0.1 ::1
		  }
		}
		let caroot_ca = ((^mise x -- mkcert -CAROOT | str trim) | path join "rootCA.pem")
		let cert_p = ($work | path join "ca.pem")
		([".certs/localhost.pem" ".certs/rootCA.pem" $caroot_ca] | where ($it | path exists) | each {|p| open --raw $p } | str join (char nl)) | save -f $cert_p
		let served_dir = ($work | path join "served")
		if (".bayt/bayt.served.json" | path exists) {
		  let omnishell = (if (($env.OMNISHELL_DIR? | default "") != "") { $env.OMNISHELL_DIR } else { (^mise where github:bonisoft3/omnishell | str trim) })
		  let tree_dir = ($served_dir | path join "tree")
		  let caddy_dir = ($served_dir | path join "caddy")
		  let srv_dir = ($served_dir | path join "srv")
		  let omni_dir = ($served_dir | path join "omnishell")
		  let scripts_out = ($caddy_dir | path join "release-scripts")
		  mkdir $tree_dir $caddy_dir $srv_dir
		  let ep = (open .bayt/bayt.served.json | get dockerfile.epilogue.0)
		  $ep | parse -r 'install -D -m 644 \\x27(?<src>[^\\x27]+)\\x27 \\x27(?<dst>[^\\x27]+)\\x27' | each {|p|
		    let s = (if ($p.src | str starts-with "\(omnishell.#Address.home)/") { ($omnishell | path join ($p.src | str replace "\(omnishell.#Address.home)/" "")) } else { ($p.src | str replace "/app/" "") })
		    let d = ($tree_dir | path join ($p.dst | str replace "\(omnishell.#Address.tree)/" ""))
		    mkdir ($d | path dirname)
		    cp -f $s $d
		  } | ignore
		  for d in ($ep | parse -r 'grep -rqE \\x27\\[\\[:space:\\]\\](?<k>[^=]+)=\\x22(?<v>[^\\x22]*)\\x22\\x27 \\x27[^\\x27]+\\x27 --include=\\x27\\*\\.html\\x27 \\|\\| \\{ echo \\x27(?<msg>[^\\x27]+)\\x27') {
		    mut matched = false
		    for f in (glob ($tree_dir | path join "**/*.html" | str replace -a (char -u 5c) "/")) {
		      let raw = (open --raw $f)
		      let pat = ('(\\s' + $d.k + '=)\\x22[^\\x22]*\\x22')
		      let rep = ('$1' + (char dquote) + $d.v + (char dquote))
		      let next = ($raw | str replace -a -r $pat $rep)
		      if $next != $raw { $next | save --raw -f $f }
		      if ($next =~ ('[\\s]' + $d.k + '=' + (char dquote) + $d.v + (char dquote))) { $matched = true }
		    }
		    if not $matched { error make { msg: $d.msg } }
		  }
		  ^mise x -- deno run --config ($omnishell | path join "server/deno.json") $"--allow-read=($tree_dir)" $"--allow-write=($tree_dir),($scripts_out)" ($omnishell | path join "server/address.ts") $tree_dir $scripts_out
		  glob ($tree_dir | path join "*" | str replace -a (char -u 5c) "/") | each {|item| cp -rf $item $srv_dir } | ignore
		  if (($tree_dir | path join "omnishell") | path exists) { cp -rf ($tree_dir | path join "omnishell") $omni_dir }
		  for rdir in [$srv_dir $omni_dir] {
		    if ($rdir | path exists) {
		      glob ($rdir | path join "**/*" | str replace -a (char -u 5c) "/") | where ($it | path type) == "file" and (not ($it | str ends-with ".etag")) | each {|f|
		        let h = (open --raw $f | hash sha256)
		        ((char dquote) + $h + (char dquote)) | save --raw -f $"($f).etag"
		      } | ignore
		    }
		  }
		}
		"""
	_localLaunchDo: """
		if (($env.SAYT_TASK_VERB? | default "") != "launch") or (($env.SAYT_PLATFORM? | default "") != "host") { exit 0 }
		def dump-logs [work: string] {
		  for f in ["proc.log" "pc.log"] {
		    let p = ($work | path join $f)
		    if ($p | path exists) {
		      open --raw $p | lines | where (not ($it | str contains "http.log.access")) | last 120 | str join (char nl) | print -e $in
		    }
		  }
		}
		def cleanup-work [w: string] {
		  if ($w | is-empty) or (not ($w | path exists)) { return }
		  let w_fwd = ($w | str replace -a (char -u 5c) "/")
		  for pf in (glob $"($w_fwd)/pg-*/postmaster.pid") {
		    try { ^mise x -- pg_ctl -D ($pf | path dirname) -m immediate -w stop | ignore } catch { }
		  }
		  try {
		    ps -l | where ((($it.command? | default "") | str contains $w) or (($it.command? | default "") | str contains $w_fwd)) and ($it.pid != $nu.pid) and ($it.name =~ '(?i)(postgres|caddy|postgrest|deno|daprd|conduit|redis-server|rclone|imgproxy|redpanda-connect|mailpit|hydra)') | each {|p| try { kill -f $p.pid } catch { } } | ignore
		  } catch { }
		  try { rm -rf $w } catch { }
		}
		load-env { MISE_ENV: "host" }
		let pc_bin = (^mise which process-compose | str trim)
		let arguments = (if (($env.SAYT_TASK_ARGS? | default "") != "") { $env.SAYT_TASK_ARGS | from json } else { [] })
		if ("--watch" in $arguments) or ("-w" in $arguments) { error make {msg: "Native watch is disabled; use sayt launch --watch for Docker"} }
		let os = (match $nu.os-info.name { "macos" => "macos", "windows" => "windows", _ => "linux" })
		let h = (pwd | hash sha256)
		let sock = ($nu.temp-dir | path join $"bayt-launch-($h | str substring 0..12).sock")
		let def_port = (28000 + (($h | str substring 0..6 | into int -r 16) mod 9000) | into string)
		let state_file = ($nu.temp-dir | path join $"bayt-launch-($h | str substring 0..12).work")
		mut prev_work = ""
		mut prev_port = $def_port
		if ($state_file | path exists) {
		  let raw_st = (open --raw $state_file | str trim)
		  if ($raw_st | str starts-with "{") {
		    let parsed = ($raw_st | from json)
		    $prev_work = ($parsed.work? | default "")
		    $prev_port = ($parsed.port? | default $def_port)
		  } else {
		    $prev_work = $raw_st
		  }
		}
		if $os == "windows" or ($sock | path exists) {
		  let prev_conn = (if $os == "windows" { ["-p" $prev_port] } else { ["-U" "-u" $sock] })
		  try { ^$pc_bin ...$prev_conn down } catch { }
		  if ($sock | path exists) { rm -f $sock }
		}
		if ($prev_work | is-not-empty) {
		  cleanup-work $prev_work
		}
		if ($state_file | path exists) { rm -f $state_file }
		let work = ($nu.temp-dir | path join $"bayt-lw-(random chars -l 8)")
		let work_fwd = ($work | str replace -a (char -u 5c) "/")
		let wbin = ($work | path join "bin")
		mkdir $wbin
		if $os == "windows" {
		  (["@echo off" "exit /b 0" ""] | str join (char crlf)) | save -f ($wbin | path join "task.cmd")
		} else {
		  (["#!/bin/sh" "exit 0" ""] | str join (char nl)) | save -f ($wbin | path join "task")
		  ^chmod +x ($wbin | path join "task")
		}
		\(B._prepareHostWork)
		$"log_location: ($work_fwd)/proc.log\n" | save -f ($work | path join "pc-logs.yaml")
		let pvars = (open --raw .bayt/process-compose.yaml | lines | parse -r '(?<var>[A-Z0-9_]+_PORT):-(?<def>[0-9]+)' | where (($it.def | into int) >= 10000) and ($it.var != "\(B.cluster.meta.door.env)") | get var | uniq | sort | append (if $os == "windows" { ["_PC_PORT"] } else { [] }))
		let start_p = (20000 + (($h | str substring 0..6 | into int -r 16) mod 7000))
		let alloc = (^mise x -- deno eval --no-config 'const vars = JSON.parse(Deno.args[0]); let p = Number(Deno.args[1]); const out = {}; for (const k of vars) { while (true) { try { const l = Deno.listen({ hostname: "127.0.0.1", port: p }); l.close(); break; } catch { p++; } } out[k] = String(p++); } console.log(JSON.stringify(out));' ($pvars | to json -r) ($start_p | into string) | from json)
		let port = ($alloc._PC_PORT? | default $def_port)
		let pc_conn = (if $os == "windows" { ["-p" $port] } else { ["-U" "-u" $sock] })
		({ work: $work, port: $port } | to json -r) | save -f $state_file
		let path_key = (if ("PATH" in $env) { "PATH" } else { "Path" })
		let bins = [$wbin ((^mise where github:bonisoft3/bayt | str trim) | path join "bin")]
		let raw_p = ($env | get -o $path_key | default [])
		let cur_p = (if (($raw_p | describe) == "string") { $raw_p | split row (char esep) } else { $raw_p })
		let val_p = (if $os == "windows" { ($bins | append $cur_p) | str join (char esep) } else { $bins | append $cur_p })
		let pc_env = (($alloc | reject -o _PC_PORT) | merge {
		  MISE_ENV: "host"
		  BAYT_LOCAL_WORK_DIR: $work
		  BAYT_LOCAL_SERVED_DIR: $served_dir
		  BAYT_LOCAL_MOCK_AI: ($env.BAYT_LOCAL_MOCK_AI? | default "1")
		  SAYT_PLATFORM: "host"
		  DENO_NO_PROMPT: "1"
		  DENO_CERT: $cert_p
		} | insert $path_key $val_p)
		try {
		  with-env $pc_env {
		    ^$pc_bin ...$pc_conn -D -L ($work | path join "pc.log") -f .bayt/process-compose.yaml -f ($work | path join "pc-logs.yaml") up launch
		  }
		} catch {|e|
		  dump-logs $work
		  cleanup-work $work
		  rm -f $sock $state_file
		  error make {msg: ($e.msg? | default ($e | to text))}
		}
		mut ready = false
		for _ in 1..600 {
		  sleep 500ms
		  if $os != "windows" and not ($sock | path exists) { continue }
		  let res = (do { ^$pc_bin ...$pc_conn process get launch -o json } | complete)
		  if $res.exit_code != 0 { continue }
		  let proc = (try { $res.stdout | from json | get -o 0 } catch { null })
		  if $proc == null { continue }
		  let st = ($proc.status? | default "")
		  let rdy = ($proc.is_ready? | default "")
		  if $st == "Running" and $rdy == "Ready" {
		    $ready = true
		    break
		  }
		  if $st in ["Skipped" "Error" "Completed" "Disabled"] { break }
		}
		if not $ready {
		  dump-logs $work
		  do { ^$pc_bin ...$pc_conn down } | complete
		  cleanup-work $work
		  rm -f $sock $state_file
		  error make {msg: "launch@host failed to become ready"}
		}
		if ($env.SAYT_LAUNCH_ONCE? | default "") == "1" {
		  do { ^$pc_bin ...$pc_conn down } | complete
		  cleanup-work $work
		  rm -f $sock $state_file
		}
		"""
	_localIntegrateDo: """
		\(B._installBrowser)
		let base_tmp = (if (($env.RUNNER_TEMP? | default "") != "") { $env.RUNNER_TEMP } else { $nu.temp-dir })
		let work = ($base_tmp | path join $"bayt-host-\(project.name)-($nu.pid)-(random int 100000..999999)")
		let wbin = ($work | path join "bin")
		mkdir $wbin
		if $os == "windows" {
		  (["@echo off" "exit /b 0" ""] | str join (char crlf)) | save -f ($wbin | path join "task.cmd")
		} else {
		  (["#!/bin/sh" "exit 0" ""] | str join (char nl)) | save -f ($wbin | path join "task")
		  ^chmod +x ($wbin | path join "task")
		}
		\(B._prepareHostWork)
		let path_key = (if ("PATH" in $env) { "PATH" } else { "Path" })
		let raw_p = ($env | get -o $path_key | default [])
		let cur_p = (if (($raw_p | describe) == "string") { $raw_p | split row (char esep) } else { $raw_p })
		let new_p = ([$wbin ((^mise where github:bonisoft3/bayt | str trim) | path join "bin")] | append $cur_p)
		let val_p = (if $os == "windows" { $new_p | str join (char esep) } else { $new_p })
		load-env {
		  ($path_key): $val_p
		  MISE_ENV: "host"
		  BAYT_LOCAL_SERVED_DIR: $served_dir
		  BAYT_LOCAL_MOCK_AI: ($env.BAYT_LOCAL_MOCK_AI? | default "1")
		  SAYT_PLATFORM: "host"
		  DENO_NO_PROMPT: "1"
		  DENO_CERT: $cert_p
		}
		let pc_bin = (^mise which process-compose | str trim)
		let pvars = (open --raw .bayt/process-compose.yaml | lines | parse -r '(?<var>[A-Z0-9_]+_PORT):-(?<def>[0-9]+)' | where (($it.def | into int) >= 10000) | get var | uniq | sort)
		mut next_p = (15000 + (((($nu.pid * 2654435761) + (random int 0..999999)) mod 85) * 200))
		let ok = (try {
		  for suite in [\(B._localSuites)] {
		    let sdir = ($work | path join $"suite-($suite)")
		    mkdir $sdir
		    let alloc = (^mise x -- deno eval --no-config 'const vars = JSON.parse(Deno.args[0]); let p = Number(Deno.args[1]); const out = {}; for (const k of vars) { while (true) { try { const l = Deno.listen({ hostname: "127.0.0.1", port: p }); l.close(); break; } catch { p++; } } out[k] = String(p++); } out._next = String(p); console.log(JSON.stringify(out));' ($pvars | to json -r) ($next_p | into string) | from json)
		    $next_p = ($alloc._next | into int)
		    load-env ($alloc | reject _next | merge { BAYT_LOCAL_WORK_DIR: $sdir })
		    let sdir_fwd = ($sdir | str replace -a (char -u 5c) '/')
		    $"log_location: ($sdir_fwd)/proc.log\n" | save -f ($sdir | path join "pc-logs.yaml")
		    let suite_err = (try {
		      ^$pc_bin --no-server -L ($sdir | path join "pc.log") -f .bayt/process-compose.yaml -f ($sdir | path join "pc-logs.yaml") run $suite
		      null
		    } catch {|err|
		      $err
		    })
		    for pf in (glob $"($sdir_fwd)/pg-*/postmaster.pid") {
		      try { ^mise x -- pg_ctl -D ($pf | path dirname) -m immediate -w stop | ignore } catch { }
		    }
		    try {
		      ps -l | where ((($it.command? | default "") | str contains $sdir) or (($it.command? | default "") | str contains $sdir_fwd)) and ($it.pid != $nu.pid) and ($it.name =~ '(?i)(postgres|caddy|postgrest|deno|daprd|conduit|redis-server|rclone|imgproxy|redpanda-connect|mailpit|hydra)') | each {|p| try { kill -f $p.pid } catch { } } | ignore
		    } catch { }
		    if $suite_err != null {
		      let proc_log = ($sdir | path join "proc.log")
		      if ($proc_log | path exists) {
		        let plines = (open --raw $proc_log | lines | where (not ($it | str contains "http.log.access")) and (not ($it | str contains "NOTICE:")) and (not ($it | str contains "WARNING:  cast will be ignored")))
		        print -e ($plines | where ($it | str contains $"\"process\":\"($suite)\"") | last 80 | str join (char nl))
		        print -e ($plines | last 120 | str join (char nl))
		      }
		      let pc_log = ($sdir | path join "pc.log")
		      if ($pc_log | path exists) {
		        print -e (open --raw $pc_log | lines | last 80 | str join (char nl))
		      }
		      error make { msg: ($suite_err.msg? | default $"suite ($suite) failed") }
		    }
		  }
		  true
		} catch {|err|
		  print -e ($err.msg? | default ($err | to text))
		  false
		})
		try { rm -rf $work } catch { }
		if (not $ok) { exit 1 }
		"""

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
	// mecha's images, named by #DefaultCluster. PRONTO_IMAGE_REGISTRY, set where
	// the build runs, pulls each from that registry instead of its publisher's:
	// the same name and digest, so a mirror serves the same bytes or none.
	_registered: R={
		pin:    string
		_parts: strings.Split(R.pin, "/")
		out:    "${PRONTO_IMAGE_REGISTRY:-\(strings.Join(list.Slice(R._parts, 0, len(R._parts)-1), "/"))}/\(R._parts[len(R._parts)-1])"
	}
	_mechaContexts: {
		for s, pin in mecha.published {
			"libraries_mecha-\(s)-image": (_switch & {service: "libraries_mecha-\(s)-image", "pin": (_registered & {"pin": pin}).out}).out
		}
		// An image mecha has not published yet builds in the monorepo alone:
		// elsewhere a build that needs it pulls a reference that names why.
		for s in mecha.#Images if mecha.published[s] == _|_ {
			"libraries_mecha-\(s)-image": "${MONOREPO_COMPOSE_MODE:-docker-image://unpublished.invalid/mecha-publishes-no-\(s)-image-yet}${MONOREPO_COMPOSE_MODE:+:libraries_mecha-\(s)-image}"
		}
	}
	// omnishell's runtime tree, as one image.
	_omnishell:        omnishell.#RuntimeImage
	_omnishellContext: (_switch & {service: _omnishell, pin: B.omnishellRuntime}).out
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
		[for s in mecha.#Images {"libraries_mecha-\(s)-image_bayt"}],
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
				"ENV FELDERA_COMPILATION_PROFILE=unoptimized",
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
	screenSources: [...string]
	_runtimeStatics: [for s in B.terminalStatics if strings.HasPrefix(s.target, "/omnishell/") {s}]

	_presentation: {
		caddy: {
			workdir: "/pronto"
			hmr: {
				native: true
				code: [".pronto/live/readiness/**"]
				configs: [B.cluster.meta.caddyfile]
				reactions: {code: "none", configs: "restart", assets: "restart"}
				assets: [".certs/**"]
				tools: [], docs: []
			}
		}
		render: {
			workdir: "/render"
			hmr: {
				native: true
				code: ["shell/index.html"]
				reactions: {code: "none", assets: "restart"}
				assets: [".pronto/development/shell.json"]
				configs: [], tools: [], docs: []
			}
		}
	}

	project: core.#project & sayt.gate & {
		files: "presentation.json": {
			dockerfile: """
				FROM \(B.cluster.surface.targets.caddy.dockerfile.from.name) AS caddy
				WORKDIR /pronto
				RUN mkdir -p /pronto/.pronto/live/readiness
				COPY \(B.cluster.meta.caddyfile) /pronto/\(B.cluster.meta.caddyfile)
				COPY .certs/ /pronto/.certs/
				COPY .pronto/live/srv/ /pronto/.pronto/live/srv/
				COPY .pronto/live/omnishell/ /pronto/.pronto/live/omnishell/
				"""
			caddyfile: B.cluster.meta.caddyfile
			for name, part in B._presentation {
				(name): {watch: (core.#hmrCompose & {hmr: part.hmr, workdir: part.workdir}).watch}
			}
		}

		files: "say.yaml": say: {
			for verb in ["launch", "integrate"] {
				(verb): rulemap: {
					builtin: {
						stop: true
						cmds: [{use: "./bayt-task.nu", do: "bayt-task \(verb)-action --generate"}]
					}
					host: {
						platform: "host"
						stop:     true
						cmds: [{use: "./bayt-task.nu", do: "\(_hostBundle); def --wrapped host-verb [...args] { if (\"--watch\" in $args) or (\"-w\" in $args) { error make {msg: \"Native watch is disabled; use sayt launch --watch for Docker\"} }; with-env { MISE_ENV: 'host' } { ^mise install; omnishell-bundle; bayt-task \(verb) --generate ...$args } }; host-verb"}]
					}
				}
			}
			// integrate@local, beside the builtin rather than among the loop's
			// checks: sayt's loop closes integrate's rulemap over them, and a check
			// names no platform. launch@local is the loop's (emit.cue).
			integrate: rulemap: local: {
				platform: "local"
				priority: -1
				stop:     true
				cmds: [{do: distribution.#IntegrateLocal.out}]
			}
		}
		// The host tier serves omnishell from `mise where`, and its data-plane
		// bundle is a build product (omnishell's bayt `bundle`): in the
		// monorepo, where the switch is set, the host verbs build it from the
		// checkout's mecha; a release ships it, and one without it is refused
		// here rather than served as a dead terminal.
		_hostBundle: "use tools.nu [run-mise]; def omnishell-bundle [] { let omnishell = (run-mise where github:bonisoft3/omnishell | str trim); if (run-mise env --json | from json | get -o MONOREPO_COMPOSE_MODE | default '') != '' { run-mise tool-stub ((run-mise where github:bonisoft3/sayt | str trim) | path join task.toml) -t ($omnishell | path join .bayt Taskfile.yml) bayt:bundle } else if not ($omnishell | path join interpreter vendor mecha-client.js | path exists) { error make {msg: $\"($omnishell) carries no interpreter/vendor/mecha-client.js, the terminal's data-plane bundle an omnishell release ships\"} } }"
		// The app is its repository's root, in its mirror and in the monorepo
		// alike: the files it commits are its mirror's. Its images take the
		// monorepo's layout where the switch is on.
		dir:      "."
		name:     B.meta.app
		imageDir: "${MONOREPO_COMPOSE_MODE:+\(B.meta.dir)}"

		targets: {for k, t in B._mechaRuntime.targets if k != "launch" {(k): t}}
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
		targets: {for k, t in B._mechaRuntime.targets
			if t != null && t.dockerfile != _|_ && t.dockerfile.copy != _|_
			for c in t.dockerfile.copy if c.from != _|_ if c.from.name != _|_
			if B._mechaContexts[c.from.name] != _|_ {
				(k): compose: build: additional_contexts: (c.from.name): B._mechaContexts[c.from.name]
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
			"launch": sayt.launch & {
				for k, v in B._mechaRuntime.targets.launch if k != "deps" {(k): v}
				deps: list.Concat([[":build:outs"], B._mechaRuntime.targets.launch.deps])
				taskfile: incremental: false
				cmd: "launch": {
					shell:      "nu"
					dockerfile: null
					do:         B._localLaunchDo
				}
			}
			"visual": {
				"process-compose": activate: "mise x --"
				activate: ""
				entrypoint: {
					shell: "nu"
					do:    "if ('tests/visual-fixture.ts' | path exists) { ^deno run --no-lock --allow-env --allow-net --unsafely-ignore-certificate-errors=caddy,localhost,127.0.0.1 tests/visual-fixture.ts }; let omni = (if (($env.OMNISHELL_DIR? | default '') != '') { $env.OMNISHELL_DIR } else { (^mise where github:bonisoft3/omnishell | str trim) }); ^deno run --node-modules-dir=auto --allow-read --allow-write --allow-net --allow-env --allow-run --allow-sys --allow-ffi --unsafely-ignore-certificate-errors=caddy,localhost,127.0.0.1 ($omni | path join 'check-visual.ts') ."
					env: {
						APP_URL: {peer: "caddy", port: "door", host: "localhost", prefix: "https://"}
						let door = resilience.resilience.timeouts.door
						SETTLE_TIMEOUT_MS: "\((door.auth + door.crud) * 1000)"
					}
					after: {
						launch: "healthy"
					}
				}
			}
			// Visual lint. `up: true, manual: true` is a load-by-name point
			// kept off the bare-up stack, which is the shape this needs: a
			// browser cannot reach a running caddy from a build RUN, so the
			// check is the container's CMD and the verdict is its exit code.
			"integrate": {
				// Image-only runtime dependencies keep its toolchain out of the visual checker.
				deps: [":launch:outs"]
				taskfile: incremental: false
				srcs: globs: list.Concat([["shell/shell.yaml"], B.screenSources])
				activate: ""
				dockerfile: {
					from: name: core.lock.images.playwright
					preamble: [
						"COPY --from=\(core.lock.images.deno_bin) /deno /usr/local/bin/deno",
						"ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
						"ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
						"ENV DENO_DIR=/deno-cache",
						B._omnishellCopy,
					]
				}
				cmd: {
					"builtin": {
						shell:      "nu"
						dockerfile: null
						srcs: globs: list.Concat([["[t]ests/**"], [for _, c in B.checks for s in c.srcs {s}]])
						do:         B._localIntegrateDo
					}
					"deno-install": (deno.#containerCmd & {
						do: "deno install --node-modules-dir=auto --entrypoint /omnishell/check-visual.ts"
					}).out
				}
				compose: {
					up:     true
					manual: true
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
						do:    #"let pronto = (if (($env.PRONTO_DIR? | default '') != '') { $env.PRONTO_DIR } else { (^mise where github:bonisoft3/pronto | str trim) }); if (($env.BAYT_LOCAL_WORK_DIR? | default '') != '') { let work = $env.BAYT_LOCAL_WORK_DIR; let pgroll = ($work | path join 'pgroll'); if ('.bayt/bayt.migrate.json' | path exists) and (not ($pgroll | path exists)) { mkdir $pgroll; let m = (open .bayt/bayt.migrate.json | get dockerfile); ($m | get -o copy | default []) | each {|c| cp ($c.srcs.0) ($pgroll | path join ($c.dst | path basename)) } | ignore; ($m | get -o epilogue | default []) | each {|e| let lines = ($e | lines); if ($lines.0 | str starts-with "COPY <<'PGROLL' /tmp/") { let name = ($lines.0 | parse "COPY <<'PGROLL' /tmp/{name}.parts" | get 0.name); ($lines | skip 1 | take while {|l| $l != "PGROLL" } | str join "" | decode base64) | save --raw -f ($pgroll | path join $name) } else if ($lines.0 | str starts-with "COPY <<'PGROLL' /pgroll/") { let name = ($lines.0 | parse "COPY <<'PGROLL' /pgroll/{name}" | get 0.name); $lines.1 | save --raw -f ($pgroll | path join $name) } else if ($lines.0 | str starts-with "COPY <<'RECONCILE' /pgroll/") { let name = ($lines.0 | parse "COPY <<'RECONCILE' /pgroll/{name}" | get 0.name); ($lines | skip 1 | drop 1 | str join "\n") | save --raw -f ($pgroll | path join $name) } } | ignore }; let os = (match $nu.os-info.name { 'macos' => 'macos', 'windows' => 'windows', _ => 'linux' }); let sh = (if ('services/migrate/migrate.nu' | path exists) { 'services/migrate/migrate.nu' } else if ('services/migrate/migrate.sh' | path exists) and ($os != 'windows') { 'services/migrate/migrate.sh' } else { ((^mise where github:bonisoft3/mecha | str trim) | path join 'services/migrate/migrate.nu') }); with-env { PRONTO_REPLAY_INITDB: ($work | path join 'initdb.d'), PRONTO_REPLAY_PGROLL_DIR: $pgroll, PRONTO_MIGRATE_SH: $sh } { ^deno run --config ($pronto | path join 'deno.json') --allow-read --allow-write --allow-run --allow-env ($pronto | path join 'check-replay.ts') . } } else { ^deno run --config ($pronto | path join 'deno.json') --allow-read --allow-write --allow-run --allow-env ($pronto | path join 'check-replay.ts') . }"#
						shell: "nu"
						env: {
							for k, v in B.cluster.surface.targets[schema.target].compose.environment {(k): v}
							if schema.pgroll != _|_ for k, v in B.cluster.surface.targets[schema.pgroll.target].compose.environment if k != "DATABASE_URL" {(k): v}
							PGHOST: {peer: schema.target, port: "pg", part: "host"}
							PGPORT: {peer: schema.target, port: "pg", part: "port"}
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
							"ENV PATH=/root/.local/bin:/root/.local/share/mise/shims:/root/.local/share/lazybox/bin:$PATH",
							"ENV MISE_TRUSTED_CONFIG_PATHS=/monorepo",
							"ENV \(B.cluster.meta.door.env)=\(B.cluster.meta.door.port)",
							"RUN printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/task && chmod 755 /usr/local/bin/task",
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
					taskfile: incremental: false
					cmd: "playwright": {
						priority:   1
						shell:      "nu"
						dockerfile: null
						do:         B._installBrowser
					}
					dockerfile: {
						from: name: core.lock.images.playwright
						defaultPreamble: {
							"lazybox-copy": {priority: -10, line: "COPY --from=\(core.lock.images.lazybox) /lazybox/ /root/.local/share/lazybox/"}
							"path-env": {priority: -9, line: "ENV PATH=/root/.local/bin:/root/.local/share/lazybox/bin:$PATH"}
							"mise-trusted": {priority: -8, line: "ENV MISE_TRUSTED_CONFIG_PATHS=/monorepo"}
							"playwright-path": {priority: -7, line: "ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"}
							"playwright-skip": {priority: -6, line: "ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"}
						}
					}
				}
			}

			for _, name in B._checkOrder {
				let c = B.checks[name]
				let base = [if c.browser {":browser"}, ":setup"][0]

				// The image is the base, which carries the toolchain, with
				// omnishell's runtime tree at /omnishell. The commands are nushell
				// on both paths, the host's process-compose and the image's
				// compose: a check that runs code of a platform tree finds the
				// tree with `mise where` (pronto's #Platform).
				"check-\(name)": {
					// The plane is an image-only dep, as visual lint's is.
					deps: [base, ":launch:outs"]
					srcs: globs: list.Concat([["tests/**"], c.srcs])
					"process-compose": activate: "mise x --"
					entrypoint: {
						shell: "nu"
						do:    strings.Replace(strings.Join(c.cmds, "; "), "--unsafely-ignore-certificate-errors=caddy", "--unsafely-ignore-certificate-errors=caddy,localhost,127.0.0.1", -1)
						env: {
							APP_URL: {peer: "caddy", port: "door", host: "localhost", prefix: "https://"}
							DOOR:    {peer: "caddy", port: "http", prefix: "http://"}
							ORIGIN:  ["${ORIGIN:-\(B.cluster.meta.door.scheme)://", {peer: "caddy", port: "door", host: "localhost"}, "}"]
							if c.browser {
								let door = resilience.resilience.timeouts.door
								SETTLE_TIMEOUT_MS: "\((door.auth + door.crud) * 1000)"
							}
							if c.database {
								DATABASE_URL:     ["postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@", {peer: "database", port: "pg"}, "/${POSTGRES_DB:-\(B.meta.app)}"]
								PGRST_JWT_SECRET: B.cluster.surface.jwtSecret
							}
						}
						after: {
							launch: "healthy"
						}
					}
					dockerfile: {
						from: ref: base
						copy: [{from: name: B._omnishell, srcs: ["/"], dst: "/omnishell"}]
					}
					cmd: "builtin": null
					compose: {
						up:     true
						manual: true
						build: additional_contexts: (B._omnishell): B._omnishellContext
						environment: {
							// The TLS door, whose certificate Caddy's own CA signs.
							APP_URL: "https://caddy:8443"
							// The plain listener, where a check reaches the door under any Host.
							DOOR: "http://caddy:8080"
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
						command: ["mise", "x", "--", "nu", "-c", strings.Join([for x in c.cmds {strings.Replace(x, "$", "$$", -1)}], "; ")]
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
				// The appliance runs the airlock as the compose stack does: the
				// same images' contents as processes beside the database, one
				// address (127.0.0.1) under each service's compose name.
				let _effects = len(B.cluster.state.effects) > 0
				let _ai = _effects && (len([for e in B.cluster.state.effects if e.ai != _|_ {e}]) > 0 || B.cluster.capabilities.ai != _|_)
				let _bridges = [for b in B.cluster.state.bridges if list.Contains(b.targets, "docker") {b}]
				// A container several bridges share (one per action) runs once.
				let _containers = {for b in _bridges {(b.container): b.appliance}}
				// The change feed, as compose runs it: Conduit off the logical slot,
				// the bus on daprd and Redis, and Redpanda Connect running the
				// pipelines and the drains' streams. These are process-compose's own
				// processes (.bayt/process-compose.yaml), given the images' binaries.
				let _capture = B.cluster.capabilities.capture
				let _compute = len(B.cluster.state.computations) > 0
				// The transform runs the pipelines and the drains' streams, and
				// carries compute's invalidations to it.
				let _streams = len(B.cluster.state.pipelines) > 0 || _compute
				// The ticker sweeps schedules and timers; the airlock runs for as
				// long as the appliance does, so nothing wakes it.
				let _wakes = len(B.cluster.state.schedules) > 0 || len(B.cluster.state.timers) > 0
				let _timers = len(B.cluster.state.timers) > 0
				let _blobs = B.cluster.capabilities.blobs
				// What an effect declares it reads, which compose refuses to start
				// without (the airlock's environment there).
				let _secrets = [for e in B.cluster.state.effects if e.secrets != _|_ for k in e.secrets {k}]
				// A computation's files, by the paths the processes' environment
				// names them, relative to the app.
				let _computed = [for f, _ in {for c in B.cluster.state.computations for f in list.Concat([[c.file], c.wasm, [if c.feldera != _|_ {c.feldera}]]) {(f): true}} {f}]
				let _overlaid = _effects || _wakes
				// The forward migrations, which compose's migrate service applies: the
				// appliance runs that same process (process-compose.yaml), which what
				// reads the schema already waits on, over the migrate image's files.
				let _pgroll = B.cluster.surface.schema.pgroll
				let _db = "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(B.meta.app)}"
				let _ready = {period_seconds: 1, timeout_seconds: 5, failure_threshold: 120}
				// process-compose.yaml declares these processes too: an override's
				// `command` replaces their entrypoint (an override's entrypoint would
				// not), and its environment merges over theirs by name.
				// Each argument single-quoted for the shell, a quote closed and
				// escaped. process-compose expands variables in commands as it
				// loads the file, which the appliance's own commands rely on; a
				// bridge's command, the app's, is taken as written: its `$` doubled.
				let _command = {
					args: [...string]
					literal: *false | bool
					out: strings.Join([for a in args {
						let q = strings.Replace(a, "'", "'\\''", -1)
						"'" + [if literal {strings.Replace(q, "$", "$$", -1)}, q][0] + "'"
					}], " ")
				}
				let _overlay = {
					version: "0.5"
					processes: {
						if _effects {
							"airlock-upgrade": {
								command: (_command & {args: ["psql", _db, "-X", "--set=ON_ERROR_STOP=1", "--single-transaction", "--file=/airlock-upgrade.sql"]}).out
								depends_on: database: condition: "process_healthy"
							}
							for c, a in _containers {
								(c): {
									command: (_command & {args: a.command, literal: true}).out
									readiness_probe: _ready & {exec: command: "portcheck --port \(a.port)"}
									availability: restart: "on_failure"
								}
							}
							"airlock-mesh": {
								// As compose runs it: every listener on loopback, metrics and
								// profiling off.
								command: (_command & {args: ["/daprd", "--app-id", "airlock", "--dapr-listen-addresses", "127.0.0.1", "--dapr-internal-grpc-listen-address", "127.0.0.1", "--resources-path", "/dapr/airlock", "--config", "/dapr/config.yaml", "--dapr-http-port", "\(mecha.#AppliancePort.meshHttp)", "--dapr-grpc-port", "\(mecha.#AppliancePort.meshGrpc)", "--dapr-internal-grpc-port", "\(mecha.#AppliancePort.meshInternal)", "--metrics-port", "0", "--profile-port", "0", "--log-level", "info"]}).out
								depends_on: {for c, _ in _containers {(c): condition: "process_healthy"}}
								// Each binding reads its bridge's address from the environment.
								environment: [for b in _bridges {
									let _act = [if b.action != _|_ {"/actions/\(b.action)"}, ""][0]
									"BRIDGE_\(strings.ToUpper(strings.Replace(b.name, "-", "_", -1)))_URL=http://\(b.container):\(b.appliance.port)\(_act)"
								}]
								readiness_probe: _ready & {exec: command: "portcheck --port \(mecha.#AppliancePort.meshHttp)"}
								availability: restart: "on_failure"
							}
							airlock: {
								command: (_command & {args: ["airlock-deno", "run", "--frozen", "--unstable-worker-options", "--allow-net=database:\(mecha.#AppliancePort.database),airlock-mesh:\(mecha.#AppliancePort.meshHttp),0.0.0.0:\(mecha.#AppliancePort.airlock)", "--allow-read", "--allow-env", "--allow-sys", "main.ts"]}).out
								working_dir: "/app/airlock"
								environment: list.Concat([
									["DATABASE_URL=\(_db)", "MESH_URL=http://airlock-mesh:\(mecha.#AppliancePort.meshHttp)", "AIRLOCK_DIR=/airlock", "DENO_DIR=/airlock-deno-dir", "PORT=\(mecha.#AppliancePort.airlock)"],
									[if len(B.cluster.state.bridges) > 0 {"AIRLOCK_TARGET=docker"}],
								])
								depends_on: {
									"airlock-upgrade": condition: "process_completed_successfully"
									"airlock-mesh": condition:    "process_healthy"
								}
								readiness_probe: _ready & {exec: command: "portcheck --port \(mecha.#AppliancePort.airlock)"}
								availability: restart: "on_failure"
							}
						}
						// The timers' check from the script the image carries, its
						// connection the base process's.
						if _timers {
							"timer-check": command: (_command & {args: ["psql", "-X", "--set=ON_ERROR_STOP=1", "--single-transaction", "--file=/timer-check.sql"]}).out
						}
						if _wakes {
							ticker: {
								command: (_command & {args: ["ticker-deno", "run", "--frozen", "--allow-net", "--allow-env", "main.ts"]}).out
								working_dir: "/ticker-app"
								environment: list.Concat([
									["CRUD_URL=http://crud:3000", "CALL_TIMEOUT_MS=\(B.cluster.meta.bounds.tickerCallMs)", "SERVICE_JWT=${SERVICE_JWT:-\(mecha.#DevServiceJwt)}", "DENO_DIR=/ticker-deno-dir", "PORT=\(mecha.#AppliancePort.ticker)"],
									[[if _effects {"WAKE_URLS=http://airlock:\(mecha.#AppliancePort.airlock)/healthz"}, "WAKE_URLS="][0]],
								])
								depends_on: crud: condition: "process_healthy"
								readiness_probe: _ready & {exec: command: "portcheck --port \(mecha.#AppliancePort.ticker)"}
								availability: restart: "on_failure"
							}
							// The clock's poke, at the cadence compose's clock keeps. A
							// refused one ends the clock, which its restart makes visible.
							clock: {
								// A script, since process-compose expands variables in commands.
								command: (_command & {args: ["/usr/local/bin/appliance-clock.sh"]}).out
								environment: ["SERVICE_JWT=${SERVICE_JWT:-\(mecha.#DevServiceJwt)}"]
								depends_on: ticker: condition: "process_healthy"
								availability: restart: "on_failure"
							}
						}
					}
				}
				// The secrets an effect declares, which the airlock inherits from the
				// container: the appliance does not start without one, as compose's
				// airlock does not (process-compose substitutes no `:?` refusal).
				let _secretCheck = [if len(_secrets) > 0 {"'for k in \(strings.Join(_secrets, " ")); do' '  eval \"v=\\${$k:-}\"' '  [ -n \"$v\" ] || { echo \"appliance: $k is required: an effect declares it\" >&2; exit 1; }' 'done' "}, ""][0]
				let _hosts = strings.Join(list.Concat([["crud", "database", "auth"], if _effects {["airlock-mesh", "airlock"]}, if _wakes {["ticker"]}, [for c, _ in _containers {c}]]), " ")
				"release-docker": core.#target & {
					activate: ""
					deps: list.Concat([
						[":database", ":crud", ":caddy"],
						if _pgroll != _|_ {[":\(_pgroll.target):outs"]},
						// Image-only: these images keep their files outside the
						// monorepo tree, which a workdir dependency copies.
						if B.cluster.meta.served != _|_ {[":served-release:outs"]},
						if B.cluster.capabilities.auth {[":auth:outs"]},
						if _effects {[":airlock:outs", ":airlock-mesh:outs", ":airlock-upgrade:outs"]},
						if _capture {[":mesh-events:outs", ":conduit:outs"]},
						if _streams {[":transform:outs"]},
						if _wakes {[":ticker:outs"]},
						if _timers {[":timer-check:outs"]},
						if _compute {[":compute:outs"]},
						[for c, _ in _containers {":\(c)-appliance:outs"}],
					])
					srcs: globs: list.Concat([[".bayt/process-compose.yaml"], if _capture {["docker/*.yaml"]}, _computed])
					compose: {
						manual: true
						// mecha's extensions image, which the runtime's targets are not.
						build: additional_contexts: "libraries_mecha-extensions-image": B._mechaContexts["libraries_mecha-extensions-image"]
						ports: ["${PORT:-8080}:${PORT:-8080}"]
						image: "${BAYT_DOCKER_REPOSITORY:-ghcr.io/bonisoft3/\(B.meta.app)}:${BAYT_IMAGE_TAG:-latest}"
					}
					dockerfile: core.nubox & {
						defaultPreamble: "zypper-postgres": (zypper.#install & {
							pkgs: list.Concat([
								[
									"postgresql18-server=\(mecha.#AppliancePostgres)",
									"postgresql18-contrib=\(mecha.#AppliancePostgres)",
									"libopenssl3=3.5.0-160000.10.1",
								],
								// The bus's store; Redis's own image links musl.
								[if _capture {"redis=8.2.0-bp160.1.3"}],
							])
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
								{from: {ref: ":crud"}, srcs: ["/bin/postgrest"], dst: "/usr/local/bin/postgrest"},
								{from: {ref: ":caddy"}, srcs: ["/usr/bin/caddy"], dst: "/usr/bin/caddy"},
								{from: {ref: ":caddy"}, srcs: ["/etc/caddy/Caddyfile"], dst: "/etc/caddy/Caddyfile"},
								{srcs: [".bayt/process-compose.yaml"], dst: "/.bayt/process-compose.yaml"},
								// pljs as `plv8` and pg_ivm, which leap ships without, built once by
								// mecha against this same server (mecha.#AppliancePostgres).
								{from: name: "libraries_mecha-extensions-image", srcs: ["/pg-extensions/lib/"], dst: "/usr/lib/postgresql18/lib64/"},
								{from: name: "libraries_mecha-extensions-image", srcs: ["/pg-extensions/extension/"], dst: "/usr/share/postgresql18/extension/"},
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
							// pgroll, its runner and the program's forward migrations, from the
							// image compose's migrate service runs.
							if _pgroll != _|_ {[
								{from: {ref: ":\(_pgroll.target)"}, srcs: [_pgroll.dir], dst: _pgroll.dir},
								{from: {ref: ":\(_pgroll.target)"}, srcs: ["/migrate.sh"], dst: "/migrate.sh"},
								{from: {ref: ":\(_pgroll.target)"}, srcs: ["/usr/local/bin/pgroll"], dst: "/usr/local/bin/pgroll"},
							]},
							// The airlock's own Deno and cache, apart from auth's, the
							// handlers and manifest, its daprd with the effects' bindings,
							// and the ledger's upgrade.
							if _effects {[
								{from: {ref: ":airlock"}, srcs: ["/usr/bin/deno"], dst: "/usr/local/bin/airlock-deno"},
								{from: {ref: ":airlock"}, srcs: ["/deno-dir"], dst: "/airlock-deno-dir"},
								{from: {ref: ":airlock"}, srcs: ["/app"], dst: "/app"},
								{from: {ref: ":airlock"}, srcs: ["/airlock"], dst: "/airlock"},
								{from: {ref: ":airlock-mesh"}, srcs: ["/daprd"], dst: "/daprd"},
								{from: {ref: ":airlock-mesh"}, srcs: ["/dapr"], dst: "/dapr"},
								{from: {ref: ":airlock-upgrade"}, srcs: ["/airlock-upgrade.sql"], dst: "/airlock-upgrade.sql"},
							]},
							// The change feed's binaries and mecha's files, where the processes'
							// overrides name them, and the app's pipeline files beside its tree.
							if _capture {[
								{from: {ref: ":mesh-events"}, srcs: ["/daprd"], dst: "/usr/local/bin/daprd"},
								{from: {ref: ":mesh-events"}, srcs: ["/dapr/components/"], dst: "/mesh-events/dapr/components/"},
								{from: {ref: ":conduit"}, srcs: ["/app/conduit"], dst: "/usr/local/bin/conduit"},
								{from: {ref: ":conduit"}, srcs: ["/app/connectors/"], dst: "/usr/local/bin/"},
								// The pipelines alone: the app's own docker/Caddyfile, which the
								// door prefers where it is, would bring back the renderer the
								// appliance's edited one drops.
								{srcs: ["docker/*.yaml"], dst: "docker/"},
							]},
							if _streams {[
								{from: {ref: ":transform"}, srcs: ["/redpanda-connect"], dst: "/usr/local/bin/redpanda-connect"},
								{from: {ref: ":transform"}, srcs: ["/cdc-trace.yaml"], dst: "/transform/cdc-trace.yaml"},
							]},
							// The timers' check, which the overlay's timer-check runs.
							if _timers {[
								{from: {ref: ":timer-check"}, srcs: ["/timer-check.sql"], dst: "/timer-check.sql"},
							]},
							// Compute's app, its cache and DuckDB's extensions, its sibling
							// sources where its imports reach them, and the program's
							// computations where the environment names them.
							if _compute {list.Concat([
								[
									{from: {ref: ":compute"}, srcs: ["/app/"], dst: "/compute-app/"},
									// One cache, content-addressed, beside auth's.
									{from: {ref: ":compute"}, srcs: ["/deno-dir"], dst: "/deno-dir"},
									{from: {ref: ":compute"}, srcs: ["/durex"], dst: "/durex"},
									{from: {ref: ":compute"}, srcs: ["/packages"], dst: "/packages"},
								],
								[if !B.cluster.capabilities.auth {{from: {name: core.lock.images.deno_bin}, srcs: ["/deno"], dst: "/usr/local/bin/deno"}}],
								[for f in _computed {srcs: [f], dst: f}],
							])},
							// The ticker, with its own Deno and cache.
							if _wakes {[
								{from: {ref: ":ticker"}, srcs: ["/usr/bin/deno"], dst: "/usr/local/bin/ticker-deno"},
								{from: {ref: ":ticker"}, srcs: ["/deno-dir"], dst: "/ticker-deno-dir"},
								{from: {ref: ":ticker"}, srcs: ["/app"], dst: "/ticker-app"},
							]},
							[for c, a in _containers for f in a.srcs {from: {ref: ":\(c)-appliance"}, srcs: [f], dst: f}],
						])
						preamble: list.Concat([
							// The AI gateway is no process of the appliance yet, so an
							// effect answered through it would never run.
							if _ai {[
								#"RUN echo "release@docker does not yet run the AI gateway; refusing to omit a runtime service" >&2 && exit 1"#,
							]},
							// An answer's bytes go to the blob plane, which the appliance
							// does not run.
							if _effects && _blobs {[
								#"RUN echo "release@docker does not yet run the blob plane an effect's answer is stored in; refusing to omit a runtime service" >&2 && exit 1"#,
							]},
							// The computations on DuckDB snapshots, as launch@local runs them:
							// compute and the transform reading its invalidations both find
							// its app and extensions here, the container's environment.
							if _compute {[
								"ENV COMPUTE_APP_DIR=/compute-app",
								"ENV BAYT_LOCAL_DUCKDB_EXTENSIONS=/compute-app/extensions",
								"ENV DENO_DIR=/deno-dir",
							]},
							if _capture {[
								"ENV MECHA_MESH_DIR=/mesh-events",
								"ENV MECHA_TRANSFORM_DIR=/transform",
							]},
							if _overlaid {[
								"COPY <<'APPLIANCE' /.bayt/process-compose.appliance.yaml\n\(yaml.Marshal(_overlay))APPLIANCE",
							]},
							if _wakes {[
								#"RUN printf '%s\n' '#!/bin/sh' 'set -e' 'while sleep "${POKE_INTERVAL_SECONDS:-60}"; do' '  curl -fsS -X POST -H "Authorization: Bearer ${SERVICE_JWT}" "http://ticker:\#(mecha.#AppliancePort.ticker)/poke?caller=appliance" >/dev/null || { echo "clock: the ticker refused its poke" >&2; exit 1; }' 'done' > /usr/local/bin/appliance-clock.sh && chmod 755 /usr/local/bin/appliance-clock.sh"#,
							]},
							[
								"ENV PATH=/usr/lib/postgresql18/bin:/usr/local/bin:$PATH",
								"ENV PGDATA=/var/lib/pgsql/data",
								"ENV DATABASE_PG_PORT=5432",
								"ENV CRUD_HTTP_PORT=3000",
								"ENV CRUD_ADMIN_PORT=3001",
								"ENV AUTH_HTTP_PORT=9999",
								"ENV CADDY_HTTP_PORT=8080",
								"ENV PORT=8080",
								"ENV ORIGIN=http://localhost:8080",
								"ENV CADDY_TLS_HOST_PORT=8080",
								// The door's own config, edited below: an app's docker/Caddyfile,
								// which caddy prefers where a tree brings it, keeps the renderer.
								"ENV CADDY_CONFIG_FILE=/etc/caddy/Caddyfile",
							],
							if B.cluster.capabilities.auth {[
								"ENV DENO_DIR=/deno-dir",
							]},
						])
						epilogue: [
							// The temporary server starts with the server's options.
							#"RUN printf '%s\n' '#!/bin/sh' 'set -e' 'if [ "$1" = "postgres" ]; then shift; fi' 'export PGDATA="${PGDATA:-/var/lib/pgsql/data}"' 'export POSTGRES_DB="${POSTGRES_DB:-\#(B.meta.app)}"' 'export PATH="/usr/lib/postgresql18/bin:$PATH"' 'q=$(printf "\047")' 'if [ ! -s "$PGDATA/PG_VERSION" ]; then' '  mkdir -p "$PGDATA" /run/postgresql' '  chown -R postgres:postgres "$PGDATA" /run/postgresql' '  setpriv --reuid=postgres --regid=postgres --clear-groups initdb -D "$PGDATA" --no-sync --encoding=UTF8 --auth=trust --locale-provider=icu --icu-locale=und --locale=C' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -w -o "-c listen_addresses='\'''\'' $*" start' '  if [ "$POSTGRES_DB" != "postgres" ]; then setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\""; fi' '  setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS _pronto_migrations (name text primary key, applied_at timestamptz default now())"' '  for f in /docker-entrypoint-initdb.d/*.sql; do' '    if [ -f "$f" ]; then' '      echo "Applying $f..."' '      setpriv --reuid=postgres --regid=postgres --clear-groups psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -f "$f"' '      base=$(basename "$f")' '      setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "INSERT INTO _pronto_migrations (name) VALUES ($q$base$q) ON CONFLICT DO NOTHING"' '    fi' '  done' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -m fast -w stop' 'else' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -w -o "-c listen_addresses='\'''\'' $*" start' '  setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS _pronto_migrations (name text primary key, applied_at timestamptz default now())"' '  for f in /docker-entrypoint-initdb.d/*.sql; do' '    if [ -f "$f" ]; then' '      base=$(basename "$f")' '      case "$base" in *seed*) continue;; esac' '      applied=$(setpriv --reuid=postgres --regid=postgres --clear-groups psql -t -A -U postgres -d "$POSTGRES_DB" -c "SELECT count(*) FROM _pronto_migrations WHERE name = $q$base$q")' '      if [ "$applied" = "0" ]; then' '        echo "Applying pending migration $f..."' '        setpriv --reuid=postgres --regid=postgres --clear-groups psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -f "$f"' '        setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "INSERT INTO _pronto_migrations (name) VALUES ($q$base$q)"' '      fi' '    fi' '  done' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -m fast -w stop' 'fi' 'exec setpriv --reuid=postgres --regid=postgres --clear-groups postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 "$@"' > /usr/local/bin/docker-entrypoint.sh && chmod 755 /usr/local/bin/docker-entrypoint.sh"#,
							#"RUN printf '%s\n' '#!/bin/sh' 'if [ "$1" = "microcheck" ]; then' '  shift' '  exec "$@"' 'fi' 'exec "$@"' > /usr/local/bin/bayt && chmod 755 /usr/local/bin/bayt"#,
							// nu, wherever mise installed it, by its own account.
							#"RUN cp "$(/root/.local/share/lazybox/bin/nu -c '$nu.current-exe')" /usr/local/bin/nu && chmod 755 /usr/local/bin/nu && /usr/local/bin/nu --version"#,
							#"RUN printf '%s\n' '#!/bin/sh' 'while [ $# -gt 0 ]; do if [ "$1" = "--" ]; then shift; break; fi; shift; done' 'exec "$@"' > /usr/local/bin/mise && chmod 755 /usr/local/bin/mise"#,
							"RUN printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/task && chmod 755 /usr/local/bin/task",
							#"RUN printf '%s\n' '#!/bin/sh' 'set -e' 'for n in \#(_hosts); do' '  grep -Eq "^[^#]*[[:space:]]$n([[:space:]]|$)" /etc/hosts || echo "127.0.0.1 $n" >> /etc/hosts || { echo "appliance: cannot name $n in /etc/hosts" >&2; exit 1; }' 'done' \#(_secretCheck)'export PORT="${PORT:-8080}"' 'export CADDY_HTTP_PORT="${PORT}"' 'export CADDY_TLS_HOST_PORT="${PORT}"' 'if [ -n "$ORIGIN" ]; then' '  if [ -z "$WEBAUTHN_RP_ID" ]; then' '    h="${ORIGIN#*://}"' '    h="${h%%/*}"' '    h="${h%%:*}"' '    if [ -n "$h" ] && [ "$h" != "localhost" ]; then export WEBAUTHN_RP_ID="$h"; fi' '  fi' '  if [ -z "$WEBAUTHN_ORIGIN" ] && [ -n "$WEBAUTHN_RP_ID" ] && [ "$WEBAUTHN_RP_ID" != "localhost" ]; then export WEBAUTHN_ORIGIN="$ORIGIN"; fi' 'fi' 'exec "$@"' > /usr/local/bin/appliance-entrypoint.sh && chmod 755 /usr/local/bin/appliance-entrypoint.sh"#,
							#"RUN sed -Ei 's|http://127\.0\.0\.1:\$\{CADDY_HTTP_PORT:-[0-9]+\}/health|http://127.0.0.1:${PORT:-8080}/health|g' /.bayt/process-compose.yaml"#,
							// The appliance runs no renderer: its handler goes, braces counted,
							// since a handler holds nested blocks a line match would cut short.
							#"RUN awk 'skip { d += gsub(/\{/, "{") - gsub(/\}/, "}"); if (d <= 0) skip = 0; next } /handle @rendered \{/ { skip = 1; d = 1; next } { print }' /etc/caddy/Caddyfile > /tmp/Caddyfile && mv /tmp/Caddyfile /etc/caddy/Caddyfile"#,
							#"RUN awk '/handle \/electric\/\* \{/{p=1; d=1; print "  handle /electric/* {\n    header Content-Type application/json\n    header electric-handle stub\n    header electric-offset 0_0\n    header electric-cursor 0\n    header electric-schema `{\"id\":{\"type\":\"text\"}}`\n    header electric-up-to-date true\n    header Access-Control-Allow-Origin *\n    header Access-Control-Expose-Headers \"electric-handle, electric-offset, electric-cursor, electric-schema, electric-up-to-date, content-type, cache-control, x-txid\"\n\n    @subset query subset__where=*\n    handle @subset {\n      respond `{\"metadata\":{\"xmin\":\"1\",\"xmax\":\"1\",\"xip_list\":[],\"snapshot_mark\":0,\"database_lsn\":\"0\"},\"data\":[]}` 200\n    }\n    handle {\n      respond `[{\"headers\":{\"control\":\"up-to-date\"}}]` 200\n    }\n  }"; next} p { d += gsub(/\{/, "{") - gsub(/\}/, "}"); if (d <= 0) p = 0; next } {print}' /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.tmp && mv /etc/caddy/Caddyfile.tmp /etc/caddy/Caddyfile"#,
							// The extensions came with compute's image: it installs none at start.
							if _compute {"RUN touch /compute-app/extensions/\(mecha.#DuckdbExtensionsMarker)"},
							// A bridge's port is no port an appliance process takes, the ones bayt
							// assigns the app included, and no other bridge's.
							if len(_bridges) > 0 {
								#"RUN ports="\#(strings.Join([for _, a in _containers {"\(a.port)"}], " "))"; for p in $ports; do if grep -Eq ":-$p\}" /.bayt/process-compose.yaml; then echo "appliance: bridge port $p is one an appliance process takes; name another" >&2; exit 1; fi; done; dup="$(printf '%s\n' $ports | sort | uniq -d)"; if [ -n "$dup" ]; then echo "appliance: bridges share port $dup" >&2; exit 1; fi"#
							},
							// Every edit above leaves a Caddyfile the door can load, or the image fails here.
							"RUN caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile",
						]
						entrypoint: ["/usr/local/bin/appliance-entrypoint.sh"]
						cmd: list.Concat([
							["/usr/local/bin/process-compose", "up", "-f", "/.bayt/process-compose.yaml"],
							[if _overlaid for a in ["-f", "/.bayt/process-compose.appliance.yaml"] {a}],
							["-t=false", "--no-server", "caddy"],
							[if B.cluster.capabilities.auth {"auth"}],
							[if _effects {"airlock"}],
							[if _capture {"conduit"}],
							[if _streams {"transform"}],
							[if _compute {"compute"}],
							if _wakes {["ticker", "clock"]},
						])
					}
				}
			}
		}
	}
}
