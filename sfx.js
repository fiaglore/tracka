// sfx.js
//
// Short UI sound effects — a tick "ding", a soft "un-tick" pop, and a
// celebratory "good job" fanfare for unlocked achievements / cleared
// debts. Like ambient-audio.js, everything is synthesized with the Web
// Audio API, so there is no audio file to license or cache.
//
// On by default; the on/off choice is remembered per device
// (localStorage). Effects only ever fire from a user action or a render
// caused by one, but every call is wrapped in try/catch so a browser that
// refuses audio can never break the tracker.

(function () {
  "use strict";

  var PREF_KEY = "trakkaSfxV1";
  var ctx = null;

  function isEnabled() {
    try { return localStorage.getItem(PREF_KEY) !== "off"; } catch (e) { return true; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch (e) {}
  }
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume().catch(function () {});
    return ctx;
  }

  // One enveloped note: quick attack, exponential decay.
  function tone(c, dest, freq, start, dur, peak, type, slideTo) {
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur * 0.5);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  function play(fn) {
    if (!isEnabled()) return;
    try { fn(getCtx()); } catch (e) {}
  }

  // Ticking a checklist box.
  function ding() {
    play(function (c) {
      var t = c.currentTime;
      tone(c, c.destination, 880, t, 0.2, 0.16, "sine", 1320);
    });
  }

  // Un-ticking: a lower, softer falling blip so it reads as "undone".
  function pop() {
    play(function (c) {
      var t = c.currentTime;
      tone(c, c.destination, 520, t, 0.14, 0.09, "sine", 330);
    });
  }

  // "Good job!" — a bright rising arpeggio (C5 E5 G5 C6) that lands on a
  // held major chord with a little sparkle on top. `big` (several
  // achievements at once) adds an extra octave run.
  function achievement(big) {
    play(function (c) {
      var t = c.currentTime + 0.02;
      var master = c.createGain();
      master.gain.value = 0.9;
      master.connect(c.destination);
      var run = [523.25, 659.25, 783.99, 1046.5];
      if (big) run = run.concat([1318.5, 1568.0]);
      run.forEach(function (f, i) {
        tone(c, master, f, t + i * 0.085, 0.32, 0.13, "triangle");
      });
      var landing = t + run.length * 0.085 + 0.02;
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f) {
        tone(c, master, f, landing, 0.9, 0.09, "sine");
      });
      // sparkle
      [2093, 2637, 3136].forEach(function (f, i) {
        tone(c, master, f, landing + 0.05 + i * 0.07, 0.35, 0.035, "sine");
      });
    });
  }

  window.TrakkaSfx = {
    ding: ding,
    pop: pop,
    achievement: achievement,
    isEnabled: isEnabled,
    setEnabled: setEnabled
  };

  // Settings-page toggle, if this page has one.
  var btn = document.getElementById("sfx-toggle-btn");
  if (btn) {
    var refresh = function () {
      var on = isEnabled();
      btn.textContent = on ? "🔔" : "🔕";
      btn.title = on ? "Turn off sound effects" : "Turn on sound effects";
      btn.classList.toggle("active", on);
    };
    btn.addEventListener("click", function () {
      var on = !isEnabled();
      setEnabled(on);
      refresh();
      if (on) ding(); // audible confirmation, and a genuine gesture to unlock audio
    });
    refresh();
  }
})();
