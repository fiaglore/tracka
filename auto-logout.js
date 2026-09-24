// auto-logout.js
//
// Signs the user out automatically in two situations:
//   1. Inactivity — no mouse/keyboard/scroll/touch activity for
//      INACTIVITY_MS. A "Still there?" dialog then counts down
//      WARNING_MS before signing out. Once it's up, only its own buttons
//      ("Stay signed in" / "Sign out now") dismiss it — activity elsewhere
//      on the page (a passing mousemove, a scroll) is ignored on purpose,
//      so the warning can't disappear without an actual decision.
//   2. Session cap — SESSION_CAP_MS after sign-in (kept across reloads in the same tab), unconditionally.
//      Not reset by activity or by dismissing the inactivity warning —
//      it's a hard ceiling on how long a session can last.
//
// Both are tracked as wall-clock deadlines, re-checked on a 1s tick and
// immediately on every visibility change (tab hidden/backgrounded, or the
// screen locked — most platforms report that as hidden too), not as a
// plain setTimeout. That's what makes leaving the screen count the same as
// leaving the mouse alone: idle time keeps accruing in the background, and
// whichever of "tab comes back" or "tab goes away" happens next re-checks
// it immediately, so a tab left hidden past both windows signs out as soon
// as that's noticed rather than only whenever it's next looked at. (A
// browser's own screen-dim/brightness state isn't something any webpage
// can read — it's blocked for privacy — so visibility/backgrounding is the
// closest real signal available, and inactivity that leads to a dim screen
// was already being counted by the mouse/keyboard timer regardless.)
//
// Wired to window.Trakka (see firebase-init.js) for auth state and
// sign-out, so it only runs while someone is actually signed in, and
// reuses the same signOutUser() the "🔒 Sign out" button calls. Where it
// sends the user afterward depends on whether a quick-unlock PIN is cached
// on this device (window.Trakka.hasPinConfigured(), see firebase-init.js):
// sign-in.html (which then shows the PIN-unlock card instead of the full
// form — see app.js's auth IIFE) if so, otherwise signed-out.html as
// before. A sessionStorage flag, set here right before signing out, is what
// tells app.js's own onAuthChange listener (which reacts to the same
// sign-out independently, and could otherwise race this one to decide
// where to land) to make the same choice — see the comment in
// forceLogout() below. That flag is only ever set here, never by the
// manual "🔒 Sign out" button, which is what keeps a manual sign-out always
// landing on the plain form.

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
    // Once the warning is up, only its own buttons ("Stay signed in" / "Sign
    // out now") dismiss it — a passing mousemove or scroll used to silently
    // cancel it, which defeated the point of asking "Still there?" at all.
    if (warningOpen()) return;
    const now = Date.now();
    if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
    lastActivityAt = now;
  }

  function onVisibilityChange() {
    // Re-check immediately in both directions. Going hidden — the tab was
    // switched away, minimized, or (on most platforms) the screen locked —
    // is itself a real signal, and getting one authoritative tick() in
    // right as it happens matters because background tabs get their timers
    // throttled or fully suspended, so the regular 1s interval may not fire
    // again (accurately or at all) until the tab is visible again. Coming
    // back needs the same catch-up, for time that passed while suspended.
    tick();
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
      // Set this BEFORE signing out, not after: app.js's own onAuthChange
      // listener reacts to the very same signOut() call directly (it's not
      // just observing what this function does afterward), so by the time
      // that listener runs it may already have raced ahead of us — the flag
      // has to be in place before signOut() fires for both of us to agree
      // on where this lands. Only set here, never by the manual "🔒 Sign
      // out" button, so that one keeps landing on the plain sign-in form.
      var canOfferPin = false;
      try { canOfferPin = !!(window.Trakka && window.Trakka.hasPinConfigured && window.Trakka.hasPinConfigured()); } catch (e) {}
      if (canOfferPin) { try { sessionStorage.setItem("trakkaAutoLogoutPending", "1"); } catch (e) {} }
      var out = (window.Trakka && typeof window.Trakka.signOutUser === "function")
        ? window.Trakka.signOutUser()
        : Promise.resolve();
      // app.js's auth listener also redirects on sign-out; this is the backstop
      // so the tracker never stays on screen after a forced logout.
      return Promise.resolve(out).catch(function () {}).then(function () {
        try { sessionStorage.removeItem(SESSION_START_KEY); } catch (e) {}
        location.replace(canOfferPin ? "sign-in.html" : "signed-out.html");
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

  // firebase-init.js sets window.Trakka and fires "trakka:ready" from the
  // top level of a <script type="module">. Per the script tags in
  // sign-in.html, that module always appears first and (per the
  // HTML spec's script-ordering rules for defer/module scripts) always
  // finishes running before this classic deferred script starts. So by
  // the time this file runs, "trakka:ready" has *already* fired — an
  // addEventListener for it here would wait forever and auto-logout would
  // never engage. Check for window.Trakka directly first; keep the event
  // listener only as a fallback in case the script order ever changes.
  function wireUpAuthTracking() {
    window.Trakka.onAuthChange(function (user) {
      if (user) startTracking();
      else {
        stopTracking();
        try { sessionStorage.removeItem(SESSION_START_KEY); } catch (e) {}
      }
    });
  }

  if (window.Trakka) {
    wireUpAuthTracking();
  } else {
    window.addEventListener("trakka:ready", wireUpAuthTracking);
  }
})();
