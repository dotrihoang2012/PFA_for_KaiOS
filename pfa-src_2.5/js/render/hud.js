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
  var _DOM_INTERVAL = 1; // ~every frame (throttle effectively off)

  // NPS tracking — circular buffer of passed-count snapshots. Sized so the
  // buffer holds >1s of history at per-frame cadence (16–66ms/frame).
  var _NPS_N = 96;
  var _npsBuf = new Float64Array(_NPS_N);
  var _npsHd  = new Float64Array(_NPS_N);
  var _npsIdx = 0;
  var _npsCnt = 0;

  // Cached label prefixes — avoids 11 navigator.mozL10n.get() dictionary
  // lookups per tick. Rebuilt only when the active language changes.
  var _lbl = null, _lblLang = null;
  function _labels() {
    var lang = (typeof L10n !== 'undefined' && L10n.getLang) ? L10n.getLang() : 'en';
    if (_lbl && _lblLang === lang) return _lbl;
    _lblLang = lang;
    _lbl = {
      nps:       L10n.t('hud_nps', 'NPS: '),
      nc:        L10n.t('hud_nc', 'NC: '),
      passed:    L10n.t('hud_passed', 'Passed: '),
      speed:     L10n.t('hud_speed', 'Speed: '),
      fps:       L10n.t('hud_fps', 'FPS: '),
      time:      L10n.t('hud_time', 'Time: '),
      poly:      L10n.t('hud_polyphony', 'Polyphony: '),
      rendered:  L10n.t('hud_rendered', 'Rendered Notes: '),
      audioBuf:  L10n.t('hud_audio_buffer', 'Audio Buffer: '),
      tick:      L10n.t('hud_tick', 'Tick: '),
      bpm:       L10n.t('hud_bpm', 'BPM: ')
    };
    return _lbl;
  }

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

    // Throttle FIRST: everything below (Sequencer reads, L10n lookups, DOM
    // writes) runs only ~10×/s. Previously the Sequencer getTime/getTick/bpm
    // calls ran on EVERY frame and were discarded ~3 out of 4 times.
    var now = Date.now();
    if (now - _lastDOM < _DOM_INTERVAL) return;
    _lastDOM = now;

    var sp = (state.speed || 1.0).toFixed(1);
    var fp = (state.fps || 0);
    var tm = '--:--';

    if (state.startCountdown != null) {
      var cs = Math.max(0, Math.ceil(state.startCountdown));
      tm = '-' + cs;
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

    // Show the zeroed/demo readout while the bundled demo is playing AND after
    // it finishes but no real .mid/.note is loaded yet (isPlaybackLocked stays
    // true until a real file loads) — otherwise the demo's leftover
    // passed/count/time would linger on screen.
    var demo = ((typeof window.isDemoActive === 'function') && window.isDemoActive())
            || ((typeof window.isPlaybackLocked === 'function') && window.isPlaybackLocked());
    if (demo) {
      var L0 = _labels();
      _set(_elCount,     L0.nps + '0');
      _set(_elNC,        L0.nc + '0');
      _set(_elPassed,    L0.passed + '0');
      _set(_elSpeed,     L0.speed + '1.0x');
      _set(_elFPS,       L0.fps + fp);
      _set(_elTime,      L0.time + '00:00');
      _set(_elPoly,      L0.poly + '0');
      _set(_elRendered,  L0.rendered + '0');
      _set(_elAudioBuf,  L0.audioBuf + '0');
      _set(_elTick,      L0.tick + '0');
      _set(_elBpm,       L0.bpm + '0');
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

    // ── NPS — notes passed per second, averaged over a rolling ~1s window ──
    // Was: peak rate over the SHORTEST sampled interval, which spiked wildly
    // (4 notes in 50ms read as 80 NPS). A rolling average is intuitive.
    var NPS_WINDOW = 1000;
    _npsBuf[_npsIdx] = now;
    _npsHd[_npsIdx] = passed;
    _npsIdx = (_npsIdx + 1) % _NPS_N;
    if (_npsCnt < _NPS_N) _npsCnt++;

    var nps = 0;
    if (_npsCnt >= 2) {
      var last = (_npsIdx - 1 + _NPS_N) % _NPS_N;
      var base = last; // oldest sample still inside the window
      for (var i = 1; i < _npsCnt; i++) {
        var prev = (_npsIdx - 1 - i + _NPS_N) % _NPS_N;
        if (_npsBuf[last] - _npsBuf[prev] > NPS_WINDOW) break;
        base = prev;
      }
      var span = _npsBuf[last] - _npsBuf[base];
      if (span >= 500) { // need ~0.5s of history for a stable rate
        var dh = _npsHd[last] - _npsHd[base];
        if (dh > 0) nps = Math.round(dh / span * 1000);
      }
    }

    // ── Polyphony — notes actually sounding (true voice count) ──
    var poly = 0;
    try {
      if (typeof window._engine === 'function') {
        var eng = window._engine();
        if (eng && typeof eng.voiceCount === 'function') poly = eng.voiceCount();
      }
    } catch (e) {}

    // Single audioList() fetch (was called twice) — reused for the polyphony
    // fallback and the Audio Buffer readout.
    var abuf = 0;
    if (typeof Sequencer !== 'undefined' && typeof Sequencer.audioList === 'function') {
      try {
        var aBuf = Sequencer.audioList();
        if (aBuf) abuf = aBuf.length;
      } catch (e) {}
    }
    if (!poly) poly = abuf;

    // ── Rendered Notes — notes in the on-screen window ──
    var rendered = 0;
    if (typeof Sequencer !== 'undefined' && typeof Sequencer.activeList === 'function') {
      try {
        var al2 = Sequencer.activeList();
        if (al2) rendered = al2.length;
      } catch (e) {}
    }

    // ── Vertical layout: one metric per row ──
    var L = _labels();
    _set(_elCount,     L.nps + _fmt(nps));
    _set(_elNC,        L.nc + _fmt(nc));
    _set(_elPassed,    L.passed + _fmt(passed));
    _set(_elSpeed,     L.speed + sp + 'x');
    _set(_elFPS,       L.fps + fp);
    _set(_elTime,      L.time + tm);
    _set(_elPoly,      L.poly + _fmt(poly));
    _set(_elRendered,  L.rendered + _fmt(rendered));
    _set(_elAudioBuf,  L.audioBuf + _fmt(abuf));
    _set(_elTick,      L.tick + _fmt(tickVal));
    _set(_elBpm,       L.bpm + Math.round(bpmVal));
  }

  function _fmt(n) {
    n = Math.round(n) || 0; // integers only — never print raw float ticks
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
    // Skip the DOM write when the text is unchanged — most rows (NC, Speed,
    // BPM, …) are static between ticks; only write what actually moved.
    if (el && el._hudVal !== val) {
      el._hudVal = val;
      el.textContent = val;
    }
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
