// ambient-audio.js
//
// Weather-matched ambient sound. Whatever weather effect is picked in
// Settings (rain, snow, autumn, spring, summer, thunderstorm, windy, harmattan, tropical rain, sandstorm, sunny,
// plus the achievement-unlocked aurora, rainbow, and starry night)
// gets a matching soundscape — rain hiss and drips, wind, birdsong,
// crickets, distant thunder. It replaces the old synthesized music pad.
//
// Everything is generated with the Web Audio API (filtered noise plus a few
// scheduled chirps/drips/rumbles), so there is no audio file to license and
// nothing extra for the service worker to cache. Choosing "None" for the
// weather means silence.
//
// Browsers refuse to start audio without a real user gesture, so the graph
// is only built inside a click/keydown handler. The on/off preference is
// remembered per device (localStorage); after a reload, playback resumes on
// the first interaction anywhere on the page.
//
// app.js announces the active weather via window.__trakkaWeather and a
// "trakka:weather" event (detail = effect id).

(function () {
  "use strict";

  var PREF_KEY = "trakkaAmbientAudioV1";
  var btn = document.getElementById("ambient-toggle-btn");

  var ctx = null;
  var masterGain = null;
  var noiseBuf = null;
  var started = false;
  var enabled = false;
  var weather = window.__trakkaWeather || "none";
  var scene = null; // { id, gain, nodes: [], timers: [] }

  function loadPref() {
    try { return localStorage.getItem(PREF_KEY) === "on"; } catch (e) { return false; }
  }
  function savePref(on) {
    try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch (e) {}
  }
  function updateButton() {
    if (!btn) return;
    btn.textContent = enabled ? "🌧️" : "🔇";
    btn.title = enabled
      ? "Turn off weather sounds"
      : "Turn on weather sounds (they follow the weather effect you pick)";
    btn.classList.toggle("active", enabled);
  }

  // Ten seconds of looping noise: white, plus a brown (integrated) version
  // in the second channel for low rumble/wind. Shared by every scene.
  function makeNoise(c) {
    var len = c.sampleRate * 10;
    var buf = c.createBuffer(2, len, c.sampleRate);
    var w = buf.getChannelData(0), b = buf.getChannelData(1), last = 0;
    for (var i = 0; i < len; i++) {
      var r = Math.random() * 2 - 1;
      w[i] = r;
      last = (last + 0.02 * r) / 1.02;
      b[i] = last * 3.5;
    }
    return buf;
  }
  function noiseSource(channelBrown) {
    // A mono view of one channel, so brown and white can be picked separately.
    var src = ctx.createBufferSource();
    var mono = ctx.createBuffer(1, noiseBuf.length, ctx.sampleRate);
    mono.copyToChannel(noiseBuf.getChannelData(channelBrown ? 1 : 0), 0);
    src.buffer = mono;
    src.loop = true;
    src.loopStart = Math.random() * 5; // de-correlate layers
    return src;
  }

  // ---- building blocks ------------------------------------------------
  function filtered(sceneObj, type, freq, q, brown, level) {
    var src = noiseSource(brown);
    var f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q || 0.7;
    var g = ctx.createGain();
    g.gain.value = level;
    src.connect(f).connect(g).connect(sceneObj.gain);
    src.start();
    sceneObj.nodes.push(src);
    return { filter: f, gain: g };
  }
  // Slow random drift on a param, so wind gusts and swells never loop audibly.
  function drift(sceneObj, param, base, depth, minS, maxS) {
    (function next() {
      if (!sceneObj.alive) return;
      var t = ctx.currentTime;
      var dur = minS + Math.random() * (maxS - minS);
      param.cancelScheduledValues(t);
      param.setTargetAtTime(Math.max(0.0001, base + (Math.random() * 2 - 1) * depth), t, dur / 3);
      sceneObj.timers.push(setTimeout(next, dur * 1000));
    })();
  }
  function every(sceneObj, minS, maxS, fn) {
    (function next() {
      if (!sceneObj.alive) return;
      try { fn(); } catch (e) {}
      sceneObj.timers.push(setTimeout(next, (minS + Math.random() * (maxS - minS)) * 1000));
    })();
  }
  function blip(sceneObj, f0, f1, dur, peak, type) {
    var t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(sceneObj.gain);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function bird(sceneObj) {
    var base = 2200 + Math.random() * 1800, n = 2 + Math.floor(Math.random() * 4);
    for (var i = 0; i < n; i++) {
      (function (i) {
        sceneObj.timers.push(setTimeout(function () {
          if (!sceneObj.alive) return;
          var up = Math.random() < 0.5;
          blip(sceneObj, up ? base : base * 1.4, up ? base * 1.4 : base * 0.9,
               0.07 + Math.random() * 0.06, 0.05, "sine");
        }, i * 110));
      })(i);
    }
  }
  function thunder(sceneObj) {
    var t = ctx.currentTime, src = noiseSource(true);
    var f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 220;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
    src.connect(f).connect(g).connect(sceneObj.gain);
    src.start(t); src.stop(t + 5);
  }
  function drip(sceneObj) {
    blip(sceneObj, 1400 + Math.random() * 1200, 500, 0.05, 0.03, "sine");
  }
  function chirpCricket(sceneObj, freq, level) {
    // Amplitude-modulated pulses on a high tone = cricket / cicada-ish.
    var o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
    var g = ctx.createGain(); g.gain.value = 0;
    var lfo = ctx.createOscillator(); lfo.type = "square"; lfo.frequency.value = 14 + Math.random() * 6;
    var depth = ctx.createGain(); depth.gain.value = level;
    var gate = ctx.createOscillator(); gate.type = "sine"; gate.frequency.value = 0.15 + Math.random() * 0.1;
    var gateDepth = ctx.createGain(); gateDepth.gain.value = level;
    lfo.connect(depth).connect(g.gain);
    gate.connect(gateDepth).connect(g.gain);
    var off = ctx.createConstantSource(); off.offset.value = level * 0.5;
    off.connect(g.gain);
    o.connect(g).connect(sceneObj.gain);
    [o, lfo, gate, off].forEach(function (n) { n.start(); sceneObj.nodes.push(n); });
  }

  // ---- scenes -----------------------------------------------------------
  var SCENES = {
    rain: function (s) {
      filtered(s, "highpass", 1500, 0.5, false, 0.16);
      filtered(s, "bandpass", 5200, 0.8, false, 0.10);
      var low = filtered(s, "lowpass", 400, 0.5, true, 0.10);
      drift(s, low.gain.gain, 0.10, 0.03, 4, 9);
      every(s, 0.25, 0.9, function () { drip(s); });
    },
    tropicalRain: function (s) {
      filtered(s, "highpass", 1000, 0.5, false, 0.24);
      filtered(s, "bandpass", 3800, 0.6, false, 0.14);
      var low = filtered(s, "lowpass", 500, 0.5, true, 0.16);
      drift(s, low.gain.gain, 0.16, 0.05, 3, 7);
      every(s, 0.15, 0.5, function () { drip(s); });
      every(s, 14, 34, function () { thunder(s); });
    },
    thunderstorm: function (s) {
      filtered(s, "highpass", 1200, 0.5, false, 0.22);
      filtered(s, "bandpass", 4200, 0.7, false, 0.12);
      var low = filtered(s, "lowpass", 450, 0.5, true, 0.18);
      drift(s, low.gain.gain, 0.18, 0.06, 3, 7);
      every(s, 0.2, 0.7, function () { drip(s); });
      every(s, 7, 18, function () { thunder(s); });
    },
    windy: function (s) {
      var wind = filtered(s, "bandpass", 600, 0.7, true, 0.16);
      drift(s, wind.gain.gain, 0.16, 0.12, 1.5, 4);
      var high = filtered(s, "bandpass", 1800, 1.0, false, 0.02);
      drift(s, high.gain.gain, 0.03, 0.025, 1.5, 4);
      var rustle = filtered(s, "bandpass", 4500, 1.2, false, 0.01);
      drift(s, rustle.gain.gain, 0.02, 0.018, 1, 3);
    },
    sandstorm: function (s) {
      var wind = filtered(s, "bandpass", 450, 0.6, true, 0.2);
      drift(s, wind.gain.gain, 0.2, 0.1, 2, 6);
      var grit = filtered(s, "highpass", 2500, 0.4, false, 0.07);
      drift(s, grit.gain.gain, 0.07, 0.04, 2, 5);
      var howl = filtered(s, "bandpass", 900, 4, false, 0.03);
      drift(s, howl.gain.gain, 0.03, 0.02, 3, 8);
    },
    snow: function (s) {
      var wind = filtered(s, "lowpass", 380, 0.4, true, 0.07);
      drift(s, wind.gain.gain, 0.07, 0.04, 5, 11);
      var hiss = filtered(s, "bandpass", 2600, 0.5, false, 0.008);
      drift(s, hiss.gain.gain, 0.008, 0.005, 6, 12);
    },
    autumn: function (s) {
      var wind = filtered(s, "bandpass", 500, 0.6, true, 0.13);
      drift(s, wind.gain.gain, 0.12, 0.09, 3, 8);
      var rustle = filtered(s, "bandpass", 4200, 1.2, false, 0.012);
      drift(s, rustle.gain.gain, 0.02, 0.018, 1.5, 4);
    },
    spring: function (s) {
      var breeze = filtered(s, "lowpass", 600, 0.4, true, 0.045);
      drift(s, breeze.gain.gain, 0.045, 0.025, 5, 10);
      every(s, 1.2, 4.5, function () { bird(s); });
    },
    harmattan: function (s) {
      var wind = filtered(s, "bandpass", 700, 0.5, true, 0.15);
      drift(s, wind.gain.gain, 0.15, 0.09, 4, 10);
      var dust = filtered(s, "highpass", 3000, 0.4, false, 0.02);
      drift(s, dust.gain.gain, 0.02, 0.012, 4, 9);
    },
    summer: function (s) {
      var breeze = filtered(s, "lowpass", 500, 0.4, true, 0.03);
      drift(s, breeze.gain.gain, 0.03, 0.015, 6, 12);
      chirpCricket(s, 3900, 0.005);
      chirpCricket(s, 4700, 0.004);
      every(s, 3, 8, function () { bird(s); });
    },
    sunny: function (s) {
      var breeze = filtered(s, "lowpass", 500, 0.4, true, 0.025);
      drift(s, breeze.gain.gain, 0.025, 0.015, 6, 12);
      chirpCricket(s, 4300, 0.006);
      chirpCricket(s, 5100, 0.004);
      every(s, 2, 7, function () { bird(s); });
    },
    // Achievement unlocks below. Aurora: a slow, shimmering high pad with no
    // wind or birds — just two faint oscillator layers drifting in and out
    // of phase, like the lights themselves.
    aurora: function (s) {
      var shimmer = filtered(s, "bandpass", 2600, 2.2, false, 0.018);
      drift(s, shimmer.gain.gain, 0.018, 0.014, 5, 11);
      [220, 330].forEach(function (f) {
        var o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
        var g = ctx.createGain(); g.gain.value = 0.02;
        o.connect(g).connect(s.gain);
        o.start(); s.nodes.push(o);
        drift(s, g.gain, 0.02, 0.016, 6, 13);
      });
    },
    // Rainbow: bright and airy — a light breeze plus soft bell-like chimes
    // instead of birdsong.
    rainbow: function (s) {
      var breeze = filtered(s, "lowpass", 550, 0.4, true, 0.03);
      drift(s, breeze.gain.gain, 0.03, 0.018, 5, 10);
      every(s, 1.5, 5, function () {
        blip(s, 1200 + Math.random() * 1600, 1800 + Math.random() * 1600, 0.4, 0.035, "sine");
      });
    },
    // Starry night: like summer/sunny's crickets but quieter and with no
    // birds (it's nighttime), plus a rare distant owl call.
    starryNight: function (s) {
      var breeze = filtered(s, "lowpass", 450, 0.4, true, 0.018);
      drift(s, breeze.gain.gain, 0.018, 0.01, 7, 14);
      chirpCricket(s, 4100, 0.004);
      chirpCricket(s, 4900, 0.003);
      every(s, 10, 25, function () {
        blip(s, 500, 380, 0.5, 0.025, "sine");
      });
    }
  };

  // ---- scene switching --------------------------------------------------
  function stopScene(sc) {
    if (!sc) return;
    sc.alive = false;
    sc.timers.forEach(clearTimeout);
    var t = ctx.currentTime;
    sc.gain.gain.cancelScheduledValues(t);
    sc.gain.gain.setTargetAtTime(0, t, 0.6);
    setTimeout(function () {
      sc.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} });
      try { sc.gain.disconnect(); } catch (e) {}
    }, 3500);
  }
  function startScene(id) {
    var build = SCENES[id];
    if (!build) return null;
    var sc = { id: id, alive: true, nodes: [], timers: [], gain: ctx.createGain() };
    sc.gain.gain.value = 0;
    sc.gain.connect(masterGain);
    build(sc);
    sc.gain.gain.setTargetAtTime(1, ctx.currentTime, 1.5);
    return sc;
  }
  function syncScene() {
    if (!started) return;
    if (scene && scene.id === weather) return;
    stopScene(scene);
    scene = startScene(weather);
  }

  function buildGraph() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = makeNoise(ctx);
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.55;
    masterGain.connect(ctx.destination);
    syncScene();
  }

  function turnOn() {
    enabled = true; savePref(true); updateButton();
    if (!started) { started = true; buildGraph(); }
    else {
      var up = function () { raiseMaster(); };
      if (ctx.state === "suspended") ctx.resume().catch(function () {}).then(up); else up();
    }
  }
  function turnOff() {
    enabled = false; savePref(false); updateButton();
    if (started && ctx.state === "running") {
      var t = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(t);
      masterGain.gain.setTargetAtTime(0, t, 0.4);
      setTimeout(function () {
        if (!enabled && ctx.state === "running") ctx.suspend().catch(function () {});
      }, 1500);
    }
  }
  // (re)raise the master level whenever we resume from off
  function raiseMaster() {
    var t = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setTargetAtTime(0.55, t, 0.8);
  }

  if (btn) {
    btn.addEventListener("click", function () {
      if (enabled) turnOff(); else turnOn();
    });
  }

  window.addEventListener("trakka:weather", function (e) {
    weather = (e && e.detail) || "none";
    syncScene();
  });

  document.addEventListener("visibilitychange", function () {
    if (!started) return;
    if (document.visibilityState === "hidden") {
      if (ctx.state === "running") ctx.suspend().catch(function () {});
    } else if (enabled && ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }
  });

  // Remembered "on": start on the first real gesture after load.
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
