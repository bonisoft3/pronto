// pronto screen lint: the design system has one declaration.
//
//   deno run --allow-read=. ../../plugins/pronto/check-screens.ts <screen css...>
//   deno run check-screens.ts --self-test
//
// The emitter turns the program's design block into shell/design.css; the
// owned token set is that plus the terminal's shell.css. A screen that
// declares one of those tokens again has forked the system: the two copies
// drift, and the palette silently means different things on different
// screens. Redeclaring is therefore an error, not a warning; consuming with
// var() is the whole point and always fine. Findings print as {severity, path, message} JSON (SPEC.md lint
// format); exit 1 when any file fails.

type Finding = { severity: string; path: string; message: string };

const DECLARATION = /(^|[;{]|\*\/)\s*(--[a-z0-9-]+)\s*:/gi;

/** Token names the shared layer declares — the ones a screen must not repeat. */
export function ownedTokens(css: string): Set<string> {
  const owned = new Set<string>();
  for (const m of css.matchAll(DECLARATION)) owned.add(m[2]);
  return owned;
}

export function checkSource(path: string, css: string, owned: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const m of css.matchAll(DECLARATION)) {
    const name = m[2];
    if (!owned.has(name) || seen.has(name)) continue;
    seen.add(name);
    findings.push({
      severity: "error",
      path,
      message:
        `${name} is declared by the shared style layer; ` +
        `redeclaring it here forks the design system. Consume it with var(${name}).`,
    });
  }
  return findings;
}

function selfTest() {
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
    // Two different owned tokens are two findings.
    [":root { --primary: #fff; --r-sm: 2px; }", 2],
  ];
  let failed = 0;
  for (const [css, want] of cases) {
    const got = checkSource("t.css", css, owned).length;
    if (got !== want) {
      failed++;
      console.error(`FAIL want ${want} got ${got}: ${JSON.stringify(css)}`);
    }
  }
  if (failed > 0) Deno.exit(1);
  console.error(`check-screens self-test: ${cases.length} cases passed`);
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    selfTest();
    Deno.exit(0);
  }
  if (Deno.args.length === 0) {
    console.error("usage: check-screens.ts <screen css...> | --self-test");
    Deno.exit(1);
  }
  const [shellCss, designCss] = await Promise.all([
    Deno.readTextFile("shell/shell.css"),
    Deno.readTextFile("shell/design.css"),
  ]);
  const owned = ownedTokens(shellCss + "\n" + designCss);
  const findings: Finding[] = [];
  for (const path of Deno.args) {
    findings.push(...checkSource(path, await Deno.readTextFile(path), owned));
  }
  console.log(JSON.stringify(findings, null, 2));
  if (findings.length > 0) Deno.exit(1);
}
