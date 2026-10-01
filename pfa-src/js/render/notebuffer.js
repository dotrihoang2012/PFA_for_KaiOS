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

  // Draw-list pool: reused every frame so the scan allocates nothing
  // (was ~1k short-lived entry objects + 2 arrays per frame → GC pauses
  // that killed fps while the machine sat idle). Same order, same pixels.
  var _whites = [], _blacks = [], _pool = [], _poolLen = 0;
  // Flat-union run state per key (min/max y, channel, x/w, active flag).
  // Same-channel overlapping notes merge into one fillRect: pixel-identical
  // coverage+color in flat mode, far fewer canvas calls at density.
  var _runMin = [], _runMax = [], _runCh = [], _runOn = [], _runNx = [], _runNw = [];

  // 3D note-fall (mirrors notes.js): STOP = unlit head barrier above the
  // bar (5px stroke covers ±2.5px, so 6 leaves a clear ~3.5px gap),
  // LIP = black-note tongue onto the bar. SLACK = extra offscreen
  // rows so the lip's 2px over-poke past fbBot survives the blit.
  var NB_STOP = 6;
  var NB_LIP = 2;
  var NB_SLACK = 6;

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

    // Render whites then blacks into offscreen.
    // Colors come from the shared Notes palette so Options →
    // Note Color Palette Randomise applies here too.
    var whites = _whites, blacks = _blacks;
    whites.length = 0; blacks.length = 0; _poolLen = 0;
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

      var entry = _pool[_poolLen] || (_pool[_poolLen] = {});
      _poolLen++;
      entry.nx = nx; entry.ny = ny; entry.nw = pos.w; entry.nh = nh;
      entry.ch = a.channel; entry.black = pos.black; entry.nn = n;
      entry.lit = (ns >= ss && ns <= es);
      if (pos.black) blacks.push(entry);
      else           whites.push(entry);
    }

    // ── Draw with per-note horizontal gradient ──
    // Per-note horizontal gradient: full palette color at the note's left
    // edge → shaded at its right edge (fadeQ from view3dFallOpacity, same as
    // notes.js), WITHIN each note (not a screen-wide fade). Gradients are
    // cached per frame in a local map — note x/width is fixed per key
    // column, so the palette only affects colors that were just created.
    var rgbTbl = _nbRgbTable();
    var gradMap = {};
    var lastCh = -1, lastGrad = null, lastFlat = null;
    // 3D fade mirrors notes.js: view3dFallOpacity (0..100) → fadeAmt 0..1 →
    // fadeQ (right-edge brightness; 1 = flat, 0.12 = strongest fade).
    // A fade of 0 intentionally returns the exact non-3D note path: no head
    // gap, no connector lip, flat color.
    var fadeAmt = (typeof Notes !== 'undefined' && Notes.fallFade)
      ? Notes.fallFade(state, nbFall3d) : 1;
    var fadeQ = (typeof Notes !== 'undefined' && Notes.fadeShade)
      ? Notes.fadeShade(fadeAmt) : 1;
    var useFade = nbFall3d && fadeAmt > 0;
    function emitFlatRun(k, inset) {
      var rgb2 = rgbTbl[_runCh[k] % 16] || { r: 204, g: 204, b: 204 };
      var flatS = 'rgb(' + rgb2.r + ',' + rgb2.g + ',' + rgb2.b + ')';
      if (flatS !== lastFlat) { _offCtx.fillStyle = flatS; lastFlat = flatS; }
      var h = _runMax[k] - _runMin[k];
      if (h < 1) h = 1;
      if (inset) {
        var fw = _runNw[k] - 2, fx = _runNx[k] + 1;
        if (fw < 1) fw = 1; // 128-key black notes are 2px wide — still draw 1px
        _offCtx.fillRect(fx, _runMin[k], fw, h);
      } else {
        _offCtx.fillRect(_runNx[k], _runMin[k], _runNw[k], h);
      }
    }
    for (var wi = 0; wi < whites.length; wi++) {
      var e = whites[wi];
      // 3D: unlit heads stop short of the bar (gap); lit notes fill to it.
      if (useFade && !e.lit) {
        var wBot = e.ny + e.nh;
        if (wBot > nbStop && e.ny < nbStop) e.nh = nbStop - e.ny;
      }
      var rgb = rgbTbl[e.ch % 16] || { r: 204, g: 204, b: 204 };
      if (useFade) {
        var gkey = e.ch + ':' + e.nx + ':' + e.nw + ':' + Math.round(fadeQ * 1000);
        var grad = gradMap[gkey] || (function () {
          var g = _offCtx.createLinearGradient(e.nx, 0, e.nx + e.nw, 0);
          g.addColorStop(0, 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')');
          g.addColorStop(1, 'rgb(' + Math.round(rgb.r * fadeQ) + ',' +
            Math.round(rgb.g * fadeQ) + ',' + Math.round(rgb.b * fadeQ) + ')');
          gradMap[gkey] = g;
          return g;
        })();
        if (e.ch !== lastCh || grad !== lastGrad) {
          _offCtx.fillStyle = grad;
          lastCh = e.ch;
          lastGrad = grad;
        }
        _offCtx.fillRect(e.nx, e.ny, e.nw, e.nh);
      } else {
        // Flat union feed: same-channel overlapping notes merge (drawn at
        // run breaks + flush below) — pixel-identical, far fewer rects.
        var un = e.nn, uch = e.ch, ueB = e.ny + e.nh;
        if (_runOn[un] && _runCh[un] === uch && e.ny <= _runMax[un] + 1 && ueB >= _runMin[un] - 1) {
          if (e.ny < _runMin[un]) _runMin[un] = e.ny;
          if (ueB > _runMax[un]) _runMax[un] = ueB;
        } else {
          if (_runOn[un]) emitFlatRun(un, false);
          _runOn[un] = 1; _runCh[un] = uch;
          _runMin[un] = e.ny; _runMax[un] = ueB;
          _runNx[un] = e.nx; _runNw[un] = e.nw;
        }
      }
    }
    if (!useFade) { for (var fi = 0; fi < 128; fi++) if (_runOn[fi]) { emitFlatRun(fi, false); _runOn[fi] = 0; } }
    lastCh = -1; lastGrad = null; lastFlat = null;
    for (var bi = 0; bi < blacks.length; bi++) {
      var e2 = blacks[bi];
      // 3D: unlit heads stop short of the bar; an arrived head grows a
      // centered 2px tongue onto the bar (gone once the note lights).
      var arrived = (e2.ny + e2.nh) >= nbStop;
      if (useFade && !e2.lit) {
        var bBot = e2.ny + e2.nh;
        if (bBot > nbStop && e2.ny < nbStop) e2.nh = nbStop - e2.ny;
      }
      var rgb = rgbTbl[e2.ch % 16] || { r: 204, g: 204, b: 204 };
      if (useFade) {
        var gkey = e2.ch + ':' + e2.nx + ':' + e2.nw + ':' + Math.round(fadeQ * 1000);
        var grad = gradMap[gkey] || (function () {
          var g = _offCtx.createLinearGradient(e2.nx, 0, e2.nx + e2.nw, 0);
          g.addColorStop(0, 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')');
          g.addColorStop(1, 'rgb(' + Math.round(rgb.r * fadeQ) + ',' +
            Math.round(rgb.g * fadeQ) + ',' + Math.round(rgb.b * fadeQ) + ')');
          gradMap[gkey] = g;
          return g;
        })();
        if (e2.ch !== lastCh || grad !== lastGrad) {
          _offCtx.fillStyle = grad;
          lastCh = e2.ch;
          lastGrad = grad;
        }
      } else {
        // Flat union feed (black inset applied at emit).
        var un2 = e2.nn, uch2 = e2.ch, ueB2 = e2.ny + e2.nh;
        if (_runOn[un2] && _runCh[un2] === uch2 && e2.ny <= _runMax[un2] + 1 && ueB2 >= _runMin[un2] - 1) {
          if (e2.ny < _runMin[un2]) _runMin[un2] = e2.ny;
          if (ueB2 > _runMax[un2]) _runMax[un2] = ueB2;
        } else {
          if (_runOn[un2]) emitFlatRun(un2, true);
          _runOn[un2] = 1; _runCh[un2] = uch2;
          _runMin[un2] = e2.ny; _runMax[un2] = ueB2;
          _runNx[un2] = e2.nx; _runNw[un2] = e2.nw;
        }
      }
      if (useFade) {
      var fw = e2.nw - 2;
      var fx = e2.nx + 1;
      if (fw < 1) fw = 1; // 128-key black notes are 2px wide — still draw 1px
      _offCtx.fillRect(fx, e2.ny, fw, e2.nh);
      if (!e2.lit && arrived && e2.ny < nbStop) {
        var lipW = Math.max(2, Math.floor(fw * 0.5));
        var lipX = fx + Math.floor((fw - lipW) / 2);
        _offCtx.fillRect(lipX, nbStop, lipW, NB_STOP + NB_LIP);
      }
      }
    }
    if (!useFade) { for (var fi2 = 0; fi2 < 128; fi2++) if (_runOn[fi2]) { emitFlatRun(fi2, true); _runOn[fi2] = 0; } }

    // Single blit to screen (SLACK rows composite transparently over the bar)
    ctx.drawImage(_offscreen, 0, 0, screenW, fbH + NB_SLACK, 0, 0, screenW, fbH + NB_SLACK);
  }

  return {
    init: init, isReady: isReady, reset: reset,
    setSpeed: setSpeed, onNote: onNote, draw: draw,
    ensureKeyCache: ensureKeyCache,
  };
})();