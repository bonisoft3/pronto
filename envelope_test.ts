import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.11";
import * as path from "node:path";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1.0.7/base64";

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
_emit: pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    _build
}
out: {
  files: _emit.files
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
_emit: pronto.#emit & {
  code:     app
  cluster:  _cluster
  terminal: _terminal
  loop:     _loop
  build:    _build
}
out: {
  files: _emit.files
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

Deno.test("manifest: true emits shell/manifest.webmanifest with defaults and links in head", async () => {
  const res = await exportCue(`
    meta: {
      name: "envelope-demo"
      description: "envelope demo app"
      manifest: true
      favicon: "icon.png"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="manifest" href="/manifest.webmanifest">');
  assertStringIncludes(indexHtml, '<meta name="mobile-web-app-capable" content="yes">');
  assertStringIncludes(indexHtml, '<meta name="apple-mobile-web-app-status-bar-style" content="default">');
  assertStringIncludes(indexHtml, '<meta name="apple-mobile-web-app-title" content="envelope-demo">');

  const manifestText = res.files["shell/manifest.webmanifest"]?.text ?? "";
  const manifest = JSON.parse(manifestText);
  assertEquals(manifest.name, "envelope-demo");
  assertEquals(manifest.short_name, "envelope-demo");
  assertEquals(manifest.description, "envelope demo app");
  assertEquals(manifest.start_url, "/");
  assertEquals(manifest.scope, "/");
  assertEquals(manifest.background_color, "#ffffff");
  assertEquals(manifest.theme_color, "#ffffff");
  assertEquals(manifest.display, "standalone");
  assertEquals(manifest.icons, [
    { src: "/icon.png", type: "image/png" }
  ]);

  const stat1 = res.statics.find((s) => s.target === "/srv/shell/manifest.webmanifest");
  assertEquals(stat1?.file, "shell/manifest.webmanifest");
  const stat2 = res.statics.find((s) => s.target === "/srv/manifest.webmanifest");
  assertEquals(stat2?.file, "shell/manifest.webmanifest");
  const iconStat = res.statics.find((s) => s.target === "/srv/icon.png");
  assertEquals(iconStat?.file, "icon.png");

  const caddyfile = res.files["docker/Caddyfile"]?.text ?? "";
  assertStringIncludes(caddyfile, "handle /manifest.webmanifest {");
  assertStringIncludes(caddyfile, '@manifest file /manifest.webmanifest /shell/manifest.webmanifest');
  assertStringIncludes(caddyfile, 'header Content-Type "application/manifest+json"');
  assertStringIncludes(caddyfile, "handle /manifest.json {");
  assertStringIncludes(caddyfile, "redir /manifest.webmanifest 308");
});

Deno.test("custom manifest and themeColor configure display and colors", async () => {
  const res = await exportCue(`
    meta: {
      name: "custom-pwa"
      description: "custom PWA"
      themeColor: "#0f172a"
      manifest: {
        short_name: "PWA"
        display: "fullscreen"
        background_color: "#1e293b"
        orientation: "portrait"
        icons: [{ src: "custom-icon.png", sizes: "512x512", type: "image/png" }]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="manifest" href="/manifest.webmanifest">');
  assertStringIncludes(indexHtml, '<meta name="theme-color" content="#0f172a">');
  assertStringIncludes(indexHtml, '<meta name="apple-mobile-web-app-title" content="PWA">');

  const manifest = JSON.parse(res.files["shell/manifest.webmanifest"]?.text ?? "");
  assertEquals(manifest.short_name, "PWA");
  assertEquals(manifest.display, "fullscreen");
  assertEquals(manifest.background_color, "#1e293b");
  assertEquals(manifest.theme_color, "#0f172a");
  assertEquals(manifest.orientation, "portrait");

  const iconStat = res.statics.find((s) => s.target === "/srv/custom-icon.png");
  assertEquals(iconStat?.file, "custom-icon.png");
});

Deno.test("social cards emit OpenGraph, Twitter, and canonical metadata", async () => {
  const res = await exportCue(`
    meta: {
      name: "social-app"
      description: "social card demo"
      social: {
        title: "Social Preview"
        description: "Explore the new release"
        url: "https://demo.example.com"
        image: "preview.png"
        imageAlt: "Preview screenshot"
        card: "summary_large_image"
        site: "@demo"
        creator: "@alice"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<meta property="og:type" content="website">');
  assertStringIncludes(indexHtml, '<meta property="og:title" content="Social Preview">');
  assertStringIncludes(indexHtml, '<meta property="og:description" content="Explore the new release">');
  assertStringIncludes(indexHtml, '<meta property="og:url" content="https://demo.example.com">');
  assertEquals(indexHtml.includes('rel="canonical"'), false);
  assertStringIncludes(indexHtml, '<meta property="og:image" content="https://demo.example.com/preview.png">');
  assertStringIncludes(indexHtml, '<meta property="og:image:alt" content="Preview screenshot">');
  assertStringIncludes(indexHtml, '<meta name="twitter:card" content="summary_large_image">');
  assertStringIncludes(indexHtml, '<meta name="twitter:title" content="Social Preview">');
  assertStringIncludes(indexHtml, '<meta name="twitter:description" content="Explore the new release">');
  assertStringIncludes(indexHtml, '<meta name="twitter:image" content="https://demo.example.com/preview.png">');
  assertStringIncludes(indexHtml, '<meta name="twitter:site" content="@demo">');
  assertStringIncludes(indexHtml, '<meta name="twitter:creator" content="@alice">');

  const stat = res.statics.find((s) => s.file === "preview.png");
  assertEquals(stat?.target, "/srv/preview.png");
});

Deno.test("resource hints inject dns-prefetch and preconnect with head ordering", async () => {
  const res = await exportCue(`
    meta: {
      name: "hints-app"
      description: "resource hints"
      dnsPrefetch: ["https://cdn.example.com"]
      preconnect: [
        "https://fonts.googleapis.com",
        { href: "https://fonts.gstatic.com", crossorigin: true }
      ]
      favicon: "⚡"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="dns-prefetch" href="https://cdn.example.com">');
  assertStringIncludes(indexHtml, '<link rel="preconnect" href="https://fonts.googleapis.com">');
  assertStringIncludes(indexHtml, '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="./favicon.svg">');

  const dnsIdx = indexHtml.indexOf('<link rel="dns-prefetch"');
  const precIdx = indexHtml.indexOf('<link rel="preconnect"');
  const iconIdx = indexHtml.indexOf('<link rel="icon"');
  assertEquals(dnsIdx < precIdx, true);
  assertEquals(precIdx < iconIdx, true);
});

Deno.test("llms metadata emits llms.txt, llms-full.txt, statics, and Caddyfile handlers", async () => {
  const res = await exportCue(`
    meta: {
      name: "llms-app"
      description: "LLM discovery"
      llms: {
        text: "# LLMs summary\\nThis is the concise overview for agents."
        fullText: "# Full reference\\nThis is the detailed specification."
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  assertEquals(res.files["llms.txt"]?.text, "# LLMs summary\nThis is the concise overview for agents.");
  assertEquals(res.files["llms-full.txt"]?.text, "# Full reference\nThis is the detailed specification.");

  const stat1 = res.statics.find((s) => s.target === "/srv/llms.txt");
  assertEquals(stat1?.file, "llms.txt");
  const stat2 = res.statics.find((s) => s.target === "/srv/llms-full.txt");
  assertEquals(stat2?.file, "llms-full.txt");

  const caddyfile = res.files["docker/Caddyfile"]?.text ?? "";
  assertStringIncludes(caddyfile, "handle /llms.txt {");
  assertStringIncludes(caddyfile, "handle /llms-full.txt {");
  assertStringIncludes(caddyfile, 'header Content-Type "text/markdown; charset=utf-8"');
});

Deno.test("wellKnown metadata emits .well-known files, statics, and Caddyfile typing", async () => {
  const aasa = JSON.stringify({ applinks: { details: [] } });
  const res = await exportCue(`
    meta: {
      name: "wellknown-app"
      description: "wellknown demo"
      wellKnown: {
        "apple-app-site-association": ${JSON.stringify(aasa)}
        "assetlinks.json": "[{}]"
        "security.txt": file: "security.txt"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  assertEquals(res.files[".well-known/apple-app-site-association"]?.text, aasa);
  assertEquals(res.files[".well-known/assetlinks.json"]?.text, "[{}]");

  const aasaStat = res.statics.find((s) => s.target === "/srv/.well-known/apple-app-site-association");
  assertEquals(aasaStat?.file, ".well-known/apple-app-site-association");
  const secStat = res.statics.find((s) => s.target === "/srv/.well-known/security.txt");
  assertEquals(secStat?.file, "security.txt");

  const caddyfile = res.files["docker/Caddyfile"]?.text ?? "";
  assertStringIncludes(caddyfile, "handle /.well-known/* {");
  assertStringIncludes(caddyfile, "@extensionless path_regexp ^/\\.well-known/[^/.]+$");
  assertStringIncludes(caddyfile, 'header @extensionless Content-Type "application/json"');

  const extensionlessRegex = /^\/\.well-known\/[^/.]+$/;
  assertEquals(extensionlessRegex.test("/.well-known/apple-app-site-association"), true);
  assertEquals(extensionlessRegex.test("/.well-known/assetlinks"), true);
  assertEquals(extensionlessRegex.test("/.well-known/security.txt"), false);
  assertEquals(extensionlessRegex.test("/.well-known/assetlinks.json"), false);
});

Deno.test("path traversal with .. in manifest icons is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "invalid-manifest-icon"
      description: "invalid icon"
      manifest: {
        icons: [{ src: "../icons/icon.png" }]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "manifest icon src may not contain '..'");
});

Deno.test("path traversal with .. in social image is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "invalid-social-image"
      description: "invalid image"
      social: {
        image: "../secrets.png"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "social image path may not contain '..'");
});

Deno.test("protocol-relative URL in social image is refused at compile time because scrapers lack protocol context", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "invalid-social-image"
      description: "invalid image"
      social: {
        image: "//cdn.example.com/card.png"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "social.image must not be protocol-relative");
});

Deno.test("malformed preconnect href is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "invalid-preconnect"
      description: "invalid preconnect"
      preconnect: ["fonts.googleapis.com"]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "preconnect href must begin with https://, http://, or //");
});

Deno.test("path traversal with .. in wellKnown is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "invalid-wellknown"
      description: "invalid wellknown"
      wellKnown: {
        "../bad": "{}"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "wellKnown key may not contain '..' or '/'");
});

Deno.test("bundle.ts inlines manifest.webmanifest and its local icons into standalone single-file bundle", async () => {
  const app = await Deno.makeTempDir({ prefix: "bundle-envelope-test-" });
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repo = path.resolve(here, "../..");

    await Deno.mkdir(path.join(app, "shell"), { recursive: true });
    await Deno.writeTextFile(path.join(app, "shell/shell.json"), JSON.stringify({ routes: [], migrations: [], tables: [] }));
    await Deno.writeTextFile(path.join(app, "shell/shell.css"), "");
    await Deno.writeTextFile(path.join(app, "shell/design.css"), "");

    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await Deno.writeFile(path.join(app, "shell/icon-192.png"), fakePng);
    const fakeFavicon = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
    await Deno.writeFile(path.join(app, "shell/favicon.ico"), fakeFavicon);
    const fakeRootPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
    await Deno.writeFile(path.join(app, "icon-512.png"), fakeRootPng);

    const manifestData = {
      name: "Bundled PWA",
      short_name: "PWA",
      start_url: "./",
      display: "standalone",
      icons: [
        { src: "/shell/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "https://example.com/logo.png", sizes: "any", type: "image/png" },
      ]
    };
    await Deno.writeTextFile(path.join(app, "shell/manifest.webmanifest"), JSON.stringify(manifestData));

    await Deno.writeTextFile(
      path.join(app, "shell/index.html"),
      [
        "<!doctype html><html><head>",
        '<link rel="icon" href="./favicon.ico">',
        '<link rel="manifest" href="/manifest.webmanifest">',
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
    const iconMatch = outHtml.match(/<link\s+rel=["']icon["']\s+href=["']data:image\/x-icon;base64,([^"']+)["']>/);
    assert(iconMatch);
    const expectedFaviconDataUri = `data:image/x-icon;base64,${encodeBase64(fakeFavicon)}`;
    assertEquals(iconMatch[0], `<link rel="icon" href="${expectedFaviconDataUri}">`);

    const manifestMatch = outHtml.match(/<link\s+rel=["']manifest["']\s+href=["']data:application\/manifest\+json;base64,([^"']+)["']>/);
    assertEquals(Boolean(manifestMatch), true);

    const decodedManifestJson = new TextDecoder().decode(decodeBase64(manifestMatch![1]));
    const inlinedManifest = JSON.parse(decodedManifestJson);
    assertEquals(inlinedManifest.name, "Bundled PWA");

    const expectedPngDataUri = `data:image/png;base64,${encodeBase64(fakePng)}`;
    const expectedRootPngDataUri = `data:image/png;base64,${encodeBase64(fakeRootPng)}`;
    assertEquals(inlinedManifest.icons[0].src, expectedPngDataUri);
    assertEquals(inlinedManifest.icons[1].src, expectedRootPngDataUri);
    assertEquals(inlinedManifest.icons[2].src, "https://example.com/logo.png");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("bundle.ts fails loudly when an inlined icon file is missing on disk rather than falling back or swallowing", async () => {
  const app = await Deno.makeTempDir({ prefix: "bundle-missing-icon-test-" });
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repo = path.resolve(here, "../..");

    await Deno.mkdir(path.join(app, "shell"), { recursive: true });
    await Deno.writeTextFile(path.join(app, "shell/shell.json"), JSON.stringify({ routes: [], migrations: [], tables: [] }));
    await Deno.writeTextFile(path.join(app, "shell/shell.css"), "");
    await Deno.writeTextFile(path.join(app, "shell/design.css"), "");

    await Deno.writeTextFile(
      path.join(app, "shell/index.html"),
      [
        "<!doctype html><html><head>",
        '<link rel="icon" href="./missing.ico">',
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
    assertEquals(bundled.success, false);
    const stderr = new TextDecoder().decode(bundled.stderr);
    assertStringIncludes(stderr, "missing.ico");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("llms metadata emits statics from external workspace files", async () => {
  const res = await exportCue(`
    meta: {
      name: "llms-files"
      description: "LLM files"
      llms: {
        file: "docs/llms.md"
        fullFile: "docs/llms-full.md"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const stat1 = res.statics.find((s) => s.target === "/srv/llms.txt");
  assertEquals(stat1?.file, "docs/llms.md");
  const stat2 = res.statics.find((s) => s.target === "/srv/llms-full.txt");
  assertEquals(stat2?.file, "docs/llms-full.md");
});

Deno.test("local social image without social.url is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "social-missing-url"
      description: "missing url"
      social: {
        image: "preview.png"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "social.url is not declared");
});

Deno.test("llms declaring both text and file is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "llms-both"
      description: "both text and file"
      llms: {
        text: "hello"
        file: "docs/llms.md"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "llms cannot declare both text and file");
});

Deno.test("wellKnown declaring both text and file is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "wellknown-both"
      description: "both text and file"
      wellKnown: {
        "item": {
          text: "hello"
          file: "docs/item.txt"
        }
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "wellKnown 'item' cannot declare both text and file");
});

Deno.test("single string preconnect and dnsPrefetch shorthand are accepted", async () => {
  const res = await exportCue(`
    meta: {
      name: "shorthand-hints"
      description: "hints shorthand"
      preconnect: "https://fonts.googleapis.com"
      dnsPrefetch: "https://cdn.example.com"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="preconnect" href="https://fonts.googleapis.com">');
  assertStringIncludes(indexHtml, '<link rel="dns-prefetch" href="https://cdn.example.com">');
});

Deno.test("app with no envelope declarations preserves blank icon and emits no extra tags", async () => {
  const res = await exportCue(`
    meta: {
      name: "bare-app"
      description: "app without envelope"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertEquals(indexHtml.includes('<link rel="manifest"'), false);
  assertEquals(indexHtml.includes('<meta name="theme-color"'), false);
  assertEquals(indexHtml.includes('<meta property="og:'), false);
  assertEquals(indexHtml.includes('<meta name="twitter:'), false);
  assertStringIncludes(indexHtml, '<link rel="icon" href="data:,">');
});

Deno.test("manifest icon inferred from emoji favicon points to /shell/favicon.svg", async () => {
  const res = await exportCue(`
    meta: {
      name: "emoji-manifest-app"
      description: "emoji favicon manifest"
      manifest: true
      favicon: "🎯"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const manifest = JSON.parse(res.files["shell/manifest.webmanifest"]?.text ?? "");
  assertEquals(manifest.icons, [
    { src: "/shell/favicon.svg", type: "image/svg+xml", sizes: "any" }
  ]);

  const stat = res.statics.find((s) => s.target === "/srv/shell/favicon.svg");
  assertEquals(stat?.file, "shell/favicon.svg");
});

Deno.test("social.url with path extracts origin for og:image", async () => {
  const res = await exportCue(`
    meta: {
      name: "social-path-app"
      description: "social url with path"
      social: {
        url: "https://demo.example.com/games/chess"
        image: "preview.png"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<meta property="og:url" content="https://demo.example.com/games/chess">');
  assertEquals(indexHtml.includes('rel="canonical"'), false);
  assertStringIncludes(indexHtml, '<meta property="og:image" content="https://demo.example.com/preview.png">');
  assertStringIncludes(indexHtml, '<meta name="twitter:image" content="https://demo.example.com/preview.png">');
});

Deno.test("social.url non-absolute is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "social-bad-url"
      description: "non-absolute url"
      social: {
        url: "example.com"
        image: "preview.png"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "social.url must begin with https:// or http://");
});

Deno.test("wellKnown empty item is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "wellknown-empty"
      description: "empty item"
      wellKnown: {
        "empty": {}
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "wellKnown 'empty' must declare either text or file");
});

Deno.test("remote and protocol-relative favicons are derived into manifest icons without local statics", async () => {
  const res = await exportCue(`
    meta: {
      name: "remote-favicon-app"
      description: "remote favicon manifest"
      manifest: true
      favicon: [
        "https://cdn.example.com/logo.png",
        "//cdn.example.com/vector.svg"
      ]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const manifest = JSON.parse(res.files["shell/manifest.webmanifest"]?.text ?? "");
  assertEquals(manifest.icons, [
    { src: "https://cdn.example.com/logo.png", type: "image/png" },
    { src: "//cdn.example.com/vector.svg", type: "image/svg+xml", sizes: "any" }
  ]);

  // Remote and protocol-relative icons must not be emitted as local cluster statics
  const remoteStatics = res.statics.filter((s) => s.target.includes("cdn.example.com"));
  assertEquals(remoteStatics.length, 0);
});

Deno.test("bundle.ts preserves absolute start_url and scope under --base", async () => {
  const app = await Deno.makeTempDir({ prefix: "bundle-manifest-base-test-" });
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repo = path.resolve(here, "../..");

    await Deno.mkdir(path.join(app, "shell"), { recursive: true });
    await Deno.writeTextFile(path.join(app, "shell/shell.json"), JSON.stringify({ routes: [], migrations: [], tables: [] }));
    await Deno.writeTextFile(path.join(app, "shell/shell.css"), "body {}");
    await Deno.writeTextFile(path.join(app, "shell/design.css"), "body {}");
    await Deno.writeTextFile(path.join(app, "shell/boot.js"), "console.log('boot');");

    const manifestData = {
      name: "Absolute URL PWA",
      start_url: "https://example.com/app/start",
      scope: "https://example.com/app/",
    };
    await Deno.writeTextFile(path.join(app, "shell/manifest.webmanifest"), JSON.stringify(manifestData));

    await Deno.writeTextFile(
      path.join(app, "shell/index.html"),
      [
        "<!doctype html><html><head>",
        '<link rel="manifest" href="/manifest.webmanifest">',
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
        "--base", "/myprefix",
        "--omnishell", path.join(repo, "plugins/omnishell"), "--mecha", path.join(repo, "libraries/mecha"),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(bundled.success, true);

    const outHtml = await Deno.readTextFile(path.join(app, "dist/browser/index.html"));
    const manifestMatch = outHtml.match(/<link\s+rel=["']manifest["']\s+href=["']data:application\/manifest\+json;base64,([^"']+)["']>/);
    assertEquals(Boolean(manifestMatch), true);

    const decodedManifestJson = new TextDecoder().decode(decodeBase64(manifestMatch![1]));
    const inlinedManifest = JSON.parse(decodedManifestJson);
    assertEquals(inlinedManifest.start_url, "https://example.com/app/start");
    assertEquals(inlinedManifest.scope, "https://example.com/app/");
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("manifest icon path normalization preserves root ./ and shell/ paths", async () => {
  const res = await exportCue(`
    meta: {
      name: "icon-norm-app"
      description: "testing manifest icon normalization"
      manifest: {
        icons: [
          { src: "./root-icon.png", type: "image/png" },
          { src: "./shell/shell-icon.png", type: "image/png" },
          { src: "shell/another-shell.png", type: "image/png" },
          { src: "/custom/custom-icon.png", type: "image/png" },
        ]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const manifest = JSON.parse(res.files["shell/manifest.webmanifest"]?.text ?? "");
  assertEquals(manifest.icons, [
    { src: "/root-icon.png", type: "image/png" },
    { src: "/shell/shell-icon.png", type: "image/png" },
    { src: "/shell/another-shell.png", type: "image/png" },
    { src: "/custom/custom-icon.png", type: "image/png" },
  ]);

  const rootStat = res.statics.find((s) => s.file === "root-icon.png");
  assertEquals(rootStat?.target, "/srv/root-icon.png");
  const shellStat = res.statics.find((s) => s.file === "shell/shell-icon.png");
  assertEquals(shellStat?.target, "/srv/shell/shell-icon.png");
  const anotherShellStat = res.statics.find((s) => s.file === "shell/another-shell.png");
  assertEquals(anotherShellStat?.target, "/srv/shell/another-shell.png");
  const customStat = res.statics.find((s) => s.file === "custom/custom-icon.png");
  assertEquals(customStat?.target, "/srv/custom/custom-icon.png");
});

Deno.test("raw manifest icons with protocol-relative URLs pass through unchanged without statics", async () => {
  const res = await exportCue(`
    meta: {
      name: "proto-rel-manifest-icon"
      description: "testing manifest icon protocol-relative url"
      manifest: {
        icons: [
          { src: "//cdn.example.com/icon.png", type: "image/png" },
        ]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  const manifest = JSON.parse(res.files["shell/manifest.webmanifest"]?.text ?? "");
  assertEquals(manifest.icons, [
    { src: "//cdn.example.com/icon.png", type: "image/png" },
  ]);
  const protoRelStatics = res.statics.filter((s) => s.target.includes("cdn.example.com"));
  assertEquals(protoRelStatics.length, 0);
});

Deno.test("explicit apple-touch-icon with SVG format is refused at compile time for Safari on iOS compatibility", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "svg-apple-touch-refusal"
      description: "testing svg apple-touch refusal"
      favicon: { rel: "apple-touch-icon", href: "icon.svg" }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "apple-touch-icon format not supported on Safari on iOS; must be PNG or JPEG");
});

Deno.test("explicit apple-touch-icon with WebP format is refused at compile time for Safari on iOS compatibility", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "webp-apple-touch-refusal"
      description: "testing webp apple-touch refusal"
      favicon: { rel: "apple-touch-icon", href: "icon.webp" }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "apple-touch-icon format not supported on Safari on iOS; must be PNG or JPEG");
});

Deno.test("apple-touch-icon is auto-derived from PNG favicon when no explicit apple-touch-icon is declared", async () => {
  const res = await exportCue(`
    meta: {
      name: "auto-apple-touch-app"
      description: "testing auto apple-touch derivation"
      favicon: "icon.png"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/png" href="/icon.png">');
  assertStringIncludes(indexHtml, '<link rel="apple-touch-icon" href="/icon.png">');
});

Deno.test("apple-touch-icon is not auto-derived when only SVG favicon is declared", async () => {
  const res = await exportCue(`
    meta: {
      name: "no-auto-apple-touch-app"
      description: "testing no auto apple-touch for svg"
      favicon: "icon.svg"
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="icon" type="image/svg+xml" href="/icon.svg">');
  assertEquals(indexHtml.includes('<link rel="apple-touch-icon"'), false);
});

Deno.test("adaptive light and dark theme-color meta tags are derived from surface.design when themeColor is omitted", async () => {
  const res = await exportCue(`
    meta: {
      name: "adaptive-theme-color-app"
      description: "testing adaptive theme-color"
      manifest: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">');
  assertStringIncludes(indexHtml, '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1e1f">');
});

Deno.test("manifest shortcuts are auto-derived from non-root static screens in surface.screens", async () => {
  const res = await exportCue(`
    meta: {
      name: "shortcuts-app"
      description: "testing shortcuts derivation"
      manifest: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    surface: {
      screens: {
        home: {
          title: "Home"
          route: "/"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
        }
        explore: {
          title: "Explore"
          route: "/explore"
          markup: "<main>Explore</main>"
          reads: []
          forms: []
          states: []
        }
        settings: {
          title: "Settings"
          route: "/settings"
          markup: "<main>Settings</main>"
          reads: []
          forms: []
          states: []
        }
      }
      handlers: {}
      design: {}
      flows: {}
    }
  `);
  const manifest = JSON.parse(res.files["shell/manifest.webmanifest"]?.text ?? "");
  assertEquals(manifest.shortcuts, [
    { name: "Explore", url: "/explore" },
    { name: "Settings", url: "/settings" },
  ]);
});

Deno.test("manifest shortcuts can be explicitly overridden by author", async () => {
  const res = await exportCue(`
    meta: {
      name: "shortcuts-override-app"
      description: "testing shortcuts override"
      manifest: {
        shortcuts: [
          { name: "Custom Action", url: "/custom" }
        ]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const manifest = JSON.parse(res.files["shell/manifest.webmanifest"]?.text ?? "");
  assertEquals(manifest.shortcuts, [
    { name: "Custom Action", url: "/custom" },
  ]);
});

Deno.test("meta.llms: true auto-synthesizes llms.txt and llms-full.txt from screens, entities, and auth", async () => {
  const res = await exportCue(`
    meta: {
      name: "synthesized-llms-app"
      description: "App with auto-synthesized LLM documentation"
      llms: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    state: {
      entities: {
        article: {
          name: "article"
          table: "article"
          durability: "live"
          access: { scope: "public" }
          fields: [
            { name: "id", type: "string", pk: true },
            { name: "title", type: "string" },
            { name: "views", type: "int" }
          ]
        }
      }
      pipelines: {}
    }
    surface: {
      screens: {
        home: {
          title: "Home"
          route: "/"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
        }
        reader: {
          title: "Article Reader"
          route: "/article"
          markup: "<main></main>"
          reads: [{ table: "article", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] }]
          forms: []
          states: []
        }
      }
      handlers: {}
      design: {}
      flows: {}
    }
  `);

  const llmsTxt = res.files["llms.txt"]?.text ?? "";
  assertStringIncludes(llmsTxt, "# synthesized-llms-app");
  assertStringIncludes(llmsTxt, "> App with auto-synthesized LLM documentation");
  assertStringIncludes(llmsTxt, "## Overview");
  assertStringIncludes(llmsTxt, "Publicly accessible web application.");
  assertStringIncludes(llmsTxt, "## Screens");
  assertStringIncludes(llmsTxt, "- [Home](/): home screen");
  assertStringIncludes(llmsTxt, "- [Article Reader](/article): reader screen");
  assertStringIncludes(llmsTxt, "## Data Models");
  assertStringIncludes(llmsTxt, "- `article`: domain entity");

  const llmsFullTxt = res.files["llms-full.txt"]?.text ?? "";
  assertStringIncludes(llmsFullTxt, "# synthesized-llms-app - Full Specification");
  assertStringIncludes(llmsFullTxt, "### Screen: Article Reader");
  assertStringIncludes(llmsFullTxt, "- Route: `/article`");
  assertStringIncludes(llmsFullTxt, "- Reads: article");
  assertStringIncludes(llmsFullTxt, "### Entity: article");
  assertStringIncludes(llmsFullTxt, "- `title` (string)");
  assertStringIncludes(llmsFullTxt, "- `views` (int)");

  const llmsStat = res.statics.find((s) => s.target === "/srv/llms.txt");
  assertEquals(llmsStat?.file, "llms.txt");
  const llmsFullStat = res.statics.find((s) => s.target === "/srv/llms-full.txt");
  assertEquals(llmsFullStat?.file, "llms-full.txt");
});

Deno.test("meta.sitemap: true emits intelligent priority, changefreq, and link rel='sitemap' in head", async () => {
  const res = await exportCue(`
    meta: {
      name: "intelligent-sitemap-app"
      description: "App with intelligent sitemap inference"
      sitemap: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    state: {
      entities: {
        feed: {
          name: "feed"
          table: "feed"
          durability: "device"
          fields: [
            { name: "id", type: "string", pk: true },
            { name: "content", type: "string" }
          ]
        }
      }
      pipelines: {}
    }
    surface: {
      screens: {
        home: {
          title: "Home"
          route: "/"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
        }
        liveFeed: {
          title: "Live Feed"
          route: "/feed"
          markup: "<main></main>"
          reads: [{ table: "feed", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] }]
          forms: []
          states: []
        }
        about: {
          title: "About Us"
          route: "/about"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
          priority: 0.3
          changefreq: "never"
        }
      }
      handlers: {}
      design: {}
      flows: {}
    }
  `);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="sitemap" type="application/xml" href="/sitemap.xml">');

  const sitemapXml = res.files["sitemap.xml"]?.text ?? "";
  assertStringIncludes(sitemapXml, "<loc>{{$o}}/</loc>");
  assertStringIncludes(sitemapXml, "<priority>1.0</priority>");

  assertStringIncludes(sitemapXml, "<loc>{{$o}}/feed</loc>");
  assertStringIncludes(sitemapXml, "<priority>0.8</priority>");
  assertStringIncludes(sitemapXml, "<changefreq>daily</changefreq>");

  assertStringIncludes(sitemapXml, "<loc>{{$o}}/about</loc>");
  assertStringIncludes(sitemapXml, "<priority>0.3</priority>");
  assertStringIncludes(sitemapXml, "<changefreq>never</changefreq>");
});

Deno.test("meta.sitemap with exclude and extra shapes crawlable routes and statics", async () => {
  const res = await exportCue(`
    meta: {
      name: "sitemap-config-app"
      description: "App with custom sitemap configuration"
      sitemap: {
        exclude: ["/admin"]
        extra: ["/changelog", "https://external.example.com/rss"]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    surface: {
      screens: {
        home: {
          title: "Home"
          route: "/"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
        }
        admin: {
          title: "Admin"
          route: "/admin"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
        }
      }
      handlers: {}
      design: {}
      flows: {}
    }
  `);

  const sitemapXml = res.files["sitemap.xml"]?.text ?? "";
  assertStringIncludes(sitemapXml, "<loc>{{$o}}/</loc>");
  assertEquals(sitemapXml.includes("<loc>{{$o}}/admin</loc>"), false);
  assertStringIncludes(sitemapXml, "<loc>{{$o}}/changelog</loc>");
  assertStringIncludes(sitemapXml, "<loc>https://external.example.com/rss</loc>");
});

Deno.test("meta.sitemap with exclude: ['/'] excludes only root route while keeping child routes", async () => {
  const res = await exportCue(`
    meta: {
      name: "sitemap-exclude-root"
      description: "App excluding root screen from sitemap"
      sitemap: {
        exclude: ["/"]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    surface: {
      screens: {
        home: {
          title: "Home"
          route: "/"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
        }
        about: {
          title: "About"
          route: "/about"
          markup: "<main></main>"
          reads: []
          forms: []
          states: []
        }
      }
      handlers: {}
      design: {}
      flows: {}
    }
  `);

  const sitemapXml = res.files["sitemap.xml"]?.text ?? "";
  assertEquals(sitemapXml.includes("<loc>{{$o}}/</loc>"), false);
  assertStringIncludes(sitemapXml, "<loc>{{$o}}/about</loc>");
});

Deno.test("meta.sitemap: false disables sitemap.xml, statics, and robots.txt Sitemap declaration", async () => {
  const res = await exportCue(`
    meta: {
      name: "sitemap-disabled-app"
      description: "App with sitemap explicitly disabled"
      sitemap: false
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);

  assertEquals(res.files["sitemap.xml"], undefined);
  const sitemapStat = res.statics.find((s) => s.target === "/srv/sitemap.xml");
  assertEquals(sitemapStat, undefined);

  const robotsTxt = res.files["robots.txt"]?.text ?? "";
  assertEquals(robotsTxt.includes("Sitemap:"), false);

  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertEquals(indexHtml.includes('<link rel="sitemap"'), false);
});

Deno.test("sitemap exclude path not beginning with / is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "invalid-exclude-app"
      description: "testing invalid exclude"
      sitemap: {
        exclude: ["relative/path"]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "sitemap exclude path must begin with '/'");
});

Deno.test("sitemap extra path not beginning with /, http://, or https:// is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "invalid-extra-app"
      description: "testing invalid extra"
      sitemap: {
        extra: ["ftp://invalid.com/path"]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "sitemap extra path must begin with '/', 'http://', or 'https://'");
});

Deno.test("sitemap: true on auth-required app is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "auth-sitemap-app"
      description: "testing auth sitemap conflict"
      sitemap: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    capabilities: {
      auth: { required: true, service: "/auth" }
      hatches: {}
      vendored: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "sitemap cannot be enabled when capabilities.auth.required is true");
});

Deno.test("priority: 1 as integer unifies properly and formats as 1.0 in sitemap.xml", async () => {
  const res = await exportCue(`
    meta: {
      name: "priority-int-app"
      description: "testing integer priority"
      sitemap: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    surface: screens: {
      home: {
        title: "Home"
        route: "/"
        priority: 1
        markup: "<main></main>"
        reads: []
        forms: []
        states: []
      }
    }
  `);
  const sitemapXml = res.files["sitemap.xml"]?.text ?? "";
  assertStringIncludes(sitemapXml, "<priority>1.0</priority>");
});

Deno.test("sitemap extra URLs escape XML entities", async () => {
  const res = await exportCue(`
    meta: {
      name: "sitemap-escape-app"
      description: "testing sitemap xml escaping"
      sitemap: {
        extra: ["/feed?view=all&sort=asc"]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const sitemapXml = res.files["sitemap.xml"]?.text ?? "";
  assertStringIncludes(sitemapXml, "<loc>{{$o}}/feed?view=all&amp;sort=asc</loc>");
});

Deno.test("spoofed type: image/png with .svg href for apple-touch-icon is refused for Safari iOS", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "spoofed-apple-touch"
      description: "testing apple-touch spoofing refusal"
      favicon: [
        { href: "shell/icon.svg", rel: "apple-touch-icon", type: "image/png" }
      ]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_faviconValidRefusal");
  assertStringIncludes(stderr, "apple-touch-icon format not supported on Safari on iOS; must be PNG or JPEG");
});

Deno.test("auto-synthesis meta.llms: true is refused on auth-required apps", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "auth-llms-app"
      description: "testing auth llms conflict"
      llms: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    capabilities: {
      auth: { required: true, service: "/auth" }
      hatches: {}
      vendored: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "llms auto-synthesis cannot be enabled when capabilities.auth.required is true");
});

Deno.test("custom meta.llms with text does not synthesize llms-full.txt", async () => {
  const res = await exportCue(`
    meta: {
      name: "custom-llms-app"
      description: "custom llms"
      llms: {
        text: "Custom curated overview for LLMs."
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertEquals(res.files["llms.txt"]?.text, "Custom curated overview for LLMs.");
  assertEquals(res.files["llms-full.txt"], undefined);
  const fullStat = res.statics.find((s) => s.target === "/srv/llms-full.txt");
  assertEquals(fullStat, undefined);
});

Deno.test("apple-touch-icon auto-derivation prioritizes touch sizes (180/192/512)", async () => {
  const res = await exportCue(`
    meta: {
      name: "touch-size-app"
      description: "touch sizes"
      favicon: [
        { href: "shell/icon-32.png", sizes: "32x32" },
        { href: "shell/icon-192.png", sizes: "192x192" },
        { href: "shell/icon-16.png", sizes: "16x16" }
      ]
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="apple-touch-icon" href="./icon-192.png">');
});

Deno.test("PWA manifest shortcuts auto-derivation is suppressed on auth-required apps", async () => {
  const res = await exportCue(`
    meta: {
      name: "auth-shortcuts-app"
      description: "auth shortcuts"
      manifest: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    capabilities: {
      auth: { required: true, service: "/auth" }
      hatches: {}
      vendored: {}
    }
    surface: screens: {
      dashboard: {
        title: "Dashboard"
        route: "/dashboard"
        markup: "<main></main>"
        reads: []
        forms: []
        states: []
      }
    }
  `);
  const manifestRaw = res.files["shell/manifest.webmanifest"]?.text ?? "{}";
  const manifest = JSON.parse(manifestRaw);
  assertEquals(manifest.shortcuts, undefined);
});

Deno.test("preconnect without crossorigin does not emit crossorigin attribute", async () => {
  const res = await exportCue(`
    meta: {
      name: "no-crossorigin-preconnect"
      description: "testing preconnect tag"
      preconnect: {
        href: "https://fonts.googleapis.com"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertStringIncludes(indexHtml, '<link rel="preconnect" href="https://fonts.googleapis.com">');
  assertEquals(indexHtml.includes("crossorigin"), false);
});

Deno.test("llms file with leading slash is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "llms-slash-file"
      description: "testing leading slash"
      llms: {
        file: "/etc/passwd"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "llms file may not contain '..' or begin with '/'");
});

Deno.test("wellKnown empty key is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "wellknown-empty-key"
      description: "testing empty key"
      wellKnown: {
        "": "data"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "wellKnown key may not contain '..' or '/' and may not be empty or '.'");
});

Deno.test("wellKnown file with leading slash is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "wellknown-slash-file"
      description: "testing leading slash file"
      wellKnown: {
        "item": {
          file: "/etc/hosts"
        }
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "wellKnown file may not contain '..' or begin with '/'");
});

Deno.test("social imageAlt without image does not emit og:image:alt", async () => {
  const res = await exportCue(`
    meta: {
      name: "social-alt-only"
      description: "testing alt without image"
      social: {
        imageAlt: "alt text without an image"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  const indexHtml = res.files["shell/index.html"]?.text ?? "";
  assertEquals(indexHtml.includes("og:image:alt"), false);
});

Deno.test("social image with data URI is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "social-data-uri"
      description: "testing data URI image"
      social: {
        url: "https://example.com"
        image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "social.image must not be a data URI");
});

Deno.test("sitemap extra path with template delimiters is refused at compile time", async () => {
  const stderr = await assertCueFails(`
    meta: {
      name: "sitemap-template-inject"
      description: "testing sitemap extra template injection"
      sitemap: {
        extra: ["/secret/{{env \\"API_KEY\\"}}"]
      }
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
  `);
  assertStringIncludes(stderr, "_envelopeRefusal");
  assertStringIncludes(stderr, "sitemap extra path may not contain template delimiters");
});

Deno.test("meta.llms: true excludes entities with private or internal access scope", async () => {
  const res = await exportCue(`
    meta: {
      name: "llms-privacy-app"
      description: "App with private and public entities"
      llms: true
      ir: sha256: ""
      targets: []
      clocks: []
      decisions: {}
      tests: {}
    }
    state: {
      entities: {
        publicPost: {
          name: "publicPost"
          table: "public_post"
          durability: "live"
          access: { scope: "public" }
          fields: [
            { name: "id", type: "string", pk: true },
            { name: "body", type: "string" }
          ]
        }
        internalSecret: {
          name: "internalSecret"
          table: "internal_secret"
          durability: "live"
          access: { scope: "internal" }
          fields: [
            { name: "id", type: "string", pk: true },
            { name: "token", type: "string" }
          ]
        }
        userDoc: {
          name: "userDoc"
          table: "user_doc"
          durability: "live"
          access: { scope: "private", owner: "id" }
          fields: [
            { name: "id", type: "string", pk: true },
            { name: "data", type: "string" }
          ]
        }
        folderDoc: {
          name: "folderDoc"
          table: "folder_doc"
          durability: "live"
          access: { scope: "folder", parent: "userDoc", on: "id" }
          fields: [
            { name: "id", type: "string", pk: true },
            { name: "data", type: "string" }
          ]
        }
        clientSetting: {
          name: "clientSetting"
          table: "client_setting"
          durability: "device"
          fields: [
            { name: "id", type: "string", pk: true },
            { name: "theme", type: "string" }
          ]
        }
      }
      pipelines: {}
    }
    surface: {
      screens: {
        feed: {
          title: "Public Feed"
          route: "/feed"
          markup: "<main></main>"
          reads: [
            { table: "public_post", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] },
            { table: "public_post", kind: "named", nested: false, lists: [], route: "server", clauses: [], embeds: [], orders: [] },
            { table: "folder_doc", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] }
          ]
          forms: []
          states: []
        }
        account: {
          title: "Account Settings"
          route: "/account"
          markup: "<main></main>"
          reads: [
            { table: "user_doc", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] },
            { table: "internal_secret", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] },
            { table: "client_setting", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] }
          ]
          forms: []
          states: []
        }
      }
      handlers: {}
      design: {}
      flows: {}
    }
  `);

  const llmsTxt = res.files["llms.txt"]?.text ?? "";
  assertStringIncludes(llmsTxt, "- `publicPost`: domain entity");
  assertEquals(llmsTxt.includes("internalSecret"), false);
  assertEquals(llmsTxt.includes("userDoc"), false);
  assertEquals(llmsTxt.includes("folderDoc"), false);
  assertEquals(llmsTxt.includes("clientSetting"), false);

  const llmsFullTxt = res.files["llms-full.txt"]?.text ?? "";
  assertStringIncludes(llmsFullTxt, "### Entity: publicPost");
  assertStringIncludes(llmsFullTxt, "### Screen: Public Feed\n- Route: `/feed`\n- Reads: publicPost");
  assertStringIncludes(llmsFullTxt, "### Screen: Account Settings\n- Route: `/account`\n- Reads: none");
  assertEquals(llmsFullTxt.includes("internalSecret"), false);
  assertEquals(llmsFullTxt.includes("userDoc"), false);
  assertEquals(llmsFullTxt.includes("folderDoc"), false);
  assertEquals(llmsFullTxt.includes("clientSetting"), false);
});



