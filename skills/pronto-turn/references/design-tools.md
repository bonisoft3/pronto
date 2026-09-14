# Design oracle by host

Use this when a visible surface needs a new or revised design direction. Keep
an accepted oracle when the change fits it; do not redesign a settled surface
just because a generation tool is available.

| Host | Preferred design path | Verification |
| --- | --- | --- |
| Claude | Installed `design` skill for the canvas; `frontend-design` for the designer seat | Browser comparison against the accepted oracle |
| Agy | Connected Stitch MCP for UI alternatives and design tokens | Agy browser tooling against the selected Stitch design |
| Codex | Available ImageGen skill/tool for visual alternatives, mockups, and raster assets | Available browser skill/tool against the selected mockup and `ir.html` |

Inspect the session's available tools and skills before invocation. These names
are capability routes, not commands guaranteed to exist in every installation.

## Agy: Stitch

Use the connected Stitch integration to explore the visible direction, then
retrieve the chosen screens and tokens. Google's
[Stitch-to-Agy flow](https://codelabs.developers.google.com/design-to-code-with-antigravity-stitch)
requires a configured MCP connection and authentication; do not silently add
credentials or modify the user's global host configuration. If disconnected,
ask to connect it or agree on another available design tool. Agy also offers
[native image generation](https://antigravity.google/docs/models) with Nano
Banana 2 for mockups and assets; it is an explicit alternative, not Stitch parity.

Stitch exports are design evidence. Adapt selected layout and tokens into the
Pronto app; do not replace its architecture or generated-file ownership with an
exported application scaffold.

## Codex: ImageGen

Use the available ImageGen skill's own instructions to produce mockups or
bitmap assets. This is a visual exploration tool, not a complete frontend-design
skill or an interactive prototype. For an established vector/icon system or a
code-native visual, work in that format instead of rasterizing it. Keep UI text,
layout, controls, and behavior implemented as real app elements.

## Approval and evidence

Show alternatives when taste is genuinely open; the human selects the direction.
Carry the decision, rationale, tokens, and relevant states into `ir.html` before
implementation. Keep mockups as supporting evidence, not a second contract.

Use the browser to inspect the actual implementation at relevant viewport sizes
and exercise its interactions. A generated picture cannot prove responsiveness,
accessibility, or behavior. Report unavailable design/browser tools and untested
evidence; never call a mockup or an unperformed visual check a passing gate.
