package pronto

// A check that runs code of a platform tree runs it under that tree's own
// config and lock, found where mise puts the tree as the command runs
// (docs/monorepo.md#commands-find-the-platform-with-mise-where): the
// checkout's tree under mise.local.toml, the pinned release in a mirror. The
// binding is `$<tree>`. A loop check is a sayt rule, with tools.nu on its
// include path; a check beside the stack runs under `mise x`, with mise on
// PATH and the config already trusted.
#Platform: P={
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
