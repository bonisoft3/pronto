import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import * as path from "node:path";
import { encodeBase64 } from "jsr:@std/encoding@1.0.7/base64";

async function exportCue(appCue: string): Promise<{ files: Record<string, { text?: string; data?: unknown }>; statics: { file: string; target: string; watch: boolean }[] }> {
  const cueCode = `
package test

import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
  ${appCue}
  state: {
    entities: {}
    pipelines: {}
  }
  capabilities: {hatches: {}, vendored: {}}
  surface: {
    screens: home: {
      title: "Home"
      route: "/"
      markup: "<main></main>"
      reads: []
      forms: []
      states: []
    }
    handlers: {}
    design: {}
    flows: {}
  }
}

_terminal: (pronto.#DefaultTerminal & {code: app}).out
_cluster: (pronto.#DefaultCluster & {code: app, statics: []}).out
_loop: (pronto.#DefaultLoop & {code: app, terminal: _terminal, cluster: _cluster}).out
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster}).out
out: {
  files: (pronto.#emit & {
    code:     app
    cluster:  _cluster
    terminal: _terminal
    loop:     _loop
    build:    _build
  }).files
  statics: _cluster.meta.statics
}
`;

  const cmd = new Deno.Command("cue", {
    args: ["export", "-", "-e", "out", "--out", "json"],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(cueCode));
  await writer.close();
  const res = await child.output();
  assertEquals(res.success, true);
  return JSON.parse(new TextDecoder().decode(res.stdout));
}

async function assertCueFails(appCue: string): Promise<string> {
  const cueCode = `
import "bonisoft.org/plugins/pronto"

app: pronto.#App & {
${appCue}
}

_terminal: (pronto.#DefaultTerminal & {code: app}).out
_cluster: (pronto.#DefaultCluster & {code: app, statics: []}).out
_loop: (pronto.#DefaultLoop & {code: app, terminal: _terminal, cluster: _cluster}).out
_build: (pronto.#DefaultBuild & {code: app, loop: _loop, cluster: _cluster}).out
out: {
  files: (pronto.#emit & {
    code:     app
    cluster:  _cluster
    terminal: _terminal
    loop:     _loop
    build:    _build
  }).files
  statics: _cluster.meta.statics
}
`;

  const cmd = new Deno.Command("cue", {
    args: ["export", "-", "-e", "out", "--out", "json"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(cueCode));
  await writer.close();
  const res = await child.output();
  assertEquals(res.success, false);
  return new TextDecoder().decode(res.stderr);
}

// Regression rationale: Chromium probes /favicon.ico unsolicited when a page has no icon; the 204 prevents spurious 404s and satisfies Lighthouse Best Practices.
Deno.test("default app without favicon preserves blank icon and answers 204", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-default"
      description: "default"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" href="data:,">');
  assertEquals(res.files["shell/favicon.svg"], undefined);
  assertEquals(res.statics.some((s) => s.file === "shell/favicon.svg"), false);

  const caddyfile = res.files["docker/Caddyfile"]?.text ?? "";
  assertStringIncludes(caddyfile, "handle /favicon.ico {");
  assertStringIncludes(caddyfile, "@favicon file /favicon.ico /shell/favicon.ico /favicon.svg /shell/favicon.svg /favicon.png /shell/favicon.png");
  assertStringIncludes(caddyfile, 'header Cache-Control "no-cache"');
  assertStringIncludes(caddyfile, 'respond "" 204');
});

Deno.test("emoji favicon generates shell/favicon.svg and links in head", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-emoji"
      description: "emoji"
      favicon: "♟️"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="./favicon.svg">');
  assertEquals(indexHtml.includes('href="data:,"'), false);

  const svg = res.files["shell/favicon.svg"]?.text ?? "";
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "♟️");

  const stat = res.statics.find((s) => s.file === "shell/favicon.svg");
  assertEquals(stat?.target, "/srv/shell/favicon.svg");
});

