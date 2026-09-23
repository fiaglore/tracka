// service-worker.js
//
// Makes Trakka installable and gives it an offline app shell. It only
// caches the tracker's own static files (HTML/CSS/JS/icons) — it never
// touches Firebase Auth/Firestore requests or the Google Fonts CDN, so
// sign-in and cloud sync always go straight to the network.
//
// Bump CACHE_VERSION whenever any shell file changes, so returning users
// pick up the new version instead of a stale cached copy.
const CACHE_VERSION = "tracka-shell-v13";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./sign-in.html",
  "./signed-out.html",
  "./styles.css",
  "./app.js",
  "./firebase-init.js",
  "./pwa.js",
  "./app-entry.js",
  "./auto-logout.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_VERSION)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests to this same origin — everything else
  // (Firebase Auth, Firestore, Google Fonts, gstatic module imports)
  // goes straight to the network untouched.
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Page navigations: try the network first so a returning user with a
  // connection always gets the latest shell. Offline, fall back to
  // whichever page was actually requested (e.g. a signed-in user
  // reopening sign-in.html should land back on sign-in.html, not get
  // bounced to the marketing landing page) and only fall back to the cached landing
  // page as a last resort if that exact page was never cached.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  // Static shell assets: cache-first, refreshing the cache in the
  // background when the network has a newer copy.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
