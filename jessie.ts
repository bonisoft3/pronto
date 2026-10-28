// What a Jessie module references, and what it evaluates to.
//
// The loader takes the compartment's completion value, so the file's last
// top-level expression must BE that value — an arrow function for a handler's
// reducer, an object literal for an adapter's map of pure functions, or the
// name of a binding holding one. Which a given module owes is the role's
// business (screen.js ROLES), checked where the role is known; this only
// reports which shape it ended in.

/** Identifiers a Jessie module may not reach for, and why. Rows, so the scan
 * below and the query that reports them read the same list. */
/** `exceptRole` is the one role whose compartment IS endowed with the name, so
 * the scan stops calling it a reach. Every other role still fails on it, and
 * a role the platform does not endow fails at runtime where it is seen. */
export const DENIED: { name: string; reason: string; exceptRole?: string }[] = [
  ...[
    "window",
    "document",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "Function",
    "globalThis",
    "import",
    "require",
  ].map((name) => ({ name, reason: "handlers run in an SES compartment with no endowments" })),
  // A formatter takes a Date; the cage still refuses the clock itself —
  // `Date.now()` and a bare `new Date()` throw under SES's taming.
  {
    name: "Date",
    reason: "handlers run in an SES compartment with no endowments",
    exceptRole: "adapter",
  },
  {
    name: "Intl",
    reason: "only an adapter or a module granted Intl via manifest endowments is endowed with Intl",
    exceptRole: "adapter",
  },
  ...[
    "Crypto",
    "Cheerio",
    "TextEncoder",
    "TextDecoder",
    "URL",
    "URLSearchParams",
  ].map((name) => ({
    name,
    reason: "safe platform primitives require opt-in via manifest endowments",
  })),
  { name: "Math.random", reason: "handlers must be deterministic" },
  // Listed again with the reason that actually holds: SES censors `eval` and
  // `import` only in their DIRECT forms, when it rewrites the source. Probed
  // against the vendored SES at the interpreter's own lockdown — `(0,eval)`
  // and `const e = eval` both reach a working evaluator and return 2, and
  // `Function("return 1")()` returns 1. The compartment confines them, it does
  // not remove them, so the name is what the scan has to catch.
  {
    name: "eval",
    reason:
      "reached indirectly it evaluates arbitrary source inside the compartment; SES rejects only the direct call form",
  },
  { name: "plv8", reason: "a validation is handed its world; it queries nothing" },
  { name: "this", reason: "Jessie has no this; in plv8 it would reach the global object" },
];

/** What a module may be granted, by the cage its role runs in: the
 * terminal's (omnishell's interpreter/jessie.js SAFE_ENDOWMENTS) or mecha's
 * (services/compute/language.ts ENDOWABLE). schema.cue's #SafeEndowment and
 * mecha's #CageEndowment spell the same two lists, and endowments_test.ts
 * holds all four together. An adapter is granted Intl without asking. */
const TERMINAL = ["Intl", "TextEncoder", "TextDecoder", "URL", "URLSearchParams"] as const;
const MECHA = ["Crypto", "Cheerio", "TextEncoder", "TextDecoder", "URL", "URLSearchParams"] as const;
export const ENDOWABLE: Record<string, readonly string[]> = {
  handler: TERMINAL,
  adapter: TERMINAL,
  renderer: TERMINAL,
  validation: TERMINAL,
  fold: TERMINAL,
  // A kinetic engine steps at the frame rate on nothing but its own state and
  // the commands it is handed, so its cage endows nothing at all.
  engine: [],
  computation: MECHA,
  effect: MECHA,
};

/**
 * Walks the source outside its comments and its string and template bodies,
 * emitting every character it passes and handing each atom's interior to
 * `atom` a character at a time. A template's `${...}` substitutions are code
 * and walked as code. A `/` begins a regex literal where an expression must
 * begin — after an operator, an opening bracket, a keyword such as `return`
 * that is not a member, or at the start — unless it would close on the opener
 * of a comment or not close on its line. Where a token may end an expression
 * or precede one (`}`, `of`, `await`, `yield` as names), `ambiguous` decides,
 * and references are read both ways (jessieFacts), so a wrong guess can only
 * add a finding.
 */
