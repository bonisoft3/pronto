package emit

import (
	"strings"
	terminal "github.com/bonisoft3/omnishell:terminal"
)

#styleCase: {
	screens: [...{name: string, html: string, css: string, shared?: [...string]}]
	html: (terminal.#Terminal & {
		app:         "styles"
		description: "shared styles"
		surface: {
			"screens": screens
			shared: ["shell/shared/chrome.css", "shell/shared/chart.css"]
		}
	}).surface.assets.html
}

_commonStyles: (#styleCase & {screens: [
	{name: "home", html: "home.html", css: "home.css", shared: ["shell/shared/chrome.css"]},
	{name: "chart", html: "chart.html", css: "chart.css", shared: ["shell/shared/chrome.css", "shell/shared/chart.css"]},
]}).html
sharedFrameEarly:   strings.Contains(_commonStyles, "<link rel=\"stylesheet\" href=\"../shell/shared/chrome.css\">") & true
routeStyleDeferred: strings.Contains(_commonStyles, "href=\"../shell/shared/chart.css\"") & false
emptyScreenStyles: strings.Contains((#styleCase & {screens: []}).html, "../shell/shared/") & false
undeclaredScreenStyles: strings.Contains((#styleCase & {screens: [
	{name: "home", html: "home.html", css: "home.css"},
]}).html, "../shell/shared/") & false
singleScreenStyles: strings.Contains((#styleCase & {screens: [
	{name: "home", html: "home.html", css: "home.css", shared: ["shell/shared/chrome.css"]},
]}).html, "../shell/shared/chrome.css") & true
