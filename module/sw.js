/* Scope-safe, versioned offline cache for the assistant's static sources. */
const CACHE_NAME = "db-assistant-static-v6";
const APP_ROOT = new URL("./", self.registration.scope);
const MODULE_ROOT = new URL("module/", APP_ROOT);
const STATIC_ASSETS = [
  APP_ROOT,
  new URL("index.html", APP_ROOT),
  new URL("db-assistant.js", MODULE_ROOT),
  new URL("db-assistant.min.js", MODULE_ROOT),
  new URL("search.js", MODULE_ROOT),
  new URL("i18n/en.json", MODULE_ROOT),
  new URL("i18n/am.json", MODULE_ROOT),
  new URL("i18n/om.json", MODULE_ROOT),
  new URL("i18n/ti.json", MODULE_ROOT),
  new URL("i18n/so.json", MODULE_ROOT),
  new URL("i18n/ar.json", MODULE_ROOT),
  new URL("demo/data/content.json", APP_ROOT),
  new URL("demo/data/jobs.json", APP_ROOT),
  new URL("demo/blank.html", APP_ROOT),
  new URL("savanna/pages/concept-with-navigation.html", APP_ROOT)
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(STATIC_ASSETS.map(async (path) => {
      const url = new URL(path);
      try {
        const response = await fetch(url, { cache: "reload" });
        if (response.ok) await cache.put(url, response);
      } catch { /* Cache the rest even when one optional source is unavailable. */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("db-assistant-static-") && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) {
      fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
      }).catch(() => {});
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response.ok && (
        url.pathname.includes("/module/")
        || url.pathname.includes("/demo/data/content.json")
        || url.pathname === new URL("index.html", APP_ROOT).pathname
        || url.pathname === new URL("savanna/pages/concept-with-navigation.html", APP_ROOT).pathname
      )) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return new Response("Offline and not cached.", { status: 503, statusText: "Offline" });
    }
  })());
});
