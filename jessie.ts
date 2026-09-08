// What a Jessie module references, and what it evaluates to.
//
// The loader takes the compartment's completion value, so the file's last
// top-level expression must BE that value — an arrow function for a handler's
// reducer, an object literal for an adapter's map of pure functions. Which of
// the two a given module owes is the role's business (screen.js ROLES), checked
// where the role is known; this only reports which shape it ended in.

/** Identifiers a Jessie module may not reach for, and why. Rows, so the scan
 * below and the query that reports them read the same list. */
export const DENIED: { name: string; reason: string }[] = [
  ...[
    "window",
  "document",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "eval",
  "Function",
  "globalThis",
  "import",
  "require",
    "Date",
  ].map((name) => ({ name, reason: "handlers run in an SES compartment with no endowments" })),
  { name: "Math.random", reason: "handlers must be deterministic" },
  { name: "plv8", reason: "a validation is handed its world; it queries nothing" },
  { name: "this", reason: "Jessie has no this; in plv8 it would reach the global object" },
];

/**
 * Walks the source outside its comments and its string and template bodies,
 * emitting every character it passes and handing each atom's interior to
 * `atom` a character at a time. The scanner does not tokenize regex literals
 * or template substitutions: a regex holding a quote or an unbalanced bracket
 * is read as one, and a `${...}` holding a quote is read inside the template.
 */
function walkAtoms(source: string, atom: (c: string) => string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
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
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") { out += atom("\\"); i++; }
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
  return out;
}

// Blanks comments and string/template-literal contents (keeping the line
// structure) so denylist hits inside them do not count.
const stripAtoms = (source: string) => walkAtoms(source, (c) => (c === "\n" ? "\n" : ""));

// The same walk, padding every dropped character with a space, so an index
// into the result is an index into the source.
const padAtoms = (source: string) => walkAtoms(source, (c) => (c === "\n" ? "\n" : " "));

const ARROW_HEAD = /^(\(([^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*=>/;
// An adapter ends in a parenthesised object literal: `({ toItems: ... })`.
const OBJECT_HEAD = /^\(\s*\{/;

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

/** The denied names a module reaches for, and which of the two completion
 * shapes it ends in — `other` where it is neither. */
export function jessieFacts(source: string): { references: string[]; completion: string } {
  const stripped = stripAtoms(source);
  const references = DENIED
    .filter(({ name }) =>
      name === "Math.random"
        ? /\bMath\s*\.\s*random\b/.test(stripped)
        : new RegExp(`\\b${name}\\b`).test(stripped)
    )
    .map(({ name }) => name);
  const last = lastStatement(stripped);
  const completion = ARROW_HEAD.test(last) ? "arrow" : OBJECT_HEAD.test(last) ? "object" : "other";
  return { references, completion };
}

/** The scanner's cases, run from derive.ts's self-test. */
export function jessieSelfTest(): string[] {
  const good = `const renumber = (items) => items.map((it, i) => ({ id: it.id, position: (i + 1) * 10 }));
// "window" and Date in this comment and the string below must not trip it
const label = "a Date for the window";
(state, event) => ({ updates: renumber(state.items) });
`;
  const cases: { name: string; source: string; expect: string[] }[] = [
    { name: "clean handler passes", source: good, expect: [] },
    {
      name: "fetch is denylisted",
      source: `(state, event) => fetch("/x");\n`,
      expect: ["fetch"],
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
  ];
  const failures: string[] = [];
  for (const t of cases) {
    // The rows, not the wording a query wraps them in: a denied name referenced,
    // and a completion value that is neither shape.
    const f = jessieFacts(t.source);
    const got = [
      ...f.references,
      ...(f.completion === "other" ? ["completion:other"] : []),
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
