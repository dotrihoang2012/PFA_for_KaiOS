/**
 * hud.js — Heads-up display overlay.
 * Caches DOM refs at init; throttles DOM writes to ~4 Hz (250ms)
 * to avoid compositor jank on KaiOS low-end hardware.
 *
 * Vertical layout (each metric on its own row):
 *   NPS:    <notes per second at the keys>
 *   NC:     <total note count of the song>
 *   Passed: <notes that have hit the band so far>
 *   Time:   <current / total>
 *   FPS:    <frames per second>
 *   Speed:  <playback speed>
 *   Polyphony: <notes currently sounding>
 *   Rendered Notes: <notes rendered in last frame>
 *   Audio Buffer: <notes in sequencer audible window>
 */

var HUD = (function () {
  'use strict';

  var _totalNotes = 0;
  var _totalSet = false;
  var _lastDOM = 0;
  var _DOM_INTERVAL = 250;

  // NPS tracking — circular buffer of activeHead snapshots
  var _npsBuf = new Float64Array(16);
  var _npsHd  = new Float64Array(16);
  var _npsIdx = 0;
  var _npsCnt = 0;

  var _domReady = false;
  var _elCount = null;      // NPS
  var _elNC = null;         // NC (total note count)
  var _elPassed = null;     // Passed (notes hit the band)
  var _elSpeed = null;      // Speed
  var _elFPS   = null;      // FPS
  var _elTime  = null;      // Time
  var _elPoly = null;       // Polyphony
  var _elRendered = null;   // Rendered Notes
  var _elAudioBuf = null;   // Audio Buffer
  var _elTick = null;       // Tick
  var _elBpm = null;        // BPM

  function _cacheDom() {
    if (_domReady) return;
    _elCount = document.getElementById('hud-note-count');
    _elNC = document.getElementById('hud-nc');
    _elPassed = document.getElementById('hud-passed');
    _elSpeed = document.getElementById('hud-speed');
    _elFPS   = document.getElementById('hud-fps');
    _elTime  = document.getElementById('hud-time');
    _elPoly     = document.getElementById('hud-polyphony');
    _elRendered = document.getElementById('hud-rendered');
    _elAudioBuf = document.getElementById('hud-audio-buffer');
    _elTick = document.getElementById('hud-tick');
    _elBpm  = document.getElementById('hud-bpm');
    _domReady = true;
  }

  function setTotal(n) {
    _totalNotes = n || 0;
    _totalSet = true;
  }

  function tick(state, liveCnt) {
    _cacheDom();
    if (typeof state === 'undefined') return;

    var sp = (state.speed || 1.0).toFixed(1);
    var fp = (state.fps || 0);
    var tm = '--:--';

    if (state.startCountdown != null) {
      var cs = Math.max(0, Math.ceil(state.startCountdown));
      tm = '-' + Math.floor(cs / 60) + ':' + (cs % 60 < 10 ? '0' : '') + (cs % 60);
    } else if (typeof Sequencer !== 'undefined') {
      var sec = Sequencer.getTime();
      var min = Math.floor(sec / 60);
      var s2 = Math.floor(sec % 60);
      tm = (min < 10 ? '0' : '') + min + ':' + (s2 < 10 ? '0' : '') + s2;
    }

    // ── Tick / BPM via Sequencer ──
    var tickVal = 0;
    var bpmVal = 0;
    if (typeof Sequencer !== 'undefined') {
      try { tickVal = Sequencer.getTick ? Sequencer.getTick() : 0; } catch (e) {}
      try { bpmVal = Sequencer.bpm ? Sequencer.bpm() : 0; } catch (e) {}
    }

    var now = Date.now();
    if (now - _lastDOM < _DOM_INTERVAL) return;
    _lastDOM = now;

    // Show the zeroed/demo readout while the bundled demo is playing AND after
    // it finishes but no real .mid/.note is loaded yet (isPlaybackLocked stays
    // true until a real file loads) — otherwise the demo's leftover
    // passed/count/time would linger on screen.
    var demo = ((typeof window.isDemoActive === 'function') && window.isDemoActive())
            || ((typeof window.isPlaybackLocked === 'function') && window.isPlaybackLocked());
    if (demo) {
      _set(_elCount,     'NPS: 0');
      _set(_elNC,        'NC: 0');
      _set(_elPassed,    'Passed: 0');
      _set(_elSpeed,     'Speed: 1.0x');
      _set(_elFPS,       'FPS: ' + fp);
      _set(_elTime,      'Time: 00:00');
      _set(_elPoly,      'Polyphony: 0');
      _set(_elRendered,  'Rendered Notes: 0');
      _set(_elAudioBuf,  'Audio Buffer: 0');
      _set(_elTick,      'Tick: 0');
      _set(_elBpm,       'BPM: 0');
      return;
    }

    // ── Passed / NPS via Sequencer.passed() (cumulative hit-count counter) ──
    var passed = 0;
    if (typeof Sequencer !== 'undefined' && typeof Sequencer.passed === 'function') {
      try { passed = Sequencer.passed(); } catch (e) {}
    }

    // ── NC — total note count ──
    var nc = _totalNotes;
    if (!nc && state.notes && state.notes.length) nc = state.notes.length;

    // ── NPS — peak rate of passed-count growth in a 2s rolling window ──
    var NPS_WINDOW = 2000;
    _npsBuf[_npsIdx] = now;
    _npsHd[_npsIdx] = passed;
    _npsIdx = (_npsIdx + 1) % 16;
    if (_npsCnt < 16) _npsCnt++;

    var nps = 0;
    if (_npsCnt >= 2) {
      var bestRate = 0;
      var last = (_npsIdx - 1 + 16) % 16; // most recent written sample
      for (var i = 1; i < _npsCnt; i++) {
        var prev = (_npsIdx - 1 - i + 16) % 16;
        var dt = _npsBuf[last] - _npsBuf[prev];
        if (dt <= 0 || dt > NPS_WINDOW) break;
        var dh = _npsHd[last] - _npsHd[prev];
        if (dh > 0) {
          var rate = dh / dt * 1000;
          if (rate > bestRate) bestRate = rate;
        }
      }
      nps = Math.round(bestRate);
    }

    // ── Polyphony — notes actually sounding (true voice count) ──
    var poly = 0;
    try {
      if (typeof window._engine === 'function') {
        var eng = window._engine();
        if (eng && typeof eng.voiceCount === 'function') poly = eng.voiceCount();
      }
    } catch (e) {}
    if (!poly && typeof Sequencer !== 'undefined' && typeof Sequencer.audioList === 'function') {
      // Fallback: notes in the audible window if no engine exposes a count.
      try {
        var al = Sequencer.audioList();
        if (al && al.length) poly = al.length;
      } catch (e) {}
    }

    // ── Rendered Notes — notes in the on-screen window ──
    var rendered = 0;
    if (typeof Sequencer !== 'undefined' && typeof Sequencer.activeList === 'function') {
      try {
        var al2 = Sequencer.activeList();
        if (al2) rendered = al2.length;
      } catch (e) {}
    }

    // ── Audio Buffer — notes currently in the sequencer's audible window ──
    // (notes scheduled/forward that the sequencer is tracking for audio), not
    // the whole remaining track. This stays correct when seeking backwards.
    var abuf = 0;
    if (typeof Sequencer !== 'undefined' && typeof Sequencer.audioList === 'function') {
      try {
        var aBuf = Sequencer.audioList();
        if (aBuf) abuf = aBuf.length;
      } catch (e) {}
    }

    // ── Vertical layout: one metric per row ──
    _set(_elCount,     'NPS: ' + _fmt(nps));
    _set(_elNC,        'NC: ' + _fmt(nc));
    _set(_elPassed,    'Passed: ' + _fmt(passed));
    _set(_elSpeed,     'Speed: ' + sp + 'x');
    _set(_elFPS,       'FPS: ' + fp);
    _set(_elTime,      'Time: ' + tm);
    _set(_elPoly,      'Polyphony: ' + _fmt(poly));
    _set(_elRendered,  'Rendered Notes: ' + _fmt(rendered));
    _set(_elAudioBuf,  'Audio Buffer: ' + _fmt(abuf));
    _set(_elTick,      'Tick: ' + _fmt(tickVal));
    _set(_elBpm,       'BPM: ' + Math.round(bpmVal));
  }

  function _fmt(n) {
    if (n >= 1000) {
      var s = String(Math.floor(n));
      var out = '';
      var cnt = 0;
      for (var i = s.length - 1; i >= 0; i--) {
        out = s[i] + out;
        cnt++;
        if (cnt % 3 === 0 && i > 0) out = '.' + out;
      }
      return out;
    }
    return String(n);
  }

  function _set(el, val) {
    if (el) el.textContent = val;
  }

  function update(state) { tick(state, undefined); }
  function refreshLive() {}

  // ── SEEK OSD ──
  var _osdTimer = null;

  function showOsd(text, holdMs) {
    var hud = document.getElementById('hud');
    var osd = document.getElementById('hud-osd');
    if (!hud || !osd) return;
    osd.textContent = text;
    hud.classList.add('osd-active');
    clearTimeout(_osdTimer);
    _osdTimer = setTimeout(hideOsd, holdMs || 2000);
  }

  function hideOsd() {
    if (_osdTimer) { clearTimeout(_osdTimer); _osdTimer = null; }
    var hud = document.getElementById('hud');
    if (hud) hud.classList.remove('osd-active');
  }

  return {
    tick: tick, update: update, refreshLive: refreshLive,
    setTotal: setTotal, showOsd: showOsd, hideOsd: hideOsd
  };
})();
