// Package pronto is the machine rung of the review ladder: the #App shape a
// program.cue instantiates, and #emit (emit.cue), which derives the emitted
// file bundle. Every object carries `ir`, the ir.html element id it realizes;
// the bijection checker matches these against the pinned IR.
package pronto

import (
	"list"
	"encoding/yaml"
	"strings"

	"github.com/bonisoft3/pronto/scales"
	"github.com/bonisoft3/pronto/terminals:omnishell"
)

#Tier: "cli" | "container" | "k8s" | "cloud"

// A path relative to the app directory, resolved by derive and by the
// terminal's module loader. No scheme and no `..`: the source is read from the
// app's own tree and embedded in emitted artifacts.
#Jessie: string & =~"^([a-z0-9_-]+/)*[a-z0-9_-]+\\.js$"

// The seven pre-composed shadow inks. Open Props' elevation carries a real
// dark story that light-dark() cannot take — --shadow-color is a bare
// `220 3% 15%` component triple and --shadow-strength a percentage, and
// neither is a <color> — so the strengths are pre-composed into finished
// colours and declared as ROLES, where the twin is closed. #scale.shadow is
// then geometry alone.
//
// Required of every preset below, in both halves. #scale.shadow depends on
// these names, so a preset that omitted them would export cleanly and emit
// `--shadow-1: 0 1px 2px -1px var(--shadow-ink-10)` with nothing declaring
// the ink: invalid at computed-value time, and every elevation silently gone.
#shadowInks: ["shadow-ink-3", "shadow-ink-4", "shadow-ink-5", "shadow-ink-6",
	"shadow-ink-7", "shadow-ink-8", "shadow-ink-10"]

// Starting points for #Design. A preset is named rather than implicit so a
// reviewer can see which opinion an app took, and so adding a second is a data
// change rather than a fork.
//
// The token NAMES are the schema contract and the platform's; the hex is the
// designer's to evolve.
#designPresets: [Name=string]: {
	colors: [string]: string
	colors: {for n in #shadowInks {(n): string}}
	dark: [string]: string
	dark: {for n in #shadowInks {(n): string}}
	rounded: [string]:  string
	spacing: [string]:  string
	motion: [string]:   string
	control: [string]:   string
	measures: [string]:  string
	type: [string]:      string
	component: [string]: #Reference
}
#designPresets: press: {
	// Identity for an editorial reading surface; the default an app takes
	// when it names no preset.
	colors: {
		primary:         "#16181A"
		secondary:       "#6B7076"
		accent:          "#1D6A4F"
		danger:          "#A93226"
		neutral:         "#FBFAF7"
		surface:         "#FFFFFF"
		border:          "#E4E1D9"
		"surface-muted": "#EFEDE6"
		"shadow-ink-3":  "hsl(220 3% 15% / 3%)"
		"shadow-ink-4":  "hsl(220 3% 15% / 4%)"
		"shadow-ink-5":  "hsl(220 3% 15% / 5%)"
		"shadow-ink-6":  "hsl(220 3% 15% / 6%)"
		"shadow-ink-7":  "hsl(220 3% 15% / 7%)"
		"shadow-ink-8":  "hsl(220 3% 15% / 8%)"
		"shadow-ink-10": "hsl(220 3% 15% / 10%)"
	}
	dark: {
		primary:         "#E9E7E2"
		secondary:       "#9AA0A6"
		accent:          "#63BE95"
		danger:          "#E2705F"
		neutral:         "#131414"
		surface:         "#1C1E1F"
		border:          "#2E3133"
		"surface-muted": "#24272A"
		"shadow-ink-3":  "hsl(220 40% 2% / 27%)"
		"shadow-ink-4":  "hsl(220 40% 2% / 28%)"
		"shadow-ink-5":  "hsl(220 40% 2% / 29%)"
		"shadow-ink-6":  "hsl(220 40% 2% / 30%)"
		"shadow-ink-7":  "hsl(220 40% 2% / 31%)"
		"shadow-ink-8":  "hsl(220 40% 2% / 32%)"
		"shadow-ink-10": "hsl(220 40% 2% / 34%)"
	}
	rounded: {sm: "4px", md: "8px", full: "999px"}
	// px, not var(--size-N). Three of the four are exactly a rung, which is
	// evidence the roles were already right rather than a reason to make them
	// indirections: rewriting them would convert six apps' --sp-* from device
	// px to rem, identical at a 16px root and not above it, while the two apps
	// that declare `spacing` concretely would keep the literals and fork the
	// corpus on the very role meant to show the two namespaces meeting.
	spacing: {sm: "8px", md: "16px", lg: "24px", xl: "40px"}
	motion: {fast: "110ms", base: "180ms", ease: "cubic-bezier(.2, 0, 0, 1)", shift: "6px"}
	// A control's geometry, which sm/md/lg/xl could not say: that ladder
	// orders spacing by size and is silent about which BOX gets which, so a
	// control's height and inset had no name and became a number. pad-x is a
	// role pointing at a role — the worked example of the two layers meeting.
	control: {
		"h-xs":  "28px", "h-sm": "32px", h: "36px", "h-lg": "40px"
		"pad-x": "var(--sp-md)"
	}
	// Page-level widths. Identity, not scale: no vocabulary contains 720px,
	// and pretending one does is how a measure stays a bare number. press
	// declares none, so every entry is the app's own.
	measures: {}
	// Six purposes and two leadings, each value a step Primer publishes, so the
	// identity is spelled in the vocabulary rather than beside it. A purpose
	// decides its size and its leading together, the shape Material's typescale
	// takes and a bare ladder cannot state. #Design.type states the tier's rules.
	type: {
		display:           "2.5rem"
		title:             "2rem"
		subtitle:          "1.25rem"
		body:              "1rem"
		caption:           "0.875rem"
		label:             "0.75rem"
		// TWO leadings, not one per purpose. The vendored ladder has five steps and
		// two roles at one norm raise, so a preset that named four would leave an
		// app a single free value and any override it made would cascade. Prose and headings are the two readings a
		// leading actually decides; a purpose that needs a third names it, and has
		// three steps left to name it with.
		"leading-title": "1.25"
		"leading-body":  "1.625"
	}
	// Geometry ordered by ELEMENT CLASS rather than by size: field-radius,
	// selector-radius, box-radius. This is the one thing an ordered sm/md/full
	// ladder cannot state whatever it is filled with — press orders radii by
	// size and other systems order them by which control wears them — so it is a
	// tier and not another rung. press declares none.
	component: {}
}

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