const REGEX_AFTER = /([(,=:[!&|?{;~^%*<>]|(?<![+])\+|(?<![-])-|(?<![\w$.])(return|typeof|case|do|else|in|new|delete|void|throw))$/;
const EITHER_AFTER = /(\}|(?<![\w$.])(of|await|yield))$/;
const regexMayBegin = (before: string, ambiguous: boolean) => {
  const prev = before.trimEnd().slice(-16);
  return prev === "" || REGEX_AFTER.test(prev) || (ambiguous && EITHER_AFTER.test(prev));
};

/** Where the regex literal opening at `i` closes, or -1 where none does. */
function regexEnd(source: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < source.length && source[j] !== "\n"; j++) {
    if (source[j] === "\\") j++;
    else if (source[j] === "[") inClass = true;
    else if (source[j] === "]") inClass = false;
    else if (source[j] === "/" && !inClass) return source[j + 1] === "/" || source[j + 1] === "*" ? -1 : j;
  }
  return -1;
}

function walkAtoms(source: string, atom: (c: string) => string, ambiguous = true): string {
  return walk(source, 0, atom, ambiguous, false).out;
}

/** From `start` to the end, or within a substitution to its closing brace. */
function walk(source: string, start: number, atom: (c: string) => string, ambiguous: boolean, substitution: boolean): { out: string; end: number } {
  let out = "";
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (substitution && c === "{") depth++;
    if (substitution && c === "}" && depth-- === 0) return { out, end: i };
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += atom(source[i]); i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      out += atom("/") + atom("*");
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += atom(source[i]);
        i++;
      }
      out += atom("*") + atom("/");
      i += 2;
      continue;
    }
    const end = c === "/" && regexMayBegin(out, ambiguous) ? regexEnd(source, i) : -1;
    if (end >= 0) {
      out += "/";
      for (i++; i < end; i++) out += atom(source[i]);
      out += "/";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") { out += atom("\\") + atom(source[i + 1] ?? ""); i += 2; continue; }
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
          const inner = walk(source, i + 2, atom, ambiguous, true);
          out += "${" + inner.out + "}";
          i = inner.end + 1;
          continue;
        }
        out += atom(source[i]);
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return { out, end: i };
}

// Blanks comments and string/template-literal contents (keeping the line
// structure) so denylist hits inside them do not count.
const stripAtoms = (source: string, ambiguous = true) => walkAtoms(source, (c) => (c === "\n" ? "\n" : ""), ambiguous);

// The same walk, padding every dropped character with a space, so an index
// into the result is an index into the source.
const padAtoms = (source: string) => walkAtoms(source, (c) => (c === "\n" ? "\n" : " "));

