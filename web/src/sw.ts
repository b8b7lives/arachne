declare const __BUILD_ID__: string;

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `arachne-${__BUILD_ID__}`;
const HASHED = /\/assets\/[^/]+\.(js|css|wasm)$|\.(png|webp|svg|woff2)$|\?v=/;
const DATA = /\.json$/;

sw.addEventListener("install", () => sw.skipWaiting());

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
});

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw new Error("offline");
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  const key = url.pathname + url.search;
  if (req.mode === "navigate" || DATA.test(url.pathname)) event.respondWith(networkFirst(req));
  else if (HASHED.test(key)) event.respondWith(cacheFirst(req));
});
