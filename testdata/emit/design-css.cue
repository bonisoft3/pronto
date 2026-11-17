package emit

import (
	"strings"
	pronto "github.com/bonisoft3/pronto"
)

// #DesignCss is design.css for any #Design: an app's shell/design.css is it
// for the program's design, and a design pinned to "light" says so.
_design: pronto.#Design & {
	colors: {
		primary:         "#1a73e8"
		secondary:       "#5f6368"
		accent:          "#f9ab00"
		danger:          "#d93025"
		neutral:         "#202124"
		surface:         "#ffffff"
		border:          "#dadce0"
		"surface-muted": "#f1f3f4"
	}
	dark: {
		primary:         "#8ab4f8"
		secondary:       "#9aa0a6"
		accent:          "#fdd663"
		danger:          "#f28b82"
		neutral:         "#e8eaed"
		surface:         "#202124"
		border:          "#3c4043"
		"surface-muted": "#303134"
	}
	shell: nav: "topbar"
}
_designBoth:  (pronto.#DesignCss & {design: _design}).text
_designLight: (pronto.#DesignCss & {design: _design & {colorScheme: "light"}}).text
designBothSchemes:  strings.Contains(_designBoth, "  color-scheme: light dark;") & true
designLightScheme:  strings.Contains(_designLight, "  color-scheme: light;") & true
designLightOnly:    strings.Contains(_designLight, "color-scheme: light dark;") & false
designScaleShared:  strings.Contains(_designLight, ":where(html) {") & true
