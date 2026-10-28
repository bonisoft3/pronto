import { assertEquals, assert } from "jsr:@std/assert@1.0.11";
import {
  extractAssetsFromHints,
  extractAssetsFromHtml,
  extractPrimaryScreen,
  harvestLinksFromHtml,
  resolveParameterizedRoutes,
  verifyHttp,
  type EdgeHints,
} from "./http-sweep.ts";

const sampleHints: EdgeHints = {
  common: [
    "</shell/_immutable-abc123-style.css>; rel=preload; as=style",
    "</shell/_immutable-def456-shell.json>; rel=preload; as=fetch",
  ],
  catalogues: {
    "pt-BR": "</messages/_immutable-pt1-pt-BR.json>; rel=preload; as=fetch",
    "en-US": "</messages/en-US.json>; rel=preload; as=fetch",
  },
  routes: [
    {
      path: "/",
      links: [
        "</shell/screens/_immutable-screen1-home.html.txt>; rel=preload; as=fetch",
      ],
      screens: ["home"],
    },
    {
      path: "/jogos",
      links: [
        "</shell/screens/_immutable-screen2-games.html.txt>; rel=preload; as=fetch",
      ],
      screens: ["games"],
    },
    {
      path: "/jogo/:slug",
      links: [
        "</shell/screens/_immutable-screen3-game.html.txt>; rel=preload; as=fetch",
      ],
      screens: ["game"],
    },
  ],
};

Deno.test("extractAssetsFromHints separates immutable assets, catalogues, and static routes", () => {
  const extracted = extractAssetsFromHints(sampleHints);
  assertEquals(extracted.immutableAssets, [
    "/messages/_immutable-pt1-pt-BR.json",
    "/shell/_immutable-abc123-style.css",
    "/shell/_immutable-def456-shell.json",
    "/shell/screens/_immutable-screen1-home.html.txt",
    "/shell/screens/_immutable-screen2-games.html.txt",
    "/shell/screens/_immutable-screen3-game.html.txt",
  ]);
  assertEquals(extracted.catalogues, ["/messages/en-US.json"]);
  assertEquals(extracted.routes, ["/", "/jogos"]);
});

Deno.test("extractPrimaryScreen identifies primary screen name from immutable template link", () => {
  const screen1 = extractPrimaryScreen(sampleHints.routes![0]);
  const screen2 = extractPrimaryScreen(sampleHints.routes![1]);
  const screen3 = extractPrimaryScreen(sampleHints.routes![2]);
  assertEquals(screen1, "home");
  assertEquals(screen2, "games");
  assertEquals(screen3, "game");
});

Deno.test("extractPrimaryScreen prioritizes route template link over transition target screens", () => {
  const route = {
    path: "/games",
    links: ["</shell/screens/_immutable-123-games.html.txt>"],
    screens: ["game", "player"],
  };
  assertEquals(extractPrimaryScreen(route), "games");
});

Deno.test("extractPrimaryScreen derives screen name from files.html", () => {
  assertEquals(
    extractPrimaryScreen({
      path: "/equipe/:id",
      files: { html: "shell/screens/team.html" },
    }),
    "team"
  );
  assertEquals(
    extractPrimaryScreen({
      path: "/equipe/:id",
      files: { html: "shell/screens/team.html.txt" },
    }),
    "team"
  );
});

Deno.test("harvestLinksFromHtml and resolveParameterizedRoutes resolve dynamic slugs", async () => {
  const html = `
    <html>
      <body>
        <a href="/jogos">Matches</a>
        <a href="/jogo/2026-final-match">Final Match</a>
      </body>
    </html>
  `;
  const links = harvestLinksFromHtml(html);
  assertEquals(links, ["/jogos", "/jogo/2026-final-match"]);

  const { resolvedRoutes, screenRoutes } = await resolveParameterizedRoutes(
    sampleHints.routes!,
    new Set(links)
  );

  assertEquals(resolvedRoutes.get("/jogo/:slug"), "/jogo/2026-final-match");
  assertEquals(screenRoutes.get("game"), "/jogo/2026-final-match");
});

