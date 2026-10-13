# Renderer measurement for the hatches record

The three objects of [the record](../../../archive/2026-10-10-hatches.md#what-irhtml-shows) — golaberto's `Game` neighbourhood, the payment machine, chess's metronome — rendered by both candidates from one source of data, 2026-10-11.

- `ab.ts` writes the six sources from `golaberto-entities.json` (`cue export -e code.state.entities --out json` in `apps/golaberto`; not kept, 300 KB) and the two charts.
- `d2 --layout elk --theme 0 --pad 24 <name>.d2 <name>.d2.svg` with `github:terrastruct/d2@v0.9.0` under mise (the GitHub release, not aqua): no browser.
- `render-mermaid.cjs` renders Mermaid 11.4.1 (the version every ir.html pins) the only way it can be rendered outside a page: in Playwright's Chromium from the root checkout's `node_modules`.

What the run established without an eye: Mermaid needs a browser to produce an SVG at build time, D2 does not; D2 reserves `height`, `width`, `label` and other keys, so column names are quoted; a second `:` in a Mermaid transition label is a parse error and `\n` in a state name prints literally; D2's output embeds its font and is byte-stable for an input and a version, Mermaid's depends on the rendering browser's fonts.

`payment-card.d2` / `payment-collapsed.d2`: one entity as its ir.html element would draw it — collapsed at rest, expanded on a `<details>` click: authored sections (fields, access, validations) in ink with a solid stroke, derived ones (level, delivery, ports, presence, roles) in the accent with a dashed stroke, the machine on top. D2's `grid-columns` lays the card out; `tooltip` carries a validation's note.

`compare.html` is the page the two halves were judged on: Mermaid against D2 for the three objects, then the entity as a D2 card and as an HTML card (golaberto's `Game` from its real declaration, with referrer and reference strips, constraint glyphs, folded stamp columns; `Payment` with its machine). The HTML card won; the record's "What ir.html shows" states the conventions it took from Azimutt.
