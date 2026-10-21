import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { emitFiles, paymentProgram } from "./effects-fixtures.ts";

function loginProgram(surfaceOverride = ""): string {
  return paymentProgram()
    .replace("capabilities: {hatches: {},", `capabilities: {auth: {required: true, service: "/auth", providers: ["google"]}, hatches: {},`)
    .replace("design: {}", `design: {
      colors: {
        primary: "#101010", secondary: "#353535", neutral: "#202020", surface: "#f5f5f5"
        ${surfaceOverride ? `"login-surface": "${surfaceOverride}"` : ""}
      }
      dark: {
        primary: "#f5f5f5", secondary: "#dddddd", neutral: "#eeeeee", surface: "#181818"
        ${surfaceOverride ? `"login-surface": "#222222"` : ""}
      }
    }`);
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
