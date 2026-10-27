import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import {
  attachNetworkTrap,
  buildRepresentativeJourneys,
  type JourneyItem,
  verifyBrowser,
} from "./browser-sweep.ts";
import { airlock } from "./airlock.ts";

Deno.test("buildRepresentativeJourneys extracts one journey per unique primary screen using resolved routes", () => {
  const hints = {
    routes: [
      { path: "/", screen: "home", links: ["</shell/screens/_immutable-1-home.html.txt>"] },
      { path: "/games", screen: "games", links: ["</shell/screens/_immutable-2-games.html.txt>"] },
      { path: "/game/:id", screen: "game", links: ["</shell/screens/_immutable-3-game.html.txt>"] },
    ],
  };

  const screenRoutes = new Map([
    ["home", "/"],
    ["games", "/games"],
    ["game", "/game/2026-final"],
  ]);

  const journeys = buildRepresentativeJourneys(hints, screenRoutes);
  assertEquals(journeys, [
    { screen: "home", path: "/" },
    { screen: "games", path: "/games" },
    { screen: "game", path: "/game/2026-final" },
  ]);
});

Deno.test("attachNetworkTrap traps HTTP 4xx/5xx and request aborts", () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  const fakePage = {
    on(event: string, fn: (...args: any[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    off(event: string, fn: (...args: any[]) => void) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
  };

  const trap = attachNetworkTrap(fakePage);

  // Trigger 200 response (ok)
  listeners["response"]?.forEach((fn) =>
    fn({
      status: () => 200,
      statusText: () => "OK",
      url: () => "https://example.com/asset.js",
    })
  );
  assertEquals(trap.errors.length, 0);

  // Trigger 404 response (failure!)
  listeners["response"]?.forEach((fn) =>
    fn({
      status: () => 404,
      statusText: () => "Not Found",
      url: () => "https://example.com/missing.css",
    })
  );
  assertEquals(trap.errors.length, 1);

  // Trigger client-side net::ERR_ABORTED (should be ignored)
  listeners["requestfailed"]?.forEach((fn) =>
    fn({
      failure: () => ({ errorText: "net::ERR_ABORTED" }),
      url: () => "https://example.com/prefetch.html",
    })
  );
  assertEquals(trap.errors.length, 1);

  // Trigger real transport failure
  listeners["requestfailed"]?.forEach((fn) =>
    fn({
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
      url: () => "https://example.com/chunk.js",
    })
  );
  assertEquals(trap.errors.length, 2);

  assertThrows(
    () => trap.assertNoErrors(),
    Error,
    "Zero-tolerance edge network trap detected 2 error(s)"
  );

  trap.detach();
  assertEquals(listeners["response"].length, 0);
});

Deno.test("attachNetworkTrap waits for pending asset requests before asserting no errors", async () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const fakePage = {
    on: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] ??= [];
      listeners[evt].push(fn);
    },
    off: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] = (listeners[evt] ?? []).filter((f) => f !== fn);
    },
  };

  const trap = attachNetworkTrap(fakePage);
  const fakeReq = {
    url: () => "https://example.com/image.png",
    headers: () => ({ accept: "image/png" }),
  };

  // Start in-flight asset request
  listeners["request"].forEach((fn) => fn(fakeReq));

  let settled = false;
  const waitPromise = trap.waitForPendingAssets(1000).then(() => {
    settled = true;
  });

  assertEquals(settled, false);

  // Complete request with 404 response
  listeners["response"].forEach((fn) =>
    fn({
      status: () => 404,
      statusText: () => "Not Found",
      url: () => "https://example.com/image.png",
      request: () => fakeReq,
    })
  );
  listeners["requestfinished"].forEach((fn) => fn(fakeReq));

  await waitPromise;
  assertEquals(settled, true);
  assertEquals(trap.errors.length, 1);
  assertEquals(trap.errors[0].includes("HTTP 404 Not Found"), true);
  trap.detach();
});

Deno.test("attachNetworkTrap fails when asset requests remain unfinished after timeout", async () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const fakePage = {
    on: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] ??= [];
      listeners[evt].push(fn);
    },
    off: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] = (listeners[evt] ?? []).filter((f) => f !== fn);
    },
  };

  const trap = attachNetworkTrap(fakePage);
  const fakeReq = {
    url: () => "https://app.example/late.css",
    headers: () => ({ accept: "text/css" }),
  };

  listeners["request"].forEach((fn) => fn(fakeReq));

  await trap.waitForPendingAssets(20);

  assertEquals(trap.errors.length, 1);
  assertEquals(trap.errors[0].includes("Asset requests timed out"), true);
  assertEquals(trap.errors[0].includes("https://app.example/late.css"), true);
  trap.detach();
});

