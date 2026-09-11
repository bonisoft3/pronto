// Which custom properties each stylesheet declares, and which literals it
// writes where the shared layer already publishes the value under a name.
//
// The emitter turns #scale into design.css's :where(html) rung block and
// DESIGN.md's frontmatter, read as the program's design block, into its :root
// role block; the terminal ships shell.css. Between them they own the
// vocabulary. Consuming a token with var() is the whole point and always
// fine, so only a declaration and a literal are rows here.
//
// Two namespaces, and the scanner keeps them apart. A ROLE is word-shaped and
// means something in the design's argument; a RUNG is number-shaped and means
// only "the Nth one". Where both publish one value the finding names the role,
// because an author should reach for --sp-md before --size-3.

// @ts-types="npm:@types/css-tree@2.3.10"
import * as csstree from "npm:css-tree@3.1.0";

/** Token names the shared layer declares — the ones a screen must not repeat. */
export function ownedTokens(css: string): Set<string> {
  return tokensOf(parse(css).decls);
}

const tokensOf = (decls: Decl[]) => new Set(decls.filter((d) => d.prop.startsWith("--")).map((d) => d.prop));

/** What derive reads of one app stylesheet, off a single parse. */
export function scanStylesheet(css: string): { tokens: Set<string>; literals: Literal[]; exceptions: Exception[] } {
  const parsed = parse(css);
  return { tokens: tokensOf(parsed.decls), literals: literalsOf(parsed.decls), exceptions: exceptionsOf(parsed) };
}

/** Each custom property a stylesheet declares, with its value. */
export function customProperties(css: string): { token: string; value: string }[] {
  return parse(css).decls.filter((d) => d.prop.startsWith("--")).map((d) => ({ token: d.prop, value: d.value }));
}

/**
 * The root font size every browser ships, which no app and not the emitter
 * sets. It is the only reason a rem rung and a px literal are comparable, so an
 * app that moved it would silence the whole length half of this scanner. That
 * coupling is checked rather than assumed: the `root` dimension below carries a
 * font-size on the root element, and no step can match it.
 */
const ROOT_PX = 16;

/**
 * The dimensions a published token can own — the list of joins this pass
 * implements, which is what settles its membership. A property decides what a
 * LITERAL is (PROPERTY_DIMENSION); a RUNG's is its bucket's, by construction,
 * and only a ROLE still needs its name read (ROLE_DIMENSION). Without that
 * last map, press's --sp-xl: 40px and --control-h-lg: 40px would both answer
 * `padding: 40px`.
 *
 * `opaque` is a bucket that publishes a name and joins nothing: an elevation is
 * a list rather than a value, and a touch floor is a decision. `token` is a
 * custom property's declaration, which has no property to classify it by — a
 * private token is not a hiding place, so it joins any step whose norm carries
 * its own unit. `color` and `shadow-color` are matched by appearance rather
 * than by length, and `root` is the ROOT_PX guard.
 */
export type Dimension =
  | "rule"
  | "space"
  | "radius"
  | "motion"
  | "layer"
  | "ratio"
  | "text"
  | "leading"
  | "opaque"
  | "token"
  | "color"
  | "shadow-color"
  | "shorthand"
  | "root";

/**
 * A literal a stylesheet writes, in the dimension its property puts it in.
 * `decl` is the declaration's ordinal (Decl.decl), which a hatch row joins on.
 */
export type Literal = {
  line: number;
  decl: number;
  prop: string;
  value: string;
  dimension: Dimension;
  norm: string;
};

/**
 * One hatch comment, against the declaration it excuses. `witnessed` is whether
 * the enclosing block references a token at all, which is what gives a
 * `derived` claim a subject; `prop` is null for a hatch that reached no
 * declaration, which still reports rather than vanishing. `decl` is the excused
 * declaration's ordinal (Decl.decl), null for an orphan.
 */
export type Exception = { line: number; decl: number | null; prop: string | null; reason: string; witnessed: boolean };

/** A value the shared layer publishes under a name. */
export type Step = { token: string; dimension: Dimension; norm: string; kind: "role" | "rung" };

/**
 * The hatch's reasons, closed. `physical` is deliberately absent: "a device
 * measure with no design meaning" is the argument for keeping rule widths in
 * px, so a reviewer who accepts it there has no ground to reject it above the
 * `border: 1px solid` that dominates the corpus. An unrecognised reason
 * excuses nothing and is itself a finding.
 */
export const EXCEPTION_REASONS = ["derived", "pending"] as const;

// Which dimension a property puts its literals in. Ordered, first match wins,
// and radius comes first because border-radius is not a border width. A
// literal's dimension is decided by the property it sits on and never by its
// unit, so `padding: 14px` is `space` and `font-size: .875rem` is `text` by
// construction, and neither can be offered the other's token.
//
// Absent on purpose: width/height/min-*/max-*/flex-basis, because control
// geometry and page measures are identity and a role's value is a decision this
// rule has no standing to police; font-weight, because the one vendored ladder
// for it is refused (scales/primer-primitives-11.10.0/admitted.json carries the
// measurement); and letter-spacing, because no vendored tree declares a tracking
// name at all, so a literal here would have nothing to be refused toward.
const PROPERTY_DIMENSION: [RegExp, Dimension][] = [
  [/^border(-(top|bottom)-(left|right)|-(start|end)-(start|end))?-radius$/, "radius"],
  [/^(border|outline)(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-width)?$/, "rule"],
  [/^(outline-offset|text-underline-offset)$/, "rule"],
  [
    /^(margin|padding|scroll-margin|scroll-padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/,
    "space",
  ],
  [/^(row-|column-)?gap$/, "space"],
  [/^inset(-(block|inline)(-(start|end))?)?$/, "space"],
  [/^(top|right|bottom|left)$/, "space"],
  // A translate is a length in the layout the padding box establishes, which is
  // why the coupled-system rule cares about it at all.
  [/^(transform|translate)$/, "space"],
  // The longhands are the shorthand's own slots under another spelling, so a
  // duration or an easing is scanned wherever it is written.
  [/^(transition|animation)(-duration|-delay|-timing-function)?$/, "motion"],
  [/^z-index$/, "layer"],
  [/^aspect-ratio$/, "ratio"],
  [/^font-size$/, "text"],
  [/^line-height$/, "leading"],
  // The `font` shorthand sets four dimensions in one declaration and no rule
  // here can read any of them, so it joins nothing and reports as itself.
  [/^font$/, "shorthand"],
];

// Which dimension a ROLE name publishes a step in. Rungs are absent because a
// rung's dimension is its bucket's, so nothing here matches a name against an
// ordered prefix list. --control-*, --measure-*, --c-* and --shell-* are absent
// for their own reason: a control's height, a page width, which geometry a class
// of control wears, and a chrome hook are decisions, not values to refuse
// toward.
//
// Absence here decides only what a literal is answered WITH. It is not what
// keeps an aliasing tier from shadowing its target — wins() does that, by making
// an alias lose to the token it points at, so --c-field-radius: var(--r-sm)
// could not have outranked --r-sm however this map read. And it exempts nothing
// from the reference check, which scaleSteps runs before consulting this map.
const ROLE_DIMENSION: [RegExp, Dimension][] = [
  [/^--sp-/, "space"],
  [/^--r-/, "radius"],
  [/^--motion-/, "motion"],
  // Ordered, the longer first. --type-* is the one role space whose entries are
  // not all one kind, and unlike --motion-*, where a time and an easing share a
  // name space because the norm tells them apart, a font size and a line-height
  // are refused toward different properties and so need different names.
  [/^--type-leading-/, "leading"],
  [/^--type-/, "text"],
];

/**
 * The role spaces where every value must be one norm() can read. Both --type-*
 * rows above exist so a font size and a line-height can be refused toward, so a
 * value this pass cannot read publishes no step: the lint teaches nothing while
 * the CSS still emits the token. A weight, a keyword, and a leading written under
 * a size name are each silent otherwise.
 *
 * Per role space rather than for every role, because --motion-shift is a
 * translate distance under --motion- — a value that space deliberately carries
 * and its dimension does not read.
 */
const GRADED_ROLES = new Set(["type"]);

// The dimensions a PRIVATE token's own value can reach, in the order one is most
// likely to have meant. A custom property declares whatever it likes, so its unit
// is the only thing that says which dimension it meant; every other dimension is
// decided by the property, which is why this list is short rather than nine long.
//
// `text` and `leading` are deliberately absent, and the reason is measured
// rather than anticipated: --size-3 is 1rem and --base-text-size-md is 1rem, so
// `--x: 1rem` would join both and naming the wrong one is how a rule teaches
// people to distrust it. The norms already separate them (px:16 against
// rem:1000); this is the belt, and it is the one that matters if remNorm is
// ever widened.
//
// Complete for its job, and checked to be: scaleSteps raises on a step outside
// this list carrying a norm the index is keyed by.
const TOKEN_DIMENSIONS: Dimension[] = ["space", "rule", "radius", "motion"];

// NORM.token's whole range, which is what the private-token index is keyed by.
// `em` is the one tag a dimension outside TOKEN_DIMENSIONS can also produce,
// remNorm handing it to `text` and `leading` for a size keyed to the inherited
// one.
const TOKEN_NORM = /^(?:px:|ms:|ease:)|^em$/;

/** Colour functions, whose arguments decide whether the colour is a literal. */
const COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
]);

/**
 * Whether a rule's prelude selects the root element: `html` or `:root`, however
 * dressed (`html[data-theme]`, `:root.dark`, `:root:not(.x)`, `html:has(> .x)`)
 * or wrapped in `:where()`/`:is()`. Read off the parsed selector rather than a
 * character class, because a combinator names a descendant and a
 * pseudo-element names a box that is not the root, and both can hide inside
 * brackets or parentheses a regex cannot see past. One selector of a list
 * reaching the root is enough: the declaration lands there.
 */
