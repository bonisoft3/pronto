# How the visual lint suite reaches a pronto-emitted app

Date: 2026-08-01. Status: design; nothing wired. Measurements in this
document were taken against `apps/thenote` served statically (no compose
stack) and driven with Playwright; they are reproducible with the recipe
in §2.

`plugins/omnishell/src/lint/playwright/` holds nine DOM checks
(theme-stability, focus-order, touch-targets, horizontal-overflow,
interactive-overlap, constrained-images, cls, console-messages,
viewport-bounds), the `visualLint` battery that runs seven of them, an AI
`vision-review`, and a `route-coverage` crawler. Three consumers import
it: `guis/iris` (through the `@omnishell/core/playwright/visual-lint`
package export), `guis/snapcards` (relative path), and omnishell's own
`playwright-tests/`. No emitted app is a consumer.

The suite was written against a component storybook rendered one story per
page at viewport width. A pronto app has neither: it has one storybook
page per route rendering every storyboard state as a 360px frame on a
board. Most of what the battery measures is measured against `window`, and
in a pronto storybook `window` is the board, not the app. That mismatch —
not the plumbing — is the whole of the work.

## 1. What an emitted app offers as a lint surface

`apps/thenote/shell/shell.yaml` declares **7 routes carrying 33 storyboard
states**: wall 6, note 6, label-wall 4, archive 4, trash 4, reminders 5,
search 4. Three routes are parametrized (`/note/:id`, `/label/:name`,
`/search/:q`); the fixture store ignores filters, so any placeholder
segment renders.

`?storybook` renders one route's full state list. Frames arrive as
`figure > .frame > .screen[data-state]` inside `.storybook`, a
`flex-wrap` board with `gap: 24px` and `.frame { width: 360px; overflow:
hidden }`. There is no state selector: a page load renders all of a
route's states, and only a page load does — the storybook branch in
`shell.js` returns before the navigation stack is wired, so changing the
hash re-renders nothing. **Full coverage is 7 page loads.**

## 2. Does `/shell/?storybook` need a cluster? No — definitively

From `plugins/omnishell/interpreter/shell.js`, the storybook branch sits
at the top of `createShell`:

- it runs **before** the auth gate, so `auth.required: true` never reaches
  the login ceremony and no `/auth` call is made;
- it runs **before** the store selection, so neither `data-crud.js` (the
  `/crud` gateway) nor `data.js` (PGlite) is imported;
- it returns before nav chrome and before the navigation stack.

`storybook.js` then substitutes a read-only fixture store whose `create`/
`update`/`remove` throw, and calls `interpretScreen` with
`{islands: false, fixtures: true}`. `islands: false` means `screen.js`
never reaches `ensureSes()`, so the SES bundle is not fetched either;
`fixtures: true` swaps any interpolated `img src` for an inline
transparent GIF, so `/img` and `/blobs` stay silent.

Verified by running it. `apps/thenote/shell` mounted at `/shell` and
`plugins/omnishell` at `/omnishell` under `python3 -m http.server`, then
`GET /shell/?storybook#/note/abc`: the page titled itself
`note — storybook`, rendered 6 frames stamped `loading, populated,
share-refused, populated-dark, trashed, gone`, and issued **19 requests —
18 local statics and exactly one off-host**:
`https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/+esm`, which `shell.js`
imports to parse `shell.yaml`. Zero requests to `/crud`, `/electric`,
`/auth`, `/img`, `/blobs`.

So this is a **cheap gate**: two static roots and a browser. The honest
caveats are two. It is not hermetic — it needs jsdelivr egress, the same
dependency the deno smokes carry as `--allow-import=cdn.jsdelivr.net:443`.
And the two roots are not one directory: `shell/index.html` imports
`/omnishell/interpreter/shell.js` at an absolute path, which the emitted
Caddyfile serves from a second `handle` block. Any host-side server has to
reproduce that pair; `caddy run` against `docker/Caddyfile` will not, since
its roots are the container's `/srv` and `/omnishell`.

## 3. Per-check verdict

Numbers below are from route `/` (6 frames, 66 visible interactives) at
1200×881 unless stated.

