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
	deno "github.com/bonisoft3/bayt/stacks/deno"
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
	tools: {"github:bonisoft3/bayt": "0.68.2", ...}
	hostTools: {"github:F1bonacc1/process-compose": "v1.122.0", ...}
	say: say: {
		...

		// The commands restated: a rule the config names replaces sayt's
		// builtin of that name, so the priority alone would leave bayt unrun.
		generate: rulemap: {"auto-bayt": {priority: 2, cmds: [{use: "./auto-bayt.nu", do: "auto-bayt"}]}, ...}
	}
}

// apps/deno.json maps the platform URLs an app's checks import to these trees
// (docs/component-contracts.md#platform-pins).
#CompilerSources: {
	paths: ["cue.mod", "apps/deno.json", "apps/*/tests/deno.json", "plugins/pronto", "plugins/omnishell", "plugins/bayt", "plugins/sayt", "libraries/mecha"]
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
				"pronto-host-mise": {glob: ".mise.host.toml"}
				"pronto-host-lock": {glob: "mise.host.lock"}
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
		let watch = ("--watch" in $arguments) or ("-w" in $arguments)
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
		if $watch {
		  try {
		    with-env $pc_env {
		      ^$pc_bin --no-server -t=false -L ($work | path join "pc.log") -f .bayt/process-compose.yaml -f ($work | path join "pc-logs.yaml") up launch
		    }
		  } catch {|e|
		    dump-logs $work
		    cleanup-work $work
		    rm -f $state_file
		    error make {msg: ($e.msg? | default ($e | to text))}
		  }
		  cleanup-work $work
		  rm -f $state_file
		} else {
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
		[for s, _ in mecha.published if s != "activepieces" {"libraries_mecha-\(s)-image_bayt"}],
		["libraries_mecha-activepieces-image_bayt"],
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
	_runtimeStatics: [for s in B.terminalStatics if strings.HasPrefix(s.target, "/omnishell/") {s}]

	project: core.#project & sayt.gate & {
		files: "say.yaml": say: {for verb in ["launch", "integrate"] {
			(verb): rulemap: {
				builtin: {
					stop: true
					cmds: [{use: "./bayt-task.nu", do: "bayt-task \(verb)-action --generate"}]
				}
				host: {
					platform: "host"
					stop:     true
					cmds: [{use: "./bayt-task.nu", do: "with-env { MISE_ENV: 'host' } { ^mise install; bayt-task \(verb) --generate }"}]
				}
			}
		}}
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
				// No :build dep. The screens this photographs are checked-in
				// artifacts the srcs below carry, and the build verb regenerates
				// them before integrate runs — depending on the build image would
				// couple visual lint to a toolchain it does not use. The plane it
				// drives is an image-only dep, so the entry closure carries every
				// fragment the aggregate waits on and loads on its own — the bkid
				// tier runs it that way.
				deps: [":launch:outs"]
				taskfile: incremental: false
				srcs: globs: ["shell/shell.yaml", "shell/screens/**"]
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

				// The image is the base, which carries the toolchain, and omnishell's
				// tree, which the tests import from /omnishell (tests/deno.json
				// maps `omnishell/` there).
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
								{from: {ref: ":crud"}, srcs: ["/bin/postgrest"], dst: "/usr/local/bin/postgrest"},
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
							// The appliance runs no airlock, so a program's effects would
							// claim their ledger and never run: the release is refused,
							// as k8s's and gcp's are, rather than shipped silently inert.
							if len(B.cluster.state.effects) > 0 {[
								#"RUN echo "release@docker does not yet deploy airlock; refusing to omit a runtime service" >&2 && exit 1"#,
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
							],
							if B.cluster.capabilities.auth {[
								"ENV DENO_DIR=/deno-dir",
							]},
						])
						epilogue: [
							#"RUN printf '%s\n' '#!/bin/sh' 'set -e' 'export PGDATA="${PGDATA:-/var/lib/pgsql/data}"' 'export POSTGRES_DB="${POSTGRES_DB:-\#(B.meta.app)}"' 'export PATH="/usr/lib/postgresql18/bin:$PATH"' 'q=$(printf "\047")' 'if [ ! -s "$PGDATA/PG_VERSION" ]; then' '  mkdir -p "$PGDATA" /run/postgresql' '  chown -R postgres:postgres "$PGDATA" /run/postgresql' '  setpriv --reuid=postgres --regid=postgres --clear-groups initdb -D "$PGDATA" --no-sync --encoding=UTF8 --auth=trust --locale-provider=icu --icu-locale=und --locale=C' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -w -o "-c listen_addresses='\'''\''" start' '  if [ "$POSTGRES_DB" != "postgres" ]; then setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\""; fi' '  setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS _pronto_migrations (name text primary key, applied_at timestamptz default now())"' '  for f in /docker-entrypoint-initdb.d/*.sql; do' '    if [ -f "$f" ]; then' '      echo "Applying $f..."' '      setpriv --reuid=postgres --regid=postgres --clear-groups psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -f "$f"' '      base=$(basename "$f")' '      setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "INSERT INTO _pronto_migrations (name) VALUES ($q$base$q) ON CONFLICT DO NOTHING"' '    fi' '  done' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -m fast -w stop' 'else' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -w -o "-c listen_addresses='\'''\''" start' '  setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS _pronto_migrations (name text primary key, applied_at timestamptz default now())"' '  for f in /docker-entrypoint-initdb.d/*.sql; do' '    if [ -f "$f" ]; then' '      base=$(basename "$f")' '      case "$base" in *seed*) continue;; esac' '      applied=$(setpriv --reuid=postgres --regid=postgres --clear-groups psql -t -A -U postgres -d "$POSTGRES_DB" -c "SELECT count(*) FROM _pronto_migrations WHERE name = $q$base$q")' '      if [ "$applied" = "0" ]; then' '        echo "Applying pending migration $f..."' '        setpriv --reuid=postgres --regid=postgres --clear-groups psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -f "$f"' '        setpriv --reuid=postgres --regid=postgres --clear-groups psql -U postgres -d "$POSTGRES_DB" -c "INSERT INTO _pronto_migrations (name) VALUES ($q$base$q)"' '      fi' '    fi' '  done' '  setpriv --reuid=postgres --regid=postgres --clear-groups pg_ctl -D "$PGDATA" -m fast -w stop' 'fi' 'if [ "$1" = "postgres" ]; then shift; fi' 'exec setpriv --reuid=postgres --regid=postgres --clear-groups postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 "$@"' > /usr/local/bin/docker-entrypoint.sh && chmod 755 /usr/local/bin/docker-entrypoint.sh"#,
							#"RUN printf '%s\n' '#!/bin/sh' 'if [ "$1" = "microcheck" ]; then' '  shift' '  exec "$@"' 'fi' 'exec "$@"' > /usr/local/bin/bayt && chmod 755 /usr/local/bin/bayt"#,
							#"RUN /root/.local/share/lazybox/bin/nu --version && cp "$(find /root/.local/share/mise/installs -name nu -type f | head -n 1)" /usr/local/bin/nu && chmod 755 /usr/local/bin/nu"#,
							#"RUN printf '%s\n' '#!/bin/sh' 'while [ $# -gt 0 ]; do if [ "$1" = "--" ]; then shift; break; fi; shift; done' 'exec "$@"' > /usr/local/bin/mise && chmod 755 /usr/local/bin/mise"#,
							"RUN printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/task && chmod 755 /usr/local/bin/task",
							#"RUN printf '%s\n' '#!/bin/sh' 'set -e' 'if ! grep -q "crud" /etc/hosts 2>/dev/null; then' '  echo "127.0.0.1 crud database auth" >> /etc/hosts 2>/dev/null || true' 'fi' 'export PORT="${PORT:-8080}"' 'export CADDY_HTTP_PORT="${PORT}"' 'export CADDY_TLS_HOST_PORT="${PORT}"' 'if [ -n "$ORIGIN" ]; then' '  if [ -z "$WEBAUTHN_RP_ID" ]; then' '    h="${ORIGIN#*://}"' '    h="${h%%/*}"' '    h="${h%%:*}"' '    if [ -n "$h" ] && [ "$h" != "localhost" ]; then export WEBAUTHN_RP_ID="$h"; fi' '  fi' '  if [ -z "$WEBAUTHN_ORIGIN" ] && [ -n "$WEBAUTHN_RP_ID" ] && [ "$WEBAUTHN_RP_ID" != "localhost" ]; then export WEBAUTHN_ORIGIN="$ORIGIN"; fi' 'fi' 'exec "$@"' > /usr/local/bin/appliance-entrypoint.sh && chmod 755 /usr/local/bin/appliance-entrypoint.sh"#,
							#"RUN sed -Ei 's|http://127\.0\.0\.1:\$\{CADDY_HTTP_PORT:-[0-9]+\}/health|http://127.0.0.1:${PORT:-8080}/health|g' /.bayt/process-compose.yaml"#,
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