function selectsRoot(prelude: string): boolean {
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(prelude, { context: "selectorList", onParseError: () => {} });
  } catch {
    return false;
  }
  const selectors = ast.type === "SelectorList" ? ast.children.toArray() : [ast];
  return selectors.some(isRootCompound);
}

function isRootCompound(sel: csstree.CssNode): boolean {
  if (sel.type !== "Selector") return false;
  const parts = sel.children.toArray();
  if (parts.some((p) => p.type === "Combinator" || p.type === "PseudoElementSelector")) return false;
  return parts.some((p) => {
    if (p.type === "TypeSelector") return p.name.toLowerCase() === "html";
    if (p.type !== "PseudoClassSelector") return false;
    const name = p.name.toLowerCase();
    if (name === "root") return true;
    // `:is(html, .x)` matches the root whenever html does, so one alternative
    // reaching it is enough here, exactly as at the top level.
    if ((name !== "where" && name !== "is") || p.children === null) return false;
    return p.children.toArray().some((c) => c.type === "SelectorList" && c.children.toArray().some(isRootCompound));
  });
}
// A font-size on the root that resolves to the browser default moves nothing;
// `100%` and `1rem` on `html` both compute against the default, so restating it
// is not a finding. Anything else is.
const ROOT_FONT_IDENTITY = new Set([
  "100%",
  "1rem",
  `${ROOT_PX}px`,
  "medium",
  "inherit",
  "initial",
  "unset",
  "revert",
]);
const HEX = /^#[0-9a-f]{3,8}$/i;
const NUMBER = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/i;
const FLUID = new Set(["clamp", "min", "max", "calc"]);
const CALL = /^([a-z][a-z0-9-]*)\(/i;

/**
 * The normal forms, one per kind of value rather than one per dimension: several dimensions have no px value at all (an easing is a function, a layer an
 * integer, a ratio a fraction, a type size is compared in rem and a leading is a
 * multiplier), and `motion` carries both a time and an easing.
 * The kind tag is what keeps a length from ever equalling a time in the `token`
 * dimension, where both are admitted.
 */
/** A numeric token's value and lowercased unit, or null for anything else. */
function splitUnit(text: string): { n: number; unit: string } | null {
  const m = NUMBER.exec(text);
  return m === null ? null : { n: Number(m[1]), unit: m[2].toLowerCase() };
}

function pxNorm(text: string): string | null {
  const v = splitUnit(text);
  if (v === null) return null;
  const { n, unit } = v;
  // `em` gets a norm no step publishes; invariants.sql's em rule reports it
  // in the dimensions lengthLiterals keeps it for.
  if (unit === "em") return "em";
  const px = unit === "px" ? n : unit === "rem" ? n * ROOT_PX : unit === "" && n === 0 ? 0 : null;
  // A fractional px is a rendering artefact, not a rung.
  if (px === null || !Number.isInteger(px)) return null;
  return `px:${px}`;
}

/**
 * A type size, in thousandths of a rem. Not pxNorm: that returns null unless the
 * px conversion is integral, and a type ladder in rem has values that are not
 * (1.05rem is 16.8px, .9rem is 14.4px) — under pxNorm they would vanish rather
 * than fail to join, which is the difference between a rule that finds nothing
 * and a rule that has nothing to find. `em`, `%` and `ch` are relative to the
 * element's own inherited size and comparable to no rung, so they take the same
 * sentinel a hairline in `em` does. A viewport or container unit publishes
 * nothing at all: a size keyed to the viewport is a fluid decision and the
 * ladder has no standing to police it.
 */
function remNorm(text: string): string | null {
  const v = splitUnit(text);
  if (v === null) return null;
  const { n, unit } = v;
  if (unit === "em" || unit === "%" || unit === "ch") return "em";
  const rem = unit === "rem" ? n : unit === "px" ? n / ROOT_PX : null;
  return rem === null ? null : `rem:${Math.round(rem * 1000)}`;
}

function msNorm(text: string): string | null {
  const v = splitUnit(text);
  if (v === null || (v.unit !== "ms" && v.unit !== "s")) return null;
  const ms = v.unit === "s" ? v.n * 1000 : v.n;
  return Number.isInteger(ms) ? `ms:${ms}` : null;
}

/** Whitespace-insensitive, because press writes `cubic-bezier(.2, 0, 0, 1)` and
 * Open Props writes `cubic-bezier(.25,0,.5,1)`. */
function easeNorm(text: string): string | null {
  return /^(cubic-bezier|steps|linear)\(/i.test(text)
    ? `ease:${text.replace(/\s+/g, "").toLowerCase()}`
    : null;
}

function colorNorm(text: string): string | null {
  const t = text.trim();
  if (t.startsWith("#")) {
    const d = t.slice(1).toLowerCase();
    const expand = (s: string) => [...s].map((c) => c + c).join("");
    if (d.length === 3 || d.length === 4) return `#${expand(d)}`;
    if (d.length === 6 || d.length === 8) return `#${d}`;
    return null;
  }
  const call = CALL.exec(t);
  if (call !== null && COLOR_FUNCTIONS.has(call[1].toLowerCase())) {
    // Whitespace is folded, never stripped: in the space syntax it is what
    // separates the channels, so `rgb(1 10 0)` and `rgb(11 0 0)` stay two
    // colours. Around commas, slashes and parens it carries nothing.
    return t.replace(/\s+/g, " ").replace(/\s*([(),\/])\s*/g, "$1").toLowerCase();
  }
  return null;
}

/**
 * The join each dimension implements, as a table rather than a switch with a
 * default: a bucket arrives from the export carrying a dimension this pass may
 * not have a case for, and a default arm would answer it with a length and
 * publish a wrong step in silence. Absent on purpose are `opaque`, whose
 * buckets publish a name and join nothing, and `root`, whose row carries the
 * raw declaration because a ROOT_PX guard has nothing to normalise toward.
 */
const NORM: Record<string, (t: string) => string | null> = {
  space: pxNorm,
  rule: pxNorm,
  radius: pxNorm,
  layer: (t) => /^-?\d+$/.test(t) ? `int:${t}` : null,
  ratio: (t) => /^[\d.]+(\s*\/\s*[\d.]+)?$/.test(t) ? `ratio:${t.replace(/\s+/g, "")}` : null,
  color: colorNorm,
  "shadow-color": colorNorm,
  motion: (t) => msNorm(t) ?? easeNorm(t),
  text: remNorm,
  // Two kinds in one dimension, kept apart by the tag as `motion` keeps a time
  // from an easing: `line-height: 1.5` and `line-height: 1.5rem` are different
  // values and must never join.
  //
  // The leading dot is the number shape CSS admits and a naive `\d+` does not.
  // `.84` would otherwise fall through to remNorm, which wants a unit, and the
  // occurrence would publish NO literal at all — a value no rule can refuse
  // because the scanner never emitted it.
  leading: (t) => {
    const v = splitUnit(t);
    return v !== null && v.unit === "" && !t.startsWith("-") ? `num:${Math.round(v.n * 1000)}` : remNorm(t);
  },
  // A private token declares whatever it likes, so its unit is the only thing
  // that says what kind of value it holds. A bare integer and a fraction are
  // excluded: `--cols: 1` is not a layer.
  token: (t) => pxNorm(t) ?? msNorm(t) ?? easeNorm(t),
};

/** A single value component, normalised for the dimension it sits in. */
function norm(dimension: Dimension, text: string): string | null {
  const join = NORM[dimension];
  if (join === undefined) throw new Error(`this pass implements no join for the dimension ${dimension}`);
  return join(text.trim());
}

/**
 * One value, parsed. css-tree keeps a run it cannot read as a Raw node, except
 * an unquoted url() carrying a quote, which is a bad-url token that fails the
 * whole value. A url's contents are never a literal this lint reads, so they are
 * blanked at their own offsets and the rest is read as written.
 */
function valueTree(value: string): csstree.CssNode {
  const read = (v: string) => csstree.parse(v, { context: "value", positions: true, onParseError: () => {} });
  try {
    return read(value);
  } catch {
    const blanked = value.replace(/url\(([^)]*)\)/gi, (_m, inner: string) => `url(${" ".repeat(inner.length)})`);
    try {
      return read(blanked);
    } catch (e) {
      throw new Error(`css-tree cannot read the value ${JSON.stringify(value)}: ${(e as Error).message}`);
    }
  }
}

type Span = { node: csstree.CssNode; text: string; start: number; end: number };

/**
 * Every node of a value with the source text it spans, in document order,
 * skipping the subtree of each function `drop` names. css-tree hands a `var()`
 * fallback back as raw text, and it is read the same way in turn: a fallback is
 * a second copy of the value it shadows, and the lint refuses it like any other.
 */
function spans(value: string, drop: (name: string) => boolean = () => false): Span[] {
  const out: Span[] = [];
  const visit = (text: string, base: number): void => {
    csstree.walk(valueTree(text), {
      enter(node: csstree.CssNode) {
        if (node.type === "Function" && drop(node.name.toLowerCase())) return csstree.walk.skip;
        const start = node.loc!.start.offset;
        const end = node.loc!.end.offset;
        const span = text.slice(start, end);
        if (node.type === "Raw" && span !== text) return visit(span, base + start);
        out.push({ node, text: span, start: base + start, end: base + end });
      },
    });
  };
  visit(value, 0);
  return out;
}

/** The numbers among a value's spans, outside every function `drop` names. */
function numbersIn(all: Span[], drop: (name: string) => boolean): string[] {
  const dropped = all.filter(({ node }) => node.type === "Function" && drop(node.name.toLowerCase()));
  return all
    .filter(({ node, start }) =>
      (node.type === "Dimension" || node.type === "Number" || node.type === "Percentage") &&
      !dropped.some((d) => start > d.start && start < d.end)
    )
    .map(({ text }) => text);
}

/** A value's top-level components, which are the `transition` shorthand's slots. */
function topLevel(value: string): string[] {
  const root = valueTree(value);
  if (root.type !== "Value") return [value.trim()];
  return root.children.toArray()
    .filter((n) => n.type !== "Operator" && n.type !== "WhiteSpace")
    .map((n) => value.slice(n.loc!.start.offset, n.loc!.end.offset));
}

/** The custom property each `var()` among a value's spans reaches for. */
function varRefsIn(all: Span[]): string[] {
  return all.flatMap(({ node }) => {
    if (node.type !== "Function" || node.name.toLowerCase() !== "var") return [];
    const first = node.children.first;
    return first !== null && first.type === "Identifier" ? [first.name] : [];
  });
}

type Decl = {
  line: number;
  /** Its ordinal in the file: the identity a literal row and a hatch row share,
   * since a hatch attaches to one declaration and (line, prop) is not one — two
   * declarations can share both. */
  decl: number;
  selector: string;
  prop: string;
  value: string;
  block: string;
  excused: string | null;
};

/** One `@import`, with the target exactly as the stylesheet spells it. */
type Import = { line: number; target: string };

const HATCH = /pronto-literal:\s*([a-z-]*)/i;

/** Source text as one line: comments out, whitespace runs collapsed. */
const tidy = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();

const rawText = (node: csstree.CssNode | null) => node !== null && node.type === "Raw" ? node.value : "";

/**
 * Declarations, with the selector they sit under and the text of the block they
 * sit in, read by css-tree. An at-rule's prelude is not a declaration, so
 * `@media (min-width: 720px)` never reaches the length corpus. A hatch comment
 * attaches to the next declaration and to nothing else — not a file, not a
 * block, not a range: one that meets a brace first, or that a second hatch
 * follows before any declaration, is an orphan.
 */
function parse(
  css: string,
): { decls: Decl[]; orphans: { line: number; reason: string }[]; imports: Import[] } {
  const hatches: { line: number; reason: string; start: number; end: number }[] = [];
  const ast = csstree.parse(css, {
    positions: true,
    parseValue: false,
    parseCustomProperty: false,
    parseRulePrelude: false,
    parseAtrulePrelude: false,
    onParseError: () => {},
    onComment: (value, loc) => {
      const m = HATCH.exec(value);
      if (m !== null) {
        hatches.push({ line: loc.start.line, reason: m[1].toLowerCase(), start: loc.start.offset, end: loc.end.offset });
      }
    },
  });
  const decls: (Decl & { start: number; end: number })[] = [];
  const imports: Import[] = [];
  csstree.walk(ast, {
    enter(this: csstree.WalkContext, node: csstree.CssNode) {
      if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
        const target = importTarget(rawText(node.prelude));
        if (target !== null) imports.push({ line: node.loc!.start.line, target });
        return;
      }
      if (node.type !== "Declaration") return;
      const text = tidy(rawText(node.value));
      if (text === "") return;
      const selector = this.rule !== null
        ? tidy(rawText(this.rule.prelude))
        : this.atrule !== null
        ? tidy(`@${this.atrule.name} ${rawText(this.atrule.prelude)}`)
        : "";
      decls.push({
        line: node.loc!.start.line,
        decl: decls.length,
        selector,
        // A property name is ASCII case-insensitive and folded so the dimension
        // tables can be keyed by it — but a CUSTOM property's name is not. Fold
        // one and the quotation join compares a name no archive declared.
        prop: node.property.startsWith("--") ? node.property : node.property.toLowerCase(),
        value: text,
        block: this.block !== null ? css.slice(this.block.loc!.start.offset + 1, this.block.loc!.end.offset - 1) : "",
        excused: null,
        start: node.loc!.start.offset,
        end: node.loc!.end.offset,
      });
    },
  });
  const orphans: { line: number; reason: string }[] = [];
  const claimed = new Map<number, number>();
  hatches.forEach((h, at) => {
    const i = decls.findIndex((d) => d.end > h.end);
    const d = decls[i];
    if (d === undefined || (d.start > h.start && /[{}]/.test(tidy(css.slice(h.end, d.start))))) {
      orphans.push(h);
      return;
    }
    const earlier = claimed.get(i);
    if (earlier !== undefined) orphans.push(hatches[earlier]);
    claimed.set(i, at);
  });
  for (const [i, at] of claimed) decls[i].excused = hatches[at].reason;
  return {
    decls: decls.map(({ start: _start, end: _end, ...d }) => d),
    orphans: orphans.map(({ line, reason }) => ({ line, reason })),
    imports,
  };
}