| Check | Verdict | Why |
|---|---|---|
| `console-messages` | **as-is** | No geometry. Catches interpreter boot failures, unhandled rejections, and the fixture tier firing real requests. The one error observed was a `favicon.ico` 404, already in `DEFAULT_IGNORES`. |
| `constrained-images` | **adapt** | Computed-style only, so frame geometry is irrelevant — but it reports **72 findings on one route, all false**. It walks up to three ancestors for `aspect-ratio`; pronto's idiom puts it on the image (`.thumbs img { width: 100%; aspect-ratio: 1; object-fit: cover }`), which the check never inspects. |
| `touch-targets` | **adapt** | Gated on `window.innerWidth > 768`, so at any desktop viewport it returns immediately while the frames it should be judging are 360px wide. Forcing 390px makes it fire (4 elements considered, 3 flagged) but only for what fits above the fold of frame 1. The 44px minimum itself is frame-independent and correct. |
| `focus-order` | **adapt** | Walks the whole document in DOM order. Frame boundaries look like backward jumps, and the viewport clip drops most of the page: 17 of 66 interactives considered, 1 finding, spurious. Meaningful only per frame. |
| `interactive-overlap` | **adapt** | `elementFromPoint` needs the element in the viewport, and 49 of 66 (74%) were skipped as off-screen. Its highest-value target is unreachable regardless — see §6. |
| `viewport-bounds` | **meaningless** | Asks whether an element crosses the right edge of the window. A frame's right edge is 360px in from wherever the frame sits; the board's own edge is nobody's constraint. 0 findings at both 1200 and 390, and it would be noise if it fired. |
| `horizontal-overflow` | **meaningless** | Compares `documentElement.scrollWidth` to `window.innerWidth`. `.frame` is `overflow: hidden`, so a screen that overflows its frame can never widen the document. Never fires by construction — false at 1200 and at 390. |
| `theme-stability` | **meaningless as written** | Toggles `.dark` on `<html>`. Pronto themes through `@media (prefers-color-scheme: dark)` and `.screen[data-state$="-dark"]`; `.dark` matches nothing. Measured: toggling it changes no computed colour, so the check passes without measuring anything. Its position map is also keyed by testid → aria-label → text: 63 elements collapse onto **10 distinct keys**, so 53 entries overwrite each other before any comparison happens. |
| `cls` | **meaningless** | Excluded from the battery already. On a storybook board the shift is the harness's — frames are appended in a loop — not the app's. |
| `vision-review` | **as-is, different verb** | Takes a full-page screenshot and a context prompt. A board of every state is a *better* input than a single screen. Belongs at `verify`, not `integrate` (§5). |
| `route-coverage` | **do not reuse** | Builds its manifest by reading `*.tsx` from a routes directory and crawls path URLs from `${baseUrl}/login`. Pronto has no tsx, routes on the hash, and serves a 404 at `/login`. The pronto manifest already exists as `shell.yaml`'s `routes` × `states` — richer than a crawl, and derived rather than discovered. |

## 4. The container is not the viewport, and what that costs

Every geometry check resolves against `window`. In the storybook a screen
lives in a `.frame`, and the two disagree on both axes.

Width: the frame is 360px wide on a 1200px page, and it does not stay
360 — at a 390px viewport it shrank to **362px**, because it is a flex item
that may shrink. So the frame width is viewport-*coupled* but never
viewport-*equal*. Any threshold keyed to `window.innerWidth` is therefore
answering a question about the wrong box. This is why `touch-targets`
disables itself exactly when the frames are phone-shaped, and why
`viewport-bounds` and `horizontal-overflow` cannot see a frame overflow.

The screens already know this. `wall.css` carries
`[data-screen="wall"] { container-type: inline-size }` with a
`@container (max-width: 860px)` rule and a comment naming the storybook
frame as the reason. Container queries are the emitted CSS's answer to the
same mismatch, and they mean the frames *do* lay out honestly for their
width — the frame is a faithful phone in every respect the CSS asks about.

Height has no such answer. `container-type: inline-size` establishes no
block-axis container, so viewport units inside a frame resolve against the
board: `wall.css`'s empty state uses `margin: 18vh 0 0`, which is 158px on
an 881px-tall board and something else entirely on a real device. A frame
is as tall as its content, so "above the fold" is not a property a frame
has at all.

The cost, stated plainly: **the storybook is sound for width-driven layout
and unsound for anything height- or viewport-anchored.** Fold behaviour,
sticky/fixed positioning, scroll containment and `vh` spacing are not
observable there and must not be gated there. Fixing this inside the
checks means giving each one a root — the element to measure against
instead of `window` — which is an additive parameter, not a rewrite.

## 5. The hook point

`guis/iris/.say.yaml` and `guis/snapcards/.say.yaml` agree on a two-verb
split, and neither uses `lint` for it:

- **`integrate` @ `browser`** (`priority: -1`, `stop: true`) runs the
  deterministic DOM battery with no docker and no backend. Iris:
  `mise exec -- pnpm playwright test e2e/visual-lint.spec.ts`. Snapcards:
  `mise exec -- bun x playwright test tests/visual-lint.pw.ts`. The rule
  replaces the compose-driven `integrate` builtin outright.
- **`verify` @ `browser`** runs the AI vision review against the same
  isolated surface (snapcards only; iris keeps `verify` for its kind
  cluster).

Pronto should adopt exactly that, and it lines up with doctrine already
written down. `plugins/sayt/loop.cue` says verify is agent-driven by
default, "the storybook renders the evidence, the driving agent judges it;
the API-key vision harness is the unattended-CI upgrade" — and SPEC.md
§"Verify is agent-driven" says the same. The DOM battery is the
deterministic half and belongs at `integrate@browser`; `vision-review` is
the CI upgrade and belongs at `verify@browser`.

Mechanically the rule is emitted, not hand-written. `plugins/sayt/loop.cue`
owns `sayYaml`, which today declares `say.lint.rulemap` only; it gains a
`say.integrate.rulemap.browser` alongside, fed by new `#Loop` inputs the
way `islandFiles`/`islandsCheck` and `screenCssFiles`/`screensCheck`
already are. `check-islands.ts` and `check-screens.ts` are the precedent
for the shape: the emitted rule points at a checker under
`../../plugins/`, so the app carries a command and the platform carries the
code.