Deno.test("verifyHttp passes when all immutable assets, catalogues, probe, and routes succeed", async () => {
  const mockFetch = async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("dummy.css")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    if (url.includes("_immutable-")) {
      return new Response("body", {
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Type": "text/css",
        },
      });
    }

    if (url.includes("/messages/")) {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Routes: include live link to /jogo/live-slug on home page
    const body = url.endsWith("/jogos")
      ? '<html><body><a href="/jogo/live-slug">Live Match</a></body></html>'
      : '<html><body><a href="/jogos">Matches</a><a href="/jogo/live-slug">Live Match</a></body></html>';

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };

  const result = await verifyHttp("https://app.example.com", {
    hints: sampleHints,
    fetchFn: mockFetch as typeof fetch,
  });

  assertEquals(result.passed, true);
  assertEquals(result.errors, []);
  assertEquals(result.assetsChecked, 6);
  assertEquals(result.cataloguesChecked, 1);
  assertEquals(result.routesChecked, 3); // /, /jogos, and resolved /jogo/live-slug
  assertEquals(result.resolvedRoutes.get("/jogo/:slug"), "/jogo/live-slug");
  assertEquals(result.negativeProbeChecked, true);
});

Deno.test("verifyHttp catches 404 immutable asset error", async () => {
  const mockFetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("screen2-games")) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response("ok", {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "text/html",
      },
    });
  };

  const result = await verifyHttp("https://app.example.com", {
    hints: sampleHints,
    fetchFn: mockFetch as typeof fetch,
  });

  assertEquals(result.passed, false);
  assert(
    result.errors.some((err) =>
      err.includes("Immutable asset /shell/screens/_immutable-screen2-games.html.txt returned HTTP 404")
    )
  );
});

Deno.test("verifyHttp catches negative 404 cache poisoning vulnerability", async () => {
  const mockFetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("dummy.css")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    return new Response("ok", {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "text/html",
      },
    });
  };

  const result = await verifyHttp("https://app.example.com", {
    hints: sampleHints,
    fetchFn: mockFetch as typeof fetch,
  });

  assertEquals(result.passed, false);
  assert(
    result.errors.some((err) =>
      err.includes("returned immutable caching header")
    )
  );
});

Deno.test("verifyHttp fails when response stream stalls during body read", async () => {
  const stallingFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("dummy.css")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    // Stream body that never resolves chunks until signal aborts
    const signal = init?.signal;
    const stream = new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new Error("Stream aborted by timeout"));
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "text/html",
      },
    });
  };

  const result = await verifyHttp("https://app.example.com", {
    hints: sampleHints,
    fetchFn: stallingFetch as typeof fetch,
    timeoutMs: 50,
  });

  assertEquals(result.passed, false);
  assert(
    result.errors.some((err) =>
      err.includes("abort") || err.includes("AbortError") || err.includes("timeout")
    )
  );
});

Deno.test("resolveParameterizedRoutes strips mount prefix when matching live links", () => {
  const routes = [
    { path: "/todo/:id", screen: "todo-detail" },
  ];
  const links = new Set(["/prefix/todo/item-999"]);
  const { resolvedRoutes, screenRoutes } = resolveParameterizedRoutes(
    routes,
    links,
    "/prefix"
  );
  assertEquals(resolvedRoutes.get("/todo/:id"), "/todo/item-999");
  assertEquals(screenRoutes.get("todo-detail"), "/todo/item-999");
});

