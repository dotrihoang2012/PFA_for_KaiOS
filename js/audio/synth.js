/**
 * synth.js — Fixed-pool Web Audio synth for KaiOS 2.5.
 * Oscillators created ONCE at boot, never stopped — only gain+freq envelopes change.
 * Zero allocation per note → zero leak, zero GC.
 *
 * IMPROVEMENTS:
 *  - LIMIT 128 → 48   (KaiOS CPU: 128 always-on oscillators = overload in dense sections)
 *  - Per-channel FAIR voice stealing (drum-heavy track can't starve melody tracks)
 *  - Per-channel WAVEFORM map (multi-track audibly distinguishable)
 *  - Volume 0.20 → 0.35 (multi-track audible)
 *  - getTime() uses ctx.currentTime when available (audio clock = synth clock)
 */
var Synth = (function () {
  console.log('[Synth] module init');
  'use strict';

  var ctx = null;
  var masterGain = null;
  var voices = [];
  var LIMIT = 48;
  var waveform = 'square';
  // OS media volume (KaiOS navigator.volumeManager) is the
  // single source of truth for loudness. We keep masterGain at 1.0 so
  // the user hears exactly what the OS slider shows, with no double dip.
  var volume = 1.0;
  var ZOMBIE_MS = 1800;
  var MAX_PER_CHANNEL = 8;

  // Per-channel waveform map — gives each MIDI track a distinct timbre
  // so multi-track is audibly distinguishable (instead of all-square blend).
  // Channel 9 (MIDI drum channel, 0-indexed) gets noise-ish "triangle".
  var CH_WAVE = [
    'square',   // ch 0 — lead
    'sawtooth', // ch 1 — bass
    'triangle', // ch 2 — pad
    'square',   // ch 3
    'sawtooth', // ch 4
    'triangle', // ch 5
    'square',   // ch 6
    'sawtooth', // ch 7
    'triangle', // ch 8
    'square',   // ch 9 — drums (0-indexed: MIDI ch 10)
    'sawtooth', // ch 10
    'triangle', // ch 11
    'square',   // ch 12
    'sawtooth', // ch 13
    'triangle', // ch 14
    'square'    // ch 15
  ];

  // ── Auto-resume on any user gesture ──
  function _autoResume() {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(function () {
        console.log('[Synth] auto-resumed OK, state=' + ctx.state);
      }).catch(function (e) {
        console.warn('[Synth] auto-resume blocked: ' + e);
      });
    }
  }
  document.addEventListener('click', _autoResume, false);
  document.addEventListener('keydown', _autoResume, false);
  document.addEventListener('touchstart', _autoResume, false);

  function _resume() {
    if (!ctx) return;
    try { ctx.resume().catch(function () {}); } catch (e) {}
  }

  function boot() {
    if (ctx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(ctx.destination);

      // Pre-create all oscillators — never stop them, only re-trigger via gain envelope
      for (var i = 0; i < LIMIT; i++) {
        var osc = ctx.createOscillator();
        osc.type = waveform;
        osc.frequency.setValueAtTime(440, 0);

        var gn = ctx.createGain();
        gn.gain.setValueAtTime(0, 0);

        osc.connect(gn);
        gn.connect(masterGain);
        osc.start(0);

        voices.push({ osc: osc, gn: gn, alive: false, born: 0, note: -1, ch: -1, vel: 0 });
      }
      console.log('[Synth] pool ' + LIMIT + ' oscillators pre-allocated, state=' + ctx.state);
      _resume();
    } catch (e) {
      console.error('[Synth] boot fail: ' + e);
      ctx = null;
    }
  }

  function init() { }
  function ensure() { if (!ctx) boot(); else _resume(); }

  // ── Voice management (no node create/destroy — ever) ──

  function freeSlot(idx) {
    var v = voices[idx];
    if (!v) return;
    var t = ctx ? ctx.currentTime : 0;
    try { v.gn.gain.cancelScheduledValues(t); v.gn.gain.setValueAtTime(0, t); } catch (e) {}
    v.alive = false;
    v.note = -1;
    v.ch = -1;
    v.vel = 0;
  }

  /** Per-channel fair allocation: prefer free, then steal from channel with most voices. */
  function findFree(channel) {
    var now = performance.now();

    // 1. Kill zombies (notes playing > ZOMBIE_MS — safety net)
    for (var i = 0; i < LIMIT; i++) {
      if (voices[i].alive && (now - voices[i].born) > ZOMBIE_MS) freeSlot(i);
    }

    // 2. First-free slot
    for (var j = 0; j < LIMIT; j++) {
      if (!voices[j].alive) return j;
    }

    // 3. Count voices per channel (for fairness)
    var chCount = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
    for (var k = 0; k < LIMIT; k++) {
      if (voices[k].alive && voices[k].ch >= 0 && voices[k].ch < 16) {
        chCount[voices[k].ch]++;
      }
    }

    // 4. If THIS channel already has MAX_PER_CHANNEL voices, steal from same channel
    //    (so a single dense track can't monopolize all 48 voices)
    if (channel >= 0 && channel < 16 && chCount[channel] >= MAX_PER_CHANNEL) {
      var oldestSame = -1, oldestBorn = Infinity;
      for (var m = 0; m < LIMIT; m++) {
        if (voices[m].alive && voices[m].ch === channel && voices[m].born < oldestBorn) {
          oldestBorn = voices[m].born;
          oldestSame = m;
        }
      }
      if (oldestSame !== -1) { freeSlot(oldestSame); return oldestSame; }
    }

    // 5. Steal from the channel with the MOST voices (fairness: spread the pain)
    var overChannel = -1, overCount = 0;
    for (var ch = 0; ch < 16; ch++) {
      if (chCount[ch] > overCount) { overCount = chCount[ch]; overChannel = ch; }
    }
    if (overChannel !== -1) {
      var oldestOver = -1, oldestOverBorn = Infinity;
      for (var n = 0; n < LIMIT; n++) {
        if (voices[n].alive && voices[n].ch === overChannel && voices[n].born < oldestOverBorn) {
          oldestOverBorn = voices[n].born;
          oldestOver = n;
        }
      }
      if (oldestOver !== -1) { freeSlot(oldestOver); return oldestOver; }
    }

    // 6. Last resort — steal oldest overall
    var idx = 0, best = Infinity;
    for (var p = 0; p < LIMIT; p++) {
      if (voices[p].born < best) { best = voices[p].born; idx = p; }
    }
    freeSlot(idx);
    return idx;
  }

  // ── Note scheduling ──

  function noteOn(note, ch, vel, delaySec, durSec) {
    if (window.Soundbank && Soundbank.isReady()) {
      Soundbank.play(note, vel, delaySec, durSec);
      return;
    }
    if (!ctx || !masterGain) return;
    if (ctx.state !== 'running') { _resume(); return; }
    if (delaySec < 0) delaySec = 0;
    if (durSec < 0.005) durSec = 0.005;
    if (vel < 1) return;

    ch = ch || 0;
    var idx = findFree(ch);
    var v = voices[idx];
    if (!v) return;

    var now = ctx.currentTime;
    var f = 440 * Math.pow(2, (note - 69) / 12);
    var g = (vel / 127) * volume;
    var tStart = now + delaySec;
    var tEnd = tStart + durSec;

    // Per-channel waveform → multi-track audible
    var wave = (ch >= 0 && ch < 16) ? CH_WAVE[ch] : waveform;
    try { if (v.osc.type !== wave) v.osc.type = wave; } catch (e) {}

    // Wipe previous scheduled curve (if this slot was just stolen)
    try { v.gn.gain.cancelScheduledValues(now); } catch (e) {}
    try { v.osc.frequency.cancelScheduledValues(now); } catch (e) {}

    // Schedule new envelope
    try {
      v.osc.frequency.setValueAtTime(f, tStart);
      v.gn.gain.setValueAtTime(0, now);
      v.gn.gain.linearRampToValueAtTime(g, tStart + 0.003);
      v.gn.gain.setValueAtTime(g, tEnd - 0.005);
      v.gn.gain.linearRampToValueAtTime(0, tEnd);
    } catch (e) {
      freeSlot(idx);
      return;
    }

    v.alive = true;
    v.note = note;
    v.ch = ch;
    v.vel = vel;
    v.born = performance.now();
  }

  function noteOff(note, ch) {
    for (var i = 0; i < LIMIT; i++) {
      if (voices[i].alive && voices[i].note === note && voices[i].ch === ch) {
        freeSlot(i);
        break;
      }
    }
  }

  // ── Housekeeping ──

  function zoo() {
    var now = performance.now();
    for (var i = 0; i < LIMIT; i++) {
      if (voices[i].alive && (now - voices[i].born) > ZOMBIE_MS) freeSlot(i);
    }
  }

  function silence() {
    for (var i = 0; i < LIMIT; i++) if (voices[i].alive) freeSlot(i);
  }

  function setWave(t) {
    waveform = t;
    // Update idle oscillators immediately (alive ones keep current waveform)
    for (var i = 0; i < LIMIT; i++) {
      try { if (!voices[i].alive) voices[i].osc.type = t; } catch (e) {}
    }
  }

  function setVolume(v) {
    // No-op: OS media volume (navigator.volumeManager) is now authoritative.
    // Master gain is pinned at 1.0; legacy callers from earlier code still
    // resolve but no longer influence loudness.
    volume = 1.0;
  }

  function getVolume() {
    return 1.0;
  }

	  function getVoiceCount() {
    var c = 0;
    for (var i = 0; i < LIMIT; i++) if (voices[i].alive) c++;
    return c;
  }

  // Use audio clock when available — keeps synth scheduling aligned with sequencer
  function getTime() {
    if (ctx && ctx.state === 'running') return ctx.currentTime;
    return performance.now() / 1000;
  }

  return {
    init: init, noteOn: noteOn, noteOff: noteOff,
    silence: silence, zoo: zoo, setWave: setWave,
    setVolume: setVolume, getVolume: getVolume, ensure: ensure, resume: ensure,
    getTime: getTime, voiceCount: getVoiceCount,
  };
})();
