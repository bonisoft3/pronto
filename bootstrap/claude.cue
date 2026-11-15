package bootstrap

// What Claude Code needs to build the repo with pronto, as the repo's own .claude/settings.json:
// pronto's plugins, offered once the repo is trusted (the outer loop, from bonisoft3/pronto; the
// hosts, billing and the intents, from bsoneca/pronto-plugins), and the intents allowed, so that
// a sentence such as "release my-app" runs with no prompt (pronto-intents). The repo's, not a
// machine's: whoever opens it gets the same. Written once, where the repo has none.
#ClaudeSettings: {
	extraKnownMarketplaces: {
		"bonisoft3-pronto": source: {source: "github", repo: "bonisoft3/pronto"}
		"bsoneca-pronto-plugins": source: {source: "github", repo: "bsoneca/pronto-plugins"}
	}
	enabledPlugins: {
		"pronto@bonisoft3-pronto":              true
		"pronto-studio@bsoneca-pronto-plugins": true
	}
	permissions: allow: [for intent in ["release", "plan", "connect", "deploy"] {"Bash(pronto \(intent):*)"}]
}
