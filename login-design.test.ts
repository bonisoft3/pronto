import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

const FLOW_PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding)-(?:left|right)\s*:|(?:^|[;{\s])border-(?:left|right)(?:-(?:width|style|color))?\s*:|(?:^|[;{\s])border-(?:top|bottom)-(?:left|right)-radius\s*:|text-align\s*:\s*(?:left|right)\b|(?:float|clear)\s*:\s*(?:left|right)\b/;

function withDesign(designCue: string): string {
  return paymentProgram().replace(
    /design: \{[\s\S]*?\n    \}/,
    `design: ${designCue}`,
  );
}

function navProgram(nav: "strip" | "sidebar" | "custom"): string {
  return paymentProgram() + `\napp: surface: design: shell: nav: "${nav}"\n`;
}

function loginProgram(surfaceOverride = ""): string {
  return paymentProgram()
    .replace(
      "capabilities: {hatches: {},",
      `capabilities: {auth: {required: true, service: "/auth", providers: ["google"]}, hatches: {},`,
    ) + `
app: surface: design: {
  colors: {
    primary: "#101010", secondary: "#353535", neutral: "#202020", surface: "#f5f5f5"
    ${surfaceOverride ? `"login-surface": "${surfaceOverride}"` : ""}
  }
  dark: {
    primary: "#f5f5f5", secondary: "#dddddd", neutral: "#eeeeee", surface: "#181818"
    ${surfaceOverride ? `"login-surface": "#222222"` : ""}
  }
}
`;
}

function palette(css: string, name: string): string[] {
  const match = css.match(new RegExp(`--${name}:\\s*light-dark\\((#[a-fA-F0-9]{6}),\\s*(#[a-fA-F0-9]{6})\\)`));
  assert(match, `missing emitted ${name} palette`);
  return match.slice(1);
}

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + .05) / (values[0] + .05);
}

Deno.test("login pairs its text and actions with the surface when the outer shell has a different background", async () => {
  const files = await emitFiles(loginProgram());
  const css = files["shell/design.css"].text;
  assertStringIncludes(css, "body:has(.shell-login) { background: var(--login-surface, var(--surface)); }");
  assertStringIncludes(css, ".shell-login .login-actions { display: grid; gap: 12px; }");
  for (const action of ["login-provider", "login-passkey"]) {
    assertStringIncludes(css, `.shell-login .${action} { background: var(--primary, var(--shell-fg)); color: var(--surface);`);
  }
  const primary = palette(css, "primary");
  const secondary = palette(css, "secondary");
  const surface = palette(css, "surface");
  const neutral = palette(css, "neutral");
  for (const appearance of [0, 1]) {
    // Surface text cannot move onto an unrelated outer chrome background.
    assert(contrast(primary[appearance], neutral[appearance]) < 3);
    assert(contrast(primary[appearance], surface[appearance]) >= 4.5);
    assert(contrast(secondary[appearance], surface[appearance]) >= 4.5);
  }
});

Deno.test("an app can declare a login surface in both appearances without changing the shell background", async () => {
  const files = await emitFiles(loginProgram("#ffffff"));
  const css = files["shell/design.css"].text;
  assertEquals(palette(css, "login-surface"), ["#ffffff", "#222222"]);
  assertStringIncludes(css, "--shell-bg: var(--neutral);");
  assertStringIncludes(css, "body:has(.shell-login) { background: var(--login-surface, var(--surface)); }");
});

