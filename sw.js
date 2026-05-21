/* sw.js — offline cache for Reader X.
   Network-first so edits show up immediately; falls back to cache
   when offline. Books themselves live in IndexedDB, not here. */
const CACHE = "readerx-v2";
const ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/storage.js",
  "js/epub-reader.js",
  "js/pdf-reader.js",
  "js/library.js",
  "js/app.js",
  "vendor/jszip.min.js",
  "vendor/epub.min.js",
  "vendor/pdf.min.js",
  "vendor/pdf.worker.min.js",
  "manifest.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
