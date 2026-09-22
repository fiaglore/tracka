// auto-logout.js
//
// Signs the user out automatically in two situations:
//   1. Inactivity — no mouse/keyboard/scroll/touch activity for
//      INACTIVITY_MS. A "Still there?" dialog then counts down
//      WARNING_MS before signing out; any activity, or clicking
//      "Stay signed in", cancels it and restarts the idle clock.
//   2. Session cap — SESSION_CAP_MS after sign-in, unconditionally.
//      Not reset by activity or by dismissing the inactivity warning —
//      it's a hard ceiling on how long a session can last.
//
// Wired to window.Tracka (see firebase-init.js) for auth state and
// sign-out, so it only runs while someone is actually signed in, and
// reuses the same signOutUser() the "🔒 Sign out" button calls — the
// existing onAuthChange listener elsewhere in the app is what re-locks
// the UI afterward, this script doesn't touch that.

(function () {
  "use strict";

  const INACTIVITY_MS  = 30 * 1000;       // idle time before the warning appears
  const WARNING_MS     = 60 * 1000;       // how long the warning stays up before forcing sign-out
  const SESSION_CAP_MS = 10 * 60 * 1000;  // hard cap on total signed-in time

  const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart"];
  const ACTIVITY_THROTTLE_MS = 1000; // don't rearm the idle timer more than once/sec

  let inactivityTimer = null;
  let sessionCapTimer = null;
  let warningCountdownTimer = null;
  let warningDeadline = 0;
  let lastActivityHandledAt = 0;
  let overlayEl = null;
  let listening = false;

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

  function showWarning() {
    const el = buildOverlay();
    el.classList.add("open");
    warningDeadline = Date.now() + WARNING_MS;
    updateCountdown();
    warningCountdownTimer = setInterval(updateCountdown, 250);
  }

  function updateCountdown() {
    const remaining = Math.max(0, Math.ceil((warningDeadline - Date.now()) / 1000));
    const countEl = overlayEl && overlayEl.querySelector("#idle-warning-count");
    if (countEl) countEl.textContent = String(remaining);
    if (remaining <= 0) forceLogout("inactivity");
  }

  function hideWarning() {
    if (overlayEl) overlayEl.classList.remove("open");
    if (warningCountdownTimer) { clearInterval(warningCountdownTimer); warningCountdownTimer = null; }
  }

  function dismissWarning() {
    hideWarning();
    armInactivityTimer();
  }

  function armInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(showWarning, INACTIVITY_MS);
  }

  function onActivity() {
    const now = Date.now();
    if (overlayEl && overlayEl.classList.contains("open")) {
      dismissWarning();
      lastActivityHandledAt = now;
      return;
    }
    if (now - lastActivityHandledAt < ACTIVITY_THROTTLE_MS) return;
    lastActivityHandledAt = now;
    armInactivityTimer();
  }

  function forceLogout() {
    stopTracking();
    if (window.Tracka && typeof window.Tracka.signOutUser === "function") {
      window.Tracka.signOutUser().catch(function () {});
    }
  }

  function startTracking() {
    if (listening) return;
    listening = true;
    ACTIVITY_EVENTS.forEach(function (evt) {
      document.addEventListener(evt, onActivity, { passive: true });
    });
    armInactivityTimer();
    sessionCapTimer = setTimeout(function () { forceLogout("session-cap"); }, SESSION_CAP_MS);
  }

  function stopTracking() {
    listening = false;
    ACTIVITY_EVENTS.forEach(function (evt) {
      document.removeEventListener(evt, onActivity);
    });
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (sessionCapTimer) { clearTimeout(sessionCapTimer); sessionCapTimer = null; }
    hideWarning();
  }

  // firebase-init.js dispatches this once window.Tracka is ready.
  window.addEventListener("tracka:ready", function () {
    window.Tracka.onAuthChange(function (user) {
      if (user) startTracking(); else stopTracking();
    });
  });
})();