#Scale: S={
	sources: [Name=string]: #Source
	buckets: [Name=string]: #Bucket
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
// Not a #designPresets entry: a preset is one identity among several, this is
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
		pronto: {kind: "own", origin: "pronto", version: "this repository"}
		terminal: {kind: "own", origin: "omnishell", version: "this repository"}
	}
	buckets: {
		size:   scales.openprops.buckets.size
		border: scales.openprops.buckets.border
		// Geometry only, and pronto's own: the six upstream NAMES republished over
		// the twinned ink roles, for the reason #shadowInks gives. Every preset
		// carries the inks, so these var()s never dangle.
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
			steps: {for n, px in omnishell.#Terminal.capabilities.floors {(n): "\(px)px"}}
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
// the same division the ir and the program keep for behaviour. Every field is
// optional: the preset supplies what the app does not say. The emitter alone
// turns these into CSS; the fact-store join (invariants.sql) guards the fork.
#Design: D={
	// The starting set this app took. Naming a token below replaces that one
	// and leaves the rest, exactly as `motion` works.
	preset:  *"press" | string
	_preset: #designPresets[D.preset]

	colors: [string]: string
	colors: {for k, v in D._preset.colors {(k): *v | string}}
	// The dark twin declares the SAME names — appearance is a token
	// resolution, never a state. Emitted as the second argument of each
	// token's light-dark(), so the two palettes are one declaration and a
	// name can no longer appear in a single appearance: a missing twin and a
	// twin nothing reads are both errors here rather than a token that
	// silently stops changing, or never changed at all.
	dark: close({for k, _ in D.colors {(k): string}})
	dark: {for k, v in D._preset.dark {(k): *v | string}}
	rounded: [string]: string
	rounded: {for k, v in D._preset.rounded {(k): *v | string}}
	spacing: [string]: string
	spacing: {for k, v in D._preset.spacing {(k): *v | string}}
	// The motion vocabulary. The terminal ships no style at all — its
	// shell.css is the empty contract — so this is the only declaration;
	// the preset supplies the defaults and naming one here replaces it.
	motion: [string]: string
	motion: {for k, v in D._preset.motion {(k): *v | string}}
	// Lengths a screen reaches for by role rather than by rung. #scale is the
	// vocabulary beneath these and has no app seam; a length the scale lacks
	// is named HERE, because a decision belongs in the app's own block and a
	// rung does not.
	control: [string]: string
	control: {for k, v in D._preset.control {(k): *v | string}}
	measures: [string]: string
	measures: {for k, v in D._preset.measures {(k): *v | string}}
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
	// purposes, so a reader who knows that vocabulary knows this one. What a
	// purpose is worth is the app's or its preset's.
	//
	// A role carries its VALUE. A role that aliased a rung would win its norm, and
	// `best` keeps one step per (dimension, norm), so the rung would drop out of
	// what the lint can name in that app and the app's identity would move under a
	// vendor's release. A role aliases another ROLE only to say "the same value as
	// that purpose", which is also the one legal spelling of it, since two roles
	// at one norm raise.
	type: [string]: string
	type: {for k, v in D._preset.type {(k): *v | string}}
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
	component: {for k, v in D._preset.component {(k): *v | string}}
	// Which colour the terminal's own chrome resolves to; the shell has no
	// opinion about which swatch is a background.
	shell: {
		bg:   *"neutral" | string
		fg:   *"primary" | string
		rule: *"border" | string
	}
}

// The reader of an app's DESIGN.md: `text` is the file, embedded by program.cue
// (`_designMd: _ @embed(file="DESIGN.md", type=text)` under `@extern(embed)`),
// and `design` is its YAML frontmatter — the lines between a first line that is
// exactly `---` and the next such line — unified with #Design, so that a key
// #Design lacks, a value of the wrong shape and a file without a frontmatter
// are all errors at `cue vet` and at export. The frontmatter is the one
// declaration: program.cue restates none of it (`surface: design:
// (pronto.#DesignMd & {text: _designMd}).design`), and it carries the app's own
// overrides and additions, `var(--…)` references included — never the resolved
// palette, so the preset keeps filling the rest. An empty frontmatter is the
// preset as it is.
#DesignMd: {
	text:   string
	_lines: strings.Split(text, "\n")
	// A fence is a whole line, so a CRLF ending, trailing space or a byte before
	// the opening fence is not one, and a `---` in the body cannot be mistaken
	// for the closing fence: the first one after the opening line closes it.
	_closes: [for i, l in _lines if i > 0 && l == "---" {i}]
	_fenced: _lines[0] == "---" && len(_closes) > 0
	// The error sits on `design` itself, so it surfaces wherever the design is
	// read rather than only where the reader is inspected. An empty frontmatter
	// unmarshals to top, which is the preset untouched.
	if _fenced {
		design: #Design & yaml.Unmarshal(strings.Join(list.Slice(_lines, 1, _closes[0]), "\n"))
	}
	if !_fenced {
		design: error("DESIGN.md has no frontmatter: the design block is the YAML between a first line that is exactly --- and the next such line")
	}
}

