// transition-banner.js
//
// Tells anyone who lands on THIS origin that Trakka has moved, and gets
// them to click through once — which is what actually runs the existing
// localStorage → Firestore migration (see app.js) on the origin where any
// unmigrated local data still lives. Without that one click-through on the
// old origin, that data is unreachable forever once this origin is retired.
//
// Deliberately inert until NEW_ORIGIN below is filled in, and self-
// contained (its own inline styles, no styles.css dependency) so removing
// the migration later is just: delete this file, its <script> tag, and its
// entry in service-worker.js's SHELL_FILES. Nothing else references it.
//
// This is NOT a same-origin check against "github.io" specifically — Trakka
// already sits on a custom domain (see CNAME), so the meaningful comparison
// is just "is this origin the NEW one or not", however either domain is
// spelled. Fill in NEW_ORIGIN once the Cloudflare project/domain exists;
// leave it blank and this file does nothing at all.
(function () {
  var NEW_ORIGIN = ""; // e.g. "https://tracka.pages.dev" or "https://app.trakka.com.ng" — no trailing slash

  if (!NEW_ORIGIN || location.origin === NEW_ORIGIN) return;

  var DISMISS_KEY = "trakkaTransitionDismissedUntil";
  var DISMISS_MS = 24 * 60 * 60 * 1000; // reappear a day later — long enough to not nag, short enough to keep surfacing until someone actually moves

  function isDismissed() {
    try {
      return Date.now() < Number(localStorage.getItem(DISMISS_KEY) || 0);
    } catch (e) {
      return false; // no localStorage (private mode, etc.) — just show it every time
    }
  }
  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_MS));
    } catch (e) {}
  }

  function render() {
    if (isDismissed() || !document.body) return;

    var style = document.createElement("style");
    style.textContent =
      "#trakka-transition-banner{position:sticky;top:0;z-index:9999;" +
      "display:flex;align-items:center;gap:12px;flex-wrap:wrap;" +
      "padding:10px 16px;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "background:#D98E2B;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.15);}" +
      "#trakka-transition-banner a{color:#fff;font-weight:700;text-decoration:underline;}" +
      "#trakka-transition-banner button{margin-left:auto;flex:0 0 auto;background:transparent;" +
      "border:1px solid rgba(255,255,255,.6);color:#fff;border-radius:6px;padding:4px 10px;" +
      "font-size:12px;cursor:pointer;}" +
      "#trakka-transition-banner button:hover{background:rgba(255,255,255,.15);}";
    document.head.appendChild(style);

    var bar = document.createElement("div");
    bar.id = "trakka-transition-banner";
    bar.setAttribute("role", "status");
    // sign-in.html/settings.html hide every direct child of <body> except
    // #auth-overlay/<script> until sign-in completes (body.ft-locked > *
    // {display:none !important} in styles.css) — the banner needs to show
    // BEFORE that, so it force-overrides with an inline !important, which
    // beats a stylesheet !important without having to touch styles.css.
    bar.style.setProperty("display", "flex", "important");
    bar.innerHTML =
      '🚚 Trakka has moved to <a href="' + NEW_ORIGIN + '">' +
      NEW_ORIGIN.replace(/^https?:\/\//, "") +
      '</a>. Sign in there once to sync your data, then continue on the new address.' +
      '<button type="button">Dismiss</button>';
    bar.querySelector("button").addEventListener("click", function () {
      dismiss();
      bar.remove();
    });

    document.body.insertBefore(bar, document.body.firstChild);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
