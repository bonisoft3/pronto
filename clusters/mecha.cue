// Pronto's cluster roster, by indirection: each file here re-exports one
// virtual-cluster implementation from its product home. Pronto owns the
// list; the implementations own themselves (mecha's lives in
// bonisoft3/mecha). Consumers import github.com/bonisoft3/pronto/clusters:<name>.
//
// The seam pronto relies on: #Cluster is the compose topology with every
// service an addressable field — escape hatches unify services in, and the
// emitter derives the data plane from the program against it: migrations in
// mecha's canonical order (seeding pipeline-written singletons, since
// pipelines only fire on CDC), CDC for all server-side entities, and one
// idempotent stream transform per program pipeline. Schema evolution
// (pgroll) is mecha's reserved surface.
package mecha

import (
	"encoding/base64"
	"strings"
	impl "github.com/bonisoft3/mecha:cluster"
	ivm "github.com/bonisoft3/mecha/packages/incremental-views:incremental_views"
	pljs "github.com/bonisoft3/mecha/services/database/pljs"
	toolchain "github.com/bonisoft3/mecha/toolchain"
)

_nuPostinstall: {
	name:   string
	script: string
	let _b64 = base64.Encode(null, script)
	let _f = ".postinstall-\(name).nu"
	out: "nu -c \"'\(_b64)' | decode base64 | decode utf-8 | save -f \(_f); ^nu \(_f); rm -f \(_f)\""
}

// A string as a nushell expression: base64, since the parser counts quotes
// and brackets inside raw strings.
_nuString: {
	v:   string
	out: "('\(base64.Encode(null, v))' | decode base64 | decode utf-8)"
}