#Field: {
	name: string
	type: "uuid" | "text" | "bool" | "int" | "bigint" | "timestamptz" | "tsvector"
	pk:       *false | bool
	required: *true | bool
	ref?:     string // referenced table; DDL: REFERENCES <ref>(id) ON DELETE CASCADE
	unique?:  bool
	default?: string // SQL expression
	// SQL expression; DDL: GENERATED ALWAYS AS (<expr>) STORED. Generated
	// fields emit no NOT NULL/DEFAULT and never appear in forms.
	generated?: string
	// The one statement of the field's constraint, `this` bound to the field
	// value. Its SQL CHECK body and its CUE constraint are derived from the
	// parsed expression (program_cel.cue), never written beside it.
	cel?: string
}

// Row visibility, enforced as RLS policies (005_policies.sql). The four
// modes are the whole vocabulary; an entity without `access` gets no RLS.
// Column names (`owner`, `on`, `user`) are of the entity's own table;
// `via` is a table name, `parent` an entity name whose access is owned.
#Access: {
	mode:  "owned"
	owner: string
	shared?: {via: string, on: string, user: string}
} | {
	mode:   "through"
	parent: string
	on:     string
} | {
	mode: "public-read"
} | {
	mode: "service-only"
}

#Entity: {
	name:  string
	ir:    *name | string
	table: string
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
	durability: "server" | "live" | "offline" | "tab" | "device"
	// Whether the rows live in the cluster: every tier but the two browser ones.
	// The one spelling of that boundary; the emitter reads this, never the names.
	server: durability != "tab" && durability != "device"
	if durability == "tab" || durability == "device" {
		access?: _|_
	}
	if durability != "tab" && durability != "device" {
		access?: #Access
	}
	// "pipeline" entities are never mutated by forms; role-level enforcement
	// is an open question in SPEC.md.
	writers: *"forms" | "pipeline"
	fields: [...#Field]
	// DDL: CREATE INDEX IF NOT EXISTS idx_<table>_<on> ON <table>
	// USING <using> (<on>); emitted after the tables in 004.
	indexes?: [...{on: string, using: *"btree" | "gin"}]
	// Row-level constraint, `this` bound to the row. Its CHECK body is derived
	// like a field's, but only its CHECK: a predicate over several columns is
	// not a constraint on any one field's value, so no CUE rendering exists.
	invariant?: {cel: string, check?: string}
	// Derived SQL CHECK bodies by column name (program_cel.cue), rendered from
	// the parsed `cel` of each field. A browser tier declares none: no table
	// is emitted for it, so its constraints reach only CUE.
	checks: [string]: string
	// The values a column admits, by column name, derived from the same parsed
	// `cel` (program_cel.cue) — only for the constraints that close the set. It
	// is the emitted answer to "which kinds are declarable", which the
	// terminal's markup rules judge a data-when against; a checker parsing the
	// cel itself would be a second front end for the one constraint language.
	enums: [string]: [...string]
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
	// never a natural key — upserts cannot resolve against it. Browser tiers
	// only: its SQL rendering (a partial unique index) waits for a
	// server-tier consumer.
	uniques: *[] | [...{name: string, cols: [...string], where?: string}]
	if durability != "tab" && durability != "device" {
		uniques: [...{where?: _|_}]
	}

	// Rung five of validation: a Jessie predicate over the row and its
	// references, run by the store before an optimistic write and by Postgres
	// before commit. Named because the name is the refusal, as a unique's is.
	validations: [Name=string]: #Validation & {name: Name}

	// Bootstrap rows: the rows a store holds before anyone writes one. A
	// server tier renders them into 900_seed.sql; a `tab` entity has no
	// migration to render into, so the terminal writes them itself when it
	// first opens the collection (shell.yaml `seed:`).
	//
	// A pipeline-written singleton MUST seed its initial state: pipelines fire
	// on CDC events, so before the first mutation the derived row exists only
	// if the schema bootstrap made it.
	//
	// Both tiers keep the same rule — the rows are written once against an
	// empty store and never reconsidered — because at both tiers the store's
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

#Pipeline: {
	name:    string
	ir:      *name | string
	trigger: *"cdc" | "schedule"
	// Complex pipelines are assembly: `src` (under pipelines/) holds the whole
	// rpk stream YAML, copied verbatim to docker/<app>-<name>.yaml. The file
	// owns input, transform, and output alike — aggregate/bloblang/key/shim do
	// not apply, and loop prevention is the author's burden (the emitter
	// cannot see inside).
	raw?: true
	if raw != _|_ {
		src: *"pipelines/\(name).yaml" | string
		transform?: _|_
		key?:       _|_
	}
	from?:   string // source entity name (CDC events); cdc pipelines set it
	to:      string // sink entity name (upsert, or scheduled mutation target)
	group?:  string // bus consumer group; cdc pipelines set it
	// Keyed aggregate: the transform groups source rows by this column and
	// emits an ARRAY of sink rows; the sink upsert conflicts on the sink pk.
	// Unset = singleton transform emitting one row.
	key?: string
	transform?: {
		aggregate: string // PostgREST query the transform reads from the source table
		src: *"pipelines/\(name).blobl" | string // assembly file holding the mapping
		bloblang: string // its content — inlined where the consumer cannot reference files
	}
	// The BROWSER-side transform, written as a fold: empty(key), step(acc, row),
	// combine(a, b), result(acc), with `harden` supplied by SES. It replaces
	// `shim` — the shim contract is (rows) => one row on id, which cannot state
	// a keyed aggregate — and it additionally lets the terminal project the
	// sink optimistically, resuming the fold over rows the sink has not counted.
	//
	// The container keeps its bloblang. rpk can run this module (it embeds
	// goja), and an earlier revision did, but nothing lints a JavaScript string
	// inside a pipeline YAML while `redpanda-connect lint` does catch a broken
	// mapping — so the sharing bought less than the lost build-time check cost.
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
		// composite unique). The reader's rows are collapsed on it: the server
		// holds one, so counting duplicates shows a total that cannot exist.
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
	interval?: string
	action?:   "delete" | "update"
	filter?:   string
	// Go-style duration of h/m/s units (e.g. "168h", "30m"); required when
	// filter uses {cutoff}: cutoff = now - window.
	window?: string
	set?: {[string]: bool | int | string} // PATCH body for action "update"
	// Browser tier cannot run bloblang; per the escape-hatch doctrine a cdc
	// pipeline binds to a declared shim there: a pure ES module, rows → sink
	// row. Scheduled and raw pipelines have no shim (no browser analogue), and
	// a fold needs none — it already runs at every tier.
	if trigger == "cdc" if raw == _|_ if fold == _|_ {
		shim: *"pipelines/\(name).browser.js" | string
	}
}

