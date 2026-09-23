// auto-logout.js
//
// Signs the user out automatically in two situations:
//   1. Inactivity — no mouse/keyboard/scroll/touch activity for
//      INACTIVITY_MS. A "Still there?" dialog then counts down
//      WARNING_MS before signing out; any activity, or clicking
//      "Stay signed in", cancels it and restarts the idle clock.
//   2. Session cap — SESSION_CAP_MS after sign-in (kept across reloads in the same tab), unconditionally.
//      Not reset by activity or by dismissing the inactivity warning —
//      it's a hard ceiling on how long a session can last.
//
// Wired to window.Tracka (see firebase-init.js) for auth state and
// sign-out, so it only runs while someone is actually signed in, and
// reuses the same signOutUser() the "🔒 Sign out" button calls, then sends
// the user to signed-out.html (app.js's auth listener does the same).

(function () {
  "use strict";

  const INACTIVITY_MS  = 2 * 60 * 1000;   // idle time before the warning appears
  const WARNING_MS     = 60 * 1000;       // how long the warning stays up before forcing sign-out
  const SESSION_CAP_MS = 20 * 60 * 1000;  // hard cap on total signed-in time
  const SAVE_FLUSH_TIMEOUT_MS = 3000;     // how long forceLogout waits for a pending save to land

  const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart"];
  const ACTIVITY_THROTTLE_MS = 1000; // record activity at most once/sec

  const TICK_MS = 1000;
  const SESSION_START_KEY = "trackaSessionStartedAt";

  // Everything is tracked as wall-clock deadlines checked on a 1s tick (and
  // whenever the tab becomes visible again), not as one long setTimeout.
  // Browsers throttle or freeze timers in background tabs and on sleeping
  // phones, so a single 2-minute setTimeout could fire far too late — or,
  // for an installed PWA that gets suspended, effectively never.
  let tickTimer = null;
  let lastActivityAt = 0;
  let sessionStartedAt = 0;
  let warningDeadline = 0;
  let overlayEl = null;
  let listening = false;
  let loggingOut = false;

  function buildOverlay() {
    if (overlayEl) return overlayEl;
    const wrap = document.createElement("div");
    wrap.id = "idle-warning-overlay";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "idle-warning-title");
    wrap.innerHTML =
      '<div class="auth-card" id="idle-warning-card">' +
        '<h2 id="idle-warning-title">Still there?</h2>' +
        '<p class="auth-sub">You\u2019ve been inactive. For your security you\u2019ll be signed out in <span id="idle-warning-count">60</span>s.</p>' +
        '<button type="button" class="auth-submit" id="idle-warning-stay">Stay signed in</button>' +
        '<button type="button" class="auth-link" id="idle-warning-out">Sign out now</button>' +
      "</div>";
    document.body.appendChild(wrap);
    overlayEl = wrap;
    wrap.querySelector("#idle-warning-stay").addEventListener("click", dismissWarning);
    wrap.querySelector("#idle-warning-out").addEventListener("click", function () { forceLogout("manual"); });
    return wrap;
  }

  function warningOpen() {
    return !!(overlayEl && overlayEl.classList.contains("open"));
  }

  function showWarning() {
    buildOverlay().classList.add("open");
    warningDeadline = lastActivityAt + INACTIVITY_MS + WARNING_MS;
  }

  function hideWarning() {
    if (overlayEl) overlayEl.classList.remove("open");
  }

  function dismissWarning() {
    hideWarning();
    lastActivityAt = Date.now();
  }

  function tick() {
    if (!listening || loggingOut) return;
    const now = Date.now();
    if (now - sessionStartedAt >= SESSION_CAP_MS) { forceLogout("session-cap"); return; }
    const idleFor = now - lastActivityAt;
    // Covers a tab that slept straight past the whole warning window too.
    if (idleFor >= INACTIVITY_MS + WARNING_MS) { forceLogout("inactivity"); return; }
    if (idleFor >= INACTIVITY_MS) {
      if (!warningOpen()) showWarning();
      const remaining = Math.max(0, Math.ceil((warningDeadline - now) / 1000));
      const countEl = overlayEl.querySelector("#idle-warning-count");
      if (countEl) countEl.textContent = String(remaining);
    }
  }

  function onActivity() {
    if (loggingOut) return;
    const now = Date.now();
    if (warningOpen()) { dismissWarning(); return; }
    if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
    lastActivityAt = now;
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") tick();
  }

  // Firestore's pending-write retry carries the auth context it was created with, so signing
  // out while a write is still in flight fails the security rule (request.auth.uid == userId)
  // — and that failure was console-only, meaning the user's last change before an auto-logout
  // could vanish with nothing shown. app.js exposes __ftFlushSave() (see save()/flushSave());
  // we wait on it, with a short ceiling so a dead connection can't block sign-out forever.
  function forceLogout() {
    if (loggingOut) return;
    loggingOut = true;
    stopTracking();
    var flush;
    try {
      flush = (window.__ftFlushSave && window.__ftFlushSave()) || Promise.resolve();
    } catch (e) {
      flush = Promise.resolve();
    }
    var ceiling = new Promise(function (resolve) { setTimeout(resolve, SAVE_FLUSH_TIMEOUT_MS); });
    Promise.race([Promise.resolve(flush).catch(function () {}), ceiling]).then(function () {
      var out = (window.Tracka && typeof window.Tracka.signOutUser === "function")
        ? window.Tracka.signOutUser()
        : Promise.resolve();
      // app.js's auth listener also redirects on sign-out; this is the backstop
      // so the tracker never stays on screen after a forced logout.
      return Promise.resolve(out).catch(function () {}).then(function () {
        try { sessionStorage.removeItem(SESSION_START_KEY); } catch (e) {}
        location.replace("signed-out.html");
      });
    });
  }

  function startTracking() {
    if (listening) return;
    listening = true;
    loggingOut = false;
    lastActivityAt = Date.now();
    // Keep the session cap across reloads in this tab, so refreshing the page
    // doesn't hand out a fresh 20 minutes.
    sessionStartedAt = lastActivityAt;
    try {
      const saved = Number(sessionStorage.getItem(SESSION_START_KEY));
      if (saved && saved <= sessionStartedAt) sessionStartedAt = saved;
      else sessionStorage.setItem(SESSION_START_KEY, String(sessionStartedAt));
    } catch (e) {}
    // Capture phase: scroll/wheel on inner scrolling panels don't bubble to document.
    ACTIVITY_EVENTS.forEach(function (evt) {
      document.addEventListener(evt, onActivity, { passive: true, capture: true });
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    tickTimer = setInterval(tick, TICK_MS);
    tick();
  }

  function stopTracking() {
    listening = false;
    ACTIVITY_EVENTS.forEach(function (evt) {
      document.removeEventListener(evt, onActivity, { capture: true });
    });
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    hideWarning();
  }

  // firebase-init.js sets window.Tracka and fires "tracka:ready" from the
  // top level of a <script type="module">. Per the script tags in
  // sign-in.html, that module always appears first and (per the
  // HTML spec's script-ordering rules for defer/module scripts) always
  // finishes running before this classic deferred script starts. So by
  // the time this file runs, "tracka:ready" has *already* fired — an
  // addEventListener for it here would wait forever and auto-logout would
  // never engage. Check for window.Tracka directly first; keep the event
  // listener only as a fallback in case the script order ever changes.
  function wireUpAuthTracking() {
    window.Tracka.onAuthChange(function (user) {
      if (user) startTracking();
      else {
        stopTracking();
        try { sessionStorage.removeItem(SESSION_START_KEY); } catch (e) {}
      }
    });
  }

  if (window.Tracka) {
    wireUpAuthTracking();
  } else {
    window.addEventListener("tracka:ready", wireUpAuthTracking);
  }
})();
