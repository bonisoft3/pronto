# The terminal's three planes: state, capabilities, surface

Continuation of `2026-08-02-terminal-doctrine.md` and `2026-08-02-terminal-hatch.md`,
read both first. Those left a real/designed/speculated split and a hatch rung with
no CUE type at all. This session gave the doctrine's four surfaces — collections,
markup, returned requests, capability object — a concrete, *uniform* CUE shape,
applied consistently across all four first-class pronto concepts (`#App`,
`#Terminal`, `#Cluster`, `#Loop`) rather than each inventing its own field names.
Returned requests stayed a protocol, not a namespace — the one surface that never
became a schema field, on purpose (see "The taxonomy" below).

## The taxonomy

Four buckets, applied to `pronto.#App`, `omnishell.#Terminal`, `mecha.#Cluster`,
and `sayt.#Loop`:

- **state** — data that persists and is queried. Domain-shaped on `#App`
  (`entities`, the collections plane), infrastructure-shaped on `#Terminal`
  (the nav stack — exclusive, unconditional, never app-configured), thin on
  `#Cluster` (`migrations`, `pipelines`), absent on `#Loop` (owns no data at all).
- **capabilities** — offered vs. requested, mirrored across files the way `auth`
  already was before this session: `#Terminal`/`#Cluster` publish what they
  offer, `#App` requests against that vocabulary. `#Loop` has none — no
  host-authority story of its own.
- **surface** — what a layer exposes for something else to compose against.
  Reused, not coined here — the original doctrine doc already used the word for
  mecha ("its own surface is only the composition") before this session applied
  it to markup. `#Cluster.surface.services` is the compose graph's input;
  `#Terminal.surface` is what's served to a browser; `#App.surface` is the
  semantic screen/handler declarations `#Terminal.surface` is a file-path
  projection of; `#Loop.surface` is nearly everything it has, because a dev-loop
  contract's entire job is exposing a build/test/lint interface.
- **meta** — identity, build provenance, verification. Present in all four, but
  it doesn't always earn its own nesting level: where it would only ever hold
  one field (`#Terminal`, `#Loop` — both just `app`), it collapses to a bare
  top-level field instead of a wrapper. `#App` (five real fields: `name`, `ir`,
  `tiers`, `decisions`, `tests`) and `#Cluster` (`app` *and* `mechaPath`) keep a
  real bucket. The rule is "let the content decide," not "always four."

Why *returned requests* never became a bucket, despite being one of the
doctrine's four original surfaces: it's Elm's `Cmd`, the verb that acts *on*
`state` or reaches into `capabilities` — not a third noun beside them. Forcing
it into a namespace would have repeated MVC's actual flaw (Controller collapses
"what changed" into "where things live"). `#App.surface.flows` is pronto's one
concrete realization of it today — each flow already declares `of: string //
screen`, so it nests under `surface`, but it's worth remembering it's the
verb given a noun's address because CUE needs somewhere to declare it, not
secretly state.

## Corrections made getting here

Worth keeping precisely because they were caught mid-session, not obvious from
the start — a reader re-deriving this design from scratch would hit the same
wrong turns:

- **Durable outbox and shape connections are mecha/client concepts, not
  terminal-owned.** `@mecha/client`/`@mecha/browser` implement them (TanStack
  DB's offline-transactions, Electric's client) — the terminal just hosts one
  instance per tab. They don't get a CUE field anywhere: nothing about them is
  per-app configurable (confirmed by checking `create-collections.ts`, which
  carries no cursor/txid/publication bookkeeping — that's entirely inside
  `@electric-sql/client`'s internals, invisible to CUE), so there's nothing for
  `#emit` to type-check. They stay doctrine prose.
- **The nav stack *is* real terminal-owned state** — Navigation-API-driven
  (`shell.js`/`screen.js`, real commits), unlike the two above. It's the one
  thing `#Terminal.state` declares, as a witness (`navigation: true`) rather
  than an empty struct, since it has no per-app-configurable facet beyond
  `#App.surface.screens[x].keep`.
- **`#Entity.path` (`"crud"|"live"|"offline"`) and `writers`
  (`*"forms"|"pipeline"`) already fully configure outbox/shape-connection
  participation** (`schema.cue:72,76`) — confirmed by reading `#Entity`
  directly. No separate capability surface needed for either; the
  configuration surface was already there, just not recognized as one.
- **The capabilities taxonomy (`sensors`/`background`/`hardware`/`os-bridge`/
  `network-peer`) is sourced from caniuse's own categories**, grouped by shared
  *authority shape* rather than topic — not a guess at future needs, a mapping
  onto a catalog that already exists. GPU/Worker-adjacent APIs (WebGL/WebGPU,
  OffscreenCanvas, SharedArrayBuffer) are deliberately *not* capabilities here
  — they're the `isolation` axis (which of `compartment`/`iframe`/`worker` a
  vendored unit runs under), a different question from which resource it can
  reach.
- **`hostOwned`/`attenuable` collapsed.** A generic extensible map,
  generalized from exactly one real example (camera), was premature the same
  way `attenuable` itself later turned out to be — named fields directly under
  `capabilities` (matching how `auth` already got its own field) beat an
  abstract wrapper sized for a guess.
- **`screens` stays, not `pages`.** Checked against Apple's Human Interface
  Guidelines and Android's Material Design guidelines: both use "screen" as
  their design-layer term, while their API-layer class names have already
  changed twice each (`UIViewController`→SwiftUI `View`;
  `Activity`→`Fragment`→`@Composable` destinations) — "screen" is the more
  durable word precisely because it isn't coupled to a framework's current
  class hierarchy, not just a familiar one.
- **`islands` → `handlers`.** Real collision with Astro's islands
  architecture — interactive, hydrated, DOM-owning components, nearly the
  opposite of a zero-DOM, zero-endowment pure function. Elm's own `update` and
  React's `useEffect` were both checked and rejected as replacements: `update`
  assumes full `Model` access, which this rung deliberately denies (it
  receives "its arguments, nothing else"); `useEffect` assumes unconstrained
  imperative access, which is exactly what SES containment exists to prevent.
  "Handler" fits without borrowed baggage — a plain web event handler already
  has the right shape (bounded arguments in, a decision about what happens
  out, no ambient assumption).
- **Handler files stay `.js`, no separate extension** — Jessie is a safe
  *subset* of JavaScript syntax, not a different language, so handler sources
  must stay directly loadable as ES modules. Pronto already distinguishes them
  semantically without a different extension: `#File.format` (`emit.cue:32`)
  has `"jessie"` as its own value, separate from `"js"`, and every handler
  gets tagged with it at emission (`emit.cue:797`) — the type-level marker
  this session added (`#Jessie: #Path & =~"\\.js$"`) makes that existing
  distinction checkable on `#App`/`#Terminal` too, not just at emission.
- **`entry`/`modules` collapse.** What had grown to six separate fields
  (`interpreterPath`, `entry`, `shellCss`, `indexHtml`, plus two more proposed
  mid-session for a would-be `shell.js`/`shell-boot.js` split) collapsed to
  three: `entry` (the one HTML file the browser requests first), `modules`
  (everything else served — CSS, JS, the interpreter engine, vendor files,
  referenced by `entry`'s own ordinary `<link>`/`<script>` tags), and
  `interpreterRoot` (kept, after initially — wrongly — proposing to drop it as
  "just emit.cue plumbing"; `#Terminal`'s own `statics` derivation resolves
  every `modules` entry against it directly, so it's a real field this type
  needs, not an emitter-internal detail).
- **The per-app `<title>` and the shell's bootstrap script move to runtime.**
  `indexHtml`'s only two interpolation points (`\(T.app)` for `<title>`,
  `\(T.entry)` for the bootstrap `<script src>`) blocked it from becoming a
  plain file. Fix: `shell.yaml` already carries `app` — `#shellConfig` in
  `emit.cue` (line ~318) already emits `app: S.code.name` into it, for
  reasons unrelated to this plan; an earlier version of this doc wrongly
  described this as something to *add* in a later task. What's actually new
  is `shell.js` *reading* it: it doesn't set `document.title` today (checked
  directly — no `document.title` reference anywhere in the file), so that
  line is a real addition, just not a `shell.yaml` change. `entry`'s default
  URL gets hardcoded directly in the checked-in file, since `entry`'s value
  is `*default | override` and the override case is rare enough to use the
  same `bayt.cue` escape-hatch seam every other override already uses.