const ARROW_HEAD = /^(\(([^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*=>/;
// An adapter ends in a parenthesised object literal: `({ toItems: ... })`.
const OBJECT_HEAD = /^\(\s*\{/;
// Or names the binding that holds it: `parseMarkdown`, alone or after the
// declarations before it, which hold no top-level semicolon to cut at.
const NAME = /(^|\}\s*)(?!(undefined|null|true|false|NaN|Infinity)$)[A-Za-z_$][\w$]*$/;

/** The bounds of the last non-empty segment between semicolons at bracket
 * depth 0, over a copy whose atoms no longer hold brackets or semicolons. */
function lastSegment(scanned: string): { start: number; end: number } | null {
  let depth = 0;
  let segStart = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < scanned.length; i++) {
    const c = scanned[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) {
      if (scanned.slice(segStart, i).trim() !== "") { start = segStart; end = i; }
      segStart = i + 1;
    }
  }
  if (scanned.slice(segStart).trim() !== "") { start = segStart; end = scanned.length; }
  return start < 0 ? null : { start, end };
}

/** The module's statements and its completion, split at the last top-level
 * segment; null unless that segment is an arrow function. The padded copy
 * decides the boundaries and the source supplies the text. */
export function splitCompletion(source: string): { statements: string; completion: string } | null {
  const padded = padAtoms(source);
  const seg = lastSegment(padded);
  if (seg === null) return null;
  const text = padded.slice(seg.start, seg.end);
  const first = seg.start + text.search(/\S/);
  const last = seg.start + text.trimEnd().length;
  if (!ARROW_HEAD.test(padded.slice(first, last))) return null;
  return { statements: source.slice(0, first), completion: source.slice(first, last) };
}

// The last top-level statement (the whole file when there is no semicolon).
function lastStatement(stripped: string): string {
  const seg = lastSegment(stripped);
  return seg === null ? "" : stripped.slice(seg.start, seg.end).trim();
}

// A static import declaration once its specifier's text is stripped: default,
// named or namespace bindings, or none, from an emptied string.
const STATIC_IMPORT = /(^|[;}\n])\s*import\s*(?:[A-Za-z_$][\w$]*\s*,?\s*)?(?:\{[^}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*)?\s*(?:from\s*)?(["'])\2/g;

/** The denied names a module reaches for, and which completion shape it ends
 * in — `other` where it is none. */
export function jessieFacts(source: string, role: string, grantedEndowments: string[] = []): { references: string[]; completion: string } {
  const endowable = ENDOWABLE[role];
  if (endowable === undefined) throw new Error(`jessieFacts: unknown role ${JSON.stringify(role)}`);
  // An engine is a module graph, linked at build time (engine-link.ts): its
  // static import declarations are the links, so they are no reach for
  // `import`, while `import(...)` and `import.meta` still are.
  const linked = (text: string) => role === "engine" ? text.replace(STATIC_IMPORT, "$1") : text;
  const stripped = linked(stripAtoms(source));
  const scans = [stripped, linked(stripAtoms(source, false))];
  const endowments = new Set(grantedEndowments);
  const unpermittedEndowments = [...endowments].filter((name) => !endowable.includes(name));
  const references = [...new Set([
    ...DENIED
      .filter(({ name }) => {
        if (endowments.has(name) && endowable.includes(name)) return false;
        // A member (`sink.fetch`, `x?.fetch`) is the object's, not the global:
        // the ways to the global object itself, globalThis and this, are
        // denied above. A spread's `...` is not a member access.
        const reach = name === "Math.random"
          ? /\bMath\s*\.\s*random\b/
          : new RegExp(`(?<![\\w$]|(?<!\\.)\\.\\s*)${name}(?![\\w$])`);
        return scans.some((text) => reach.test(text));
      })
      .map(({ name }) => name),
    ...unpermittedEndowments,
  ])];
  const last = lastStatement(stripped);
  // An engine is a module: what it completes in is its exports.
  const completion = role === "engine" ? "exports" : ARROW_HEAD.test(last) ? "arrow" : OBJECT_HEAD.test(last) ? "object" : NAME.test(last) ? "name" : "other";
  return { references, completion };
}

/** The scanner's cases, run from derive.ts's self-test. */
export function jessieSelfTest(): string[] {
  const good = `const renumber = (items) => items.map((it, i) => ({ id: it.id, position: (i + 1) * 10 }));
// "window" and Date in this comment and the string below must not trip it
const label = "a Date for the window";
(state, event) => ({ updates: renumber(state.items) });
`;
  // `shape` is the completion a case must end in; without it only `other` is reported.
  const cases: { name: string; source: string; role?: string; granted?: string[]; shape?: string; expect: string[] }[] = [
    { name: "clean handler passes", source: good, expect: [] },
    {
      name: "fetch is denylisted",
      source: `(state, event) => fetch("/x");\n`,
      expect: ["fetch"],
    },
    {
      // Neither of these is a direct call, so SES lets both through to a
      // working evaluator; the scan is the only thing that sees them.
      name: "eval reached indirectly is denylisted",
      source: `(state, event) => ({ a: (0, eval)("1+1"), b: (() => { const e = eval; return e("1+1"); })() });\n`,
      expect: ["eval"],
    },
    {
      name: "Math.random is denylisted",
      source: `(state, event) => ({ n: Math.random() });\n`,
      expect: ["Math.random"],
    },
    {
      name: "Date is denylisted",
      source: `(state, event) => ({ at: Date.now() });\n`,
      expect: ["Date"],
    },
    {
      name: "an engine's static imports are its links, not a reach",
      source: `import { step } from "./step.js";\nimport * as table from './table.js';\nimport seed, { mix } from "./prng.js";\nexport const advanceFrame = (s, c) => step(s, c, table, seed, mix);\n`,
      role: "engine",
      expect: [],
    },
    {
      name: "an engine's import() and import.meta are still a reach",
      source: `export const loadState = (s) => import("./x.js").then(() => import.meta.url);\n`,
      role: "engine",
      expect: ["import"],
    },
    {
      name: "a static import is a reach in every role but an engine's",
      source: `import { step } from "./step.js";\n(state, event) => step(state, event);\n`,
      expect: ["import"],
    },
    {
      name: "an engine is endowed with nothing",
      source: `export const initState = () => ({ at: new Intl.NumberFormat("en").format(1) });\n`,
      role: "engine",
      granted: ["Intl"],
      expect: ["Intl"],
    },
    {
      name: "a completion naming the binding that holds the value passes",
      source: `const reduce = (state, event) => state;\nreduce;\n`,
      shape: "name",
      expect: [],
    },
    {
      name: "a regex literal holding a backtick or a bracket is one atom",
      source: "const fence = /^ {0,3}```/;\nconst open = (s) => /[(]/.test(s) ? s / 2 : s;\n(state, event) => ({ f: fence.test(event.s), o: open(event.s) });\n",
      expect: [],
    },
    {
      name: "a division after a keyword-named member hides nothing",
      source: `(s, e) => ({ r: e.in / fetch(e.u) / 2, o: e.of / eval(e.v) / 2 });\n`,
      expect: ["fetch", "eval"],
    },
    {
      name: "a division after an ambiguous token hides nothing",
      source: `let i = 0; const of = 4;\n(s, e) => ({ a: i++ / fetch(e.u) / 2, b: of / fetch(e.u) / 2, c: {} / eval(e.u) / 2 });\n`,
      expect: ["fetch", "eval"],
    },
    {
      name: "a guessed regex never closes on a comment's opener",
      source: `const cap = (row) => row.in / 2 /* the row's cap */;\nconst leak = () => plv8.execute("x"); // it's\n(state, row) => cap(row) > 0 || leak();\n`,
      role: "validation",
      expect: ["plv8"],
    },
    {
      name: "a spread is not a member access",
      source: `(row) => ({...globalThis}).plv8.execute("x") || ({...this}).y;\n`,
      role: "validation",
      expect: ["globalThis", "this"],
    },
    {
      name: "a regex literal holding a denied word is no reach",
      source: `const isDate = (s) => /Date|window/.test(s);\n(state, event) => isDate(event.s);\n`,
      shape: "arrow",
      expect: [],
    },
    {
      name: "a template's substitution is code",
      source: "(state, event) => `${plv8.execute('x')} and ${`${fetch(event.u)}`}`.length > 0;\n",
      role: "validation",
      shape: "arrow",
      expect: ["fetch", "plv8"],
    },
    {
      name: "a template's text is not",
      source: "(state, event) => `window ${event.a} {fetch} $ {eval}`;\n",
      shape: "arrow",
      expect: [],
    },
    {
      name: "a literal is not a name completion",
      source: `const f = 1;\nundefined\n`,
      expect: ["completion:other"],
    },
    {
      name: "a name after the declarations before it passes",
      source: `function reduce(state, event) { return state; }\nreduce;\n`,
      shape: "name",
      expect: [],
    },
    {
      name: "missing trailing arrow fails",
      source: `const reduce = (state, event) => state;\n`,
      expect: ["completion:other"],
    },
    {
      name: "semicolons inside the arrow body do not cut it",
      source: `(state, event) => { const a = 1; return { updates: [] }; }\n`,
      expect: [],
    },
    { name: "plv8 is denylisted", source: `(state, event) => plv8.execute("select 1");\n`, expect: ["plv8"] },
    { name: "this is denylisted", source: `(state, event) => this.rows;\n`, expect: ["this"] },
    {
      name: "safe platform endowments without opt-in are denylisted",
      source: `(state, event) => ({ u: new URL("https://example.com"), t: new TextEncoder().encode("hi"), i: typeof Intl });\n`,
      expect: ["Intl", "TextEncoder", "URL"],
    },
    {
      name: "safe platform endowments with opt-in pass",
      source: `(state, event) => ({ u: new URL("https://example.com"), t: new TextEncoder().encode("hi"), i: typeof Intl });\n`,
      granted: ["Intl", "URL", "TextEncoder"],
      expect: [],
    },
    {
      name: "a member is the object's, not the global",
      source: `(state, event) => ({ r: event.sink.fetch("/x"), w: event . window, d: event.$document });\n`,
      expect: [],
    },
    {
      name: "a global reached as itself is still denied",
      source: `(state, event) => fetch(event.url).then(() => (0, window).document);\n`,
      expect: ["window", "fetch"],
    },
    {
      name: "Crypto is reached only by opt-in",
      source: `(state, event) => Crypto.digest("SHA-256", event.bytes);\n`,
      expect: ["Crypto"],
    },
    {
      name: "a grant is judged against the role's cage",
      source: `(state, event) => Crypto.digest("SHA-256", event.bytes);\n`,
      granted: ["Crypto"],
      expect: ["Crypto"],
    },
    {
      name: "the same grant passes in mecha's cage",
      source: `(state, event) => Crypto.digest("SHA-256", event.bytes);\n`,
      role: "computation",
      granted: ["Crypto"],
      expect: [],
    },
    {
      name: "unpermitted endowment opt-in is denylisted",
      source: `(state, event) => 1;\n`,
      granted: ["fetch"],
      expect: ["fetch"],
    },
  ];
  const failures: string[] = [];
  for (const t of cases) {
    // The rows, not the wording a query wraps them in: a denied name referenced,
    // and a completion value that is neither shape.
    const f = jessieFacts(t.source, t.role ?? "handler", t.granted ?? []);
    const got = [
      ...f.references,
      ...(f.completion === "other" || t.shape !== undefined && f.completion !== t.shape ? [`completion:${f.completion}`] : []),
    ];
    const ok = got.length === t.expect.length && t.expect.every((want, i) => got[i] === want);
    if (!ok) failures.push(`jessie ${t.name}: got ${JSON.stringify(got)}`);
  }
  const splits: { name: string; source: string; want: { statements: string; completion: string } | null }[] = [
    {
      name: "statements end where the arrow's segment starts",
      source: `const a = 1;\n(state, event) => a;\n`,
      want: { statements: "const a = 1;\n", completion: "(state, event) => a" },
    },
    {
      name: "a comment before the arrow is not part of the completion",
      source: `const a = 1; // one\n// the predicate\n(state, event) => a;\n`,
      want: { statements: "const a = 1; // one\n// the predicate\n", completion: "(state, event) => a" },
    },
    {
      name: "a semicolon or brace inside a string does not cut a segment",
      source: `const s = "a;{b}";\n(s2) => s;\n`,
      want: { statements: `const s = "a;{b}";\n`, completion: "(s2) => s" },
    },
    {
      name: "no trailing semicolon",
      source: `(state, event) => state`,
      want: { statements: "", completion: "(state, event) => state" },
    },
    {
      name: "a trailing comment after the semicolon is dropped",
      source: `(s) => s; // done\n`,
      want: { statements: "", completion: "(s) => s" },
    },
    {
      name: "a block comment holding a semicolon and a brace does not cut a segment",
      source: `const a = 1; /* ; { */\n(state, event) => a;\n`,
      want: { statements: "const a = 1; /* ; { */\n", completion: "(state, event) => a" },
    },
    {
      name: "an escaped quote does not end a string",
      source: `const s = "a\\"b;";\n(s2) => s;\n`,
      want: { statements: `const s = "a\\"b;";\n`, completion: "(s2) => s" },
    },
    { name: "a declaration is not a completion", source: `const f = (a) => a;\n`, want: null },
  ];
  for (const t of splits) {
    const got = splitCompletion(t.source);
    if (JSON.stringify(got) !== JSON.stringify(t.want)) {
      failures.push(`jessie split ${t.name}: got ${JSON.stringify(got)}`);
    }
  }
  return failures;
}