/** The stylesheet an `@import` names: its first string, or url()'s argument. */
function importTarget(prelude: string): string | null {
  for (const { node } of spans(prelude)) {
    if (node.type === "String" || node.type === "Url") return node.value;
  }
  return null;
}


/** The serving root an absolute path in a served stylesheet is relative to. */
const SERVING_ROOT = "/srv";

/**
 * Every import each stylesheet makes, resolved the way a browser does: against
 * `base`, the served directory the sheet's own URL puts it in. That is not
 * always the directory it is served from — a screen's CSS is injected as a
 * <style> in the document, so its imports resolve against the document — which
 * is why the caller states it rather than this deriving it.
 *
 * `resolved` is null where no local path can be derived — a scheme, or a
 * protocol-relative host — which is equally a path no image carries.
 */
export function resolveImports(
  sheets: { path: string; css: string; base: string }[],
): { path: string; line: number; target: string; resolved: string | null }[] {
  return sheets.flatMap(({ path, css, base }) =>
    parse(css).imports.map(({ line, target }) => ({
      path,
      line,
      target,
      resolved: /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")
        ? null
        : joinPath(target.startsWith("/") ? SERVING_ROOT : base, target),
    }))
  );
}

function joinPath(dir: string, rel: string): string {
  const out = dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** A custom property a stylesheet declares, with what it sits under and reaches for. */
type TokenDeclaration = {
  selector: string;
  token: string;
  value: string;
  colored: boolean;
  refs: string[];
};

/**
 * The emitted design.css read back as rows: which selector declares each
 * token, whether the value carries a colour of its own, and which tokens it
 * reaches for. The emission's own invariants join on these — a colour may not
 * enter the rung block, a token may not be declared under a third selector,
 * and a rung's var() may not name something nothing declares.
 */
export function tokenDeclarations(css: string): TokenDeclaration[] {
  return parse(css).decls
    .filter((d) => d.prop.startsWith("--"))
    .map((d) => {
      const all = spans(d.value);
      return {
        selector: d.selector,
        token: d.prop,
        value: d.value,
        colored: colorLiteralsIn(all).length > 0,
        refs: [...new Set(varRefsIn(all))],
      };
    });
}

/**
 * Every literal a published token already owns. Named for the bulk of what it
 * finds; layer, ratio, leading and the easing half of motion
 * are not lengths, and colour is refused here too.
 */
export function lengthLiterals(css: string): Literal[] {
  return literalsOf(parse(css).decls);
}

function literalsOf(decls: Decl[]): Literal[] {
  const out: Literal[] = [];
  for (const d of decls) {
    const row = (dimension: Dimension, value: string, n: string) =>
      out.push({ line: d.line, decl: d.decl, prop: d.prop, value, dimension, norm: n });
    // A colour is refused on any property, because a duplicate of a published
    // role is a second copy wherever it sits; on a shadow it is refused
    // outright, because the ink roles exist and a shadow list is not a length
    // the join can compare.
    const shadow = d.prop === "box-shadow" || d.prop === "text-shadow";
    const all = spans(d.value);
    for (const c of colorLiteralsIn(all)) row(shadow ? "shadow-color" : "color", c.text, c.norm);
    // A font-size on the root element is the ROOT_PX declaration, never a type
    // choice: it is what every rem rung is compared to a px literal through. So
    // this branch owns it — reporting it where it moves ROOT_PX and reporting
    // nothing where it restates the default — and `text` never sees it.
    if (d.prop === "font-size" && selectsRoot(d.selector)) {
      if (!ROOT_FONT_IDENTITY.has(d.value.trim().toLowerCase())) {
        row("root", d.value, d.value.trim().toLowerCase());
      }
      continue;
    }
    const dimension = d.prop.startsWith("--")
      ? "token"
      : PROPERTY_DIMENSION.find(([re]) => re.test(d.prop))?.[1];
    if (dimension === undefined) continue;
    if (dimension === "layer" || dimension === "ratio") {
      const n = norm(dimension, d.value);
      if (n !== null) row(dimension, d.value.trim(), n);
      continue;
    }
    if (dimension === "motion") {
      for (const p of topLevel(d.value)) {
        if (p.includes("var(")) continue;
        const n = norm(dimension, p);
        if (n !== null) row(dimension, p, n);
      }
      continue;
    }
    // The whole declaration, joining nothing: four dimensions are set at once
    // and no rule here can read any of them. invariants.sql reports the row.
    if (dimension === "shorthand") {
      row(dimension, d.value.trim(), "shorthand");
      continue;
    }
    // A token name's digits and a colour's are never a number. What is
    // deliberately still read is a var() fallback and a calc() operand: a fallback is a second
    // copy of the value that will drift from the token it shadows, and a calc()
    // whose other operand is a literal is arithmetic on a number, not a token.
    //
    // A fluid size is the exception: it is a decision with an explicit range,
    // and naming one operand of `clamp(0.75rem, 1.7dvh, 0.9375rem)` would tell
    // an author to tokenise a bound they chose deliberately. So for `text` those calls are skipped the way a colour function already is, which is
    // also the deferral of fluid steps stated as a mechanism.
    const fluid = dimension === "text";
    for (const t of numbersIn(all, (n) => COLOR_FUNCTIONS.has(n) || (fluid && FLUID.has(n)))) {
      // `em` is kept in rule, radius and text, where invariants.sql's em rule
      // reports it; elsewhere it is text rhythm and untracked.
      const n = norm(dimension, t);
      if (n === null) continue;
      if (n === "em" && dimension !== "rule" && dimension !== "radius" && dimension !== "text") continue;
      row(dimension, t, n);
    }
  }
  return out;
}

/** The colour literals in one value: a hex, or a colour function whose
 * arguments reach for no token. `color-mix(in srgb, var(--accent) 40%,
 * transparent)` is clean, because its colour comes from a token. */
function colorLiteralsIn(all: Span[]): { text: string; norm: string }[] {
  const calls = all.filter(({ node, text }) =>
    node.type === "Function" && COLOR_FUNCTIONS.has(node.name.toLowerCase()) && !/var\(/i.test(text) &&
    colorNorm(text) !== null
  );
  // The outermost literal only. `color-mix(in oklch, #000 55%, transparent)` is
  // one hand-written ink, and reporting the mix and the black it mixes would
  // name one site twice — which is how a rule teaches people to skip it.
  const hexes = all.filter(({ node, text, start }) =>
    node.type === "Hash" && HEX.test(text) && !calls.some((c) => start >= c.start && start < c.end)
  );
  return [...calls, ...hexes].map(({ text }) => ({ text, norm: colorNorm(text)! }));
}

/** Every use of the hatch, so the population is countable rather than silent. */
export function literalExceptions(css: string): Exception[] {
  return exceptionsOf(parse(css));
}

function exceptionsOf({ decls, orphans }: { decls: Decl[]; orphans: { line: number; reason: string }[] }): Exception[] {
  const rows: Exception[] = [
    ...decls.filter((d) => d.excused !== null).map((d) => ({
      line: d.line,
      decl: d.decl,
      prop: d.prop,
      reason: d.excused as string,
      witnessed: /var\(\s*--/.test(d.block),
    })),
    ...orphans.map((o) => ({ line: o.line, decl: null, prop: null, reason: o.reason, witnessed: false })),
  ];
  return rows.sort((a, b) => a.line - b.line || (a.prop ?? "").localeCompare(b.prop ?? ""));
}

/** One ladder under one prefix, as the export carries it. The prefix and the
 * dimension travel with the steps, so this pass reads a vocabulary it does not
 * have to know the shape of. */
type Bucket = {
  prefix: string;
  dimension: Dimension;
  source: string;
  steps: Record<string, string>;
};

/** Where a bucket's bytes came from. `quoted` names an archive vendored under
 * scales/; `own` says there is none. The quotation rules key on a
 * vendored tree answering the source name rather than on this; #Source in
 * schema.cue says why. */
type ScaleSource = { kind: "quoted" | "own"; origin: string; version: string };

export type Scale = { sources: Record<string, ScaleSource>; buckets: Record<string, Bucket> };

// The roles' prefixes stay hardcoded here. #Design is a different namespace
// with a different argument — an app names its own roles and the emitter fixes
// their spelling — and giving it the same (prefix, dimension) treatment is a
// #Design change this one does not make.
const ROLE_PREFIX: Record<string, string> = {
  rounded: "--r-",
  spacing: "--sp-",
  motion: "--motion-",
  control: "--control-",
  measures: "--measure-",
  type: "--type-",
  component: "--c-",
};

const wrongBuckets = (what: string, names: string[]) => {
  if (names.length > 0) throw new Error(`the export ${what}: ${names.sort().join(", ")}`);
};

// A precondition that cannot be met raises; it never degrades. A vocabulary
// that arrived with no buckets, or with a bucket carrying no steps, would
// publish zero steps for it, and every rule joining on those steps would then
// report nothing — which reads as green.
function requireSteps(scale: Scale): void {
  if (Object.keys(scale.buckets).length === 0) {
    throw new Error("the export carries no scale buckets at all");
  }
  wrongBuckets(
    "carries a scale bucket with no steps",
    Object.keys(scale.buckets).filter((b) => Object.keys(scale.buckets[b].steps).length === 0),
  );
}

/** The sources the scale composes, so the quotation rules can ask which archive
 * a step is answerable to. A vendored tree the scale does not draw from owes it
 * nothing, and this is the table that says which those are. */
export function scaleSources(scale: Scale): ({ name: string } & ScaleSource)[] {
  return Object.entries(scale.sources).map(([name, s]) => ({ name, ...s }));
}

/**
 * The rung block the emitter owes, off #scale: the same per-bucket prefix the
 * emitter applies, so the emitted block can be held equal to its source name
 * for name and value for value. Whitespace runs are collapsed on both sides,
 * because that is what reading the CSS back yields.
 *
 * Each row carries its bucket's SOURCE, so the quotation joins a step to the
 * archive its own bucket names. Joining on the token name alone would hold
 * --text-base against whichever vendored tree happened to declare it, which is
 * right only while no two archives share a name.
 */
export function scaleDeclarations(
  scale: Scale,
): { token: string; value: string; source: string; kind: string }[] {
  requireSteps(scale);
  return Object.entries(scale.buckets).flatMap(([name, b]) => {
    const source = scale.sources[b.source];
    if (source === undefined) {
      throw new Error(`the export's scale bucket ${name} names source ${b.source}, which the scale does not carry`);
    }
    return Object.entries(b.steps).map(([k, v]) => ({
      token: `${b.prefix}${k}`,
      value: v.replace(/\s+/g, " ").trim(),
      source: b.source,
      kind: source.kind,
    }));
  });
}

/**
 * The join's other side, off the cue export: #scale's rungs and the design
 * block's roles, one row per (dimension, norm) with the role winning.
 *
 * One level of same-file var() indirection is resolved, so a role defined as a
 * rung — an app whose `spacing` points at the ladder — is still joinable under
 * its own name. It is resolved for every declared token, including the tiers
 * that join nothing, because the resolution is also the reference check.
 */
export function scaleSteps(scale: Scale, design: Record<string, Record<string, string>>): Step[] {
  requireSteps(scale);
  wrongBuckets(
    "carries no design bucket named",
    [...Object.keys(ROLE_PREFIX), "colors", "dark"].filter((b) => design[b] === undefined),
  );

  const values = new Map<string, { value: string; kind: "role" | "rung"; dimension?: Dimension }>();
  for (const [name, b] of Object.entries(scale.buckets)) {
    // Skipped explicitly rather than by a prefix list's silence: a bucket that
    // publishes a name and joins nothing is a decision the vocabulary states,
    // and `min` under `space` would answer `padding: 24px` with --min-touch.
    if (b.dimension === "opaque") continue;
    if (NORM[b.dimension] === undefined) {
      throw new Error(`the export's scale bucket ${name} is dimension ${b.dimension}, which this pass implements no join for`);
    }
    for (const [k, v] of Object.entries(b.steps)) {
      values.set(`${b.prefix}${k}`, { value: v, kind: "rung", dimension: b.dimension });
    }
  }
  const graded = new Set<string>();
  for (const [bucket, prefix] of Object.entries(ROLE_PREFIX)) {
    for (const [k, v] of Object.entries(design[bucket])) {
      values.set(`${prefix}${k}`, { value: v, kind: "role" });
      if (GRADED_ROLES.has(bucket)) graded.add(`${prefix}${k}`);
    }
  }
  // One level of indirection, and the target must be published: a token whose
  // value is a var() nothing declares resolves to nothing at computed-value
  // time, and keeping the raw text would fail norm() and drop the step in
  // silence — the dangling-var failure, discovered by nobody.
  //
  // Resolved for EVERY declared token and not only the ones that go on to join.
  // --control-*, --measure-* and --c-* are absent from ROLE_DIMENSION on purpose,
  // and a check downstream of that gate would have skipped the three tiers whose
  // whole job is to point at another token: --c-field-radius: var(--nope) would
  // be emitted verbatim and caught by nothing.
  const resolved = new Map<string, { value: string; alias: boolean }>();
  for (const [token, { value }] of values) {
    const m = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/.exec(value.trim());
    if (m === null) {
      resolved.set(token, { value, alias: false });
      continue;
    }
    const target = values.get(m[1]);
    if (target === undefined) {
      throw new Error(`${token} is declared ${value}, and nothing publishes ${m[1]}`);
    }
    resolved.set(token, { value: target.value, alias: true });
  }

  type Offer = Step & { alias: boolean };
  const best = new Map<string, Offer>();
  const offer = (step: Offer) => {
    const key = `${step.dimension} ${step.norm}`;
    const held = best.get(key);
    if (held === undefined || wins(step, held)) best.set(key, step);
  };
  for (const [token, { kind, dimension: rung }] of values) {
    // A rung's dimension came with its bucket; only a role still has to be
    // recognised by its name.
    const dimension = rung ?? ROLE_DIMENSION.find(([re]) => re.test(token))?.[1];
    if (dimension === undefined) continue;
    const r = resolved.get(token)!;
    const n = norm(dimension, r.value);
    if (n === null && graded.has(token)) {
      throw new Error(`${token} is declared ${r.value}, which is no ${dimension} this pass reads, so it publishes no step`);
    }
    if (n !== null) offer({ token, dimension, norm: n, kind, alias: r.alias });
  }
  // The appearance half of a role is a step too, so a screen that writes either
  // side of a twin by hand is a duplicate of the same published token.
  for (const bucket of ["colors", "dark"]) {
    for (const [k, v] of Object.entries(design[bucket])) {
      const n = colorNorm(v);
      if (n !== null) offer({ token: `--${k}`, dimension: "color", norm: n, kind: "role", alias: false });
    }
  }
  const offers = [...best.values()];
  // The index a custom property joins against: one token per norm across every
  // length and time dimension, since a private token's unit is the only thing
  // that says which dimension it meant.
  const byNorm = new Map<string, Offer>();
  for (const s of offers) {
    if (!TOKEN_DIMENSIONS.includes(s.dimension)) {
      if (TOKEN_NORM.test(s.norm)) {
        throw new Error(
          `${s.token} is ${s.dimension}, which the private-token index does not carry, ` +
            `and its value normalises to ${s.norm}, which the index joins`,
        );
      }
      continue;
    }
    const held = byNorm.get(s.norm);
    if (held === undefined || wins(s, held)) byNorm.set(s.norm, s);
  }
  for (const s of byNorm.values()) offers.push({ ...s, dimension: "token" });
  return offers.map(({ alias: _alias, ...step }) => step);
}

/**
 * Which of two steps at one norm the message names. Total: every path decides on
 * a stated ground or raises, and none decides by ASCII — a vocabulary whose
 * canonical name is picked by a vendor's spelling teaches the wrong name with the
 * same confidence as the right one.
 */
function wins(a: Step & { alias: boolean }, b: Step & { alias: boolean }): boolean {
  if (a.kind !== b.kind) return a.kind === "role";
  // An alias holds its target's value by construction, so a tie between them is
  // not a tie: naming the alias would send an author to the indirection.
  if (a.alias !== b.alias) return !a.alias;
  if (a.dimension !== b.dimension) {
    const ra = TOKEN_DIMENSIONS.indexOf(a.dimension);
    const rb = TOKEN_DIMENSIONS.indexOf(b.dimension);
    // Only the private-token index compares across dimensions, and it admits
    // only members — so an unranked side here means the index took a step the
    // guard above should have refused.
    if (ra < 0 || rb < 0) {
      throw new Error(`${(ra < 0 ? a : b).token} is ${(ra < 0 ? a : b).dimension}, which carries no private-token rank`);
    }
    return ra < rb;
  }
  // The same name on both sides is one published token offered twice, its twin
  // repeating a value across appearances, and not two names for one value.
  if (a.token === b.token) return false;
  // A colour dimension carries only roles, and two roles at one colour is an
  // identity an app states: w3caria's --surface IS its --neutral, and shadcnui's
  // --primary is its --neutral read in the other appearance. Declaration order
  // decides, which is a reviewed line rather than ASCII — and `colors` is offered
  // before `dark`, so the name a literal is answered with is one whose LIGHT
  // value is that literal.
  if (a.dimension === "color") return false;
  const [first, second] = [a.token, b.token].sort();
  throw new Error(`${first} and ${second} are both ${a.norm} in ${a.dimension}, and a value may not be spelled twice`);
}

// ── the fixture ───────────────────────────────────────────────────────────────

// The vendored tree FIXTURE_VENDOR_CSS is the archive of.
export const FIXTURE_VENDOR_SOURCE = { name: "fixture", origin: "a vendored vocabulary", version: "0" };

// A scale small enough to read and wide enough to carry every dimension: one
// negative rung, the three rule widths that matter, one easing, two layers, one
// ratio, and the two opaque buckets that publish a name and join nothing.
//
// Both source kinds, because the exemption is the half a fixture can lose: the
// opaque buckets name a source NO vendored tree answers and every other bucket is
// answerable to FIXTURE_VENDOR_CSS, so the witness rule has something to acquit
// and something to convict. Being answered by a tree, not `kind`, is what
// the rule keys on.
export const FIXTURE_SCALE: Scale = {
  sources: {
    fixture: { kind: "quoted", origin: FIXTURE_VENDOR_SOURCE.origin, version: FIXTURE_VENDOR_SOURCE.version },
    pronto: { kind: "own", origin: "pronto", version: "this repository" },
  },
  buckets: {
    size: {
      prefix: "--size-",
      dimension: "space",
      source: "fixture",
      steps: { "00": "-.25rem", "1": ".25rem", "2": ".5rem", "3": "1rem", "4": "1.25rem" },
    },
    border: {
      prefix: "--border-",
      dimension: "rule",
      source: "fixture",
      steps: { "size-1": "1px", "size-2": "2px", "size-3": "5px" },
    },
    shadow: {
      prefix: "--shadow-",
      dimension: "opaque",
      source: "pronto",
      steps: { "1": "0 1px 2px -1px var(--shadow-ink-10)" },
    },
    ease: {
      prefix: "--ease-",
      dimension: "motion",
      source: "fixture",
      steps: { "3": "cubic-bezier(.25,0,.3,1)" },
    },
    layer: { prefix: "--layer-", dimension: "layer", source: "fixture", steps: { "1": "1", "2": "2" } },
    ratio: { prefix: "--ratio-", dimension: "ratio", source: "fixture", steps: { widescreen: "16/9" } },
    min: { prefix: "--min-", dimension: "opaque", source: "pronto", steps: { touch: "24px" } },
    // --text-base is 1rem and --size-3 is 1rem, which is the collision the
    // cases below pin: a literal's dimension is its property's, so a font-size
    // can never be answered with a space rung.
    text: {
      prefix: "--text-",
      dimension: "text",
      source: "fixture",
      steps: { sm: "0.875rem", base: "1rem" },
    },
    leading: {
      prefix: "--leading-",
      dimension: "leading",
      source: "fixture",
      steps: { normal: "1.5" },
    },
  },
};

// The archive that fixture scale quotes, in the shape a vendored tree ships:
// minified CSS under one selector. It carries one refused family
// (`--size-px-*`), and `--shadow-1` under the upstream colour the scale
// republishes over its own inks — so the quotation rule's skip is exercised in
// both of its forms, a name refused with a reason and a name (`--min-touch`) no
// archive declares at all.
export const FIXTURE_VENDOR_CSS =
  ":where(html){--size-00:-.25rem;--size-1:.25rem;--size-2:.5rem;--size-3:1rem;" +
  "--size-4:1.25rem;--size-px-1:4px;--border-size-1:1px;--border-size-2:2px;" +
  "--border-size-3:5px;--shadow-1:0 1px 2px -1px hsl(var(--shadow-color)/var(--shadow-strength-10));" +
  "--ease-3:cubic-bezier(.25,0,.3,1);--layer-1:1;--layer-2:2;--ratio-widescreen:16/9;" +
  "--text-sm:0.875rem;--text-base:1rem;--text-shadow-sm:0 1px 0 #0001;--leading-normal:1.5}";

export const FIXTURE_VENDOR_EXCLUSIONS = [
  {
    source: "fixture",
    pattern: "^--size-px-",
    reason: "a device-pixel spelling of the rem ladder",
  },
  {
    source: "fixture",
    pattern: "^--shadow-[1-6]$",
    reason: "the geometry is quoted and the colour is not",
  },
  // The nesting case, refused before --text- is read: a vendor that publishes
  // --text-xs beside --text-shadow-xs is a vocabulary, not a hazard.
  {
    source: "fixture",
    pattern: "^--text-shadow-",
    reason: "an elevation is a list rather than a value",
  },
];

// The roles the spec's case table names, plus one colour and its twin, and the
// one ink #scale.shadow reaches for — without it the fixture's rung block would
// carry a var() nothing declares, which is itself one of the rules below.
export const FIXTURE_ROLES: Record<string, Record<string, string>> = {
  colors: { primary: "#09090B", "shadow-ink-10": "hsl(220 3% 15% / 10%)" },
  dark: { primary: "#FAFAFA", "shadow-ink-10": "hsl(220 40% 2% / 34%)" },
  rounded: { sm: "6px" },
  spacing: { md: "16px", xl: "40px" },
  motion: { fast: "110ms", base: "180ms", shift: "6px" },
  control: { h: "36px", "h-lg": "40px" },
  measures: { page: "720px" },
  // Both kinds the one mixed role space carries, so the two ROLE_DIMENSION rows
  // are exercised in the order that decides them.
  type: { body: ".8125rem", "leading-prose": "1.6" },
  // Points at a role, and publishes no step of its own — so it is the case that
  // pins the reference check reaching a tier ROLE_DIMENSION never classifies.
  component: { "field-radius": "var(--r-sm)" },
};

/**
 * What the shared layer would declare for that fixture — the redeclaration
 * rule's side of the join, so one case can exercise both rules at once.
 */
export function fixtureOwned(): Set<string> {
  const owned = new Set<string>();
  for (const b of Object.values(FIXTURE_SCALE.buckets)) {
    for (const k of Object.keys(b.steps)) owned.add(`${b.prefix}${k}`);
  }
  for (const [bucket, prefix] of Object.entries(ROLE_PREFIX)) {
    for (const k of Object.keys(FIXTURE_ROLES[bucket] ?? {})) owned.add(`${prefix}${k}`);
  }
  for (const k of Object.keys(FIXTURE_ROLES.colors)) owned.add(`--${k}`);
  return owned;
}

/**
 * The emission the fixture stands in for, written out rather than generated:
 * the rung block is held equal to FIXTURE_SCALE by one of the rules it feeds,
 * so a copy that drifts is what that rule exists to catch.
 */
export const FIXTURE_DESIGN_CSS = `:where(html) {
  --size-00: -.25rem;
  --size-1: .25rem;
  --size-2: .5rem;
  --size-3: 1rem;
  --size-4: 1.25rem;
  --border-size-1: 1px;
  --border-size-2: 2px;
  --border-size-3: 5px;
  --shadow-1: 0 1px 2px -1px var(--shadow-ink-10);
  --ease-3: cubic-bezier(.25,0,.3,1);
  --layer-1: 1;
  --layer-2: 2;
  --ratio-widescreen: 16/9;
  --min-touch: 24px;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --leading-normal: 1.5;
}
:root {
  --primary: light-dark(#09090B, #FAFAFA);
  --shadow-ink-10: light-dark(hsl(220 3% 15% / 10%), hsl(220 40% 2% / 34%));
  --r-sm: 6px;
  --sp-md: 16px;
  --sp-xl: 40px;
  --motion-fast: 110ms;
  --motion-base: 180ms;
  --motion-shift: 6px;
  --control-h: 36px;
  --control-h-lg: 40px;
  --measure-page: 720px;
  --type-body: .8125rem;
  --type-leading-prose: 1.6;
  --c-field-radius: var(--r-sm);
  color-scheme: light dark;
}
.screen[data-state$="-dark"] {
  color-scheme: dark;
}
`;

/**
 * One stylesheet the rule of record is run over, and what it must report.
 *
 * `want` counts every row invariants.sql yields for the case — the ledger row a
 * hatch prints included, since a hatch that reported nothing would be a
 * silence. check-facts.ts grades these by running the SQL itself, so what has
 * judgment in it (which property is which dimension, what a norm is, which
 * reasons the hatch admits) is asserted where it is decided rather than beside
 * a second implementation of it.
 */
/** `debt` marks a case wearing a pending hatch over a literal a hatch can excuse:
 * summed, the cases' `meta.design.pendingLiterals`, which the SQL budget
 * equality grades. */
type LiteralCase = { css: string; want: number; token?: string; pins: string; debt?: true };

export const LITERAL_CASES: LiteralCase[] = [
  {
    css: ".x { border: 1px solid var(--border); }",
    want: 1,
    token: "--border-size-1",
    pins: "a length inside a shorthand — the dominant case",
  },
  {
    css: ".x { padding: 6px 10px; }",
    want: 0,
    pins: "no rung exists, and this is what keeps the rule usable",
  },
  { css: ".x { margin: 4px; }", want: 1, token: "--size-1", pins: "rem against px at ROOT_PX" },
  {
    css: ".x { gap: 1px; }",
    want: 0,
    pins: "dimension discipline: 1px is a rule width, never a space rung",
  },
  {
    css: ".x { min-height: 4px; }",
    want: 0,
    pins: "control geometry is never a finding, even at a rung",
  },
  { css: ".x { max-width: 720px; }", want: 0, pins: "a measure is never a finding" },
  { css: ".x { margin: 16px; }", want: 1, token: "--sp-md", pins: "the role wins the message" },
  {
    css: ".x { padding: 40px; }",
    want: 1,
    token: "--sp-xl",
    pins: "the token to dimension map: --control-h-lg publishes no step",
  },
  {
    css: ".x { transition: opacity var(--motion-fast) cubic-bezier(.25,0,.3,1); }",
    want: 1,
    token: "--ease-3",
    pins: "easing norm, spacing-insensitive",
  },
  {
    css: ".x { transition-timing-function: cubic-bezier(.25,0,.3,1); }",
    want: 1,
    token: "--ease-3",
    pins: "the longhand is the shorthand's easing slot under another spelling",
  },
  {
    css: ".x { animation-delay: 180ms; }",
    want: 1,
    token: "--motion-base",
    pins: "and the delay longhand is a time in the same dimension",
  },
  { css: ".x { transition: opacity 180ms; }", want: 1, token: "--motion-base", pins: "time norm" },
  { css: ".x { z-index: 1; }", want: 1, token: "--layer-1", pins: "a unitless dimension" },
  {
    css: ".x { aspect-ratio: 16/9; }",
    want: 1,
    token: "--ratio-widescreen",
    pins: "a ratio is not a length",
  },
  { css: ".x { padding: 0.25em; }", want: 0, pins: "em is untracked in space" },
  { css: ".x { border: 0.0625em solid; }", want: 1, pins: "em is refused in rule" },
  { css: ".x { border-radius: 0.5em; }", want: 1, pins: "and in radius" },
  {
    css: ".x { box-shadow: 0 4px 12px rgb(0 0 0 / 10%); }",
    want: 1,
    pins: "geometry is not joined, the ink is",
  },
  {
    css: ".x { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent); }",
    want: 0,
    pins: "a token-derived colour is clean",
  },
  {
    css: ".x { box-shadow: 0 1px 2px color-mix(in oklch, #000 55%, transparent); }",
    want: 1,
    pins: "the outermost literal only: a mix and the black it mixes are one site",
  },
  {
    css: ".x { box-shadow: 0 1px 2px color-mix(in oklch, var(--accent) 55%, #000); }",
    want: 1,
    pins: "and a hand-written ink inside a token-derived mix is still reported once",
  },
  {
    css: ".x { --otp-pad: 4px; }",
    want: 1,
    token: "--size-1",
    pins: "a private token is not a hiding place",
  },
  { css: ".x { --otp-pad: calc(var(--control-h) / 9); }", want: 0, pins: "the intended shape" },
  {
    css: "@media (min-width: 720px) {\n  .x { color: red; }\n}",
    want: 0,
    pins: "at-rule preludes are not declarations",
  },
  {
    css: ".x { color: #09090b; }",
    want: 1,
    token: "--primary",
    pins: "hex lowercased and expanded before comparison",
  },
  {
    css: ".x { color: #FFF; }",
    want: 0,
    pins: "a colour no role publishes is the app's own",
  },
  {
    css: ".x { color: #fafafa; }",
    want: 1,
    token: "--primary",
    pins: "the dark half of the same role counts too",
  },
  {
    css: ".x { color: var(--primary); /* pronto-literal: derived */ margin: 4px; padding: 4px; }",
    want: 2,
    pins: "the hatch covers the NEXT declaration only, and prints its ledger row",
  },
  {
    css: ".x {\n  color: var(--primary);\n  /* pronto-literal: derived */\n  margin: 4px;\n  padding: 4px;\n}",
    want: 2,
    pins: "and the same one declaration when each sits on its own line",
  },
  {
    css: ".x { /* pronto-literal: derived */ margin: 4px; }",
    want: 2,
    pins: "derived needs a subject: no token in the block, no claim",
  },
  {
    css: ".x { color: var(--primary);\n  /* pronto-literal: derived */\n  transform: translateX(20px); }",
    want: 1,
    pins: "the case the hatch exists for: arithmetic no calc() can state, ledgered",
  },
  {
    css: ".x { /* pronto-literal: physical */ border: 1px solid var(--border); }",
    want: 3,
    pins: "the enum is closed and physical is gone, so it excuses nothing",
  },
  { css: "html { font-size: 18px; }", want: 1, pins: "the ROOT_PX coupling is checked, not assumed" },
  {
    css: "html[data-theme] { font-size: 18px; }",
    want: 1,
    pins: "a root selector wearing an attribute, class or pseudo is still the root, so the guard reads it",
  },
  {
    css: ":where(html) { font-size: 100%; }",
    want: 0,
    pins: "100% on the root IS ROOT_PX, so restating the default moves nothing",
  },
  {
    css: ".x { /* pronto-literal: pending */ padding: 4px; } .y { padding: 4px; }",
    want: 2,
    token: "--size-1",
    debt: true,
    pins: "a hatch excuses ONE declaration: a second literal on the same line and property is still refused",
  },
  {
    css: "/* pronto-literal: pending */\n.x { color: var(--primary); }",
    want: 1,
    pins: "an orphan hatch is ledgered and excuses nothing, so it counts toward no budget",
  },
  {
    css: ".x { /* pronto-literal: pending */ color: var(--primary); }",
    want: 1,
    pins: "a hatch over a declaration with no literal is ledgered and is not debt, so a fixed site with its comment left behind lowers the number",
  },
  {
    css: ":root::before { font-size: 17px; }",
    want: 0,
    pins: "a pseudo-element on the root is a box that is not the root, so it does not move ROOT_PX (and 17px is no text rung)",
  },
  {
    css: ":where( html ) { font-size: 20px; }",
    want: 1,
    pins: "spaces inside :where() are still the root, read off the parsed selector",
  },
  {
    css: ":is(html, .x) { font-size: 20px; }",
    want: 1,
    pins: "one alternative of :is() reaching the root is enough, as one selector of a list is",
  },
  {
    css: "html { /* pronto-literal: pending */ font-size: 18px; }",
    want: 2,
    pins: "a hatch over the root font-size is ledgered, excuses nothing, and is not debt",
  },
  {
    css: ".x { transition: transform .18s; }",
    want: 1,
    token: "--motion-base",
    pins: "the time norm is ms, so .18s and 180ms are one value",
  },
  {
    css: ":root { --sp-md: 16px; }",
    want: 2,
    pins: "redeclaration and literal are independent rules over one line",
  },

  // ── adversarial ────────────────────────────────────────────────────────────
  {
    css: ".x { padding: var(--gap, 4px); }",
    want: 1,
    token: "--size-1",
    pins: "a fallback is a second copy of the value that will drift from the token it shadows",
  },
  {
    css: ".x { padding: calc(100% - 4px); }",
    want: 1,
    token: "--size-1",
    pins: "calc() is not a hiding place either; only its unitless operands are exempt",
  },
  {
    css: "@media (min-width: 1px) {\n  .x { color: red; }\n}",
    want: 0,
    pins: "a prelude length is not a rule width — the at-rule is not descended",
  },
  {
    css: ".x { font-size: 16px; }",
    want: 1,
    token: "--text-base",
    pins: "a px size joins a rem rung through ROOT_PX, the same way a length does",
  },
  {
    css: ".x { font-size: 1rem; }",
    want: 1,
    token: "--text-base",
    // --size-3 is 1rem too. A literal's dimension is its property's and never
    // its unit, which is the whole reason the two namespaces can share a value.
    pins: "a font-size is never answered with a space rung, even at the same length",
  },
  {
    css: ".x { padding: 1rem; }",
    want: 1,
    token: "--sp-md",
    pins: "and the collision reads the other way too: a padding is never answered with a text rung",
  },
  {
    css: ".x { font-size: 1.05rem; }",
    want: 0,
    pins: "16.8px is not integral, and remNorm keeps it rather than dropping it as pxNorm would",
  },
  {
    css: ".x { font-size: 1.2em; }",
    want: 1,
    pins: "a size keyed to the inherited size is comparable to no rung, and reports as such",
  },
  {
    css: ".x { font-size: 2cqmin; }",
    want: 0,
    pins: "a size keyed to the viewport is a fluid decision the ladder has no standing to police",
  },
  {
    css: ".x { font-size: clamp(0.75rem, 1.7dvh, 0.9375rem); }",
    want: 0,
    pins: "and naming one operand of a deliberate range is how a rule teaches people to distrust it",
  },
  {
    css: ".x { line-height: 1.5; }",
    want: 1,
    token: "--leading-normal",
    pins: "a unitless leading",
  },
  {
    css: ".x { line-height: 1.5rem; }",
    want: 0,
    pins: "and a length leading is a different value, kept apart by the tag as motion keeps a time from an easing",
  },
  {
    css: ".x { font-size: .8125rem; }",
    want: 1,
    token: "--type-body",
    pins: "a size the ladders have no step for, named as a role because a screen asked",
  },
  {
    css: ".x { line-height: 1.6; }",
    want: 1,
    token: "--type-leading-prose",
    pins: "and the one mixed role space reads leading-* first, or a line-height would be offered a font size",
  },
  {
    css: ".x { font: 600 1rem/1.5 system-ui; }",
    want: 1,
    pins: "a shorthand sets four dimensions and no rule can read one, so it reports as itself",
  },
  {
    css: ".x { font: inherit; }",
    want: 0,
    pins: "and a shorthand that sets nothing this rule could refuse is not a finding",
  },
  { css: ".x { margin: 0; }", want: 0, pins: "a unitless 0 lands on no rung, in any dimension" },
  { css: ".x { padding: 50%; }", want: 0, pins: "a percentage has no px value to compare" },
  {
    css: ".x { border-width: 1.5px; }",
    want: 0,
    pins: "a fractional px is a rendering artefact, not a rung",
  },
  {
    css: ".x { --cols: 1; }",
    want: 0,
    pins: "a bare integer in a private token is not a layer — the token index carries only units",
  },
  {
    css: ".x { background: url(data:image/svg+xml;utf8,<svg width='1px'/>); }",
    want: 0,
    pins: "a url() carries a semicolon and a length, and is neither a declaration break nor a rule width",
  },
  {
    css: '@import "./ok.css";\n.x { color: red; }',
    want: 0,
    pins: "an import the image carries resolves, and no other rule here follows an import",
  },
  {
    css: '@import "./gone.css";\n.x { color: red; }',
    want: 1,
    pins: "a browser ignores a failed import in silence, so nothing else would ever say it",
  },
];

/**
 * What the fixture's image carries: each case at its own path, plus the one
 * file an import above is allowed to reach.
 */
export function fixtureServed(): { file: string; target: string }[] {
  return [
    ...LITERAL_CASES.map((_c, i) => ({ file: casePath(i), target: `/srv/${casePath(i)}` })),
    { file: "ok.css", target: "/srv/ok.css" },
    { file: "shell/design.css", target: "/srv/shell/design.css" },
  ];
}

/** One case's stylesheet path, which is how a finding names the case it came from. */
export function casePath(i: number): string {
  return `case-${String(i).padStart(2, "0")}.css`;
}

/** The scanner's cases, run from derive.ts's self-test. */
export function styleSelfTest(): string[] {
  const failures: string[] = [];

  // ── the palette's one declaration ──────────────────────────────────────────
  const owned = ownedTokens(":root {\n  --primary: #000;\n  --r-sm: 6px;\n}");
  const tokenCases: [string, number][] = [
    // Consuming an owned token is the point.
    [".card { color: var(--primary); border-radius: var(--r-sm); }", 0],
    // Redeclaring one is the fork.
    [":root { --primary: #fff; }", 1],
    // Inside a media query counts too — dark twins are where this hides.
    ["@media (prefers-color-scheme: dark) {\n  :root { --primary: #fff; }\n}", 1],
    // A screen's own private token is its business.
    [".card { --card-gap: 4px; padding: var(--card-gap); }", 0],
    // Reported once per token however often it repeats.
    [":root { --primary: #fff; }\n.x { --primary: #eee; }", 1],
    // A declaration right after a comment close, which the scanner allows for and
    // nothing exercised.
    [":root { /* palette */ --primary: #fff; }", 1],
    // Two different owned tokens are two findings.
    [":root { --primary: #fff; --r-sm: 2px; }", 2],
  ];
  for (const [css, want] of tokenCases) {
    // The overlap the join computes: the tokens a screen declares that the
    // shared layer already owns, each counted once however often it repeats.
    const got = [...ownedTokens(css)].filter((t) => owned.has(t)).length;
    if (got !== want) {
      failures.push(`style: want ${want} owned tokens, got ${got}: ${JSON.stringify(css)}`);
    }
  }

  // ── a leading dot is a number, and an unscanned value is an unrefusable one ─
  // `.84` is a unitless leading, not a length remNorm could read, and a value
  // the scanner does not emit is one no rule can refuse. realworld's drop cap is
  // the corpus's one such value. Asserted here rather than in LITERAL_CASES
  // because the finding is the row's absence, and that harness can only see a
  // row that joins.
  const dotted = lengthLiterals(".x { line-height: .84; }");
  if (dotted.length !== 1 || dotted[0].norm !== "num:840") {
    failures.push(`style: want line-height .84 to publish num:840, got ${JSON.stringify(dotted)}`);
  }
  if (JSON.stringify(lengthLiterals(".x { line-height: 0.84; }").map((l) => l.norm)) !== '["num:840"]') {
    failures.push("style: the two spellings of one number must normalise alike");
  }

  // ── a custom property's name keeps its case, every other name loses it ─────
  // A custom property is case-SENSITIVE, and the shipping scale has a camelCase
  // ladder: folded, the quotation join would compare --base-text-lineheight-tight
  // against an archive that declares no such name, and every step of Primer's
  // leading bucket would read as unquoted.
  const cased = tokenDeclarations(":root { --base-text-lineHeight-tight: 1.25; COLOR: red; }");
  if (cased.length !== 1 || cased[0].token !== "--base-text-lineHeight-tight") {
    failures.push(`style: a custom property's name must keep its case, got ${JSON.stringify(cased)}`);
  }
  if (parse(":root { COLOR: red; }").decls[0].prop !== "color") {
    failures.push("style: a non-custom property name must fold, since PROPERTY_DIMENSION is keyed by it");
  }

  // ── the hatch is a ledger, not a silence ───────────────────────────────────
  const hatches: { css: string; want: Exception[]; pins: string }[] = [
    {
      css: ".x { color: var(--primary);\n  /* pronto-literal: derived */\n  transform: translateX(20px); }",
      want: [{ line: 3, decl: 1, prop: "transform", reason: "derived", witnessed: true }],
      pins: "the row carries the declaration it excuses, which is what the join suppresses",
    },
    {
      css: ".x {\n  /* pronto-literal: pending */\n  gap: 6px;\n  /* pronto-literal: pending */\n  gap: 10px; }",
      want: [
        { line: 3, decl: 0, prop: "gap", reason: "pending", witnessed: false },
        { line: 5, decl: 1, prop: "gap", reason: "pending", witnessed: false },
      ],
      pins: "every use is a row, so `count(pending) = pendingLiterals` is countable",
    },
    {
      css: "/* pronto-literal: derived */\n.x { margin: 4px; }",
      want: [{ line: 1, decl: null, prop: null, reason: "derived", witnessed: false }],
      pins: "a hatch that reaches no declaration still reports, rather than vanishing",
    },
  ];
  for (const h of hatches) {
    const got = literalExceptions(h.css);
    if (JSON.stringify(got) !== JSON.stringify(h.want)) {
      failures.push(
        `style: hatch rows ${JSON.stringify(got)}, want ${JSON.stringify(h.want)} — ` +
          `${h.pins}: ${JSON.stringify(h.css)}`,
      );
    }
  }

  // ── a colour's norm keeps the spaces that separate its channels ────────────
  // `rgb(1 10 0)` and `rgb(11 0 0)` are two colours; a norm that strips every
  // space folds them into one and the second role is silently dropped.
  const spaced = scaleSteps(FIXTURE_SCALE, {
    ...FIXTURE_ROLES,
    colors: { a: "rgb(1 10 0)", b: "rgb(11 0 0)" },
    dark: { a: "rgb(0 0 1)", b: "rgb(0 1 0)" },
  }).filter((s) => s.dimension === "color" && (s.token === "--a" || s.token === "--b"));
  if (spaced.length !== 4 || new Set(spaced.map((s) => s.norm)).size !== 4) {
    failures.push(
      `style: rgb(1 10 0) and rgb(11 0 0) and their twins must publish four distinct colour steps, got ${JSON.stringify(spaced)}`,
    );
  }

  // ── one level of var() indirection, so a role defined as a rung is joinable ─
  const indirect = scaleSteps(FIXTURE_SCALE, {
    ...FIXTURE_ROLES,
    spacing: { md: "var(--size-3)", xl: "40px" },
  }).find((s) => s.dimension === "space" && s.norm === "px:16");
  if (indirect?.token !== "--sp-md") {
    failures.push(
      `style: --sp-md: var(--size-3) must still publish px:16 under its own name, got ${
        JSON.stringify(indirect ?? null)
      }`,
    );
  }
  // An opaque bucket publishes a name and joins nothing. Asserted rather than
  // assumed because the skip is one line and its absence is silent: --min-touch
  // under `space` would answer `padding: 24px` with a touch floor.
  for (const token of ["--min-touch", "--shadow-1"]) {
    if (scaleSteps(FIXTURE_SCALE, FIXTURE_ROLES).some((s) => s.token === token)) {
      failures.push(`style: ${token} is an opaque bucket's step and must join no literal`);
    }
  }

  // ── an import resolves against its base, not against its own path ──────────
  const resolved = resolveImports([{
    path: "shell/screens/home.css",
    base: "/srv/shell",
    css: '@import "./shared/screen.css";\n@import "../docs/x.css";\n@import url(/shell/a.css);\n' +
      '@import "https://fonts.example/x.css";',
  }]).map((i) => i.resolved);
  const wantResolved = ["/srv/shell/shared/screen.css", "/srv/docs/x.css", "/srv/shell/a.css", null];
  if (JSON.stringify(resolved) !== JSON.stringify(wantResolved)) {
    failures.push(
      `style: imports resolved ${JSON.stringify(resolved)}, want ${JSON.stringify(wantResolved)}`,
    );
  }

  // ── an alias never outranks the step it points at ──────────────────────────
  // --ease-1 sorts before --ease-3, so lexicographic order alone would name the
  // indirection; the corpus's own --ease-elastic-N are exactly this shape.
  const aliased = scaleSteps(
    {
      sources: FIXTURE_SCALE.sources,
      buckets: {
        ...FIXTURE_SCALE.buckets,
        ease: {
          ...FIXTURE_SCALE.buckets.ease,
          steps: { "3": "cubic-bezier(.25,0,.3,1)", "1": "var(--ease-3)" },
        },
      },
    },
    FIXTURE_ROLES,
  ).find((s) => s.dimension === "motion" && s.norm === "ease:cubic-bezier(.25,0,.3,1)");
  if (aliased?.token !== "--ease-3") {
    failures.push(
      `style: an alias must lose to the step it points at, got ${JSON.stringify(aliased ?? null)}`,
    );
  }

  // ── two roles at one colour is an identity, not a value spelled twice ──────
  // A surface equal to the page ground, and a twin whose halves are each other's,
  // are both in the corpus. Refusing them would make the app restate a colour it
  // deliberately shares; declaration order names one, and this pins which.
  const twinned = scaleSteps(FIXTURE_SCALE, {
    ...FIXTURE_ROLES,
    colors: { ...FIXTURE_ROLES.colors, ground: "#09090B" },
  }).find((s) => s.dimension === "color" && s.norm === "#09090b");
  if (twinned?.token !== "--primary") {
    failures.push(`style: the colour declared first must name the value, got ${JSON.stringify(twinned ?? null)}`);
  }

  // ── the private-token index's membership is derived, not believed ──────────
  // TOKEN_DIMENSIONS is four of the nine, and its completeness is the claim that
  // no step outside it can carry a norm the `token` join also produces. `em` is
  // the one crack: remNorm hands it to `text` and `leading` too, so a rung there
  // in em would be dropped from the index in silence.
  for (const b of Object.values(FIXTURE_SCALE.buckets)) {
    if (b.dimension === "opaque" || TOKEN_DIMENSIONS.includes(b.dimension)) continue;
    for (const [k, v] of Object.entries(b.steps)) {
      const n = norm(b.dimension, v);
      if (n !== null && TOKEN_NORM.test(n)) {
        failures.push(`style: ${b.prefix}${k} normalises to ${n} from ${b.dimension}, and the private-token index is keyed by that norm`);
      }
    }
  }

  // ── the preconditions raise rather than publish nothing ────────────────────
  const withBuckets = (buckets: Record<string, Bucket>): Scale => ({
    sources: FIXTURE_SCALE.sources,
    buckets: { ...FIXTURE_SCALE.buckets, ...buckets },
  });
  const without = (m: Record<string, Record<string, string>>, bucket: string) => {
    const copy = { ...m };
    delete copy[bucket];
    return copy;
  };
  const raises: { pins: string; run: () => unknown; want: string }[] = [
    {
      pins: "a vocabulary that arrived with nothing in it would refuse no literal anywhere",
      run: () => scaleSteps({ sources: {}, buckets: {} }, FIXTURE_ROLES),
      want: "the export carries no scale buckets at all",
    },
    {
      pins: "and a bucket whose steps stopped arriving is the same silence, one ladder wide",
      run: () => scaleSteps(withBuckets({ ease: { ...FIXTURE_SCALE.buckets.ease, steps: {} } }), FIXTURE_ROLES),
      want: "the export carries a scale bucket with no steps: ease",
    },
    {
      pins: "a dimension this pass has no join for would publish a wrong step under a default arm",
      run: () =>
        scaleSteps(
          withBuckets({
            typography: {
              prefix: "--typography-",
              dimension: "typography" as Dimension,
              source: "x",
              steps: { "1": "1rem" },
            },
          }),
          FIXTURE_ROLES,
        ),
      want: "the export's scale bucket typography is dimension typography, which this pass implements no join for",
    },
    {
      pins: "the role side has the same hole",
      run: () => scaleSteps(FIXTURE_SCALE, without(FIXTURE_ROLES, "spacing")),
      want: "the export carries no design bucket named: spacing",
    },
    {
      pins: "a role pointing at nothing resolves to nothing at computed-value time",
      run: () => scaleSteps(FIXTURE_SCALE, { ...FIXTURE_ROLES, spacing: { md: "var(--nope)" } }),
      want: "--sp-md is declared var(--nope), and nothing publishes --nope",
    },
    // The three tiers ROLE_DIMENSION never classifies, one case each. A check
    // downstream of the dimension gate passes all three, because the token is
    // dropped before anything reads its value — and the emitter writes it into
    // :root regardless, where the reference resolves to nothing in silence.
    ...(["component", "control", "measures"] as const).map((bucket) => ({
      pins: `a ${bucket} token pointing at nothing is emitted and applies to nothing`,
      run: () => scaleSteps(FIXTURE_SCALE, { ...FIXTURE_ROLES, [bucket]: { x: "var(--nope)" } }),
      want: `${ROLE_PREFIX[bucket]}x is declared var(--nope), and nothing publishes --nope`,
    })),
    {
      // #Scale.joined refuses this composition in the export; the raise reaches
      // what an index over dimensions cannot — two steps in ONE bucket whose
      // spellings normalise alike. Without it the canonical name would be
      // whichever token sorts first, a vendor's spelling deciding what the lint
      // teaches.
      pins: "two buckets in one joining dimension leave the canonical name to ASCII order",
      run: () =>
        scaleSteps(
          withBuckets({
            borderWidth: {
              prefix: "--borderWidth-",
              dimension: "rule",
              source: "fixture",
              steps: { thin: "0.0625rem" },
            },
          }),
          FIXTURE_ROLES,
        ),
      want: "--border-size-1 and --borderWidth-thin are both px:1 in rule, and a value may not be spelled twice",
    },
    {
      // The one shape that can cross the boundary: remNorm gives `text` and
      // `leading` the same `em` sentinel pxNorm gives the `token` join, so a rung
      // there is a step the index would drop without saying so.
      pins: "a step outside the private-token index carrying a norm the index joins",
      run: () =>
        scaleSteps(
          withBuckets({
            typeEm: { prefix: "--type-em-", dimension: "text", source: "fixture", steps: { x: "1em" } },
          }),
          FIXTURE_ROLES,
        ),
      want: "--type-em-x is text, which the private-token index does not carry, and its value normalises to em, which the index joins",
    },
    {
      // #Scale.joined does not reach the design block: two names for one value is
      // the same defect whether a vendor or an app spells it.
      pins: "two roles in one dimension at one value",
      run: () => scaleSteps(FIXTURE_SCALE, { ...FIXTURE_ROLES, spacing: { md: "16px", medium: "16px" } }),
      want: "--sp-md and --sp-medium are both px:16 in space, and a value may not be spelled twice",
    },
    // A ramp can be written half-dead: each of these emits its token into :root
    // and publishes nothing, so no literal is ever answered with it and no rule
    // says why. A leading under a size name is the one a reviewer would not see.
    ...([
      ["a leading under a size name", { body: "1.5" }, "--type-body", "1.5", "text"],
      ["a weight, which no dimension here carries", { "title-weight": "650" }, "--type-title-weight", "650", "text"],
      ["a keyword", { body: "medium" }, "--type-body", "medium", "text"],
    ] as const).map(([pins, type, token, value, dimension]) => ({
      pins: `a type role carrying ${pins} publishes no step`,
      run: () => scaleSteps(FIXTURE_SCALE, { ...FIXTURE_ROLES, type }),
      want: `${token} is declared ${value}, which is no ${dimension} this pass reads, so it publishes no step`,
    })),
    {
      // #Scale.sourced closes this in the export; here it decides whether the
      // published row carries a `kind`, and a row whose kind arrived undefined
      // is a step the witness rule would neither convict nor acquit.
      pins: "a bucket naming a source the scale does not carry has no archive to be held against",
      run: () =>
        scaleDeclarations(withBuckets({
          ratio: { ...FIXTURE_SCALE.buckets.ratio, source: "nope" },
        })),
      want: "the export's scale bucket ratio names source nope, which the scale does not carry",
    },
  ];
  for (const r of raises) {
    let threw: string | null = null;
    try {
      r.run();
    } catch (e) {
      threw = (e as Error).message;
    }
    if (threw !== r.want) {
      failures.push(
        `style: want the raise ${JSON.stringify(r.want)}, got ${JSON.stringify(threw)} — ${r.pins}`,
      );
    }
  }

  return failures;
}