Deno.test("verifyHttp allows 404 on non-root deep links for Pages platform", async () => {
  const mockFetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("dummy.css")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }
    if (url.endsWith("/my-app/")) {
      return new Response("<html><body><a href=\"/my-app/jogos\">Jogos</a></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    // Deep link on Pages returns 404 with 404.html content
    if (url.includes("/jogos")) {
      return new Response("<html><body>404.html SPA entry</body></html>", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("ok", {
      status: 200,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    });
  };

  const result = await verifyHttp("https://owner.github.io/my-app/", {
    platform: "pages",
    routes: ["/", "/jogos"],
    fetchFn: mockFetch as typeof fetch,
  });

  assertEquals(result.passed, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("resolveParameterizedRoutes matches localized path variants and locale prefixes", () => {
  const routes = [
    {
      path: "/jogador/:slug",
      screen: "player",
      paths: {
        "en-US": "/player/:slug",
        "es-AR": "/jugador/:slug",
      },
    },
  ];
  const links = new Set(["/en-US/player/l-yamal"]);
  const { resolvedRoutes, screenRoutes } = resolveParameterizedRoutes(
    routes,
    links,
    "",
    { locales: { "en-US": {}, "pt-BR": {} } }
  );
  assertEquals(resolvedRoutes.get("/jogador/:slug"), "/en-US/player/l-yamal");
  assertEquals(screenRoutes.get("player"), "/en-US/player/l-yamal");
});

Deno.test("resolveParameterizedRoutes matches configured locale path segments differing from BCP-47 tag", () => {
  const routes = [
    {
      path: "/jogo/:slug",
      screen: "game",
    },
  ];
  const links = new Set(["/pt-br/jogo/2026-final"]);
  const { resolvedRoutes, screenRoutes } = resolveParameterizedRoutes(
    routes,
    links,
    "",
    { locales: { "pt-BR": { path: "pt-br" } } }
  );
  assertEquals(resolvedRoutes.get("/jogo/:slug"), "/pt-br/jogo/2026-final");
  assertEquals(screenRoutes.get("game"), "/pt-br/jogo/2026-final");
});

Deno.test("resolveParameterizedRoutes matches slugs containing words like missing or undefined", () => {
  const routes = [
    { path: "/article/:slug", screen: "article" },
    { path: "/profile/:user", screen: "profile" },
  ];
  const links = new Set(["/article/missing-person", "/profile/undefined"]);
  const { resolvedRoutes, screenRoutes } = resolveParameterizedRoutes(routes, links);
  assertEquals(resolvedRoutes.get("/article/:slug"), "/article/missing-person");
  assertEquals(screenRoutes.get("article"), "/article/missing-person");
  assertEquals(resolvedRoutes.get("/profile/:user"), "/profile/undefined");
  assertEquals(screenRoutes.get("profile"), "/profile/undefined");
});

Deno.test("extractAssetsFromHtml extracts importmap and tag assets", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <script type="importmap" id="pronto-assets">
          {
            "imports": {
              "shell": "/_immutable-1111111111111111-shell.js",
              "app": "/_immutable-2222222222222222-app.js",
              "messages": "/messages/pt-BR.json"
            }
          }
        </script>
        <link rel="stylesheet" href="/_immutable-3333333333333333-theme.css">
      </head>
      <body></body>
    </html>
  `;
  const assets = extractAssetsFromHtml(html);
  assertEquals(assets.immutableAssets, [
    "/_immutable-1111111111111111-shell.js",
    "/_immutable-2222222222222222-app.js",
    "/_immutable-3333333333333333-theme.css",
  ]);
  assertEquals(assets.catalogues, ["/messages/pt-BR.json"]);
});

Deno.test("verifyHttp populates asset matrix from deployed entry document for container platforms", async () => {
  const entryHtml = `
    <html>
      <head>
        <script type="importmap" id="pronto-assets">
          {
            "imports": {
              "main": "/_immutable-abcdef1234567890-main.js"
            }
          }
        </script>
      </head>
      <body>Deployed Container App</body>
    </html>
  `;

  const mockFetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("dummy.css")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    if (url.includes("_immutable-abcdef1234567890-main.js")) {
      return new Response("console.log('main');", {
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Type": "application/javascript",
        },
      });
    }

    // Root entry document
    return new Response(entryHtml, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const result = await verifyHttp("https://k8s-app.example.com", {
    platform: "k8s",
    routes: ["/"],
    fetchFn: mockFetch as typeof fetch,
  });

  assertEquals(result.passed, true);
  assertEquals(result.errors.length, 0);
  assertEquals(result.assetsChecked, 1);
});

Deno.test("verifyHttp fails loudly for k8s platform when deployed document provides no immutable assets", async () => {
  const mockFetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("dummy.css")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    return new Response("<html><body>Empty Document</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const result = await verifyHttp("https://k8s-app.example.com", {
    platform: "k8s",
    routes: ["/"],
    fetchFn: mockFetch as typeof fetch,
  });

  assertEquals(result.passed, false);
  assertEquals(
    result.errors.some((e) => e.includes("No immutable assets found")),
    true
  );
});

Deno.test("verifyHttp fails loudly for cloudflare platform when deployed document provides no immutable assets", async () => {
  const mockFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("_immutable-0000")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    return new Response("<html><body>Maintenance Document Without Importmap</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const result = await verifyHttp("https://cf-app.example.com", {
    platform: "cloudflare",
    routes: ["/"],
    fetchFn: mockFetch as typeof fetch,
  });

  assertEquals(result.passed, false);
  assertEquals(
    result.errors.some((e) => e.includes("No immutable assets found")),
    true
  );
});

Deno.test("extractAssetsFromHtml fails loudly when #pronto-assets JSON is malformed", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <script type="importmap" id="pronto-assets">
          { malformed json }
        </script>
      </head>
      <body></body>
    </html>
  `;
  try {
    extractAssetsFromHtml(html);
    assert(false, "Expected extractAssetsFromHtml to throw on malformed #pronto-assets");
  } catch (e) {
    assert(e instanceof Error && e.message.includes("Malformed #pronto-assets"));
  }
});

Deno.test("verifyHttp preserves target query parameters when requesting document routes", async () => {
  const fetchedUrls: string[] = [];

  const fakeFetch = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    fetchedUrls.push(url);

    if (url.includes("_immutable-0000")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.includes("_immutable-")) {
      return new Response("console.log('asset');", {
        status: 200,
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    return new Response("<!DOCTYPE html><html><body>ok</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const result = await verifyHttp("https://app.example.com/?clock=manual&seed=7", {
    fetchFn: fakeFetch as any,
    hints: {
      routes: [
        { path: "/", links: ["</shell/_immutable-bundle.js>"] },
        { path: "/games", links: ["</shell/_immutable-games.js>"] },
      ],
    },
  });

  assertEquals(result.passed, true);
  // Static assets do NOT have query string
  assertEquals(fetchedUrls.includes("https://app.example.com/shell/_immutable-bundle.js"), true);
  assertEquals(fetchedUrls.includes("https://app.example.com/shell/_immutable-games.js"), true);
  // Document routes DO have the target query string
  assertEquals(fetchedUrls.includes("https://app.example.com/?clock=manual&seed=7"), true);
  assertEquals(fetchedUrls.includes("https://app.example.com/games?clock=manual&seed=7"), true);
});

Deno.test("verifyHttp fetches assets and negative probe at root origin without prepending mount prefix", async () => {
  const fetchedUrls: string[] = [];

  const fakeFetch = async (url: string | URL) => {
    const urlStr = String(url);
    fetchedUrls.push(urlStr);

    if (urlStr.includes("dummy.css")) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (urlStr.includes("_immutable-") || urlStr.includes("messages")) {
      return new Response("body", {
        status: 200,
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    return new Response("<!DOCTYPE html><html><body>ok</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const result = await verifyHttp("https://app.example.com/subapp/", {
    fetchFn: fakeFetch as any,
    hints: {
      prefix: "/subapp",
      catalogues: {
        en: "/messages/_immutable-123-en.json",
      },
      routes: [
        { path: "/", links: ["</shell/_immutable-bundle.js>"] },
      ],
    },
  });

  assertEquals(result.passed, true);
  // Assets and catalogues are fetched from root, NOT under /subapp
  assertEquals(fetchedUrls.includes("https://app.example.com/shell/_immutable-bundle.js"), true);
  assertEquals(fetchedUrls.includes("https://app.example.com/messages/_immutable-123-en.json"), true);
  assertEquals(fetchedUrls.includes("https://app.example.com/_immutable-0000000000000000000000000000000000000000000000000000000000000000-dummy.css"), true);
  // Document route IS mounted under /subapp
  assertEquals(fetchedUrls.includes("https://app.example.com/subapp/"), true);
});
