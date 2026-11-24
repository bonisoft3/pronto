// Package pronto is the machine rung of the review ladder: the #App shape a
// program.cue instantiates, and #emit (emit.cue), which derives the emitted
// file bundle. Every object carries `ir`, the ir.html element id it realizes;
// the bijection checker matches these against the pinned IR.
package pronto

import (
	"crypto/sha256"
	"list"
	"path"
	"encoding/base64"
	"encoding/json"
	"encoding/yaml"
	"regexp"
	"strconv"
	"strings"

	mechaCluster "github.com/bonisoft3/pronto/clusters:mecha"
	"github.com/bonisoft3/pronto/resilience"
	"github.com/bonisoft3/pronto/scales"
	"github.com/bonisoft3/pronto/terminals:omnishell"
	grammar "github.com/bonisoft3/mecha/pgroll"
)

// A target is where a program is released; a tier, a rung of mecha's ladder
// (docs/release-targets.md#targets-platforms-and-tiers).
#Target: "pages" | "cloudflare" | "docker" | "k8s" | "gcp" | "aws"
#Tier:   "browser" | "edge" | "container" | "k8s" | "cloud"

// An isolate pronto publishes, as an isolate hatch's `uses` names it:
// `pronto/<name>`, one of emit.cue's _publishedIsolates.
#PublishedIsolate: or([for s, _ in _publishedIsolates {"pronto/\(s)"}])

// A path relative to the app directory, resolved by derive and by the
// terminal's module loader. No scheme and no `..`: the source is read from the
// app's own tree and embedded in emitted artifacts.
#Jessie: string & =~"^([a-z0-9_-]+/)*[a-z0-9_-]+\\.js$"

// A framework step's digits an app may place it at: after the schema's own
// steps through validations (000-009), below the framework's 800s and the
// seed at 900.
#StepDigits: string & =~"^(0[1-9][0-9]|[1-7][0-9]{2})$"

// The framework's steps an app's program runs, by name: the defaults unless
// `state.steps` places them. The effect ledger precedes the airlock's tables
// and those the job key's function, as mecha's cluster.cue orders them.
#steps: {
	let S = self
	code:    _
	_placed: [if S.code.state.steps != _|_ {S.code.state.steps}, {}][0]
	_digits: {
		machines: [if _placed.machines != _|_ {_placed.machines}, "010"][0]
		actors:   [if _placed.actors != _|_ {_placed.actors}, "016"][0]
		graphile: [if _placed.graphile != _|_ {_placed.graphile}, "011"][0]
		airlock:  [if _placed.airlock != _|_ {_placed.airlock}, "012"][0]
		jobKey:   [if _placed.jobKey != _|_ {_placed.jobKey}, "013"][0]
	}
	_ledgerFirst:  true & (_digits.graphile < _digits.airlock)
	_airlockFirst: true & (_digits.airlock < _digits.jobKey)
	machines:      "\(_digits.machines)_machines.sql"
	actors:        "\(_digits.actors)_mecha_actors.sql"
	graphile:      "\(_digits.graphile)_graphile_worker.sql"
	airlock:       "\(_digits.airlock)_airlock.sql"
	jobKey:        "\(_digits.jobKey)_airlock_job_key.sql"
}
#SafeEndowment: "Intl" | "TextEncoder" | "TextDecoder" | "URL" | "URLSearchParams" | "Statechart"

// The seven pre-composed shadow inks. Open Props' elevation carries a real
// dark story that light-dark() cannot take — --shadow-color is a bare
// `220 3% 15%` component triple and --shadow-strength a percentage, and
// neither is a <color> — so the strengths are pre-composed into finished
// colours and declared as ROLES, where the twin is closed. #scale.shadow is
// then geometry alone.
//
// Required of every design, in both halves, with structural defaults below so
// `--shadow-1..6` never dangle when an app leaves elevation inks untinted.
#shadowInks: ["shadow-ink-3", "shadow-ink-4", "shadow-ink-5", "shadow-ink-6",
	"shadow-ink-7", "shadow-ink-8", "shadow-ink-10"]

// The eight semantic colour roles every app owes in both appearances. Unlike
// the shadow inks and structural ladders, identity colours carry no platform
// default: naming none would hand every app the same palette by inertia.
#colorRoles: ["primary", "secondary", "accent", "danger", "neutral",
	"surface", "border", "surface-muted"]

// The navigation postures emit.cue renders at `:where(...)` specificity:
//   - `topbar`: fluid full-width sticky horizontal toolbar across viewports
//   - `tabbar`: centered floating top pill capsule on tablet/desktop (>= 640px)
//               that adapts to a pinned bottom tab bar on compact phones (< 640px)
//   - `sidebar`: inline-start vertical column on wide screens (>= 860px) that
//                collapses to a compact sticky top bar on narrower screens
//   - `dock`: centered floating pill capsule anchored near the bottom edge
//             across viewports, leaving the top edge chrome-free
//   - `custom`: zero-specificity link/control resets only; app CSS owns geometry
//   - `none`: no shell navigation strip is mounted; app owns the full viewport
// Required with no default so every app chooses its chrome explicitly.
#NavPosture: "topbar" | "tabbar" | "sidebar" | "dock" | "custom" | "none"

// Named 24x24 stroke icons Omnishell's chrome renders in `body > nav` links
// (`plugins/omnishell/interpreter/chrome.js` `CHROME_ICONS`). Held equal to
// `CHROME_ICONS` by `login-design.test.ts`.
#NavIcon: "home" | "compass" | "search" | "sparkles" | "globe" | "map-pin" |
	"layout-grid" | "grid-3x3" | "list" | "kanban" | "layers" | "table" |
	"calendar" | "clock" | "history" |
	"chart-bar" | "chart-line" | "chart-pie" | "trending-up" | "wallet" | "credit-card" | "receipt" | "shopping-bag" |
	"book-open" | "file-text" | "newspaper" | "scroll" | "circle-help" | "info" | "bookmark" | "tag" | "folder" |
	"message-square" | "mail" | "inbox" | "bell" | "users" | "user" | "heart" | "share" |
	"gamepad" | "trophy" | "award" | "flame" | "zap" | "play" | "music" | "image" |
	"plus-circle" | "check-circle" | "sliders" | "settings" | "shield" | "code" | "terminal"

// The joins the scanner implements. A bucket's dimension says which norm()
// runs over its steps and which properties' literals can reach them, so this is
// the set of dimensions in which a literal can be REFUSED — not a taxonomy of
// tokens. Read that way it settles its own membership: `token`, `root` and
// `shadow-color` classify a LITERAL and are correctly absent, and `opaque` is a
// bucket that publishes a name and joins nothing, because an elevation is a
// list rather than a value and a touch floor is a decision. Getting the last
// one wrong is live: `min` under `space` would answer `padding: 24px` with
// "use --min-touch".
//
// Closed, and the closedness buys a check rather than a second list: styles.ts
// looks a bucket's dimension up in its norm() dispatch table and raises when
// there is no case, so neither language carries a copy of the other's members.
#Dimension: "space" | "rule" | "radius" | "motion" | "layer" | "ratio" |
	"text" | "leading" | "opaque"

// A value that names another token rather than holding one. The one level of
// indirection styles.ts resolves, so a shape it cannot read is a reference that
// applies to nothing in silence.
#Reference: string & =~"^var\\(--[a-zA-Z0-9_-]+\\)$"

// Where a bucket's bytes came from. A scale composes more than one: the
// terminal's measured floors are not a vendor's, and no vendor publishes every
// dimension this corpus needs.
//
// `kind` says which of the two a source is, but it is NOT what exempts one from
// the quotation. A `quoted` source names an archive vendored under scales/, and
// invariants.sql holds every step drawn from it equal to a declaration in those
// bytes AND demands that the bytes declare the name at all — so an invented rung
// under a vendor's prefix is an error rather than a join that matches nothing.
// Both of those key on the vendored TREE answering the bucket's source name,
// because a label a line can change is a label that can buy an exemption. `url`
// and `integrity` describe the archive scales/refresh.ts re-fetches and
// scales/build.ts quotes, so only a quotation may carry them.
#Source: {
	kind:    "quoted" | "own"
	origin:  string
	version: string
	if kind == "quoted" {
		url:       string
		integrity: string
	}

	// An own source has no archive, so it has no version an archive could pin;
	// the only honest one is this repository. A constraint as well as a rule: a relabelled vendor source,
	// `{kind: "own", origin: "open-props", version: "1.7.23"}`, fails here before
	// THE WITNESS in invariants.sql reads it.
	if kind == "own" {
		version: "this repository"
	}
}

// One ladder under one prefix. The emitted name is prefix + key, so it IS the
// upstream name and a release bump is a `curl | diff`; and a step's dimension is
// its bucket's by construction, so nothing matches a token name against an
// ordered prefix list — which is what makes a nested prefix harmless, argued at
// #Scale.prefixes where the index is built.
#Bucket: {
	prefix:    scales.#Prefix
	dimension: #Dimension
	source:    string
	steps: [string]: string
}

#Scale: {
	let S = self
	sources: [string]~(Name,_): #Source
	buckets: [string]~(Name,_): #Bucket
	// Both of these are non-hidden because a hidden field is evaluated only where
	// something dereferences it, and neither of these is dereferenced anywhere:
	// a guard nothing evaluates is a guard nothing has. Non-hidden, they ride
	// #emit's `scale`, so `cue export` fails before the writer emits a byte, and
	// `cue vet -c ./...` names the bucket at test.
	//
	// Building the index IS the uniqueness check — two buckets under one prefix
	// write two different names into one key and conflict here — which is a
	// collision the emitter could not resolve. A NESTED prefix is not a collision
	// but a vocabulary: Open Props publishes --size-1 beside the --size-px-1 its
	// admitted.json refuses, and nothing matches a name against this map.
	prefixes: {for n, b in S.buckets {(b.prefix): n}}
	// A bucket naming a source the scale does not carry would emit bytes with no
	// provenance, which is the one thing a vendored vocabulary owes. Keyed by
	// bucket so the error names it.
	sourced: {for n, b in S.buckets {(n): S.sources[b.source] & #Source}}
	// Two buckets in one JOINING dimension both answer a literal, and nothing in
	// the composition says which of the two names a rule should teach. Adoption is
	// a replacement argument per dimension rather than an addition, and this is
	// that argument as a constraint; a dimension that ever needs two buckets gets
	// a declared order rather than a tie-break.
	//
	// `opaque` is exempt because a step there publishes a name and joins nothing —
	// scaleSteps skips the dimension before it offers — so `shadow` and `min`
	// cannot compete for a norm.
	joined: {for n, b in S.buckets if b.dimension != "opaque" {(b.dimension): n}}
}

// The value vocabulary this platform ships, drawn from the generated files under
// scales/ — which scales/build.ts writes from the archives vendored beside them —
// and from pronto's own. The composition is written out because the order of
// these lines is the order the rung block is emitted in, which is the one thing
// about the vocabulary that is neither the vendor's nor derivable — and a bucket
// the generator publishes that this list drops is caught by the admission rule in
// invariants.sql, which asks the archive rather than this list.
//
// Distinct from #Design: #Design states one app's own identity, whereas this is
// the vocabulary every identity is spelled in. And it has no app seam at all —
// an app that needs a length the scale lacks names a ROLE, which is a
// decision, rather than a rung, which is not. That is what keeps a scale from
// becoming a junk drawer.
//
// A step carries no dark twin because a rung has no appearance: 1rem is 1rem
// in both. What changes with the appearance is WHICH rung a role points at,
// and that indirection lives one namespace up, where the twin is closed.
//
// Only values come in: Open Props' animations pack is 23 shorthands unusable
// without the 25 @keyframes beside them, and a vocabulary that ships rules is
// a stylesheet, not a vocabulary.
#scale: #Scale & {
	sources: {
		openprops: scales.openprops.source
		primer:    scales.primer.source
		pronto:    {kind: "own", origin: "pronto", version: "this repository"}
		terminal:  {kind: "own", origin: "omnishell", version: "this repository"}
	}
	buckets: {
		size:   scales.openprops.buckets.size
		border: scales.openprops.buckets.border
		// Geometry only, and pronto's own: the six upstream NAMES republished over
		// the twinned ink roles, for the reason #shadowInks gives. #Design defaults
		// the inks, so these var()s never dangle.
		shadow: {
			prefix:    "--shadow-"
			dimension: "opaque"
			source:    "pronto"
			steps: {
				"1": "0 1px 2px -1px var(--shadow-ink-10)"
				"2": "0 3px 5px -2px var(--shadow-ink-4), 0 7px 14px -5px var(--shadow-ink-6)"
				"3": "0 -1px 3px 0 var(--shadow-ink-3), 0 1px 2px -5px var(--shadow-ink-3), 0 2px 5px -5px var(--shadow-ink-5), 0 4px 12px -5px var(--shadow-ink-6), 0 12px 15px -5px var(--shadow-ink-8)"
				"4": "0 -2px 5px 0 var(--shadow-ink-3), 0 1px 1px -2px var(--shadow-ink-4), 0 2px 2px -2px var(--shadow-ink-4), 0 5px 5px -2px var(--shadow-ink-5), 0 9px 9px -2px var(--shadow-ink-6), 0 16px 16px -2px var(--shadow-ink-7)"
				"5": "0 -1px 2px 0 var(--shadow-ink-3), 0 2px 1px -2px var(--shadow-ink-4), 0 5px 5px -2px var(--shadow-ink-4), 0 10px 10px -2px var(--shadow-ink-5), 0 20px 20px -2px var(--shadow-ink-6), 0 40px 40px -2px var(--shadow-ink-8)"
				"6": "0 -1px 2px 0 var(--shadow-ink-3), 0 3px 2px -2px var(--shadow-ink-4), 0 7px 5px -2px var(--shadow-ink-4), 0 12px 10px -2px var(--shadow-ink-5), 0 22px 18px -2px var(--shadow-ink-6), 0 41px 33px -2px var(--shadow-ink-7), 0 100px 80px -2px var(--shadow-ink-8)"
			}
		}
		ease:  scales.openprops.buckets.ease
		layer: scales.openprops.buckets.layer
		ratio: scales.openprops.buckets.ratio
		// The terminal's own measured floors, read off the terminal rather than
		// restated; omnishell.#Terminal.capabilities.floors argues the one
		// declaration. Device px, because a body's reach is not keyed to a font size.
		min: {
			prefix:    "--min-"
			dimension: "opaque"
			source:    "terminal"
			steps:     {for n, px in omnishell.#Terminal.capabilities.floors {(n): "\(px)px"}}
		}
		// Type quotes Primer's base ladder, and what decides it is step economy
		// rather than coverage. Over the corpus the literal rule reads —
		// `select count(*) from app_literal where dimension = 'text'`, 484 rows —
		// Primer's six steps join 215 and Tailwind 4.3.3's thirteen join 216: one
		// occurrence for seven more emitted names, because every Primer step joins
		// something and six of the thirteen (3xl, 5xl..9xl) publish a name no
		// stylesheet here writes. 35.8 occurrences a step against 16.6.
		//
		// Leading is a tie at 63 of 196, two joining steps each. The two ladders
		// spell tight, snug, normal and relaxed identically and differ only at
		// `loose`, which nothing writes, so it follows its size from one vendor
		// rather than splitting a designed pair — and #Scale.joined refuses a
		// second bucket in either dimension.
		//
		// The weight ladder declared beside them is refused in the tree's own
		// admitted.json. Primer's functional sheet is not vendored at all:
		// --text-body-*, --text-title-* and --fontStack-* name purposes rather than
		// values, and --fontStack-sansSerif opens "Mona Sans VF", so quoting it
		// would put a vendor's display face in every app's rung block.
		text:    scales.primer.buckets.textSize
		leading: scales.primer.buckets.textLineHeight
	}
}

// The design system's values. An app states them once, as the YAML
// frontmatter of its DESIGN.md, and program.cue reads them through #DesignMd
// below — the file's body argues the identity and its frontmatter carries it,
// the same division the ir and the program keep for behaviour. There are no
// named theme presets: every app explicitly authors its eight core colour roles
// in both `colors` and `dark` and selects its navigation posture in `shell.nav`,
// while structural geometry and motion carry sensible defaults an app may
// refine. The emitter alone turns these into CSS; the fact-store join
// (invariants.sql) guards the fork.
#Design: {
	let D = self

	colors: [string]: string & !=""
	colors: {
		for n in #colorRoles {(n): string & !=""}
		"shadow-ink-3":  *"hsl(220 3% 15% / 3%)" | (string & !="")
		"shadow-ink-4":  *"hsl(220 3% 15% / 4%)" | (string & !="")
		"shadow-ink-5":  *"hsl(220 3% 15% / 5%)" | (string & !="")
		"shadow-ink-6":  *"hsl(220 3% 15% / 6%)" | (string & !="")
		"shadow-ink-7":  *"hsl(220 3% 15% / 7%)" | (string & !="")
		"shadow-ink-8":  *"hsl(220 3% 15% / 8%)" | (string & !="")
		"shadow-ink-10": *"hsl(220 3% 15% / 10%)" | (string & !="")
	}
	// The dark twin declares the SAME names — appearance is a token
	// resolution, never a state. Emitted as the second argument of each
	// token's light-dark(), so the two palettes are one declaration and a
	// name can no longer appear in a single appearance: a missing twin and a
	// twin nothing reads are both errors here rather than a token that
	// silently stops changing, or never changed at all.
	dark: close({for k, _ in D.colors {(k): string & !=""}})
	dark: {
		"shadow-ink-3":  *"hsl(220 40% 2% / 27%)" | (string & !="")
		"shadow-ink-4":  *"hsl(220 40% 2% / 28%)" | (string & !="")
		"shadow-ink-5":  *"hsl(220 40% 2% / 29%)" | (string & !="")
		"shadow-ink-6":  *"hsl(220 40% 2% / 30%)" | (string & !="")
		"shadow-ink-7":  *"hsl(220 40% 2% / 31%)" | (string & !="")
		"shadow-ink-8":  *"hsl(220 40% 2% / 32%)" | (string & !="")
		"shadow-ink-10": *"hsl(220 40% 2% / 34%)" | (string & !="")
	}
	rounded: [string]: string
	rounded: {
		sm:   *"4px" | string
		md:   *"8px" | string
		full: *"999px" | string
	}
	// px, not var(--size-N): rewriting structural roles to rem indirections
	// would fork apps that declare `spacing` concretely at non-16px roots.
	spacing: [string]: string
	spacing: {
		sm: *"8px" | string
		md: *"16px" | string
		lg: *"24px" | string
		xl: *"40px" | string
	}
	// The motion vocabulary. The terminal ships no style at all — its
	// shell.css is the empty contract — so this is the only declaration;
	// naming a key here replaces its structural default.
	motion: [string]: string
	motion: {
		fast:  *"110ms" | string
		base:  *"180ms" | string
		ease:  *"cubic-bezier(.2, 0, 0, 1)" | string
		shift: *"6px" | string
	}
	// Lengths a screen reaches for by role rather than by rung. #scale is the
	// vocabulary beneath these and has no app seam; a length the scale lacks
	// is named HERE, because a decision belongs in the app's own block and a
	// rung does not. pad-x points at a spacing role — the two layers meeting.
	control: [string]: string
	control: {
		"h-xs":  *"28px" | string
		"h-sm":  *"32px" | string
		h:       *"36px" | string
		"h-lg":  *"40px" | string
		"pad-x": *"var(--sp-md)" | string
	}
	// Page-level widths. Identity, not scale: every entry is the app's own.
	measures: [string]: string
	// A named size or leading, emitted --type-*, chosen so it collides with no
	// vendored ladder's prefix. A key spelled leading-* is a line-height and any
	// other is a font size, because a role's dimension is read off its name and a
	// font size and a line-height are refused toward different properties — so
	// unlike --motion-*, where a time and an easing share one name space and the
	// norm tells them apart, these two cannot.
	//
	// A purpose is named from `display, title, subtitle, heading, lead, body,
	// body-small, label, caption, overline, code`, each with an optional
	// `leading-<stem>` twin: Primer's functional layer read as a list of
	// purposes, so a reader who knows that vocabulary knows this one.
	//
	// TWO default leadings, not one per purpose: the vendored ladder has five
	// steps and two roles at one norm raise, so prose and headings leave three
	// steps free for any purpose that needs its own.
	//
	// A role carries its VALUE. A role that aliased a rung would win its norm, and
	// `best` keeps one step per (dimension, norm), so the rung would drop out of
	// what the lint can name in that app and the app's identity would move under a
	// vendor's release. A role aliases another ROLE only to say "the same value as
	// that purpose", which is also the one legal spelling of it, since two roles
	// at one norm raise.
	type: [string]: string
	type: {
		display:         *"2.5rem" | string
		title:           *"2rem" | string
		subtitle:        *"1.25rem" | string
		body:            *"1rem" | string
		caption:         *"0.875rem" | string
		label:           *"0.75rem" | string
		"leading-title": *"1.25" | string
		"leading-body":  *"1.625" | string
	}
	// Keys are <element>-<property> and values POINT AT a role or a rung, so the
	// tier says which geometry a class of control wears without inventing a value.
	// A constraint, not a convention: this tier publishes no step, so a literal
	// here would put a value into :root under a name no ladder quotes, no literal
	// rule reads and no role space grades — the junk drawer the tier exists to
	// avoid. The target must itself be published, which scaleSteps closes by
	// resolving every declared token's one-level reference, this tier included.
	//
	// Emitted --c-*, and like control and measures it publishes no step: which box
	// gets which is a decision, not a value to refuse a literal toward.
	component: [string]: #Reference
	// Which colour the terminal's own chrome resolves to, optional brand title
	// rendered at the inline start of `body > nav`, and which navigation posture
	// (`topbar`, `tabbar`, `sidebar`, `dock`, `custom`, or `none`) `design.css` emits
	// at `:where(...)` specificity. `nav` has no default: every app chooses its
	// chrome explicitly.
	shell: {
		bg:        *"neutral" | string
		fg:        *"primary" | string
		rule:      *"border" | string
		nav:       #NavPosture
		title?:    string & !=""
		titleKey?: string & !=""
		if titleKey != _|_ {
			title: string & !=""
		}
		if nav == "none" {
			title?:    _|_
			titleKey?: _|_
		}
	}
}

// The reader of an app's DESIGN.md: `text` is the file, embedded by program.cue
// (`_designMd: _ @embed(file="DESIGN.md", type=text)` under `@extern(embed)`),
// and `design` is its YAML frontmatter — the lines between a first line that is
// exactly `---` and the next such line — unified with #Design, so that a key
// #Design lacks, a missing required palette role or `shell.nav` posture, a value
// of the wrong shape and a file without a frontmatter are all errors at `cue vet`
// and at export. The frontmatter is the one declaration: program.cue restates
// none of it (`surface: design: (pronto.#DesignMd & {text: _designMd}).design`).
#DesignMd: {
	text:   string
	_lines: strings.Split(text, "\n")
	// A fence is a whole line, so a CRLF ending, trailing space or a byte before
	// the opening fence is not one, and a `---` in the body cannot be mistaken
	// for the closing fence: the first one after the opening line closes it.
	_closes: [for i, l in _lines if i > 0 && l == "---" {i}]
	_fenced: _lines[0] == "---" && len(_closes) > 0
	// The error sits on `design` itself, so it surfaces wherever the design is
	// read rather than only where the reader is inspected.
	if _fenced {
		design: #Design & yaml.Unmarshal(strings.Join(list.Slice(_lines, 1, _closes[0]), "\n"))
	}
	if !_fenced {
		design: error("DESIGN.md has no frontmatter: the design block is the YAML between a first line that is exactly --- and the next such line")
	}
}

// An entity's durable identity: 64 random bits, Cap'n Proto's form, minted by
// identity.ts and never by the compiling model. Why a name cannot be this is
// docs/types-and-identity.md#identity.
#TypeId: string & =~"^0x[89a-f][0-9a-f]{15}$"

// A field's type is a portable type the table names (types.cue), or one of the
// physical labels an older program still spells.
#Type:       or([for _name, _ in #types {_name}])
#LegacyType: or([for _name, _ in #typeAlias {_name}])

#Field: {
	name: string
	// Which field of its entity this is, for as long as the entity lives. The
	// name is a label over it; a holder that keeps rows keeps them by this.
	ordinal?: int & >0
	// A field is never removed, because an ordinal that was forgotten can be
	// minted again over rows that still mean the old thing.
	retired: *false | bool
	// What is left of a retired field is its place: nothing writes it, so it
	// cannot be demanded, and nothing reads it, so it forbids nothing.
	if retired {
		required: false
		cel?:     _|_
	}
	type: #Type | #LegacyType
	if type == "decimal" {
		precision!: int & >=1 & <=38
		scale!:     int & >=0 & <=precision
	}
	pk:       *false | bool
	required: *true | bool
	ref?:     string // referenced table; DDL: REFERENCES <ref>(id) ON DELETE CASCADE
	unique?:  bool
	default?: string // SQL expression
	// SQL expression; DDL: GENERATED ALWAYS AS (<expr>) STORED. Generated
	// fields emit no NOT NULL/DEFAULT and never appear in forms.
	generated?: string
	// Field behaviour, in Google AIP-203's words (https://google.aip.dev/203),
	// the same for every client whatever its role, as Drive marks a file's
	// modifiedTime "Output only". An output-only field is set by the server
	// alone: a value a client sends is cleared, never refused, so a client
	// insert takes the default and a client update keeps the value. An
	// immutable field is set when its row is created and never changed: a
	// client update stating the same value passes, and one changing it is
	// refused as an invalid argument. The server's writers (machines,
	// computations, seeds, migrations, the service) write both. Neither is a
	// key's, a generated field's, a retired one's or a row machine's state
	// field's, and a field is not both.
	outputOnly?: bool
	immutable?:  bool
	// The one statement of the field's constraint, `this` bound to the field
	// value. Its SQL CHECK body and its CUE constraint are derived from the
	// parsed expression (program_cel.cue), never written beside it.
	cel?: string
	// A value the reader types once for an external effect, a PIN, kept as
	// Kubernetes keeps a sealed secret: the screen seals it to the airlock's
	// public key, so only ciphertext travels and is stored, and the airlock
	// opens it in memory just before its handler's call. The column is NULL in
	// every row; a write naming it hands the sealed value to the airlock's
	// secret table for five minutes, where the effect naming it in `secrets`
	// reads it. What else it may not touch is refused at #App
	// (docs/decisions/2026-11-16-secret-fields.md).
	secret?: true
	if secret != _|_ {
		type:     "string"
		required: false
		pk:       false
	}
}

// Row visibility, enforced as RLS policies (006_policies.sql). Modeled after the
// Google Drive access model, in its words:
//   scope: "private"   - owned by user, optional shared list and group grants
//   scope: "folder"    - inherited access from parent entity
//   scope: "public"    - public read-only to anyone
//   scope: "internal"  - restricted to backend services
//   scope: "group"     - the membership list: who is in which group
// Column names (`owner`, `on`, `user`, `role`, `of`, `group` under scope
// "group") are of the entity's own table; `via` is a table name, `parent` an
// entity name whose access is private.
//
// A grant carries a Drive role. `shared.role` names the grant table's column
// holding it, and a grant table without one grants "writer". A reader reads
// the row and what is under it; a writer also changes both and edits its
// grants, unless `writersCanShare: false`, Drive's setting of that name, keeps
// the grants the owner's; only the owner deletes the row or hands it to
// another owner, and is left its writer by a grant row the cluster writes.
//
// A grant names a user or, where `shared.group` names a second column of the
// grant table, a group: the membership list's group id as it is written. A
// grant row fills one of the two columns, and which one is the grantee's type.
#Access: {
	scope: "private" | "folder" | "public" | "internal" | "group"
	if scope == "private" {
		close({
			scope:   "private"
			owner:   string
			shared?: {via: string, on: string, user: string, group?: string, role?: string, writersCanShare?: bool}
			groups?: [#GroupGrant, ...#GroupGrant]
		})
	}
	if scope == "folder" {
		close({
			scope:  "folder"
			parent: string
			on:     string
		})
	}
	if scope == "public" {
		close({
			scope:  "public"
			write?: bool | "update"
		})
	}
	if scope == "internal" {
		close({
			scope: "internal"
		})
	}
	if scope == "group" {
		close({
			scope: "group"
			group: string
			user:  string
		})
	}
}

#Role: "reader" | "writer"

// A row shared with a group it names: the group `<value of "of">:<group>`,
// where `of` is a column of the row and its key when omitted, as Drive's
// finance@acme is a name at a domain. Membership is the program's one
// scope "group" entity, which the service writes.
#GroupGrant: close({
	group: =~"^[a-z][a-z0-9_]{0,30}$"
	of?:   string
	role:  #Role
})

#Durability: "server" | "live" | "offline" | "tab" | "device"

// What can be claimed of a write, from the durability of the row it lands on:
// the saga's compensatable and retriable steps and its pivot (Garcia-Molina &
// Salem 1987), with the local step and the pure function at either end. Never
// authored; shown on the entity, the machine and in every lint sentence. The
// terminal keeps the same table (omnishell/machine.cue) for its own lint, and a
// test holds the two equal.
#EffectLevel: "projection" | "ephemeral" | "compensable" | "replicated" | "external"
#DurabilityEffectLevel: {
	tab:     "ephemeral"
	device:  "ephemeral"
	offline: "compensable"
	live:    "compensable"
	server:  "replicated"
}

