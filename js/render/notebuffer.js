/**
 * notebuffer.js — Fast note fall renderer using offscreen canvas.
 *
 * Strategy: pre-render ONE frame into offscreen canvas, blit to screen.
 * Faster than direct canvas because:
 *  - Offscreen canvas ops are batched by GPU
 *  - drawImage() of offscreen = single GPU texture blit
 *  - Avoids repeated fillStyle parse per note (pre-cached colors)
 *
 * For Buffer mode: wire NoteBuffer.drawFrame() instead of Notes.draw()
 * It still scans activeList but renders to offscreen first then blits.
 * For massive note counts, combine with heatmap threshold.
 */
var NoteBuffer = (function () {
  'use strict';

  var _offscreen = null;
  var _offCtx    = null;
  var _w = 0, _h = 0;

  var CH_COLORS = [
    '#FFB500','#00C8FF','#64FF64','#FF468C',
    '#FFDC00','#AA64FF','#00F0B4','#FF7850',
    '#50B4FF','#C8FF00','#FF3464','#64C8FF',
    '#FF9B00','#B464FF','#82FFC8','#FF64A0'
  ];

  var _keyCache = null, _keyCacheW = -1, _keyCacheKey = -1;

  function ensureKeyCache(camKey, keyW) {
    if (_keyCache && _keyCacheKey === camKey && _keyCacheW === keyW) return;
    _keyCache = new Array(128);
    _keyCacheKey = camKey; _keyCacheW = keyW;
    var xByNote = new Array(128), runX = 0;
    for (var i = 0; i < 128; i++) {
      xByNote[i] = runX;
      if (!Constants.isBlackKey(i % 12)) runX += keyW;
    }
    for (var n = 0; n < 128; n++) {
      var bk = Constants.isBlackKey(n % 12);
      var w  = bk ? Math.round(keyW * 0.6) : keyW;
      var x  = bk ? Math.round(xByNote[n] - w * 0.5) : xByNote[n];
      _keyCache[n] = { x: Math.round(x), w: Math.round(w), black: bk };
    }
  }

  function init(screenW, screenH) {
    _w = screenW; _h = screenH;
    _offscreen = document.createElement('canvas');
    _offscreen.width  = screenW;
    _offscreen.height = screenH - 60; // fbH
    _offCtx = _offscreen.getContext('2d');
    console.log('[NoteBuffer] init', screenW, 'x', screenH);
  }

  function isReady() { return !!_offCtx; }
  function reset() {}
  function setSpeed() {}
  function onNote() {} // not used in this design

  /**
   * draw() — renders activeList into offscreen then blits to screen.
   * Called from Notes.draw() when renderMode='buffer'.
   * Same inputs as Notes.draw() but uses offscreen canvas for speed.
   */
  function draw(ctx, screenW, screenH, state) {
    if (!_offCtx) return;

    var KB_H = 60;
    var fbBot = screenH - KB_H;
    var fbH   = fbBot;
    if (fbH < 30) return;

    var kw = state.keyWidth || 16;
    var ck = state.camKey   || 48;
    var sp = state.speed    || 1.0;
    var ns = 0;
    try { ns = Sequencer.getTime(); } catch(e) { return; }

    var trailSetting = (state.trail != null && isFinite(state.trail)) ? state.trail : 1.0;
    var effectiveLK  = 1.0 / trailSetting;
    var FALL = fbH / effectiveLK;

    ensureKeyCache(ck, kw);
    var camOffset = _keyCache[ck] ? _keyCache[ck].x : 0;

    // Resize offscreen if needed
    if (_offscreen.width !== screenW || _offscreen.height !== fbH) {
      _offscreen.width  = screenW;
      _offscreen.height = fbH;
    }

    // Clear offscreen
    _offCtx.clearRect(0, 0, screenW, fbH);

    var live = [];
    try { live = Sequencer.activeList(); } catch(e) {}
    if (!live || !live.length) return;

    // Render whites then blacks into offscreen
    var whites = [], blacks = [];
    var liveLen = live.length;

    for (var i = 0; i < liveLen; i++) {
      var a = live[i];
      var n = a.note;
      if (n < ck || n > 127) continue;

      var pos = _keyCache[n];
      if (!pos) continue;
      var nx = pos.x - camOffset;
      if (nx < -pos.w || nx > screenW + pos.w) continue;

      var ss = a.startSec != null ? a.startSec : 0;
      var es = a.endSec   != null ? a.endSec   : ss + 0.5;
      if (es < ns - 0.1) continue;
      if (ss > ns + effectiveLK) continue;

      var nyBottom = fbBot - (ss - ns) * FALL * sp;
      var nh = Math.max(2, (es - ss) * FALL * sp);
      var ny = nyBottom - nh;
      if (nyBottom < 0) continue;
      if (ny > fbBot) continue;

      var entry = { nx: nx, ny: ny, nw: pos.w, nh: nh,
                    ch: a.channel, black: pos.black };
      if (pos.black) blacks.push(entry);
      else           whites.push(entry);
    }

    var lastCh = -1;
    for (var wi = 0; wi < whites.length; wi++) {
      var e = whites[wi];
      if (e.ch !== lastCh) {
        _offCtx.fillStyle = CH_COLORS[(e.ch || 0) % 16];
        lastCh = e.ch;
      }
      _offCtx.fillRect(e.nx, e.ny, e.nw, e.nh);
    }
    lastCh = -1;
    for (var bi = 0; bi < blacks.length; bi++) {
      var e = blacks[bi];
      if (e.ch !== lastCh) {
        _offCtx.fillStyle = CH_COLORS[(e.ch || 0) % 16];
        lastCh = e.ch;
      }
      _offCtx.fillRect(e.nx + 1, e.ny, e.nw - 2, e.nh);
    }

    // Single blit to screen
    ctx.drawImage(_offscreen, 0, 0, screenW, fbH, 0, 0, screenW, fbH);
  }

  return {
    init: init, isReady: isReady, reset: reset,
    setSpeed: setSpeed, onNote: onNote, draw: draw,
    ensureKeyCache: ensureKeyCache,
  };
})();
