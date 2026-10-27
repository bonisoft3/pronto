// Tier 1: Fast HTTP Asset and Cold-Cache Sweep
//
// Probes the released target platform over HTTP:
// 1. Asset Matrix: parallel GET for content-addressed assets (_immutable-*).
//    Asserts 200 and Cache-Control: public, max-age=31536000, immutable.
// 2. Catalogue Matrix: parallel GET for /messages/*.json. Asserts 200.
// 3. Negative 404 Poisoning Probe: GET for non-existent _immutable-* path.
//    Asserts 404 and Cache-Control: no-store (fails loudly if cached as immutable).
// 4. Document Routes: GET for declared routes with Accept: text/html. Asserts 200.
// 5. Dynamic Link & Slug Harvesting: discovers concrete URLs for parameterized routes
//    by reading live links from rendered directory screens.

export interface EdgeHintsRoute {
  path: string;
  screen?: string;
  links?: string[];
  paths?: Record<string, string>;
  ssr?: string;
  screens?: string[];
  files?: { html?: string; [key: string]: unknown };
  access?: "public" | "private" | string;
}

export type EdgeRoute = EdgeHintsRoute;

export interface EdgeHints {
  common?: string[];
  catalogues?: Record<string, string>;
  routes?: EdgeHintsRoute[];
  prefix?: string;
  i18n?: {
    default?: string;
    locales?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface ExtractedAssets {
  immutableAssets: string[];
  catalogues: string[];
  routes: string[];
}

const LINK_HREF = /<([^>]+)>/;

/**
 * Extracts the primary screen name for a route from its screen property,
 * or by matching its immutable template link (_immutable-*-<screen>.html.txt).
 */
export function extractPrimaryScreen(route: EdgeHintsRoute): string {
  if (route.screen) return route.screen;
  if (route.files?.html) {
    const base = route.files.html.split("/").pop();
    if (base) return base.replace(/\.html(\.txt)?$/, "");
  }
  for (const link of route.links ?? []) {
    const match = /_immutable-[^-]+-([a-zA-Z0-9_-]+)\.html\.txt/.exec(link);
    if (match) return match[1];
  }
  const cleanPath = route.path.replace(/^\//, "").split("/")[0]?.replace(/:.*$/, "");
  return cleanPath || "root";
}

/**
 * Extracts all relative href links from HTML markup.
 */
export function harvestLinksFromHtml(html: string): string[] {
  const matches = html.matchAll(/href="(\/[^"#?\s]+)"/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

/**
 * Extracts content-addressed assets and catalogues from rendered HTML markup.
 * Parses the release importmap (`<script id="pronto-assets">`) and static asset link/script tags.
 */
export function extractAssetsFromHtml(html: string): ExtractedAssets {
  const immutableAssets = new Set<string>();
  const catalogues = new Set<string>();

  const mapMatch = /<script\b[^>]*\bid="pronto-assets"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (mapMatch) {
    try {
      const parsed = JSON.parse(mapMatch[1]);
      const imports = parsed?.imports ?? {};
      for (const val of Object.values(imports)) {
        if (typeof val === "string") {
          if (val.includes("_immutable-")) {
            immutableAssets.add(val.startsWith("/") ? val : `/${val}`);
          } else if (val.includes("/messages/") && val.endsWith(".json")) {
            catalogues.add(val.startsWith("/") ? val : `/${val}`);
          }
        }
      }
    } catch (e) {
      throw new Error(
        `Malformed #pronto-assets importmap in deployed entry document: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const tagMatches = html.matchAll(/(?:href|src)="(\/[^"#?\s]+)"/g);
  for (const m of tagMatches) {
    const val = m[1];
    if (val.includes("_immutable-")) {
      immutableAssets.add(val);
    } else if (val.includes("/messages/") && val.endsWith(".json")) {
      catalogues.add(val);
    }
  }

  return {
    immutableAssets: [...immutableAssets].sort(),
    catalogues: [...catalogues].sort(),
    routes: ["/"],
  };
}

/**
 * Extracts immutable assets, catalogues, and static routes from EdgeHints.
 */
export function extractAssetsFromHints(hints: EdgeHints): ExtractedAssets {
  const immutableSet = new Set<string>();
  const catalogueSet = new Set<string>();
  const routeSet = new Set<string>();

  const processLink = (linkStr: string) => {
    const match = LINK_HREF.exec(linkStr);
    const href = match ? match[1] : linkStr;
    if (href.includes("_immutable-")) {
      immutableSet.add(href);
    } else if (href.includes("/messages/") && href.endsWith(".json")) {
      catalogueSet.add(href);
    }
  };

  for (const item of hints.common ?? []) {
    processLink(item);
  }

  for (const item of Object.values(hints.catalogues ?? {})) {
    processLink(item);
  }

  for (const r of hints.routes ?? []) {
    for (const link of r.links ?? []) {
      processLink(link);
    }
    if (r.path && !r.path.includes(":")) {
      routeSet.add(r.path);
    }
  }

  if (routeSet.size === 0) {
    routeSet.add("/");
  }

  return {
    immutableAssets: [...immutableSet].sort(),
    catalogues: [...catalogueSet].sort(),
    routes: [...routeSet].sort(),
  };
}

/**
 * Recursively scans a public directory for content-addressed assets and catalogues.
 */
export async function scanPublicDir(publicDir: string): Promise<ExtractedAssets> {
  const immutableAssets: string[] = [];
  const catalogues: string[] = [];

  async function walk(dir: string, relPrefix = "") {
    for await (const entry of Deno.readDir(dir)) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : `/${entry.name}`;
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(fullPath, relPath);
      } else if (entry.isFile) {
        if (entry.name.includes("_immutable-")) {
          immutableAssets.push(relPath);
        } else if (relPath.startsWith("/messages/") && entry.name.endsWith(".json")) {
          catalogues.push(relPath);
        }
      }
    }
  }

  await walk(publicDir);

  return {
    immutableAssets: immutableAssets.sort(),
    catalogues: catalogues.sort(),
    routes: ["/"],
  };
}

/**
 * Dynamically resolves concrete URLs for parameterized routes from harvested live links.
 */
export function resolveParameterizedRoutes(
  routes: EdgeHintsRoute[],
  linkPool: Set<string>,
  prefix = "",
  i18n?: { default?: string; locales?: Record<string, unknown> }
): { resolvedRoutes: Map<string, string>; screenRoutes: Map<string, string> } {
  const resolvedRoutes = new Map<string, string>();
  const screenRoutes = new Map<string, string>();

  // 1. Direct static routes
  for (const r of routes) {
    const screen = extractPrimaryScreen(r);
    if (!r.path.includes(":")) {
      resolvedRoutes.set(r.path, r.path);
      screenRoutes.set(screen, r.path);
    }
  }

  // 2. Match parameterized routes against harvested live linkPool
  for (const r of routes) {
    if (!r.path.includes(":")) continue;

    // Collect all candidate patterns for this route: canonical, localized, and locale-prefixed
    const candidatePatterns = new Set<string>();
    candidatePatterns.add(r.path);
    for (const p of Object.values(r.paths ?? {})) {
      candidatePatterns.add(p);
    }

    if (i18n?.locales) {
      for (const [tag, spec] of Object.entries(i18n.locales)) {
        const seg = typeof spec === "object" && spec && "path" in spec && typeof (spec as any).path === "string"
          ? String((spec as any).path)
          : String(tag).toLowerCase();
        for (const loc of new Set([seg, tag])) {
          for (const p of [r.path, ...Object.values(r.paths ?? {})]) {
            const cleanP = p.startsWith("/") ? p : `/${p}`;
            if (!cleanP.startsWith(`/${loc}/`)) {
              candidatePatterns.add(`/${loc}${cleanP}`);
            }
          }
        }
      }
    }

    const regexes = [...candidatePatterns].map((pat) => {
      const parts = pat.split("/");
      const regexParts = parts.map((p) =>
        p.startsWith(":") ? "([^/]+)" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      );
      return new RegExp(`^${regexParts.join("/")}$`);
    });

    for (const link of linkPool) {
      // Strip mount prefix if present before matching route pattern
      const appRelative = prefix && link.startsWith(prefix)
        ? link.slice(prefix.length) || "/"
        : link;
      const cleanRelative = appRelative.startsWith("/") ? appRelative : `/${appRelative}`;
      const cleanPathname = cleanRelative.split(/[?#]/)[0];

      const matched = regexes.some((re) => re.test(cleanPathname));
      if (matched) {
        resolvedRoutes.set(r.path, cleanPathname);
        screenRoutes.set(extractPrimaryScreen(r), cleanPathname);
        break;
      }
    }
  }

  return { resolvedRoutes, screenRoutes };
}

export interface HttpSweepOptions {
  hints?: EdgeHints;
  publicDir?: string;
  appDir?: string;
  platform?: string;
  routes?: string[];
  fetchFn?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
}

export interface HttpSweepResult {
  passed: boolean;
  totalRequests: number;
  assetsChecked: number;
  cataloguesChecked: number;
  routesChecked: number;
  negativeProbeChecked: boolean;
  resolvedRoutes: Map<string, string>;
  screenRoutes: Map<string, string>;
  errors: string[];
}

/**
 * Executes the Tier 1 HTTP Cold-Cache and Asset Sweep.
 */
export async function verifyHttp(
  targetUrl: string,
  options: HttpSweepOptions = {}
): Promise<HttpSweepResult> {
  const parsedTarget = new URL(targetUrl);
  const baseUrl = parsedTarget.origin;
  const targetPath = parsedTarget.pathname;
  const targetSearch = parsedTarget.search;
  const doFetch = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60000;
  const concurrency = options.concurrency ?? 16;
  const errors: string[] = [];

  const derivedPrefix = options.platform === "pages" || (targetPath.endsWith("/") && targetPath !== "/")
    ? targetPath.replace(/\/+$/, "")
    : "";

  const prefix = typeof options.hints?.prefix === "string"
    ? options.hints.prefix.replace(/\/+$/, "")
    : derivedPrefix;

  const toMountedPath = (appPath: string) => {
    const clean = appPath.startsWith("/") ? appPath : `/${appPath}`;
    return prefix ? `${prefix}${clean}` : clean;
  };

  const assetUrl = (p: string) => {
    const clean = p.startsWith("/") ? p : `/${p}`;
    return `${baseUrl}${clean}`;
  };

  const fullDocumentUrl = (p: string) => {
    const base = `${baseUrl}${toMountedPath(p)}`;
    if (!targetSearch) return base;
    const url = new URL(base);
    const targetParams = new URLSearchParams(targetSearch);
    for (const [k, v] of targetParams.entries()) {
      if (!url.searchParams.has(k)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  };

  let assets: ExtractedAssets = { immutableAssets: [], catalogues: [], routes: ["/"] };

  if (options.hints) {
    assets = extractAssetsFromHints(options.hints);
  }
  if (options.publicDir) {
    const diskAssets = await scanPublicDir(options.publicDir);
    assets.immutableAssets = [...new Set([...assets.immutableAssets, ...diskAssets.immutableAssets])].sort();
    assets.catalogues = [...new Set([...assets.catalogues, ...diskAssets.catalogues])].sort();
  }

  if (options.routes && options.routes.length > 0) {
    assets.routes = options.routes;
  }

  const targetAppRoute = prefix && targetPath.startsWith(prefix)
    ? targetPath.slice(prefix.length) || "/"
    : targetPath;

  if (targetAppRoute && targetAppRoute !== "/" && !assets.routes.includes(targetAppRoute)) {
    assets.routes.push(targetAppRoute);
  }

  let totalRequests = 0;

  async function fetchProbe(
    url: string,
    init?: RequestInit
  ): Promise<{ status: number; headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      totalRequests++;
      const res = await doFetch(url, { ...init, signal: controller.signal });
      await res.body?.cancel().catch(() => {});
      return { status: res.status, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchText(
    url: string,
    init?: RequestInit
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      totalRequests++;
      const res = await doFetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async function pool<T>(items: T[], fn: (item: T) => Promise<void>, poolConcurrency = concurrency) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(poolConcurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) {
          try {
            await fn(item);
          } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
          }
        }
      }
    });
    await Promise.all(workers);
  }

  // For deployments without pre-addressed asset manifests (e.g. k8s and GCP container deployments),
  // extract content-addressed assets from the deployed entry document's #pronto-assets map and asset tags.
  if (assets.immutableAssets.length === 0 && options.platform !== "pages") {
    try {
      const entryRes = await fetchText(fullDocumentUrl("/"), {
        headers: { Accept: "text/html" },
      });
      if (entryRes.status === 200 && entryRes.text) {
        const harvested = extractAssetsFromHtml(entryRes.text);
        assets.immutableAssets = harvested.immutableAssets;
        for (const cat of harvested.catalogues) {
          if (!assets.catalogues.includes(cat)) {
            assets.catalogues.push(cat);
          }
        }
      }
    } catch (e) {
      errors.push(`Failed to fetch entry document to extract asset matrix: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (assets.immutableAssets.length === 0 && options.platform !== "pages") {
      errors.push(
        `No immutable assets found in deployment metadata or deployed entry document at ${fullDocumentUrl("/")}`
      );
    }
  }

  // 1. Immutable Asset Matrix
  await pool(assets.immutableAssets, async (assetPath) => {
    const url = assetUrl(assetPath);
    const res = await fetchProbe(url);
    if (res.status !== 200) {
      errors.push(`Immutable asset ${assetPath} returned HTTP ${res.status} (expected 200)`);
      return;
    }
    const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
    if (!cc.includes("immutable") || !cc.includes("max-age=31536000")) {
      errors.push(
        `Immutable asset ${assetPath} missing immutable caching headers: Cache-Control is '${cc}'`
      );
    }
  });

  // 2. Catalogue Matrix
  await pool(assets.catalogues, async (catPath) => {
    const url = assetUrl(catPath);
    const res = await fetchProbe(url);
    if (res.status !== 200) {
      errors.push(`Catalogue ${catPath} returned HTTP ${res.status} (expected 200)`);
    }
  });

  // 3. Negative 404 Cache Poisoning Probe
  let negativeProbeChecked = false;
  const probePath = `/_immutable-${"0".repeat(64)}-dummy.css`;
  try {
    const probeRes = await fetchProbe(assetUrl(probePath));
    if (probeRes.status !== 404) {
      errors.push(
        `Negative 404 probe ${probePath} returned HTTP ${probeRes.status} (expected 404)`
      );
    }
    const probeCc = (probeRes.headers.get("cache-control") ?? "").toLowerCase();
    if (probeCc.includes("immutable") || probeCc.includes("max-age=31536000")) {
      errors.push(
        `Negative 404 probe ${probePath} returned immutable caching header: '${probeCc}' (cache poisoning vulnerability)`
      );
    }
    if (options.platform === "cloudflare" && !probeCc.includes("no-store")) {
      errors.push(
        `Negative 404 probe ${probePath} missing 'no-store' header: '${probeCc}'`
      );
    }
    negativeProbeChecked = true;
  } catch (e) {
    errors.push(`Negative 404 probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Initial Static Document Routes & Live Link Harvesting
  const harvestedLinks = new Set<string>();

  await pool(assets.routes, async (routePath) => {
    const url = fullDocumentUrl(routePath);
    const res = await fetchText(url, {
      headers: { Accept: "text/html" },
    });
    // On Pages, non-root routes intentionally return 404.html with status 404
    const isPagesDeepLink = options.platform === "pages" && routePath !== "/";
    const allowed = isPagesDeepLink ? [200, 404] : [200];
    if (!allowed.includes(res.status)) {
      errors.push(
        `Document route ${routePath} returned HTTP ${res.status} (expected ${allowed.join(" or ")})`
      );
      return;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html")) {
      errors.push(
        `Document route ${routePath} returned unexpected Content-Type '${ct}' (expected text/html)`
      );
    }
    for (const link of harvestLinksFromHtml(res.text)) {
      harvestedLinks.add(link);
    }
  }, Math.min(concurrency, 4));

  // 5. Dynamic Parameterized Route Resolution
  const { resolvedRoutes, screenRoutes } = options.hints?.routes
    ? resolveParameterizedRoutes(options.hints.routes, harvestedLinks, prefix, options.hints.i18n)
    : { resolvedRoutes: new Map<string, string>(), screenRoutes: new Map<string, string>() };

  // Sweep newly resolved parameterized routes
  const parameterizedToSweep = [...new Set([...resolvedRoutes.values()])].filter(
    (p) => !assets.routes.includes(p)
  );

  await pool(parameterizedToSweep, async (routePath) => {
    const url = fullDocumentUrl(routePath);
    const res = await fetchText(url, {
      headers: { Accept: "text/html" },
    });
    const isPagesDeepLink = options.platform === "pages" && routePath !== "/";
    const allowed = isPagesDeepLink ? [200, 404] : [200];
    if (!allowed.includes(res.status)) {
      errors.push(
        `Parameterized route ${routePath} returned HTTP ${res.status} (expected ${allowed.join(" or ")})`
      );
      return;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html")) {
      errors.push(
        `Parameterized route ${routePath} returned unexpected Content-Type '${ct}' (expected text/html)`
      );
    }
  }, Math.min(concurrency, 4));

  return {
    passed: errors.length === 0,
    totalRequests,
    assetsChecked: assets.immutableAssets.length,
    cataloguesChecked: assets.catalogues.length,
    routesChecked: assets.routes.length + parameterizedToSweep.length,
    negativeProbeChecked,
    resolvedRoutes,
    screenRoutes,
    errors,
  };
}
