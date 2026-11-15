package pronto

// A check that runs code of a platform tree runs it under that tree's own
// config and lock, found where mise puts the tree as the command runs
// (docs/monorepo.md#commands-find-the-platform-with-mise-where): the
// checkout's tree under mise.local.toml, the pinned release in a mirror. The
// binding is `$<tree>`. A loop check is a sayt rule, with tools.nu on its
// include path; a check beside the stack runs under `mise x`, with mise on
// PATH and the config already trusted.
#Platform: {
	let P = self
	tree:  "pronto" | "omnishell" | "mecha"
	rule:  "use tools.nu [run-mise]; let \(P.tree) = (run-mise where github:bonisoft3/\(P.tree) | str trim)"
	check: "let \(P.tree) = (^mise where github:bonisoft3/\(P.tree) | str trim)"
	...
}

// omnishell's test harness, the environment an app's tests run in when they
// import `@bonisoft3/omnishell/`: its test config, which maps that name onto
// its tree, and its test lock, frozen.
#Harness: (#Platform & {tree: "omnishell"}) & {
	flags: "--config ($omnishell | path join test deno.json) --lock ($omnishell | path join test deno.lock) --frozen"
}

// Cross-tree environment for checks that reach more than one platform tree at
// once: maps each installed tree by its `mise where` path at execution time
// and holds external specifiers against the app's `tests/deno.lock`.
#Platforms: {
	let _url = "str replace --all '\\' '/' | str trim --left --char '/' | str replace --all ' ' '%20' | prepend 'file:///' | append"
	let _ext = "path join | open | get imports | transpose k v | where {|r| $r.v !~ '^\\.' } | transpose --header-row --as-record"
	rule:  "use tools.nu [run-mise]; let pronto = (run-mise where github:bonisoft3/pronto | str trim); let omnishell = (run-mise where github:bonisoft3/omnishell | str trim); let mecha = (run-mise where github:bonisoft3/mecha | str trim)"
	check: "let pronto = (^mise where github:bonisoft3/pronto | str trim); let omnishell = (^mise where github:bonisoft3/omnishell | str trim); let mecha = (^mise where github:bonisoft3/mecha | str trim)"
	flags: "--no-config --import-map ([([$pronto deno.json] | \(_ext)) ([$mecha services compute deno.json] | \(_ext)) {'@bonisoft3/pronto/': ($pronto | \(_url) '/' | str join) '@bonisoft3/omnishell/': ($omnishell | \(_url) '/' | str join) '@bonisoft3/mecha/': ($mecha | \(_url) '/' | str join) '@mecha/compute/': ($mecha | \(_url) '/services/compute/' | str join) '@mecha/client/types': ($mecha | \(_url) '/services/compute/portable-contract.ts' | str join)}] | into record | {imports: $in} | to json --raw | url encode | prepend 'data:application/json,' | str join) --lock tests/deno.lock --frozen"
}
