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
