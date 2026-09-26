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
  // Spam bridge: close same-column slit gaps so a tight staccato run reads
  // as a solid column instead of a ruled ladder. Two guards keep
  // musically-separated notes distinct: the pixel gap must be small, AND
  // the two notes must belong to the same rapid run (onset spacing within
  // NB_BRIDGE_ONSET). The slit is filled with the *previous* note's color,
  // so different channels never merge.
  var NB_BRIDGE_MIN   = 4;
  var NB_BRIDGE_PX    = 14;
  var NB_BRIDGE_PX_m  = 0.06; // scale cap with fall speed, clipped to NB_BRIDGE_PX
  var NB_BRIDGE_ONSET = 0.18; // s — same-key onsets closer than this are one run

  function _bridgeRuns(list, maxGap) {
    if (list.length < 2) return;
    var cols = {}, keys = [], n = 0;
    for (var i = 0; i < list.length; i++) {
      var key = list[i].nx + '|' + list[i].nw;
      if (!cols[key]) { cols[key] = []; keys.push(key); }
      cols[key].push(list[i]);
    }
    for (var ki = 0; ki < keys.length; ki++) {
      var arr = cols[keys[ki]];
      arr.sort(function (a, b) { return a.ny - b.ny; });
      for (var j = 1; j < arr.length; j++) {
        var gap = arr[j].ny - (arr[j - 1].ny + arr[j - 1].nh);
        if (gap > 0 && gap <= maxGap &&
            Math.abs(arr[j].ssec - arr[j - 1].ssec) <= NB_BRIDGE_ONSET) {
          arr[j - 1].nh += gap;
        }
      }
      for (var k = 0; k < arr.length; k++) list[n++] = arr[k];
    }
    list.length = n;
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
    // Visible window — Keyboard Range [kbStart..kbEnd] replaces camKey
    var ck = (state.kbStart != null) ? state.kbStart : 21;
    var ckEnd = (state.kbEnd != null) ? state.kbEnd : 108;
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

      var nyBottom = fbBot - (ss - ns) * FALL;
      // Buffer-native minimum dash: at high fall speeds sub-5ms notes would
      // render as 2px hairlines (the "striped lines" look). Floor them to
      // 5ms of fall so every note reads as a bar. Low trails are untouched
      // (0.005*FALL <= 2 there, so the floor stays exactly 2px).
      var nh = Math.max(2, 0.005 * FALL, (es - ss) * FALL);
      var ny = nyBottom - nh;
      if (nyBottom < 0) continue;
      if (ny > fbBot) continue;

      var entry = { nx: nx, ny: ny, nw: pos.w, nh: nh,
                    ch: a.channel, black: pos.black,
                    ssec: ss,
                    lit: (ns >= ss && ns <= es), arrv: (ns > ss) };
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

    // 3D head-stop: unlit, not-yet-arrived heads stop short of the bar.
    // Applied BEFORE the spam bridge so a tight run bridges seamlessly past
    // the stop band (no vanishing/flicker as notes overlap at the bar),
    // while an isolated approaching note keeps its stop gap.
    if (useFade) {
      for (var si = 0; si < whites.length; si++) {
        var se = whites[si];
        if (!se.lit && !se.arrv) {
          var sBot = se.ny + se.nh;
          if (sBot > nbStop && se.ny < nbStop) se.nh = nbStop - se.ny;
        }
      }
      for (var si2 = 0; si2 < blacks.length; si2++) {
        var se2 = blacks[si2];
        if (!se2.lit && !se2.arrv) {
          var sBot2 = se2.ny + se2.nh;
          if (sBot2 > nbStop && se2.ny < nbStop) se2.nh = nbStop - se2.ny;
        }
      }
    }

    // Close small same-column slit gaps (tight staccato spam) so the column
    // renders as one continuous bar instead of a dashed stack, but stay
    // clear of musically-separated notes (cap is small, in pixels).
    var maxGap = Math.round(FALL * NB_BRIDGE_PX_m);
    if (maxGap < NB_BRIDGE_MIN) maxGap = NB_BRIDGE_MIN;
    else if (maxGap > NB_BRIDGE_PX) maxGap = NB_BRIDGE_PX;
    _bridgeRuns(whites, maxGap);
    _bridgeRuns(blacks, maxGap);

    for (var wi = 0; wi < whites.length; wi++) {
      var e = whites[wi];
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
      } else {
        // 3D off ('keyboard'/'none'): flat solid channel color, no fade.
        var flatS = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
        if (flatS !== lastFlat) { _offCtx.fillStyle = flatS; lastFlat = flatS; }
      }
      _offCtx.fillRect(e.nx, e.ny, e.nw, e.nh);
    }
    lastCh = -1; lastGrad = null; lastFlat = null;
    for (var bi = 0; bi < blacks.length; bi++) {
      var e2 = blacks[bi];
      // 3D: unlit heads stop short of the bar; an arrived head grows a
      // centered 2px tongue onto the bar (gone once the note lights).
      var arrived = (e2.ny + e2.nh) >= nbStop;
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
        // 3D off ('keyboard'/'none'): flat solid channel color, no fade.
        var flatS = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
        if (flatS !== lastFlat) { _offCtx.fillStyle = flatS; lastFlat = flatS; }
      }
      var fw = e2.nw - 2;
      var fx = e2.nx + 1;
      if (fw < 1) fw = 1; // 128-key black notes are 2px wide — still draw 1px
      _offCtx.fillRect(fx, e2.ny, fw, e2.nh);
      if (useFade && !e2.lit && arrived && e2.ny < nbStop) {
        var lipW = Math.max(2, Math.floor(fw * 0.5));
        var lipX = fx + Math.floor((fw - lipW) / 2);
        _offCtx.fillRect(lipX, nbStop, lipW, NB_STOP + NB_LIP);
      }
    }

    // Single blit to screen (SLACK rows composite transparently over the bar)
    ctx.drawImage(_offscreen, 0, 0, screenW, fbH + NB_SLACK, 0, 0, screenW, fbH + NB_SLACK);
  }

  return {
    init: init, isReady: isReady, reset: reset,
    setSpeed: setSpeed, onNote: onNote, draw: draw,
    ensureKeyCache: ensureKeyCache,
  };
})();