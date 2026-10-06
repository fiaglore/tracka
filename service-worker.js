// service-worker.js
//
// Makes Trakka installable and gives it an offline app shell. It only
// caches the tracker's own static files (HTML/CSS/JS/icons) — it never
// touches Firebase Auth/Firestore requests or the Google Fonts CDN, so
// sign-in and cloud sync always go straight to the network.
//
// Bump CACHE_VERSION whenever any shell file changes, so returning users
// pick up the new version instead of a stale cached copy.
const CACHE_VERSION = "tracka-shell-v134";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./sign-in.html",
  "./settings.html",
  "./signed-out.html",
  "./faq.html",
  "./terms.html",
  "./styles.css",
  "./app.js",
  "./firebase-init.js",
  "./ambient-audio.js",
  "./sfx.js",
  "./pwa.js",
  "./app-entry.js",
  "./auto-logout.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "./images/hero-phone-smile.jpg",
  "./images/final-cta-planner.jpg",
  "./images/premium-banner-top.jpg",
  "./images/premium-banner-side.jpg"
];

// A host that serves *.html at a "pretty" extensionless URL (Cloudflare
// Pages does this by default: a request for ./sign-in.html gets a 308 to
// ./sign-in) hands fetch() back a Response with .redirected === true.
// Chrome refuses to use a redirected Response to satisfy a *navigation*,
// so a precached or cache.put'd redirected entry silently breaks offline
// loads and the navigate handler's offline fallback below. Re-wrapping the
// body in a fresh, non-redirected Response before it ever reaches
// cache.put fixes this at the one place it needs fixing, rather than at
// every call site. A response that was never redirected passes through
// untouched.
async function cleanResponse(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, {
    headers: res.headers,
    status: res.status,
    statusText: res.statusText
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(
        SHELL_FILES.map((url) =>
          fetch(url)
            .then(cleanResponse)
            .then((res) => cache.put(url, res))
        )
      )
    )
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
          cleanResponse(res.clone()).then((clean) =>
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clean))
          );
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  // Code/style shell files: network-first, same as navigations above. These
  // change with every feature PR, and navigations already fetch the latest
  // HTML network-first — cache-first here used to let a stale cached app.js
  // get paired with that fresh HTML for one whole page load right after a
  // deploy (new markup, e.g. a new card's DOM, wired up by old JS that
  // doesn't know about it — the card would sit there never updating). Only
  // falls back to cache when actually offline.
  if (/\.(js|css)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            cleanResponse(res.clone()).then((clean) =>
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, clean))
            );
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (icons, manifest): cache-first, refreshing the cache in
  // the background when the network has a newer copy. These essentially
  // never change, so serving instantly from cache is worth it here in a way
  // it isn't for code/styles above.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            cleanResponse(res.clone()).then((clean) =>
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, clean))
            );
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ----- Web Push -----
// Fires while Trakka is fully closed (no tab, no open PWA window) — this is
// the one piece of the notification system that genuinely can't run as
// plain page JS, since nothing is executing to receive it otherwise. The
// actual decision of WHEN to send lives entirely outside this file, in the
// scheduled GitHub Actions job (notifications/scripts/send-notifications.mjs) that calls
// the Web Push protocol directly — this handler just displays whatever
// payload it's handed. See subscribeToPush() in firebase-init.js for how a
// device registers to receive these in the first place.
self.addEventListener("push", (event) => {
  let payload = { title: "AnchorTrakk", body: "" };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (e) {
    // Not JSON (shouldn't happen — the sender always sends JSON — but a
    // malformed payload should still show SOMETHING rather than silently
    // drop, since some browsers require every push to result in a
    // notification or they'll warn/penalize the site).
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./icon-192.png",
      badge: "./icon-192.png"
    })
  );
});

// Clicking the notification focuses an already-open Trakka tab if there is
// one, or opens a fresh one otherwise — without this, a push notification's
// click does nothing at all (that's the default).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./sign-in.html");
    })
  );
});