Deno.test("raw SVG favicon markup emits shell/favicon.svg verbatim", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-svg"
      description: "svg"
      favicon: "<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='5'/></svg>"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="./favicon.svg">');

  const svg = res.files["shell/favicon.svg"]?.text ?? "";
  assertStringIncludes(svg, "<circle cx='5' cy='5' r='5'/>");
});

Deno.test("shell file path favicon links relative to base and declares static", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-shell-file"
      description: "shell file"
      favicon: "shell/favicon.ico"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/x-icon" href="./favicon.ico">');
  assertEquals(res.files["shell/favicon.svg"], undefined);

  const stat = res.statics.find((s) => s.file === "shell/favicon.ico");
  assertEquals(stat?.target, "/srv/shell/favicon.ico");
});

Deno.test("root file path favicon links absolute and declares static", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-root-file"
      description: "root file"
      favicon: "favicon.svg"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="/favicon.svg">');

  const stat = res.statics.find((s) => s.file === "favicon.svg");
  assertEquals(stat?.target, "/srv/favicon.svg");
});

Deno.test("data URI favicon renders without static emission", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-data"
      description: "data"
      favicon: "data:image/svg+xml,<svg></svg>"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg></svg>">');
  assertEquals(res.files["shell/favicon.svg"], undefined);
});

Deno.test("structured item favicon sets custom rel, sizes, and type", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-struct"
      description: "struct"
      favicon: {
        rel: "apple-touch-icon"
        href: "/apple-touch-icon.png"
        sizes: "180x180"
        type: "image/png"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="apple-touch-icon" type="image/png" sizes="180x180" href="/apple-touch-icon.png">');
});

Deno.test("list of favicons renders each link in head", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-list"
      description: "list"
      favicon: [
        {href: "./favicon.svg", type: "image/svg+xml"},
        {rel: "alternate icon", href: "./favicon.ico"}
      ]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  assertStringIncludes(indexHtml, '<link rel="alternate icon" type="image/x-icon" href="/favicon.ico">');
});

Deno.test("emoji with special characters escapes XML markup", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-escape"
      description: "escape"
      favicon: "R&D"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const svg = res.files["shell/favicon.svg"]?.text ?? "";
  assertStringIncludes(svg, "R&amp;D");
});

Deno.test("multiple SVG or emoji favicons are refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "test-conflict"
      description: "conflict"
      favicon: ["🚀", "✨"]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_faviconSvgRefusal");
  assertStringIncludes(stderr, "at most one SVG markup or emoji favicon may be declared");
});

Deno.test("emoji favicon conflicting with shell/favicon.svg file is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "test-path-conflict"
      description: "path conflict"
      favicon: ["🚀", "shell/favicon.svg"]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_faviconConflictRefusal");
  assertStringIncludes(stderr, "cannot declare an emoji or SVG favicon alongside shell/favicon.svg");
});

Deno.test("data URI favicon with quoted attributes escapes XML quotes in HTML tag", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-data-quoted"
      description: "data uri quoted"
      favicon: "data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"/>"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=&quot;http://www.w3.org/2000/svg&quot;/>">');
});

Deno.test("extensionless or mistyped favicon paths are refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "test-invalid-name"
      description: "invalid name"
      favicon: "favicon"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_faviconValidRefusal");
  assertStringIncludes(stderr, "unsupported favicon format or missing extension: 'favicon'");
});

Deno.test("unsupported favicon file formats are refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "test-unsupported-ext"
      description: "unsupported extension"
      favicon: "fav.gif"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_faviconValidRefusal");
  assertStringIncludes(stderr, "unsupported favicon format or missing extension: 'fav.gif'");
});

Deno.test("path traversal with .. in favicon is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "test-path-traversal"
      description: "path traversal"
      favicon: "shell/../favicon.ico"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_faviconValidRefusal");
  assertStringIncludes(stderr, "favicon path may not contain '..'");
});

Deno.test("structured favicon href with raw SVG markup or emoji is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "test-structured-invalid"
      description: "structured invalid"
      favicon: {href: "🚀"}
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_faviconValidRefusal");
  assertStringIncludes(stderr, "structured favicon href must be a file path, data URI, or URL");
});