#Entity: {
	let E = self
	name:  string
	ir:    *name | string
	table: string
	id?:   #TypeId
	// Ordinals are 1..n: none exceeds the count and no two agree. That every
	// field HAS one is identity.ts's to say, because a field an author just
	// added has none until it mints, and it has to be able to read the program
	// to do that.
	fields: [...{ordinal?: <=len(E.fields)}]
	// A stated row meets its types' canonical forms where it meets its cel.
	seed:      [...{for f in E.fields if #TypeConstraint[f.type] != _|_ {(f.name)?: #TypeConstraint[f.type].valid}}]
	_ordinals: {for f in E.fields if f.ordinal != _|_ {"\(f.ordinal)": f.name}}
	// Every value names a guarantee, and they are monotonic in expense:
	//
	//   tab      survives navigation
	//   device   survives a restart
	//   server   survives device loss; the client asks for it each time
	//   live     ...and the client sees changes without asking
	//   offline  ...and it works with no network
	//
	// It reads as one ladder and decomposes as two questions — what holds the
	// truth, and what the client keeps of it:
	//
	//                | keeps nothing | keeps to the tab | keeps to the device
	//   client truth |       —       |       tab        |       device
	//   server truth |     server    |       live       |       offline
	//
	// so `tab` is to `device` as `live` is to `offline`: the same question of
	// whether the client's copy survives a restart, asked once on each side.
	// The decomposition is worth reading and not worth authoring — an enum
	// names the five valid points, where two fields would also name a sixth
	// that cannot exist.
	//
	// The emitter derives everything from this — table, trigger, publication
	// entry, policy, outbox — so a reviewer can see the cost someone chose.
	//
	// Visibility is a different axis. A tab or device entity is private by
	// construction, with no policy to write, which is why `access` is not
	// merely optional for them but meaningless: nothing else can reach it.
	durability: #Durability
	level:      #DurabilityEffectLevel[durability]
	// Whether the rows live in the cluster: every durability but the two the browser keeps.
	// The one spelling of that boundary; the emitter reads this, never the names.
	server: durability != "tab" && durability != "device"
	if durability == "tab" || durability == "device" {
		access?: _|_
	}
	if durability != "tab" && durability != "device" {
		access?: #Access
	}

	// How the terminal reads the table: "eager" takes the whole shape before
	// a screen reads it; "lazy" loads what each active query demands.
	// #App.#read decides it for every server entity (read.cue), so an authored
	// value it contradicts fails to unify.
	if server {
		read: "eager" | "lazy"
	}
	if !server {
		read?: _|_
	}

	// Who writes rows here, derived at #App (writers.cue) from every
	// declaration that names the entity; the card prints each as
	// `kind:by op·op`. Nothing refuses two kinds of writer on one entity
	// (PENDING.md).
	writers: [...#Writer]
	fields:  [...#Field]
	// DDL: CREATE INDEX IF NOT EXISTS idx_<table>_<on> ON <table>
	// USING <using> (<on>); emitted after the tables in 005.
	indexes?: [...{on: string, using: *"btree" | "gin"}]
	// Row-level constraint, `this` bound to the row. Its CHECK body is derived
	// like a field's, but only its CHECK: a predicate over several columns is
	// not a constraint on any one field's value, so no CUE rendering exists.
	invariant?: {cel: string, check?: string}
	// What the parsed `cel` of each field says, in the languages its readers
	// speak, all written by one derivation (program_cel.cue, derive-cel.ts)
	// so no reader parses a cel itself: `checks` are the SQL CHECK bodies by
	// column (none for a browser tier, which emits no table); `enums` the
	// values a column admits, only where the constraint closes the set, for
	// the terminal's markup rules and the emitted shell.yaml; `bounds` what an
	// open constraint admits — a range, a length, a pattern — for a battery
	// that has to PROPOSE a value, every key optional and absent unbounded.
	// Empty is what a first export holds before any derivation has run.
	cel: {
		checks: *{} | {[string]: string}
		enums:  *{} | {[string]: [...string]}
		bounds: *{} | {[string]: #Bounds}
	}
	// Composite uniques the per-field `unique` flag cannot express. Declared
	// rather than written as assembly SQL because the shell needs them too: a
	// row's natural key is what an upsert resolves against, and what an
	// optimistic contribution is collapsed on. The name is carried rather than
	// derived because a violation IS the app's duplicate refusal and the
	// constraint name is what reaches the screen.
	//
	// `where` makes the unique partial: it holds only over rows matching the
	// predicate, stated in the data-plane fragment grammar. A partial unique
	// is a slot's cardinality witness ("at most one row wears this flag"),
	// never a natural key — upserts cannot resolve against it. Browser
	// durabilities only: its SQL rendering (a partial unique index) waits for
	// a cluster consumer.
	uniques: *[] | [...{name: string, cols: [...string], where?: string}]
	if durability != "tab" && durability != "device" {
		uniques: [...{where?: _|_}]
	}

	// Derived from lifecycle-machine guards; the refusal names are shared by
	// the server interpreter and the browser preflight.
	validations: [string]~(Name,_): #Validation & {name: Name, machine?: string, on?: [...string]}

	// Bootstrap rows: the rows a store holds before anyone writes one. A
	// cluster durability renders them into 900_seed.sql; a `tab` entity has no
	// migration to render into, so the terminal writes them itself when it
	// first opens the collection (shell.yaml `seed:`).
	//
	// A pipeline-written singleton MUST seed its initial state: pipelines fire
	// on CDC events, so before the first mutation the derived row exists only
	// if the schema bootstrap made it.
	//
	// Both keep the same rule — the rows are written once against an
	// empty store and never reconsidered — because at both the store's
	// birth is what triggers them: a fresh database runs the migration, a
	// fresh tab collection is seeded at open. A row the reader deletes
	// therefore stays deleted for as long as its store lives.
	seed: [...{[string]: string | int | bool}]
	if durability == "device" {
		// Not deferred — the tier is the wrong home for a stated row. A device
		// collection outlives the page, so its birth and the terminal's boot
		// are different moments and the rule above has nothing to hang on:
		// seeding at every open resurrects what the reader deleted, and
		// seeding once needs a ledger of what was already seeded that the
		// reader cannot delete.
		//
		// No such ledger is needed, because the program is already the durable
		// copy of anything it states. Rows the PROGRAM owns belong at `tab`,
		// re-stated on every load and therefore never stale; `device` is for
		// what the READER makes, which is exactly what a seed is not. An app
		// wanting both reads its stated rows from the tab entity and keeps the
		// reader's own at device.
		seed: []
	}
}

#Validation: {
	machine?: string
	on?:      [...string]
	order?: [string]: [int, int]
	name: string & =~"^[a-z][a-z0-9-]*$"
	ir:   *name | string
	src:  #Jessie
	// The references the predicate may follow. A field of the entity that
	// carries `ref` walks forward to the one referenced row; "<Entity>.<field>"
	// whose field refs this entity walks backward to every row pointing here.
	via:  *[] | [...string]
	note: string
	// Resolved by derive (program_validations.cue): each edge as the SQL and
	// the store read it: rows of `table` whose `key` equals the row's `from`.
	edges?: [...{table: string, key: string, from: string}]
	// The module split at its completion, for the plv8 body.
	module?: {statements: string, completion: string}
}

// A numeric program (docs/pipelines-and-schedules.md#computations): a module
// run by mecha's compute service, whose services/compute/main.ts states the
// contract.
#Computation: {
	name:        string
	src:         *"computations/\(name).js" | string
	risingwave?: string & !=""
	steps?:      string & !=""
	// The live entities it alone writes.
	to: [...string] & [_, ...]
	sinkWrites?: [string]: "replace" | "upsert"
	if sinkWrites != _|_ {_sinkWriteTargets: [for sink, _ in sinkWrites {list.Contains(to, sink) & true}]}
	sinkColumns?: [string]: [...string] & [_, ...] & list.UniqueItems()
	if sinkColumns != _|_ {
		typedSinks: true
		_sinkColumnTargets: [for sink, columns in sinkColumns {
			list.Contains(to, sink) & list.Contains(columns, "id") & true
		}]
	}

	// App-relative paths of the committed wasm modules its jobs call, each
	// named in a job by its file's stem.
	wasm: *[] | [...string]
	// What its module may use past the language, as an omnishell module
	// declares Intl: Crypto among them. Undeclared, a use is a refusal.
	endowments:  *[] | [...mechaCluster.#CageEndowment]
	onComplete?: string & =~"^[a-z_][a-z0-9_]{0,62}$"
	queryTypes?: [string]: [...mechaCluster.#ComputationField & {type: #Type | #LegacyType}]
	typedSinks:     *false | bool
	declaredReads?: [...string]
}

#Pipeline: {
	let P = self

	// Equivalent SQL recount for hosts without the CDC pipeline runtime.
	portableDrain?: #Drain & {name: P.name}
	name:           string
	ir:             *name | string
	trigger:        *"cdc" | "schedule"
	// Complex pipelines are assembly: `src` (under pipelines/) holds the whole
	// rpk stream YAML, copied verbatim to docker/<app>-<name>.yaml. The file
	// owns input, transform, and output alike — aggregate/bloblang/key/shim do
	// not apply, and loop prevention is the author's burden (the emitter
	// cannot see inside).
	raw?: true
	if raw != _|_ {
		src:        *"pipelines/\(name).yaml" | string
		note!:      string & !=""
		delivery:   "unspecified"
		transform?: _|_
		key?:       _|_
	}

	from?:  string // source entity name (CDC events); cdc pipelines set it
	to:     string // sink entity name (upsert, or scheduled mutation target)
	group?: string // bus consumer group; cdc pipelines set it
	// Keyed aggregate: the transform groups source rows by this column and
	// emits an ARRAY of sink rows; the sink upsert conflicts on the sink pk.
	// Unset = singleton transform emitting one row.
	key?: string
	transform?: {
		aggregate: string                              // PostgREST query the transform reads from the source table
		src:       *"pipelines/\(name).blobl" | string // assembly file holding the mapping
		bloblang:  string                              // its content — inlined where the consumer cannot reference files
	}
	// A keyed aggregate's transform, written as a fold: empty(key),
	// step(acc, row), combine(a, b), result(acc), with `harden` supplied by
	// SES. Nothing runs the module at any tier
	// (docs/pipelines-and-schedules.md#below-the-cluster): the declaration is
	// the served contract that `projects`, `watermark` and `pair` hang off. It
	// replaces `shim`, whose (rows) => one row on id cannot state a keyed
	// aggregate.
	//
	// The container keeps its bloblang. rpk can run this module (it embeds
	// goja), but nothing lints a JavaScript string inside a pipeline YAML while
	// `redpanda-connect lint` does catch a broken mapping — so the sharing
	// bought less than the lost build-time check cost.
	// Convert a container transform only where the aggregate is substantial
	// enough that two expressions of it could genuinely diverge.
	//
	// Two laws no type states: combine is associative with empty(key) as its
	// identity, so a fold splits; and the ACCUMULATOR IS THE SINK ROW, so a
	// sink can be read back as a partial fold. The second is why the sink
	// carries `watermark` below, and why an average would have to store sum
	// and n rather than the quotient.
	fold?: {
		src: *"pipelines/\(name).js" | string
		// The sink column the terminal re-projects optimistically. Named here
		// because the interpreter is generic: without it the projection has to
		// guess, and a guess that is right for one app is silently `undefined`
		// for the next.
		projects: string
		// Sink column holding the newest source txid the count includes. NOT
		// the sink's own txid, which is stamped when the sink row is written —
		// strictly after the read, so it counts rows it never saw.
		watermark: string
		// Source columns uniquely identifying one contribution (the table's
		// composite unique). The projection reads `key`, not these, to hold the
		// reader to one row.
		dedupe: [...string]
		// Source column that, when set, means the row has been retracted.
		retracted: string
		// The reader's own private answer to "did the count include me".
		//
		// A public aggregate mixes this reader's row with everyone else's, and
		// the difference is not recoverable from the reader's own row: it is a
		// property of the READ that produced the total, not of the data now. So
		// the pipeline emits it, per reader, into a table RLS keeps private —
		// a count discloses nobody, and each browser syncs only its own row.
		//
		// What the terminal actually maintains is `others`, which no write of
		// this reader's can change; their intent applies on top of it, live and
		// offline alike. `total` is carried beside `counted` so the pair is one
		// row from one read, and `asOf` names the version of the reader's row it
		// describes.
		pair: {
			table:   string
			counted: string
			total:   string
			asOf:    string
		}
	}
	if fold != _|_ {
		shim?: _|_
		key:   string // a fold groups; the singleton case has no key to seed empty() with
	}

	// Scheduled pipelines: a generate input ticks every `interval` and the
	// action mutates `to` rows matched by `filter` (PostgREST fragment;
	// tokens {cutoff} and {nowts} resolve to bloblang metadata at runtime).
	interval?: #PipelineDuration
	action?:   "delete" | "update"
	filter?:   string
	// Required when filter uses {cutoff}: cutoff = now - window.
	window?: #PipelineDuration
	set?:    {[string]: bool | int | string} // PATCH body for action "update"
	// A cdc pipeline's browser twin of its bloblang: a pure ES module, rows →
	// sink row, declared and served. The page's cluster runs no stream, so
	// nothing executes it (docs/pipelines-and-schedules.md#below-the-cluster).
	// Scheduled and raw pipelines have no shim, and a fold names its module
	// instead.
	if trigger == "cdc" if raw == _|_ if fold == _|_ {
		shim: *"pipelines/\(name).browser.js" | string
	}
}

// A pipeline's period: ISO 8601's duration in whole hours, minutes and
// seconds (PT1H, PT30M, PT1H30M), as the duration type spells one; a day or a
// month is refused, having no fixed length.
#PipelineDuration: =~"^PT([0-9]+H)?([0-9]+M)?([0-9]+S)?$" & !="PT"

// The columns mecha writes on a tick, for the entity a #Schedule emits into.
// Spelled here rather than injected at emit so the entity a reviewer reads is
// the entity that exists. The ticker writes all five LAST, after the
// declaration's own values, so nothing an app states can overwrite them.
//
// Combine with `list.Concat([#tickFields, [...]])`: `+` on lists is not supported.
#tickFields: [...#Field] & [
	{name: "id", type: "uuid", pk: true},
	{name: "schedule", type: "text"},
	{name: "tick_at", type: "timestamptz"},
	// The tick was decided and not run: its lateness budget had passed. A
	// pipeline reading this table skips these, and Forbid never waits on one.
	{name: "late", type: "bool"},
	{name: "caller", type: "text", required: false},
]

// A periodic wake, declared. The clock is the cluster's; what an app states
// is which occurrences it wants and what row each one becomes.
//
// Occurrence semantics, deliberately not reconciliation: a tick names an
// instant, can be missed, and fires at most once for that instant. A pipeline
// whose job is "make this predicate false, repeatedly" wants #Pipeline's own
// trigger instead — it needs no identity, no watermark and no lateness.
#Schedule: {
	let S = self
	name: string
	ir:   *name | string
	// Five fields, the only grammar. A step steps over `*` or a range
	// (`*/10`, `5-59/10`); `n/step` is refused here, as the ticker refuses it.
	cron:     string & !~"(^|[ ,])[0-9]+/"
	timeZone: *"UTC" | string
	suspend:  *false | bool
	// Older than this and a tick is recorded `late` and not run: the moment it
	// was defending has passed. Floors at the coarsest clock any tier runs, or
	// every tick is late on arrival.
	maxLatenessSeconds: *300 | int & >=60
	// Forbid declines to emit while the previous tick is unanswered, without
	// advancing the watermark — a delay, never a drop. It is backpressure as
	// much as concurrency control: a pipeline that has stopped answering stops
	// receiving.
	concurrency: *"Allow" | "Forbid"
	// The entity a tick becomes a row in, and what the declaration sets on it.
	// Mecha owns `id`, `schedule`, `tick_at`, `late` and `caller` on that
	// entity and writes them last, so `values` can overwrite none of them.
	// It must be durability "server": the publication carries those, and a tick
	// nothing reads is not a tick.
	emits: {
		entity: string
		values: {[string]: bool | int | string}
	}
	// Where a pipeline says it answered a tick, and the filter that says so.
	// A DIFFERENT entity from `emits.entity`, and necessarily: the tick table
	// is a CDC source, so the pipeline reading it cannot write back to it
	// without feeding itself. The answer lands in a sink — durability "live",
	// which the publication excludes.
	done?: {entity: string, filter: string}
	if S.concurrency == "Forbid" {
		done: {entity: string, filter: string}
	}
}

// A database function the cluster calls when tables it reads change: a queue
// it drains, or the sources of a projection it recomputes whole
// (docs/pipelines-and-schedules.md#drains). The call is the whole job, so it
// must be idempotent and must make progress: a drain that leaves its queue
// non-empty without changing it is never woken again, and one that rewrites
// its own queue on every call never sleeps.
#Drain: {
	name: string
	ir:   *name | string
	// Tables whose change wakes the drain, each of which the publication must
	// carry: the default one carries every `server` entity, and any other table
	// is the app's to add, as an app narrowing its publication adds all of them.
	// A function whose answer moves with the date names a #Schedule's tick
	// entity here, and the tick wakes it.
	// Unqualified, as a change names its table: `public.x` would never match.
	on:     [=~"^[a-z_][a-z0-9_]{0,62}$", ...=~"^[a-z_][a-z0-9_]{0,62}$"]
	call:   string & =~"^[a-z_][a-z0-9_]{0,62}$"
	stream: *true | bool
	// The JSON arguments of every call, each named as a function's argument
	// is: the page's and the edge's clusters call `call(key => value, …)`.
	body: *{} | {[=~"^[a-z_][a-z0-9_]{0,62}$"]: bool | int | string}
	// The HTTP deadline of one call, in seconds above the service role's
	// statement_timeout so the database, not the client, ends a slow call
	// (resilience's drain bound).
	timeout: *"\(resilience.resilience.timeouts.drain)s" | =~"^[0-9]+(ms|s|m)$"
	_timeoutMs: [
		if strings.HasSuffix(timeout, "ms") {strconv.Atoi(strings.TrimSuffix(timeout, "ms"))},
		if !strings.HasSuffix(timeout, "ms") && strings.HasSuffix(timeout, "s") {strconv.Atoi(strings.TrimSuffix(timeout, "s")) * 1000},
		if strings.HasSuffix(timeout, "m") {strconv.Atoi(strings.TrimSuffix(timeout, "m")) * 60000},
	][0] & >(resilience.resilience.timeouts.statement.service * 1000)
}

// A Mecha statechart executed inside PostgreSQL — transactions, trigger reducers,
// finite timeouts, and deterministic relational effects. Level 3 effect limit.
//
// The ops mecha's interpreter performs, narrowed from the terminal's
// #MutationOp (one grammar, defined where the author-facing chart lives and
// classified there by delivery behavior). Atomicity groups effects within
// one invocation; it does not deduplicate separate deliveries. The sink owns
// acceptance and retry, and effect composition determines algebraic laws.
#RelationalOp: omnishell.#MutationOp & ("create" | "ensure" | "upsert" | "accumulate" | "update" | "delete")

#RelationalEffect: {
	schema?:       string & =~"^[a-z_][a-z0-9_]*$"
	op:            #RelationalOp
	table:         string
	values?:       {[string]: _}
	key?:          [...string]
	where?:        {[string]: _}
	rawWhere?:     string
	accumulate?:   [...string]
	updateValues?: {[string]: _}
}

#SqlHatchCall: {
	name:  string
	call:  string
	args?: [...] | {[string]: _}
}

#NotifyRaise: {
	notify:  string
	payload: string
}

#StreamRaise: {
	stream:  string
	signal?: "refresh" | "checkpoint" | "flush"
	key?:    string | {raw: string}
}

#MechaRaise: #NotifyRaise | #StreamRaise

#MechaReadLock: {
	when?:   string
	schema?: string & =~"^[a-z_][a-z0-9_]*$"
	table:   string & =~"^[a-z_][a-z0-9_]*$"
	key:     string & =~"^[a-z_][a-z0-9_]*$"
	values:  [_, ...]
}

#MechaSpawn: {machine: string & =~"^[a-z][a-z0-9_]*$", id: _, input: {[string]: _}, members: {[string]: _}}
#MechaSend:  {machine: string & =~"^[a-z][a-z0-9_]*$", id: _, event: string, payload: {[string]: _}}

#MechaAction: {
	spawn?:  #MechaSpawn
	send?:   #MechaSend
	lock?:   #MechaReadLock
	assign?: {[string]: _}
	effect?: #RelationalEffect | [...#RelationalEffect]
	hatch?:  #SqlHatchCall | [...#SqlHatchCall]
	raise?:  #MechaRaise | [...#MechaRaise]
	reject?: string
}

#MechaTransition: {
	target?:  string
	guard?:   string
	actions?: #MechaAction | [...#MechaAction]
}

#MechaTransitionValue: string | #MechaTransition | [...#MechaTransition]

// An arrow out of an invoking state. Its actions read the ledger's outcome as
// the PL/pgSQL variable `outcome`: {target, kind, data, reconciled}, where kind
// is done, failed or unknown.
#OutcomeBranch:     {target: string, guard?: string, actions?: #MechaAction | [...#MechaAction]}
#OutcomeTransition: string | #OutcomeBranch | [#OutcomeBranch, ...#OutcomeBranch]

#MechaState: {
	type?: "final" | "normal"
	on?: [string]~(Event,_):              #MechaTransitionValue
	// XState's after: a key is milliseconds, or a name the machine's delays
	// gives.
	after?: [=~"^(0|[1-9][0-9]{0,11}|[a-z][a-zA-Z0-9_]*)$"]: string | (#MechaTransition & {target!: string}) | [(#MechaTransition & {target!: string}), ...(#MechaTransition & {target!: string})]
	// XState's invoke, whose actor is an external effect's handler: entering
	// the state claims the effect, and only its outcome leaves.
	invoke?: {
		src:     string
		onDone:  #OutcomeTransition
		onError: #OutcomeTransition
	}
	entry?: #MechaAction | [...#MechaAction]
	exit?:  #MechaAction | [...#MechaAction]
}

#LifecycleTransition: {
	guard?:   string | [string, ...string]
	actions?: #MechaAction | [...#MechaAction]
}

#LifecycleTransitionValue: #LifecycleTransition | #MechaAction | [...#MechaAction]

#MechaMachine: {
	let M = self
	cortex?: {id: string, sourceEvents: [...string]}
	name:    string
	ir:      *name | string
	entity:  string
	guards: [string]~(Name,_): #Validation & {name: Name}
	level: #EffectLevel
	_actions: list.Concat([
		[for _, tr in M._on for act in tr.actions {act}],
		[if M.states != _|_ for _, st in M.states if st.entry != _|_ for a in [if (st.entry & [...]) != _|_ {st.entry}, [st.entry]][0] {a}],
		[if M.states != _|_ for _, st in M.states if st.exit != _|_ for a in [if (st.exit & [...]) != _|_ {st.exit}, [st.exit]][0] {a}],
		// A lone arrow's actions are asked of the arrow itself: wrapped in a
		// list first, a missing `actions` stalls CUE 0.18.0-rc.4 without end
		// when the machine is read under an inline (#emit & {...}).files.
		[if M.states != _|_ for _, st in M.states if st.on != _|_ for _, tr in st.on for acts in [if (tr & string) != _|_ {[]}, if (tr & [...]) != _|_ {[for t in tr if t.actions != _|_ {t.actions}]}, if tr.actions != _|_ {[tr.actions]}, []][0] for a in [if (acts & [...]) != _|_ {acts}, [acts]][0] {a}],
		[if M.states != _|_ for _, st in M.states if st.after != _|_ for _, tr in st.after for acts in [if (tr & string) != _|_ {[]}, if (tr & [...]) != _|_ {[for t in tr if t.actions != _|_ {t.actions}]}, if tr.actions != _|_ {[tr.actions]}, []][0] for a in [if (acts & [...]) != _|_ {acts}, [acts]][0] {a}],
		[if M.states != _|_ for _, st in M.states if st.invoke != _|_ for _, tr in {done: st.invoke.onDone, failed: st.invoke.onError} for acts in [if (tr & string) != _|_ {[]}, if (tr & [...]) != _|_ {[for t in tr if t.actions != _|_ {t.actions}]}, if tr.actions != _|_ {[tr.actions]}, []][0] for a in [if (acts & [...]) != _|_ {acts}, [acts]][0] {a}],
	])
	hatches: list.SortStrings([for hn, _ in {
		for a in M._actions if a.hatch != _|_
		for h in [if (a.hatch & [...]) != _|_ {a.hatch}, [a.hatch]][0] {(h.name): true}
	} {hn}])
	_on: {if M.on != _|_ for op, tr in M.on {
		let transition = tr.guard != _|_ || tr.actions != _|_
		(op): {
			guard: [if transition if tr.guard != _|_ {[if (tr.guard & string) != _|_ {[tr.guard]}, tr.guard][0]}, []][0]
			actions: [
				if transition {[if tr.actions != _|_ {[if (tr.actions & [...]) != _|_ {tr.actions}, [tr.actions]][0]}, []][0]},
				[if (tr & [...]) != _|_ {tr}, [tr]][0],
			][0]
		}
	}}
	_timers: [if M.states != _|_ for sn, st in M.states if st.after != _|_
	for ms, tr in st.after
	for idx, t in [if (tr & string) != _|_ {[{target: tr}]}, if (tr & [...]) != _|_ {tr}, [tr]][0] {
		state:    sn
		"delay":  ms
		"branch": idx
		target:   t.target
		if t.guard != _|_ {guard: t.guard}
	}]
	_timed: len(_timers) > 0

	// XState's delays: a named delay is milliseconds, or the row's duration
	// field read as the state is entered. A delay is never a date.
	delays?: [=~"^[a-z][a-zA-Z0-9_]*$"]: (int & >=0 & <=999999999999) | string

	timing?:  "BEFORE" | "AFTER"
	field?:   string
	initial?: string
	states?: [string]~(StateName,_): #MechaState
	on?: {
		insert?: #LifecycleTransitionValue
		update?: #LifecycleTransitionValue
		delete?: #LifecycleTransitionValue
	}
}

// The release targets a bridge may run on: gcp runs no daprd for the airlock.
#BridgeTargets: ["docker", "cloudflare", "k8s"]

// Level 4: what a machine's invoking state asks of the world outside the
// cluster, performed by mecha's airlock against one sink and recorded in the
// ledger (docs/decisions/2026-10-03-external-effects.md).
// The sink an effect reaches on a release target; null where it names none.
#SinkAt: {
	let S = self
	sink:   _
	target: string
	out: [
		if S.sink.targets != _|_ if S.sink.targets[S.target] != _|_ {S.sink.targets[S.target]},
		if S.sink.origin != _|_ {{origin: S.sink.origin}},
		if S.sink.bridge != _|_ {{bridge: S.sink.bridge}},
		if S.sink.ai != _|_ {{ai: S.sink.ai, tier: S.sink.tier}},
		null,
	][0]
}

#ExternalEffect: {
	// Also the sink's Dapr binding name, so a DNS label.
	name: =~"^[a-z][a-z0-9-]*$"
	ir:   *name | string
	// XState's input: what the handler is handed, frozen into the ledger at
	// the claim. "NEW.<col>" reads the row, {raw: sql} is an expression,
	// anything else a literal. A read's is what its path expands.
	input: {[string]: _} | *{}
	// An https origin naming a host by a DNS name of two labels or more, as
	// mecha spells it (#Origin); a name that resolves inward is not refused,
	// since the airlock's daprd dials what its endpoint names, and that is the
	// record's residual. No userinfo: the sink's credential, where it takes
	// one, is a header the airlock adds to every call from a declared secret,
	// which the handler never holds. Or a declared bridge, for a sink that
	// does not speak HTTP, or mecha's AI gateway (`ai: "text" | "image"`).
	// `contentType` names what an origin takes that is not JSON; its handler
	// sends the body already encoded, as a string. "multipart/form-data" is the
	// one of its family, its boundary the airlock's: the handler sends a list
	// of FormData parts, {name, value} or {name, filename, type?, bytes | blob}
	// (bytes as base64, blob a content key), and the airlock encodes them.
	//
	// `targets` overrides the sink per release target, as ai.targets does the
	// models: the entry wins, the rest take the default, and a target left with
	// neither is refused. docker is the compose stack every app launches and
	// integrates on, simulators included. Sandbox or live is the app's own
	// value, or, on cloudflare, each deployment's: `origin: {secret: NAME}`
	// is read from the dispatcher's secret at each run, as the credential is,
	// so one release reaches a vendor's sandbox from staging and its live API
	// from production.
	sink: {
		origin?: mechaCluster.#Origin | #NamedOrigin
		bridge?: string
		ai?:     mechaCluster.#AiModality
		if ai != _|_ {tier: *"cheap" | mechaCluster.#AiBackendTier}
		targets?: [("docker" | "cloudflare" | "gcp" | "k8s" | "aws")]: {origin?: mechaCluster.#Origin | #NamedOrigin, bridge?: string}
		credential?:  #Credential
		contentType?: "multipart/form-data" | =~"^[a-z]+/[a-z0-9][a-z0-9.+-]*$" & !="application/json" & !~"^multipart/"
	}

	// A read: the effect is this HTTP request, a GET, whose answer is the
	// outcome, so it has no handler (docs/decisions/2026-10-03-external-effects.md#reads).
	// `path` is an RFC 6570 template over `input`: `{var}` a path segment,
	// `{?a,b}` and `{&a,b}` the query. A GET is safe (RFC 9110 §9.2.1): nothing
	// claims it, so it states no key, idempotency, reentry, note or attempts.
	// Like every effect it is a machine's: a screen asks it by writing the row
	// whose state invokes it, as the row's own, and sees the answer land there.
	request?: {
		method: "GET"
		path:   =~"^/([A-Za-z0-9._~!$&'()*+,;=:@/?-]|\\{[?&]?[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*\\})*$"
		// Refused below with the reason: a GET's body has no meaning (RFC 9110 §9.3.1).
		body?: _
	}
	if request == _|_ {
		// The ledger key is "<name>:" and these fields of the invoking machine's
		// entity: one as its text, several JSON-encoded. It is also the sink's
		// idempotency key, so it names the instance and never the input's content.
		key: *["id"] | [string, ...string]
		// What a handler does when the ledger shows an earlier entry that may have
		// reached the sink. An idempotent sink is simply called again; a repeat
		// is called again too, and `note` says why a duplicate is acceptable.
		{sink: idempotent: true} | {
			sink: idempotent: false
			reentry: *"reconcile" | "unknown" | "repeat"
		}

		// The judgment the compiler cannot make: the sink's idempotency and what
		// a repeat costs are claims about a peer.
		note: string & !=""
		// Thrown errors tolerated before the outcome is unknown.
		attempts: *5 | int & >=1
	}
	if request != _|_ {
		// Refused below with the reason, rather than as words a read lacks.
		key?: _
		sink: idempotent?: _
		reentry?:  _
		note?:     _
		attempts?: _

		// The int32 field of the invoking entity counting the row's entries
		// into the invoking state, and its uuid field naming the row's
		// incarnation, which a row deleted and made again under its key does
		// not share. The interpreter alone writes both: the incarnation once,
		// at the insert, and the count, adding one as the row enters. A read's
		// journal key is `<name>:<row's key>:<incarnation>:<count>`: replay,
		// re-running the row's transitions, reaches the same key and is
		// answered from the journal.
		count:       string
		incarnation: string
		// Freshness, in Cache-Control's own syntax (RFC 9111 §5.2.2), for an
		// answer whose sink sends neither Cache-Control nor Expires, as many
		// legacy services send none: `"max-age=60"`. The airlock's cache is
		// shared by every row's read, so it keeps an answer to an authorized
		// request only if it says `public`, `s-maxage` or `must-revalidate`
		// (RFC 9111 §3.5), and a private one never.
		cacheControl?: =~"^[a-z-]+(=(\"[^\"]*\"|[0-9]+|[a-z-]+))?(, ?[a-z-]+(=(\"[^\"]*\"|[0-9]+|[a-z-]+))?)*$"
		// got's own options, the part JSON spells (got's RetryOptions and
		// Delays, in milliseconds). Absent, two quick retries on 408, 429,
		// 5xx and network errors, honouring Retry-After up to 5 s, and 5 s a
		// request; the whole read is bound at 20 s.
		got?: {
			retry?: close({
				limit?:         int & >=0 & <=5
				statusCodes?:   [...(int & >=100 & <=599)]
				errorCodes?:    [...=~"^E[A-Z_]+$"]
				backoffLimit?:  int & >=0
				noise?:         int & >=0
				maxRetryAfter?: int & >=0
			})
			timeout?: close({
				lookup?:        int & >0
				connect?:       int & >0
				secureConnect?: int & >0
				socket?:        int & >0
				send?:          int & >0
				response?:      int & >0
				read?:          int & >0
				request?:       int & >0 & <=20000
			})
		}
	}

	// What the handler is handed beside its input at each call, never in the
	// ledger: an environment variable by name, a key to sign with being the
	// common case, or `{field: <name>}`, a secret field of the invoking
	// entity, the value its reader typed, as Kubernetes' `secretKeyRef` names
	// a key of a Secret. A field secret's value is the handler's `secrets[<name>]`.
	// A read has no handler, so it takes none.
	secrets?:      [...(#SecretName | close({field: string}))]
	_envSecrets:   [if secrets != _|_ for s in secrets if (s & string) != _|_ {s}]
	_fieldSecrets: [if secrets != _|_ for s in secrets if (s & string) == _|_ {s.field}]
	// What its handler may use past the language, as an omnishell module
	// declares Intl: Crypto to sign with, TextEncoder to give it bytes.
	endowments?: [...mechaCluster.#CageEndowment]
}

// A provider's word that a row may have changed: `POST /signal/<name>[/<id>]`.
// Nothing in the body is believed and no signature is checked, since all a signal
// can do is send the machine's `event` to the row `id` names, whose target state
// asks the provider through an effect. So a forged one costs one read. A row that
// is mid-check answers 503, the provider's redelivery being what keeps the signal.
// `count` is an integer field the move adds one to and the target's effect names
// in its `key`, since a ledger key is performed once and a row is checked often.
#Signal: {
	machine: string
	event:   string
	id:      {path: true} | {body: [string, ...string]}
	count:   string
}

// A path of the app's own, answered at another the door already answers:
// Next.js's `rewrites`, a subset. `source` is path-to-regexp's literal and
// `:name` segments, a parameter being letters, digits and `. _ ~ -`;
// `destination` is a PostgREST path under `/crud`, naming the parameters it
// uses; a table or view takes the request's own query after it, a function
// (`rpc/`) the destination's alone. `methods`, as Vercel's routes spell it,
// narrows what is otherwise every method, the client's. The request is handed
// on as it came, its `Authorization` included, with the method and the target
// it asked, as sent, in `X-Forwarded-Method` and `X-Forwarded-Uri`, which the
// door sets itself; a `PUT`, `PATCH` or `DELETE` reaches a function as the
// `POST` PostgREST calls one by. `has` is Next.js's, its `query` items alone
// (#RewriteHas). What the subset leaves out (`missing`, the other `has`
// types, wildcards, patterns) is refused, never ignored.
#Rewrite: {
	source:      =~"^(/([A-Za-z0-9][A-Za-z0-9_-]*|:[a-z][A-Za-z0-9_]*))+$" & !~"^/(crud|signal|electric|auth|poke|blob-claim|blobs|img|health|omnishell|shell|seed-assets)(/|$)"
	destination: =~"^/crud/(rpc/)?[a-z][a-z0-9_]*(\\?[^\\s{}\"`\\\\#]*)?$"
	methods?:    [#RewriteMethod, ...#RewriteMethod] & list.UniqueItems()
	has?:        [#RewriteHas, ...#RewriteHas]
}
#RewriteMethod: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"

// One condition of a rewrite, every one of which the request meets: the query
// holds `key` once, with a value, and `value`, a regular expression, matches
// that value in full. An item gives the destination parameters as Next.js
// names them: with no `value`, the key's letters, whatever else it holds
// dropped (`job_id` is `:jobid`); with one, each group it names
// (`(?<name>…)`), and the key none. A name given twice, which Next.js
// would have the later replace, is refused, as is a key two items name.
// The expression is the door's, Go's: what it does not take (a lookaround,
// a backreference) is refused, as is what the door's file would read as
// its own (a quote, a backquote, a brace before a letter) or lose where its
// snippet is imported (the backslash before a brace: a brace itself is
// `[{]` or `\x7B`).
#RewriteHas: {
	type:   "query"
	key:    =~"^[A-Za-z0-9_.-]+$"
	value?: string & !="" & !~"[\"`\n\r]|\\{[A-Za-z$]|\\\\[{}]"
	if value != _|_ {
		_compiles: regexp.Match("^(?:\(value))$", "")
	}
}

// A role a token may name beside the cluster's own `anon`, `app_user` and
// `service`: PostgreSQL's NOLOGIN role, which PostgREST's login may switch to
// and which holds nothing else. What it may do is the app's own SQL (GRANT
// EXECUTE on a function, a policy naming it); it never bypasses row-level
// security. A token naming it comes from an issuer the release trusts
// (docs/identity.md#token-roles-and-trusted-issuers). `note` says who acts as
// it, and why.
#TokenRole: close({
	note: string & !=""
})

// A Postgres role name none of the cluster's own roles, nor one Postgres or a
// managed database reserves. Emitted SQL quotes it.
#TokenRoleName: =~"^[a-z][a-z0-9_]{0,62}$" & !~"^(anon|app_user|service|electric|authenticator|postgres|public|none|app|streaming_replica)$" & !~"^(pg_|cloudsql|rds|azure_)"

// What a sink reads a caller's credential from: `Authorization: Bearer <key>`
// is `{scheme: "Bearer", secret: "KEY"}`; an `X-Api-Key` header is
// `{header: "X-Api-Key", secret: "KEY"}`; `Basic` takes the secret already
// base64-encoded as `user:password`. The header's first letter is uppercase,
// which is what daprd forwards as a header, and it is none of the host's or
// HTTP's own. A header other than Authorization follows a redirect to any
// host, which the record states as the residual.
#Credential: {
	header:  *"Authorization" | =~"^[A-Z][A-Za-z0-9-]*$" & !~"(?i)^(Idempotency-Key|Content-Type|Content-Length|Accept|Host|Transfer-Encoding|Traceparent|Tracestate|Baggage)$"
	scheme?: =~"^[A-Za-z][A-Za-z0-9-]*$"
	secret:  #SecretName
}