Deno.test("attachNetworkTrap excludes Electric live long polls from pending asset tracking", async () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const fakePage = {
    on: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] ??= [];
      listeners[evt].push(fn);
    },
    off: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] = (listeners[evt] ?? []).filter((f) => f !== fn);
    },
  };

  const trap = attachNetworkTrap(fakePage);
  const electricReq = {
    url: () => "https://app.example/electric/v1/shape?table=item&live=true",
    headers: () => ({ accept: "application/json" }),
  };

  // Start Electric live poll
  listeners["request"].forEach((fn) => fn(electricReq));

  // Should return immediately without timing out or reporting an error
  await trap.waitForPendingAssets(20);
  assertEquals(trap.errors.length, 0);
  trap.assertNoErrors();

  // However, if Electric returns an HTTP 500 error, it must still be trapped
  listeners["response"].forEach((fn) =>
    fn({
      status: () => 500,
      statusText: () => "Internal Server Error",
      url: () => "https://app.example/electric/v1/shape?table=item&live=true",
      request: () => electricReq,
    })
  );

  assertEquals(trap.errors.length, 1);
  assertEquals(trap.errors[0].includes("Edge HTTP 500"), true);
  trap.detach();
});

Deno.test("verifyBrowser executes journeys and handles airlocked rollbacks", async () => {
  const trace: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
  };

  const fakeBrowser = {
    newContext: async (opts?: any) => {
      trace.push(`newContext:baseURL=${opts?.baseURL}`);
      return {
        newPage: async () => fakePage,
        close: async () => {},
      };
    },
    newPage: async () => fakePage,
  };

  const airlockedJourney = airlock({
    screen: "write-screen",
    async execute() {
      trace.push("execute");
      return { id: "123" };
    },
    async verify(_page, state) {
      trace.push(`verify:${state.id}`);
    },
    async rollback(state) {
      trace.push(`rollback:${state.id}`);
    },
  });

  const result = await verifyBrowser({
    targetUrl: "https://example.com",
    browser: fakeBrowser,
    journeys: [airlockedJourney],
  });

  assertEquals(result.passed, true);
  assertEquals(result.journeysRun, 1);
  assertEquals(result.screensChecked, 1);
  assertEquals(trace, ["newContext:baseURL=https://example.com", "execute", "verify:123", "rollback:123"]);
});

Deno.test("verifyBrowser preserves Pages prefix when hints are absent", async () => {
  const visitedUrls: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
  };

  const fakeBrowser = {
    newContext: async () => ({
      newPage: async () => fakePage,
      close: async () => {},
    }),
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://owner.github.io/my-app/",
    platform: "pages",
    browser: fakeBrowser,
  });

  assertEquals(result.passed, true);
  assertEquals(result.journeysRun, 1);
  assertEquals(visitedUrls, ["https://owner.github.io/my-app/"]);
});

Deno.test("verifyBrowser fails loudly when screen readiness times out", async () => {
  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async () => ({ status: () => 200 }),
    waitForFunction: async () => {
      throw new Error("Timeout 5000ms exceeded waiting for function");
    },
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://example.com",
    browser: fakeBrowser,
  });

  assertEquals(result.passed, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0].includes("Timeout 5000ms exceeded waiting for function"),
    true
  );
});

Deno.test("attachNetworkTrap allows top-level navigation 404 for Pages platform", () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  const fakePage = {
    on(event: string, fn: (...args: any[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    off(event: string, fn: (...args: any[]) => void) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
  };

  const trap = attachNetworkTrap(fakePage, { allowPagesDeepLink: true });

  // Deep-link document navigation on Pages returns 404
  listeners["response"]?.forEach((fn) =>
    fn({
      status: () => 404,
      statusText: () => "Not Found",
      url: () => "https://owner.github.io/my-app/deep-route",
      request: () => ({ isNavigationRequest: () => true }),
    })
  );
  assertEquals(trap.errors.length, 0);

  // Missing subresource 404 must still be trapped as an error!
  listeners["response"]?.forEach((fn) =>
    fn({
      status: () => 404,
      statusText: () => "Not Found",
      url: () => "https://owner.github.io/my-app/chunk.js",
      request: () => ({ isNavigationRequest: () => false }),
    })
  );
  assertEquals(trap.errors.length, 1);
});

Deno.test("verifyBrowser mounts application routes starting with prefix correctly without collision", async () => {
  const visitedUrls: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
  };

  const fakeBrowser = {
    newContext: async () => ({
      newPage: async () => fakePage,
      close: async () => {},
    }),
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://example.com/todo/",
    hints: {
      prefix: "/todo",
      routes: [
        { path: "/todo", screen: "todo-screen" },
        { path: "/todo-list", screen: "list-screen" },
      ],
    },
    browser: fakeBrowser,
  });

  assertEquals(result.passed, true);
  assertEquals(visitedUrls, [
    "https://example.com/todo/todo",
    "https://example.com/todo/todo-list",
  ]);
});

