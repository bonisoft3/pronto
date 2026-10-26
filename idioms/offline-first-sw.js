// A release is its entry (pronto's release-addresses.ts): every file a page
// runs is named by its content address in the entry's map, and an addressed
// file never changes. So an address is answered from this worker's copy
// forever, and a navigation from the copy of the entry it kept, revalidated
// behind it: a kept entry names only addresses, so painting it is coherent,
// and offline it is the page. The worker holds no release state; the page
// learns of a newer entry itself (shell.js) and drops the kept one to take it.
const ADDRESSED_CACHE = "pronto-addressed-v1";
const ENTRY_CACHE = "pronto-entries-v1";

const ADDRESSED = /\/_immutable-[0-9a-f]{64}-[^/]*$/;
const BYPASS_PREFIXES = ["/electric/", "/crud/", "/auth/", "/events/"];

// A document's request-only reads are current only as it arrives
// (interpreter/data-sync.js), so the copy kept for a later paint goes
// without them, and a shell taking that copy over asks the network. The copy
// says it is one, so the page painted from it asks whether a deployment
// landed since (shell.js) and one painted from the network does not.
const SERVED_READS = /<script type="application\/json" id="pronto-reads">[\s\S]*?<\/script>/;
const HEAD = /<head\b[^>]*>/;

async function keptCopy(response) {
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html.replace(SERVED_READS, "").replace(HEAD, (head) => `${head}<meta name="pronto-kept">`), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== ADDRESSED_CACHE && k !== ENTRY_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) return;
  if (req.cache === "no-store") return;

  if (ADDRESSED.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(ADDRESSED_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh.ok) event.waitUntil(cache.put(url.pathname, fresh.clone()));
      return fresh;
    })());
    return;
  }

  if (req.mode !== "navigate") return;
  event.respondWith((async () => {
    const cache = await caches.open(ENTRY_CACHE);
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
  })());
});