// Only the edge's airlock reads its environment per call; a daprd endpoint's
// baseUrl is fixed when the stack starts.
#NamedOrigin: close({secret: #SecretName})

// An environment variable an effect declares, never one the cluster's own
// services read, whose compose environments a value of it would reach and a
// release would write as theirs, the airlock's own among them (mecha's
// #ReservedSecretName: its seal keys, AIRLOCK_*, and crud's key set and
// audience, PGRST_JWKS and TRUSTED_*), nor a bridge's: BRIDGE_<NAME> binds a
// container on the dispatcher Worker and BRIDGE_<NAME>_URL addresses one on
// the mesh.
#SecretName: =~"^[A-Z][A-Z0-9_]*$" & !~"^(SERVICE_JWT|PGRST_JWT_SECRET|PGRST_JWKS|TRUSTED_JWKS|TRUSTED_AUDIENCE|POSTGRES_PASSWORD|POSTGRES_USER|POSTGRES_DB|ELECTRIC_SECRET|ELECTRIC_PASSWORD|AUTHENTICATOR_PASSWORD|WAKE_URLS|RCLONE_[A-Z0-9_]*|REDIS_URL|CRUD_URL|MESH_EVENTS_URL|POKE_INTERVAL|DUCKSTREAM_ENGINE|COMPUTE_STATE_DIR|CADDY_TLS_HOST_PORT|WEBAUTHN_ORIGIN|WEBAUTHN_RP_ID|ANDROID_APK_KEY_HASHES|NATIVE_SCHEMES|AI_TARGET|AI_LOCAL_[A-Z0-9_]*|OIDC_[A-Z0-9_]*)$" & !~mechaCluster.#ReservedSecretName & !~"^BRIDGE_"

#ActivepiecesAlias:      string & =~"^[a-zA-Z][a-zA-Z0-9_]*$"
#ActivepiecesPath:       string & =~"^\\./pieces/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$"
#ActivepiecesSchemaPath: string & =~"^\\./pieces/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\\.(input|output|auth)\\.schema\\.json$"
#ActivepiecesJSON:       null | bool | number | string | [...#ActivepiecesJSON] | {[string]: #ActivepiecesJSON}
#MailAddress:            string & =~"^[^\\s@<>\",;]+@[^\\s@<>\",;]+\\.[^\\s@<>\",;]+$"
#MailTargets: {
	pages?: {
		publicKey:  string & !=""
		serviceId:  string & !=""
		templateId: string & !=""
	}
	cloudflare?: {recipients: [#MailAddress, ...#MailAddress]}
}
#Activepieces: {
	let AP = self
	lock: string & =~"^\\./pieces/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\\.lock$"
	limits: {
		timeoutMs:       *8000 | int & >0 & <=8000
		maxConcurrent:   *4 | int & >=1
		maxRequestBytes: *1048576 | int & >0
		maxResultBytes:  *1048576 | int & >0
	}
	pieces: [#ActivepiecesAlias]: {
		{local: #ActivepiecesPath, export: #ActivepiecesAlias} | {
			npm: {package: string & =~"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$", version: string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$", export: #ActivepiecesAlias}
		}
	}
	actions: [#ActivepiecesAlias]: {
		piece:               #ActivepiecesAlias
		action:              string & =~"^[a-zA-Z][a-zA-Z0-9_-]*$"
		inputSchema:         #ActivepiecesSchemaPath
		outputSchema:        #ActivepiecesSchemaPath
		auth?:               {jsonSecret: #SecretName, schema: #ActivepiecesSchemaPath}
		fixedProps:          *{} | {[string]: #ActivepiecesJSON}
		idempotencyKeyProp?: #ActivepiecesAlias
		mail?:               #MailTargets
		if mail != _|_ {
			idempotencyKeyProp: "requestKey"
			fixedProps: messageIdDomain: string & =~"^[a-zA-Z0-9][a-zA-Z0-9.-]*$"
		}
	}
	_violations: list.Concat([
		[for n, a in AP.actions if AP.pieces[a.piece] == _|_ {"action \(n) needs a declared piece"}],
		[for n, a in AP.actions if a.idempotencyKeyProp != _|_ if a.fixedProps[a.idempotencyKeyProp] != _|_ {"action \(n) fixes its idempotency key property"}],
		[for n, a in AP.actions if a.mail != _|_ if a.fixedProps.message != _|_ {"mail action \(n) fixes its message property"}],
	])
	_refusal: [if len(_violations) == 0 {true}, _violations[0]][0] & true
}

// The SQL prototype and the admitted native computation stage are separate backends.
#DuckStreamPipeline: #DuckStreamSQL | #DuckStreamCompute

#DuckStreamSQL: {
	name:       string
	ir:         *name | string
	sql:        string
	sources:    [...string]
	sink:       string
	tempo:      *"hot" | "cold"
	operators?: [...("tumble" | "hop" | "session" | "distinct" | "interval_join" | "cross_join")]
}

#DuckStreamCompute: {
	name:        string
	ir:          *name | string
	backend:     "compute"
	src:         string & !=""
	risingwave?: string & !=""
	steps?:      string & !=""
	sources: [string]: {
		entities: [...string] & [_, ...]
		read:     "snapshot"
	}
	sinks: [string]: {
		entity:      string
		columns?:    [...string] & [_, ...] & list.UniqueItems()
		write:       "replace" | "upsert"
		version:     "latest"
		transaction: string & !=""
	}
	wasm:        *[] | [...string]
	endowments:  *[] | [...mechaCluster.#CageEndowment]
	onComplete?: string & =~"^[a-z_][a-z0-9_]{0,62}$"
	queryTypes?: [string]: [...mechaCluster.#ComputationField & {type: #Type | #LegacyType}]

}

#FormField: {
	name: string
	// "file" (blobs on): the shell PUTs the picked file to
	// /blobs/mecha-objects/<uuid><ext> and submits the field's name with the
	// resulting key string.
	// "date" submits day precision: empty → JSON null, else the picked day
	// pinned to 00:00:00Z — the one-clock day convention.
	control:         "text" | "checkbox" | "textarea" | "select" | "hidden" | "datetime" | "date" | "file"
	required:        *false | bool
	maxLength?:      int
	placeholder?:    string
	invalidMessage?: string
	options?:        [...string] // select controls
	// hidden controls; resolved at submit: `{param.x}`, `{now}`, and the
	// literal `null` meaning SQL NULL.
	value?: string
}

#Form: {
	id:     string
	entity: string
	// The form's data-action (omnishell REFERENCE.md, "Mutations").
	action: omnishell.#MutationOp & ("create" | "update" | "delete" | "upsert")
	// Delete forms only: a PostgREST filter fragment ({param.x} interpolates)
	// scoping a bulk delete of every matching row, instead of the row context.
	filter?: string
	// ir flow id this form realizes; unset when the form realizes no single
	// flow (row-scoped deletes, or one form serving several flows).
	flow?:  string
	fields: [...#FormField]
}

// One read a screen's markup makes, as the terminal reads and routes it
// (omnishell lint.ts screenAccess, fragment.js routeOf). Derived, never
// authored.
#Read: {
	table: string
	// data-live, data-reads (a reduce's whole table) or data-read-<name>.
	kind: "live" | "reads" | "named"
	// Inside an enclosing region, its placeholders resolved against that
	// region's row. A route's top-level reads decide what a document rendered
	// for no one in particular may show (#Screen.ssr); a nested one reads
	// under whoever the enclosing row is rendered for.
	nested: bool
	// The lists stamping it, as indices into the screen's reads: each region
	// whose item template it is inside, each naming that template, and the
	// lists stamping those in turn. It is read once per row of each; with
	// none, once, as a slot binds one row.
	lists: [...int]
	// How the store serves it as far as the markup decides: computed by the
	// server, filtered by the client ("snapshot"), the collection itself
	// ("whole"), or maintained by the view engine ("view").
	route: "server" | "snapshot" | "whole" | "view"
	// Server-computed filters omit clauses. Embed dependencies include nested
	// relations, named by table or foreign-key column even for server selects.
	clauses?: [...{col: string, op: string}]
	embeds?:  [...string]
	limit?:   int & >0
	// Every column an order it can be in names.
	orders: [...string]
}

// One write a screen's markup states: a form, a chart's effect, or a reduce
// (data-on-<event>, a drag's data-handler), op "reduce" on its region's table,
// whose updates and effects may write any table by any op. Derived, never
// authored.
#Write: {
	table:   string
	op:      omnishell.#MutationOp
	filter?: string
}

// One terminal chart a screen's markup carries, as the terminal projects it
// (read-markup.ts `machines`): the row it runs over, the field it moves, and
// its effects, each also among the screen's writes. Derived, never authored;
// the chart's own bytes stay the terminal's (the `chart` fact row).
#Chart: {
	table:  string
	field:  string
	writes: [...#Write]
}

#Screen: {
	let S = self
	hatches: *[] | [...string]
	name:    string
	ir:      *name | string
	title:   string
	route:   string // may contain `:param` segments; params reach filters, hidden values, and `{param.x}` interpolation
	// A `?` makes a segment optional, and only the last segment may be: the
	// terminal matches it there alone, and the door expands it there alone.
	route: =~"^[^?]*(:[a-zA-Z_][a-zA-Z0-9_]*\\?)?$"
	// The message key this route's FIRST segment is drawn from — regras /
	// reglas / rules. Declaring it makes the route addressable in every
	// locale; additional literals opt in through segments below. The key
	// lands in the catalogue a translator already works in,
	// so a locale missing a slug is the finding a locale missing a button
	// label already is.
	slug?: string
	// Additional literal path segments, keyed by their default spelling and
	// resolved through the same catalogues as the first segment's slug.
	segments?: [string & =~"^[a-z0-9]+(-[a-z0-9]+)*$"]~(Segment,_): string
	// The message key the terminal draws this route's STRIP label from, the
	// counterpart of `slug` for the word rather than the address. `title`
	// stays the default-language spelling and is what an app declaring no
	// catalogues shows; declaring this makes the strip speak every locale the
	// app does. It needs meta.i18n: a key with no catalogue to answer it is a
	// reference error out of the emitter, the way a slug's is.
	label?: string
	// Written as a document per locale at build, so a crawler receives HTML
	// rather than a shell that assembles itself. Only a route with no `:param`
	// can be: the rows a /article/:slug would need do not exist when the build
	// runs. Its document is drawn before any read lands, so one reading rows
	// the server holds is refused (#DefaultTerminal), and so is a region that
	// names no row to show until then (omnishell's render-documents.ts).
	prerender: *false | bool
	if S.prerender {route: =~"^[^:]*$"}
	priority?:   number & >=0.0 & <=1.0
	changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never"

	// Who the route's entry document may be shown to without a session,
	// in the browser-applicable subset of #Access.scope: #App defaults it to
	// "private" when capabilities.auth.required is true or when every top-level
	// live region on the screen is restricted, and "public" otherwise.
	access: "public" | "private"
	// Rendering strategy:
	//   ssg: a document per locale written at generate (prerender: true)
	//   ssr: a document rendered with its public rows on request, by the
	//        terminal's renderer, held until a read that drew it changes
	//   spa: client-side single page app shell
	ssr: "spa" | "ssg" | "ssr"
	if S.prerender {ssr: "ssg"}

	// A slugged route's authored pattern is what the default locale's
	// catalogue must agree with, so it needs a first segment to translate.
	if S.slug != _|_ {route: =~"^/[a-z0-9][a-z0-9-]*(/|$)"}

	// Derived from the markup (program_derived.cue). An assembly screen's html
	// exists before any derivation, so a screen the derived file misses is a
	// stale generation and the export fails incomplete rather than shipping a
	// screen whose reads, writes and handlers are silently empty. A CUE-authored
	// screen alone carries the bootstrap default: its html does not exist
	// before the first export, so the first derivation cannot see it —
	// write.ts's fixpoint re-derives after writing and re-exports until the
	// derived file holds what the emitted markup says.
	reads!:  [...#Read]
	writes!: [...#Write]
	charts!: [...#Chart]
	if S.markup != _|_ {
		reads:  *[] | [...#Read]
		writes: *[] | [...#Write]
		charts: *[] | [...#Chart]
	}

	// A component-bearing screen is authored HERE, in CUE: `markup` is the
	// screen's whole HTML, composed by interpolating component definitions
	// (their tags survive in it as inert wrappers), and files.html becomes an
	// emitted file rather than an assembly source. Absent, the screen is
	// assembly authored at files.html as ever.
	markup?: string
	forms:   [...#Form]
	states:  [...string] // ir frame ids are "\(name)-\(state)"
	// How many instances of this screen the terminal's navigation stack holds
	// once the user leaves it: the DOM stays, the subscriptions stop, and
	// coming back repaints before it refreshes. A parametrized route would
	// otherwise accumulate one held screen per id ever visited. 0 rebuilds on
	// every visit — the right answer for a screen whose entry animation or
	// first-run state is the point.
	keep: *1 | int & >=0
	// Whether the terminal lists this screen in the strip it draws. A screen
	// reached from somewhere more specific than "everywhere" — a person's own
	// page, a row — declares false, so the strip keeps to the places a reader
	// starts from. A route with a required param is never listed: it has no
	// static href. A trailing `:name?` is optional, and a route may list the
	// addresses it takes with it as further strip entries, each a link of its
	// own that is current at its own address: the shelves of a library.
	// Optional named stroke icon (`#NavIcon`) rendered inside the route's link
	// on `body > nav`, and `iconOnly: true` for compact utility routes (such as
	// rules or stats) whose visible chrome is the icon while screen readers,
	// `aria-label`, and `title` retain the localized label.
	icon?:     #NavIcon
	iconOnly?: bool
	if S.iconOnly != _|_ if S.iconOnly {
		icon: #NavIcon
	}
	strip: *true | bool
	entries: *[] | [...{
		let E = self
		label:     string
		key?:      string
		icon?:     #NavIcon
		iconOnly?: bool
		if E.iconOnly != _|_ if E.iconOnly {
			icon: #NavIcon
		}
		params: [string]: string
	}]
	paths: [string]~(Name,_): {states: [...string], accepts: [...string]}
	// Assembly files (app-relative): the screen's semantics live in these
	// directly generated artifacts, not in CUE. reads/forms above are the
	// structured source they are generated from — the compiler owns their
	// consistency with the markup.
	//
	// Open, and load-bearingly so: this block is copied verbatim into the
	// route's entry in shell.yaml, where the TERMINAL is the authority on
	// which file kinds a route may carry. Closing it here would mean every
	// vocabulary the terminal grows — renderers today, whatever follows —
	// has to be mirrored into this compiler before an app can name it.
	files: {
		...
		html: *"shell/screens/\(name).html" | string
		css:  *"shell/screens/\(name).css" | string
		// Jessie handlers, SES-compartment-loaded. Derived from the markup;
		// required or bootstrap-defaulted exactly as #Screen.reads is.
		handlers!: [...string]
		if S.markup != _|_ {
			handlers: *[] | [...string]
		}

		// The control adapters the screen's markup names (data-value-adapter).
		// Apart from handlers because the role decides the cage: an adapter ends
		// in a map of pure functions, and its compartment is endowed with Intl.
		adapters: *[] | [...string]
		// Stylesheets under shell/shared/ this screen imports. Screen CSS is
		// injected as a <style> in the document head, so an @import inside it
		// resolves against /shell/ — `@import url("shared/screen.css")`.
		//
		// Naming it here is what builds it: the served set is the union of what
		// screens actually reference, so a shared file nobody imports is never
		// copied into the image and cannot sit there looking load-bearing.
		shared: [...string & =~"^shell/shared/.*\\.css$"]
	}
}

#Flow: {
	name:   string
	ir:     *name | string
	of:     string // screen
	entity: string
	// The form's data-action (omnishell REFERENCE.md, "Mutations"). "navigate"
	// flows end in a read, not a store call (a navigate form's hash change);
	// entity names the entity the landing read targets.
	action: omnishell.#MutationOp & ("create" | "update" | "delete" | "upsert" | "navigate")
}

#Test: {
	id: string
	ir: *id | string
	of: string
	// Derived from the `data-accepts` of the ir element `ir` names (pronto
	// derive.ts): the design is the one statement of what a test settles.
	accepts: [...string]
	says:    string
	given:   _
	when:    string
	then:    string // CEL over injected input/output/error
}

// A locale is ONE BCP 47 tag and nothing beside it: `pt` and `pt-BR` are
// different locales, not spellings of one, and the tag is the key so there is
// nowhere to write a second, disagreeing name for either.
#I18n: {
	let I = self

	// The locale served unprefixed, and the one x-default names. A default
	// naming a locale the app does not carry is a root resolving to nothing,
	// so it is constrained to a key of `locales`.
	default: string & or([for tag, _ in I.locales {tag}])
	locales: [=~"^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$"]: {
		// The URL segment, lowercased: pt-BR -> pt-br. Carried by the default
		// too, whose segment addresses no document and exists to be 301'd away
		// from.
		path: string & =~"^[a-z0-9]+(-[a-z0-9]+)*$"
	}
	// The app's own message files, written in the app package as
	//   catalogues: _ @embed(glob="messages/*.json")
	// because @embed resolves against the directory it is written in. #emit
	// projects them away: shell.yaml carries resolved paths, not catalogues.
	// A value is a sentence, or the flat map of arms an element's
	// data-msg-plural / data-msg-select picks one of (plugins/omnishell
	// terminal.cue, capabilities."message-arms"). A slug resolved out of a
	// catalogue still unifies against a segment below, so a key spelled as a
	// map where a URL is wanted stays a cue error.
	catalogues: [=~"^messages/[^/]+\\.json$"]: [string]: string | {[string]: string}
	// The catalogue of each declared locale, keyed by tag — what a route's
	// `slug` is resolved against.
	_msg: {for tag, _ in I.locales {(tag): I.catalogues["messages/\(tag).json"]}}
}

#FaviconItem: {
	href:   string & !~"\\.\\." & !~"^<svg"
	rel:    *"icon" | string
	type?:  string
	sizes?: string
}

#Favicon: string | #FaviconItem | [...(string | #FaviconItem)]

#PreconnectItem: {
	href:         string & !~"\\.\\." & (=~"^https?://" | =~"^//")
	crossorigin?: bool
}

#Preconnect: string | #PreconnectItem

#ManifestIcon: {
	src:      string
	sizes?:   string
	type?:    string
	purpose?: *"any" | "maskable" | "monochrome" | "any maskable"
}

#Manifest: {
	name?:             string
	short_name?:       string
	description?:      string
	start_url?:        string
	display?:          *"standalone" | "fullscreen" | "minimal-ui" | "browser"
	background_color?: string
	theme_color?:      string
	icons?:            [...#ManifestIcon]
	scope?:            string
	orientation?:      string
	dir?:              "auto" | "ltr" | "rtl"
	lang?:             string
	[string]:          _
}

// The card names no address of its own: the origin is the deployment's
// (mecha's ORIGIN), so a local image is spelled from the root and made
// absolute against it where a document is rendered (component-contracts.md).
#Social: {
	title?:       string
	description?: string
	image?:       string
	imageAlt?:    string
	card?:        *"summary_large_image" | "summary" | "app" | "player"
	type?:        *"website" | string
	site?:        string
	creator?:     string
}

// A Google Ads tag: page views, remarketing and the conversion linker's
// first-party _gcl_* cookies for the readers of `hosts`, run in a frame of the
// app's origin. Any other host loads nothing, so a launch or a test reaches no
// Google server. Every storage starts denied and follows what the terminal
// states from meta.consent, which the tag requires.
#GoogleTag: {
	id:    =~"^AW-[0-9]+$"
	hosts: [...=~"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$"]
}

// The reader's consent to advertising: the app's tags storing and sending
// for ads (Consent Mode's ad_storage, ad_user_data and ad_personalization).
// The terminal asks every reader alike, wherever they are, in a bar on the
// first view; `none` asks nobody and states `none.advertising` for everyone.
// Measurement, the app's own analytics into its own lake, is never asked.
#Consent: {
	mode: *"bar" | "none"
	none?: advertising!: "denied" | "granted"
	// The privacy policy the bar links; a new version asks every reader again.
	policy: {
		url:     =~"^https://[^\\s]+$"
		version: =~"^[0-9A-Za-z][0-9A-Za-z.-]*$"
	}
}

#Llms: {
	text?:     string
	file?:     string
	fullText?: string
	fullFile?: string
}

#WellKnownItem: string | {
	text?: string
	file?: string
}

#Sitemap: bool | #SitemapConfig

#SitemapConfig: {
	enabled?: bool
	exclude?: [...string]
	extra?:   [...string]
}

