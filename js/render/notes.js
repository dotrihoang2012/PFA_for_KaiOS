/**
 * notes.js — Falling notes + time-bucketed heatmap renderer.
 *
 * OPTIMIZATIONS (learned from reference audio-visualizer):
 *  - Pre-parsed color cache: fillStyle set ONCE per channel per frame,
 *    not per-note. Gecko 48 parses hex strings each fillStyle assignment.
 *  - Hysteresis on heatmap mode (HEAT_THRESH_LO/HI) — avoids flipping
 *    between modes at threshold → no "loạn màu".
 *  - VISUAL_LK=4s matching keyboard vertical scale.
 *  - No per-frame object allocation in main scan loop.
 */
var Notes = (function () {
  'use strict';

  var VISUAL_LK = 6.0;       // lookahead window — đủ để note xuất hiện từ top canvas
  var HEAT_THRESH_LO = 200;
  var HEAT_THRESH_HI = 300;
  var MAX_DRAW_PER_FRAME = 1024;
  var SCAN_MAX = 4096;

  // 16 channel colors (matching dipswitchhuey scheme)
  var CH_COLORS = [
    '#FFB500', '#00C8FF', '#64FF64', '#FF468C',
    '#FFDC00', '#AA64FF', '#00F0B4', '#FF7850',
    '#50B4FF', '#C8FF00', '#FF3464', '#64C8FF',
    '#FF9B00', '#B464FF', '#82FFC8', '#FF64A0'
  ];

  // Parsed RGBA strings for heatmap (pre-built, no per-frame parse)
  var _rgbaCache = null;

  // Key cache (rebuild on camKey/keyWidth change)
  var _keyCache = null;
  var _keyCacheW = -1;
  var _keyCacheKey = -1;

  // Mode hysteresis state
  var _heatMode = false;

  function channelColor(ch) {
    ch = (isFinite(ch) ? ch : 0) % 16;
    return CH_COLORS[ch] || '#CCCCCC';
  }

  function buildRgbaCache() {
    if (_rgbaCache) return;
    _rgbaCache = [];
    for (var i = 0; i < 16; i++) {
      var hex = CH_COLORS[i];
      var h = hex.charAt(0) === '#' ? hex.substring(1) : hex;
      var r = parseInt(h.substring(0, 2), 16);
      var g = parseInt(h.substring(2, 4), 16);
      var b = parseInt(h.substring(4, 6), 16);
      // Pre-build 5 alpha levels for heatmap (0.15, 0.30, 0.45, 0.60, 0.75)
      _rgbaCache[i] = [
        'rgba(' + r + ',' + g + ',' + b + ',0.15)',
        'rgba(' + r + ',' + g + ',' + b + ',0.30)',
        'rgba(' + r + ',' + g + ',' + b + ',0.45)',
        'rgba(' + r + ',' + g + ',' + b + ',0.60)',
        'rgba(' + r + ',' + g + ',' + b + ',0.75)'
      ];
    }
  }

  /** Returns cached rgba string for heatmap. val: 1..5 */
  function rgbaForChannel(ch, valAlphaIdx) {
    if (!_rgbaCache) buildRgbaCache();
    var ci = ((isFinite(ch) ? ch : 0) % 16);
    var vi = valAlphaIdx < 0 ? 0 : (valAlphaIdx > 4 ? 4 : valAlphaIdx);
    return _rgbaCache[ci][vi];
  }

  function ensureKeyCache(camKey, keyW) {
    if (_keyCache && _keyCacheKey === camKey && _keyCacheW === keyW) return;
    _keyCache = new Array(128);
    _keyCacheKey = camKey;
    _keyCacheW = keyW;
    var xByNote = new Array(128);
    var runningX = 0;

    // First pass: compute white-key X positions
    for (var i = 0; i < 128; i++) {
      xByNote[i] = runningX;
      if (!Constants.isBlackKey(i % 12)) runningX += keyW;
    }
    // Second pass: build cache (black keys centered on boundary)
    for (var note = 0; note < 128; note++) {
      var bk = Constants.isBlackKey(note % 12);
      var w = bk ? Math.round(keyW * 0.6) : keyW;
      var x;
      if (bk) {
        x = Math.round(xByNote[note] - w * 0.5);
      } else {
        x = xByNote[note];
      }
      _keyCache[note] = { x: Math.round(x), w: Math.round(w) };
    }
  }

  function draw(state, ctx, w, h) {
    var KB_H = 60;
    // Canvas height already excludes softkey band (see main.js _chromeH),
    // so fbBot sits flush with the canvas bottom (just above where piano
    // will be drawn).
    var fbBot = h - KB_H;                    // bottom y of falling-notes band
    var fbTop = 0;                           // top y of band
    if (fbBot < fbTop) fbBot = fbTop + 30;
    var fbH   = fbBot - fbTop;               // height of band
    if (fbH < 30) { fbH = 30; fbBot = fbTop + 30; } // safety on tiny screens
    var trailSetting = (state.trail != null && isFinite(state.trail)) ? state.trail : 1.0;
    var effectiveLK = VISUAL_LK / trailSetting; // trail=2 -> half lookahead -> 2x faster
    var FALL = fbH / effectiveLK;
    var kw = state.keyWidth || 16;
    var ck = state.camKey   || 48;
    var ns = 0;
    try { ns = Sequencer.getTime(); } catch(e) { return; }
    var sp = state.speed || 1.0;

    var live = state._activeList;
    if (!live) { try { live = Sequencer.activeList(); } catch (e) { live = []; } }
    if (!live || !live.length) return;

    var liveLen  = live.length;
    var audioLen = (typeof Sequencer.audioList === 'function') ? Sequencer.audioList().length : 0;

    // Heatmap based on currently-playing notes (audioList), not 6s lookahead
    if (!_heatMode && audioLen > HEAT_THRESH_HI) _heatMode = true;
    else if (_heatMode && audioLen < HEAT_THRESH_LO) _heatMode = false;

    ensureKeyCache(ck, kw);

    // Scroll offset — same as keyboard.js: sx = x position of camKey
    var camOffset = _keyCache[ck] ? _keyCache[ck].x : 0;

    if (_heatMode) {
      drawHeatmap(live, ctx, w, fbTop, fbBot, fbH, kw, ck, ns, sp, camOffset);
      return;
    }

    // ── Individual falling notes ──
    // Pre-sort into white/black arrays ONCE, then draw white first, black on top.
    // Không scan 2 lần → không duplicate, không mờ ảo.
    var whites = [], blacks = [];

    for (var i = 0; i < liveLen && i < SCAN_MAX; i++) {
      var a = live[i];
      var n = a.note;
      if (n < ck || n > 127) continue;

      var pos = _keyCache[n];
      if (!pos) continue;
      var nx = pos.x - camOffset;
      if (nx < -5 || nx > w + 5) continue;

      var ss = a.startSec != null ? a.startSec : Tempo.toSec(a.tick);
      var es = a.endSec   != null ? a.endSec   :
               (a.endTick != null ? Tempo.toSec(a.endTick) : ss + 0.5);

      if (es < ns - 0.1) continue;
      if (ss > ns + effectiveLK) continue;

      var du = es - ss;
      if (du < 0.01) du = 0.01;

      // nyBottom: note bottom falls at FALL speed (already scaled by trail via effectiveLK)
      var nyBottom = fbBot - (ss - ns) * FALL * sp;
      var nh = du * FALL * sp; // note height (trail already in FALL)
      if (nh < 2) nh = 2;
      var ny = nyBottom - nh;
      if (nyBottom < 0) continue;
      if (ny > fbBot)   continue;

      var entry = { nx: nx, ny: ny, nw: pos.w, nh: nh, ch: a.channel,
                    black: Constants.isBlackKey(n % 12) };
      if (entry.black) blacks.push(entry);
      else             whites.push(entry);
    }

    // Draw white notes first
    var lastCh = -1;
    for (var wi = 0; wi < whites.length; wi++) {
      var e = whites[wi];
      if (e.ch !== lastCh) { ctx.fillStyle = channelColor(e.ch); lastCh = e.ch; }
      ctx.fillRect(e.nx, e.ny, e.nw, e.nh);
    }
    // Draw black notes on top (narrower)
    lastCh = -1;
    for (var bi = 0; bi < blacks.length; bi++) {
      var e = blacks[bi];
      if (e.ch !== lastCh) { ctx.fillStyle = channelColor(e.ch); lastCh = e.ch; }
      ctx.fillRect(e.nx + 1, e.ny, e.nw - 2, e.nh);
    }
  }

  function drawHeatmap(live, ctx, w, fbTop, fbBot, fbH, keyW, camKey, nowSec, speed, camOffset) {
    var BUCKETS = 16;
    var hor = nowSec + VISUAL_LK;
    var HM_SCAN = 400;

    if (!_rgbaCache) buildRgbaCache();

    ensureKeyCache(camKey, keyW);

    // Single typed array grid (no per-frame object allocation):
    // For each pixel column (0..w), 16 bucket counts + 1 channel id.
    // We bucket by note X position (rounded to integer).
    var colCount = w + 4;
    // grid format: 16 buckets per column (counts 0..N), stored flat.
    // Reuse buffer if possible.
    if (!drawHeatmap._buf || drawHeatmap._buf.length < colCount * BUCKETS) {
      drawHeatmap._buf = new Int8Array(colCount * BUCKETS);
    }
    var buf = drawHeatmap._buf;
    for (var z = 0; z < colCount * BUCKETS; z++) buf[z] = 0;

    // Also track which channel dominates each column (for color pick)
    if (!drawHeatmap._colCh || drawHeatmap._colCh.length < colCount) {
      drawHeatmap._colCh = new Int8Array(colCount);
    }
    var colCh = drawHeatmap._colCh;
    for (var zc = 0; zc < colCount; zc++) colCh[zc] = -1;

    for (var i = 0; i < live.length && i < HM_SCAN; i++) {
      var a = live[i];
      var n = a.note;
      if (n < camKey || n > 127) continue;

      var ss = a.startSec != null ? a.startSec : Tempo.toSec(a.tick);
      var es = a.endSec   != null ? a.endSec   :
               (a.endTick != null ? Tempo.toSec(a.endTick) : ss + 0.5);

      var vs = Math.max(nowSec, ss);
      var ve = Math.min(hor, es);
      if (vs >= ve) continue;

      // bucket 0 = xa nhất (trên cao), bucket BUCKETS-1 = gần piano
      var bFrom = Math.floor((vs - nowSec) / VISUAL_LK * BUCKETS);
      var bTo   = Math.floor((ve - nowSec) / VISUAL_LK * BUCKETS);
      if (bFrom < 0) bFrom = 0;
      if (bTo > BUCKETS - 1) bTo = BUCKETS - 1;
      if (bFrom > BUCKETS - 1) continue;

      var pos = _keyCache[n];
      if (!pos) continue;
      var px = pos.x - camOffset;
      if (px < 0 || px >= w) continue;

      var ch = a.channel || 0;
      var endX = px + pos.w;
      if (endX > w) endX = w;

      // Fill per-pixel-column buckets
      for (var cx = px; cx < endX; cx++) {
        // Track dominant channel (any channel wins if previous is -1)
        if (colCh[cx] === -1) colCh[cx] = ch;
        for (var b = bFrom; b <= bTo; b++) {
          buf[cx * BUCKETS + b]++;
        }
      }
    }

    var bucketH = fbH / BUCKETS;

    // Draw: walk columns, batch by dominant channel + alpha level
    var lastCh = -1;
    var lastAlphaIdx = -1;
    for (var x = 0; x < w; x++) {
      var ch = colCh[x];
      if (ch < 0) continue;
      var base = x * BUCKETS;
      for (var bi = 0; bi < BUCKETS; bi++) {
        var val = buf[base + bi];
        if (val <= 0) continue;
        // Map count → alpha level (0..4)
        var ai;
        if (val <= 1) ai = 0;
        else if (val <= 2) ai = 1;
        else if (val <= 3) ai = 2;
        else if (val <= 4) ai = 3;
        else ai = 4;

        if (ch !== lastCh || ai !== lastAlphaIdx) {
          ctx.fillStyle = rgbaForChannel(ch, ai);
          lastCh = ch;
          lastAlphaIdx = ai;
        }
        // bi=0 → trên cao (xa), bi=BUCKETS-1 → gần piano
        var yPos = fbBot - (BUCKETS - bi) * bucketH;
        ctx.fillRect(x, yPos, 1, bucketH + 1);
      }
    }
  }

  return { draw: draw, channelColor: channelColor };
})();
