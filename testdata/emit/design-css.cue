package emit

import (
	"strings"
	pronto "github.com/bonisoft3/pronto"
)

// #DesignCss is design.css for any #Design: an app's shell/design.css is it
// for the program's design, and a design pinned to "light" says so.
_designBoth:  (pronto.#DesignCss & {design: pronto.#Design & {}}).text
_designLight: (pronto.#DesignCss & {design: pronto.#Design & {colorScheme: "light"}}).text
designBothSchemes:  strings.Contains(_designBoth, "  color-scheme: light dark;") & true
designLightScheme:  strings.Contains(_designLight, "  color-scheme: light;") & true
designLightOnly:    strings.Contains(_designLight, "color-scheme: light dark;") & false
designScaleShared:  strings.Contains(_designLight, ":where(html) {") & true
