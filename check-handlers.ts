// pronto handler lint: a stub for the real Jessie grammar gate.
//
//   deno run --allow-read=. ../../plugins/pronto/check-handlers.ts <handler files...>
//   deno run check-handlers.ts --self-test
//
// Jessie modules evaluate in an SES Compartment, so anything on the denylist
// would be undefined (or nondeterministic) at runtime; the lint catches it at
// emit time. The loader takes the compartment's completion value, so the
// file's last top-level expression must BE that value — an arrow function for
// a handler's reducer, an object literal for an adapter's map of pure
// functions. Which of the two a given module owes is the role's business
// (screen.js ROLES), checked where the role is known; this only refuses a file
// whose completion value is neither.
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any file fails.

type Finding = { severity: string; path: string; message: string };

const DENYLIST = [
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
];

// Blanks comments and string/template-literal contents (keeping the line
// structure) so denylist hits inside them do not count.
export function stripAtoms(source: string): string {
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

export function checkSource(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const stripped = stripAtoms(source);
  for (const name of DENYLIST) {
    if (new RegExp(`\\b${name}\\b`).test(stripped)) {
      findings.push({
        severity: "error",
        path,
        message: `denylisted identifier: ${name} (handlers run in an SES compartment with no endowments)`,
      });
    }
  }
  if (/\bMath\s*\.\s*random\b/.test(stripped)) {
    findings.push({
      severity: "error",
      path,
      message: "denylisted identifier: Math.random (handlers must be deterministic)",
    });
  }
  const last = lastStatement(stripped);
  if (!ARROW_HEAD.test(last) && !OBJECT_HEAD.test(last)) {
    findings.push({
      severity: "error",
      path,
      message:
        "the last top-level expression must be the module's completion value — " +
        "an arrow function (handler) or a parenthesised object literal (adapter)",
    });
  }
  return findings;
}

function selfTest(): void {
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
      expect: ["arrow function"],
    },
    {
      name: "semicolons inside the arrow body do not cut it",
      source: `(state, event) => { const a = 1; return { updates: [] }; }\n`,
      expect: [],
    },
  ];
  let failed = 0;
  for (const t of cases) {
    const got = checkSource("<self-test>", t.source);
    const ok =
      got.length === t.expect.length &&
      t.expect.every((frag, i) => got[i].message.includes(frag));
    if (!ok) {
      failed++;
      console.error(`FAIL ${t.name}: got ${JSON.stringify(got)}`);
    } else {
      console.error(`ok   ${t.name}`);
    }
  }
  if (failed > 0) Deno.exit(1);
  console.error(`check-handlers self-test: ${cases.length} cases passed`);
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    selfTest();
    Deno.exit(0);
  }
  if (Deno.args.length === 0) {
    console.error("usage: check-handlers.ts <handler files...> | --self-test");
    Deno.exit(1);
  }
  const findings: Finding[] = [];
  for (const path of Deno.args) {
    findings.push(...checkSource(path, await Deno.readTextFile(path)));
  }
  console.log(JSON.stringify(findings, null, 2));
  if (findings.length > 0) Deno.exit(1);
}
