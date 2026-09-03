// Which custom properties each stylesheet declares.
//
// The emitter turns the program's design block into shell/design.css, and the
// terminal ships shell.css; between them they own the palette. Consuming a
// token with var() is the whole point and always fine, so only a declaration
// is a row here.

const DECLARATION = /(^|[;{]|\*\/)\s*(--[a-z0-9-]+)\s*:/gi;

/** Token names the shared layer declares — the ones a screen must not repeat. */
export function ownedTokens(css: string): Set<string> {
  const owned = new Set<string>();
  for (const m of css.matchAll(DECLARATION)) owned.add(m[2]);
  return owned;
}

/** The scanner's cases, run from derive.ts's self-test. */
export function styleSelfTest(): string[] {
  const owned = ownedTokens(":root {\n  --primary: #000;\n  --r-sm: 6px;\n}");
  const cases: [string, number][] = [
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
  const failures: string[] = [];
  for (const [css, want] of cases) {
    // The overlap the join computes: the tokens a screen declares that the
    // shared layer already owns, each counted once however often it repeats.
    const got = [...ownedTokens(css as string)].filter((t) => owned.has(t)).length;
    if (got !== want) {
      failures.push(`style: want ${want} owned tokens, got ${got}: ${JSON.stringify(css)}`);
    }
  }
  return failures;
}
