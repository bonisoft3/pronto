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
];

// Blanks comments and string/template-literal contents (keeping the line
// structure) so denylist hits inside them do not count.
function stripAtoms(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        if (source[i] === "\n") out += "\n";
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

// The last top-level statement: the last non-empty segment between
// semicolons at bracket depth 0 (the whole file when there is none).
function lastStatement(stripped: string): string {
  let depth = 0;
  let start = 0;
  let last = "";
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) {
      const seg = stripped.slice(start, i).trim();
      if (seg !== "") last = seg;
      start = i + 1;
    }
  }
  const tail = stripped.slice(start).trim();
  if (tail !== "") last = tail;
  return last;
}

const ARROW_HEAD = /^(\(([^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*=>/;
// An adapter ends in a parenthesised object literal: `({ toItems: ... })`.
const OBJECT_HEAD = /^\(\s*\{/;

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
  return failures;
}
