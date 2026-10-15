const STATIC_CACHE = "pronto-static-v3";
const RUNTIME_CACHE = "pronto-runtime-v3";
const VERIFIED_CACHE = "pronto-verified-releases-v1";
const PIN_CACHE = "pronto-release-clients-v1";
const PENDING_MS = 60 * 60 * 1000;

const PRECACHE_ASSETS = [
  "/shell/index.html",
  "/shell/shell.css",
  "/shell/design.css",
  "/shell/boot.js",
];

const BYPASS_PREFIXES = ["/electric/", "/crud/", "/auth/", "/events/"];

// A document's request-only reads are current only as it arrives
// (interpreter/data-sync.js), so the copy kept for a later paint goes
// without them, and a shell taking that copy over asks the network.
const SERVED_READS = /<script type="application\/json" id="pronto-reads">[\s\S]*?<\/script>/;

async function keptCopy(response) {
  const html = await response.text();
  return new Response(html.replace(SERVED_READS, ""), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE && k !== VERIFIED_CACHE && k !== PIN_CACHE)
          .map((k) => caches.delete(k)),
      )
    ).then(cleanPins).then(() => self.clients.claim()),
  );
});

function pinKey(kind, id) {
  return new URL(`/.pronto/release-${kind}/${encodeURIComponent(id)}`, self.location.origin).href;
}

async function cleanPins() {
  const cache = await caches.open(PIN_CACHE);
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/.pronto/release-clients/")) continue;
    const response = await cache.match(request);
    if (!response) continue;
    const pin = await response.json();
    const id = decodeURIComponent(url.pathname.split("/").pop());
    if (await self.clients.get(id)) continue;
    // A reserved navigation or worker client is not yet execution-ready.
    // Only its first request proves arrival; abandoned loads age out.
    if (!pin.pending || Date.now() - pin.createdAt >= PENDING_MS) await cache.delete(request);
  }
}

async function clientPin(clientId) {
  if (!clientId) return null;
  const cache = await caches.open(PIN_CACHE);
  const key = pinKey("clients", clientId);
  const response = await cache.match(key);
  if (!response) return null;
  const pin = await response.json();
  if (pin.pending) {
    pin.pending = false;
    await cache.put(key, new Response(JSON.stringify(pin)));
  }
  return pin;
}

async function pinClient(clientId, pin) {
  if (!clientId) throw new Error("pinned response has no resulting client");
  await (await caches.open(PIN_CACHE)).put(pinKey("clients", clientId), new Response(JSON.stringify({
    ...pin, pending: true, createdAt: Date.now(),
  })));
}

async function manifestFor(pin) {
  const response = await (await caches.open(VERIFIED_CACHE)).match(new URL(`shell/release.json?pronto-release=${pin.id}`, pin.base).href);
  if (!response) throw new Error(`verified release not cached: ${pin.id}`);
  const manifest = await response.json();
  if (manifest.id !== pin.id) throw new Error("cached release identity mismatch");
  return manifest;
}

function assetUrl(pin, path) {
  return new URL(path.startsWith("omnishell/") ? `/${path}` : path, pin.base).href;
}

function assetPath(pin, url) {
  const base = new URL(pin.base);
  return url.pathname.startsWith("/omnishell/") ? url.pathname.slice(1)
    : url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : "";
}

async function workerReferrerPin(request) {
  if (!request.referrer) return null;
  const referrer = new URL(request.referrer);
  const id = referrer.searchParams.get("pronto-release");
  if (referrer.origin !== self.location.origin || !id) return null;
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid worker release pin");
  const response = await (await caches.open(PIN_CACHE)).match(pinKey("targets", id));
  if (!response) throw new Error(`worker release was not prepared: ${id}`);
  const pin = await response.json();
  await verifiedAsset(pin, assetPath(pin, referrer));
  return pin;
}

async function verifiedAsset(pin, path, manifest = null) {
  manifest ??= await manifestFor(pin);
  if (!Object.hasOwn(manifest.assets, path)) throw new Error(`asset absent from pinned release: ${path}`);
  const response = await (await caches.open(VERIFIED_CACHE)).match(`${assetUrl(pin, path)}?pronto-release=${pin.id}`);
  if (!response) throw new Error(`incomplete pinned release ${pin.id}: ${path}`);
  return response;
}

async function ownsNavigation(pin, pathname) {
  const cfg = await (await verifiedAsset(pin, "shell/shell.json")).json();
  const prefix = cfg.prefix ?? "";
  if (prefix) {
    if (pathname === prefix) pathname = "/";
    else if (pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length);
    else return false;
  }
  let segments = pathname.split("/");
  let locale = cfg.i18n?.default;
  const localized = Object.entries(cfg.i18n?.locales ?? {}).find(([tag, spec]) =>
    String(spec?.path ?? tag).toLowerCase() === segments[1]);
  if (localized) {
    locale = localized[0];
    segments = ["", ...segments.slice(2)];
    if (segments.length === 1) segments.push("");
  }
  return (cfg.routes ?? []).some((route) => {
    const pattern = route.paths === undefined ? route.path : route.paths[locale];
    if (pattern === undefined) return false;
    const expected = pattern.split("/");
    return expected.length === segments.length && expected.every((part, index) =>
      part.startsWith(":") ? segments[index] !== "" : part === segments[index]);
  });
}