- **`shell.css` isn't pure terminal chrome — the real `emit.cue` already
  concatenates it with per-app content.** Caught mid-implementation:
  `"shell/shell.css": {text: E.terminal.shellCss + E._designCss}`
  (`emit.cue:785`) — `_designCss` is a substantial, per-app-compiled block
  (`#App.design`'s colors/dark/rounded tokens). Turning `shellCss` into one
  static terminal-owned file, as first written here, silently drops every
  app's actual design tokens. Fix: `shell.css` stays a real static file
  (terminal chrome only); `_designCss` becomes its own generated file,
  `shell/design.css` — per-app, `#App`/pronto-owned, nothing omnishell or
  mecha needs to know about it, generated by `#emit` the same way
  `shell.yaml` already is. `shell.html` links both.
- **`entry`/`css`/`boot` are app-relative *target* paths; getting their
  *content* there took two wrong turns before landing.** First wrong turn:
  `@embed` pointed at `../omnishell/shell.html` from `emit.cue` — fails with
  `@embed: cannot refer to parent directory`, confirmed directly. CUE's embed
  directive cannot cross a directory boundary, full stop. Second wrong turn:
  routed around that with `#File.src` (`"shell/index.html": {src:
  "../../plugins/omnishell/shell.html"}`), the same passthrough
  `screens[].html`/`.css` use — this vets clean but fails at the real build,
  confirmed by actually running it: `write.ts` has a hard, pre-existing,
  unconditional guard (`if f.src.split("/").includes("..")) fail(...)`,
  `write.ts:66`) rejecting any `src` that leaves the app's own directory —
  a deliberate sandbox boundary, not a bug, and the pinned build command's
  `deno run --allow-read=.` scope independently denies the same read even if
  the guard didn't exist. `src:` cannot cross a directory any more than
  `@embed` can; it just fails one layer later, at write time instead of
  vet time.

  The fix that actually works, verified end-to-end in isolation before
  landing it: do the `@embed` *inside* `plugins/omnishell`'s own package —
  same directory as `shell.html`/`shell.css`/`boot.js`, so no boundary
  crossing — and expose the embedded content as an ordinary field on
  `#Terminal` (`surface.assets.{html, css, boot}`). `emit.cue` then reads
  those as plain CUE values (`text:`, not `src:`) — content flows through
  the package-import graph at CUE-evaluation time, never touching a
  filesystem path at write time at all. This is closer to what was actually
  asked for than the `src:` detour was: an `@embed` directive, just placed
  in the one directory where CUE allows it, with `emit.cue` mapping the
  embedded value onto the target path rather than a source path.

  This also still resolves the relative-URL mismatch a naive static-file
  version would have had: `entry`/`css`/`boot`/`design.css` all land under
  the same app-relative `shell/` directory, so `shell.html`'s relative refs
  to the other three resolve. `boot.js`'s own reference to the interpreter's
  `shell.js` (which stays under the shared `/omnishell/interpreter/` prefix)
  stays absolute — that one's a genuine cross-prefix reference on purpose.
- **A third gap in the same mechanism, found the moment `write.ts` actually
  ran: `format:"js"` has no header entry, and `format:"html"` would have
  gotten one in the wrong place.** `write.ts`'s `HEADER` map (`sql`, `yaml`,
  `caddyfile`, `cue`, `css`, `html`, `text`) has no `js` entry — `boot.js`
  crashed write.ts outright (`unknown format js`), the first `format:"js"`
  entry ever to flow through `text:` rather than `src:` (which the writer's
  own header comment says is "never headed" — `src`-copied files skip
  `render()` entirely). Adding a bare `js` entry would have fixed the crash
  but left a subtler bug: `shell/index.html` is *also* the first
  `format:"html"` entry ever routed through `text:`, and its content is
  `<!doctype html>` as the literal first byte — `render()` prepends the
  header unconditionally (`header + f.text`), which would land an HTML
  comment before the doctype, risking quirks-mode rendering. The header
  text itself is also factually wrong for all three: "generated by pronto
  from program.cue" is true for `design.css` (really computed from
  `#App.design`) but false for `shell.html`/`shell.css`/`boot.js`, which
  are static and never vary per program.cue. Fix: those three use
  `format: "text"` instead of their nominal format — `HEADER.text` is
  already `""` (write.ts already has this exact "verbatim, no header" case,
  just never needed by anything before), so this is zero new code in
  `write.ts`, only a format-tag change in `emit.cue`. The file's own
  extension (from its target path, e.g. `shell/index.html`) still governs
  how it's served — `format` only ever controlled the writer's rendering
  step, confirmed by reading `write.ts` end to end. `design.css` keeps
  `format: "css"` — its header claim is true, and it should stay true.