// The columns mecha writes on a tick, for the entity a #Schedule emits into.
// Spelled here rather than injected at emit so the entity a reviewer reads is
// the entity that exists. The ticker writes all five LAST, after the
// declaration's own values, so nothing an app states can overwrite them.
//
// Combine with `list.Concat([#tickFields, [...]])`: cue 0.16 supersedes `+` on
// lists and says so as an error, not a warning.
#tickFields: [
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
#Schedule: S={
	name: string
	ir:   *name | string
	// Five fields, the only grammar. `n/step` means n to the end of the field,
	// so `5/10` in minutes is 5, 15, 25 … 55.
	cron:     string
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

#FormField: {
	name: string
	// "file" (blobs on): the shell PUTs the picked file to
	// /blobs/mecha-objects/<uuid><ext> and submits the field's name with the
	// resulting key string.
	// "date" submits day precision: empty → JSON null, else the picked day
	// pinned to 00:00:00Z — the one-clock day convention.
	control:  "text" | "checkbox" | "textarea" | "select" | "hidden" | "datetime" | "date" | "file"
	required: *false | bool
	maxLength?:      int
	placeholder?:    string
	invalidMessage?: string
	options?: [...string] // select controls
	// hidden controls; resolved at submit: `{param.x}`, `{now}`, and the
	// literal `null` meaning SQL NULL.
	value?: string
}

