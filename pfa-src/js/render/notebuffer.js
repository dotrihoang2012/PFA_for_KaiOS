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
 */
var NoteBuffer = (function () {
  'use strict';

  var _offscreen = null;
  var _offCtx    = null;
  var _w = 0, _h = 0;

  var _keyCache = null, _keyCacheW = -1, _keyCacheKey = -1;

  // 3D note-fall (mirrors notes.js): STOP = unlit head barrier above the
  // bar (5px stroke covers ±2.5px, so 6 leaves a clear ~3.5px gap),
  // LIP = black-note tongue onto the bar. SLACK = extra offscreen
  // rows so the lip's 2px over-poke past fbBot survives the blit.
  var NB_STOP = 6;
  var NB_LIP = 2;
  var NB_SLACK = 6;
  try { window._pfaNb = 'nb-flat-14'; } catch (eV) {}

  // Bucket-union tables: 128 keys x 16 channels per side, buckets reused
  // across frames (touched-list reset) = zero per-note allocs. Frame paint
  // state below is set per draw() and read by nbPaintRun/nbLip (module fns,
  // so no closures are created per frame either).
  var _bkW = new Array(2048), _bkB = new Array(2048);
  var _touchedW = [], _touchedB = [];
  var _touchedWN = 0, _touchedBN = 0;
  var _nbRgb = null, _nbGradMap = null;
  var _nbFlatTbl = new Array(16);
  var _nbFp = null, _nbKw = -1;
  var _nbUseFade = false, _nbFadeQ = 1, _nbFadeQi = 1000, _nbStop = 0;

  // Paint one merged run (same gradient/flat rules as the old per-note path;
  // gradients cached per frame — x/width are fixed per key column).
  function nbPaintRun(b) {
    var h = b.bot - b.top;
    if (h < 1) return;
    var rgb = _nbRgb[b.ch % 16] || { r: 204, g: 204, b: 204 };
    if (_nbUseFade) {
      var gkey = b.ch + ':' + b.nx + ':' + b.nw + ':' + _nbFadeQi;
      var grad = _nbGradMap[gkey];
      if (!grad) {
        grad = _offCtx.createLinearGradient(b.nx, 0, b.nx + b.nw, 0);
        grad.addColorStop(0, 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')');
        grad.addColorStop(1, 'rgb(' + Math.round(rgb.r * _nbFadeQ) + ',' +
          Math.round(rgb.g * _nbFadeQ) + ',' + Math.round(rgb.b * _nbFadeQ) + ')');
        _nbGradMap[gkey] = grad;
      }
      _offCtx.fillStyle = grad;
    } else {
      // 3D off ('keyboard'/'none'): flat solid channel color, no fade.
      _offCtx.fillStyle = _nbFlatTbl[b.ch % 16] || 'rgb(204,204,204)';
    }
    _offCtx.fillRect(b.nx, b.top, b.nw, h);
  }

  // Centered tongue of an arrived unlit black head onto the bar.
  function nbLip(b) {
    var lipW = Math.max(2, Math.floor(b.nw * 0.5));
    var lipX = b.nx + Math.floor((b.nw - lipW) / 2);
    _offCtx.fillRect(lipX, _nbStop, lipW, NB_STOP + NB_LIP);
  }

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
   * Per-frame RGB table rebuilt from the shared Notes palette.
   * Needed for the left→right darkening fade (see draw()). 16 hex
   * parses per frame is negligible; palette changes just take effect
   * on the next frame automatically.
   */
  function _nbRgbTable() {
    var tbl = [];
    for (var i = 0; i < 16; i++) {
      var hex = (typeof Notes !== 'undefined' && Notes.channelColor)
        ? Notes.channelColor(i) : '#CCCCCC';
      var h = hex.charAt(0) === '#' ? hex.substring(1) : hex;
      tbl[i] = {
        r: parseInt(h.substring(0, 2), 16),
        g: parseInt(h.substring(2, 4), 16),
        b: parseInt(h.substring(4, 6), 16)
      };
    }
    return tbl;
  }

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
    // Visible window — Keyboard Range [kbStart..kbEnd] replaces camKey.
    // kbSize 'dynamic' auto-expands past 88 keys for out-of-range notes.
    var _nbdr = (typeof Notes !== 'undefined' && Notes.dynRange)
      ? Notes.dynRange(state) : { start: null, end: null };
    var ck = (_nbdr.start != null) ? _nbdr.start
      : ((state.kbStart != null) ? state.kbStart : 21);
    var ckEnd = (_nbdr.end != null) ? _nbdr.end
      : ((state.kbEnd != null) ? state.kbEnd : 108);
    try { if (typeof window.demoVisualValue === 'function') {
      ck = window.demoVisualValue('kbStart', ck);
      ckEnd = window.demoVisualValue('kbEnd', ckEnd);
    } } catch (e) {}
    ck    = Math.max(0, Math.min(127, ck));
    ckEnd = Math.max(ck + 1, Math.min(127, ckEnd));
    var ns = 0;
    try { ns = Sequencer.getTime(); } catch(e) { return; }

    var trailSetting = (state.trail != null && isFinite(state.trail)) ? state.trail : 0.7;
    try { if (typeof window.demoVisualValue === 'function') trailSetting = window.demoVisualValue('trail', trailSetting); } catch (e) {}
    var effectiveLK  = 1.0 / trailSetting;
    var FALL = fbH / effectiveLK;

    ensureKeyCache(ck, kw);
    var camOffset = _keyCache[ck] ? _keyCache[ck].x : 0;

    // 3D fall gate — Graphics → 3D View 'notefall' or 'both'.
    var nbV3d = (state.view3d != null) ? state.view3d : 'both';
    try { if (typeof window.demoVisualValue === 'function') nbV3d = window.demoVisualValue('view3d', nbV3d); } catch (e) {}
    var nbFall3d = (nbV3d === 'notefall' || nbV3d === 'both');
    var nbStop = fbBot - NB_STOP; // unlit head barrier

    // Resize offscreen if needed (SLACK rows hold the lip over-poke).
    if (_offscreen.width !== screenW || _offscreen.height !== fbH + NB_SLACK) {
      _offscreen.width  = screenW;
      _offscreen.height = fbH + NB_SLACK;
    }

    // Clear offscreen
    _offCtx.clearRect(0, 0, screenW, fbH + NB_SLACK);

    var live = [];
    try { live = Sequencer.activeList(); } catch(e) {}
    if (!live || !live.length) return;

    // Bucket-union feed: one bucket per (key, channel) per color side, reused
    // across frames. Same-column notes merge into vertical runs (GAP absorbs
    // sub-pixel cracks) — a 46k wall becomes ~1k fillRects, zero entry objects.
    // Colors come from the shared Notes palette so Options →
    // Note Color Palette Randomise applies here too.
    var liveLen = live.length;

    // Frame paint state (module vars feed nbPaintRun/nbLip).
    // Persistent palette/gradient cache: rebuild only when the palette
    // actually changes (fingerprint all 16 channels — exact, ~1µs/frame).
    // Saves ~16 hex parses + hundreds of gradient creations per frame.
    var _fp = null, _fpSame = false;
    try {
      if (typeof Notes !== 'undefined' && Notes.channelColor) {
        _fp = [];
        for (var _fi2 = 0; _fi2 < 16; _fi2++) _fp.push(Notes.channelColor(_fi2));
        _fpSame = !!(_fp && _nbFp);
        if (_fpSame) {
          for (var _fi3 = 0; _fi3 < 16; _fi3++) {
            if (_fp[_fi3] !== _nbFp[_fi3]) { _fpSame = false; break; }
          }
        }
      }
    } catch (eFP) { _fpSame = false; }
    if (!_fpSame) {
      _nbRgb = _nbRgbTable();
      _nbGradMap = {};
      _nbFp = _fp;
    }
    // Key columns moved (zoom/refit) — old gradients never hit again.
    if (_nbKw !== kw) { _nbGradMap = {}; _nbKw = kw; }
    // Flat-color table (built every frame, ~2µs): the else-branch below
    // looks these up instead of concatenating per run.
    for (var _fi4 = 0; _fi4 < 16; _fi4++) {
      var _frgb = (_nbRgb && _nbRgb[_fi4]) || null;
      _nbFlatTbl[_fi4] = _frgb ? ('rgb(' + _frgb.r + ',' + _frgb.g + ',' + _frgb.b + ')') : 'rgb(204,204,204)';
    }
    var _fadeAmt = (typeof Notes !== 'undefined' && Notes.fallFade)
      ? Notes.fallFade(state, nbFall3d) : 1;
    _nbFadeQ = (typeof Notes !== 'undefined' && Notes.fadeShade)
      ? Notes.fadeShade(_fadeAmt) : 1;
    _nbUseFade = nbFall3d && _fadeAmt > 0;
    _nbFadeQi = Math.round(_nbFadeQ * 1000);
    _nbStop = nbStop;
    // Clear last frame's buckets (flush walks only this frame's touched).
    var _ti;
    for (_ti = 0; _ti < _touchedWN; _ti++) _bkW[_touchedW[_ti]].has = false;
    for (_ti = 0; _ti < _touchedBN; _ti++) _bkB[_touchedB[_ti]].has = false;
    _touchedWN = 0; _touchedBN = 0;
    var _doLip = liveLen < 8000;   // decorative tongues only when sparse
    var _GAP = 1;

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
      // live[] is time-ordered, so everything past the window fails too.
      if (ss > ns + effectiveLK) break;

      var nyBottom = fbBot - (ss - ns) * FALL;
      // Buffer-native minimum dash: at high fall speeds sub-5ms notes would
      // render as 2px hairlines (the "striped lines" look). Floor them to
      // 5ms of fall so every note reads as a bar. Low trails are untouched
      // (0.005*FALL <= 2 there, so the floor stays exactly 2px).
      // Integer snap: fractional rects force edge antialiasing on the
      // software canvas (several × slower per fillRect). Every note is
      // still drawn — only edges land on whole pixels.
      var nh = Math.max(2, Math.round(0.005 * FALL), Math.round((es - ss) * FALL));
      var ny = Math.round(nyBottom) - nh;
      if (nyBottom < 0) continue;
      if (ny > fbBot) continue;

      var lit = (ns >= ss && ns <= es);
      var arrived = (ny + nh) >= nbStop;
      // 3D: unlit heads stop short of the bar (gap); lit notes fill to it.
      if (_nbUseFade && !lit) {
        var wBot = ny + nh;
        if (wBot > nbStop && ny < nbStop) nh = nbStop - ny;
      }
      var y0 = ny, y1 = ny + nh;
      var chx = a.channel | 0;
      if (chx < 0 || chx > 15) chx = 0;
      if (pos.black) {
        var dwb = pos.w - 2, dxb = nx + 1;
        if (dwb < 1) dwb = 1; // 128-key black notes are 2px wide — still draw 1px
        var idxb = (n << 4) | chx;
        var bb = _bkB[idxb];
        if (!bb) { bb = { has: false, top: 0, bot: 0, nx: 0, nw: 0, ch: 0, touchBar: false }; _bkB[idxb] = bb; }
        if (!bb.has) {
          bb.has = true; bb.top = y0; bb.bot = y1; bb.nx = dxb; bb.nw = dwb; bb.ch = a.channel;
          bb.touchBar = _doLip && !lit && arrived && ny < nbStop;
          _touchedB[_touchedBN++] = idxb;
        } else if (y0 <= bb.bot + _GAP && y1 >= bb.top - _GAP) {
          if (y0 < bb.top) bb.top = y0;
          if (y1 > bb.bot) bb.bot = y1;
          if (_doLip && !lit && arrived && ny < nbStop) bb.touchBar = true;
        } else {
          nbPaintRun(bb);
          if (_doLip && bb.touchBar) nbLip(bb);
          bb.top = y0; bb.bot = y1;
          bb.touchBar = _doLip && !lit && arrived && ny < nbStop;
        }
      } else {
        var idxw = (n << 4) | chx;
        var wb = _bkW[idxw];
        if (!wb) { wb = { has: false, top: 0, bot: 0, nx: 0, nw: 0, ch: 0, touchBar: false }; _bkW[idxw] = wb; }
        if (!wb.has) {
          wb.has = true; wb.top = y0; wb.bot = y1; wb.nx = nx; wb.nw = pos.w; wb.ch = a.channel;
          _touchedW[_touchedWN++] = idxw;
        } else if (y0 <= wb.bot + _GAP && y1 >= wb.top - _GAP) {
          if (y0 < wb.top) wb.top = y0;
          if (y1 > wb.bot) wb.bot = y1;
        } else {
          nbPaintRun(wb);
          wb.top = y0; wb.bot = y1;
        }
      }
    }

    // ── Flush: whites first (under), blacks on top — same layering as before.
    // (A mid-scan black split paints immediately, so in overlap zones a later
    // white run may cover 1px of a black edge — extreme density only,
    // invisible in practice.)
    var _fi, _fb;
    for (_fi = 0; _fi < _touchedWN; _fi++) { _fb = _bkW[_touchedW[_fi]]; if (_fb.has) nbPaintRun(_fb); }
    for (_fi = 0; _fi < _touchedBN; _fi++) { _fb = _bkB[_touchedB[_fi]]; if (_fb.has) { nbPaintRun(_fb); if (_doLip && _fb.touchBar) nbLip(_fb); } }

    // Single blit to screen (SLACK rows composite transparently over the bar)
    ctx.drawImage(_offscreen, 0, 0, screenW, fbH + NB_SLACK, 0, 0, screenW, fbH + NB_SLACK);
  }

  return {
    init: init, isReady: isReady, reset: reset,
    setSpeed: setSpeed, onNote: onNote, draw: draw,
    ensureKeyCache: ensureKeyCache,
  };
})();