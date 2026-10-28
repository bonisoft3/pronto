/// <reference lib="dom" />

// Tier 2: Browser User Journey Sweep (Playwright)
//
// Runs in a headless browser against the target deployment:
// 1. One representative user journey per role / screen type.
// 2. Zero-tolerance network error trap: fails immediately on any 4xx/5xx or net::ERR_*.
// 3. Executes airlocked journeys with guaranteed compensating rollback.

import type { AirlockJourney, AirlockContext } from "./airlock.ts";
import { type EdgeHints, extractPrimaryScreen, resolveParameterizedRoutes } from "./http-sweep.ts";

export interface JourneyItem {
  screen: string;
  role?: string;
  path?: string;
  run?: (page: any, ctx?: AirlockContext) => Promise<void>;
}

export function isAuthenticatedSession(tokenStr: string | null): boolean {
  if (!tokenStr) return false;
  try {
    const parsed = JSON.parse(tokenStr);
    if (parsed === null || typeof parsed !== "object") return false;
    if (parsed.user?.guest === true) return false;
    return Boolean(parsed.token || parsed.user);
  } catch {
    return true; // raw JWT string
  }
}

export interface NetworkTrap {
  errors: string[];
  detach: () => void;
  assertNoErrors: () => void;
  waitForPendingAssets: (timeoutMs?: number) => Promise<void>;
}

/**
 * Installs the zero-tolerance edge network error trap on a Playwright page.
 * Captures any HTTP status >= 400, request failures, or unhandled page errors.
 */