Deno.test("verifyBrowser preserves default screen journeys when custom journeys are provided", async () => {
  const visitedScreens: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async () => ({ status: () => 200 }),
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const customJourney = {
    screen: "custom-screen",
    run: async () => {
      visitedScreens.push("custom-screen");
    },
  };

  const result = await verifyBrowser({
    targetUrl: "https://example.com",
    hints: {
      routes: [
        { path: "/default-a", screen: "screen-a" },
        { path: "/default-b", screen: "screen-b" },
      ],
    },
    journeys: [customJourney],
    browser: fakeBrowser,
  });

  assertEquals(result.passed, true);
  assertEquals(result.journeysRun, 3);
  assertEquals(result.screensChecked, 3);
});

Deno.test("verifyBrowser discovers parameterized screen routes from hydrated browser DOM", async () => {
  const visitedUrls: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    $$eval: async (selector: string, fn: any) => {
      if (selector === "a[href]") {
        return fn([{ getAttribute: () => "/jogador/l-yamal" }]);
      }
      return [];
    },
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://golaberto.bonisoft3.com/",
    hints: {
      routes: [
        { path: "/", screen: "home" },
        { path: "/jogador/:slug", screen: "player" },
      ],
    },
    browser: fakeBrowser,
  });

  assertEquals(result.passed, true);
  assertEquals(result.screensChecked, 2);
  assertEquals(visitedUrls, [
    "https://golaberto.bonisoft3.com/",
    "https://golaberto.bonisoft3.com/jogador/l-yamal",
  ]);
});

Deno.test("verifyBrowser asserts expected screen identity and fails on mismatch", async () => {
  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async () => ({ status: () => 200 }),
    waitForFunction: async (_fn: any, expectedScreen: string) => {
      // Simulate that the loaded screen has data-screen="wrong-screen"
      throw new Error(`Screen identity mismatch: expected '${expectedScreen}', got 'wrong-screen'`);
    },
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://example.com",
    hints: {
      routes: [{ path: "/profile", screen: "user-profile" }],
    },
    browser: fakeBrowser,
  });

  assertEquals(result.passed, false);
  assertEquals(
    result.errors.some((e) => e.includes("Screen identity mismatch: expected 'user-profile'")),
    true
  );
});

Deno.test("verifyBrowser transitively discovers nested parameterized routes across multiple screens", async () => {
  const visitedUrls: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    $$eval: async (selector: string, fn: any) => {
      if (selector === "a[href]") {
        const last = visitedUrls[visitedUrls.length - 1];
        if (last.endsWith("/")) {
          return fn([{ getAttribute: () => "/equipe/flamengo" }]);
        }
        if (last.includes("/equipe/flamengo")) {
          return fn([{ getAttribute: () => "/equipe-campeonato/flamengo/brasileirao" }]);
        }
      }
      return [];
    },
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://golaberto.bonisoft3.com/",
    hints: {
      routes: [
        { path: "/", screen: "home" },
        { path: "/equipe/:slug", screen: "team" },
        { path: "/equipe-campeonato/:slug/:championship", screen: "team-championship" },
      ],
    },
    browser: fakeBrowser,
  });

  assertEquals(result.passed, true);
  assertEquals(result.screensChecked, 3);
  assertEquals(visitedUrls, [
    "https://golaberto.bonisoft3.com/",
    "https://golaberto.bonisoft3.com/equipe/flamengo",
    "https://golaberto.bonisoft3.com/equipe-campeonato/flamengo/brasileirao",
  ]);
});

