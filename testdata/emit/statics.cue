// Each COPY in caddy's image is a layer, and an image past ~127 layers fails
// to load on an overlay snapshotter ("max depth exceeded"). Statics that
// mirror their path under a root share one COPY per consecutive run; a static
// aimed elsewhere ends the run, so a later static still overwrites an earlier
// one at the same target. The terminal's own statics are the build's to copy
// from omnishell's image, never the cluster's.
package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
)

_staticsCopy: (pronto.#DefaultCluster & {code: _code, statics: [
	{file: "a.html", target: "/srv/a.html"},
	{file: "shell/b.css", target: "/srv/shell/b.css"},
	{file: "branding/a.html", target: "/srv/a.html"},
	{file: "c.js", target: "/srv/c.js"},
	{file: "interpreter/shell.js", target: "/omnishell/interpreter/shell.js"},
	{file: "d.js", target: "/srv/d.js"},
]}).out.surface.targets.caddy.dockerfile.copy
staticsRuns: list.Slice(_staticsCopy, 2, len(_staticsCopy)) & [
	{srcs: ["a.html", "shell/b.css"], dst: "/srv/", parents: true},
	{srcs: ["branding/a.html"], dst: "/srv/a.html"},
	{srcs: ["c.js", "d.js"], dst: "/srv/", parents: true},
	...,
]
