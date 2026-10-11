# Renderer measurement for the hatches record

The three objects of [the record](../../2026-10-10-hatches.md#what-irhtml-shows) — golaberto's `Game` neighbourhood, the payment machine, chess's metronome — rendered by both candidates from one source of data, 2026-10-11.

- `ab.ts` writes the six sources from `golaberto-entities.json` (`cue export -e code.state.entities --out json` in `apps/golaberto`; not kept, 300 KB) and the two charts.
- `d2 --layout elk --theme 0 --pad 24 <name>.d2 <name>.d2.svg` with `aqua:terrastruct/d2@0.9.0` under mise: no browser.
- `render-mermaid.cjs` renders Mermaid 11.4.1 (the version every ir.html pins) the only way it can be rendered outside a page: in Playwright's Chromium from the root checkout's `node_modules`.

What the run established without an eye: Mermaid needs a browser to produce an SVG at build time, D2 does not; D2 reserves `height`, `width`, `label` and other keys, so column names are quoted; a second `:` in a Mermaid transition label is a parse error and `\n` in a state name prints literally; D2's output embeds its font and is byte-stable for an input and a version, Mermaid's depends on the rendering browser's fonts.