Deno.test("verifyBrowser executes multiple distinct custom journeys for the same screen", async () => {
  const executedJourneys: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
  };
  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const journey1 = {
    spec: { screen: "settings", as: "admin" },
    run: async () => {
      executedJourneys.push("admin");
    },
  };
  const journey2 = {
    spec: { screen: "settings", as: "viewer" },
    run: async () => {
      executedJourneys.push("viewer");
    },
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    journeys: [journey1 as any, journey2 as any],
  });

  assertEquals(result.passed, true);
  assertEquals(result.journeysRun, 2);
  assertEquals(executedJourneys, ["admin", "viewer"]);
});

Deno.test("verifyBrowser rejects journeys that have neither a runner nor a path", async () => {
  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
  };
  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const emptyJourney = {
    screen: "home",
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    journeys: [emptyJourney as any],
  });

  assertEquals(result.passed, false);
  assertEquals(
    result.errors.some((e) =>
      e.includes("Journey for screen 'home' must specify a non-empty 'path' or a callable 'run' method")
    ),
    true
  );
});

Deno.test("verifyBrowser harvests links after custom journeys to discover downstream routes", async () => {
  const visitedUrls: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    $$eval: async (sel: string) => {
      if (sel === "a[href]") {
        return ["/item/special-item"];
      }
      return [];
    },
    waitForFunction: async () => true,
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const customHomeJourney = {
    spec: { screen: "home" },
    run: async (_page: any) => {
      visitedUrls.push("custom-home-run");
    },
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    hints: {
      routes: [
        { path: "/", screen: "home" },
        { path: "/item/:id", screen: "item-detail" },
      ],
    },
    journeys: [customHomeJourney as any],
  });

  assertEquals(result.passed, true);
  assertEquals(visitedUrls, [
    "custom-home-run",
    "https://app.example.com/item/special-item",
  ]);
  assertEquals(result.screensChecked, 2);
});

Deno.test("verifyBrowser preserves tab-local pronto-token between screen journeys", async () => {
  const initScriptsCalled: any[] = [];
  let simulatedStorageToken: string | null = null;
  const tokensReceivedInCtx: (string | undefined)[] = [];

  const fakeBrowser = {
    newPage: async () => {
      const page = {
        on: () => {},
        off: () => {},
        close: async () => {},
        addInitScript: async (fn: any, arg: any) => {
          initScriptsCalled.push({ fn, arg });
        },
        evaluate: async (fn: any) => {
          return simulatedStorageToken;
        },
        waitForFunction: async () => true,
      };
      return page;
    },
  };

  const loginJourney = {
    screen: "login",
    run: async (_page: any, ctx: any) => {
      tokensReceivedInCtx.push(ctx?.token);
      // Simulate successful login stashing token
      simulatedStorageToken = JSON.stringify({ token: "auth-123", user: { id: "user-1" } });
    },
  };

  const profileJourney = {
    screen: "profile",
    run: async (_page: any, ctx: any) => {
      tokensReceivedInCtx.push(ctx?.token);
    },
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    journeys: [loginJourney, profileJourney],
  });

  assertEquals(result.passed, true);
  // First journey had no token initially
  assertEquals(tokensReceivedInCtx[0], undefined);
  // Second journey received token in ctx
  assertEquals(tokensReceivedInCtx[1], JSON.stringify({ token: "auth-123", user: { id: "user-1" } }));
  // Second page had addInitScript invoked with the captured token
  assertEquals(initScriptsCalled.length, 1);
  assertEquals(initScriptsCalled[0].arg, JSON.stringify({ token: "auth-123", user: { id: "user-1" } }));
});

Deno.test("verifyBrowser injects configured session option into initial page addInitScript", async () => {
  const initScriptsCalled: any[] = [];

  const fakeBrowser = {
    newPage: async () => ({
      on: () => {},
      off: () => {},
      close: async () => {},
      addInitScript: async (fn: any, arg: any) => {
        initScriptsCalled.push({ fn, arg });
      },
      evaluate: async () => null,
      waitForFunction: async () => true,
    }),
  };

  const homeJourney = {
    screen: "home",
    run: async () => {},
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    session: { token: "preset-token", user: { id: "admin" } },
    journeys: [homeJourney],
  });

  assertEquals(result.passed, true);
  assertEquals(initScriptsCalled.length, 1);
  assertEquals(initScriptsCalled[0].arg, JSON.stringify({ token: "preset-token", user: { id: "admin" } }));
});