- **The navbar resolves as a `widget`, not a `hatch`.** Checked
  `widget.js`'s `hydrateWidget(root, {adapter, rows, onValue})` directly — it's
  already completely plane-agnostic ("the widget is ignorant of the store," per
  its own comment). A navbar reading `state.navigation` (read-only, the
  screens/routes the terminal already knows) through a Jessie adapter is the
  *existing* mechanism applied to a new source of `rows`, not new machinery —
  "hooks to move it around, hide it" resolve as ordinary `onValue`-shaped
  returned requests, the same as any other widget interaction.
- **`transport`/`transports` renamed `isolation`.** "Transport" fit `iframe`
  and `worker` (both cross a boundary via `postMessage`) but not `compartment`,
  which involves no message-passing at all — direct in-process calls into a
  restricted scope. What actually varies across the three is the strength and
  kind of *isolation boundary*; the communication mechanism is a consequence
  of that choice, not the axis being selected. Renamed on both sides:
  `#Terminal.capabilities.isolation` (offered), `#App.capabilities.
  vendored[Name].isolation` (requested).
- **Service workers are neither `isolation` nor a bare capability.** They
  never run vendored/handler code on a unit's behalf, so they don't belong on
  the `isolation` axis (which is specifically "where does a unit's code
  run") — they're terminal-owned, singleton, persistent infrastructure, the
  same category as the nav stack. But they're not simply a new capability
  either: `background.push`/`background.background-sync` already declare the
  *capability* correctly; a service worker is the *delivery mechanism*
  underneath both, not a resource a unit reaches into. Resolved the same way
  `#App.blobs` already works: no field for an app to declare "I need a
  service worker" — whether one gets registered is *derived* from whether any
  `background.*` capability is actually requested. No new schema added for
  this reason; `push`/`background-sync` stay declared-but-blocked (their
  `note` fields say why) until service-worker registration support exists,
  same pattern as `device-orientation` blocked on Q3.
- **`#Loop` should stop hardcoding rules that belong to `#Terminal`/
  `#Cluster`.** `plugins/sayt/loop.cue`'s rulemap already has `"caddy"`
  (validates `#Cluster`'s own `docker/Caddyfile`) and `"islands"` (explicitly
  commented *"Stub for the real Jessie grammar gate"* — exactly the capability
  boundary this session designed) hardcoded by name, with no import of either
  type. Both should become `surface.checks` entries contributed *from*
  `#Terminal`/`#Cluster`, bucketed by their declared verb into the matching
  rulemap by `#Loop` instead of authored in place. This gives the handler-grammar
  check an actual landing spot: validating that a handler's source only
  references the capabilities it was granted, not just that its declared
  capability list is well-formed.
- **`#emit` stays fixed and hand-authored — not auto-derived by name-matching.**
  Considered and rejected: matching by doc-comments is not implementable in
  CUE at all (comments aren't part of the value model); matching by field name,
  even after this session's bucket alignment, doesn't eliminate the real
  cross-shape lowering `#DefaultTerminal`/`#DefaultCluster` do (`#App.surface.
  screens`'s routes/reads/forms really do become `#Terminal.surface.screens`'s
  bare file paths — a projection, not a rename; not even the simplest field,
  app identity, survived unrenamed: `#App.meta.name` vs. `#Terminal`/`#Cluster`/
  `#Loop`'s `app`). What *does* generalize: the offered/requested witness-check
  pattern, today hand-written once for auth (`true & list.Contains(E.terminal.
  auth.modes, E.code.auth.mode)`), worth writing once as a comprehension over
  `capabilities` instead of by hand per case. The "sync burden" of three files
  needing to move together isn't a silent-drift risk either way — CUE's own
  type-checking turns any of them changing shape into an immediate,
  precise, compile-time failure at every stale reference site.

## The four shapes, final

```cue
#Path:   string
#Jessie: #Path & =~"\\.js$"
```

(`#Content` was proposed mid-session for `shellHtml`/`shellCss` before the
`entry`/`modules` collapse replaced every content-typed field with file-typed
ones — it's dead in the final shape and isn't implemented.)

```cue
// omnishell.#Terminal — plugins/omnishell/terminal.cue
#Terminal: {
	app: string

	state: {
		navigation: true
	}

	capabilities: {
		auth: {modes: [...string], identity: string}

		sensors: [Name=string]: {yields: string, note: string}
		sensors: camera:               {yields: "captured frame (Blob), via a returned request", note: "one MediaStream per tab; CameraView is terminal chrome, not a mountable unit"}
		sensors: microphone:           {yields: "captured audio clip (Blob), via a returned request", note: "getUserMedia's audio half"}
		sensors: "screen-capture":     {yields: "a captured frame or recording (Blob), via a returned request", note: "getDisplayMedia"}
		sensors: geolocation:          {yields: "{lat: number, lng: number, accuracy: number}, via a returned request", note: "one-shot read only"}
		sensors: "device-orientation": {yields: "an orientation/acceleration reading", note: "fires continuously — blocked on Q3 (do subscriptions generalize?), declared but not yet grantable"}

		background: [Name=string]: {yields: string, note: string}
		background: notifications:     {yields: "a shown notification, via a returned request", note: "Notifications API"}
		background: push:              {yields: "a push subscription (endpoint + keys), via a returned request", note: "the push event itself fires in the service worker, never in a unit — blocked on service-worker registration support, not yet grantable"}
		background: "background-sync": {yields: "a registered sync tag, via a returned request", note: "same service-worker-only firing as push — same block"}
		background: "wake-lock":       {yields: "an active, auto-released wake lock, via a returned request", note: "Screen Wake Lock API"}

		hardware: [Name=string]: {yields: string, note: string}
		hardware: usb:       {yields: "a connected USB device handle, via a returned request", note: "WebUSB"}
		hardware: hid:       {yields: "a connected HID device handle, via a returned request", note: "WebHID"}
		hardware: serial:    {yields: "a connected serial port handle, via a returned request", note: "Web Serial"}
		hardware: bluetooth: {yields: "a connected Bluetooth device handle, via a returned request", note: "Web Bluetooth"}
		hardware: nfc:       {yields: "a scanned NFC tag reading, via a returned request", note: "Web NFC"}

		"os-bridge":    [Name=string]: {yields: string, note: string} // declared, empty — clipboard, file-system, share, contacts land here
		"network-peer": [Name=string]: {yields: string, note: string} // declared, empty — websocket, webrtc, broadcast-channel land here

		isolation: [...string]
		isolation: *["compartment"] | [...string]
	}

	surface: {
		// entry/css/boot are app-relative TARGET paths — where these land
		// in the app's own served tree, alongside shell.yaml and design.css
		// (pronto/emit.cue-owned, not declared here). Their CONTENT comes
		// from assets below, embedded locally within this package (@embed
		// cannot cross a directory boundary, checked directly) — emit.cue
		// reads assets.* as plain CUE values (text:), never a src: path,
		// since write.ts also refuses any src leaving the app's own
		// directory (checked directly — this is a real, hard guard, not
		// a config knob). design.css isn't listed here — it's #App's own
		// generated file, nothing omnishell-specific about it.
		entry: #Path
		entry: *"shell/index.html" | string
		css: #Path
		css: *"shell/shell.css" | string
		boot: #Path
		boot: *"shell/boot.js" | string

		// Embedded from this package's own shell.html/shell.css/boot.js —
		// same directory, so @embed is legal here (never in emit.cue).
		assets: {html: string, css: string, boot: string}

		interpreterRoot: #Path
		interpreterRoot: *"../../plugins/omnishell/interpreter" | string
		modules:         [...#Path]

		screens:  [...{name: string, html: #Path, css: #Path}]
		handlers: [...#Jessie]

		lint:    [Name=string]: {cmd: string, note: string}
		statics: [...#Static]
	}
}
```

```cue
// pronto.#App — plugins/pronto/schema.cue (what program.cue instantiates)
#App: {
	state: {
		entities:       [Name=string]: #Entity & {name: Name}
		entityOrder?:   [...string]
		rawMigrations?: [...{name: string, src: string}]
		pipelines:      [Name=string]: #Pipeline & {name: Name}
	}

	capabilities: {
		auth?:    {required: bool, service: string, mode: string}
		blobs:    bool
		hatches:  [Name=string]: {ir: string, kind: "container", note: string} // cluster-tier
		vendored: [Name=string]: {                                              // terminal-tier
			isolation:    "compartment" | "iframe" | "worker"
			capabilities: [...string] // "group.name" — validated against omnishell.#Terminal.capabilities
			src:          string
			note:         string
		}
	}

	surface: {
		screens:  [Name=string]: #Screen & {name: Name}
		handlers: [Name=string]: {ir: string, of: string, src: #Jessie, note: string}
		design:   #Design
		flows:    [Name=string]: #Flow & {name: Name}
	}

	meta: {
		name:      string
		ir:        {source: string, sha256: string}
		tiers:     [...#Tier]
		decisions: [Id=string]: {ir: string, note: string}
		tests:     [Id=string]: #Test & {id: Id}
	}
}
```

```cue
// cluster.#Cluster — libraries/mecha/cluster.cue
#Cluster: {
	state: {migrations: [...string], pipelines: [...{name: string, file: string}]}

	capabilities: {auth: bool, blobs: bool}

	surface: {
		services: [string]: _
		lint:     [Name=string]: {cmd: string, note: string} // e.g. caddy
	}

	meta: {app: string, mechaPath: string, statics: [...#Static]}
}
```

```cue
// sayt.#Loop — plugins/sayt/loop.cue
#Loop: {
	state:        {} // owns no data
	capabilities: {} // no host-authority story of its own

	surface: {
		buildCmd:       string
		testCmd:        string
		pipelineFiles:  [...string]
		handlerFiles:   [...#Jessie]
		handlersCheck:  string
		screenCssFiles: [...string]
		screensCheck:   string
		bijectionCheck: string
		// takes terminal.surface.checks + cluster.surface.checks alongside
		// cue/rpk/bijection — no longer hardcodes "caddy"/"islands" by name
		checks: [Name=string]: {verb: "lint" | "test" | "integrate", cmds: [...string], note: string}
		sayYaml:   say: [Verb=string]: rulemap: [Name=string]: {priority?: int, cmds: [...{do: string}]}
		tasksJson: {version: string, tasks: [...{label: string, type: string, command: string, group: {kind: string, isDefault?: bool}}]}
	}

	meta: {app: string}
}
```

## What `#emit` needs to change

- Every `D.code.X`/`E.code.X`/`E.terminal.X`/`E.cluster.X` reference in
  `#DefaultTerminal`, `#DefaultCluster`, `#DefaultLoop`, `#appMigrations`, and
  `#emit` itself moves to its new nested path (`D.code.screens` →
  `D.code.surface.screens`, `E.code.entities` → `E.code.state.entities`, etc.)
  — the largest concentration of changed references in the migration, larger
  than any single app's `program.cue`.
- A new generic capability-witness check, following the existing auth-mode
  pattern exactly, applied over `vendored`/`capabilities` instead of hand-
  written per case.
- `#DefaultLoop` merges `terminal.surface.checks` and `cluster.surface.checks`
  into `#Loop.surface.checks`, which buckets them by verb into
  `sayYaml.say.<verb>.rulemap`, replacing the hardcoded `"caddy"`/`"islands"`
  entries in `plugins/sayt/loop.cue`.
- The generated `bayt.cue` text block (`emit.cue:808-826`) needs its own
  `cluster: mecha.#Cluster` / `terminal: omnishell.#Terminal` re-declarations
  to keep matching the new shapes — it's emitted text, not evaluated CUE, so
  nothing catches this one at compile time; it needs manual verification.

## Breaking-change surface

Confirmed acceptable to break every consumer:

- `apps/thenote/program.cue`, `apps/thenote/bayt.cue`
- Keep's CUE wherever it declares `#App` fields or cluster-tier hatches
- `plugins/pronto/emit.cue` (see above — the real center of gravity)
- `plugins/sayt/loop.cue` (rulemap hardcoding → fold-in)

## Explicitly out of scope for this spec

- No interpreter runtime for `iframe`/`worker` isolation kinds —
  `isolation` stays `["compartment"]` only. Real implementation happens
  against apps/iris's actual camera/MediaPipe need, a separate spec, per the
  earlier "doctrine + CUE typing only" decision — building it now would be
  designing against an imagined caller instead of a real one.
- No navbar widget implementation. The resolution (navbar = widget reading
  `state.navigation`) is a design conclusion this doc records; thenote has no
  navbar screen to migrate, so nothing here requires building it. Relevant to
  apps/iris, not to thenote's recompile.
- `os-bridge`/`network-peer` stay declared-but-empty; `sensors."device-
  orientation"` stays declared-but-refused pending Q3 (does "returned
  requests" generalize to continuous subscriptions?) from the hatch doc — MediaPipe's
  frame-by-frame case and now device-orientation are two independent pieces of
  evidence Q3 needs answering before either can be granted, not something
  this spec resolves.

## Facts not to re-derive

- `#File.format` already distinguishes `"jessie"` from `"js"`
  (`emit.cue:32`); handler sources are `.js` on disk regardless.
- `widget.js`'s `hydrateWidget` takes `rows`/`adapter`/`onValue` with no
  assumption about where `rows` comes from — it was already plane-agnostic
  before this session, not extended to become so.
- `#Entity.path`/`writers` (`schema.cue:72,76`) already fully configure
  outbox/shape-connection participation per entity; no separate capability
  surface was missing, just unrecognized.
- `#Cluster.blobs` and `#App.blobs` are already the same toggle, unified by
  `#emit` today — not a pattern this design introduces, one it formalizes.
- `apps/thenote/shell/shell.yaml` is already generated per-app and already
  fetched at boot — adding `app` to it is extending an existing mechanism,
  not building a new one.

## Pointers

`plugins/omnishell/terminal.cue`, `plugins/pronto/schema.cue`,
`libraries/mecha/cluster.cue`, `plugins/sayt/loop.cue`,
`plugins/pronto/emit.cue` (the migration's center of gravity),
`plugins/omnishell/interpreter/widget.js` (the navbar resolution's evidence),
`apps/thenote/` (the regression target — spec 2, next).