_postgrestScript: #"""
	if $nu.os-info.name == "macos" {
	  let bin = ($env.MISE_TOOL_INSTALL_PATH | path join "postgrest")
	  ^install_name_tool -change /opt/homebrew/opt/libpq/lib/libpq.5.dylib "@executable_path/../../github-theseus-rs-postgresql-binaries/18.6.1/lib/libpq.5.dylib" $bin
	  ^install_name_tool -change /usr/local/opt/libpq/lib/libpq.5.dylib "@executable_path/../../github-theseus-rs-postgresql-binaries/18.6.1/lib/libpq.5.dylib" $bin
	  ^codesign --force -s - $bin
	}
	"""#

_postgresScript: #"""
	let os = (match $nu.os-info.name { "macos" => "macos", "windows" => "windows", _ => "linux" })
	let dlext = (match $os { "macos" => "dylib", "windows" => "dll", _ => "so" })
	let pg_dir = $env.MISE_TOOL_INSTALL_PATH
	let tmp = ($nu.temp-dir | path join $"mise-pg-build-($nu.pid)-(random int 1000..9999)")
	mkdir $tmp
	try {
	  let pljs = ($tmp | path join "pljs")
	  ^git clone --depth 1 --branch \#(pljs.#Source.tag) --recurse-submodules \#(pljs.#Source.repo) $pljs
	  let pljs_rev = (^git -C $pljs rev-parse HEAD | str trim)
	  if $pljs_rev != "\#(pljs.#Source.commit)" { error make { msg: $"unexpected pljs commit for \#(pljs.#Source.tag): ($pljs_rev)" } }
	  let fn_c = ($pljs | path join "src/functions.c")
	  let needle = \#((_nuString & {v: pljs.#Needle}).out)
	  let inject = ([$needle \#(strings.Join([for l in pljs.#AliasLines {(_nuString & {v: l}).out}], " "))] | str join "\n")
	  let aliased = (open --raw $fn_c | str replace $needle $inject)
	  if ($aliased | split row \#((_nuString & {v: pljs.#AliasMarker}).out) | length) != 2 { error make { msg: "pljs alias needle moved: functions.c gained no plv8 global" } }
	  $aliased | save -f $fn_c
	  let pljs_c = ($pljs | path join "src/pljs.c")
	  let errors_needle = \#((_nuString & {v: pljs.#Errors.needle}).out)
	  let errors = ([$errors_needle \#(strings.Join([for l in pljs.#Errors.lines {(_nuString & {v: l}).out}], " "))] | str join "\n")
	  let errors_pattern = \#((_nuString & {v: pljs.#Errors.pattern}).out)
	  let errors_replacement = \#((_nuString & {v: pljs.#Errors.replacement}).out)
	  let raised = (open --raw $pljs_c | str replace $errors_needle $errors | str replace -a -r $errors_pattern $errors_replacement)
	  if ($raised | split row \#((_nuString & {v: pljs.#Errors.marker}).out) | length) != \#(pljs.#Errors.sites + 1) { error make { msg: "pljs error sites changed" } }
	  $raised | save -f $pljs_c
	  let ivm_tgz = ($tmp | path join "pg_ivm.tar.gz")
	  http get --raw "\#(ivm.#Source.url)" | save -f $ivm_tgz
	  let ivm_got = (open --raw $ivm_tgz | hash sha256)
	  if $ivm_got != "\#(ivm.#Source.sha256)" { error make { msg: $"sha256 mismatch for pg_ivm: got ($ivm_got)" } }
	  ^tar -xzf $ivm_tgz -C $tmp
	  let ivm_dir = ($tmp | path join "pg_ivm-\#(ivm.#Source.commit)")
	  if $os == "windows" {
	    let ch = ($pg_dir | path join "include/server/c.h")
	    open --raw $ch | str replace -a "#ifdef __MINGW64__" "#if 0" | save -f $ch
	    let tc = ($pljs | path join "src/types.c")
	    open --raw $tc | str replace -a "(unsigned long)obj" "(Datum)obj" | save -f $tc
	    with-env { MISE_LOCKED: "0" } {
	      ^mise x zig@0.14.0 -- zig cc -target x86_64-windows-gnu -shared -O2 -Wno-implicit-function-declaration -D_GNU_SOURCE '-DCONFIG_VERSION="2025-04-26"' '-DPLJS_VERSION="\#(pljs.#Version)"' -DJSONB_DIRECT_CONVERSION -DEXPOSE_GC -Dunicode_to_utf8=qjs_unicode_to_utf8 -Dunicode_from_utf8=qjs_unicode_from_utf8 $"-I($pg_dir | path join 'include/server/port/win32')" $"-I($pg_dir | path join 'include/server')" $"-I($pg_dir | path join 'include')" $"-I($pljs)" $"-I($pljs | path join 'deps/quickjs')" ($pljs | path join "deps/quickjs/cutils.c") ($pljs | path join "deps/quickjs/dtoa.c") ($pljs | path join "deps/quickjs/libregexp.c") ($pljs | path join "deps/quickjs/libunicode.c") ($pljs | path join "deps/quickjs/quickjs.c") ($pljs | path join "src/pljs.c") ($pljs | path join "src/cache.c") ($pljs | path join "src/functions.c") ($pljs | path join "src/types.c") ($pljs | path join "src/params.c") ($pg_dir | path join "lib/postgres.lib") -o ($pg_dir | path join $"lib/pljs.($dlext)")
	      ^mise x zig@0.14.0 -- zig cc -target x86_64-windows-gnu -shared -O2 -Wno-ignored-attributes $"-I($pg_dir | path join 'include/server/port/win32')" $"-I($pg_dir | path join 'include/server')" $"-I($pg_dir | path join 'include')" $"-I($ivm_dir)" ($ivm_dir | path join "createas.c") ($ivm_dir | path join "matview.c") ($ivm_dir | path join "pg_ivm.c") ($ivm_dir | path join "ruleutils.c") ($ivm_dir | path join "subselect.c") ($pg_dir | path join "lib/postgres.lib") -o ($pg_dir | path join $"lib/pg_ivm.($dlext)")
	    }
	    mkdir ($pg_dir | path join "share/extension")
	    cp -f ($pljs | path join "pljs.control") ($pg_dir | path join "share/extension/pljs.control")
	    cp -f ($pljs | path join "pljs.sql") ($pg_dir | path join "share/extension/pljs--\#(pljs.#Version).sql")
	    cp -f ($ivm_dir | path join "pg_ivm.control") ($pg_dir | path join "share/extension/pg_ivm.control")
	    glob ($ivm_dir | path join "pg_ivm--*.sql" | str replace -a (char -u 5c) "/") | each {|f| cp -f $f ($pg_dir | path join "share/extension" | path join ($f | path basename)) }
	  } else {
	    if $os == "macos" {
	      let sdk = (^xcrun --show-sdk-path | str trim)
	      let mk = ($pg_dir | path join "lib/pgxs/src/Makefile.global")
	      open --raw $mk | str replace -a -r '-isysroot [^ \t\r\n]+' $"-isysroot ($sdk)" | save -f $mk
	    }
	    do { cd $pljs; \#(strings.Join([for p in pljs.#Patches {"^patch -p1 -i \(p)"}], "; ")) }
	    ^make -C ($pljs | path join "deps/quickjs") -j4 libquickjs.a
	    ^make -C $pljs -j4 $"PG_CONFIG=($pg_dir | path join 'bin/pg_config')" with_llvm=no install
	    ^make -C $ivm_dir -j4 $"PG_CONFIG=($pg_dir | path join 'bin/pg_config')" with_llvm=no install
	  }
	  [\#(strings.Join([for l in pljs.#Control {(_nuString & {v: l}).out}], " "))] | str join "\n" | $in + "\n" | save -f ($pg_dir | path join "share/extension/plv8.control")
	  open --raw ($pg_dir | path join "share/extension/pljs--\#(pljs.#Version).sql") | str replace -a "\#(pljs.#Language.from)" "\#(pljs.#Language.to)" | save -f ($pg_dir | path join "share/extension/plv8--\#(pljs.#Version).sql")
	} catch {|e|
	  rm -rf $tmp
	  error make { msg: ($e.msg? | default ($e | to text)) }
	}
	rm -rf $tmp
	"""#

_redisScript: #"""
	if $nu.os-info.name != "windows" {
	  let d = $env.MISE_TOOL_INSTALL_PATH
	  ^make -C ($d | path join "src") -j4 BUILD_TLS=no USE_SYSTEMD=no MALLOC=libc INSTALL=/usr/bin/install install $"PREFIX=($d)"
	  ^make -C ($d | path join "src") clean
	}
	"""#

#HostTools: {
	...
	"github:xataio/pgroll": {
		version: "v0.16.3"
		bin:     "pgroll"
	}
	"github:dapr/dapr":                             "v1.16.1"
	"github:ConduitIO/conduit":                     "v0.20.4"
	"github:conduitio-labs/conduit-connector-http": "v0.4.0"
	"github:rclone/rclone":                         "v1.71.0"
	"github:axllent/mailpit":                       "v1.32.0"
	"github:PostgREST/postgrest": {
		version:     "v16.5"
		postinstall: (_nuPostinstall & {name: "postgrest", script: _postgrestScript}).out
	}
	"github:theseus-rs/postgresql-binaries": {
		version:     "18.6.1"
		postinstall: (_nuPostinstall & {name: "postgres", script: _postgresScript}).out
	}
	"http:redis": {
		version:     "8.6.2"
		postinstall: (_nuPostinstall & {name: "redis", script: _redisScript}).out
		platforms: {
			for p in ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "macos-x64", "macos-arm64"] {
				"\(p)": url: "https://github.com/redis/redis/archive/refs/tags/{{ version }}.tar.gz"
			}
			"windows-x64": url: "https://github.com/redis-windows/redis-windows/releases/download/8.6.7/Redis-8.6.7-Windows-x64-msys2.zip"
		}
	}
}

#Project: {tools: toolchain.#Tools, hostTools: #HostTools, ...}

#Cluster: impl.#Cluster
#Runtime: impl.#Runtime
#Static:  impl.#Static

// The dev service token, which crud's dev secret verifies.
#DevServiceJwt: impl.#DevServiceJwt

// What a sink's origin may be: the airlock's daprd dials it.
#Origin: impl.#Origin

// What a computation's or an effect's module may be endowed with.
#CageEndowment: impl.#CageEndowment
#ComputationField: impl.#ComputationField

// A bridge role.
#Bridge: impl.#Bridge
#AppliancePort: impl.#AppliancePort
#AppliancePorts: impl.#AppliancePorts
#DuckdbExtensionsMarker: impl.#DuckdbExtensionsMarker
#AppliancePostgres: impl.#AppliancePostgres

// Mecha's AI gateway (services/airlock/tsbifrost.ts) and the tiered AI model schema.
#TsBifrostPort:   impl.#TsBifrostPort
#AiModality:      impl.#AiModality
#AiTier:          impl.#AiTier
#AiBackendTier:   impl.#AiBackendTier
#AiTarget:        impl.#AiTarget
#AiProvider:      impl.#AiProvider
#AiModelSpec:     impl.#AiModelSpec
#AiTierOverrides: impl.#AiTierOverrides
#AiCapability:    impl.#AiCapability

#ConduitSlot:      impl.#ConduitSlot
#MachineTimersSql: impl.#MachineTimersSql

// A machine Mecha runs: XState's configuration and the setup beside it.
#Machine: impl.#Machine
#XState:  impl.#XState
#Shape:   impl.#Shape

// The mecha images an app takes by name, as pronto pins them: the consumer
// pins what it builds on, so a pronto release names a mecha release's images
// and an app pinning pronto gets them through it. One per service of
// impl.#Images, from the pin lines a mecha release prints.
// Those whose targets copy mecha's sources, which a build from a checkout
// carries as each one's srcs view.
#Sourced: impl.#Sourced
#Builds: impl.#Builds
#Images:  impl.#Images

published: impl.#Published & {
	airlock:  "bonitao/mecha-airlock:0.20.6@sha256:b999fe8ff8e7e349f5fc5ed827584567c1c98f16c774884839a854b98ee28b50"
	auth:     "bonitao/mecha-auth:0.20.6@sha256:ef5ff16a08574ef492e82d30ac6d046761cb2482a06fcf754f7f5fe715f936ff"
	clock:    "bonitao/mecha-clock:0.20.6@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.20.6@sha256:ead90c13996630d80ab26ae42f5c36d88d8481753848b31899cf63faab91af28"
	conduit:  "bonitao/mecha-conduit:0.20.6@sha256:c18a81780ff1c066c2dc2f7ed1115ac0333b28b2f6c9fe4c9390708c8f7810a1"
	database: "bonitao/mecha-database:0.20.6@sha256:d3eb729237d5bcdead34c500e4f482b86f4cfce00994b98a7c5a27745880b624"
	mesh:     "bonitao/mecha-mesh:0.20.6@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.20.6@sha256:ddb62e40bb03ac5b77a797c597ca8c088d72edc60154ac4f3ac57e0c8ebc7ce3"
}

#ActivepiecesContainer: impl.#ActivepiecesContainer
