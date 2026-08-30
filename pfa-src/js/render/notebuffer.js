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

    // Band bottom follows the Piano Size strip height ('none' → full canvas)
    var KB_H = (typeof Keyboard !== 'undefined' && Keyboard.height)
      ? Keyboard.height(state) : 60;
    var fbBot = screenH - KB_H;
    var fbH   = fbBot;
    if (fbH < 30) return;

    var kw = state.keyWidth || 16;
    try { if (typeof window.demoVisualValue === 'function') kw = window.demoVisualValue('keyWidth', kw); } catch (e) {}
    // Visible window — Keyboard Range [kbStart..kbEnd] replaces camKey
    var ck = (state.kbStart != null) ? state.kbStart : 21;
    var ckEnd = (state.kbEnd != null) ? state.kbEnd : 108;
    try { if (typeof window.demoVisualValue === 'function') {
      ck = window.demoVisualValue('kbStart', ck);
      ckEnd = window.demoVisualValue('kbEnd', ckEnd);
    } } catch (e) {}
    ck    = Math.max(0, Math.min(127, ck));
    ckEnd = Math.max(ck + 1, Math.min(127, ckEnd));
    var sp = state.speed    || 1.0;
    try { if (typeof window.demoVisualValue === 'function') sp = window.demoVisualValue('speed', sp); } catch (e) {}
    var ns = 0;
    try { ns = Sequencer.getTime(); } catch(e) { return; }

    var trailSetting = (state.trail != null && isFinite(state.trail)) ? state.trail : 0.7;
    try { if (typeof window.demoVisualValue === 'function') trailSetting = window.demoVisualValue('trail', trailSetting); } catch (e) {}
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

    // Render whites then blacks into offscreen.
    // Colors come from the shared Notes palette so Options →
    // Note Color Palette Randomise applies here too.
    var whites = [], blacks = [];
    var liveLen = live.length;

    for (var i = 0; i < liveLen; i++) {
      var a = live[i];
      var n = a.note;
      // Only notes inside the visible Keyboard Range are drawn
      if (n < ck || n > ckEnd) continue;

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
        _offCtx.fillStyle = (typeof Notes !== 'undefined' && Notes.channelColor)
          ? Notes.channelColor(e.ch) : '#CCCCCC';
        lastCh = e.ch;
      }
      _offCtx.fillRect(e.nx, e.ny, e.nw, e.nh);
    }
    lastCh = -1;
    for (var bi = 0; bi < blacks.length; bi++) {
      var e2 = blacks[bi];
      if (e2.ch !== lastCh) {
        _offCtx.fillStyle = (typeof Notes !== 'undefined' && Notes.channelColor)
          ? Notes.channelColor(e2.ch) : '#CCCCCC';
        lastCh = e2.ch;
      }
      _offCtx.fillRect(e2.nx + 1, e2.ny, e2.nw - 2, e2.nh);
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
