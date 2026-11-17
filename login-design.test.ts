import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { CHROME_ICONS } from "../omnishell/interpreter/chrome.js";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

const FLOW_PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding)-(?:left|right)\s*:|(?:^|[;{\s])border-(?:left|right)(?:-(?:width|style|color))?\s*:|(?:^|[;{\s])border-(?:top|bottom)-(?:left|right)-radius\s*:|text-align\s*:\s*(?:left|right)\b|(?:float|clear)\s*:\s*(?:left|right)\b/;

function withDesign(designCue: string): string {
  return paymentProgram().replace(
    /design: \{[\s\S]*?\n    \}/,
    `design: ${designCue}`,
  );
}

function navProgram(nav: "topbar" | "tabbar" | "sidebar" | "dock" | "custom"): string {
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

Deno.test("design refuses preset keys, legacy strip name, and requires explicit palette twins and shell.nav posture", async () => {
  await assertRejects(() => emitFiles(withDesign("{}")), Error, "unresolved disjunction");
  await assertRejects(
    () => emitFiles(withDesign(`{ shell: nav: "topbar" }`)),
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
    'unresolved disjunction "topbar" | "tabbar" | "sidebar" | "dock" | "custom"',
  );
  await assertRejects(
    () => emitFiles(paymentProgram() + `\napp: surface: design: shell: nav: "strip"\n`),
    Error,
    "empty disjunction",
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

Deno.test("shell.nav emits zero-specificity :where(...) rules for topbar, tabbar, sidebar, dock, and custom postures without physical flow properties", async () => {
  const topbarCss = (await emitFiles(navProgram("topbar")))["shell/design.css"].text;
  assertStringIncludes(topbarCss, ":where(body > nav) { position: sticky; inset-block-start: 0; z-index: 10;");
  assertStringIncludes(topbarCss, "padding: var(--shell-nav-pad, 8px clamp(16px, 3vw, 32px));");
  assertStringIncludes(topbarCss, ":where(body > nav > .shell-brand) { flex: none; white-space: nowrap;");
  assertStringIncludes(topbarCss, ':where(body > nav > a[aria-current="page"]) {');
  assertStringIncludes(topbarCss, "color: var(--shell-nav-active-fg, inherit);");
  assertStringIncludes(topbarCss, "color-mix(in srgb, currentColor 9%, transparent)");
  assertStringIncludes(topbarCss, ":where(body > nav > a:hover) {");
  assertStringIncludes(topbarCss, ":where(body > nav .shell-me) { margin-inline-start: auto; flex: none;");
  assertStringIncludes(topbarCss, ":where(body > nav .shell-who) { max-width: var(--shell-who-max, 24ch); }");
  assertStringIncludes(topbarCss, ":where(body > nav > a ~ .shell-me) {");
  assertStringIncludes(topbarCss, ":where(body > nav :is(.shell-signout, .shell-signin, .shell-register, .shell-provider))");
  assertStringIncludes(topbarCss, ':where(body > nav > a[data-display="icon-only"])');
  assert(
    topbarCss.lastIndexOf(':where(body > nav > a[data-display="icon-only"])') >
      topbarCss.lastIndexOf(":where(body > nav > a) {"),
    "icon-only padding/gap override must follow posture :where(body > nav > a) rules in source order",
  );
  assertStringIncludes(topbarCss, "@media print { :where(body > nav) { display: none; } }");
  assertStringIncludes(topbarCss, ":where(body > nav[hidden]) { display: none; }");
  assertFalse(FLOW_PHYSICAL.test(topbarCss));

  const tabbarCss = (await emitFiles(navProgram("tabbar")))["shell/design.css"].text;
  assertStringIncludes(tabbarCss, "@media (min-width: 640px) {");
  assertStringIncludes(tabbarCss, "width: fit-content; max-width: calc(100% - var(--sp-lg, 24px));");
  assertStringIncludes(tabbarCss, "border-radius: var(--shell-nav-radius, var(--r-full, 999px));");
  assertStringIncludes(tabbarCss, "@media not all and (min-width: 640px) {");
  assertStringIncludes(tabbarCss, ":where(body > nav) { position: fixed; inset-block-end: 0; inset-inline: 0; z-index: 10;");
  assertStringIncludes(tabbarCss, "justify-content: safe center;");
  assertStringIncludes(
    tabbarCss,
    "padding-block-end: calc(var(--shell-nav-clearance, 76px) + env(safe-area-inset-bottom, 0px));",
  );
  assertStringIncludes(tabbarCss, "@media print {");
  assertFalse(FLOW_PHYSICAL.test(tabbarCss));

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

  const dockCss = (await emitFiles(navProgram("dock")))["shell/design.css"].text;
  assertStringIncludes(dockCss, "inset-block-end: max(var(--sp-md, 16px), env(safe-area-inset-bottom, 0px));");
  assertStringIncludes(dockCss, "width: fit-content; max-width: calc(100% - var(--sp-lg, 24px));");
  assertStringIncludes(
    dockCss,
    "padding-block-end: calc(var(--shell-nav-clearance, 84px) + env(safe-area-inset-bottom, 0px));",
  );
  assertStringIncludes(dockCss, "@media print {");
  assertFalse(FLOW_PHYSICAL.test(dockCss));

  const customCss = (await emitFiles(navProgram("custom")))["shell/design.css"].text;
  assertFalse(customCss.includes(":where(body > nav) {"));
  assertFalse(customCss.includes(':where(body > nav > a[aria-current="page"]) {'));
  assertStringIncludes(customCss, ":where(body > nav a) { color: inherit; text-decoration: none; }");
  assertStringIncludes(customCss, ":where(body > nav .shell-nav-icon) { flex: none;");
  assertStringIncludes(customCss, ":where(body > nav :is(.shell-signout, .shell-signin, .shell-register, .shell-provider))");
  assertFalse(FLOW_PHYSICAL.test(customCss));

  // Omnishell's standalone browser suite (`nav-postures.pw.ts`) cannot import
  // pronto in `bonisoft3/omnishell`, so hold its checked-in posture fixtures
  // byte-for-byte equal to `emit.cue` here.
  const fixture = JSON.parse(
    await Deno.readTextFile(new URL("../omnishell/playwright-tests/fixtures/nav-postures.json", import.meta.url)),
  ) as Record<string, string>;
  assertEquals(fixture.topbar, topbarCss);
  assertEquals(fixture.tabbar, tabbarCss);
  assertEquals(fixture.sidebar, sidebarCss);
  assertEquals(fixture.dock, dockCss);
  for (const nav of ["tabbar", "dock"] as const) {
    const invertedCss = (
      await emitFiles(paymentProgram() + `\napp: surface: design: shell: { nav: "${nav}", bg: "primary", fg: "surface" }\n`)
    )["shell/design.css"].text;
    assertEquals(fixture[`${nav}:inverted`], invertedCss);
  }
});

Deno.test("#NavIcon matches CHROME_ICONS 1:1 and emits shell.title + route icons into shell.yaml", async () => {
  const schemaCue = await Deno.readTextFile(new URL("./schema.cue", import.meta.url));
  const navIconBlock = schemaCue.match(/#NavIcon:\s*([\s\S]*?)\n\n/);
  assert(navIconBlock, "missing #NavIcon definition in schema.cue");
  const cueIcons = [...navIconBlock[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
  const jsIcons = Object.keys(CHROME_ICONS).sort();
  assertEquals(cueIcons, jsIcons);

  const prog = paymentProgram() + `
app: surface: {
  design: shell: {
    nav: "topbar"
    title: "The Daily Five"
  }
  screens: {
    play: {
      title: "Play"
      route: "/play"
      markup: "<main></main>"
      icon: "grid-3x3"
      reads: []
      forms: []
      states: ["ready"]
    }
    rules: {
      title: "Rules"
      route: "/rules"
      markup: "<main></main>"
      icon: "circle-help"
      iconOnly: true
      reads: []
      forms: []
      states: ["ready"]
    }
  }
}
`;
  const files = await emitFiles(prog);
  const shell = files["shell/shell.yaml"].data as {
    brand?: { label: string; key?: string };
    routes: Array<{ screen: string; nav: { label: string; icon?: string; display?: string } }>;
  };
  assertEquals(shell.brand, { label: "The Daily Five" });
  const playRoute = shell.routes.find((r) => r.screen === "play")!;
  const rulesRoute = shell.routes.find((r) => r.screen === "rules")!;
  assertEquals(playRoute.nav, { label: "Play", icon: "grid-3x3" });
  assertEquals(rulesRoute.nav, { label: "Rules", icon: "circle-help", display: "icon-only" });

  // iconOnly: true without icon is refused at compile time.
  await assertRejects(
    () =>
      emitFiles(
        paymentProgram() + `
app: surface: screens: broken: {
  title: "Broken", route: "/broken", markup: "<main></main>", iconOnly: true,
  reads: [], forms: [], states: ["ready"]
}
`,
      ),
    Error,
  );

  // Unknown icon name is refused at compile time.
  await assertRejects(
    () =>
      emitFiles(
        paymentProgram() + `
app: surface: screens: broken: {
  title: "Broken", route: "/broken", markup: "<main></main>", icon: "not-a-real-icon",
  reads: [], forms: [], states: ["ready"]
}
`,
      ),
    Error,
  );
});