Deno.test("design refuses preset keys and requires explicit palette twins and shell.nav posture", async () => {
  await assertRejects(() => emitFiles(withDesign("{}")), Error, "unresolved disjunction");
  await assertRejects(
    () => emitFiles(withDesign(`{ shell: nav: "strip" }`)),
    Error,
    "non-concrete value",
  );
  await assertRejects(
    () =>
      emitFiles(withDesign(`{
      colors: { primary: "#111111", secondary: "#555555", accent: "#0055aa", danger: "#aa0000", neutral: "#fafafa", surface: "#ffffff", border: "#dddddd", "surface-muted": "#efefef" }
      dark: { primary: "#f5f5f5", secondary: "#aaaaaa", accent: "#66aaff", danger: "#ff6666", neutral: "#111111", surface: "#1a1a1a", border: "#333333", "surface-muted": "#242424" }
    }`)),
    Error,
    'unresolved disjunction "strip" | "sidebar" | "custom"',
  );
  await assertRejects(
    () => emitFiles(paymentProgram() + `\napp: surface: design: preset: "press"\n`),
    Error,
    "preset: field not allowed",
  );
  await assertRejects(
    () => emitFiles(paymentProgram() + `\napp: surface: design: colors: primary: ""\n`),
    Error,
    'invalid value ""',
  );
});

Deno.test("shell.nav emits zero-specificity :where(...) rules for strip, sidebar, and custom postures without physical flow properties", async () => {
  const stripCss = (await emitFiles(navProgram("strip")))["shell/design.css"].text;
  assertStringIncludes(stripCss, ":where(body > nav) { position: sticky; top: 0; z-index: 10;");
  assertStringIncludes(stripCss, ':where(body > nav > a[aria-current="page"]) {');
  assertStringIncludes(stripCss, "color: var(--shell-nav-active-fg, inherit);");
  assertStringIncludes(stripCss, "color-mix(in srgb, currentColor 9%, transparent)");
  assertStringIncludes(stripCss, ":where(body > nav > a:hover) {");
  assertStringIncludes(stripCss, ":where(body > nav .shell-me) { margin-inline-start: auto; flex: none;");
  assertStringIncludes(stripCss, ":where(body > nav .shell-who) { max-width: var(--shell-who-max, 24ch); }");
  assertStringIncludes(stripCss, ":where(body > nav > a ~ .shell-me) {");
  assertStringIncludes(stripCss, ":where(body > nav :is(.shell-signout, .shell-signin, .shell-register, .shell-provider))");
  assertStringIncludes(stripCss, "@media print { :where(body > nav) { display: none; } }");
  assertStringIncludes(stripCss, ":where(body > nav[hidden]) { display: none; }");
  assertFalse(FLOW_PHYSICAL.test(stripCss));

  const sidebarCss = (await emitFiles(navProgram("sidebar")))["shell/design.css"].text;
  assertStringIncludes(sidebarCss, "@media (min-width: 860px) {");
  assertStringIncludes(sidebarCss, ":where(body > nav) { position: fixed; inset-block: 0; inset-inline-start: 0;");
  assertStringIncludes(sidebarCss, "border-inline-end: 1px solid var(--shell-rule);");
  assertStringIncludes(sidebarCss, ':where(body > nav > a[aria-current="page"]) {');
  assertStringIncludes(sidebarCss, "color: var(--shell-nav-active-fg, inherit);");
  assertStringIncludes(sidebarCss, ":where(body > nav > a ~ .shell-me) {");
  assertStringIncludes(sidebarCss, ":where(body:has(> nav:not([hidden])) > #app) {");
  assertStringIncludes(sidebarCss, "margin-inline-start: var(--shell-nav-width, var(--size-13));");
  assertStringIncludes(sidebarCss, "@media not all and (min-width: 860px) {");
  assertFalse(sidebarCss.includes("@media (max-width: 859px)"));
  assertStringIncludes(sidebarCss, "@media print {");
  assertStringIncludes(sidebarCss, ":where(body > nav :is(.shell-signout, .shell-signin, .shell-register, .shell-provider))");
  assertFalse(FLOW_PHYSICAL.test(sidebarCss));

  const customCss = (await emitFiles(navProgram("custom")))["shell/design.css"].text;
  assertFalse(customCss.includes(":where(body > nav) {"));
  assertFalse(customCss.includes(':where(body > nav > a[aria-current="page"]) {'));
  assertStringIncludes(customCss, ":where(body > nav a) { color: inherit; text-decoration: none; }");
  assertStringIncludes(customCss, ":where(body > nav :is(.shell-signout, .shell-signin, .shell-register, .shell-provider))");
  assertFalse(FLOW_PHYSICAL.test(customCss));
});