Deno.test("verifyBrowser preserves query parameters from explicit targetUrl during screen navigation", async () => {
  const visitedUrls: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    waitForFunction: async () => true,
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com/?clock=manual&seed=7",
    browser: fakeBrowser,
    hints: {
      routes: [
        { path: "/", screen: "home" },
        { path: "/games", screen: "games" },
      ],
    },
  });

  assertEquals(result.passed, true);
  assertEquals(visitedUrls, [
    "https://app.example.com/?clock=manual&seed=7",
    "https://app.example.com/games?clock=manual&seed=7",
  ]);
});

Deno.test("buildRepresentativeJourneys skips private routes in unauthenticated sweep even when path is known", () => {
  const hints = {
    routes: [
      { path: "/", screen: "home" },
      { path: "/public-item/:id", screen: "public-item" },
      { path: "/admin", screen: "admin", access: "private" },
      { path: "/admin-edit/:id", screen: "admin-edit", access: "private" },
    ],
  };

  const unresolved: string[] = [];
  const screenRoutes = new Map([
    ["home", "/"],
    ["public-item", "/public-item/123"],
    ["admin", "/admin"],
  ]);

  // Unauthenticated sweep without session skips /admin and /admin-edit/:id
  const journeys = buildRepresentativeJourneys(hints, screenRoutes, unresolved, { hasSession: false });
  assertEquals(journeys, [
    { screen: "home", path: "/" },
    { screen: "public-item", path: "/public-item/123" },
  ]);
  assertEquals(unresolved.length, 0);

  // Authenticated sweep with session includes /admin and reports unresolved /admin-edit
  const authUnresolved: string[] = [];
  const authJourneys = buildRepresentativeJourneys(hints, screenRoutes, authUnresolved, { hasSession: true });
  assertEquals(authJourneys, [
    { screen: "home", path: "/" },
    { screen: "public-item", path: "/public-item/123" },
    { screen: "admin", path: "/admin" },
  ]);
  assertEquals(authUnresolved.length, 1);
  assertEquals(authUnresolved[0].includes("admin-edit"), true);
});

Deno.test("attachNetworkTrap scopes pending asset completion to target origin", async () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const fakePage = {
    on: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] ??= [];
      listeners[evt].push(fn);
    },
    off: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
    },
  };

  const trap = attachNetworkTrap(fakePage, { targetOrigin: "https://app.example.com" });

  // Third-party external request that stays pending
  const externalReq = {
    url: () => "https://tile.openstreetmap.org/1/2/3.png",
    headers: () => ({ accept: "image/png" }),
  };
  listeners["request"]?.forEach((fn) => fn(externalReq));

  // Same-origin deployment asset that completes
  const internalReq = {
    url: () => "https://app.example.com/_immutable-style.css",
    headers: () => ({ accept: "text/css" }),
  };
  listeners["request"]?.forEach((fn) => fn(internalReq));
  listeners["requestfinished"]?.forEach((fn) => fn(internalReq));

  // Should succeed immediately without waiting/timing out on externalReq
  await trap.waitForPendingAssets(100);
  trap.assertNoErrors();
  trap.detach();
});

Deno.test("verifyBrowser skips live discovered private routes when unauthenticated", async () => {
  const visitedUrls: string[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    $$eval: async (sel: string) => {
      if (sel === "a[href]") {
        return ["/public/123", "/admin/edit/123"];
      }
      return [];
    },
    waitForFunction: async () => true,
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    hints: {
      routes: [
        { path: "/", screen: "home" },
        { path: "/public/:id", screen: "public-detail" },
        { path: "/admin/edit/:id", screen: "admin-edit", access: "private" },
      ],
    },
  });

  assertEquals(result.passed, true);
  // Visited home and public-detail, but skipped unauthenticated admin-edit
  assertEquals(visitedUrls, [
    "https://app.example.com/",
    "https://app.example.com/public/123",
  ]);
  assertEquals(result.screensChecked, 2);
});

