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
  var _seq = 0;
  var _muted = false;
  // True while the app should actually be sounding (a real file or the demo
  // is playing, start countdown running, …). While false, the AudioContext
  // is SUSPENDED so KaiOS drops the status-bar play indicator — otherwise a
  // latently-booted 'content'-channel context keeps the ▶ icon lit forever
  // even when we're not playing anything. Only resume on a call the app made
  // explicitly for playback (or a first-gesture unlock while audible).
  var _audible = false;
  var LIMIT = 16;
  var waveform = 'square';
  // OS media volume (KaiOS navigator.volumeManager) is the
  // single source of truth for loudness. We keep masterGain at 1.0 so
  // the user hears exactly what the OS slider shows, with no double dip.
  var volume = 1.0;
  // Voices die on their SCHEDULED envelope end (+margin), not a flat 600ms
  // timeout — the flat cut truncates long notes mid-sustain into a "pop".
  var EXPIRE_MARGIN_MS = 250;
  var EXPIRE_CAP_MS    = 8000; // safety cap for pathological durations
  var MAX_PER_CHANNEL = 8;

  // All channels use sine — no more buzzer/harsh sound.
  // Square and sawtooth have too many harmonics, sounding like a telegraph bell.
  var CH_WAVE = [
    'sine', 'sine', 'sine', 'sine',
    'sine', 'sine', 'sine', 'sine',
    'sine', 'sine', 'sine', 'sine',
    'sine', 'sine', 'sine', 'sine'
  ];

  // ── Auto-resume on any user gesture ──
  // Only when we're actually meant to be sounding: an idle context that got
  // suspended would otherwise be woken by any stray keydown/click and the
  // status-bar play indicator would reappear with nothing playing.
  function _autoResume() {
    if (_audible && ctx && ctx.state === 'suspended') {
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
  document.addEventListener('visibilitychange', _autoResume, false);
  document.addEventListener('mozvisibilitychange', _autoResume, false);

  function _resume() {
    if (!ctx) return;
    try { ctx.resume().catch(function () {}); } catch (e) {}
  }

  function boot() {
    if (ctx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      console.log('[Synth] AudioContext impl:', AC ? AC.name || typeof AC : 'NONE');
      // KaiOS 2.5: must pass 'content' RIGHT IN the constructor (positional
      // string arg). `new AC()` then setting `mozAudioChannelType='content'`
      // afterward has NO effect (channel stays stuck on default) → audio gets
      // routed through the wrong channel → "background hum + pop" noise.
      // Passing it in the constructor routes on the correct content channel →
      // no more pop. (Verified CLEAN in testing.)
      ctx = new AC('content');
      console.log('[Synth] ctx.state=' + ctx.state + ' sampleRate=' + ctx.sampleRate + ' ch=' + (ctx.mozAudioChannelType || (ctx.destination && ctx.destination.mozAudioChannelType)));

      // KaiOS volume rocker + HUD must step the MEDIA ('content') volume —
      // the channel this AudioContext routes on. Without volumeControlChannel
      // the OS steps its DEFAULT (normal/notification) channel: the OSD still
      // slides but the content-channel gain heard by the user never changes
      // = the exact "OSD shows but volume doesn't move" bug. Bind the rocker
      // to 'content' so requestUp()/requestDown() hit what we actually hear.
      try {
        var acm = navigator.mozAudioChannelManager || navigator.audioChannelManager;
        if (acm && typeof acm.volumeControlChannel === 'string') {
          acm.volumeControlChannel = 'content';
          console.log('[Synth] volumeControlChannel=' + acm.volumeControlChannel +
            ' → rocker now steps the MEDIA (content) channel');
        } else if (acm) {
          console.warn('[Synth] volumeControlChannel is not writable on this build');
        } else {
          console.warn('[Synth] no AudioChannelManager — rocker may step the wrong channel');
        }
      } catch (e) {
        console.warn('[Synth] volumeControlChannel set fail: ' + e);
      }

      masterGain = ctx.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(ctx.destination);

      // Pre-create all oscillators — never stop them, only re-trigger via gain envelope
      for (var i = 0; i < LIMIT; i++) {
        var osc = ctx.createOscillator();
        // Pre-create as sine (CH_WAVE default): changing osc.type on a
        // RUNNING oscillator clicks — avoid ever doing it live.
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, 0);

        var gn = ctx.createGain();
        gn.gain.setValueAtTime(0, 0);

        osc.connect(gn);
        gn.connect(masterGain);
        osc.start(0);

        voices.push({ osc: osc, gn: gn, alive: false, born: 0, expires: 0, note: -1, ch: -1, vel: 0, f: 0, freeAt: 0, det: false });
      }
      console.log('[Synth] pool ' + LIMIT + ' oscillators pre-allocated, state=' + ctx.state);
      _resume();
    } catch (e) {
      console.error('[Synth] boot fail: ' + e);
      ctx = null;
    }
  }

  function init() { }
  // Boot (lazily) / resume the context — but ONLY while we're meant to be
  // sounding. Gating on _audible keeps idle key-presses (controls.js's
  // every-keydown bootstrap, menu navigation, etc.) from waking a suspended
  // AudioContext and re-lighting the OS status-bar play icon with nothing
  // playing. The autoplay-policy unlock still works: the first user gesture
  // while a demo/song is running hits ensure() → resume() inside the event.
  // Muted: never boot/resume — a muted "play" must not show the icon either.
  function ensure() {
    if (!_audible || _muted) return;
    if (!ctx) boot();
    else _resume();
  }

  // ── Voice management (no node create/destroy — ever) ──

  function freeSlot(idx) {
    var v = voices[idx];
    if (!v) return;
    var t = ctx ? ctx.currentTime : 0;
    try {
      v.gn.gain.cancelScheduledValues(t);
      // Never read `gain.value` (idl attribute = 1.0, NOT the live level) —
      // setValueAtTime'ing it would hard-step to 1.0 = click on every note
      // off. Instead decay whatever residual survives to silence smoothly.
      v.gn.gain.setTargetAtTime(0, t, 0.025);
    } catch (e) {}
    v.alive = false;
    v.note = -1;
    v.ch = -1;
    v.vel = 0;
    v.expires = 0;
    // Slot is provably clean again once the residual decay has died out (~6t).
    v.freeAt = performance.now() + 40;
  }

  /** Per-channel fair allocation: prefer free, then steal from channel with most voices. */
  function findFree(channel) {
    var now = performance.now();

    // 1. Kill expired voices (scheduled envelope fully done + margin)
    for (var i = 0; i < LIMIT; i++) {
      if (voices[i].alive && performance.now() > voices[i].expires) freeSlot(i);
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
    if (_muted) return;
    if (window.Soundbank && Soundbank.isReady()) {
      Soundbank.play(note, vel, delaySec, durSec);
      return;
    }
    if (!ctx || !masterGain) return;
    if (ctx.state !== 'running') {
      _resume();
      // Autoplay policy: before a user gesture, ctx stays suspended →
      // currentTime is frozen. The old 60ms retry loop queued up notes
      // indefinitely → on resume, the whole backlog would fire at once =
      // a "pop pop" burst. Instead: drop the audio side of the note (don't
      // queue it); later notes, once ctx is running, play normally
      // (the visual/sequencer counter keeps running independent of audio).
      return;
    }
    if (delaySec < 0) delaySec = 0;
    // Micro-notes can't be heard as notes — as 5ms blips they only ADD a
    // "pop" to the mix, so skip them in audio (they still render).
    if (durSec < 0.02) return;
    if (durSec < 0.005) durSec = 0.005;
    if (vel < 1) return;

    ch = ch || 0;
    var idx = findFree(ch);
    var v = voices[idx];
    if (!v) return;
    // Reattach a detached branch (node was never stopped — zero churn) and
    // force a frequency re-assert since the value was set long ago.
    if (v.det) {
      try { v.gn.connect(masterGain); } catch (e) {}
      v.det = false;
      v.f = 0;
    }

    var now = ctx.currentTime;
    var f = 440 * Math.pow(2, (note - 69) / 12);
    var g = (vel / 127) * volume;
    // Loudness compensation: tiny speaker can't reproduce low sines, and a
    // pure sine has only the fundamental — so bass gets +gain relative to
    // pitch, or it disappears under higher notes. ~0.35 → ~+4dB per octave
    // down, capped so we never clip the mix.
    var k = Math.pow(440 / f, 0.35);
    if (k > 2.0) k = 2.0;
    g = Math.min(g * k, 0.12);
    // The real "pop" = SUM clipping the DAC: N voices × gain > 1.0 rails
    // (proven: 12×0.09=1.08 → "pop"; single voice always clean; app pops
    //  more with more notes). Dynamic headroom: scale each new note so that
    //  the running sum stays ≤ 0.75 regardless of polyphony. Quiet pieces
    //  stay full-gain; dense ones auto-throttle instead of clipping.
    var _alive = 0;
    for (var _i = 0; _i < voices.length; _i++) if (voices[_i].alive) _alive++;
    var _cap = 0.75 / (_alive + 1);
    if (g > _cap) g = _cap;
    // Onset de-coincidence: stagger each note's attack by (3ms × arrival mod 4)
    // so few gains step inside the same 2.7ms control block. The SUM's first
    // step is what clicks, not any single voice.
    _seq = (_seq + 1) % 4;
    var _stagger = _seq * 0.003;
    var tStart = now + delaySec;
    var tEnd = tStart + durSec;

    // All channels render sine (CH_WAVE). NEVER touch oscillator.type after
// boot: reconfiguring a node that's currently running on Gecko glitches the
// whole graph (a "pop" on EVERY channel playing), even if that node itself
// is silent. The waveform setting is now just a stored meta value — it's
// never applied live.
    var wave = 'sine';

    // Split scheduling: if this voice has been fully silent >40ms (no pending
    // automation left), take the MINIMAL path — 2 events only (attack+release).
    // Otherwise (voice just released/overlapping) take the conservative path
    // with cancel + residual decay + 20ms guard, so we never step on a tail.
    // Fewer timestamped events per note = measurably fewer pops on KaiOS.
    var vNow = performance.now();
    var isClean = v.freeAt !== 0 && vNow >= v.freeAt;

    if (isClean) {
      var a0c = Math.max(tStart, now + 0.008) + _stagger;
      var a1c = a0c + Math.max(0.010, durSec * 0.20);
      var holdc = tEnd - 0.030;
      if (holdc < a1c + 0.005) holdc = a1c + 0.005;
      if (a0c <= holdc) {
        if (v.f !== f) v.osc.frequency.setValueAtTime(f, a0c);
        v.gn.gain.setTargetAtTime(g, a0c, 0.030);
        v.gn.gain.setTargetAtTime(0, holdc, 0.030);
      }
    } else {
      try {
        v.osc.frequency.cancelScheduledValues(now);
        v.gn.gain.cancelScheduledValues(now);
        // Never read `gain.value` (idl attribute = 1.0) — decay residual.
        v.gn.gain.setTargetAtTime(0, now, 0.025);
        var a0 = Math.max(tStart, now + 0.020) + _stagger;
        var a1 = a0 + Math.max(0.010, durSec * 0.20);
        var hold = tEnd - 0.030;
        if (hold < a1 + 0.005) hold = a1 + 0.005;
        if (a0 <= hold) {
          if (v.f !== f) v.osc.frequency.setValueAtTime(f, a0);
          v.gn.gain.setTargetAtTime(g, a0, 0.030);
          v.gn.gain.setTargetAtTime(0, hold, 0.030);
        }
      } catch (e) {
        freeSlot(idx);
        return;
      }
    }

    v.f = f;
    v.freeAt = 0;

    v.alive = true;
    v.note = note;
    v.ch = ch;
    v.vel = vel;
    v.born = performance.now();
    // Voice self-expires right after its scheduled envelope ends, capped so
    // a bad duration can never park a voice for ages.
    var _lifeMs = (delaySec + durSec) * 1000 + EXPIRE_MARGIN_MS;
    v.expires = v.born + Math.min(_lifeMs, EXPIRE_CAP_MS);
  }

  function noteOff(note, ch) {
    for (var i = 0; i < LIMIT; i++) {
      if (voices[i].alive && voices[i].note === note && voices[i].ch === ch) {
        freeSlot(i);
        break;
      }
    }
  }

  // ── Fresh-context transplant: rebuild the whole audio graph (ctx + pool).
  //    A long-lived ctx accumulates event garbage that makes KaiOS's backend
  //    degrade ("pop" growing with session length). Fresh ctx = fresh backend
  //    state (the console note test proved a new ctx is pop-free). ──
  function transplant() {
    silence();
    var old = ctx;
    ctx = null;
    masterGain = null;
    voices = [];
    try { if (old) old.close(); } catch (e) {}
    boot();
    console.log('[Synth] transplanted new ctx=' + (ctx ? ctx.state : 'null'));
  }

  // ── Housekeeping ──

  function zoo() {
    var now = performance.now();
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].alive && now > voices[i].expires) freeSlot(i);
      // Idle branches cost the mixer forever ("background pop" while silent). Once the
      // residual is fully gone, detach the voice from the graph — oscillator
      // keeps running (no stop/start churn), reattach on next note.
      var v = voices[i];
      if (!v.alive && !v.det && v.freeAt && now > v.freeAt + 150) {
        try { v.gn.disconnect(); } catch (e) {}
        v.det = true;
      }
    }
  }

  function silence() {
    for (var i = 0; i < LIMIT; i++) if (voices[i].alive) freeSlot(i);
  }

  // Audio On/Off toggle (Settings → Synth → Audio). Muted: not a single
  // note is scheduled (no param events at all — the "pop" source), master
  // gain pinned to 0 via direct write. Suspending the context when muted
  // also drops the KaiOS status-bar play indicator. Unmute restores
  // instantly — but only when we actually want to sound (audible).
  function mute(on) {
    _muted = !!on;
    if (_muted) {
      try { silence(); } catch (e) {}
      if (masterGain) masterGain.gain.value = 0;
      // Suspend the context so the OS status-bar play icon hides even
      // if the song is still "playing" (sequencer keeps ticking while
      // we're muted — we just skip noteOn calls via the flag).
      _suspend();
      console.log('[Synth] audio OFF');
    } else {
      if (masterGain) masterGain.gain.value = 1.0;
      // Only resume when we actually want audible output — toggling
      // audio ON while idle must not re-show the status-bar play icon.
      if (_audible) ensure();
      console.log('[Synth] audio ON');
    }
  }

  // Suspend the AudioContext so the OS drops the status-bar play icon.
  // Safe to call at any time; no-ops if already suspended / absent.
  function _suspend() {
    if (!ctx || ctx.state !== 'running') return;
    try { ctx.suspend(); } catch (e) {}
  }

  /**
   * Tell the synth whether the app should actually be producing sound.
   * Called from main.js on play/pause/stop transitions. When audible
   * becomes false, the context is suspended immediately (kill the
   * status-bar play indicator). When it becomes true, ensure() is
   * called so the context boots / resumes for upcoming notes.
   */
  function setActive(on) {
    _audible = !!on;
    if (_audible) { ensure(); }
    else { _suspend(); }
  }

  function setWave(t) {
    // Store only. Do NOT mutate oscillator.type: live type changes on Gecko
    // trigger a graph re-config that clicks every playing channel.
    waveform = t;
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

  function keepAliveState() {
    return 'removed';
  }

  return {
    init: init, noteOn: noteOn, noteOff: noteOff,
    silence: silence, zoo: zoo, setWave: setWave,
    setVolume: setVolume, getVolume: getVolume, ensure: ensure, resume: ensure,
    getTime: getTime, voiceCount: getVoiceCount,
    keepAliveState: keepAliveState, transplant: transplant, mute: mute,
    setActive: setActive,
  };
})();