#Form: {
	id:     string
	entity: string
	action: "create" | "update" | "delete" | "upsert"
	// Delete forms only: a PostgREST filter fragment ({param.x} interpolates)
	// scoping a bulk delete of every matching row, instead of the row context.
	filter?: string
	// ir flow id this form realizes; unset when the form realizes no single
	// flow (row-scoped deletes, or one form serving several flows).
	flow?: string
	fields: [...#FormField]
}

#Screen: S={
	name:  string
	ir:    *name | string
	title: string
	route: string // may contain one `:param` segment; params reach filters, hidden values, and `{param.x}` interpolation
	// filter/select are PostgREST query fragments passed through verbatim;
	// `{param.x}` placeholders resolve in the interpreter.
	// Derived from the markup (program_derived.cue). An assembly screen's html
	// exists before any derivation, so a screen the derived file misses is a
	// stale generation and the export fails incomplete rather than shipping a
	// screen whose reads and handlers are silently empty. A CUE-authored
	// screen alone carries the bootstrap default: its html does not exist
	// before the first export, so the first derivation cannot see it —
	// write.ts's fixpoint re-derives after writing and re-exports until the
	// derived file holds what the emitted markup says.
	reads!: [...{entity: string, order?: string, filter?: string, select?: string}]
	if S.markup != _|_ {
		reads: *[] | [...{entity: string, order?: string, filter?: string, select?: string}]
	}
	// A component-bearing screen is authored HERE, in CUE: `markup` is the
	// screen's whole HTML, composed by interpolating component definitions
	// (their tags survive in it as inert wrappers), and files.html becomes an
	// emitted file rather than an assembly source. Absent, the screen is
	// assembly authored at files.html as ever.
	markup?: string
	forms: [...#Form]
	states: [...string] // ir frame ids are "\(name)-\(state)"
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
	// starts from. Parametrized routes are never listed: they have no static
	// href.
	strip: *true | bool
	paths: [Name=string]: {states: [...string], accepts: [...string]}
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
	// "navigate" flows end in a read, not a store call (a navigate form's hash
	// change); entity names the entity the landing read targets.
	action: "create" | "update" | "delete" | "upsert" | "navigate"
}

#Test: {
	id: string
	ir: *id | string
	of: string
	accepts: [...string]
	says:  string
	given: _
	when:  string
	then:  string // CEL over injected input/output/error
}

