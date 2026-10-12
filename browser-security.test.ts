import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

Deno.test("the door emits the terminal fence with only declared resource sources", async () => {
  const files = await emitFiles(paymentProgram() + `
app: capabilities: resources: {
  map: {kind: "frame", source: "https://www.openstreetmap.org", note: "the map presents club locations"}
  pictures: {kind: "img", source: "https:", note: "readers choose image hosts"}
}
`);
  const caddy = files["docker/Caddyfile"].text;
  assertStringIncludes(files["shell/index.html"].text, 'http-equiv="Content-Security-Policy"');
  assertStringIncludes(caddy, "require-trusted-types-for 'script'");
  assertStringIncludes(caddy, "frame-src 'self' https://www.openstreetmap.org;");
  assertStringIncludes(caddy, "img-src 'self' data: blob: https:;");
  assertStringIncludes(caddy, "connect-src 'self';");
  assertStringIncludes(caddy, "font-src 'self' data:;");
  assertStringIncludes(caddy, "script-src-attr 'none';");
});

Deno.test("resource declarations cannot relax scripts, omit a reason or broaden non-image origins", async () => {
  for (const fields of [
    'kind: "script", source: "https://example.org", note: "code"',
    'kind: "frame", source: "https:", note: "any frame"',
    'kind: "connect", source: "https://example.org/path", note: "a path"',
    'kind: "img", source: "https://example.org"',
    'kind: "img", source: "https://example.org", note: ""',
  ]) {
    const res = await cue(["export", "-", "-e", "app"], paymentProgram() + `\napp: capabilities: resources: bad: {${fields}}`);
    assertEquals(res.success, false, fields);
  }
});

Deno.test("the terminal fence excludes only a declared realm's served files", async () => {
  const files = await emitFiles(paymentProgram({ vendored: `map: {
    isolation: "realm", ports: {reads: [], raises: []}, note: "a sandboxed presenter",
    src: "shell/units/map/index.html", files: ["shell/units/map/index.html", "shell/units/map/map.js"]
  }` }));
  assertStringIncludes(files["docker/Caddyfile"].text,
    "@terminal not path /shell/units/map/index.html /shell/units/map/map.js\n  header @terminal Content-Security-Policy");
});

const hostDom = `
app: capabilities: hatches: dealer: {
  kind: "host-dom", note: "trusted browser and DOM access",
  src: "shell/hatches/dealer.js", files: ["shell/hatches/dealer.js"]
}
app: surface: screens: board: hatches: ["dealer"]
`;

Deno.test("host-DOM hatches are explicit screen capabilities served under the terminal fence", async () => {
  const files = await emitFiles(paymentProgram() + hostDom) as unknown as Record<string, { text: string; data: any }>;
  assertEquals(files["shell/shell.yaml"].data.hostDom, {
    dealer: { src: "shell/hatches/dealer.js", note: "trusted browser and DOM access" },
  });
  assertEquals(files["shell/shell.yaml"].data.routes[0].hatches, ["dealer"]);
  assertStringIncludes(files["docker/Caddyfile"].text, "script-src-attr 'none'");
  assertEquals(files["docker/Caddyfile"].text.includes("@terminal not path /shell/hatches"), false);
});

Deno.test("projected emission refuses undeclared, unserved and malformed host-DOM hatches", async () => {
  for (const change of [
    hostDom.replace('hatches: ["dealer"]', 'hatches: ["missing"]'),
    hostDom.replace('hatches: ["dealer"]', 'hatches: ["dealer", "dealer"]'),
    hostDom.replace('kind: "host-dom"', 'kind: "sql"').replace('src: "shell/hatches/dealer.js", ', ''),
    hostDom.replace('note: "trusted browser and DOM access",', ''),
    hostDom.replace('note: "trusted browser and DOM access"', 'note: ""'),
    hostDom.replace('files: ["shell/hatches/dealer.js"]', 'files: ["shell/hatches/other.js"]'),
    hostDom.replaceAll('shell/hatches/dealer.js', 'https://example.org/dealer.js'),
    hostDom.replaceAll('shell/hatches/dealer.js', 'shell/hatches/../dealer.js'),
  ]) {
    const result = await cue(["export", "-", "-e", "out", "--out", "json"], paymentProgram() + change);
    assertEquals(result.success, false, change);
  }
});
