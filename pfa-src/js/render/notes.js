/**
 * notes.js — Falling notes renderer.
 *
 * OPTIMIZATIONS (learned from reference audio-visualizer):
 *  - Pre-parsed color cache: fillStyle set ONCE per channel per frame,
 *    not per-note. Gecko 48 parses hex strings each fillStyle assignment.
 *  - VISUAL_LK=4s matching keyboard vertical scale.
 *  - No per-frame object allocation in main scan loop.
 *
 * Visual Settings integration:
 *  - Channel colors are MUTABLE — Options → Note Color Palette Randomise
 *    regenerates all 16 with guaranteed-unique hues (randomizePalette).
 *  - Visible note window comes from Store kbStart/kbEnd (Keyboard Range).
 *  - Falling-notes band bottom follows the Piano Size strip height.
 */
var Notes = (function () {
  'use strict';

  var VISUAL_LK = 2.0;       // match LK in sequencer — enough for notes to appear from top of canvas
  var MAX_DRAW_PER_FRAME = 1180591620717411303424;
  var SCAN_MAX = 1180591620717411303424;

  // 16 channel colors (matching dipswitchhuey scheme).
  // MUTABLE — randomizePalette() / setPaletteColors() overwrites entries
  // in place so every consumer picks up the new palette through
  // channelColor() without re-wiring.
  var CH_COLORS = [
    '#FFB500', '#00C8FF', '#64FF64', '#FF468C',
    '#FFDC00', '#AA64FF', '#00F0B4', '#FF7850',
    '#50B4FF', '#C8FF00', '#FF3464', '#64C8FF',
    '#FF9B00', '#B464FF', '#82FFC8', '#FF64A0'
  ];

  // Parse RGB triplets cache (built from CH_COLORS, invalidated on
  // per-note horizontal gradients (bright left → dark right) without
  // parsing hex strings every frame.
  var _rgbCache = null;

  // Cache of per-note CanvasGradient objects, keyed by ch/nx/nw.
  // Invalidated on palette change or canvas resize.
  var _gradCache = null;

  var _gradW = -1, _gradH = -1;

  // Horizontal blend weights — deep/solid left (100%), mid (55%), the
  // remainder always lands on a near-black (~16%) right edge.
  var _NOTE_SHADES = [1.0, 0.55, 0.16];
  // First two segment widths as fractions of note width; the last segment
  // absorbs rounding so the dark right edge is never lost to a 0px slice.
  var _NOTE_SEGS   = [0.42, 0.30];
  // Notes narrower than this are drawn as a single bright fill (a second
  // sub-rect would be sub-pixel and just cost time). Kept at 3px so the
  // left→right fade stays visible on KaiOS screens (88 keys ≈ 5px/note,
  // 128 keys ≈ 3px/note — an 8px threshold would never trigger there).
  var _MIN_TWO_TONE_W = 3;

  // 3D note-fall (Graphics → 3D View 'notefall'/'both'): unlit notes hover
  // above the bar instead of touching it. STOP = head stop distance above
  // the band bottom (the 5px bar stroke covers ±2.5px, so 6 leaves a clear
  // ~3.5px gap); LIP = black-note tongue protruding onto the bar (2px).
  var FALL3D_STOP = 6;
  var FALL3D_LIP = 2;

  // Key cache (rebuild on camKey/keyWidth change)
  var _keyCache = null;
  var _keyCacheW = -1;
  var _keyCacheKey = -1;

  // Demo track override: while the bundled demo is active (and locked until
  // a real .mid/.note loads), the two demo tracks are ALWAYS rendered with
  // their fixed default colors — track 1 = yellow, track 2 = water blue —
  // regardless of any Note Color palette the user applies. Toggled by
  // main.js via setDemoOverride() on demo start / real-file load.
  var _demoOverride = false;

  // Demo track colors (fixed, palette-independent).
  var _DEMO_COLORS = ['#FFCC00', '#00C8FF'];

  function setDemoOverride(on) {
    on = !!on;
    if (on === _demoOverride) return;
    _demoOverride = on;
    // Drop every cached color table so the next build re-derives through
    // channelColor() and picks up the fixed demo colors (or the user's
    // palette once a real file loads).
    _rgbCache = null;
    _gradCache = null; // per-note gradients use stale colors otherwise
  }

  function channelColor(ch) {
    ch = (isFinite(ch) ? ch : 0) % 16;
    if (_demoOverride && ch < _DEMO_COLORS.length) return _DEMO_COLORS[ch];
    return CH_COLORS[ch] || '#CCCCCC';
  }

  /** '#rrggbb' → {r,g,b} integer triplet. */
  function _hexToRgb(hex) {
    var h = hex.charAt(0) === '#' ? hex.substring(1) : hex;
    return {
      r: parseInt(h.substring(0, 2), 16),
      g: parseInt(h.substring(2, 4), 16),
      b: parseInt(h.substring(4, 6), 16)
    };
  }

  /**
   * Build the per-channel RGB cache from the current CH_COLORS.
   * Used by the note-fade renderer to avoid parsing hex strings on
   * every draw call.
   */
  function _buildRgbCache() {
    _rgbCache = [];
    for (var i = 0; i < 16; i++) {
      _rgbCache[i] = _hexToRgb(channelColor(i));
    }
  }

  /**
   * Per-note horizontal gradient: full palette color at the LEFT edge
   * → ~12% (near black) at the RIGHT edge, WITHIN this note.
   */
  function _noteGradient(ctx, rgb, nx, nw) {
    var g = ctx.createLinearGradient(nx, 0, nx + nw, 0);
    g.addColorStop(0, 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')');
    g.addColorStop(1, 'rgb(' + Math.round(rgb.r * 0.12) + ',' +
      Math.round(rgb.g * 0.12) + ',' + Math.round(rgb.b * 0.12) + ')');
    return g;
  }

  /**
   * Randomize all 16 channel colors — Options → Note Color Palette
   * Randomise. Uniqueness is guaranteed by construction: hues advance
   * by the golden angle (137.508°), which never repeats within 16 steps
   * (the golden-angle sequence only cycles after 360/gcd ≈ huge counts),
   * and saturation/lightness are jittered per slot on top of that.
   */
  function randomizePalette() {
    var GOLDEN = 137.508;
    var baseH = Math.floor(Math.random() * 360);
    for (var i = 0; i < CH_COLORS.length; i++) {
      var h = (baseH + i * GOLDEN) % 360;
      var s = 65 + ((i * 29) % 26);   // 65..90  — vivid, readable on dark bg
      var l = 48 + ((i * 17) % 18);   // 48..65  — mid lightness spread
      CH_COLORS[i] = hslToHex(h, s, l);
    }
    _rgbCache = null;  // fade renderer cache too
    _gradCache = null;
  }

  /**
   * Apply a fixed palette (16 hex colors) to the 16 channel colors.
   * Short arrays keep their existing colors. Used by the Note Color
   * Settings palette list and the Synthesia built-in palettes.
   */
  function setPaletteColors(colors) {
    if (!colors || !colors.length) return;
    for (var i = 0; i < CH_COLORS.length; i++) {
      if (colors[i]) CH_COLORS[i] = colors[i];
    }
    _rgbCache = null;
    _gradCache = null;
  }

  /** hsl(h°,s%,l%) → '#rrggbb' — standard HSL conversion. */
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs(hp % 2 - 1));
    var r = 0, g = 0, b = 0;
    if      (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else             { r = c; b = x; }
    var m = l - c / 2;
    function to(v) {
      var n = Math.round((v + m) * 255);
      var hex = n.toString(16);
      return n < 16 ? '0' + hex : hex;
    }
    return '#' + to(r) + to(g) + to(b);
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
    // Band bottom follows the Piano Size strip height ('none' → full canvas).
    var kbH = (typeof Keyboard !== 'undefined' && Keyboard.height)
      ? Keyboard.height(state) : 60;
    // Canvas height already excludes softkey band (see main.js _chromeH),
    // so fbBot sits flush with the canvas bottom (just above where piano
    // will be drawn).
    var fbBot = h - kbH;                     // bottom y of falling-notes band
    var fbTop = 0;                           // top y of band
    if (fbBot < fbTop) fbBot = fbTop + 30;
    var fbH   = fbBot - fbTop;               // height of band
    if (fbH < 30) { fbH = 30; fbBot = fbTop + 30; } // safety on tiny screens
    function dv(k, c) { try { return (typeof window.demoVisualValue === 'function') ? window.demoVisualValue(k, c) : c; } catch (e) { return c; } }
    var trailSetting = (state.trail != null && isFinite(state.trail)) ? state.trail : 0.7;
    trailSetting = dv('trail', trailSetting);
    var effectiveLK = VISUAL_LK / trailSetting; // trail=2 -> half lookahead -> 2x faster
    var FALL = fbH / effectiveLK;
    var kw = state.keyWidth || 16;
    kw = dv('keyWidth', kw);
    // Visible window — Keyboard Range [kbStart..kbEnd] replaces camKey.
    var ckStart = (state.kbStart != null) ? state.kbStart : 21;
    var ckEnd   = (state.kbEnd   != null) ? state.kbEnd   : 108;
    ckStart = dv('kbStart', ckStart);
    ckEnd   = dv('kbEnd', ckEnd);
    ckStart = Math.max(0, Math.min(127, ckStart));
    ckEnd   = Math.max(ckStart + 1, Math.min(127, ckEnd));
    var ns = 0;
    try { ns = Sequencer.getTime(); } catch(e) { return; }

    var live = state._activeList;
    if (!live) { try { live = Sequencer.activeList(); } catch (e) { live = []; } }
    if (!live || !live.length) return;

    var liveLen  = live.length;

    // Render mode: auto/individual/buffer
    var renderMode = state.renderMode || 'auto';
    renderMode = dv('renderMode', renderMode);
    if (renderMode === 'buffer') {
      if (typeof NoteBuffer !== 'undefined' && NoteBuffer.isReady()) {
        NoteBuffer.draw(ctx, w, h, state);
      }
      return;
    }

    ensureKeyCache(ckStart, kw);

    // 3D fall gate — Graphics → 3D View 'notefall' or 'both' (the demo
    // never locks view3d, so the user's choice always applies).
    var _v3d = (state.view3d != null) ? state.view3d : 'both';
    _v3d = dv('view3d', _v3d);
    var fall3d = (_v3d === 'notefall' || _v3d === 'both');
    var fallStop = fbBot - FALL3D_STOP; // unlit head barrier

    // Scroll offset — left edge of the range window (same layout math
    // as keyboard.js, so notes and piano keys line up pixel-perfect).
    var camOffset = _keyCache[ckStart] ? _keyCache[ckStart].x : 0;

    // ── Individual falling notes ──
    // Pre-sort into white/black arrays ONCE, then draw white first, black on top.
    // Don't scan twice → no duplicates, no ghosting.
    var whites = [], blacks = [];

    // Lazy-build the RGB cache for per-note fade rendering.
    if (!_rgbCache) _buildRgbCache();

    var _scanBudget = performance.now() + 8; // max 8ms for note scan
    for (var i = 0; i < liveLen && i < SCAN_MAX; i++) {
      if ((i & 127) === 0 && performance.now() > _scanBudget) break; // time budget
      var a = live[i];
      var n = a.note;
      // Only notes inside the visible Keyboard Range are drawn
      if (n < ckStart || n > ckEnd) continue;

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

      // nyBottom: note bottom falls at FALL speed (musical-time based —
      // playhead ns already advances with speed, so no *sp here; otherwise
      // speed<1 would also stretch the trail and hollow out the top).
      var nyBottom = fbBot - (ss - ns) * FALL;
      var nh = du * FALL; // note height (trail already in FALL)
      if (nh < 2) nh = 2;
      var ny = nyBottom - nh;
      if (nyBottom < 0) continue;
      if (ny > fbBot)   continue;

      var entry = { nx: nx, ny: ny, nw: pos.w, nh: nh, ch: a.channel,
                    black: Constants.isBlackKey(n % 12), lit: (ns >= ss && ns <= es) };
      if (entry.black) blacks.push(entry);
      else             whites.push(entry);
    }

    // ── Draw with per-note horizontal gradient ──
    // Each note is filled with a gradient inside ITS OWN rectangle:
    // full palette color at its left edge → near-black at its right
    // edge. (No screen-wide fade — that looked like a global dim.)
    if (_gradCache && (w !== _gradW || h !== _gradH)) _gradCache = null; // canvas resized
    if (!_gradCache) { _gradCache = {}; _gradW = w; _gradH = h; }
    var lastCh = -1, lastGrad = null, lastFlat = null;
    for (var wi = 0; wi < whites.length; wi++) {
      var e = whites[wi];
      // 3D: unlit heads stop short of the bar (gap); lit notes fill to it.
      if (fall3d && !e.lit) {
        var wBot = e.ny + e.nh;
        if (wBot > fallStop && e.ny < fallStop) e.nh = fallStop - e.ny;
      }
      var rgb = _rgbCache[e.ch % 16] || { r: 204, g: 204, b: 204 };
      var gkey;
      if (fall3d) {
        gkey = e.ch + ':' + e.nx + ':' + e.nw;
        var grad = _gradCache[gkey];
        if (e.ch !== lastCh || grad !== lastGrad) {
          if (!grad) {
            grad = _noteGradient(ctx, rgb, e.nx, e.nw);
            _gradCache[gkey] = grad;
          }
          ctx.fillStyle = grad;
          lastCh = e.ch;
          lastGrad = grad;
        }
      } else {
        // 3D off ('keyboard'/'none'): flat solid channel color, no fade.
        var flatS = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
        if (flatS !== lastFlat) { ctx.fillStyle = flatS; lastFlat = flatS; }
      }
      ctx.fillRect(e.nx, e.ny, e.nw, e.nh);
    }
    // Draw black notes on top (narrower)
    lastCh = -1; lastGrad = null; lastFlat = null;
    for (var bi = 0; bi < blacks.length; bi++) {
      var e = blacks[bi];
      // 3D: unlit heads stop short of the bar (gap); lit notes fill to it.
      // An unlit head that reached the barrier grows a centered 2px tongue
      // onto the bar — it vanishes the moment the note lights.
      var arrived = (e.ny + e.nh) >= fallStop;
      if (fall3d && !e.lit) {
        var bBot = e.ny + e.nh;
        if (bBot > fallStop && e.ny < fallStop) e.nh = fallStop - e.ny;
      }
      var rgb = _rgbCache[e.ch % 16] || { r: 204, g: 204, b: 204 };
      var gkey;
      if (fall3d) {
        gkey = e.ch + ':' + e.nx + ':' + e.nw;
        var grad = _gradCache[gkey];
        if (e.ch !== lastCh || grad !== lastGrad) {
          if (!grad) {
            grad = _noteGradient(ctx, rgb, e.nx, e.nw);
            _gradCache[gkey] = grad;
          }
          ctx.fillStyle = grad;
          lastCh = e.ch;
          lastGrad = grad;
        }
      } else {
        // 3D off ('keyboard'/'none'): flat solid channel color, no fade.
        var flatS = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
        if (flatS !== lastFlat) { ctx.fillStyle = flatS; lastFlat = flatS; }
      }
      var fw = e.nw - 2, fx = e.nx + 1;
      if (fw < 1) fw = 1; // 128-key black notes are 2px wide — still draw 1px
      ctx.fillRect(fx, e.ny, fw, e.nh);
      if (fall3d && !e.lit && arrived && e.ny < fallStop) {
        var lipW = Math.max(2, Math.floor(fw * 0.5));
        var lipX = fx + Math.floor((fw - lipW) / 2);
        ctx.fillRect(lipX, fallStop, lipW, FALL3D_STOP + FALL3D_LIP);
      }
    }
  }

  return {
    draw: draw,
    channelColor: channelColor,
    randomizePalette: randomizePalette,
    setPaletteColors: setPaletteColors,
    setDemoOverride: setDemoOverride
  };
})();