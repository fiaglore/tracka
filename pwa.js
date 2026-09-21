// pwa.js
//
// Two jobs, kept separate from app.js on purpose so the tracker's own
// logic never has to know about installability:
//   1. Register the service worker (offline app shell + installability).
//   2. Show/wire the "📲 Install app" button using the browser's
//      beforeinstallprompt event (Chrome/Edge/Android). iOS/Safari has no
//      such event — there, "Add to Home Screen" only lives in the Share
//      sheet, so the button just stays hidden and that's expected.

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.warn("Tracka: service worker registration failed", err);
    });
  });
}

let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  // Stop the browser's own mini-infobar; show our own button instead so
  // install fits the app's own toolbar instead of a random browser popup.
  event.preventDefault();
  deferredInstallPrompt = event;
  const btn = document.getElementById("pwa-install-btn");
  if (btn) btn.style.display = "";
});

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("pwa-install-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    btn.disabled = true;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.style.display = "none";
    btn.disabled = false;
  });
});

// Once installed, hide the button for good (covers browsers that don't
// fire a fresh beforeinstallprompt after install).
window.addEventListener("appinstalled", () => {
  const btn = document.getElementById("pwa-install-btn");
  if (btn) btn.style.display = "none";
  deferredInstallPrompt = null;
});