Deno.test("remote URL favicon is preserved verbatim and excluded from statics", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-remote"
      description: "remote url"
      favicon: "https://example.com/assets/icon.png"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/png" href="https://example.com/assets/icon.png">');
  assertEquals(res.files["shell/favicon.svg"], undefined);
  assertEquals(res.statics.some((s) => s.target.includes("example.com")), false);
});

Deno.test("relative ./ paths are normalized and cluster statics are deduplicated", async () => {
  const res = await exportCue(`
    meta: {
      name: "test-dedup"
      description: "deduplicated statics"
      favicon: [
        "./favicon.ico",
        "/favicon.ico",
        { href: "shell/favicon.ico", rel: "shortcut icon" },
        { href: "./shell/favicon.ico", rel: "alternate icon" },
      ]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/x-icon" href="/favicon.ico">');
  assertStringIncludes(indexHtml, '<link rel="shortcut icon" type="image/x-icon" href="./favicon.ico">');
  assertStringIncludes(indexHtml, '<link rel="alternate icon" type="image/x-icon" href="./favicon.ico">');

  const icoStatics = res.statics.filter((s) => s.file === "favicon.ico");
  assertEquals(icoStatics.length, 1);
  assertEquals(icoStatics[0].target, "/srv/favicon.ico");

  const shellIcoStatics = res.statics.filter((s) => s.file === "shell/favicon.ico");
  assertEquals(shellIcoStatics.length, 1);
  assertEquals(shellIcoStatics[0].target, "/srv/shell/favicon.ico");
});

Deno.test("bundle.ts inlines local favicon and apple-touch-icon into single-file HTML bundle", async () => {
  const app = await Deno.makeTempDir({ prefix: "bundle-favicon-test-" });
  try {
    const here = import.meta.dirname!;
    const repo = path.resolve(here, "../..");

    await Deno.mkdir(path.join(app, "shell"), { recursive: true });
    await Deno.writeTextFile(path.join(app, "shell/shell.json"), JSON.stringify({ routes: [], migrations: [], tables: [] }));
    await Deno.writeTextFile(path.join(app, "shell/shell.css"), "");
    await Deno.writeTextFile(path.join(app, "shell/design.css"), "");
    await Deno.writeTextFile(
      path.join(app, "shell/favicon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎯</text></svg>',
    );
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await Deno.writeFile(path.join(app, "shell/apple-touch-icon.png"), fakePng);
    await Deno.writeTextFile(
      path.join(app, "shell/index.html"),
      [
        "<!doctype html><html><head>",
        '<link rel="icon" type="image/svg+xml" href="./favicon.svg">',
        '<link rel="apple-touch-icon" sizes="180x180" href="./apple-touch-icon.png">',
        '<link rel="icon" href="https://example.com/remote.png">',
        '<link rel="alternate icon" href="//cdn.example.com/icon.ico">',
        '<link rel="stylesheet" href="./shell.css">',
        '<link rel="stylesheet" href="./design.css">',
        '</head><body><div id="app"></div>',
        '<script type="module" src="./boot.js"></script>',
        "</body></html>",
      ].join("\n"),
    );

    const bundled = await new Deno.Command(Deno.execPath(), {
      args: [
        "run", "-A", "--config", path.join(here, "bundle/deno.json"), path.join(here, "bundle/bundle.ts"), app,
        "--omnishell", path.join(repo, "plugins/omnishell"), "--mecha", path.join(repo, "libraries/mecha"),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(bundled.success, true);

    const outHtml = await Deno.readTextFile(path.join(app, "dist/browser/index.html"));
    const svgData = encodeBase64(new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎯</text></svg>',
    ));
    const pngData = encodeBase64(fakePng);
    assertStringIncludes(outHtml, `href="data:image/svg+xml;base64,${svgData}"`);
    assertStringIncludes(outHtml, `href="data:image/png;base64,${pngData}"`);
    assertStringIncludes(outHtml, 'href="https://example.com/remote.png"');
    assertStringIncludes(outHtml, 'href="//cdn.example.com/icon.ico"');
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