Two constraints on the command. `apps/thenote/.mise.toml` pins cue, deno,
redpanda-connect and caddy — **no node, no bun, no playwright**, and that
file is scaffold-owned rather than emitted, so a toolchain addition is a
scaffold change. And the harness needs the two-root static server from §2,
which is the natural `webServer` entry in a Playwright config living beside
the spec in `plugins/omnishell/`. The cheapest arrangement keeps both in
omnishell — where `@playwright/test` is already a devDependency and
`playwright.config.ts` already exists — and gives the emitted rule an app
directory as its argument.

That arrangement has one thing to settle first: `plugins/omnishell/package.json`
devDepends on `@playwright/test` 1.52.0 while the root workspace pins 1.59.1,
and in this bun monorepo Playwright must resolve to a single root instance or
the browsers crash on launch. Run the existing `playwright-tests/` from
`plugins/omnishell` before building on top of them; if the two pins have to
converge, that is a workspace change, not a pronto one.

## 6. Rules for touching shared code

`checkThemeStability` and every sibling reach `guis/iris`,
`guis/snapcards` and omnishell's own `playwright-tests/` through
`visual-lint.ts`. Its behaviour is load-bearing for two shipped apps:
`guis/iris/e2e/visual-lint.spec.ts` maintains a wrapper that drops this
exact rule as flaky, and `playwright-tests/visual-lint.pw.ts` asserts on
its output directly. **No check's default behaviour changes.** Everything
pronto needs arrives as an optional parameter with today's behaviour as
the default:

- a root/scope option, so a check measures against a frame instead of
  `window` (`touch-targets`, `focus-order`, `interactive-overlap`,
  and the viewport-relative guards inside them);
- an appearance-switch option for theme stability, so a caller can pass
  `page.emulateMedia({colorScheme})` or a `data-state` swap instead of the
  `.dark` class;
- an identity hook, since emitted screens carry **zero `data-testid`**
  and every check's fallback identifier degrades to fixture text
  ("Sample title 1"), which is both non-unique and unaddressable back to
  `program.cue`.

There is a better answer for theme stability than parameterizing the
toggle. The storybook already renders each dark twin as its own frame
(`populated` beside `populated-dark`), and `program.cue`'s
`decision-dark-twins` claims precisely that switching appearance
"re-resolves tokens with no state change". Comparing the geometry of a
`-dark` frame against its base frame tests that claim directly, needs no
toggle, and is a pronto-shaped check rather than a patched generic one.

Two coverage limits no parameter fixes. The storybook renders frames only —
no shell chrome — so the sticky `nav { position: sticky; z-index: 10 }`
from `shell/index.html` is absent, and the overlap class
`interactive-overlap` is best at (chrome covering content) is unreachable
there. And `islands: false` leaves island regions as inert markup, so
anything an island opens — a popover, a drag ghost — is never on screen.
Both are cluster-tier observations, i.e. `verify` against a running stack,
not `integrate`.

## 7. Plan, ranked by value per effort

1. **Console-only gate at `integrate@browser`.** Seven page loads, one per
   route, asserting zero console errors and zero page errors. No check
   needs adapting, nothing measures geometry, and it catches the failure
   that actually costs a session: an interpreter or fixture regression
   that breaks a screen. Cost is the static server, one spec, the `#Loop`
   surface and the emitted rule.
2. **Frame identity in the report.** Iterate `.frame` locators and label
   findings `(screen, state)` from `shell.yaml` rather than from the DOM.
   Falls out of doing (1) frame-by-frame, and is the precondition for
   every finding below being actionable.
3. **`constrained-images` relaxation.** Accept `aspect-ratio` on the image
   itself, additively. Smallest diff on this list; turns 72 guaranteed
   false positives into a check that can find a real one.
4. **Scoped `touch-targets`.** With a root parameter it becomes the most
   valuable geometry check pronto has, because 44px is an absolute rule
   and the frame is an honest 360px phone.
5. **Dark-twin geometry comparison.** Frame-to-frame, no shared-code
   change, and it gates a decision the program already asserts.
6. **Scoped `focus-order` and `interactive-overlap`.** Real but weaker:
   focus order inside a single screen is mostly a function of emitted
   markup order, and overlap's best target is out of reach until there is
   a cluster-tier surface.
7. **`vision-review` at `verify@browser`.** Doctrinally the right home,
   and the board of all states is an ideal prompt input — but it costs
   credits and is non-deterministic, so it lands after the deterministic
   half is trustworthy. Emit the context prompt from the storyboard, as
   SPEC.md already anticipates.
8. **Not now:** `horizontal-overflow`, `viewport-bounds`, `cls`,
   `route-coverage`. The first three need a surface where the frame *is*
   the viewport; the fourth needs replacing with a `shell.yaml`-derived
   manifest and would only pay for itself once there is a cluster-tier
   `verify`.
