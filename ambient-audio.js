// ambient-audio.js
//
// Soft ambient background pad, entirely synthesized with the Web Audio
// API — no audio file to license or to add to the service worker's cache
// list. A handful of oscillators tuned to an open, spread chord (C3/G3/
// E4/B4), each slowly swelling on its own independent LFO with a touch of
// detune drift, run through a gentle lowpass filter and a short
// algorithmic reverb (a ConvolverNode fed a generated noise-decay
// impulse, not a sample) so it has some space without sounding harsh.
// Kept deliberately quiet — this sits under the tracker, it isn't meant
// to be listened to on its own.
//
// Browsers refuse to start audio without a real user gesture, so the
// graph is only ever built inside a genuine click/keydown handler, never
// on page load. The on/off preference is remembered per device
// (localStorage, same pattern app.js's theme-mode toggle already uses)
// so the button reflects it across reloads, but actual playback still
// waits for the next real interaction anywhere on the page — a reload
// is not itself a gesture the browser will accept, and forcing the user
// to specifically find and re-click this exact button after every
// reload would be a worse experience than just resuming on whatever
// they touch first.

(function () {
  "use strict";

  var PREF_KEY = "trakkaAmbientAudioV1";
  var btn = document.getElementById("ambient-toggle-btn");
  if (!btn) return;

  var ctx = null;
  var masterGain = null;
  var started = false; // the audio graph has been built and is running
  var enabled = false; // the user's current on/off intent

  function loadPref() {
    try { return localStorage.getItem(PREF_KEY) === "on"; } catch (e) { return false; }
  }
  function savePref(on) {
    try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch (e) {}
  }
  function updateButton() {
    btn.textContent = enabled ? "🎵" : "🔇";
    btn.title = enabled ? "Turn off soft background music" : "Turn on soft background music";
    btn.classList.toggle("active", enabled);
  }

  // A couple of seconds of exponentially-decaying noise, used as the
  // impulse response for a cheap algorithmic reverb.
  function makeReverbImpulse(audioCtx) {
    var duration = 2.2, rate = audioCtx.sampleRate;
    var length = Math.floor(rate * duration);
    var impulse = audioCtx.createBuffer(2, length, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = impulse.getChannelData(ch);
      for (var i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
      }
    }
    return impulse;
  }

  function buildGraph() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = ctx.createGain();
    masterGain.gain.value = 0; // fades in below, never starts abruptly

    var filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1100;
    filter.Q.value = 0.3;

    var reverb = ctx.createConvolver();
    reverb.buffer = makeReverbImpulse(ctx);
    var reverbGain = ctx.createGain();
    reverbGain.gain.value = 0.35;
    var dryGain = ctx.createGain();
    dryGain.gain.value = 0.75;

    filter.connect(dryGain).connect(masterGain);
    filter.connect(reverb).connect(reverbGain).connect(masterGain);
    masterGain.connect(ctx.destination);

    // Each note's own gain is what actually keeps this "soft" — the
    // master fade below is just an on/off ramp, not a volume control.
    var notes = [
      { freq: 130.81, type: "sine",     gain: 0.09, period: 11 }, // C3
      { freq: 196.00, type: "sine",     gain: 0.07, period: 14 }, // G3
      { freq: 329.63, type: "triangle", gain: 0.05, period: 9 },  // E4
      { freq: 493.88, type: "sine",     gain: 0.04, period: 17 }  // B4
    ];
    notes.forEach(function (n) {
      var osc = ctx.createOscillator();
      osc.type = n.type;
      osc.frequency.value = n.freq;

      // A few cents of slow, continuous detune drift, so a pure sine
      // pad doesn't sound like a dead, static test tone.
      var detuneLfo = ctx.createOscillator();
      detuneLfo.frequency.value = 0.05 + Math.random() * 0.05;
      var detuneDepth = ctx.createGain();
      detuneDepth.gain.value = 4;
      detuneLfo.connect(detuneDepth).connect(osc.detune);

      // Slow swell instead of a flat drone — offset + LFO summed onto
      // the note's own gain so it breathes between roughly half and
      // full of its target level over each note's own period.
      var noteGain = ctx.createGain();
      noteGain.gain.value = 0;
      var swellLfo = ctx.createOscillator();
      swellLfo.frequency.value = 1 / n.period;
      var swellDepth = ctx.createGain();
      swellDepth.gain.value = n.gain * 0.5;
      var swellOffset = ctx.createConstantSource();
      swellOffset.offset.value = n.gain * 0.5;
      swellLfo.connect(swellDepth).connect(noteGain.gain);
      swellOffset.connect(noteGain.gain);

      osc.connect(noteGain).connect(filter);

      osc.start(); detuneLfo.start(); swellLfo.start(); swellOffset.start();
    });

    masterGain.gain.setTargetAtTime(1, ctx.currentTime, 3);
  }

  function fadeOutAndSuspend() {
    if (!ctx || !masterGain) return;
    var now = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(0, now, 1.2);
    setTimeout(function () {
      if (ctx && ctx.state === "running") ctx.suspend().catch(function () {});
    }, 1800);
  }
  function fadeInAndResume() {
    if (!ctx || !masterGain) return;
    var resumed = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
    resumed.catch(function () {}).then(function () {
      var now = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setTargetAtTime(1, now, 3);
    });
  }

  function turnOn() {
    enabled = true;
    savePref(true);
    updateButton();
    if (!started) { started = true; buildGraph(); }
    else fadeInAndResume();
  }
  function turnOff() {
    enabled = false;
    savePref(false);
    updateButton();
    if (started) fadeOutAndSuspend();
  }

  btn.addEventListener("click", function () {
    if (enabled) turnOff(); else turnOn();
  });

  // Pause while the tab is hidden (no point spending CPU/battery on a
  // background tab) and resume the fade-in when it's visible again, but
  // only if the user still wants it on.
  document.addEventListener("visibilitychange", function () {
    if (!started) return;
    if (document.visibilityState === "hidden") {
      if (ctx && ctx.state === "running") ctx.suspend().catch(function () {});
    } else if (enabled && ctx && ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }
  });

  // Reflect a remembered "on" preference immediately, but actual
  // playback on THIS page load still needs a real gesture — see the
  // header comment above. Any genuine pointerdown/keydown anywhere on
  // the page (capturing phase, so it fires before the target's own
  // handlers) quietly starts it once.
  enabled = loadPref();
  updateButton();
  if (enabled) {
    var resumeOnce = function () {
      document.removeEventListener("pointerdown", resumeOnce, true);
      document.removeEventListener("keydown", resumeOnce, true);
      if (enabled && !started) { started = true; buildGraph(); }
    };
    document.addEventListener("pointerdown", resumeOnce, true);
    document.addEventListener("keydown", resumeOnce, true);
  }
})();