#App: {
	let A = self
	state: {
		entities: [string]~(Name,_): #Entity & {name: Name}
		// DDL table-order override: must list every entity, parents before
		// children (a `ref` REFERENCES needs its target table emitted first).
		// Unset = entity declaration order, which must itself be parents-first.
		entityOrder?: [...string]
		// Hand-authored SQL beyond the schema vocabulary, as assembly files; the
		// writer copies each src into services/database/migrations/<name>, and
		// the name's numeric prefix orders it among the emitted migrations.
		// Three digits no other startup file holds, then `_`: mecha's cluster
		// refuses any other name. The app owns 000-799 and its seed at 900;
		// 800-899 are the framework's steps (mecha's cluster.cue), but for
		// 802_signals.sql, which a live database applied as the app's signals
		// and their machines' states stood.
		// A named baseline keeps its applied bytes; later changes go in state.migrations.
		rawMigrations?: [...{name: (string & !~"^8") | "802_signals.sql", src: string}]
		// What a live database's baseline scripts (005-010) were applied with.
		// Set once a database outlives a release: those scripts then hold
		// `entities` alone, since an applied script may never change, and each
		// later server entity arrives in a pgroll migration of its own,
		// <after>_<table>. `after` sorts past every migration a live database
		// ran, which a container's migrate step demands. Unset, the baseline
		// holds every entity.
		baseline?: {
			entities: [...or([for n, e in A.state.entities if e.server {n}])]
			after:    =~"^[0-9]+$"
			// For each released later-entity migration the app keeps in
			// state.migrations, the digest of what the emitter generates for
			// its entity now: the change since is carried by a later migration.
			carried?: [=~"^[0-9]+_[a-z0-9_]+$"]: =~"^[0-9a-f]{64}$"
		}
		// Each a route a provider posts to (#Signal).
		signals?: [=~"^[a-z][a-z0-9-]*$"]: #Signal
		// Each a path answered at another under /crud (#Rewrite), on a container target.
		rewrites?: [=~"^[a-z][a-z0-9-]*$"]: #Rewrite
		// Each a role a token may name beside the cluster's own (#TokenRole).
		tokenRoles?: [#TokenRoleName]: #TokenRole
		// Who provisions the database's roles, their attributes, memberships and
		// settings, and the schema's grants (docs/access.md#generated-or-checked):
		// pronto's migrations ("generated", the default), or the instance's owner,
		// which every release then checks before its migrations ("checked"),
		// refusing any difference with the statements that fix it.
		provisioning?:      "generated" | "checked"
		_rawMigrationNames: [if rawMigrations != _|_ for migration in rawMigrations {migration.name}] & list.UniqueItems()
		// Where the framework's own steps run, for an app whose steps already
		// hold their default digits (#steps). The program writes each step's
		// three digits; its name keeps the step's suffix, so a release finds it
		// by name. `note` states why the app's steps sorting below a placed
		// machines or airlock step write no row it governs: a row written
		// before its machine's trigger exists is never judged or claimed.
		steps?: {
			machines?: #StepDigits
			actors?:   #StepDigits
			graphile?: #StepDigits
			airlock?:  #StepDigits
			jobKey?:   #StepDigits
			note!:     string & !=""
		}
		cortex?: [string]: #CortexMachine
		// A Mecha machine as XState writes it, its Jessie rules, and the
		// internal form the compilers read, derived.
		mecha: reducers: [string]~(Name,_): {
			let H = self
			machine: mechaCluster.#Machine & {config: id: Name}
			rules:   string
			reducer: (#Reducer & {machine: H.machine}).out
		}
		// Pure Jessie the database calls inside a transaction, compiled to
		// `public.fn_<name>(jsonb) RETURNS jsonb`
		// ([[docs/decisions/2026-11-05-database-jessie#Functions]]).
		functions?: [string & =~"^[a-z][a-z0-9_]{0,30}$"]~(Name,_): {
			rules: string & =~"^[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)*\\.js$"
			fuel:  int & >0 & <=1000000
			note:  string & !=""
		}
		// Changes to a schema that already exists, as pgroll migrations, keyed
		// by the version they create; the cluster is given them
		// (#DefaultCluster) and applies them in key order.
		//
		// Separate from the migrations above because they answer a different
		// question. Those build the schema on a fresh volume, where initdb
		// applies every one of them once. These are applied
		// against a database that already holds a schema, through pgroll, which
		// keeps a ledger of what it has run: a migration here runs once, and
		// running it again is a no-op rather than an error. So they are written
		// plainly, with no IF NOT EXISTS and no DO block to swallow a duplicate
		// — the spellings that cost the checks their sight.
		//
		// Typed by the grammar mecha's cluster is given them in, which is
		// pgroll's own, so an operation this does not accept is one pgroll
		// would not accept.
		migrations?: [grammar.#Name]:    grammar.#Migration
		pipelines: [string]~(Name,_):    #Pipeline & {name: Name}
		drains: [string]~(Name,_):       #Drain & {name: Name}
		computations: [string]~(Name,_): #Computation & {name: Name}
		schedules: [string]~(Name,_):    #Schedule & {name: Name}
		mecha: rows: [string]~(Name,_): #MechaMachine & {name: Name}
		if A.state.cortex != _|_ {
			mecha: rows: {for chartName, sourceChart in A.state.cortex if sourceChart.config.meta != _|_ if sourceChart.config.meta.host != _|_ if sourceChart.config.meta.host == "mecha" {
				(chartName): {
					name: chartName
					cortex: {
						id:           sourceChart.config.id
						sourceEvents: [for _, actor in sourceChart.setup.actors if actor.via == "query" {actor.event}]
					}
					entity:  sourceChart.config.meta.entity
					field:   sourceChart.config.meta.field
					initial: sourceChart.config.initial
					guards:  {}
					states: {for stateName, state in sourceChart.config.states {
						(stateName): {
							if state.type != _|_ {type: state.type}
							if state.on != _|_ {
								on: {for event, transition in state.on {
									(event): [for branch in [if (transition & string) != _|_ {[transition]}, if (transition & [...]) != _|_ {transition}, [transition]][0] {
										(#CortexMechaTransition & {transition: branch, guards: sourceChart.setup.guards, actions: sourceChart.setup.actions, event: true}).out
									}]
								}}
							}
							if state.invoke != _|_ {
								invoke: {
									src:     state.invoke.src
									onDone:  (#CortexMechaOutcome & {transition: state.invoke.onDone, guards: sourceChart.setup.guards, actions: sourceChart.setup.actions}).out
									onError: (#CortexMechaOutcome & {transition: state.invoke.onError, guards: sourceChart.setup.guards, actions: sourceChart.setup.actions}).out
								}
							}
						}
					}}
				}
			}}
		}

		// Each also a Dapr output binding of the airlock's, and a handler the
		// program ships at effects/<name>.js (libraries/mecha/services/airlock).
		effects?: [string]~(Name,_): #ExternalEffect & {name: Name}
		// An Airlock-facing endpoint of a declared container hatch, or of an
		// isolate hatch by `isolate`, whose container, port and appliance form
		// pronto derives ([[docs/isolate-hatches]]).
		// A bridge runs as its simulator in the local stack and as its container
		// on the release targets it names; elsewhere its effects fail at run time
		// ([[docs/container-bridges#Targets]]). `docker` lowers a bridge as a
		// process of its appliance, so it needs the bridge's `appliance` form;
		// `cloudflare` ships the container's own image as a Cloudflare
		// Container of the dispatcher Worker, and `k8s` as a Deployment behind
		// the airlock's daprd, so on both its container needs a Dockerfile.
		// gcp runs no daprd for the airlock: naming it is refused here rather
		// than failing every call there.
		bridges?: [string]~(Name,_):     mechaCluster.#Bridge & {name: Name, targets: *[] | [...or(#BridgeTargets)]}
		duckstreams?: [string]~(Name,_): #DuckStreamPipeline & {name: Name}
		// Seed rows held as data rather than stated: a JSON file beside the
		// program, outside its package, keyed by entity name —
		// {"<Entity>": [row, ...]}. A row in the package is re-judged by every
		// evaluation of the program, so an archive of thousands taxes every
		// export, vet and check; held here, its rows are judged against #Seed
		// only when it or the entities change (seed.ts), and render into
		// 900_seed.sql beside the stated ones. An entity's rows have one home:
		// stated or held, never both.
		seed?: {src: string}
	}

	// What state.seed.src must satisfy, for `cue vet -d`: a server entity's
	// rows under every constraint its own `seed` carries. Closed, so a row of
	// an entity that is not a server one, or of none, is refused — a tab
	// entity's rows are the program's own and render into shell.yaml.
	#Seed: {for n, e in A.state.entities if e.server {
		(n)?: e.seed & [...{
			if A.state.mecha.rows != _|_
			for _, m in A.state.mecha.rows if m.entity == n || m.entity == e.table
			if m.field != _|_ if m.initial != _|_ {
				(m.field)?: or([for state, _ in m.states {state}])
			}
		}]
	}}

	capabilities: {
		// Browser fetches outside the app are authored authority. Script sources
		// remain the terminal's; only reader-supplied images may name a scheme.
		resources?: [string]: {
			kind:   "img" | "font" | "media" | "frame" | "connect"
			source: mechaCluster.#Origin | "https:"
			if kind != "img" {source: mechaCluster.#Origin}
			note: string & !=""
		}
		// Passed through to shell.yaml verbatim: the terminal owns the login
		// chrome, keyed on `required`, and calls the auth service at `service`.
		// Presence also switches the cluster's auth plane on (#emit), and puts
		// one Sign in in the nav for anyone not signed in as a person, opening
		// in place onto the ways in (omnishell's GUIDE.md#signing-in).
		// `self` names the signed-in person's own page for the strip the
		// terminal draws: `route` is a route's screen name, whose :params the
		// terminal fills from the session user and whose localized pattern it
		// composes; and `name` the table and column the name they chose
		// lives in, read live so a rename reaches the strip as it reaches a
		// byline. Omitted by an app that has no page for a person — and then
		// the one identity always on screen leads nowhere.
		auth?: {
			required: bool
			service:  string
			mode:     *"passkey" | string
			self?:    {route: string, name?: {table: string, column: string}}
			// The providers a person may sign in through besides a passkey,
			// each one the terminal offers (#emit): a way in at the gate and
			// among the nav's, run by the cluster's auth service. A provider's
			// person and a passkey's are two.
			providers?: [string, ...string] & list.UniqueItems()
			// A named provider's settings, the cluster's defaults for what the
			// deployment's OIDC_<NAME>_<SETTING> overrides: another issuer in
			// the provider's place, where the cluster reaches it, the client
			// registered there (`origin` for a public client named by the
			// app's origin), the scope and further authorization parameters.
			// Without a client here the deployment must give one. Never a
			// secret, and never the terminal's. `credential` signs Google in by
			// its own button (Identity Services, FedCM where the browser has
			// it) for a client registered to the app's origins, which the
			// terminal is handed; Google's script runs in the auth service's
			// page the terminal frames, never the app's. It has no redirect, so
			// no native host signs in by it.
			provider?: [string]~(Name,_): {
				_providersPresent: true & (providers != _|_)
				_named:            true & list.Contains(providers, Name)
				issuer?:           string
				internal?:         string
				client?:           string
				scope?:            string
				params?:           string
				credential?:       true
				if credential != _|_ {_credentialIsGoogle: Name & "google"}
			}
		}
		// The native hosts the app ships beside the web one, each for its
		// store: every route projects deterministically to DivKit (phone) and
		// winio (desktop) via project-native.ts. The hosts are the terminal's;
		// this only says which the app asks for.
		native: *[] | [...("android" | "ios")] & list.UniqueItems()
		// Switches the cluster's blob plane on (#emit): rclone-s3 object store
		// and imgproxy behind the caddy /blobs and /img routes.
		blobs: *false | bool
		// The edge's image service, the layer above blob storage (R2 there,
		// docs/release-targets.md#cloudflare): /img transforms what the bucket holds.
		edgeImages?: {
			// A bucket name rows written before mecha-objects still spell.
			sourceBucket?: =~"^[a-z0-9][a-z0-9.-]*[a-z0-9]$"
			// "paid" when this account has a card behind Cloudflare Images: the
			// release refuses a screen's data-image-src without it.
			plan: *"free" | "paid"
		}
		if edgeImages != _|_ {blobs: true}

		// Files that are part of the app, as its code is: named by their sha256,
		// served at /seed-assets/<file> and read by code, never by a row. Every
		// { file, sha256 } the app-relative manifest names, fetched from the
		// public origin and refused unless its bytes hash to its sha256. In a
		// cluster the door routes them to the app's own target `assets` on 8787.
		seedAssets?: {
			manifest: string
			origin:   =~"^https://[^/]+(/.*[^/])?$"
		}
		// Objects that are part of the data, as seed rows are: the files in this
		// app-relative directory, named by their sha256, go to blob storage at
		// seed/<file> on every target, where a row names them as it names any
		// other object. Pages has no blob storage, and inlines them.
		seedBlobs?: dir: string
		if seedBlobs != _|_ {blobs: true}

		// First-class 3-tier AI model architecture (`browser`, `cheap`, `heavy`)
		// with per-tier and per-release-target model overrides. Backend tiers
		// (`cheap`, `heavy`) route through mecha's tsbifrost AI gateway; the
		// `browser` tier runs in an `agent` worker unit via `capabilities.vendored`.
		// On cloudflare a backend tier may be `{secret: NAME, routes: {...}}`:
		// each deployment's NAME selects a route at each call, so staging and
		// production differ by a setting, not a build. NAME is a dispatcher
		// secret the publish carries or finds held, and verify asks for; a
		// route's provider key is required only where it is selected.
		ai?: {
			text?:   *["browser", "cheap", "heavy"] | ([...mechaCluster.#AiTier] & list.UniqueItems())
			image?:  *["browser", "cheap", "heavy"] | ([...mechaCluster.#AiTier] & list.UniqueItems())
			models?: mechaCluster.#AiTierOverrides
			targets?: {
				[("browser" | "pages" | "docker" | "local" | "gcp" | "k8s" | "aws")]: mechaCluster.#AiTierOverrides
				cloudflare?:                                                          mechaCluster.#AiEdgeOverrides
			}
		}
		// Escape hatches (ir kind "hatch"): what pronto is told not to look
		// inside. A `container` hatch withholds a service, whose definition is
		// the program's cluster unification beside it. An `isolate` hatch is a
		// container of another shape: a module in the Workers format that
		// pronto bundles and serves itself, from `entrypoint` among `files`
		// ([[docs/isolate-hatches]]). A `sql` or `proto` hatch
		// withholds files from the lint that reads every other one — squawk over
		// the SQL, buf breaking over the protos — and `files` names them,
		// app-relative, as exact paths.
		//
		// Inspection is default-on, so a file nobody declares here is a file the
		// lint reads: adding SQL or a proto cannot quietly escape the checks,
		// and escaping them is a declaration. Because every hatch carries `ir`,
		// that declaration is also an element in ir.html, which is what makes an
		// exemption reviewable rather than a line in a tool's config.
		hatches: [string]~(Name,_): {
			let H = self
			ir:   *Name | string
			kind: "container" | "isolate" | "sql" | "proto" | "host-dom"
			note: string
			edge?: {
				kind:  *"worker" | "worker"
				src:   string & =~"^[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)*\\.js$"
				route: string & =~"^/[A-Za-z][A-Za-z0-9_-]*$" & !~"^/(auth|crud|electric|import|poke|blobs|img|rtc-ice)$"
				// Plain settings, which the release supplies and uploads.
				environment: *[] | [...(string & =~"^[A-Z][A-Z0-9_]*$")]
				// Names only: the values live in the Worker's secret store, and no release
				// reads or uploads them ([[docs/release-targets#Keys]]).
				secrets:          *[] | [...(string & =~"^[A-Z][A-Z0-9_]*$")]
				publicAttributes: *{} | {[string & =~"^data-[a-z][a-z0-9-]*$"]: string}
				email?:           {name: string & =~"^[A-Z][A-Z0-9_]*$", recipients: [string & =~"^[^@ ]+@[^@ ]+\\.[^@ ]+$", ...string]}
			}
			if H.edge != _|_ {kind: "container"}

			// The container tier's counterpart of `edge`: caddy proxies `route`,
			// path kept, to the cluster target of the hatch's name on `port`,
			// which the program defines beside it. That service is part of every
			// launch, and the tree every container door serves carries
			// `publicAttributes` ([[docs/edge-hatches#The cluster's door]]).
			door?: {
				route:            string & =~"^/[A-Za-z][A-Za-z0-9_-]*$" & !~"^/(auth|crud|electric|import|poke|blobs|img|rtc-ice|health|omnishell|shell)$"
				port:             int & >0 & <65536
				publicAttributes: *{} | {[string & =~"^data-[a-z][a-z0-9-]*$"]: string & =~"^[A-Za-z0-9_.:-]*$"}
			}
			if H.door != _|_ {kind: "container"}
			activepieces?: #Activepieces
			if H.activepieces != _|_ {
				kind: "container"
				note: !=""
			}
			if H.kind == "host-dom" {
				note:  !=""
				src!:  string & =~"^shell/hatches/([A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\\.(m?js)$"
				files: [string, ...string] & [...(string & =~"^shell/hatches/([A-Za-z0-9_-]+/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$")]
			}

			// The module the bundle starts from, one of `files`, which hold
			// everything it imports beside its packages (its deno.json and lock
			// among them), and the heap the isolate may hold, in MiB, which a
			// Cloudflare Worker caps at 128.
			if H.kind == "isolate" {
				note:        !=""
				entrypoint!: string & =~"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*\\.(ts|js|mjs)$" & !~"(^|/)\\.\\.?(/|$)"
				files:       [string, ...string] & [...(string & =~"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$" & !~"(^|/)\\.\\.?(/|$)")]
				memory:      *128 | int & >=16 & <=128
				// A published isolate is a module pronto ships, which pronto writes
				// beside the app's other generated files and names here
				// ([[docs/isolate-hatches#Published isolates]]).
				uses?: #PublishedIsolate
				if H.uses != _|_ {
					let N = strings.TrimPrefix(H.uses, "pronto/")
					entrypoint: ".pronto/isolates/\(N)/main.ts"
					files:      [for f, _ in _publishedIsolates[N] {".pronto/isolates/\(N)/\(f)"}]
				}
			}

			// A file hatch names its artifacts; host-dom serves them without
			// removing the terminal CSP or Trusted Types boundary.
			if H.kind != "container" {
				files!: [string, ...string]
			}
		}
		// Terminal-tier hatch: a vendored unit running inside the terminal, under
		// one of `isolation`'s boundaries, touching the app only through its
		// `ports`. The boundary is checked against #Terminal.capabilities' offer
		// in #emit; a port naming an undeclared entity is refused here.
		//
		// `files` is everything the unit needs served, `src` among them: the
		// wrapper an engineer audited, and whatever that wrapper loads beside
		// itself. They are served as statics like any other app file, so a unit
		// reaches no further over the network than the app already does.
		vendored: [string]~(Name,_): {
			ir: *Name | string
			// How far the unit reaches without the platform, as protection
			// domains (Saltzer & Schroeder 1975) named by the web platform's own
			// rungs: a `compartment` has no ambient authority; a `realm` is an
			// iframe with its own globals and DOM (ECMA-262 realm) and may
			// present; an `agent` is a worker with its own thread (ECMA-262
			// agent). The boundary does not say what the unit is for: an agent
			// with a memo is a question, and one without is a presenter, whose
			// worker the terminal strips to painting (`role`).
			isolation: "compartment" | "realm" | "agent"
			// Browser permissions the unit asks its seat to delegate, from the
			// terminal's `hatch.realm.grants` offer; only a realm's frame carries
			// them, and the reader is asked in the app's name.
			grants: *[] | [...("geolocation" | "camera" | "payment")]
			// A dedicated subdomain label, served at `https://<subdomain>.<domain>`
			// under the domain a release names, for a realm unit that embeds a
			// third-party provider requiring a non-opaque origin while remaining
			// cross-origin isolated from the app's origin.
			subdomain?: =~"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
			// Derived, never authored: a question asks and its answer lands in
			// the memo; a presenter shows. An agent presenter paints the frames
			// the terminal hands it on a canvas the terminal transfers, in a
			// worker whose policy refuses every connection but blob: and data:
			// and whose globals are pruned to what drawing needs.
			role: [if memo != _|_ {"question"}, "presenter"][0]
			// The terminal's pinned scripts an agent presenter runs before its
			// own code (the terminal's `presenter.scripts` offer): fetched by
			// the terminal against their integrity, evaluated in the worker
			// before the prune.
			scripts: [...string]
			// Everything the unit touches, as entities and events (ports and
			// adapters, Cockburn 2005): `reads` the entities whose rows it is
			// handed, read-only, and `raises` the events it may post. The
			// terminal is the adapter on each — the mount's data-prop-* feed off
			// a read's row, the mount's data-on-* listener on a raise — and it
			// refuses a row or an event outside them; its markup lint holds every
			// mount to the same lists and asks that every raise be handled.
			// Each raise names its payload shape, the grammar machine events
			// use: the seat rebuilds a detail from it and holds every detail to
			// one size bound, so what an event may carry is the program's to say
			// (docs/archive/2026-10-28-unit-event-types.md). A memo's one raise is
			// written `{}`: its shape is the memo's key and columns, derived.
			ports: {
				reads: [...string]
				raises: [string]: #MechaShape & {type: "object"}
			}
			// An agent is a question whose answer lands in a memo (Michie's memo
			// table, 1968: answers addressed by what was asked); a unit that
			// acts on the world is a process hatch. `entity` is where the answer
			// lands and `key` the question's fields — a unique of the entity,
			// taken from the mount's data-prop-* of the same names. The terminal
			// performs it: a question whose row exists is answered from the row
			// and never posted; the unit's answer is upserted on the key and the
			// one event it raises reaches the chart naming the row. #App holds
			// the isolation, the entity, the key, the unique and the columns
			// (text, since an answer crosses the seat as strings) to this;
			// #emit holds the columns to the seat's detail offer — their count,
			// their names, and the size bound a column declares — since an
			// answer carries every column in one event.
			memo?: {entity: string, key: [string, ...string]}
			src:   string
			files: [...string]
			note:  string
		}
	}

	surface: {
		screens: [string]~(Name,_): {
			let S = self
			#Screen & {
				name: Name
				let authRequired = [if A.capabilities.auth != _|_ if A.capabilities.auth.required {true}, false][0]
				let authOn = A.capabilities.auth != _|_
				_topLive: [
					for read in S.reads if read.kind == "live" && !read.nested {
						read.table
					},
				]
				_topRestricted: [
					for read in S.reads if read.kind == "live" && !read.nested
					let en = A._entityByTable[read.table]
					let e = A.state.entities[en] if e.server if e.access != _|_ if e.access.scope != "public" {
						"\(en) (\(e.access.scope))"
					},
				]
				_publicServerReads: [
					for read in S.reads if read.kind == "live"
					let en = A._entityByTable[read.table]
					let e = A.state.entities[en] if e.server if e.access != _|_ if e.access.scope == "public" {
						en
					},
				]
				let defaultAccess = [
					if authRequired || (len(S._topLive) > 0 && len(S._topRestricted) == len(S._topLive)) {"private"},
					"public",
				][0]
				access: *defaultAccess | "public" | "private"
				let defaultSsr = [
					if S.prerender {"ssg"},
					if S.access == "public" && authOn && len(S._publicServerReads) > 0 {"ssr"},
					"spa",
				][0]
				ssr: *defaultSsr | "spa" | "ssg" | "ssr"
				if S.ssr == "ssg" {prerender: true}
			}
		}
		// Jessie handlers, bijection surface (ir kind "handler"): `of` is the
		// screen, `src` the assembly module, served by the terminal. The loader
		// resolves the screen's files.handlers, which markup binding derives.
		handlers: [string]~(Name,_): {ir: *Name | string, of: string, src: #Jessie, note: string}
		// The kinetic plane's Jessie module graphs: `src` is the entry, its
		// static imports relative paths to the app's own modules. derive links
		// it (engine-link.ts) into shell/engines/<Name>.json, which the
		// terminal serves and its cage imports, endowed with nothing. An
		// `engine` exports initState, advanceFrame, saveState and loadState
		// (omnishell's docs/kinetic.md); a `sound` exports createSound, which
		// the terminal hands the AudioContext it tames (kinetic-sound.js), so
		// the context is the role's one authority and an argument, not a
		// global.
		engines: [string]~(Name,_): {src: #Jessie, note: string, role: *"engine" | "sound"}
		design: #Design
		flows: [string]~(Name,_): #Flow & {name: Name}
		// What a terminal module may use past the language, keyed by its
		// app-relative path: the one spelling every loader and lint read, and
		// a key naming no module is refused.
		endowments?: [string]~(Path,_): [...#SafeEndowment]
	}

	meta: {
		// Also the app's directory name, which is why a hyphen is admitted;
		// the emission folds it where an identifier is required.
		name: =~"^[a-z][a-z0-9-]*$"
		// One line for the entry page's meta description. The hash router gives
		// every route this same description, so it names the app, not a screen.
		description: string
		favicon?:    #Favicon
		manifest?:   bool | #Manifest
		social?:     #Social
		llms?:       bool | #Llms
		wellKnown?: [string]: #WellKnownItem
		preconnect?:  string | #PreconnectItem | [...(string | #PreconnectItem)]
		dnsPrefetch?: string | [...string]
		googleTag?:   #GoogleTag
		consent?:     #Consent
		themeColor?:  string
		sitemap?:     #Sitemap
		ir:           {source: *"ir.html" | string, sha256: *"" | string} // the pinned IR this program was compiled from
		ladder:       *[] | [...string]                                   // composed journal/ and ir/ files served under /srv/docs/
		domain?:      string
		ssrOrigin?:   string
		// A frozen archive retains its schedules and runs none, at the edge or
		// in a page.
		edgeClock?: "ticker" | "disabled"
		cloudflare: workersPaid: *false | bool
		targets: *["docker"] | [...#Target]
		// Targets where something outside the cluster pokes the ticker. The
		// compose clock is emitted by cluster.cue and the edge's Cron Trigger
		// by the cloudflare release, so neither needs a declaration; a cloud
		// target's clock lives in a deploy tree mecha does not write, and the
		// original bug was not that the clock was in the wrong place but that
		// nothing could tell. #emit refuses a target that declares a schedule
		// and no clock here.
		clocks: *[] | [...#Target]
		// A program names its decisions and nothing more: `note` is derived
		// from the prose of the ir element `ir` names (pronto derive.ts), so the
		// reviewed artifact is the only place the rationale is written. The
		// empty default is what a first export holds before any derivation has
		// run: program_derived.cue unifies the derived note over it, so a new
		// app needs no stub file to complete its first generate.
		decisions: [string]~(Id,_): {ir: *Id | string, note: *"" | string}
		tests: [string]~(Id,_):     #Test & {id: Id}
		i18n?: #I18n
		// The literal debt this app still carries: how many declarations wear
		// `/* pronto-literal: pending */`. Checked for EQUALITY, not a ceiling —
		// fixing a site without lowering the number fails, adding one without
		// raising it fails, and raising it is a diff here that a reviewer sees.
		// Debt is strictly monotone downward, and zero is the default because an
		// app that has never reached for the hatch should not have to say so.
		design: pendingLiterals: *0 | int & >=0
	}

	if A.state.duckstreams != _|_ {
		state: computations: {
			for streamName, stream in A.state.duckstreams if stream.backend != _|_ {
				(streamName): {
					_sourceCount:      len([for _, source in stream.sources {source}]) & >0
					_sinkCount:        len([for _, sink in stream.sinks {sink}]) & >0
					_transactions:     [for transaction, _ in {for _, sink in stream.sinks {(sink.transaction): true}} {transaction}]
					_transactionCount: len(_transactions) & 1
					_sourceStorage: [for _, source in stream.sources for entity in source.entities {
						A.state.entities[entity].durability & ("offline" | "live" | "server")
					}]
					src: stream.src
					if stream.risingwave != _|_ {risingwave: stream.risingwave}
					if stream.steps != _|_ {steps: stream.steps}
					to:         [for _, sink in stream.sinks {sink.entity}]
					sinkWrites: {for _, sink in stream.sinks {(sink.entity): sink.write}}
					if len([for _, sink in stream.sinks if sink.columns != _|_ {true}]) > 0 {
						sinkColumns: {for _, sink in stream.sinks if sink.columns != _|_ {(sink.entity): sink.columns}}
					}
					declaredReads: [for table, _ in {
						for _, source in stream.sources for entity in source.entities {
							(A.state.entities[entity].table): true
						}
					} {table}]
					typedSinks: true
					wasm:       stream.wasm
					endowments: stream.endowments
					if stream.onComplete != _|_ {onComplete: stream.onComplete}
					if stream.queryTypes != _|_ {queryTypes: stream.queryTypes}
				}
			}
		}
	}

	_sinkColumnViolations: list.Concat([for name, computation in A.state.computations
	if computation.sinkColumns != _|_ for entity, columns in computation.sinkColumns {
		let fields = A.state.entities[entity].fields
		let writable = [for f in fields if !f.retired if f.generated == _|_ {f.name}]
		list.Concat([
			[for column in columns if !list.Contains(writable, column) {
				"computation \(name) sink \(entity) column \(column) is not a writable entity field"
			}],
			[for f in fields if !f.retired if f.generated == _|_
			if f.pk || (f.required && f.default == _|_) if !list.Contains(columns, f.name) {
				"computation \(name) sink \(entity) requires insert column \(f.name)"
			}],
		])
	}])
	_sinkColumnRefusal: [if len(_sinkColumnViolations) == 0 {true}, error(_sinkColumnViolations[0])][0]

	// Static proof of the mutation loop: a cold pipeline cannot feed an active screen mutation loop D(E)
	_hotViolations: [
		if A.state.duckstreams != _|_
		let eLookup = {
			for eName, e in A.state.entities {
				(eName): eName
				if e.table != _|_ {
					(e.table): eName
				}
			}
		}
		for plName, pl in A.state.duckstreams if pl.backend == _|_ if pl.tempo == "cold"
		let plSinkEntity = [if eLookup[pl.sink] != _|_ {eLookup[pl.sink]}, pl.sink][0]
		let plSourceEntities = [for s in pl.sources {[if eLookup[s] != _|_ {eLookup[s]}, s][0]}]
		for sName, s in A.surface.screens
		let sReadsEntities = [if s.reads != _|_ for r in s.reads {[if eLookup[r.table] != _|_ {eLookup[r.table]}, r.table][0]}]
		let sFormsEntities = [if s.forms != _|_ for f in s.forms if f.entity != _|_ {[if eLookup[f.entity] != _|_ {eLookup[f.entity]}, f.entity][0]}]
		if list.Contains(sReadsEntities, plSinkEntity)
		if len([for fe in sFormsEntities if list.Contains(plSourceEntities, fe) {fe}]) > 0 {
			pipeline: plName
			screen:   sName
			sink:     pl.sink
		}
	]
	_hotRefusal: [if len(_hotViolations) == 0 {true}, "cold pipeline cannot feed an active screen mutation loop: \(_hotViolations[0].pipeline) feeds \(_hotViolations[0].sink) on screen \(_hotViolations[0].screen)"][0] & true

	_hostDomViolations: list.Concat([
		[for sn, screen in A.surface.screens for hn in screen.hatches if A.capabilities.hatches[hn] == _|_ {
			"screen \(sn) names undeclared host-DOM hatch: \(hn)"
		}],
		[for sn, screen in A.surface.screens for hn in screen.hatches if A.capabilities.hatches[hn] != _|_ if A.capabilities.hatches[hn].kind != "host-dom" {
			"screen \(sn) names hatch \(hn), which is not host-dom"
		}],
		[for hn, h in A.capabilities.hatches if h.kind == "host-dom" if !list.Contains(h.files, h.src) {
			"host-DOM hatch \(hn) must serve its src in files"
		}],
		[for sn, screen in A.surface.screens if len([for hn, _ in {for h in screen.hatches {(h): true}} {hn}]) != len(screen.hatches) {
			"screen \(sn) repeats a host-DOM hatch"
		}],
	])
	_hostDomRefusal: [if len(_hostDomViolations) == 0 {true}, _hostDomViolations[0]][0] & true

	_screenAccessViolations: list.Concat([
		[if A.capabilities.auth != _|_ if A.capabilities.auth.required for sn, screen in A.surface.screens if screen.access == "public" {
			"screen \(sn) declares access: \"public\" in an app behind a sign-in"
		}],
		[for sn, screen in A.surface.screens if len(screen._topLive) > 0 && len(screen._topRestricted) == len(screen._topLive) if screen.access == "public" {
			"screen \(sn) declares access: \"public\" over \(strings.Join(screen._topRestricted, ", ")); every top-level region is restricted"
		}],
	])
	_screenAccessRefusal: [if len(_screenAccessViolations) == 0 {true}, error(_screenAccessViolations[0])][0]

	state: entities: {for en, e in A.state.entities {
		(en): validations: close({
			if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m.entity == en || m.entity == e.table
			for gn, g in m.guards {
				(gn): g & {
					machine: mn
					on:      [for op, tr in m._on if list.Contains(tr.guard, gn) {op}]
					let ordinal = [for i, name in list.SortStrings([for other, om in A.state.mecha.rows if om.entity == en || om.entity == e.table {"trg_\(e.table)_\(other)_reducer"}]) if name == "trg_\(e.table)_\(mn)_reducer" {i}][0]
					order: {for op, tr in m._on for i, name in tr.guard if name == gn {(op): [ordinal, i]}}
				}
			}
		})
	}}
	// The column each chart owns, by entity name (a chart names its entity by
	// name or by table) and then field: its initial state and its states, read
	// once here for every column's lookup (#machineColumn). A machine reads the
	// App, so a lookup handed the machines themselves copies the App each time.
	_machineColumns: {if A.state.mecha.rows != _|_ for _, m in A.state.mecha.rows if m.field != _|_ if m.initial != _|_
	for en, e in A.state.entities if m.entity == en || m.entity == e.table {
		(en): (m.field): {initial: m.initial, states: [for n, _ in m.states {n}]}
	}}
	state: mecha: rows: [string]~(mn,_): {
		let m = A.state.mecha.rows[mn]
		for en, e in A.state.entities if m.entity == en || m.entity == e.table {
			level: [if len([if m.states != _|_ for st in m.states if st.invoke != _|_ {st}]) > 0 {"external"}, if m.states == _|_ if len(m._actions) == 0 {e.level}, "replicated"][0]
		}
	}

	_lifecycleViolations: list.Concat([
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows for op, tr in m._on if len([for name, _ in {for g in tr.guard {(g): true}} {name}]) != len(tr.guard) {
			"lifecycle machine \(mn).\(op) repeats a guard"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows for op, tr in m._on for gn in tr.guard if m.guards[gn] == _|_ {
			"lifecycle machine \(mn).\(op) names undeclared guard \(gn)"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows for gn, _ in m.guards if len([for op, tr in m._on if list.Contains(tr.guard, gn) {op}]) == 0 {
			"lifecycle machine \(mn) declares unused guard \(gn)"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if len(m.guards) > 0 if m.states != _|_ {
			"machine \(mn) puts lifecycle guards on a statechart"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m.on != _|_ for en, e in A.state.entities if m.entity == en || m.entity == e.table if len("trg_\(e.table)_\(m.name)_reducer") > 63 {
			"lifecycle interpreter name exceeds Postgres's 63-byte limit: \(mn)"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if len(m.guards) > 0 for a in m._actions if a.assign != _|_ {
			"guarded lifecycle machine \(mn) cannot assign NEW after the write; use a relational action"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if len(m.guards) > 0 if m.timing != _|_ if m.timing != "AFTER" {
			"lifecycle guards require AFTER timing: \(mn)"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows for en, e in A.state.entities if m.entity == en || m.entity == e.table if !e.server if m.states != _|_ || len(m._actions) > 0 {
			"machine \(mn) requires a server-held entity for actions or a statechart: \(en)"
		}],
	])
	_lifecycleRefusal: [if len(_lifecycleViolations) == 0 {true}, _lifecycleViolations[0]][0] & true

	_machineActions: list.Concat([
		[if A.state.mecha.rows != _|_ for mName, m in A.state.mecha.rows {machine: mName, actions: m._actions}],
		[if A.state.mecha.reducers != _|_ for mName, m in A.state.mecha.reducers {machine: mName, actions: [for _, phase in m.reducer.states for _, transition in phase.on if transition.actions != _|_ for actionSpec in transition.actions {actionSpec}]}],
	])
	_machineCalls: [for caller in _machineActions for actionSpec in caller.actions for call in [
		if actionSpec.spawn != _|_ {{kind: "spawn", target: actionSpec.spawn.machine}},
		if actionSpec.send != _|_ {{kind: "send", target: actionSpec.send.machine, event: actionSpec.send.event}},
	] {call}]
	_callTargets: [if A.state.mecha.reducers != _|_ {A.state.mecha.reducers}, {}][0]
	_machineCallViolations: list.Concat([
		[for call in _machineCalls if _callTargets[call.target] == _|_ {"undeclared Mecha operation target: \(call.target)"}],
		[for call in _machineCalls if _callTargets[call.target] != _|_ if call.kind == "spawn" if _callTargets[call.target].reducer.initialize == _|_ {"Mecha spawn requires an initializer: \(call.target)"}],
		[for call in _machineCalls if _callTargets[call.target] != _|_ if call.kind == "send" if _callTargets[call.target].reducer.events[call.event] == _|_ {"undeclared Mecha delivery event: \(call.target).\(call.event)"}],
		[for call in _machineCalls if _callTargets[call.target] != _|_ if call.kind == "send" if _callTargets[call.target].reducer.events[call.event] != _|_ if _callTargets[call.target].reducer.events[call.event].tier != "mecha" {"delivery requires a Mecha event: \(call.target).\(call.event)"}],
	])
	_machineCallRefusal: [if len(_machineCallViolations) == 0 {true}, _machineCallViolations[0]][0] & true
	// A Cortex state names the screen that hosts it and the actor its child
	// is; what an actor's `via` needs of its Mecha machine is what that
	// machine's ports carry.
	_cortexViolations: [if A.state.cortex != _|_ for cName, c in A.state.cortex if c.config.meta == _|_ || c.config.meta.host == _|_ for sName, st in c.config.states
	let rootInvokes = [if st.invoke == _|_ {[]}, if (st.invoke & [...]) != _|_ {st.invoke}, {[st.invoke]}][0]
	let subInvokes = list.Concat([
		for _, sub in [if st.states != _|_ {st.states}, {}][0] if sub.invoke != _|_ {
			[if (sub.invoke & [...]) != _|_ {sub.invoke}, {[sub.invoke]}][0]
		}
	])
	let screenInvokes = list.Concat([rootInvokes, subInvokes])
	for v in list.Concat([
		[if st.meta == _|_ || st.meta.screen == _|_ {"\(cName).\(sName): no meta.screen hosts it"}],
		[if st.meta != _|_ if st.meta.screen != _|_ if A.surface.screens[st.meta.screen] == _|_ {"\(cName).\(sName): no screen \(st.meta.screen)"}],
		for inv in screenInvokes {
			[if c.setup.actors[inv.src] == _|_ {"\(cName).\(sName): the setup implements no actor \(inv.src)"}]
		},
		for inv in screenInvokes if c.setup.actors[inv.src] != _|_ if c.setup.actors[inv.src].via == "kinetic" {
			let actor = c.setup.actors[inv.src]
			let markup = [if st.meta != _|_ if st.meta.screen != _|_ if A.surface.screens[st.meta.screen] != _|_ if A.surface.screens[st.meta.screen].markup != _|_ {A.surface.screens[st.meta.screen].markup}, ""][0]
			list.Concat([
				[if [for n, e in A.surface.engines if n == actor.engine if e.role == "engine" {n}] == [] {"\(cName).\(sName): no engine \(actor.engine) races the kinetic child \(inv.src)"}],
				[if actor.sound != _|_ if [for n, e in A.surface.engines if n == actor.sound if e.role == "sound" {n}] == [] {"\(cName).\(sName): no sound role \(actor.sound) voices the kinetic child \(inv.src)"}],
				[if [for n, v in A.capabilities.vendored if n == actor.presenter if v.role == "presenter" if v.isolation == "agent" {n}] == [] {"\(cName).\(sName): no presenter \(actor.presenter) paints the kinetic child \(inv.src)"}],
				[if !strings.Contains(markup, "data-kinetic=\"\(inv.src)\"") {"\(cName).\(sName): no data-kinetic=\"\(inv.src)\" mounts the kinetic child on its screen"}],
			])
		},
		for inv in screenInvokes if c.setup.actors[inv.src] != _|_ if list.Contains(["session", "sync", "local"], c.setup.actors[inv.src].via) {
			let actor = c.setup.actors[inv.src]
			list.Concat([
				[if _callTargets[actor.machine] == _|_ {"\(cName).\(sName): no Mecha machine \(actor.machine)"}],
				if _callTargets[actor.machine] != _|_ {
					let m = _callTargets[actor.machine].reducer
					let instance = [if inv.input != _|_ if inv.input.instance != _|_ {inv.input.instance}, ""][0]
					list.Concat([
						[if m.initialize == _|_ {"\(cName).\(sName): \(m.name) has no initializer"}],
						[if actor.via == "session" if m.ports == _|_ || m.ports.lease == _|_ {"\(cName).\(sName): a session needs \(m.name)'s lease"}],
						[if actor.via == "sync" if m.ports == _|_ || m.ports.join == _|_ {"\(cName).\(sName): a sync child joins \(m.name), which declares no join"}],
						[if actor.via == "sync" if !strings.HasPrefix(instance, "{param.") {"\(cName).\(sName): a sync child's input.instance names its route's parameter"}],
						[if actor.via == "sync" if strings.HasPrefix(instance, "{param.") if st.meta != _|_ if st.meta.screen != _|_ if A.surface.screens[st.meta.screen] != _|_
						if !list.Contains(strings.Split(A.surface.screens[st.meta.screen].route, "/"), ":" + strings.TrimSuffix(strings.TrimPrefix(instance, "{param."), "}")) {"\(cName).\(sName): \(st.meta.screen)'s route has no \(instance)"}],
					])
				},
			])
		},
	]) {v}]
	_cortexBackend: [if A.state.cortex != _|_ for chartName, chart in A.state.cortex if chart.config.meta != _|_ if chart.config.meta.host != _|_ if chart.config.meta.host == "mecha" {
		name:      chartName
		id:        chart.config.id
		function:  chart.config.meta.function
		migration: chart.config.meta.migration
		table:     [if A.state.entities[chart.config.meta.entity] != _|_ {A.state.entities[chart.config.meta.entity].table}, chart.config.meta.entity][0]
		field:     chart.config.meta.field
	}]
	_cortexBackendViolations: [for c in _cortexBackend for other in _cortexBackend if c.name != other.name {
		if c.id == other.id {"Cortex charts \(c.name) and \(other.name) share id \(c.id)"}
		if c.function == other.function && c.migration != other.migration {"Cortex function \(c.function) spans migrations \(c.migration) and \(other.migration)"}
		if c.table == other.table && c.field == other.field {"Cortex charts \(c.name) and \(other.name) both own \(c.table).\(c.field)"}
	}]
	_cortexTerminal: [if A.state.cortex != _|_ for _, chart in A.state.cortex if chart.config.meta != _|_ if chart.config.meta.host != _|_ if chart.config.meta.host == "omnishell" {chart}]
	_cortexTerminalViolations: list.Concat([
		[if len(_cortexTerminal) > 1 {"one terminal Cortex root may own navigation"}],
		[for chart in _cortexTerminal for screen, _ in A.surface.screens if chart.config.on["route:"+screen] == _|_ {"terminal Cortex root has no route:\(screen) transition"}],
		[for chart in _cortexTerminal for name, actor in chart.setup.actors if actor.via == "rows" if A.surface.screens[actor.screen] == _|_ {"terminal Cortex row actor \(name) names undeclared screen \(actor.screen)"}],
		[if A.state.cortex != _|_ for _, chart in A.state.cortex for name, actor in chart.setup.actors if actor.via == "observe" if actor.machine != _|_ if actor.table == _|_ || actor.field == _|_ {"Cortex observation \(name) requires composition to resolve machine \(actor.machine)"}],
	])
	_cortexAllViolations: list.Concat([_cortexViolations, _cortexBackendViolations, _cortexTerminalViolations])
	_cortexRefusal:       [if len(_cortexAllViolations) == 0 {true}, _cortexAllViolations[0]][0] & true
	// A signal names where a Mecha machine went: `signal:<table>.<state>`, a
	// state of the machine on that table's entity. One naming no such state is
	// an arrow nothing ever fires, which a walk of the chart would still cover.
	_cortexNodes: [if A.state.cortex != _|_ for cName, c in A.state.cortex if c.config != _|_ for sName, st in c.config.states
	for at, node in {
		(sName): st
		if st.states != _|_ for n1, s1 in st.states {
			"\(sName).\(n1)": s1
			if s1.states != _|_ for n2, s2 in s1.states {"\(sName).\(n1).\(n2)": s2}
		}
	} {chart: cName, state: at, on: [if node.on != _|_ {node.on}, {}][0]}]
	_cortexSignalViolations: [for n in _cortexNodes for k, _ in n.on if strings.HasPrefix(k, "signal:")
	let parts = strings.SplitN(strings.TrimPrefix(k, "signal:"), ".", 2)
	let entity = [if len(parts) == 2 if A._entityByTable[parts[0]] != _|_ {A._entityByTable[parts[0]]}, ""][0]
	let states = [if A.state.mecha.rows != _|_ for _, m in A.state.mecha.rows if m.entity == entity {m.states}]
	if len(parts) != 2 || entity == "" || len(states) == 0 || states[0][parts[len(parts)-1]] == _|_ {
		"\(n.chart).\(n.state): \(k) names no state of a Mecha machine on its table"
	}]
	_cortexSignalRefusal: [if len(_cortexSignalViolations) == 0 {true}, _cortexSignalViolations[0]][0] & true
	// The XState a Mecha machine cannot run is refused rather than read as
	// something else: its step is its reducer's, so it invokes nothing, and an
	// event names one transition.
	// Each state is checked where it stands: a compound state's children by
	// their path (`racing.closing`), beside the parent whose events they take.
	_mechaViolations: list.Concat([[if A.state.mecha.reducers != _|_ for hName, h in A.state.mecha.reducers for sName, node in {
		for n, s in h.machine.config.states {
			(n): {st: s, parent: {}}
			if s.states != _|_ for c, cs in s.states {"\(n).\(c)": {st: cs, parent: s}}
		}
	}
	let st = node.st for v in list.Concat([
		[if st.invoke != _|_ {"mecha \(hName).\(sName): a Mecha machine invokes nothing"}],
		[if st.on != _|_ for ev, tv in st.on if (tv & [...]) != _|_ if len(tv) != 1 {"mecha \(hName).\(sName).on.\(ev): an event names one transition; a guarded alternative belongs in the guard"}],
		// XState takes the machine's transition when the state's own guard
		// refuses; one event names one transition here, so it is the state's
		// or the machine's.
		[if h.machine.config.on != _|_ if st.on != _|_ for ev, _ in st.on if h.machine.config.on[ev] != _|_ {"mecha \(hName).\(sName).on.\(ev): the machine takes \(ev) in every state; a state does not take it as well"}],
		// Nor does a child take an event the state it is a child of takes.
		[if node.parent.on != _|_ if st.on != _|_ for ev, _ in st.on if node.parent.on[ev] != _|_ {"mecha \(hName).\(sName).on.\(ev): the state it is a child of takes \(ev); a child does not take it as well"}],
		// XState reads a delay that is not a number as a name in `delays`.
		[if st.after != _|_ for delay, _ in st.after if !(delay =~ "^[0-9]+$") if h.machine.setup.delays == _|_ || h.machine.setup.delays[delay] == _|_ {"mecha \(hName).\(sName).after.\(delay): no delay \(delay) in setup.delays"}],
		[if st.after != _|_ if st.type != _|_ if st.type == "final" {"mecha \(hName).\(sName): a final state starts no timer"}],
		// One level of XState's nesting: a compound state's children, atomic.
		[if st.states != _|_ for cName, ct in st.states if ct.states != _|_ {"mecha \(hName).\(sName).\(cName): a child state holds no states of its own"}],
		[if st.type != _|_ if st.type == "parallel" {"mecha \(hName).\(sName): a Mecha machine has no parallel states"}],
	]) {v}], [if A.state.mecha.reducers != _|_ for hName, h in A.state.mecha.reducers if h.machine.setup.ports != _|_ if h.machine.setup.ports.wake != _|_ {
		"mecha \(hName).setup.ports.wake: a timer is a state's after, its delay a number of milliseconds or a name in setup.delays"
	}],[if A.state.mecha.reducers != _|_ for hName, h in A.state.mecha.reducers if h.machine.config.on != _|_ for ev, tv in h.machine.config.on if (tv & [...]) != _|_ if len(tv) != 1 {
		"mecha \(hName).on.\(ev): an event names one transition; a guarded alternative belongs in the guard"
	}]])
	_mechaRefusal: [if len(_mechaViolations) == 0 {true}, _mechaViolations[0]][0] & true
	// A machine's surface columns hold its own values: a seat's view, a
	// command's request and an open's input are json columns whose cel is the
	// one cel-shape.cue renders from the machine, so the value a settle writes
	// and the value the terminal proposes are judged by one text.
	_surfaceEntities: {if A.state.entities != _|_ for n, e in A.state.entities {(e.table): e}}
	_surfaceViolations: list.Concat([if A.state.mecha.reducers != _|_ for hName, h in A.state.mecha.reducers {
		let seat = _surfaceEntities["\(hName)_seat"]
		let command = _surfaceEntities["\(hName)_command"]
		let open = _surfaceEntities["\(hName)_open"]
		list.Concat([
			[if seat != _|_ for f in seat.fields if f.name == "view" {
				let want = (#ShapeCel & {shape: h.reducer.view}).out
				if f.type != "json" {"mecha \(hName): \(seat.table).view holds the view, so it is json"}
				if f.type == "json" if f.cel == _|_ {"mecha \(hName): \(seat.table).view states no cel; #ShapeCel renders the view's"}
				if f.type == "json" if f.cel != _|_ if f.cel != want {"mecha \(hName): \(seat.table).view's cel is not the view's as #ShapeCel renders it"}
			}],
			[if command != _|_ for f in command.fields if f.name == "request" {
				let want = (#RequestCel & {events: [for ev, e in h.reducer.events if e.tier == "omnishell" {ev}]}).out
				if f.type != "json" {"mecha \(hName): \(command.table).request holds the request, so it is json"}
				if f.type == "json" if f.cel == _|_ {"mecha \(hName): \(command.table).request states no cel; #RequestCel renders the envelope's"}
				if f.type == "json" if f.cel != _|_ if f.cel != want {"mecha \(hName): \(command.table).request's cel is not the envelope's as #RequestCel renders it"}
			}],
			[if open != _|_ for f in open.fields if f.name == "input" if f.type != "json" {"mecha \(hName): \(open.table).input holds the input, so it is json"}],
		])
	}])
	_surfaceRefusal: [if len(_surfaceViolations) == 0 {true}, _surfaceViolations[0]][0] & true
	_machineHatches: {
		if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows {(mn): m.hatches}
		if A.state.mecha.reducers != _|_ for mn, m in A.state.mecha.reducers {("reducer:\(mn)"): m.reducer.hatches}
	}

	_machineHatchViolations: list.Concat([
		[for mn, hs in _machineHatches for hn in hs if A.capabilities.hatches[hn] == _|_ {
			"machine \(mn) calls undeclared SQL hatch: \(hn)"
		}],
		[for mn, hs in _machineHatches for hn in hs if A.capabilities.hatches[hn] != _|_ if A.capabilities.hatches[hn].kind != "sql" {
			"machine \(mn) calls hatch \(hn), which is not SQL"
		}],
	])
	_machineHatchRefusal: [if len(_machineHatchViolations) == 0 {true}, _machineHatchViolations[0]][0] & true

	// A machine names its entity by name or table, as emit.cue resolves it.
	_machineEntityViolations: [
		if A.state.mecha.rows != _|_
		for mName, m in A.state.mecha.rows
		if len([for en, e in A.state.entities if en == m.entity || e.table == m.entity {en}]) == 0 {
			"machine \(mName) names undeclared entity: \(m.entity)"
		},
	]
	_machineEntityRefusal: [if len(_machineEntityViolations) == 0 {true}, _machineEntityViolations[0]][0] & true

	_machineStateViolations: list.Concat([
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m.states != _|_ if m.on != _|_ {
			"machine \(mn) combines states and lifecycle handlers: declare separate machines"
		}],
		if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m.field != _|_ if m.initial != _|_ for en, e in A.state.entities if en == m.entity || e.table == m.entity {
			list.Concat([
				[if m.states[m.initial] == _|_ {"machine \(mn) initial \(m.initial) is not a state"}],
				[if !list.Contains([for f in e.fields {f.name}], m.field) {"machine \(mn) field \(m.field) is not a column of \(en)"}],
				[for f in e.fields if f.name == m.field if f.generated != _|_ {
					"machine \(mn) field \(en).\(m.field) is generated and cannot hold transitions"
				}],
				[for f in e.fields if f.name == m.field if f.retired {
					"machine \(mn) field \(en).\(m.field) is retired and cannot hold transitions"
				}],
				// A client moves the machine by writing its state field, which the
				// interpreter reads as the target: a field a client's value is cleared
				// from, or may not change, would make every such move a silent no-op
				// or a refusal. A Cortex machine's events arrive as command rows.
				[if m.cortex == _|_ for f in e.fields if f.name == m.field for b in ["outputOnly", "immutable"] if f[b] != _|_ if f[b] {
					"machine \(mn) field \(en).\(m.field) is \(b) and cannot hold transitions: a client moves the machine by writing it"
				}],
				[for f in e.fields if f.name == m.field if f.default != _|_ if strings.TrimSpace(f.default) != "'"+strings.Replace(m.initial, "'", "''", -1)+"'" {
					"machine \(mn) initial \(m.initial) disagrees with \(en).\(m.field) default \(f.default)"
				}],
				[if e.cel.enums[m.field] != _|_ for state, _ in m.states if !list.Contains(e.cel.enums[m.field], state) {
					"machine \(mn) state \(state) is not admitted by \(en).\(m.field) cel enum"
				}],
				[for i, row in e.seed if row[m.field] != _|_ if !list.Contains([for state, _ in m.states {state}], row[m.field]) {
					"machine \(mn) seed \(en)[\(i)].\(m.field) value \(row[m.field]) is not a state"
				}],
				// A seed restores its row standing in a state, entering nothing:
				// a timer or an invocation the state would start, nothing starts.
				[for i, row in e.seed if row[m.field] != _|_ if row[m.field] != m.initial if m.states[row[m.field]] != _|_
				if m.states[row[m.field]].after != _|_ || m.states[row[m.field]].invoke != _|_ {
					"machine \(mn) seed \(en)[\(i)] stands in \(row[m.field]), whose after or invoke a seed does not start: seed it in a state without either"
				}],
			])
		},
	])
	_machineStateRefusal: [if len(_machineStateViolations) == 0 {true}, _machineStateViolations[0]][0] & true

	_timedMachines: [if A.state.mecha.rows != _|_ for _, m in A.state.mecha.rows if m._timed {m}]
	_timerViolations: list.Concat([
		// A page's clock (mecha-browser's clock.ts) sweeps only while it is
		// open, so a page states that it is the clock.
		[if len(A._timedMachines) > 0 for target in A.meta.targets if target != "cloudflare" if !list.Contains(A.meta.clocks, target) {
			"server timers require a declared clock for \(target)"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m._timed for en, e in A.state.entities if en == m.entity || e.table == m.entity if !e.server {
			"timed machine \(mn) requires a server-held entity"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m._timed for en, e in A.state.entities if en == m.entity || e.table == m.entity if len([for f in e.fields if f.pk {f}]) == 0 {
			"timed machine \(mn) requires a primary key"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows for t in m._timers if m.states[t.target] == _|_ {
			"timed machine \(mn) state \(t.state) targets missing state \(t.target)"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m.states != _|_ for sn, st in m.states if st.type != _|_ if st.type == "final" if st.after != _|_ {
			"machine \(mn) final state \(sn) cannot declare after"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows for t in m._timers if (t.delay & =~"^[0-9]+$") == _|_ if m.delays == _|_ || m.delays[t.delay] == _|_ {
			"machine \(mn) state \(t.state) waits after \(t.delay), which its delays does not name"
		}],
		[if A.state.mecha.rows != _|_ for mn, m in A.state.mecha.rows if m.delays != _|_ for dn, d in m.delays if (d & string) != _|_
		for en, e in A.state.entities if en == m.entity || e.table == m.entity
		let found = [for f in e.fields if f.name == d {f}]
		for f in [if len(found) > 0 {found[0]}, {name: d, type: "absent"}][:1]
		if f.type != "duration" {
			[if f.type == "absent" {"machine \(mn) delay \(dn) reads \(d), which \(en) does not declare"},
				"machine \(mn) delay \(dn) reads \(d), a \(f.type): a delay is a duration field, never a date"][0]
		}],
		[if len(A._timedMachines) > 0 for en, e in A.state.entities if e.table == "schedule" || e.table == "machine_timer_tick" {
			"timed machines reserve table \(e.table), declared by \(en)"
		}],
		[if len(A._timedMachines) > 0 for sn, sc in A.state.schedules if strings.HasPrefix(sc.name, "machine:") {
			"timed machines reserve schedule prefix machine:, declared by \(sn)"
		}],
	])
	_timerRefusal: [if len(_timerViolations) == 0 {true}, _timerViolations[0]][0] & true

	_authProviders: [if (A.capabilities & null) == _|_ if A.capabilities.auth != _|_ if A.capabilities.auth.providers != _|_ for p in A.capabilities.auth.providers {p}]
	_authTargetViolations: list.Concat([
		// An iOS host ships on the App Store, which requires Sign in with Apple
		// beside any other provider (App Review Guideline 4.8).
		[if (A.capabilities & null) == _|_ if list.Contains(A.capabilities.native, "ios") if len(_authProviders) > 0 if !list.Contains(_authProviders, "apple") {
			"an iOS host ships on the App Store, which requires Sign in with Apple beside \(_authProviders[0]) (App Review Guideline 4.8): add apple to capabilities.auth.providers"
		}],
		[if (A.capabilities & null) == _|_ if len(A.capabilities.native) > 0 if A.capabilities.auth != _|_ if A.capabilities.auth.provider != _|_ for p, v in A.capabilities.auth.provider if v.credential != _|_ {
			"\(p) signs in by its own button (credential), which no native host draws: drop credential or capabilities.native"
		}],
		[if (A.capabilities & null) == _|_ if len(A.capabilities.native) > 0 if list.Contains(_authProviders, "bluesky") {
			"bluesky offers no native sign-in yet: drop it or capabilities.native"
		}],
	])
	_authTargetRefusal: [if len(_authTargetViolations) == 0 {true}, _authTargetViolations[0]][0] & true

	_unitViolations: list.Concat([
		[for un, u in A.capabilities.vendored for r in u.ports.reads if A.state.entities[r] == _|_ {
			"unit \(un) reads \(r), which is no declared entity"
		}],
		[for un, u in A.capabilities.vendored if u.isolation == "agent" if u.memo == _|_ if len(u.ports.raises) > 0 {
			"unit \(un) is an agent presenter and raises \(strings.Join([for r, _ in u.ports.raises {r}], ", ")): what it computes is a function of its thread's timing, not of anything a person did, so it paints and raises nothing"
		}],
		[for un, u in A.capabilities.vendored if len(u.scripts) > 0 if !(u.isolation == "agent" && u.memo == _|_) {
			"unit \(un) names scripts and is no agent presenter: only a presenter's worker runs the terminal's pinned scripts"
		}],
		[for un, u in A.capabilities.vendored if u.isolation != "agent" if u.memo != _|_ {
			"unit \(un) is a \(u.isolation) with a memo: only an agent asks a question"
		}],
		[for un, u in A.capabilities.vendored if u.memo != _|_ if A.state.entities[u.memo.entity] == _|_ {
			"unit \(un) memo names \(u.memo.entity), which is no declared entity"
		}],
		[for un, u in A.capabilities.vendored if u.isolation != "realm" if len(u.grants) > 0 {
			"unit \(un) is seated as \(u.isolation) and asks for \(strings.Join(u.grants, ", ")): only a realm's frame is delegated a permission"
		}],
		[for un, u in A.capabilities.vendored if u.isolation != "realm" if u.subdomain != _|_ {
			"unit \(un) is seated as \(u.isolation) and names subdomain \(u.subdomain): only a realm's frame has an origin of its own"
		}],
		[for un, u in A.capabilities.vendored if u.memo != _|_ if len(u.ports.raises) != 1 {
			"unit \(un) has a memo and raises \(len(u.ports.raises)) events: a question has one answer"
		}],
		[for un, u in A.capabilities.vendored if u.memo != _|_ for r, sh in u.ports.raises if len(sh.fields) > 0 {
			"unit \(un) has a memo and declares fields for \(r): an answer's shape is the memo's key and columns, derived"
		}],
		[for un, u in A.capabilities.vendored if u.memo != _|_ if A.state.entities[u.memo.entity] != _|_
		let me = A.state.entities[u.memo.entity]
		for k in u.memo.key if !list.Contains([for f in me.fields {f.name}], k) {
			"unit \(un) memo keys on \(k), which is not a field of \(u.memo.entity)"
		}],
		[for un, u in A.capabilities.vendored if u.memo != _|_ if A.state.entities[u.memo.entity] != _|_
		let mk = A.state.entities[u.memo.entity]
		for k in u.memo.key for f in mk.fields if f.name == k if f.pk || f.retired {
			"unit \(un) memo keys on \(k), which is not an active non-primary field of \(u.memo.entity)"
		}],
		[for un, u in A.capabilities.vendored if u.memo != _|_ if A.state.entities[u.memo.entity] != _|_
		let mu = A.state.entities[u.memo.entity]
		if len([for q in mu.uniques if q.where == _|_ if list.SortStrings(q.cols) == list.SortStrings(u.memo.key) {q}]) != 1 {
			"unit \(un) memo on \(u.memo.entity) has no unique over exactly (\(strings.Join(u.memo.key, ", "))): the natural key an answer resolves against"
		}],
		[for un, u in A.capabilities.vendored if u.memo != _|_ if A.state.entities[u.memo.entity] != _|_
		let mc = A.state.entities[u.memo.entity]
		for f in mc.fields if !f.pk if !f.retired if f.type != "string" {
			"unit \(un) memo on \(u.memo.entity): column \(f.name) is \(f.type), and an answer crosses the seat as strings"
		}],
	])
	_unitRefusal: [if len(_unitViolations) == 0 {true}, _unitViolations[0]][0] & true

	_effects: [if A.state.effects != _|_ {A.state.effects}, {}][0]
	_signals: [if A.state.signals != _|_ {A.state.signals}, {}][0]
	_signalViolations: [
		for n, sg in _signals
		let m = [if A.state.mecha.rows[sg.machine] != _|_ {A.state.mecha.rows[sg.machine]}, {}][0]
		let ent = [for en, e in A.state.entities if m.entity != _|_ if en == m.entity || e.table == m.entity {e}]
		let taking = [if m.states != _|_ for _, st in m.states if st.on != _|_ if st.on[sg.event] != _|_ {st.on[sg.event]}]
		if len(taking) == 0 ||
			len([for t in taking if (t & string) == _|_ {t}]) > 0 ||
			len([for e in ent for f in e.fields if f.name == sg.count {f}]) == 0 ||
			len([for e in ent for f in e.fields if f.pk != _|_ if f.pk {f}]) != 1 {
			"signal \(n): one machine's event, a plain target in every state that takes it, over a row with one primary key and the declared count field"
		},
		// A read's count is its interpreter's alone, which refuses the signal's
		// own increment of it.
		for n, sg in _signals if A.state.mecha.rows[sg.machine] != _|_
		let m = A.state.mecha.rows[sg.machine]
		if m.states != _|_ for _, st in m.states if st.on != _|_ if st.on[sg.event] != _|_
		let to = st.on[sg.event]
		if (to & string) != _|_ if m.states[to] != _|_ if m.states[to].invoke != _|_
		let src = m.states[to].invoke.src
		if _reads[src] != _|_ if _reads[src].count == sg.count {
			"signal \(n) counts in \(sg.count), where the read \(src) counts its entries and only its machine writes: give the signal a count field of its own"
		},
	]
	_signalRefusal: [if len(_signalViolations) == 0 {true}, _signalViolations[0]][0] & true
	// A destination names only its source's parameters, and two rewrites one
	// request matches would leave the answer to their order.
	_rewrites:        [if A.state.rewrites != _|_ {A.state.rewrites}, {}][0]
	_rewriteSegments: {for n, r in _rewrites {(n): strings.Split(r.source, "/")}}
	// The parameters a rewrite's `has` gives its destination: the letters
	// of a key that states no value, where it has any, and the groups a
	// value's expression names, which the expression itself tells: made
	// optional it matches nothing, and names every group it has.
	_rewriteHas: {for n, r in _rewrites {
		(n): [if r.has != _|_ for h in r.has for p in [
			if h.value == _|_ if h.key =~ "[A-Za-z]" {regexp.ReplaceAll("[^A-Za-z]", h.key, "")},
			if h.value != _|_ for g, _ in regexp.FindNamedSubmatch("(?:\(h.value))?", "") {g},
		] {p}]
	}}
	_rewriteViolations: [
		for n, r in _rewrites
		for t in regexp.FindAll("::|[A-Za-z0-9_]+::?[A-Za-z0-9_]*|:[A-Za-z][A-Za-z0-9_]*|[A-Za-z0-9_]+|[^:A-Za-z0-9_]+|:", r.destination, -1)
		if t =~ "^:[A-Za-z]" if !strings.Contains(r.source + "/", "/" + t + "/") if !list.Contains(_rewriteHas[n], strings.TrimPrefix(t, ":")) {
			"rewrite \(n): the destination names \(t), where the source and `has` give \(strings.Join(list.Concat([[for p in regexp.FindAll("(:[a-z][A-Za-z0-9_]*|$)", r.source, -1) if p != "" {p}], [for p in _rewriteHas[n] {":" + p}], [if !strings.Contains(r.source, ":") if len(_rewriteHas[n]) == 0 {"no parameter"}]]), ", "))"
		},
		// Next.js lets a name given twice be the later's, `has` after the
		// source: a key's letters make that easy to do unseen (`page1` and
		// `page2` are both `:page`), so here each name is given once.
		for n, r in _rewrites for p in _rewriteHas[n] if strings.Contains(r.source + "/", "/:" + p + "/") {
			"rewrite \(n): `has` and the source both give :\(p), where Next.js would have the one of `has` replace the source's: name one of them by a group of its value, (?<name>…)"
		},
		for n, r in _rewrites for i, p in _rewriteHas[n] if list.Contains(list.Drop(_rewriteHas[n], i + 1), p) if !list.Contains(list.Take(_rewriteHas[n], i), p) {
			"rewrite \(n): `has` gives :\(p) twice, where Next.js would have the later replace the earlier: name one of them by a group of its value, (?<name>…)"
		},
		// The door reads a key's one value, so one item states all of it.
		for n, r in _rewrites if r.has != _|_ for i, h in r.has if list.Contains([for o in list.Drop(r.has, i + 1) {o.key}], h.key) if !list.Contains([for o in list.Take(r.has, i) {o.key}], h.key) {
			"rewrite \(n): two `has` items name the key \(h.key), and one item states all a key's value meets"
		},
		// Go's expression takes a name declared twice, and the door gives
		// the parameter the last of them, empty where that one took no part
		// in the match. The expression tells its names and not how often
		// each is declared, and a group is declared in no other spelling
		// than these, so one written twice is refused, declared twice or not.
		for n, r in _rewrites if r.has != _|_ for h in r.has if h.value != _|_
		for g, _ in regexp.FindNamedSubmatch("(?:\(h.value))?", "") if len(regexp.FindAll("\\(\\?P?<\(g)>", h.value, -1)) > 1 {
			"rewrite \(n): a `has` value declares the group \(g) more than once, and each group name is declared once: the door would give the parameter of the one that took no part, empty"
		},
		// A group's name is a parameter's, as the destination writes one.
		for n, r in _rewrites for p in _rewriteHas[n] if p !~ "^[A-Za-z][A-Za-z0-9_]*$" {
			"rewrite \(n): a `has` value names the group \(p), and a parameter is a letter, then letters, digits and _"
		},
		// The door tries a rewrite before its own routes, so a parameter in
		// the first segment would answer /health and the shell's files.
		for n, _ in _rewrites if strings.HasPrefix(_rewriteSegments[n][1], ":") {
			"rewrite \(n): the source begins with a parameter, and its first segment is a word"
		},
		// PostgREST reads the query of a function's POST as filters on what
		// it returns, never as its arguments, and the door calls a function
		// by POST for a PUT, PATCH or DELETE too; no `methods` is every one.
		for n, r in _rewrites if r.destination =~ "^/crud/rpc/[^?]*\\?"
		if len([if r.methods == _|_ {""}, if r.methods != _|_ for m in r.methods if m != "GET" if m != "HEAD" {m}]) > 0 {
			"rewrite \(n): a function's destination has a query, which is its arguments under GET and HEAD alone, so its methods name no other; under any other the function reads the path and query from X-Forwarded-Uri"
		},
		// PostgREST takes the last of an argument its query names twice,
		// so a function's destination names each key once, written as
		// PostgREST reads it: an escape would hide one named twice.
		for n, r in _rewrites if r.destination =~ "^/crud/rpc/[^?]*\\?."
		let keys = [for pair in strings.Split(strings.SplitN(r.destination, "?", 2)[1], "&") {strings.SplitN(pair, "=", 2)[0]}]
		for i, k in keys if strings.Contains(k, "%") || (list.Contains(list.Drop(keys, i + 1), k) && !list.Contains(list.Take(keys, i), k)) {
			[
				if strings.Contains(k, "%") {"rewrite \(n): a function's destination writes the key \(k) with an escape, and a key is written as PostgREST reads it, so that one named twice is seen"},
				"rewrite \(n): a function's destination names \(k) twice, and PostgREST takes the last, so the one before it is never the argument",
			][0]
		},
		// What PostgREST makes of a function's query it decides pair by
		// pair, by the key and by how the value opens, so a parameter a
		// function's destination places is the whole value of a key
		// PostgREST reads as an argument's name: the door holds what the
		// parameter is (emit.cue's _rewriteOperand), and nothing written
		// around it. The keys are PostgREST's own (`reserved` and
		// `reservedEmbeddable` in its QueryParams.hs, at the version
		// cluster.cue pins) and any that is more than a name, which it reads
		// as a path. rewrites.integration.test.ts holds this to PostgREST.
		for n, r in _rewrites if r.destination =~ "^/crud/rpc/[^?]*\\?."
		for pair in strings.Split(strings.SplitN(r.destination, "?", 2)[1], "&") if pair =~ ":[A-Za-z]"
		let placed = [for t in regexp.FindAll("::|[A-Za-z0-9_]+::?[A-Za-z0-9_]*|:[A-Za-z][A-Za-z0-9_]*|[A-Za-z0-9_]+|[^:A-Za-z0-9_]+|:", pair, -1) if t =~ "^:[A-Za-z]" {t}]
		if len(placed) > 0
		let kv = strings.SplitN(pair, "=", 2)
		if len(kv) != 2 || kv[len(kv)-1] != placed[0] {
			"rewrite \(n): a function's destination places \(placed[0]) within \(pair), and a parameter is the whole value of its argument: beside other text PostgREST may read it as a filter on what the function returns"
		},
		for n, r in _rewrites if r.destination =~ "^/crud/rpc/[^?]*\\?."
		for pair in strings.Split(strings.SplitN(r.destination, "?", 2)[1], "&") if pair =~ ":[A-Za-z]"
		let placed = [for t in regexp.FindAll("::|[A-Za-z0-9_]+::?[A-Za-z0-9_]*|:[A-Za-z][A-Za-z0-9_]*|[A-Za-z0-9_]+|[^:A-Za-z0-9_]+|:", pair, -1) if t =~ "^:[A-Za-z]" {t}]
		if len(placed) > 0
		let kv = strings.SplitN(pair, "=", 2)
		if len(kv) == 2 if kv[1] == placed[0] if kv[0] !~ "^[A-Za-z_][A-Za-z0-9_]*$" || kv[0] =~ "^(select|columns|on_conflict|order|limit|offset|and|or)$" {
			"rewrite \(n): a function's destination places \(placed[0]) under \(kv[0]), which PostgREST does not read as an argument's name: a name is letters, digits and _, and none of select, columns, on_conflict, order, limit, offset, and, or"
		},
		for n, r in _rewrites if strings.Contains(r.source, ":")
		let ps = regexp.FindAll(":[a-z][A-Za-z0-9_]*", r.source, -1)
		if len(ps) != len({for p in ps {(p): true}}) {
			"rewrite \(n): the source names a parameter twice"
		},
		for n, r in _rewrites
		for m, o in _rewrites if m < n
		let rs = _rewriteSegments[n]
		let os = _rewriteSegments[m]
		// One request matches both where every segment is the same word, or
		// a parameter in either.
		if len(rs) == len(os) if len([for i, s in rs if s != os[i] if !strings.HasPrefix(s, ":") if !strings.HasPrefix(os[i], ":") {s}]) == 0
		let rm = [if r.methods != _|_ {r.methods}, []][0]
		let om = [if o.methods != _|_ {o.methods}, []][0]
		if len(rm) == 0 || len(om) == 0 || len([for x in rm if list.Contains(om, x) {x}]) > 0 {
			"rewrites \(m) and \(n): both answer \(strings.Join([for i, s in rs {[if !strings.HasPrefix(s, ":") {s}, if !strings.HasPrefix(os[i], ":") {os[i]}, ":"][0]}], "/"))"
		},
	]
	_rewriteRefusal: [if len(_rewriteViolations) == 0 {true}, _rewriteViolations[0]][0] & true
	// A group grant is read against one membership list, and a role, a group's
	// `of` and a membership's columns each name a field that exists.
	_groupLists: [for n, e in A.state.entities if e.access != _|_ if e.access.scope == "group" {n}]
	// Whose keys a group's name is read over: the entity's own, the entity a
	// reference names, or the column's where it references nothing.
	_groupOver: [for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.groups != _|_ for g in e.access.groups {
		group:  g.group
		entity: n
		over:   [if g.of == _|_ {e.table}, for f in e.fields if g.of != _|_ if f.name == g.of if f.ref != _|_ {f.ref}, "\(e.table).\(g.of)"][0]
	}]
	_groupViolations: [
		// A membership names a group as "<key>:<name>" and no entity, so one
		// name over two entities' keys would let a member of one read the other.
		for a in _groupOver for b in _groupOver if a.group == b.group if a.over < b.over {
			"group \(a.group): named over \(a.over) by \(a.entity) and over \(b.over) by \(b.entity), and a group's name is one entity's"
		},
		if len(_groupLists) > 1 {
			"entities \(strings.Join(_groupLists, ", ")): one entity is the membership list, scope \"group\""
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "group"
		for c in [e.access.group, e.access.user] if len([for f in e.fields if f.name == c {f}]) == 0 {
			"entity \(n): the membership list names \(c), which is no field of it"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.groups != _|_ if len(_groupLists) == 0 {
			"entity \(n): shared with a group, and no entity is the membership list, scope \"group\""
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.groups != _|_
		for g in e.access.groups if g.of != _|_ if len([for f in e.fields if f.name == g.of {f}]) == 0 {
			"entity \(n): group \(g.group) is of \(g.of), which is no field of it"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ if e.access.shared.role != _|_
		if len([for _, v in A.state.entities if v.table == e.access.shared.via for f in v.fields if f.name == e.access.shared.role {f}]) == 0 {
			"entity \(n): the grant table \(e.access.shared.via) has no field \(e.access.shared.role) to hold a role"
		},
		// The policy compares the role with a name, and a membership's group
		// with "<key>:<name>".
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ if e.access.shared.role != _|_
		for _, v in A.state.entities if v.table == e.access.shared.via for f in v.fields if f.name == e.access.shared.role if f.type != "string" {
			"entity \(n): the grant table \(e.access.shared.via) holds a role in \(f.name), which is a string and not \(f.type)"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "group"
		for f in e.fields if f.name == e.access.group if f.type != "string" {
			"entity \(n): the membership list names a group in \(f.name), which is a string and not \(f.type)"
		},
		// A group is one column of the row, so an entity names it once.
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.groups != _|_
		for i, g in e.access.groups for j, h in e.access.groups if i < j if g.group == h.group {
			"entity \(n): group \(g.group) is named twice, and a group holds one role on a row"
		},
	]
	// A grant table that names groups is read against the membership list, and
	// a grant row fills its user or its group, so neither column is required.
	_grantViolations: [
		// The grant table is the entity's own composition, or its policies are
		// another's: a grant anyone may write is the row anyone may read.
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_
		if len([for _, v in A.state.entities if v.table == e.access.shared.via if v.access != _|_ if v.access.scope == "folder" if v.access.parent == n if v.access.on == e.access.shared.on {v}]) == 0 {
			"entity \(n): its grant table \(e.access.shared.via) is an entity with access {scope: \"folder\", parent: \"\(n)\", on: \"\(e.access.shared.on)\"}"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_
		for m, x in A.state.entities if n < m if x.access != _|_ if x.access.scope == "private" if x.access.shared != _|_ if x.access.shared.via == e.access.shared.via {
			"entities \(n), \(m): one grant table, \(e.access.shared.via), shares one entity's rows"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_
		for _, v in A.state.entities if v.table == e.access.shared.via
		if len([for f in v.fields if f.name == e.access.shared.user {f}]) == 0 {
			"entity \(n): the grant table \(e.access.shared.via) has no field \(e.access.shared.user) to name a user"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ if e.access.shared.role != _|_
		for _, v in A.state.entities if v.table == e.access.shared.via for f in v.fields if f.name == e.access.shared.role if !f.required {
			"entity \(n): a grant in \(e.access.shared.via) holds a role, so \(f.name) is required"
		},
		// The policies, the triggers and the sync path address a shared row by
		// `id`, and name a group over the row's own key by the key's text.
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ || e.access.groups != _|_
		for f in e.fields if f.pk if f.name != "id" {
			"entity \(n): shared, and its key is \(f.name): a shared entity's key is id"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.groups != _|_
		for g in e.access.groups if g.of == _|_ for f in e.fields if f.pk if f.type != "uuid" if f.type != "string" {
			"entity \(n): group \(g.group) is named over its key, a \(f.type): a uuid or a string, whose text the cluster and the terminal spell alike"
		},
		// A row is filed under a group by a reference, so who may file it there
		// is who reads the row it names.
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.groups != _|_
		for g in e.access.groups if g.of != _|_ for f in e.fields if f.name == g.of
		if len([for _, x in A.state.entities if f.ref != _|_ if x.table == f.ref if x.access != _|_ if x.access.scope == "private" || x.access.scope == "public" {x}]) == 0 {
			"entity \(n): group \(g.group) is of \(g.of), which references no private or public entity"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ if e.access.shared.group != _|_ if len(_groupLists) == 0 {
			"entity \(n): its grant table names groups, and no entity is the membership list, scope \"group\""
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ if e.access.shared.group != _|_
		if len([for _, v in A.state.entities if v.table == e.access.shared.via for f in v.fields if f.name == e.access.shared.group {f}]) == 0 {
			"entity \(n): the grant table \(e.access.shared.via) has no field \(e.access.shared.group) to name a group"
		},
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_ if e.access.shared.group != _|_
		for _, v in A.state.entities if v.table == e.access.shared.via for f in v.fields if f.name == e.access.shared.group || f.name == e.access.shared.user if f.required {
			"entity \(n): a grant in \(e.access.shared.via) names a user or a group, so \(f.name) is required: false"
		},
	]
	// A row handed to another owner leaves the previous one a grant, which the
	// cluster writes from the row alone: its key, the grantee and the role.
	_handoverViolations: [
		if len(_groupViolations)+len(_grantViolations) == 0
		for n, e in A.state.entities if e.access != _|_ if e.access.scope == "private" if e.access.shared != _|_
		for _, v in A.state.entities if v.table == e.access.shared.via for f in v.fields
		if f.required if !f.retired if f.default == _|_ if f.generated == _|_ if !(f.pk && f.type == "uuid")
		if !list.Contains([e.access.shared.on, e.access.shared.user, if e.access.shared.role != _|_ {e.access.shared.role}], f.name) {
			"entity \(n): a row handed to another owner grants the previous one in \(e.access.shared.via), which cannot fill \(f.name): give it a default"
		},
	]
	_handoverRefusal: [if len(_handoverViolations) == 0 {true}, _handoverViolations[0]][0] & true
	_groupRefusal:    [if len(_groupViolations) == 0 {true}, _groupViolations[0]][0] & true
	_grantRefusal:    [if len(_grantViolations) == 0 {true}, _grantViolations[0]][0] & true
	_invokes: [
		if A.state.mecha.rows != _|_
		for mName, m in A.state.mecha.rows
		if m.states != _|_
		for sName, st in m.states
		if st.invoke != _|_ {
			machine: mName
			state:   sName
			entity:  m.entity
			src:     st.invoke.src
			others:  st.on != _|_ || st.after != _|_
			final:   [if st.type != _|_ {st.type == "final"}, false][0]
			states:  [for n, _ in m.states {n}]
			fallbacks: [for tr in [st.invoke.onDone, st.invoke.onError] {
				let choices = [if (tr & string) != _|_ {[{target: tr}]}, if (tr & [...]) != _|_ {tr}, [tr]][0]
				guarded: choices[len(choices)-1].guard != _|_
			}]
			arrows: [for tr in [st.invoke.onDone, st.invoke.onError]
			for t in [if (tr & string) != _|_ {[{target: tr}]}, if (tr & [...]) != _|_ {tr}, [tr]][0] {
				target:  t.target
				actions: [if t.actions != _|_ {[if (t.actions & [...]) != _|_ {t.actions}, [t.actions]][0]}, []][0]
			}]

		},
	]
	// The entities, by name, of the machines invoking each effect, keyed by
	// the effect: one is the effect's own, the row its NEW reads and its key
	// fields come from; none or several is refused below. An effect states no
	// entity of its own.
	_effectEntities:    {for i in _invokes for en, e in A.state.entities if en == i.entity || e.table == i.entity {(i.src): (en): true}}
	_effectEntityNames: {for n, s in _effectEntities {(n): [for en, _ in s {en}]}}
	// By key: an effect refused below is bottom as a value, not undeclared.
	_effectNames: [for n, _ in _effects {n}]
	// An invoking state is left only by its outcome, so an outcome that cannot
	// be delivered leaves the row there for good: the interpreter would refuse the
	// move, and the airlock would retry the sink until its attempts ran out.
	_invokeViolations: list.Concat([
		[for i in _invokes if !list.Contains(_effectNames, i.src) {
			"machine \(i.machine) state \(i.state) invokes undeclared effect: \(i.src)"
		}],
		[for i in _invokes if i.others {
			"machine \(i.machine) state \(i.state) invokes \(i.src) and declares on or after: only the effect's outcome leaves it"
		}],
		[for n, _ in _effects if len([for i in _invokes if i.src == n {i}]) == 0 {
			"effect \(n) is invoked by no state: its entity is its invoking machine's, so it has none"
		}],
		[for n, ens in _effectEntityNames if len(ens) > 1 {
			"effect \(n) is invoked by machines of \(len(ens)) entities (\(strings.Join(ens, ", "))): its NEW reads and its key need one row"
		}],
		[for n, _ in _effects let c = len([for i in _invokes if i.src == n {i}]) if c > 1 {
			"effect \(n) is invoked by \(c) states: exactly one invokes it, so its ledger key names one instance of one state"
		}],
		[for n, ens in _effectEntityNames if _effects[n] != _|_ for en in ens if !A.state.entities[en].server {
			"effect \(n) is of \(en), whose rows do not live in the cluster: an effect fired from every tab would be performed by every tab"
		}],
		[for n, ens in _effectEntityNames if _effects[n] != _|_ if _effects[n].request == _|_ for en in ens for k in _effects[n].key if !list.Contains([for f in A.state.entities[en].fields {f.name}], k) {
			"effect \(n) keys on \(k), which is not a field of \(en)"
		}],
		[for i in _invokes if i.final {
			"machine \(i.machine) state \(i.state) invokes \(i.src) and is final: no outcome could leave it"
		}],
		[for i in _invokes for fb in i.fallbacks if fb.guarded {
			"machine \(i.machine) state \(i.state): each outcome requires an unguarded fallback"
		}],
		[for i in _invokes for ar in i.arrows if !list.Contains(i.states, ar.target) {
			"machine \(i.machine) state \(i.state) invokes \(i.src) with an outcome target that is no state: \(ar.target)"
		}],
		[for i in _invokes for ar in i.arrows if ar.target == i.state {
			"machine \(i.machine) state \(i.state) invokes \(i.src) with an outcome targeting itself: the row would never leave"
		}],

		[for i in _invokes for ar in i.arrows for a in ar.actions if a.reject != _|_ {
			"machine \(i.machine) state \(i.state): an outcome's actions reject, which would refuse the recorded outcome's delivery"
		}],
		[for i in _invokes let m = A.state.mecha.rows[i.machine]
		for actions in list.Concat([
			[if m.states[i.state].exit != _|_ {m.states[i.state].exit}],
			[for ar in i.arrows if m.states[ar.target] != _|_ if m.states[ar.target].entry != _|_ {m.states[ar.target].entry}],
		]) for a in [if (actions & [...]) != _|_ {actions}, [actions]][0] if a.reject != _|_ {
			"machine \(i.machine) state \(i.state): an outcome's entry or exit actions reject, which would refuse the recorded outcome's delivery"
		}],
		[for n, ens in _effectEntityNames if _effects[n] != _|_ for en in ens for k, v in _effects[n].input if (v & string) != _|_ if strings.HasPrefix(v, "NEW.") || strings.HasPrefix(v, "OLD.") if !list.Contains([for f in A.state.entities[en].fields {f.name}], strings.SplitN(v, ".", 2)[1]) {
			"effect \(n) input \(k) reads \(v), which is not a field of \(en)"
		}],
		// The credential is the airlock's alone: a handler handed it could put
		// it in a body the ledger keeps.
		[for n, x in _effects if x.sink.credential != _|_ if list.Contains(x._envSecrets, x.sink.credential.secret) {
			"effect \(n) lists its credential's \(x.sink.credential.secret) among the handler's secrets"
		}],
		// The names an effect's cluster keeps for the wake: the ticker's
		// schedule table, its row named airlock, and the wake's own table.
		[if len(_effects) > 0 for en, e in A.state.entities if e.table == "schedule" || e.table == "airlock_wake" {
			"entity \(en) takes table \(e.table), which the airlock's wake keeps"
		}],
		[if len(_effects) > 0 if A.state.schedules != _|_ for sn, _ in A.state.schedules if sn == "airlock" {
			"schedule airlock is the airlock's own wake"
		}],
	])
	_invokeRefusal: [if len(_invokeViolations) == 0 {true}, _invokeViolations[0]][0] & true

	// A read: an effect that is a GET (#ExternalEffect.request), invoked by a
	// state; its input read from the row, which keeps it until the answer
	// lands, and its count the interpreter's.
	_reads: {for n, x in _effects if x.request != _|_ {(n): x}}
	_readVars: {for n, x in _reads {
		(n): [if regexp.Match("[{]", x.request.path) for e in regexp.FindAll("[{][^}]*[}]", x.request.path, -1) for v in strings.Split(strings.Trim(e, "{}?&"), ",") {v}]
	}}
	_readViolations: list.Concat([
		[for n, x in _reads if x.request.body != _|_ {
			"effect \(n) is a GET, which carries no body (RFC 9110 §9.3.1): what it sends is its path and query"
		}],
		[for n, x in _reads
		for w, there in {
			key:         x.key != _|_
			idempotent:  x.sink.idempotent != _|_
			reentry:     x.reentry != _|_
			note:        x.note != _|_
			attempts:    x.attempts != _|_
			secrets:     x.secrets != _|_
			endowments:  x.endowments != _|_
			contentType: x.sink.contentType != _|_
		} if there {
			"effect \(n) is a read and declares \(w): a GET is safe (RFC 9110 §9.2.1), so nothing claims it, and it has no handler and sends no body"
		}],
		[for n, x in _reads
		for b in list.Concat([[if x.sink.bridge != _|_ {x.sink.bridge}], [if x.sink.targets != _|_ for _, at in x.sink.targets if at.bridge != _|_ {at.bridge}]])
		if _declaredBridges[b] != _|_ if _declaredBridges[b].action != _|_ {
			"effect \(n) is a GET on bridge \(b), whose Activepieces action answers only what is posted to it"
		}],
		[for n, x in _reads if x.sink.ai != _|_ {
			"effect \(n) is a GET on the AI gateway, which answers only what is posted to it"
		}],
		[for n, _ in _reads if A.capabilities.auth == _|_ {
			"effect \(n) is a read, and the app declares no auth: a read spends its sink's credential, so only a signed-in writer asks one"
		}],
		[for n, x in _reads if list.Contains(A.meta.targets, "cloudflare") {
			"effect \(n) is a read, which the edge's airlock does not perform: name another target"
		}],
		[for n, x in _reads for v in _readVars[n] if x.input[v] == _|_ {
			"effect \(n)'s path names \(v), which its input does not"
		}],
		[for n, x in _reads for k, _ in x.input if !list.Contains(_readVars[n], k) {
			"effect \(n)'s input \(k) is sent nowhere: its path names it in no expression"
		}],
		[for n, x in _reads for k, v in x.input if (v & string) == _|_ && (v & number) == _|_ && (v & bool) == _|_ && (v & {raw: string}) == _|_ {
			"effect \(n)'s input \(k) is no string, number or boolean, which is all a path or a query carries"
		}],
		[for n, x in _reads if x.cacheControl != _|_ if regexp.Match("(^|, ?)private(,|=|$)", x.cacheControl) {
			"effect \(n) declares its answers private, and the airlock's cache is shared by every row's read (RFC 9111 §5.2.2.7)"
		}],
		[for n, x in _reads for i in _invokes if i.src == n
		for k, v in x.input if (v & string) != _|_ if strings.HasPrefix(v, "OLD.") || v == "NEW.\(A.state.mecha.rows[i.machine].field)" || v == "NEW.\(x.count)" || v == "NEW.\(x.incarnation)" {
			"effect \(n)'s input \(k) reads \(v): a read reads the row it enters its state with, which keeps those fields until the answer lands, and its state and count fields are the interpreter's"
		}],
		[for n, ens in _effectEntityNames if _reads[n] != _|_ for en in ens
		if len([for f in A.state.entities[en].fields if f.name == _reads[n].count if f.type == "int32" || f.type == "int" {f}]) == 0 {
			"effect \(n) counts its entries in \(_reads[n].count), which is no int32 field of \(en)"
		}],
		[for n, ens in _effectEntityNames if _reads[n] != _|_ for en in ens
		if len([for f in A.state.entities[en].fields if f.name == _reads[n].incarnation if f.type == "uuid" if f.generated == _|_ if f.pk == _|_ || !f.pk {f}]) == 0 {
			"effect \(n) names its row's incarnation \(_reads[n].incarnation), which is no uuid field of \(en) that is neither generated nor a primary key"
		}],
		// Each machine's interpreter refuses any other writer's change to a
		// count, another machine's increments among them.
		[for n, x in _reads for n2, x2 in _reads if n < n2 if x.count == x2.count
		for i in _invokes if i.src == n for i2 in _invokes if i2.src == n2 if i.machine != i2.machine
		if A.state.mecha.rows[i.machine].entity == A.state.mecha.rows[i2.machine].entity {
			"effects \(n) and \(n2) count their entries in \(x.count), and two machines invoke them: each machine counts in a field of its own"
		}],
		// Each machine's interpreter sets an incarnation at the insert, so a
		// second would replace the one the first enqueued with.
		[for n, x in _reads for n2, x2 in _reads if n < n2 if x.incarnation == x2.incarnation
		for i in _invokes if i.src == n for i2 in _invokes if i2.src == n2 if i.machine != i2.machine
		if A.state.mecha.rows[i.machine].entity == A.state.mecha.rows[i2.machine].entity {
			"effects \(n) and \(n2) name their row's incarnation in \(x.incarnation), and two machines invoke them: each machine names it in a field of its own"
		}],
		[for n, x in _reads if x.incarnation == x.count {
			"effect \(n) names \(x.count) both its count and its incarnation"
		}],
		[for n, ens in _effectEntityNames if _reads[n] != _|_ for en in ens
		for f in A.state.entities[en].fields if f.name == _reads[n].count if f.generated != _|_ {
			"effect \(n) counts its entries in \(f.name), which is generated: PostgreSQL computes it after the interpreter, which writes the count"
		}],
		[for n, ens in _effectEntityNames if _reads[n] != _|_ for en in ens for i in _invokes if i.src == n
		if _reads[n].count == A.state.mecha.rows[i.machine].field || len([for f in A.state.entities[en].fields if f.name == _reads[n].count if f.pk != _|_ if f.pk {f}]) > 0 {
			"effect \(n) counts its entries in \(_reads[n].count), which is its machine's state field or a primary key"
		}],
	])
	_readRefusal: [if len(_readViolations) == 0 {true}, _readViolations[0]][0] & true
	// A secret field (#Field.secret) is opened only while the effect naming
	// it runs. So no client keeps a copy of its row, nothing the database
	// derives, checks, indexes or seeds reads it, and an effect reaches it
	// through `secrets` alone: an input is frozen into the ledger, and a key is
	// the sink's idempotency key.
	_secretFields: [for en, e in A.state.entities for f in e.fields if f.secret != _|_ {entity: en, field: f}]
	_secretReads:  {for s in _secretFields {(s.entity): (s.field.name): "\\b(NEW|OLD)\\.\"?\(s.field.name)\"?(\\b|$)"}}
	_secretViolations: list.Concat([
		// The seal binds the value to the row it was typed for, by its key.
		[for s in _secretFields let e = A.state.entities[s.entity] if len([for f in e.fields if f.pk {f}]) != 1 {
			"entity \(s.entity) field \(s.field.name) is secret, and \(s.entity) has no one-field primary key to seal it to"
		}],
		[for s in _secretFields let e = A.state.entities[s.entity] if e.durability != "server" {
			"entity \(s.entity) field \(s.field.name) is secret, and \(s.entity) is \(e.durability): only a server entity's rows stay out of every client's copy"
		}],
		[for s in _secretFields for k in ["cel", "generated", "default", "ref", "unique"] if s.field[k] != _|_ {
			"entity \(s.entity) field \(s.field.name) is secret, and states \(k): the column is always NULL, so nothing derives, checks or relates its value"
		}],
		[for s in _secretFields let e = A.state.entities[s.entity] if e.invariant != _|_
		for x in [e.invariant.cel, if e.invariant.check != _|_ {e.invariant.check}] if x =~ "\\b\(s.field.name)\\b" {
			"entity \(s.entity): its invariant reads the secret field \(s.field.name)"
		}],
		[for s in _secretFields let e = A.state.entities[s.entity] for g in e.fields if g.generated != _|_ if g.generated =~ "\\b\(s.field.name)\\b" {
			"entity \(s.entity) field \(g.name) is generated from the secret field \(s.field.name)"
		}],
		[for s in _secretFields let e = A.state.entities[s.entity] if e.indexes != _|_ for ix in e.indexes if ix.on =~ "\\b\(s.field.name)\\b" {
			"entity \(s.entity) indexes the secret field \(s.field.name)"
		}],
		[for s in _secretFields let e = A.state.entities[s.entity] for u in e.uniques if list.Contains(u.cols, s.field.name) {
			"entity \(s.entity) unique \(u.name) names the secret field \(s.field.name)"
		}],
		[for s in _secretFields let e = A.state.entities[s.entity] for r in e.seed if r[s.field.name] != _|_ {
			"entity \(s.entity) seeds the secret field \(s.field.name)"
		}],
		[for n, ens in _effectEntityNames if _effects[n] != _|_ for en in ens if _secretReads[en] != _|_ for f, read in _secretReads[en]
		for k, v in _effects[n].input
		let sql = [if (v & string) != _|_ {v}, if (v & {raw: string}) != _|_ {v.raw}, ""][0] if sql =~ read {
			"effect \(n) input \(k) reads the secret field \(f): an input is frozen into the ledger, so the effect names it in secrets"
		}],
		[for n, ens in _effectEntityNames if _effects[n] != _|_ for en in ens if _secretReads[en] != _|_ for f, _ in _secretReads[en] if _effects[n].key != _|_ if list.Contains(_effects[n].key, f) {
			"effect \(n) keys on the secret field \(f): a key is the sink's idempotency key and the ledger's"
		}],
		[for n, x in _effects for f in x._fieldSecrets if _effectEntityNames[n] != _|_ for en in _effectEntityNames[n]
		if len([for g in A.state.entities[en].fields if g.name == f if g.secret != _|_ {g}]) == 0 {
			"effect \(n) names {field: \"\(f)\"} in secrets, which is no secret field of \(en): a field that is no secret belongs in its input"
		}],
		[for s in _secretFields if len([for n, x in _effects if _effectEntityNames[n] != _|_ if list.Contains(_effectEntityNames[n], s.entity) if list.Contains(x._fieldSecrets, s.field.name) {n}]) == 0 {
			"entity \(s.entity) field \(s.field.name) is secret, and no effect names it in secrets: nothing would ever read it"
		}],
	])
	_secretRefusal: [if len(_secretViolations) == 0 {true}, _secretViolations[0]][0] & true

	// Field behaviour (#Field.outputOnly, #Field.immutable, AIP-203). A key is
	// the name a client creates its row by, a generated or retired field is
	// written by nobody already, and output-only already admits no client
	// write, immutable or not. A form is a client's write: it names no
	// output-only field, and an update form no immutable one.
	_behaviorFields: [for en, e in A.state.entities for f in e.fields
		for b in ["outputOnly", "immutable"] if f[b] != _|_ if f[b] {entity: en, field: f, behavior: b}]
	_behaviorViolations: list.Concat([
		[for s in _behaviorFields for k in ["pk", "retired"] if s.field[k] {
			"entity \(s.entity) field \(s.field.name) is \(s.behavior), and is \([if k == "pk" {"a primary key: a client names the key it creates its row by"}, "retired: nothing writes it"][0])"
		}],
		[for s in _behaviorFields if s.field.generated != _|_ {
			"entity \(s.entity) field \(s.field.name) is \(s.behavior), and is generated: PostgreSQL computes it, and nobody writes it"
		}],
		[for s in _behaviorFields if s.behavior == "outputOnly" if s.field.immutable != _|_ if s.field.immutable {
			"entity \(s.entity) field \(s.field.name) is outputOnly and immutable: a field no client writes has no change of a client's to refuse"
		}],
		[for sn, s in A.surface.screens for fm in s.forms for en, e in A.state.entities if en == fm.entity || e.table == fm.entity
		for ff in fm.fields for f in e.fields if f.name == ff.name if f.outputOnly != _|_ if f.outputOnly {
			"screen \(sn) form \(fm.id) writes \(en).\(f.name), which is outputOnly: the server sets it, and clears a value a client sends"
		}],
		[for sn, s in A.surface.screens for fm in s.forms if fm.action == "update" for en, e in A.state.entities if en == fm.entity || e.table == fm.entity
		for ff in fm.fields for f in e.fields if f.name == ff.name if f.immutable != _|_ if f.immutable {
			"screen \(sn) form \(fm.id) updates \(en).\(f.name), which is immutable: it is set when the row is created and never changed"
		}],
	])
	_behaviorRefusal: [if len(_behaviorViolations) == 0 {true}, _behaviorViolations[0]][0] & true

	_declaredBridges: [if A.state.bridges != _|_ {A.state.bridges}, {}][0]
	_bridgeViolations: list.Concat([
		[for n, b in _declaredBridges if b.isolate == _|_ if A.capabilities.hatches[b.container] == _|_ {
			"bridge \(n) names undeclared container hatch: \(b.container)"
		}],
		[for n, b in _declaredBridges if b.isolate != _|_ if A.capabilities.hatches[b.isolate] == _|_ {
			"bridge \(n) names undeclared isolate hatch: \(b.isolate)"
		}],
		[for n, b in _declaredBridges if b.isolate == _|_ if A.capabilities.hatches[b.container] != _|_ if A.capabilities.hatches[b.container].kind != "container" {
			"bridge \(n) names hatch \(b.container), which is not a container"
		}],
		[for n, b in _declaredBridges if b.isolate != _|_ if b.appliance != _|_ {
			"bridge \(n) states an appliance form, which pronto derives for an isolate"
		}],
		[for n, b in _declaredBridges if b.isolate != _|_ if A.capabilities.hatches[b.isolate] != _|_ if A.capabilities.hatches[b.isolate].kind != "isolate" {
			"bridge \(n) names hatch \(b.isolate) by isolate, which is not an isolate"
		}],
		// The local stack bundles an isolate under .isolate/, beside the sources.
		[for hn, h in A.capabilities.hatches if h.kind == "isolate" for f in h.files if strings.HasPrefix(f, ".isolate/") {
			"isolate hatch \(hn)'s \(f) is under .isolate/, where the local stack writes its bundle"
		}],
		[for hn, h in A.capabilities.hatches if h.kind == "isolate" if !list.Contains(h.files, h.entrypoint) {
			"isolate hatch \(hn)'s entrypoint \(h.entrypoint) is not one of its files"
		}],
		// The bundle, its WebAssembly shims and their WebAssembly land in one
		// directory, where a shim is found by its name.
		[for hn, h in A.capabilities.hatches if h.kind == "isolate"
		let names = [for f in h.files if strings.HasSuffix(f, ".wasm") || strings.HasSuffix(f, ".wasm.js") {path.Base(f, path.Unix)}]
		for i, n in names if list.Contains(list.Drop(names, i + 1), n) {
			"isolate hatch \(hn) has two files named \(n): its WebAssembly and shims share one directory beside the bundle"
		}],
		[for n, b in _declaredBridges if A.capabilities.hatches[b.container] != _|_ if A.capabilities.hatches[b.container].activepieces != _|_ if b.port != 8080 {
			"bridge \(n) must use the Activepieces port 8080"
		}],
		[for hn, h in A.capabilities.hatches if h.activepieces != _|_ for an, action in h.activepieces.actions for target in A.meta.targets if target == "pages" || target == "cloudflare" if action.mail == _|_ {
			"Activepieces action \(hn).\(an) has no \(target) implementation"
		}],
		[for hn, h in A.capabilities.hatches if h.activepieces != _|_ for an, action in h.activepieces.actions if action.mail != _|_ if list.Contains(A.meta.targets, "pages") if action.mail.pages == _|_ {
			"mail action \(hn).\(an) requires EmailJS publicKey, serviceId and templateId for pages"
		}],
		[for hn, h in A.capabilities.hatches if h.activepieces != _|_ for an, action in h.activepieces.actions if action.mail != _|_ if list.Contains(A.meta.targets, "cloudflare") if !A.meta.cloudflare.workersPaid if action.mail.cloudflare == _|_ {
			"mail action \(hn).\(an) requires meta.cloudflare.workersPaid or explicit Cloudflare recipients"
		}],
		[for n, b in _declaredBridges if A.capabilities.hatches[b.container] != _|_ if A.capabilities.hatches[b.container].activepieces != _|_ if b.action == _|_ {
			"bridge \(n) needs an Activepieces action"
		}],
		// An Activepieces mail action on cloudflare lowers to Email Routing
		// (bundle/edge-effects.ts), so a container there would be built and
		// never called.
		[for n, b in _declaredBridges if A.capabilities.hatches[b.container] != _|_ if A.capabilities.hatches[b.container].activepieces != _|_ if list.Contains(b.targets, "cloudflare") {
			"bridge \(n) names cloudflare, where its Activepieces action runs without a container"
		}],
		[for n, b in _declaredBridges if A.capabilities.hatches[b.container] != _|_ if A.capabilities.hatches[b.container].activepieces == _|_ if b.action != _|_ {
			"bridge \(n) selects an action on a non-Activepieces hatch"
		}],
		[for n, b in _declaredBridges if A.capabilities.hatches[b.container] != _|_ if A.capabilities.hatches[b.container].activepieces != _|_ if b.action != _|_ if A.capabilities.hatches[b.container].activepieces.actions[b.action] == _|_ {
			"bridge \(n) needs an opted-in action"
		}],
		[for n, x in _effects
		let reached = list.Concat([[if x.sink.bridge != _|_ {x.sink.bridge}], [if x.sink.targets != _|_ for _, at in x.sink.targets if at.bridge != _|_ {at.bridge}]])
		for b in reached if _declaredBridges[b] == _|_ {
			"effect \(n) reaches undeclared bridge: \(b)"
		}],
		// The airlock settles a bridge not deployed by the effect's own bridge
		// (effects.json); one reached only through k8s's entry would be dialed
		// there and never answer.
		[for n, x in _effects if x.sink.targets != _|_ if x.sink.targets.k8s != _|_ if x.sink.targets.k8s.bridge != _|_
		let b = x.sink.targets.k8s.bridge
		if _declaredBridges[b] != _|_ if !list.Contains(_declaredBridges[b].targets, "k8s") if [if x.sink.bridge != _|_ {x.sink.bridge}, ""][0] != b {
			"effect \(n) reaches bridge \(b) on k8s, which \(b) does not name in its targets"
		}],
		[for n, x in _effects
		let defaults = len([if x.sink.origin != _|_ {1}]) + len([if x.sink.bridge != _|_ {1}]) + len([if x.sink.ai != _|_ {1}])
		if defaults > 1 {
			"effect \(n) names more than one of origin, bridge and ai as its default sink"
		}],
		[for n, x in _effects if x.sink.targets != _|_ for t, at in x.sink.targets
		if len([if at.origin != _|_ {1}])+len([if at.bridge != _|_ {1}]) != 1 {
			"effect \(n) names one of origin and bridge for target \(t)"
		}],
		[for n, x in _effects if x.sink.origin == _|_ if x.sink.bridge != _|_ || x.sink.ai != _|_ if x.sink.credential != _|_ || x.sink.contentType != _|_ {
			"effect \(n) declares a credential or content type for a sink that is no origin"
		}],
		[for n, x in _effects for t in list.Concat([["docker"], [for t in A.meta.targets if t != "docker" && t != "pages" {t}]])
		if (#SinkAt & {sink: x.sink, target: t}).out == null {
			"effect \(n) names no sink for target \(t)"
		}],
		[for n, x in _effects for t in list.Concat([["docker"], [for t in A.meta.targets if t != "docker" && t != "pages" && t != "cloudflare" {t}]])
		let at = (#SinkAt & {sink: x.sink, target: t}).out
		if at != null if at.origin != _|_ if at.origin.secret != _|_ {
			"effect \(n) names its origin by the secret \(at.origin.secret), which only cloudflare reads: give target \(t) an origin or a bridge"
		}],
		[for b, _ in _declaredBridges if len(list.Concat([[for _, x in _effects if x.sink.bridge != _|_ if x.sink.bridge == b {x}], [for _, x in _effects if x.sink.targets != _|_ for _, at in x.sink.targets if at.bridge != _|_ if at.bridge == b {x}]])) == 0 {
			"bridge \(b) is reached by no effect"
		}],
		// Past a bridge nothing is the platform's to promise, and a bridge
		// answers no query by key, so a bridged effect states what a repeat
		// costs rather than claiming idempotence or a reconciliation.
		[for n, x in _effects if x.request == _|_ if x.sink.bridge != _|_ if x.sink.idempotent {
			"effect \(n) reaches bridge \(x.sink.bridge) as an idempotent sink: past a bridge nothing is the platform's to promise"
		}],
		[for n, x in _effects if x.request == _|_ if x.sink.bridge != _|_ if !x.sink.idempotent if x.reentry == "reconcile" {
			"effect \(n) reaches bridge \(x.sink.bridge) and reconciles: a bridge answers no query, so state reentry unknown or repeat"
		}],
	])
	_bridgeRefusal: [if len(_bridgeViolations) == 0 {true}, _bridgeViolations[0]][0] & true

	_aiViolations: list.Concat([
		[for n, x in _effects if x.sink.ai != _|_ if A.capabilities.ai == _|_ {
			"effect \(n) reaches AI modality \(x.sink.ai) without capabilities.ai declared"
		}],
		[for n, x in _effects if x.sink.ai != _|_ if A.capabilities.ai != _|_
		let tiers = [if x.sink.ai == "text" && A.capabilities.ai.text != _|_ {A.capabilities.ai.text}, if x.sink.ai == "image" && A.capabilities.ai.image != _|_ {A.capabilities.ai.image}, []][0]
		if !list.Contains(tiers, x.sink.tier) {
			"effect \(n) reaches AI \(x.sink.ai) tier \(x.sink.tier), which is not declared in capabilities.ai.\(x.sink.ai)"
		}],
	])
	_aiRefusal: [if len(_aiViolations) == 0 {true}, _aiViolations[0]][0] & true

	_declaredStreams: [for dsName, _ in [if A.state.duckstreams != _|_ {A.state.duckstreams}, {}][0] {dsName}]
	_undeclaredStreams: [
		for ma in _machineActions
		for act in ma.actions
		for eff in [if act.raise != _|_ {[if (act.raise & [...]) != _|_ {act.raise}, [act.raise]][0]}, []][0]
		if (eff & #StreamRaise) != _|_
		if !list.Contains(_declaredStreams, eff.stream) {
			machine: ma.machine
			stream:  eff.stream
		},
	]
	_streamRefusal: [if len(_undeclaredStreams) == 0 {true}, "machine \(_undeclaredStreams[0].machine) references undeclared duckstream: \(_undeclaredStreams[0].stream)"][0] & true

	_deleteActions: [
		if A.state.mecha.rows != _|_
		for mName, m in A.state.mecha.rows {
			machine: mName
			actions: list.Concat([
				[if m.on != _|_ if m.on.delete != _|_ for act in [if (m.on.delete & [...]) != _|_ {m.on.delete}, [m.on.delete]][0] {act}],
				[
					if m.states != _|_
					for _, st in m.states
					if st.on != _|_ if st.on.delete != _|_
					for tr in [if (st.on.delete & string) != _|_ {[]}, if (st.on.delete & [...]) != _|_ {st.on.delete}, [st.on.delete]][0]
					if tr.actions != _|_
					for a in [if (tr.actions & [...]) != _|_ {tr.actions}, [tr.actions]][0] {a}
				],
			])
		}
	]

	_deleteNewViolations: [
		for da in _deleteActions
		for act in da.actions
		if strings.Contains(json.Marshal(act), "NEW.") {
			machine: da.machine
			action:  json.Marshal(act)
		}
	]
	_deleteNewRefusal: [if len(_deleteNewViolations) == 0 {true}, "machine \(_deleteNewViolations[0].machine) references NEW in delete action: \(_deleteNewViolations[0].action)"][0] & true

	_favicon: #faviconPlan & {
		if A.meta.favicon != _|_ {raw: A.meta.favicon}
	}
	_faviconValidRefusal:    [if len(_favicon._errors) == 0 {true}, _favicon._errors[0]][0] & true
	_faviconSvgRefusal:      [if _favicon._svgCount <= 1 {true}, "at most one SVG markup or emoji favicon may be declared"][0] & true
	_faviconConflictRefusal: [if _favicon._svgCount == 0 || _favicon._pathConflict == 0 {true}, "cannot declare an emoji or SVG favicon alongside shell/favicon.svg"][0] & true

	_envelope: #envelopePlan & {
		meta:         A.meta
		surface:      A.surface
		state:        A.state
		capabilities: A.capabilities
	}
	_envelopeRefusal: [if len(_envelope._errors) == 0 {true}, _envelope._errors[0]][0] & true
}

#faviconMime: {
	".svg":  "image/svg+xml"
	".png":  "image/png"
	".ico":  "image/x-icon"
	".webp": "image/webp"
	".jpg":  "image/jpeg"
	".jpeg": "image/jpeg"
}

#faviconPlan: {
	let F = self
	raw?: _
	_rawItems: [
		if F.raw != _|_ {
			if (F.raw & [...]) != _|_ {F.raw}
			if (F.raw & [...]) == _|_ {[F.raw]}
		},
		[],
	][0]

	items: [
		for it in _rawItems {
			let isStr = (it & string) != _|_
			let rawHref = [
				if isStr {it},
				if !isStr && it.href != _|_ {it.href},
				"",
			][0]

			let isSvgMarkup = isStr && strings.HasPrefix(rawHref, "<svg")
			let isDataUri = strings.HasPrefix(rawHref, "data:")
			let isHttp = strings.HasPrefix(rawHref, "http://") || strings.HasPrefix(rawHref, "https://") || strings.HasPrefix(rawHref, "//")
			let hasDotDot = strings.Contains(rawHref, "..")

			let ext = [for e, _ in #faviconMime if strings.HasSuffix(rawHref, e) {e}, ""][0]
			let hasValidExt = ext != ""

			let isEmojiText = !strings.HasPrefix(rawHref, "<svg") && !isDataUri && !isHttp && !strings.Contains(rawHref, "/") && !strings.Contains(rawHref, ".") && len(strings.Runes(rawHref)) <= 8 && !regexp.Match("^[a-zA-Z0-9_-]+$", rawHref)
			let isEmoji = isStr && isEmojiText

			let rawRel = [
				if !isStr if it.rel != _|_ {it.rel},
				"icon",
			][0]

			let rawType = [
				if !isStr if it.type != _|_ {it.type},
				"",
			][0]

			let isAppleTouch = rawRel == "apple-touch-icon"
			let isAppleTouchUnusable = ext == ".svg" || ext == ".webp" || ext == ".ico" || isSvgMarkup || isEmoji || strings.HasPrefix(rawHref, "data:image/svg") || strings.HasPrefix(rawHref, "data:image/webp") || strings.HasPrefix(rawHref, "data:image/x-icon")
			let isAppleTouchUsable = !isAppleTouchUnusable && (ext == ".png" || ext == ".jpg" || ext == ".jpeg" || strings.HasPrefix(rawHref, "data:image/png") || strings.HasPrefix(rawHref, "data:image/jpeg") || ((ext == "" || isHttp) && (rawType == "image/png" || rawType == "image/jpeg")))
			let isAppleTouchInvalid = isAppleTouch && !isAppleTouchUsable

			let isStructuredInvalid = !isStr && (strings.HasPrefix(rawHref, "<svg") || isEmojiText)
			let isValid = !hasDotDot && !isStructuredInvalid && !isAppleTouchInvalid && (isSvgMarkup || isDataUri || isHttp || isEmoji || hasValidExt)

			let isPath = !isSvgMarkup && !isDataUri && !isHttp && !isEmoji

			let itemErr = [
				if hasDotDot {"favicon path may not contain '..': '\(rawHref)'"},
				if isStructuredInvalid {"structured favicon href must be a file path, data URI, or URL, not raw SVG markup or emoji: '\(rawHref)'"},
				if isAppleTouchInvalid {"apple-touch-icon format not supported on Safari on iOS; must be PNG or JPEG: '\(rawHref)'"},
				if !isValid {"unsupported favicon format or missing extension: '\(rawHref)' (supported: .ico, .png, .svg, .webp, .jpg, .jpeg, emoji, SVG markup, data:, https://)"},
				"",
			][0]

			let clean = strings.TrimPrefix(strings.TrimPrefix(rawHref, "./"), "/")
			let inShell = strings.HasPrefix(clean, "shell/")

			let itemHref = [
				if isSvgMarkup || isEmoji {"./favicon.svg"},
				if isDataUri || isHttp {rawHref},
				if inShell {"./" + strings.TrimPrefix(clean, "shell/")},
				if !inShell {"/" + clean},
				rawHref,
			][0]

			let inferredType = [
				if isSvgMarkup || isEmoji || strings.HasPrefix(rawHref, "data:image/svg+xml") {"image/svg+xml"},
				if hasValidExt {#faviconMime[ext]},
				if strings.HasPrefix(rawHref, "data:image/x-icon") {"image/x-icon"},
				if strings.HasPrefix(rawHref, "data:image/png") {"image/png"},
				if strings.HasPrefix(rawHref, "data:image/webp") {"image/webp"},
				if strings.HasPrefix(rawHref, "data:image/jpeg") {"image/jpeg"},
				"",
			][0]

			let itemType = [
				if rawType != "" {rawType},
				if inferredType != "" {inferredType},
				"",
			][0]

			let itemRel = rawRel

			let itemSizes = [
				if !isStr && it.sizes != _|_ {it.sizes},
				"",
			][0]

			let escapedText = strings.Replace(strings.Replace(rawHref, "&", "&amp;", -1), "<", "&lt;", -1)
			let itemSvg = [
				if isSvgMarkup {rawHref},
				if isEmoji {"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><text y=\".9em\" font-size=\"90\">\(escapedText)</text></svg>\n"},
				"",
			][0]

			let staticFile = [
				if isSvgMarkup || isEmoji {"shell/favicon.svg"},
				if isPath && isValid {clean},
				"",
			][0]

			let staticTarget = [
				if staticFile != "" {"/srv/\(staticFile)"},
				"",
			][0]

			let itemRelEsc = strings.Replace(strings.Replace(itemRel, "&", "&amp;", -1), "\"", "&quot;", -1)
			let itemTypeEsc = strings.Replace(strings.Replace(itemType, "&", "&amp;", -1), "\"", "&quot;", -1)
			let itemSizesEsc = strings.Replace(strings.Replace(itemSizes, "&", "&amp;", -1), "\"", "&quot;", -1)
			let itemHrefEsc = strings.Replace(strings.Replace(itemHref, "&", "&amp;", -1), "\"", "&quot;", -1)

			valid:   isValid
			err:     itemErr
			rel:     itemRel
			href:    itemHref
			type:    itemType
			sizes:   itemSizes
			svgText: itemSvg
			file:    staticFile
			target:  staticTarget
			tag:     "<link rel=\"\(itemRelEsc)\"" + [if itemType != "" {" type=\"\(itemTypeEsc)\""}, ""][0] + [if itemSizes != "" {" sizes=\"\(itemSizesEsc)\""}, ""][0] + " href=\"\(itemHrefEsc)\">"
		}
	]

	_explicitAppleTouch: [for x in items if x.valid if x.rel == "apple-touch-icon" {x}]
	_pngOrJpegFavicons: [
		for x in items
		if x.valid
		if x.rel != "apple-touch-icon"
		if !strings.HasSuffix(x.href, ".svg") && !strings.HasSuffix(x.href, ".webp") && !strings.HasSuffix(x.href, ".ico")
		if x.type == "image/png" || x.type == "image/jpeg" || strings.HasSuffix(x.href, ".png") || strings.HasSuffix(x.href, ".jpg") || strings.HasSuffix(x.href, ".jpeg") || strings.HasPrefix(x.href, "data:image/png") || strings.HasPrefix(x.href, "data:image/jpeg") {x}
	]
	_touchSizedFavicons: [
		for x in _pngOrJpegFavicons
		if strings.Contains(x.sizes, "180") || strings.Contains(x.sizes, "192") || strings.Contains(x.sizes, "512") {x}
	]
	_bestAppleTouch: [
		if len(_touchSizedFavicons) > 0 {_touchSizedFavicons[0]},
		if len(_pngOrJpegFavicons) > 0 {_pngOrJpegFavicons[0]},
		null,
	][0]
	_autoAppleTouchTag: [
		if len(_explicitAppleTouch) == 0 && _bestAppleTouch != null {
			let escHref = strings.Replace(strings.Replace(_bestAppleTouch.href, "&", "&amp;", -1), "\"", "&quot;", -1)
			"<link rel=\"apple-touch-icon\" href=\"\(escHref)\">"
		},
		"",
	][0]

	_svgItems:     [for x in items if x.svgText != "" {x}]
	_svgCount:     len(_svgItems)
	_pathConflict: len([for x in items if x.svgText == "" && x.file == "shell/favicon.svg" {x}])
	_errors:       [for x in items if !x.valid {x.err}]

	svgFile: [if _svgCount == 1 {_svgItems[0].svgText}, ""][0]
	links: strings.Join(list.Concat([
		[for x in items if x.valid {x.tag}],
		[if _autoAppleTouchTag != "" {_autoAppleTouchTag}],
	]), "\n")

	_staticMap: {
		for x in items if x.valid && x.target != "" {
			(x.target): {
				file:   x.file
				target: x.target
				watch:  true
			}
		}
	}
	statics: [for _, s in _staticMap {s}]
}

#hintsPlan: {
	let H = self
	preconnect:  *[] | _
	dnsPrefetch: *[] | _

	_preconnectList:  [if (H.preconnect & [...]) != _|_ {H.preconnect}, [H.preconnect]][0]
	_dnsPrefetchList: [if (H.dnsPrefetch & [...]) != _|_ {H.dnsPrefetch}, [H.dnsPrefetch]][0]

	_preconnectItems: [
		for p in _preconnectList if p != _|_ {
			let isStr = (p & string) != _|_
			let hasHref = (p & {href: string}) != _|_
			let isCross = [if !isStr for k, v in p if k == "crossorigin" if v == true {true}, false][0]
			let rawHref = [if isStr {p}, if hasHref {p.href}, ""][0]
			let isValid = (strings.HasPrefix(rawHref, "https://") || strings.HasPrefix(rawHref, "http://") || strings.HasPrefix(rawHref, "//")) && !strings.Contains(rawHref, "..") && !strings.Contains(rawHref, " ") && !strings.Contains(rawHref, "\t") && !strings.Contains(rawHref, "\n")
			let err = [if !isValid {"preconnect href must begin with https://, http://, or // and contain no whitespace: '\(rawHref)'"}, ""][0]
			let escHref = strings.Replace(strings.Replace(rawHref, "&", "&amp;", -1), "\"", "&quot;", -1)
			let itemTag = "<link rel=\"preconnect\" href=\"\(escHref)\"" + [if isCross {" crossorigin"}, ""][0] + ">"
			valid: isValid
			href:  rawHref
			error: err
			tag:   itemTag
		}
	]

	_dnsPrefetchItems: [
		for d in _dnsPrefetchList if d != _|_ {
			let rawHref = d
			let isValid = (strings.HasPrefix(rawHref, "https://") || strings.HasPrefix(rawHref, "http://") || strings.HasPrefix(rawHref, "//")) && !strings.Contains(rawHref, "..") && !strings.Contains(rawHref, " ") && !strings.Contains(rawHref, "\t") && !strings.Contains(rawHref, "\n")
			let err = [if !isValid {"dns-prefetch href must begin with https://, http://, or // and contain no whitespace: '\(rawHref)'"}, ""][0]
			let escHref = strings.Replace(strings.Replace(rawHref, "&", "&amp;", -1), "\"", "&quot;", -1)
			let itemTag = "<link rel=\"dns-prefetch\" href=\"\(escHref)\">"
			valid: isValid
			href:  rawHref
			error: err
			tag:   itemTag
		}
	]

	_errors: [
		for x in _preconnectItems if !x.valid {x.error},
		for x in _dnsPrefetchItems if !x.valid {x.error},
	]

	tags: list.Concat([
		[for x in _dnsPrefetchItems if x.valid {x.tag}],
		[for x in _preconnectItems if x.valid {x.tag}],
	])
	links: strings.Join(tags, "\n")
}

#manifestPlan: {
	let M = self
	raw?:          _
	meta:          _
	favicon:       #faviconPlan
	screens?:      _
	design?:       _
	capabilities?: _

	_isAuthRequired: [
		if M.capabilities != _|_ if M.capabilities.auth != _|_ if M.capabilities.auth.required == true {true},
		false,
	][0]

	_enabled: [if M.raw != _|_ {(M.raw & null) == _|_ && (M.raw & false) == _|_}, false][0]
	_isObj:   _enabled && (M.raw & bool) == _|_ && (M.raw & {}) != _|_

	_hasIcons: [if _isObj if M.raw.icons != _|_ {true}, false][0]
	_rawIcons: [if _hasIcons {M.raw.icons}, []][0]

	_derivedIcons: [
		if _hasIcons {
			[
				for ic in _rawIcons {
					let s = ic.src
					let isSvg = strings.HasSuffix(s, ".svg") || (ic.type != _|_ && ic.type == "image/svg+xml")
					src: [
						if strings.HasPrefix(s, "./shell/") {"/shell/" + strings.TrimPrefix(s, "./shell/")},
						if strings.HasPrefix(s, "shell/") {"/shell/" + strings.TrimPrefix(s, "shell/")},
						if strings.HasPrefix(s, "./") {"/" + strings.TrimPrefix(s, "./")},
						if strings.HasPrefix(s, "//") || strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "data:") {s},
						if strings.HasPrefix(s, "/") {s},
						"/" + s,
					][0]
					if ic.type != _|_ {type: ic.type}
					if ic.sizes != _|_ {sizes: ic.sizes}
					if (ic.sizes == _|_) && isSvg {sizes: "any"}
					if ic.purpose != _|_ {purpose: ic.purpose}
				}
			]
		},
		[
			for it in M.favicon.items if it.valid if it.href != "" if !strings.HasPrefix(it.href, "data:") {
				let isRemote = strings.HasPrefix(it.href, "https://") || strings.HasPrefix(it.href, "http://") || strings.HasPrefix(it.href, "//")
				src: [
					if isRemote {it.href},
					if strings.HasPrefix(it.href, "./") {"/shell/" + strings.TrimPrefix(it.href, "./")},
					if strings.HasPrefix(it.href, "/") {it.href},
					"/shell/" + it.href,
				][0]
				if it.type != "" {type: it.type}
				if it.sizes != "" {sizes: it.sizes}
				if it.sizes == "" && it.type == "image/svg+xml" {sizes: "any"}
			}
		],
	][0]

	_hasShortcuts: [if _isObj if M.raw.shortcuts != _|_ {true}, false][0]
	_rawShortcuts: [if _hasShortcuts {M.raw.shortcuts}, []][0]

	_staticScreens: [
		if M.screens != _|_ if !_isAuthRequired
		for sName, s in M.screens
		if s.route != _|_ if s.route != "/" && !strings.Contains(s.route, ":") {
			name: [if s.title != _|_ {s.title}, sName][0]
			url:  s.route
		}
	]

	_derivedShortcuts: [
		if _hasShortcuts {_rawShortcuts},
		[for idx, sc in _staticScreens if idx < 4 {sc}],
	][0]

	_hasTheme: [if _isObj if M.raw.theme_color != _|_ {true}, false][0]
	_hasBg:    [if _isObj if M.raw.background_color != _|_ {true}, false][0]

	_designLightColor: [
		if M.design != _|_ if M.design.colors != _|_ if M.design.colors.surface != _|_ {strings.ToLower(M.design.colors.surface)},
		"",
	][0]
	_bgColor: [if _hasBg {M.raw.background_color}, if _designLightColor != "" {_designLightColor}, "#ffffff"][0]
	_designDarkColor: [
		if M.design != _|_ if M.design.dark != _|_ if M.design.dark.surface != _|_ {strings.ToLower(M.design.dark.surface)},
		"",
	][0]

	_explicitTheme: [
		if _hasTheme {M.raw.theme_color},
		if M.meta.themeColor != _|_ {M.meta.themeColor},
		"",
	][0]

	_themeColor: [
		if _explicitTheme != "" {_explicitTheme},
		if _enabled {_designLightColor},
		"",
	][0]

	_manifestData: {
		name:             [if _isObj if M.raw.name != _|_ {M.raw.name}, M.meta.name][0]
		short_name:       [if _isObj if M.raw.short_name != _|_ {M.raw.short_name}, [if _isObj if M.raw.name != _|_ {M.raw.name}, M.meta.name][0]][0]
		description:      [if _isObj if M.raw.description != _|_ {M.raw.description}, M.meta.description][0]
		start_url:        [if _isObj if M.raw.start_url != _|_ {M.raw.start_url}, "/"][0]
		scope:            [if _isObj if M.raw.scope != _|_ {M.raw.scope}, "/"][0]
		display:          [if _isObj if M.raw.display != _|_ {M.raw.display}, "standalone"][0]
		background_color: _bgColor
		theme_color:      _themeColor
		if len(_derivedIcons) > 0 {icons: _derivedIcons}
		if len(_derivedShortcuts) > 0 {shortcuts: _derivedShortcuts}
		if _isObj if M.raw.orientation != _|_ {orientation: M.raw.orientation}
		if _isObj if M.raw.dir != _|_ {dir: M.raw.dir}
		if _isObj if M.raw.lang != _|_ {lang: M.raw.lang}
		if _isObj {
			for k, v in M.raw if !list.Contains(["name", "short_name", "description", "start_url", "display", "background_color", "theme_color", "icons", "shortcuts", "scope", "orientation", "dir", "lang"], k) {
				(k): v
			}
		}
	}

	_iconErrors: [
		for ic in _rawIcons
		if ic.src != _|_
		if strings.Contains(ic.src, "..") {"manifest icon src may not contain '..': '\(ic.src)'"}
	]

	_errors: _iconErrors

	enabled:  _enabled && len(_errors) == 0
	data:     _manifestData
	jsonText: [if enabled {json.Marshal(_manifestData) + "\n"}, ""][0]

	_appNameEsc:    strings.Replace(strings.Replace(_manifestData.short_name, "&", "&amp;", -1), "\"", "&quot;", -1)
	_themeColorEsc: strings.Replace(strings.Replace(_themeColor, "&", "&amp;", -1), "\"", "&quot;", -1)
	_darkColorEsc:  strings.Replace(strings.Replace(_designDarkColor, "&", "&amp;", -1), "\"", "&quot;", -1)

	_themeTags: [
		if _explicitTheme != "" {
			["<meta name=\"theme-color\" content=\"\(_themeColorEsc)\">"]
		},
		if _explicitTheme == "" && _enabled {
			if _designDarkColor != "" && _designDarkColor != _designLightColor {
				[
					"<meta name=\"theme-color\" media=\"(prefers-color-scheme: light)\" content=\"\(_themeColorEsc)\">",
					"<meta name=\"theme-color\" media=\"(prefers-color-scheme: dark)\" content=\"\(_darkColorEsc)\">",
				]
			}
			if _designDarkColor == "" || _designDarkColor == _designLightColor {
				["<meta name=\"theme-color\" content=\"\(_themeColorEsc)\">"]
			}
		},
		[],
	][0]

	tags: list.Concat([
		[if enabled {"<link rel=\"manifest\" href=\"/manifest.webmanifest\">"}],
		_themeTags,
		[
			if enabled {"<meta name=\"mobile-web-app-capable\" content=\"yes\">"},
			if enabled {"<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">"},
			if enabled {"<meta name=\"apple-mobile-web-app-title\" content=\"\(_appNameEsc)\">"},
		],
	])
	links: strings.Join(tags, "\n")

	statics: [
		if enabled
		for ic in _derivedIcons
		let s = ic.src
		if !strings.HasPrefix(s, "data:") && !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") && !strings.HasPrefix(s, "//") && !strings.Contains(s, "..") {
			let clean = strings.TrimPrefix(s, "/")
			file:   clean
			target: "/srv/" + clean
			watch:  true
		}
	]
}

#socialPlan: {
	let S = self
	raw?: _
	meta: _

	_enabled: [if S.raw != _|_ {(S.raw & null) == _|_}, false][0]
	_isObj:   [if _enabled {(S.raw & bool) == _|_ && (S.raw & {}) != _|_}, false][0]

	_title: [if _isObj if S.raw.title != _|_ {S.raw.title}, S.meta.name][0]
	_desc:  [if _isObj if S.raw.description != _|_ {S.raw.description}, S.meta.description][0]
	_type:  [if _isObj if S.raw.type != _|_ {S.raw.type}, "website"][0]
	_card:  [if _isObj if S.raw.card != _|_ {S.raw.card}, if _hasImage {"summary_large_image"}, "summary"][0]

	_hasImage:           [if _isObj if S.raw.image != _|_ {true}, false][0]
	_rawImage:           [if _hasImage {S.raw.image}, ""][0]
	_hasDotDot:          strings.Contains(_rawImage, "..")
	_isProtocolRelative: strings.HasPrefix(_rawImage, "//")
	_isHttp:             strings.HasPrefix(_rawImage, "http://") || strings.HasPrefix(_rawImage, "https://")
	_isData:             strings.HasPrefix(_rawImage, "data:")

	_cleanImage: strings.TrimPrefix(strings.TrimPrefix(_rawImage, "./"), "/")

	_imageUrl: [
		if !_hasImage {""},
		if _isHttp {_rawImage},
		"/" + _cleanImage,
	][0]

	_errors: [
		if _hasDotDot {"social image path may not contain '..': '\(_rawImage)'"},
		if _isProtocolRelative {
			"social.image must not be protocol-relative ('\(_rawImage)'); OpenGraph and Twitter cards require explicit https:// or http://"
		},
		if _isData {
			"social.image must not be a data URI ('\(_rawImage)'); OpenGraph and Twitter cards require explicit https:// or http://"
		},
	]

	_titleEsc: strings.Replace(strings.Replace(_title, "&", "&amp;", -1), "\"", "&quot;", -1)
	_descEsc:  strings.Replace(strings.Replace(_desc, "&", "&amp;", -1), "\"", "&quot;", -1)
	_typeEsc:  strings.Replace(strings.Replace(_type, "&", "&amp;", -1), "\"", "&quot;", -1)
	_cardEsc:  strings.Replace(strings.Replace(_card, "&", "&amp;", -1), "\"", "&quot;", -1)
	_imgEsc:   strings.Replace(strings.Replace(_imageUrl, "&", "&amp;", -1), "\"", "&quot;", -1)

	tags: [
		if _enabled {"<meta property=\"og:type\" content=\"\(_typeEsc)\">"},
		if _enabled {"<meta property=\"og:title\" content=\"\(_titleEsc)\">"},
		if _enabled {"<meta property=\"og:description\" content=\"\(_descEsc)\">"},
		if _hasImage && _imageUrl != "" {"<meta property=\"og:image\" content=\"\(_imgEsc)\">"},
		if _isObj if S.raw.imageAlt != _|_ if _hasImage && _imageUrl != "" {
			let altEsc = strings.Replace(strings.Replace(S.raw.imageAlt, "&", "&amp;", -1), "\"", "&quot;", -1)
			"<meta property=\"og:image:alt\" content=\"\(altEsc)\">"
		},
		if _enabled {"<meta name=\"twitter:card\" content=\"\(_cardEsc)\">"},
		if _enabled {"<meta name=\"twitter:title\" content=\"\(_titleEsc)\">"},
		if _enabled {"<meta name=\"twitter:description\" content=\"\(_descEsc)\">"},
		if _hasImage && _imageUrl != "" {"<meta name=\"twitter:image\" content=\"\(_imgEsc)\">"},
		if _isObj if S.raw.site != _|_ {
			let sEsc = strings.Replace(strings.Replace(S.raw.site, "&", "&amp;", -1), "\"", "&quot;", -1)
			"<meta name=\"twitter:site\" content=\"\(sEsc)\">"
		},
		if _isObj if S.raw.creator != _|_ {
			let cEsc = strings.Replace(strings.Replace(S.raw.creator, "&", "&amp;", -1), "\"", "&quot;", -1)
			"<meta name=\"twitter:creator\" content=\"\(cEsc)\">"
		},
	]
	links: strings.Join(tags, "\n")

	static: [
		if _enabled && _hasImage && !_isHttp && !_hasDotDot && !_isProtocolRelative && !_isData {
			file:   _cleanImage
			target: "/srv/\(_cleanImage)"
			watch:  true
		},
	]
}

#llmsPlan: {
	let L = self
	raw?:          _
	meta?:         _
	surface?:      _
	state?:        _
	capabilities?: _

	_enabled: [if L.raw != _|_ {(L.raw & null) == _|_ && (L.raw & false) == _|_}, false][0]
	_isObj:   [if _enabled {(L.raw & bool) == _|_ && (L.raw & {}) != _|_}, false][0]

	_hasText:     [if _isObj if L.raw.text != _|_ {true}, false][0]
	_hasFullText: [if _isObj if L.raw.fullText != _|_ {true}, false][0]
	_hasFile:     [if _isObj if L.raw.file != _|_ {true}, false][0]
	_hasFullFile: [if _isObj if L.raw.fullFile != _|_ {true}, false][0]

	_rawFile:     [if _hasFile {L.raw.file}, ""][0]
	_rawFullFile: [if _hasFullFile {L.raw.fullFile}, ""][0]

	_isRawBool:  [if L.raw != _|_ {(L.raw & bool) != _|_}, false][0]
	_synthBrief: [if _isRawBool {L.raw == true}, false][0]
	_synthFull:  [if _isRawBool {L.raw == true}, false][0]

	_isAuthRequired: [
		if L.capabilities != _|_ if L.capabilities.auth != _|_ if L.capabilities.auth.required == true {true},
		false,
	][0]

	_appName: [if L.meta != _|_ if L.meta.name != _|_ {L.meta.name}, "App"][0]
	_appDesc: [if L.meta != _|_ if L.meta.description != _|_ {L.meta.description}, ""][0]

	_authSummary: [
		if _isAuthRequired {
			"Authentication is required to access protected routes."
		},
		"Publicly accessible web application.",
	][0]

	_screenSummaries: [
		if L.surface != _|_ if L.surface.screens != _|_
		for sName, s in L.surface.screens
		if s.route != _|_ if !strings.Contains(s.route, ":") {
			let title = [if s.title != _|_ {s.title}, sName][0]
			let route = s.route
			"- [\(title)](\(route)): \(sName) screen"
		}
	]

	_publicEntityNames: [
		if L.state != _|_ if L.state.entities != _|_
		for eName, ent in L.state.entities
		let entAccess = [for k, v in ent if k == "access" {v}, {scope: ""}][0]
		if entAccess.scope == "public" {
			eName
		}
	]

	_entitySummaries: [
		for eName in _publicEntityNames {
			"- `\(eName)`: domain entity"
		}
	]

	_synthBriefText: strings.Join(list.Concat([
		[
			"# \(_appName)",
			"",
			if _appDesc != "" {"> \(_appDesc)\n"},
			"## Overview",
			_authSummary,
			"",
			"## Screens",
		],
		[if len(_screenSummaries) > 0 {strings.Join(_screenSummaries, "\n")}, "None declared."][0:1],
		[
			"",
			"## Data Models",
		],
		[if len(_entitySummaries) > 0 {strings.Join(_entitySummaries, "\n")}, "None declared."][0:1],
		[""],
	]), "\n")

	_tableToEntity: {
		if L.state != _|_ if L.state.entities != _|_
		for eName, ent in L.state.entities {
			(ent.table): eName
		}
	}

	_screenDetails: [
		if L.surface != _|_ if L.surface.screens != _|_
		for sName, s in L.surface.screens
		if s.route != _|_ if !strings.Contains(s.route, ":") {
			let title = [if s.title != _|_ {s.title}, sName][0]
			let route = s.route
			let publicReadsMap = {
				if s.reads != _|_
				for r in s.reads
				if _tableToEntity[r.table] != _|_
				let eName = _tableToEntity[r.table]
				if list.Contains(_publicEntityNames, eName) {
					(eName): true
				}
			}
			let publicReads = [for eName, _ in publicReadsMap {eName}]
			let reads = [if len(publicReads) > 0 {strings.Join(publicReads, ", ")}, "none"][0]
			"""
				### Screen: \(title)
				- Route: `\(route)`
				- Reads: \(reads)
				"""
		}
	]

	_entityDetails: [
		if L.state != _|_ if L.state.entities != _|_
		for eName in _publicEntityNames {
			let ent = L.state.entities[eName]
			let fields = [
				if ent.fields != _|_
				for f in ent.fields
				let fRetired = [for k, v in f if k == "retired" {v}, false][0]
				if fRetired == false {
					let fName = [if f.name != _|_ {f.name}, "field"][0]
					let fType = [if f.type != _|_ {f.type}, "string"][0]
					"  - `\(fName)` (\(fType))"
				}
			]
			let fieldsStr = [if len(fields) > 0 {strings.Join(fields, "\n")}, "  - (no fields)"][0]
			"""
				### Entity: \(eName)
				Fields:
				\(fieldsStr)
				"""
		}
	]

	_synthFullText: strings.Join(list.Concat([
		[
			"# \(_appName) - Full Specification",
			"",
			if _appDesc != "" {"> \(_appDesc)\n"},
			"## Architecture",
			_authSummary,
			"",
			"## Screens Specification",
		],
		[if len(_screenDetails) > 0 {strings.Join(_screenDetails, "\n\n")}, "None declared."][0:1],
		[
			"",
			"## Data Models Schema",
		],
		[if len(_entityDetails) > 0 {strings.Join(_entityDetails, "\n\n")}, "None declared."][0:1],
		[""],
	]), "\n")

	_errors: [
		if _hasText && _hasFile {
			"llms cannot declare both text and file"
		},
		if _hasFullText && _hasFullFile {
			"llms cannot declare both fullText and fullFile"
		},
		if _hasFile && (strings.Contains(_rawFile, "..") || strings.HasPrefix(_rawFile, "/")) {
			"llms file may not contain '..' or begin with '/': '\(_rawFile)'"
		},
		if _hasFullFile && (strings.Contains(_rawFullFile, "..") || strings.HasPrefix(_rawFullFile, "/")) {
			"llms fullFile may not contain '..' or begin with '/': '\(_rawFullFile)'"
		},
		if _isAuthRequired && _enabled && (_synthBrief || _synthFull) {
			"llms auto-synthesis cannot be enabled when capabilities.auth.required is true"
		},
	]

	files: {
		if _hasText && !_hasFile {
			"llms.txt": {
				format: "text"
				text:   L.raw.text
			}
		}
		if _synthBrief {
			"llms.txt": {
				format: "text"
				text:   _synthBriefText
			}
		}
		if _hasFullText && !_hasFullFile {
			"llms-full.txt": {
				format: "text"
				text:   L.raw.fullText
			}
		}
		if _synthFull {
			"llms-full.txt": {
				format: "text"
				text:   _synthFullText
			}
		}
	}

	statics: [
		if (_hasText || _synthBrief) && !_hasFile {
			file:   "llms.txt"
			target: "/srv/llms.txt"
			watch:  true
		},
		if _hasFile && !_hasText && !strings.Contains(_rawFile, "..") {
			file:   _rawFile
			target: "/srv/llms.txt"
			watch:  true
		},
		if (_hasFullText || _synthFull) && !_hasFullFile {
			file:   "llms-full.txt"
			target: "/srv/llms-full.txt"
			watch:  true
		},
		if _hasFullFile && !_hasFullText && !strings.Contains(_rawFullFile, "..") {
			file:   _rawFullFile
			target: "/srv/llms-full.txt"
			watch:  true
		},
	]
}

#wellKnownPlan: {
	let W = self
	raw?: _

	_enabled: [if W.raw != _|_ {(W.raw & null) == _|_}, false][0]
	_rawMap:  [if _enabled if (W.raw & bool) == _|_ if (W.raw & {}) != _|_ {W.raw}, {}][0]

	_errors: list.Concat([
		[
			for name, _ in _rawMap
			if name == "" || name == "." || strings.Contains(name, "..") || strings.Contains(name, "/") {"wellKnown key may not contain '..' or '/' and may not be empty or '.': '\(name)'"}
		],
		[
			for name, item in _rawMap
			if (item & {}) != _|_
			if item.text != _|_ && item.file != _|_ {"wellKnown '\(name)' cannot declare both text and file"}
		],
		[
			for name, item in _rawMap
			if (item & {}) != _|_
			if item.text == _|_ && item.file == _|_ {"wellKnown '\(name)' must declare either text or file"}
		],
		[
			for _, item in _rawMap
			if (item & {}) != _|_
			if item.file != _|_
			if strings.Contains(item.file, "..") || strings.HasPrefix(item.file, "/") {"wellKnown file may not contain '..' or begin with '/': '\(item.file)'"}
		],
	])

	files: {
		for name, item in _rawMap {
			let isStr = (item & string) != _|_
			let hasText = [if (item & {}) != _|_ if item.text != _|_ {true}, false][0]
			let hasFile = [if (item & {}) != _|_ if item.file != _|_ {true}, false][0]
			if (isStr || hasText) && !hasFile {
				let content = [if isStr {item}, if hasText {item.text}, ""][0]
				".well-known/\(name)": {
					format: "text"
					text:   content
				}
			}
		}
	}

	statics: list.Concat([
		[
			for name, item in _rawMap
			let isStr = (item & string) != _|_
			let hasText = [if (item & {}) != _|_ if item.text != _|_ {true}, false][0]
			let hasFile = [if (item & {}) != _|_ if item.file != _|_ {true}, false][0]
			if (isStr || hasText) && !hasFile && name != "" && name != "." && !strings.Contains(name, "..") && !strings.Contains(name, "/") {
				file:   ".well-known/\(name)"
				target: "/srv/.well-known/\(name)"
				watch:  true
			}
		],
		[
			for name, item in _rawMap
			let hasText = [if (item & {}) != _|_ if item.text != _|_ {true}, false][0]
			let hasFile = [if (item & {}) != _|_ if item.file != _|_ {true}, false][0]
			if hasFile && !hasText
			if name != "" && name != "." && !strings.Contains(name, "..") && !strings.Contains(name, "/") && !strings.Contains(item.file, "..") && !strings.HasPrefix(item.file, "/") {
				file:   item.file
				target: "/srv/.well-known/\(name)"
				watch:  true
			}
		],
	])
}

#sitemapPlan: {
	let S = self
	raw?:          _
	meta?:         _
	capabilities?: _

	_isExplicitBool: [if S.raw != _|_ {(S.raw & bool) != _|_}, false][0]
	_isExplicitObj:  [if S.raw != _|_ {(S.raw & {}) != _|_}, false][0]
	_isDeclared:     [if S.raw != _|_ {(S.raw & null) == _|_}, false][0]

	_isAuthRequired: [
		if S.capabilities != _|_ if S.capabilities.auth != _|_ if S.capabilities.auth.required == true {true},
		false,
	][0]

	enabled: [
		if _isExplicitBool {S.raw},
		if _isExplicitObj if S.raw.enabled != _|_ {S.raw.enabled},
		true,
	][0]

	declared: _isDeclared

	_exclude: [if _isExplicitObj if S.raw.exclude != _|_ {S.raw.exclude}, []][0]
	_extra:   [if _isExplicitObj if S.raw.extra != _|_ {S.raw.extra}, []][0]

	_excludeErrors: [
		for ex in _exclude
		if !strings.HasPrefix(ex, "/") {"sitemap exclude path must begin with '/': '\(ex)'"}
	]

	_extraErrors: [
		for ext in _extra
		if !strings.HasPrefix(ext, "/") && !strings.HasPrefix(ext, "http://") && !strings.HasPrefix(ext, "https://") {"sitemap extra path must begin with '/', 'http://', or 'https://': '\(ext)'"},
		for ext in _extra
		if strings.Contains(ext, "{{") || strings.Contains(ext, "}}") {"sitemap extra path may not contain template delimiters '{{' or '}}': '\(ext)'"},
	]

	_authConflictErrors: [
		if _isAuthRequired && _isDeclared && enabled {
			"sitemap cannot be enabled when capabilities.auth.required is true"
		}
	]

	_errors: list.Concat([_excludeErrors, _extraErrors, _authConflictErrors])

	exclude: _exclude
	extra:   _extra

	tag: [
		if enabled && _isDeclared {"<link rel=\"sitemap\" type=\"application/xml\" href=\"/sitemap.xml\">"},
		"",
	][0]
}

#consentPlan: {
	let C = self
	raw?:    _
	enabled: C.raw != _|_
	// The hosts of the tags consent governs: nowhere else is anything sent,
	// so nowhere else is anyone asked.
	hosts: [...string]

	_errors: list.Concat([
		[if enabled if len(C.hosts) == 0 {"consent governs what a tag sends, and the app declares none: declare meta.googleTag"}],
		[if enabled if C.raw.mode == "none" if C.raw.none == _|_ {"consent mode none asks nobody, so it states what everyone gets: write none.advertising"}],
		[if enabled if C.raw.mode == "bar" if C.raw.none != _|_ {"consent.none is what mode none states; the bar asks instead"}],
	])

	terminal: [if enabled {
		mode:   C.raw.mode
		policy: C.raw.policy
		hosts:  C.hosts
		if C.raw.none != _|_ {none: C.raw.none}
	}, null][0]
}

#googleTagPlan: {
	let G = self
	raw?:     _
	enabled:  G.raw != _|_
	consent?: _

	// The tag frame: a document of this origin, so the cookies it writes are
	// first-party, in a realm of its own, so Google's scripts run under its
	// policy and never under the terminal's lockdown and Trusted Types.
	frame:  "shell/tag.html"
	_hosts: [if enabled {json.Marshal(G.raw.hosts)}, ""][0]

	_errors: list.Concat([
		[if enabled if len(G.raw.hosts) == 0 {"googleTag.hosts must name the hosts whose readers the tag measures"}],
		[if enabled if list.Contains(G.targets, "pages") {"googleTag needs its frame served beside the app, which a pages release, one file, cannot"}],
		[if enabled if G.consent == _|_ {"googleTag stores Google's cookies only with the reader's consent: declare meta.consent"}],
	])
	targets: [...string]

	// The app's side: `gtag` takes consent and event commands for the frame.
	// On a declared host alone, the terminal's first consent update mounts the
	// frame, which is told that consent, the page it measures and the landing
	// click ids before it configures, and then each route the reader reaches.
	bridge: [if enabled {
		"""
			{
			  const hosts = \(_hosts);
			  const landing = new URL(location.href);
			  const queue = [];
			  let frame = null;
			  let ready = false;
			  const post = (message) => ready ? frame.contentWindow.postMessage(message, location.origin) : queue.push(message);
			  const mount = (consent) => {
			    frame = document.createElement("iframe");
			    frame.src = \(json.Marshal("/"+frame));
			    // Or the frame's own referrer, this page, stands in for an empty one.
			    frame.referrerPolicy = "no-referrer";
			    frame.hidden = true;
			    frame.tabIndex = -1;
			    frame.setAttribute("aria-hidden", "true");
			    addEventListener("message", (event) => {
			      if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.kind !== "ready") return;
			      const click = {};
			      for (const key of ["gclid", "gbraid", "wbraid"]) if (landing.searchParams.has(key)) click[key] = landing.searchParams.get(key);
			      frame.contentWindow.postMessage({kind: "init", consent, page_location: landing.href, page_referrer: document.referrer, click}, location.origin);
			      ready = true;
			      for (const message of queue.splice(0)) post(message);
			    });
			    document.body.append(frame);
			  };
			  window.gtag = function gtag(command, ...args) {
			    if (command !== "consent" && command !== "event") throw new TypeError(`the tag frame takes consent and event commands, not ${command}`);
			    if (!hosts.includes(location.hostname)) return;
			    if (frame !== null) return post({kind: "gtag", args: [command, ...args]});
			    if (command !== "consent" || args[0] !== "update") throw new Error("the terminal states the reader's consent before any other command reaches the tag frame");
			    mount(args[1]);
			  };
			  if (hosts.includes(location.hostname)) {
			    let shown = landing.href;
			    globalThis.navigation?.addEventListener("currententrychange", (event) => {
			      if (location.href === shown) return;
			      if (event.navigationType !== "replace") post({kind: "page_view", page_location: location.href, page_referrer: shown});
			      shown = location.href;
			    });
			  }
			}
			"""
	}, ""][0]
	tag:        [if enabled {"<script>\(bridge)</script>"}, ""][0]
	bridgeHash: "'sha256-\(base64.Encode(null, sha256.Sum256(bridge)))'"
	// What the terminal's policy admits beside its own, by directive: the
	// bridge, and nothing of Google's.
	sources: [if enabled {script: [bridgeHash]}, {}][0]

	_frameScript: [if enabled {
		let src = "https://www.googletagmanager.com/gtag/js?id=\(G.raw.id)"
		"""
			if (parent === window || !\(_hosts).includes(location.hostname)) throw new Error("the tag frame runs framed by the app on a declared host");
			const dataLayer = window.dataLayer = [];
			function gtag() { dataLayer.push(arguments); }
			gtag("consent", "default", {ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied"});
			gtag("set", "ads_data_redaction", true);
			addEventListener("message", (event) => {
			  if (event.origin !== location.origin || event.source !== parent) return;
			  const message = event.data;
			  if (message.kind === "init") {
			    gtag("consent", "update", message.consent);
			    if (Object.keys(message.click).length > 0) history.replaceState(null, "", "?" + new URLSearchParams(message.click));
			    gtag("js", new Date());
			    gtag("config", \(json.Marshal(G.raw.id)), {page_location: message.page_location, page_referrer: message.page_referrer});
			    const tag = document.createElement("script");
			    tag.async = true;
			    tag.src = \(json.Marshal(src));
			    document.head.append(tag);
			  } else if (message.kind === "page_view") {
			    gtag("event", "page_view", {send_to: \(json.Marshal(G.raw.id)), page_location: message.page_location, page_referrer: message.page_referrer});
			  } else if (message.kind === "gtag") {
			    gtag(...message.args);
			  } else {
			    throw new TypeError(`not a tag frame message: ${message.kind}`);
			  }
			});
			parent.postMessage({kind: "ready"}, location.origin);
			"""
	}, ""][0]
	// Google's Ads lists (developers.google.com/tag-platform/security/guides/csp);
	// a remarketing pixel goes to the reader's own www.google.<TLD>, which no
	// list can name.
	framePolicy: strings.Join([
		"default-src 'none'",
		"base-uri 'none'",
		"object-src 'none'",
		"form-action 'none'",
		"script-src 'sha256-\(base64.Encode(null, sha256.Sum256(_frameScript)))' https://www.googletagmanager.com https://googleads.g.doubleclick.net https://www.googleadservices.com https://www.google.com",
		"connect-src https://www.googletagmanager.com https://www.google.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://ad.doubleclick.net https://pagead2.googlesyndication.com",
		"img-src https:",
		"frame-src https://www.googletagmanager.com",
	], "; ")
	frameHtml: [if enabled {
		"""
			<!doctype html>
			<html>
			<head>
			<meta charset="utf-8">
			<meta http-equiv="Content-Security-Policy" content="\(strings.Replace(framePolicy, "'", "&#39;", -1))">
			<script>\(_frameScript)</script>
			</head>
			<body></body>
			</html>

			"""
	}, ""][0]
}

#envelopePlan: {
	let P = self
	meta:          _
	surface?:      _
	state?:        _
	capabilities?: _

	favicon: #faviconPlan & {
		if P.meta.favicon != _|_ {raw: P.meta.favicon}
	}

	hints: #hintsPlan & {
		if P.meta.preconnect != _|_ {preconnect: P.meta.preconnect}
		if P.meta.dnsPrefetch != _|_ {dnsPrefetch: P.meta.dnsPrefetch}
	}

	googleTag: #googleTagPlan & {
		targets: P.meta.targets
		if P.meta.googleTag != _|_ {raw: P.meta.googleTag}
		if P.meta.consent != _|_ {consent: P.meta.consent}
	}

	consent: #consentPlan & {
		if P.meta.consent != _|_ {raw: P.meta.consent}
		hosts: [if P.meta.googleTag != _|_ {P.meta.googleTag.hosts}, []][0]
	}

	manifest: #manifestPlan & {
		meta:    P.meta
		favicon: P.favicon
		if P.capabilities != _|_ {capabilities: P.capabilities}
		if P.surface != _|_ {
			if P.surface.screens != _|_ {screens: P.surface.screens}
			if P.surface.design != _|_ {design: P.surface.design}
		}
		if P.meta.manifest != _|_ {raw: P.meta.manifest}
	}

	social: #socialPlan & {
		meta: P.meta
		if P.meta.social != _|_ {raw: P.meta.social}
	}

	llms: #llmsPlan & {
		meta: P.meta
		if P.surface != _|_ {surface: P.surface}
		if P.state != _|_ {state: P.state}
		if P.capabilities != _|_ {capabilities: P.capabilities}
		if P.meta.llms != _|_ {raw: P.meta.llms}
	}

	wellKnown: #wellKnownPlan & {
		if P.meta.wellKnown != _|_ {raw: P.meta.wellKnown}
	}

	sitemap: #sitemapPlan & {
		meta: P.meta
		if P.capabilities != _|_ {capabilities: P.capabilities}
		if P.meta.sitemap != _|_ {raw: P.meta.sitemap}
	}

	_errors: list.Concat([
		P.hints._errors,
		P.googleTag._errors,
		P.consent._errors,
		P.manifest._errors,
		P.social._errors,
		P.llms._errors,
		P.wellKnown._errors,
		P.sitemap._errors,
	])

	_hasEnvelopeInjections: P.meta.favicon != _|_ || P.hints.links != "" || P.googleTag.tag != "" || P.manifest.links != "" || P.social.links != "" || P.sitemap.tag != ""

	headLinks: [
		if !_hasEnvelopeInjections {
			"<link rel=\"icon\" href=\"data:,\">"
		},
		if _hasEnvelopeInjections {
			strings.Join([
				for s in [
					P.hints.links,
					P.googleTag.tag,
					[if P.meta.favicon != _|_ {P.favicon.links}, "<link rel=\"icon\" href=\"data:,\">"][0],
					P.manifest.links,
					P.social.links,
					P.sitemap.tag,
				] if s != "" {s}
			], "\n")
		},
	][0]

	files: {
		if P.favicon.svgFile != "" {
			"shell/favicon.svg": {
				format: "text"
				text:   P.favicon.svgFile
			}
		}
		if P.manifest.enabled {
			"shell/manifest.webmanifest": {
				format: "text"
				text:   P.manifest.jsonText
			}
		}
		if P.googleTag.enabled {
			(P.googleTag.frame): {
				format: "text"
				text:   P.googleTag.frameHtml
			}
		}
		for k, f in P.llms.files {
			(k): f
		}
		for k, f in P.wellKnown.files {
			(k): f
		}
	}

	_rawStatics: list.Concat([
		P.favicon.statics,
		[
			if P.manifest.enabled {
				file:   "shell/manifest.webmanifest"
				target: "/srv/shell/manifest.webmanifest"
				watch:  true
			},
			if P.manifest.enabled {
				file:   "shell/manifest.webmanifest"
				target: "/srv/manifest.webmanifest"
				watch:  true
			},
			if P.googleTag.enabled {
				file:   P.googleTag.frame
				target: "/srv/\(P.googleTag.frame)"
				watch:  true
			},
		],
		P.manifest.statics,
		P.social.static,
		P.llms.statics,
		P.wellKnown.statics,
	])

	_staticMap: {
		for s in _rawStatics if s != _|_ if s.target != "" {
			(s.target): s
		}
	}
	statics: [for _, s in _staticMap {s}]
}

// What an open constraint admits, for a reader that has to propose a value:
// a range, a length, a pattern. A json column states the shape of its value
// instead: the kind at each level, a record's fields (none stated: open), a
// list's items and cap, a string's set where the constraint closes it.
#Bounds: {
	kind?:       "boolean" | "string" | "integer" | "array" | "object"
	intMin?:     int
	intMax?:     int
	sizeMin?:    int
	sizeMax?:    int
	regex?:      string
	enumValues?: [...string]
	maxItems?:   int
	items?:      #Bounds
	fields?: [string]: #Bounds
}