Deno.test("verifyBrowser refreshes session and discovers private screens after login journey", async () => {
  const visitedUrls: string[] = [];
  let userToken: string | null = null;

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    evaluate: async (fn: any) => {
      return userToken;
    },
    $$eval: async (sel: string) => {
      if (sel === "a[href]") {
        return ["/admin/edit/456"];
      }
      return [];
    },
    waitForFunction: async () => true,
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const customLoginJourney: JourneyItem = {
    screen: "login",
    path: "/login",
    run: async (page: any) => {
      await page.goto("https://app.example.com/login");
      // Simulate signing in and establishing session
      userToken = "valid-session-jwt";
    },
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    journeys: [customLoginJourney],
    hints: {
      routes: [
        { path: "/login", screen: "login" },
        { path: "/admin/dashboard", screen: "admin-dashboard", access: "private" },
        { path: "/admin/edit/:id", screen: "admin-edit", access: "private" },
      ],
    },
  });

  assertEquals(result.passed, true);
  // Custom login journey ran, then static private admin-dashboard and dynamic admin-edit were both visited!
  assertEquals(visitedUrls, [
    "https://app.example.com/login",
    "https://app.example.com/admin/dashboard",
    "https://app.example.com/admin/edit/456",
  ]);
  assertEquals(result.screensChecked, 3);
});

Deno.test("verifyBrowser enqueues private routes without double-prefixing on mounted deployment", async () => {
  const visitedUrls: string[] = [];
  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    evaluate: async () => "session-token",
    $$eval: async () => [],
    waitForFunction: async () => true,
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const result = await verifyBrowser({
    targetUrl: "https://test.example/app/",
    browser: fakeBrowser,
    hints: {
      routes: [
        { path: "/", screen: "home" },
        { path: "/private", screen: "private", access: "private" },
      ],
    },
  });

  assertEquals(result.passed, true);
  assertEquals(visitedUrls, [
    "https://test.example/app/",
    "https://test.example/app/private",
  ]);
});

Deno.test("verifyBrowser clears retained session after logout journey", async () => {
  let inSession = true;
  const sessionsSeenOnNewPage: (string | null)[] = [];

  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    addInitScript: async (fn: any, arg: string) => {
      sessionsSeenOnNewPage.push(arg);
    },
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => (inSession ? "active-token" : null),
    $$eval: async () => [],
    waitForFunction: async () => true,
  };

  const fakeBrowser = {
    newPage: async () => fakePage,
  };

  const logoutJourney: JourneyItem = {
    screen: "logout",
    path: "/logout",
    run: async () => {
      inSession = false;
    },
  };

  const subsequentJourney: JourneyItem = {
    screen: "after-logout",
    path: "/after-logout",
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: fakeBrowser,
    session: "active-token",
    journeys: [logoutJourney, subsequentJourney],
  });

  assertEquals(result.passed, true);
  // Initial page for logout had active-token, but subsequent page did not receive active-token because session was cleared
  assertEquals(sessionsSeenOnNewPage.length, 1);
  assertEquals(sessionsSeenOnNewPage[0], "active-token");
});

Deno.test("verifyBrowser does not enqueue private routes when session is a guest token", async () => {
  const visitedUrls: string[] = [];
  const fakePage = {
    on: () => {},
    off: () => {},
    close: async () => {},
    addInitScript: async () => {},
    goto: async (url: string) => {
      visitedUrls.push(url);
      return { status: () => 200 };
    },
    evaluate: async () => JSON.stringify({ token: "guest-jwt", user: { id: "g1", guest: true } }),
    $$eval: async () => ["/admin-edit/123"],
    waitForFunction: async () => true,
  };

  const result = await verifyBrowser({
    targetUrl: "https://app.example.com",
    browser: { newPage: async () => fakePage },
    hints: {
      routes: [
        { path: "/", screen: "home" },
        { path: "/admin", screen: "admin", access: "private" },
        { path: "/admin-edit/:id", screen: "admin-edit", access: "private" },
      ],
    },
  });

  assertEquals(result.passed, true);
  assertEquals(visitedUrls, ["https://app.example.com/"]);
});

Deno.test("attachNetworkTrap excludes prefetch and API requests from pending asset tracking", async () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const fakePage = {
    on: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] ??= [];
      listeners[evt].push(fn);
    },
    off: (evt: string, fn: (...args: any[]) => void) => {
      listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
    },
  };

  const trap = attachNetworkTrap(fakePage, { targetOrigin: "https://app.example.com" });

  for (const req of [
    { url: () => "https://app.example.com/equipes", headers: () => ({ accept: "text/html", "x-pronto-prefetch": "1" }) },
    { url: () => "https://app.example.com/crud/game?select=*", headers: () => ({ accept: "application/json" }) },
    { url: () => "https://app.example.com/auth/guest", headers: () => ({ accept: "application/json" }) },
  ]) {
    listeners["request"]?.forEach((fn) => fn(req));
  }

  await trap.waitForPendingAssets(50);
  trap.assertNoErrors();
  trap.detach();
});