export function attachNetworkTrap(
  page: any,
  trapOptions?: { allowPagesDeepLink?: boolean; targetOrigin?: string }
): NetworkTrap {
  const errors: string[] = [];
  const pendingRequests = new Set<any>();

  const isPersistentSync = (req: any) => {
    try {
      const url = typeof req.url === "function" ? req.url() : (req.url ?? "");
      const headers = typeof req.headers === "function" ? req.headers() : (req.headers ?? {});
      const accept = (headers["accept"] ?? "").toLowerCase();
      return (
        accept.includes("text/event-stream") ||
        url.includes("/events") ||
        url.includes("/stream") ||
        url.includes("/sync") ||
        url.includes("/v1/shape") ||
        url.includes("/electric/") ||
        url.includes("/crud/") ||
        url.includes("/auth/") ||
        url.includes("live=true")
      );
    } catch {
      return false;
    }
  };

  const isDeploymentAsset = (req: any) => {
    try {
      if (!trapOptions?.targetOrigin) return true;
      const url = typeof req.url === "function" ? req.url() : (req.url ?? "");
      return url.startsWith(trapOptions.targetOrigin) || url.startsWith("/");
    } catch {
      return true;
    }
  };

  const isPrefetch = (req: any) => {
    try {
      const headers = typeof req.headers === "function" ? req.headers() : (req.headers ?? {});
      if (
        headers["sec-purpose"]?.includes("prefetch") ||
        headers["purpose"]?.includes("prefetch") ||
        headers["x-pronto-prefetch"] === "1"
      ) {
        return true;
      }
      const type = typeof req.resourceType === "function" ? req.resourceType() : (req.resourceType ?? "");
      return type === "prefetch";
    } catch {
      return false;
    }
  };

  const onRequest = (req: any) => {
    if (!isPersistentSync(req) && !isPrefetch(req) && isDeploymentAsset(req)) {
      pendingRequests.add(req);
    }
  };

  const onRequestFinished = (req: any) => {
    pendingRequests.delete(req);
  };

  const onResponse = (res: any) => {
    try {
      const status = res.status();
      // On Pages, top-level document navigation to deep links returns HTTP 404 with 404.html
      const isNav404 =
        trapOptions?.allowPagesDeepLink &&
        status === 404 &&
        (typeof res.request?.()?.isNavigationRequest === "function"
          ? res.request().isNavigationRequest()
          : false);
      if (status >= 400 && !isNav404) {
        errors.push(`Edge HTTP ${status} ${res.statusText()} on ${res.url()}`);
      }
    } catch {
      // Ignored if response detached
    }
  };

  const onRequestFailed = (req: any) => {
    pendingRequests.delete(req);
    try {
      const failure = req.failure();
      const errText = failure?.errorText ?? "unknown failure";
      // net::ERR_ABORTED is client-side cancellation (e.g. idle link prefetch or page teardown)
      if (errText !== "net::ERR_ABORTED") {
        errors.push(`Edge network aborted: ${errText} on ${req.url()}`);
      }
    } catch {
      // Ignored
    }
  };

  const onPageError = (err: Error) => {
    errors.push(`Browser unhandled page error: ${err.message}`);
  };

  page.on("request", onRequest);
  page.on("requestfinished", onRequestFinished);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("pageerror", onPageError);

  return {
    errors,
    detach: () => {
      pendingRequests.clear();
      if (typeof page.off === "function") {
        page.off("request", onRequest);
        page.off("requestfinished", onRequestFinished);
        page.off("response", onResponse);
        page.off("requestfailed", onRequestFailed);
        page.off("pageerror", onPageError);
      }
    },
    assertNoErrors: () => {
      if (errors.length > 0) {
        throw new Error(
          `Zero-tolerance edge network trap detected ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`
        );
      }
    },
    waitForPendingAssets: async (timeoutMs = 45000) => {
      if (pendingRequests.size === 0) return;
      const deadline = Date.now() + timeoutMs;
      while (pendingRequests.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      if (pendingRequests.size > 0) {
        const urls = [...pendingRequests].map((r) =>
          typeof r.url === "function" ? r.url() : String(r.url ?? "unknown")
        );
        errors.push(
          `Asset requests timed out and failed to complete within ${timeoutMs}ms:\n${urls.map((u) => `  - ${u}`).join("\n")}`
        );
      }
    },
  };
}

export interface BrowserSweepOptions {
  targetUrl: string;
  hints?: EdgeHints;
  screenRoutes?: Map<string, string>;
  journeys?: (AirlockJourney<any> | JourneyItem)[];
  headless?: boolean;
  browser?: any;
  ctx?: AirlockContext;
  platform?: string;
  session?: unknown;
  screenTimeoutMs?: number;
}

export interface BrowserSweepResult {
  passed: boolean;
  screensChecked: number;
  journeysRun: number;
  errors: string[];
}

/**
 * Builds representative journeys from EdgeHints and resolved screenRoutes.
 * Visits one concrete route per unique primary screen type.
 */
export function buildRepresentativeJourneys(
  hints: EdgeHints,
  screenRoutes?: Map<string, string>,
  unresolvedScreens?: string[],
  options?: { hasSession?: boolean }
): JourneyItem[] {
  const journeys: JourneyItem[] = [];
  const seenScreens = new Set<string>();

  for (const route of hints.routes ?? []) {
    const primaryScreen = extractPrimaryScreen(route);
    if (seenScreens.has(primaryScreen)) continue;

    // Private routes are guarded by authentication; skip private routes in unauthenticated sweeps
    if (route.access === "private" && !options?.hasSession) {
      continue;
    }

    const concretePath =
      screenRoutes?.get(primaryScreen) ??
      (!route.path.includes(":") ? route.path : undefined);

    if (concretePath) {
      seenScreens.add(primaryScreen);
      journeys.push({
        screen: primaryScreen,
        path: concretePath,
      });
    } else {
      unresolvedScreens?.push(
        `Screen '${primaryScreen}' (${route.path}) could not be resolved to a concrete URL and has no custom journey`
      );
    }
  }

  if (journeys.length === 0) {
    journeys.push({ screen: "root", path: "/" });
  }

  return journeys;
}

/**
 * Executes Tier 2 Browser User Journey Sweep.
 */
export async function verifyBrowser(
  options: BrowserSweepOptions
): Promise<BrowserSweepResult> {
  const parsedTarget = new URL(options.targetUrl);
  const baseUrl = parsedTarget.origin;
  const targetPath = parsedTarget.pathname;
  const targetSearch = parsedTarget.search;
  const errors: string[] = [];
  let journeysRun = 0;
  const screensChecked = new Set<string>();

  let browser = options.browser;
  let ownsBrowser = false;

  if (!browser) {
    const { chromium } = await import("npm:playwright@1.61.1");
    try {
      browser = await chromium.launch({
        headless: options.headless ?? true,
        args: ["--ignore-certificate-errors", "--no-sandbox"],
      });
    } catch (launchErr: any) {
      if (
        launchErr.message?.includes("npx playwright install") ||
        launchErr.message?.includes("Executable doesn't exist")
      ) {
        const cmd = new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "npm:playwright@1.61.1", "install", "--with-deps", "chromium"],
          stdout: "inherit",
          stderr: "inherit",
        });
        const out = await cmd.output();
        if (!out.success) {
          throw new Error(`Failed to install Playwright browser: code ${out.code}`);
        }
        browser = await chromium.launch({
          headless: options.headless ?? true,
          args: ["--ignore-certificate-errors", "--no-sandbox"],
        });
      } else {
        throw launchErr;
      }
    }
    ownsBrowser = true;
  }

  const derivedPrefix =
    options.platform === "pages" || (targetPath.endsWith("/") && targetPath !== "/")
      ? targetPath.replace(/\/+$/, "")
      : "";

  const prefix = typeof options.hints?.prefix === "string"
    ? options.hints.prefix.replace(/\/+$/, "")
    : derivedPrefix;

  const toMountedPath = (appPath: string) => {
    const clean = appPath.startsWith("/") ? appPath : `/${appPath}`;
    return prefix ? `${prefix}${clean}` : clean;
  };

  const appBaseUrl = `${baseUrl}${prefix}`;

  try {
    const unresolved: string[] = [];
    const journeysToRun: (AirlockJourney<any> | JourneyItem)[] = [];
    const coveredScreens = new Set<string>();

    let currentProntoToken: string | null = options.session
      ? (typeof options.session === "string" ? options.session : JSON.stringify(options.session))
      : options.ctx?.token
      ? (typeof options.ctx.token === "string" ? options.ctx.token : JSON.stringify(options.ctx.token))
      : options.ctx?.session
      ? (typeof options.ctx.session === "string" ? options.ctx.session : JSON.stringify(options.ctx.session))
      : null;

    for (const j of options.journeys ?? []) {
      journeysToRun.push(j);
      coveredScreens.add("spec" in j ? (j as any).spec.screen : j.screen);
    }

    const representative = options.hints
      ? buildRepresentativeJourneys(options.hints, options.screenRoutes, unresolved, {
          hasSession: isAuthenticatedSession(currentProntoToken),
        })
      : (options.journeys && options.journeys.length > 0 ? [] : [{ screen: "root", path: "/" }]);

    for (const j of representative) {
      const s = "spec" in j ? (j as any).spec.screen : j.screen;
      if (!coveredScreens.has(s)) {
        journeysToRun.push(j);
        coveredScreens.add(s);
      }
    }

    const targetAppRoute = prefix && targetPath.startsWith(prefix)
      ? targetPath.slice(prefix.length) || "/"
      : targetPath;

    if (
      targetAppRoute &&
      targetAppRoute !== "/" &&
      !journeysToRun.some((j) => "path" in j && (j.path === targetAppRoute || j.path === targetPath))
    ) {
      journeysToRun.unshift({ screen: "targeted-route", path: targetAppRoute });
    }

    const liveHarvestedLinks = new Set<string>();
    const queue: (AirlockJourney<any> | JourneyItem)[] = [...journeysToRun];
    const visitedPaths = new Set<string>();

    const context = typeof browser.newContext === "function"
      ? await browser.newContext({ baseURL: appBaseUrl, bypassCSP: true })
      : null;

    try {
      while (queue.length > 0) {
        const item = queue.shift()!;
        const isCustomJourney = "run" in item && typeof item.run === "function";

        if (!isCustomJourney) {
          const pathKey = "path" in item && item.path ? item.path : ("spec" in item ? item.spec.screen : item.screen);
          if (visitedPaths.has(pathKey)) continue;
          visitedPaths.add(pathKey);
        }

        const page = context ? await context.newPage() : await browser.newPage();
        if (currentProntoToken && typeof page.addInitScript === "function") {
          await page.addInitScript((token: string) => {
            try {
              if (!sessionStorage.getItem("pronto-token")) {
                sessionStorage.setItem("pronto-token", token);
              }
            } catch {
              // Ignore storage initialization failure
            }
          }, currentProntoToken);
        }

        const trap = attachNetworkTrap(page, {
          allowPagesDeepLink: options.platform === "pages",
          targetOrigin: baseUrl,
        });

        const screenName = "spec" in item ? item.spec.screen : item.screen;
        screensChecked.add(screenName);
        journeysRun++;

        const runCtx = {
          ...options.ctx,
          targetUrl: options.targetUrl,
          baseUrl: appBaseUrl,
          token: currentProntoToken ?? options.ctx?.token,
        };

        try {
          if ("run" in item && typeof item.run === "function") {
            // Airlock journey or custom journey with run method
            if ("spec" in item) {
              await item.run(page, runCtx);
            } else {
              await item.run!(page, runCtx);
            }
          } else if ("path" in item && typeof item.path === "string" && item.path.trim().length > 0) {
            // Default screen journey: navigate to route and verify clean hydration
            const baseDestination = item.path.startsWith("http://") || item.path.startsWith("https://")
              ? item.path
              : `${baseUrl}${toMountedPath(item.path)}`;
            let target = baseDestination;
            if (targetSearch) {
              const targetUrlObj = new URL(baseDestination);
              const targetParams = new URLSearchParams(targetSearch);
              for (const [k, v] of targetParams.entries()) {
                if (!targetUrlObj.searchParams.has(k)) {
                  targetUrlObj.searchParams.set(k, v);
                }
              }
              target = targetUrlObj.toString();
            }
            const screenTimeout = options.screenTimeoutMs ?? 45000;
            const res = await page.goto(target, { waitUntil: "domcontentloaded", timeout: screenTimeout });
            const isPages = options.platform === "pages";
            const allowed = (status: number) => status === 200 || (isPages && status === 404);
            if (!res || !allowed(res.status())) {
              throw new Error(`Navigation to ${target} returned HTTP ${res?.status() ?? "none"}`);
            }
            // Wait for observable application/screen hydration readiness with bounded timeout
            if (typeof page.waitForFunction === "function") {
              await page.waitForFunction(
                (expectedScreen: string) => {
                  const shellScreen = document.querySelector(
                    "#app .shell-screen:not([hidden])"
                  );
                  if (!shellScreen) return false;
                  // Screen must have exited server-served state and client entering transition
                  if (
                    shellScreen.hasAttribute("data-served") ||
                    shellScreen.hasAttribute("data-entering")
                  ) {
                    return false;
                  }

                  const screenEl = shellScreen.querySelector(".screen");
                  if (!screenEl) return false;

                  const state = screenEl.getAttribute("data-state");
                  if (state === "loading") return false;
                  if (state === "network-error") {
                    throw new Error("Screen lifecycle reported network-error");
                  }

                  // All child regions must have finished hydration
                  if (
                    screenEl.querySelector("[data-hydrating]") ||
                    screenEl.querySelector("[data-state='loading']")
                  ) {
                    return false;
                  }

                  if (expectedScreen && expectedScreen !== "root" && expectedScreen !== "targeted-route") {
                    const actualScreen = screenEl.getAttribute("data-screen") ?? "";
                    const matches =
                      actualScreen === expectedScreen ||
                      screenEl.classList.contains(`screen-${expectedScreen}`);
                    if (!matches) {
                      throw new Error(
                        `Screen identity mismatch: expected '${expectedScreen}', got '${actualScreen || screenEl.className}'`
                      );
                    }
                  }
                  return true;
                },
                screenName,
                { timeout: options.screenTimeoutMs ?? 45000 }
              );
            }
          } else {
            throw new Error(
              `Journey for screen '${screenName}' must specify a non-empty 'path' or a callable 'run' method`
            );
          }

          // Refresh session token immediately after journey execution so downstream
          // link harvesting and private route enqueuing reflect authentication
          const hadSessionBefore = isAuthenticatedSession(currentProntoToken);
          if (typeof page.evaluate === "function") {
            try {
              const token = await page.evaluate(() => sessionStorage.getItem("pronto-token"));
              currentProntoToken = token ?? null;
            } catch {
              // Retain current session token if evaluate fails
            }
          }

          // If session just transitioned to authenticated, enqueue newly eligible private screens
          if (!hadSessionBefore && isAuthenticatedSession(currentProntoToken) && options.hints?.routes) {
            for (const r of options.hints.routes) {
              if (r.access === "private") {
                const screen = extractPrimaryScreen(r);
                const path = options.screenRoutes?.get(screen) ?? (r.path.includes(":") ? undefined : r.path);
                if (path && !coveredScreens.has(screen) && !visitedPaths.has(path)) {
                  coveredScreens.add(screen);
                  queue.push({ screen, path });
                }
              }
            }
          }

          // Harvest links from live hydrated browser DOM to discover further parameterized routes
          // (runs for both custom journeys and default route visits)
          if (options.hints?.routes && typeof page.$$eval === "function") {
            try {
              const liveHrefs: string[] = await page.$$eval("a[href]", (els: any[]) =>
                els.map((el) => {
                  const href = el.getAttribute("href");
                  if (!href) return null;
                  try {
                    const u = new URL(href, location.origin);
                    if (u.origin === location.origin) return u.pathname;
                  } catch {}
                  return href.startsWith("/") ? href : null;
                }).filter(Boolean)
              );
              let foundNewLinks = false;
              for (const h of liveHrefs) {
                if (!liveHarvestedLinks.has(h)) {
                  liveHarvestedLinks.add(h);
                  foundNewLinks = true;
                }
              }
              if (foundNewLinks) {
                const { screenRoutes: newScreenRoutes } = resolveParameterizedRoutes(
                  options.hints.routes,
                  liveHarvestedLinks,
                  prefix,
                  options.hints.i18n
                );
                for (const [screen, path] of newScreenRoutes.entries()) {
                  const targetRoute = options.hints.routes.find((r) => extractPrimaryScreen(r) === screen);
                  if (targetRoute?.access === "private" && !isAuthenticatedSession(currentProntoToken)) {
                    continue;
                  }
                  if (!coveredScreens.has(screen) && !visitedPaths.has(path)) {
                    coveredScreens.add(screen);
                    queue.push({ screen, path });
                  }
                }
              }
            } catch {
              // Ignore detached evaluation
            }
          }

          await trap.waitForPendingAssets(options.screenTimeoutMs ?? 45000);
          trap.assertNoErrors();
        } catch (err) {
          errors.push(
            `Screen '${screenName}' failed: ${err instanceof Error ? err.message : String(err)}`
          );
        } finally {
          trap.detach();
          await page.close();
        }
      }

      for (const u of unresolved) {
        const match = /Screen '([^']+)'/.exec(u);
        if (match && coveredScreens.has(match[1])) continue;
        errors.push(u);
      }
    } finally {
      if (context) await context.close();
    }
  } finally {
    if (ownsBrowser && browser) {
      await browser.close();
    }
  }

  return {
    passed: errors.length === 0,
    screensChecked: screensChecked.size,
    journeysRun,
    errors,
  };
}