#App: {
	state: {
		entities: [Name=string]: #Entity & {name: Name}
		// DDL table-order override: must list every entity, parents before
		// children (a `ref` REFERENCES needs its target table emitted first).
		// Unset = entity declaration order, which must itself be parents-first.
		entityOrder?: [...string]
		// Hand-authored SQL beyond the schema vocabulary, as assembly files; the
		// writer copies each src into services/database/migrations/<name>, and
		// the name's numeric prefix orders it among the emitted migrations.
		rawMigrations?: [...{name: string, src: string}]
		pipelines: [Name=string]: #Pipeline & {name: Name}
		schedules: [Name=string]: #Schedule & {name: Name}
	}

	capabilities: {
		// Passed through to shell.yaml verbatim: the terminal owns the login
		// chrome, keyed on `required`, and calls the auth service at `service`.
		// Presence also switches the cluster's auth plane on (#emit).
		// `self` names the signed-in person's own page for the strip the
		// terminal draws: `path` is a route whose :params it fills from the
		// session user, and `name` the table and column the name they chose
		// lives in, read live so a rename reaches the strip as it reaches a
		// byline. Omitted by an app that has no page for a person — and then
		// the one identity always on screen leads nowhere.
		auth?: {
			required: bool
			service:  string
			mode:     *"passkey" | string
			self?: {path: string, name?: {table: string, column: string}}
		}
		// Switches the cluster's blob plane on (#emit): rclone-s3 object store
		// and imgproxy behind the caddy /blobs and /img routes.
		blobs: *false | bool
		// Escape hatches, bijection surface only (ir kind "hatch"): the actual
		// service definition is the program's cluster unification beside it.
		hatches: [Name=string]: {ir: *Name | string, kind: "container", note: string}
		// Terminal-tier hatch: a vendored unit running inside the terminal, under
		// one of `isolation`'s boundaries, requesting a subset of the terminal's
		// capability vocabulary (`"group.name"` strings). Checked against
		// #Terminal.capabilities' offer in #emit, not here.
		//
		// `files` is everything the unit needs served, `src` among them: the
		// wrapper an engineer audited, and whatever that wrapper loads beside
		// itself. They are served as statics like any other app file, so a unit
		// reaches no further over the network than the app already does.
		vendored: [Name=string]: {
			ir: *Name | string
			isolation: "compartment" | "iframe" | "worker"
			capabilities: [...string]
			src: string
			files: [...string]
			note: string
		}
	}

	surface: {
		screens: [Name=string]: #Screen & {name: Name}
		// Jessie handlers, bijection surface (ir kind "handler"): `of` is the
		// screen, `src` the assembly module — also listed in that screen's
		// files.handlers, which is what the loader resolves.
		handlers: [Name=string]: {ir: *Name | string, of: string, src: #Jessie, note: string}
		design: #Design
		flows: [Name=string]: #Flow & {name: Name}
	}

	meta: {
		// Also the app's directory name, which is why a hyphen is admitted;
		// the emission folds it where an identifier is required.
		name: =~"^[a-z][a-z0-9-]*$"
		// One line for the entry page's meta description. The hash router gives
		// every route this same description, so it names the app, not a screen.
		description: string
		ir: {source: *"ir.html" | string, sha256: string} // the pinned IR this program was compiled from
		tiers: [...#Tier]
		// Tiers where something outside the cluster pokes the ticker. The
		// compose clock is emitted by cluster.cue and needs no declaration;
		// k8s and cloud do, because their clock lives in a deploy tree mecha
		// does not write, and the original bug was not that the clock was in
		// the wrong place but that nothing could tell. #emit refuses a cloud
		// tier that declares a schedule and no clock here.
		clocks: [...#Tier]
		// A program names its decisions and nothing more: `note` is derived
		// from the prose of the ir element `ir` names (pronto derive.ts), so the
		// reviewed artifact is the only place the rationale is written.
		decisions: [Id=string]: {ir: *Id | string, note: string}
		tests: [Id=string]: #Test & {id: Id}
		// The literal debt this app still carries: how many declarations wear
		// `/* pronto-literal: pending */`. Checked for EQUALITY, not a ceiling —
		// fixing a site without lowering the number fails, adding one without
		// raising it fails, and raising it is a diff here that a reviewer sees.
		// Debt is strictly monotone downward, and zero is the default because an
		// app that has never reached for the hatch should not have to say so.
		design: pendingLiterals: *0 | int & >=0
	}
}