self.addEventListener("message", (event) => {
  if (!["PRONTO_RELEASE_CLIENT", "PRONTO_RELEASE_READY"].includes(event.data?.type)) return;
  const answer = event.ports[0];
  event.waitUntil((async () => {
    await cleanPins();
    if (event.data.type === "PRONTO_RELEASE_CLIENT") {
      answer.postMessage({ id: (await clientPin(event.source.id))?.id ?? null });
      return;
    }
    const pin = { base: event.data.base, id: event.data.id, restartPath: new URL(event.source.url).pathname };
    if (!/^[0-9a-f]{64}$/.test(pin.id) || new URL(pin.base).origin !== self.location.origin) throw new Error("invalid release pin");
    const manifest = await manifestFor(pin);
    if (!manifest.assets["shell/index.html"] || !manifest.assets["omnishell/interpreter/shell.js"]) throw new Error("release lacks entry or runtime");
    await Promise.all(Object.keys(manifest.assets).map((path) => verifiedAsset(pin, path, manifest)));
    await (await caches.open(PIN_CACHE)).put(pinKey("targets", pin.id), new Response(JSON.stringify({ ...pin, preparedAt: Date.now() })));
    answer.postMessage({ ready: true });
  })().catch((error) => { answer.postMessage({ error: error.message }); }));
});

async function pinnedResponse(event, url) {
  let pin = await clientPin(event.clientId || event.replacesClientId);
  if (event.request.mode === "navigate") {
    const explicit = url.searchParams.get("pronto-release");
    if (explicit) {
      if (!/^[0-9a-f]{64}$/.test(explicit)) throw new Error("invalid navigation release pin");
      const response = await (await caches.open(PIN_CACHE)).match(pinKey("targets", explicit));
      if (!response) throw new Error(`release was not prepared: ${explicit}`);
      pin = await response.json();
    }
    if (!pin) return null;
    const basePath = new URL(pin.base).pathname;
    if (url.pathname !== basePath.replace(/\/$/, "") && !url.pathname.startsWith(basePath)) return null;
    if (!(explicit && url.pathname === pin.restartPath) && !await ownsNavigation(pin, url.pathname)) return null;
    const entry = await verifiedAsset(pin, "shell/index.html");
    await cleanPins();
    await pinClient(event.resultingClientId, pin);
    return entry;
  }
  // Chromium omits clientId on nested-worker subrequests. Their entry URL
  // carries the same release through the browser's same-origin referrer.
  pin ??= await workerReferrerPin(event.request);
  if (!pin) return null;
  const path = assetPath(pin, url);
  if (!/^(?:shell|messages|omnishell)\//.test(path)) return null;
  const response = await verifiedAsset(pin, path);
  if (event.request.destination === "worker" || event.request.destination === "sharedworker") {
    await pinClient(event.resultingClientId, pin);
    if (url.searchParams.get("pronto-release") !== pin.id) {
      url.searchParams.set("pronto-release", pin.id);
      return Response.redirect(url.href);
    }
    const headers = new Headers(response.headers);
    headers.set("Referrer-Policy", "same-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) return;
  if (req.cache === "no-store") return;

  event.respondWith((async () => {
    const pinned = await pinnedResponse(event, url);
    if (pinned) return pinned;
    if (["/shell/", "/omnishell/", "/messages/"].some((p) => url.pathname.startsWith(p))) {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      const kept = cached?.clone();
      const update = (async () => {
        let fresh;
        try {
          fresh = await fetch(req);
        } catch (error) {
          if (cached) return cached;
          throw error;
        }
        if (!fresh.ok) return fresh;
        if (!cached) {
          event.waitUntil(cache.put(req, fresh.clone()));
          return fresh;
        }
        const newText = await fresh.clone().text();
        if (newText === await kept.text()) return fresh;
        event.waitUntil(cache.put(req, fresh.clone()).then(async () => {
          const clients = await self.clients.matchAll({ type: "window" });
          for (const client of clients) {
            if (url.pathname.endsWith(".html")) {
              client.postMessage({ type: "PRONTO_SKELETON_UPDATED", url: req.url, pathname: url.pathname, html: newText });
            } else if (url.pathname.endsWith(".css")) {
              client.postMessage({ type: "PRONTO_STYLE_UPDATED", url: req.url, pathname: url.pathname, css: newText });
            } else if (url.pathname.startsWith("/messages/")) {
              client.postMessage({ type: "PRONTO_MESSAGES_UPDATED", url: req.url, pathname: url.pathname, json: newText });
            } else {
              client.postMessage({ type: "PRONTO_ASSET_UPDATED", url: req.url, pathname: url.pathname });
            }
          }
        }));
        return fresh;
      })();
      if (req.cache === "no-cache") {
        const fresh = await update;
        return fresh.status >= 500 ? cached ?? fresh : fresh;
      }
      if (cached) {
        event.waitUntil(update);
        return cached;
      }
      return update;
    }

    if (req.mode === "navigate") {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const update = (async () => {
        let fresh;
        try {
          fresh = await fetch(req);
        } catch (error) {
          if (cached) return cached;
          throw error;
        }
        const cc = fresh.headers.get("Cache-Control") || "";
        const keepable = !cc.includes("no-store") && !cc.includes("private");
        if (fresh.ok && keepable) event.waitUntil(keptCopy(fresh.clone()).then((copy) => cache.put(req, copy)));
        else if (fresh.status === 404 || fresh.status === 410 || (fresh.ok && !keepable)) event.waitUntil(cache.delete(req));
        return fresh;
      })();
      if (cached) {
        event.waitUntil(update);
        return cached;
      }
      return update;
    }
    return fetch(req);
  })());
});
