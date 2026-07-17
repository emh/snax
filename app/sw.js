const CACHE_NAME = "snax-shell-v32";
const APP_SHELL = [
  "./",
  "./index.html",
  "./fonts/fonts.css",
  "./fonts/atkinson-hyperlegible-mono-latin.woff2",
  "./fonts/atkinson-hyperlegible-next-latin.woff2",
  "./fonts/atkinson-hyperlegible-next-italic-latin.woff2",
  "./fonts/barlow-condensed-500-latin.woff2",
  "./fonts/barlow-condensed-600-latin.woff2",
  "./fonts/barlow-condensed-700-latin.woff2",
  "./fonts/barlow-condensed-800-latin.woff2",
  "./fonts/caveat-latin.woff2",
  "./fonts/cormorant-garamond-italic-latin.woff2",
  "./fonts/permanent-marker-latin.woff2",
  "./styles.css",
  "./themes/basquiat.css",
  "./themes/mondrian.css",
  "./themes/pollock.css",
  "./assets/basquiat-exercise-icons.png",
  "./theme.js",
  "./config.js",
  "./main.js",
  "./model.js",
  "./storage.js",
  "./sync.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon.png",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(warmCache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function warmCache() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })));
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok && shouldCache(request)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    if (fallbackUrl) {
      const fallback = (await cache.match(fallbackUrl)) || (await cache.match("./"));
      if (fallback) {
        return fallback;
      }
    }

    throw error;
  }
}

function shouldCache(request) {
  const url = new URL(request.url);
  return request.cache !== "no-store" && !url.search;
}
