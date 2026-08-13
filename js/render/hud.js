/**
 * hud.js — Heads-up display overlay.
 * Caches DOM refs at init; throttles DOM writes to ~4 Hz (250ms)
 * to avoid compositor jank on KaiOS low-end hardware.
 */

var HUD = (function () {
  'use strict';

  var _totalNotes = 0;
  var _lastDOM = 0;
  var _smoothedCount = -1;
  var _DOM_INTERVAL = 250;  // ms between DOM writes

  // Cached DOM refs (queried once)
  var _domReady = false;
  var _elCount = null;
  var _elSpeed = null;
  var _elFPS   = null;
  var _elTime  = null;

  function _cacheDom() {
    if (_domReady) return;
    _elCount = document.getElementById('hud-note-count');
    _elSpeed = document.getElementById('hud-speed');
    _elFPS   = document.getElementById('hud-fps');
    _elTime  = document.getElementById('hud-time');
    _domReady = true;
  }

  function setTotal(n) { _totalNotes = n || 0; }

  /**
   * Tick — called from main render loop every frame.
   * Does light computation every call (cheap), but DOM writes
   * only when _DOM_INTERVAL ms have passed.
   *
   * @param state  Store state ref
   * @param liveCnt  Active note count (from Notes.draw)
   */
  function tick(state, liveCnt) {
    _cacheDom();

    if (typeof state === 'undefined') return;

    var raw = liveCnt ? liveCnt : 0;
    if (_smoothedCount < 0) _smoothedCount = raw;
    else _smoothedCount = Math.round(_smoothedCount * 0.65 + raw * 0.35);

    var total = state.notes && state.notes.length ? state.notes.length : 0;
    if (!_totalNotes && total) _totalNotes = total;

    var sp = (state.speed || 1.0).toFixed(1);
    var fp = (state.fps || 0);
    var tm = '--:--';

    if (typeof Sequencer !== 'undefined') {
      var sec = Sequencer.getTime();
      var min = Math.floor(sec / 60);
      var s = Math.floor(sec % 60);
      tm = (min < 10 ? '0' : '') + min + ':' + (s < 10 ? '0' : '') + s;
    }

    var now = Date.now();
    if (now - _lastDOM < _DOM_INTERVAL) return;
    _lastDOM = now;

    _set(_elCount, _smoothedCount + '/' + _totalNotes);
    _set(_elSpeed, sp + 'x');
    _set(_elFPS, fp + ' FPS');
    _set(_elTime, tm);
  }

  function _set(el, val) {
    if (el) el.textContent = val;
  }

  // Legacy: update() now delegates to tick (backward compat for notes.js)
  function update(state) {
    tick(state, undefined);
  }

  // Legacy: refreshLive() now a no-op (combined into tick)
  function refreshLive(liveCnt) {
    /* no-op — combined into tick() */
  }

  return { tick: tick, update: update, refreshLive: refreshLive, setTotal: setTotal };
})();