/**
 * keyboard.js — Piano strip renderer (Keyboard Range window).
 * Pre-caches the full 128-key spritesheet, draws only the visible
 * [kbStart..kbEnd] slice per frame. Only re-blits black keys that have
 * highlights.
 *
 * Visual Settings integration:
 *  - pianoSize 'big'|'small'|'none' → strip height 60/32/0 px
 *  - kbStart/kbEnd                  → visible note window (21..108 default)
 *  - pianoColorHex                  → custom white-key fill color
 *  - view3dKeyGlow/view3dGlowColor  → 3D impact glow toggle and RGBA color
 */
var Keyboard = (function () {
  'use strict';
  console.log('[Keyboard] module init', typeof Store);

  var cacheCanvas = null;
  var keyLayout   = [];

  // Strip heights per Visual → Piano Size preset ('none' hides the strip).
  var KB_HEIGHTS = { big: 60, small: 32, none: 0 };

  // Cache-invalidation trackers (geometry + color)
  var _lastKeyW     = -1;
  var _lastSize     = null;
  var _lastPianoHex = null;
  var _lastView3d   = null; // 3D depth flag baked into the sprite

  // Note-label state (only painted when Visual → noteLabels=true and theme labels on)
  var NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  var SHOW_OCTAVE = true;

  /** Strip height in px for the current pianoSize setting ('none' → 0). */
  function height(state) {
    var ps = (state && state.pianoSize) || 'big';
    try { if (typeof window.demoVisualValue === 'function') ps = window.demoVisualValue('pianoSize', ps); } catch (e) {}
    return (KB_HEIGHTS[ps] != null) ? KB_HEIGHTS[ps] : 60;
  }

  /** Black keys are ~60% of the strip height at any size. */
  function blackHeight(kbH) {
    return Math.round(kbH * 0.6);
  }

  /** 'white' is the factory default for the 3D key glow. */
  function keyGlowOn(state, kb3d) {
    if (!kb3d) return false;
    if (state && state.view3dKeyGlow === false) return false;
    return true;
  }

  /** Parse '#rgb'/'#rrggbb'/'rgb()'/'rgba()' into {r,g,b,a:0..1}. */
  function glowRgba(css) {
    var fallback = { r: 255, g: 255, b: 255, a: 1 };
    if (css == null) return fallback;
    var s = String(css).trim();
    if (!s) return fallback;
    var m = s.match(/^rgba?\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*(?:,\s*([+-]?\d+(?:\.\d+)?%?)\s*)?\)$/i);
    if (m) {
      var alpha = 1;
      if (m[4] != null && m[4] !== '') {
        if (m[4].charAt(m[4].length - 1) === '%') alpha = parseFloat(m[4]) / 100;
        else {
          alpha = parseFloat(m[4]);
          if (alpha > 1) alpha = alpha / 100;
        }
      }
      return {
        r: Math.max(0, Math.min(255, Math.round(parseFloat(m[1])))),
        g: Math.max(0, Math.min(255, Math.round(parseFloat(m[2])))),
        b: Math.max(0, Math.min(255, Math.round(parseFloat(m[3])))),
        a: Math.max(0, Math.min(1, isFinite(alpha) ? alpha : 1))
      };
    }
    var h = s.charAt(0) === '#' ? s.substring(1) : s;
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
    return {
      r: parseInt(h.substring(0, 2), 16),
      g: parseInt(h.substring(2, 4), 16),
      b: parseInt(h.substring(4, 6), 16),
      a: 1
    };
  }

  /** Current 3D key-glow color from Visual → Graphics → Effects Colors. */
  function glowColor(state) {
    var css = (state && state.view3dGlowColor) ? state.view3dGlowColor : '#FFFFFF';
    try { if (typeof window.demoVisualValue === 'function') css = window.demoVisualValue('view3dGlowColor', css); } catch (e) {}
    return glowRgba(css);
  }

  /**
   * Draw the upgraded impact glow: an upward halo plus a bright core where
   * the falling note meets the strip. The halo colors follow Effects Colors.
   */
  function drawKeyGlow(ctx, state, hits, y, coreH, kbH) {
    var glow = glowColor(state);
    if (glow.a <= 0) return;
    var glowH = Math.max(4, Math.round(kbH * 0.14));
    var haloH = glowH + coreH;
    var haloOuter = 'rgba(' + glow.r + ',' + glow.g + ',' + glow.b + ',' + (glow.a * 0.18).toFixed(3) + ')';
    var haloInner = 'rgba(' + glow.r + ',' + glow.g + ',' + glow.b + ',' + (glow.a * 0.42).toFixed(3) + ')';
    var core = 'rgba(' + glow.r + ',' + glow.g + ',' + glow.b + ',' + glow.a.toFixed(3) + ')';
    var i, e, innerH;

    ctx.fillStyle = haloOuter;
    for (i = 0; i < hits.length; i++) {
      e = hits[i];
      ctx.fillRect(e.dx, y - glowH, e.w, haloH);
    }

    innerH = Math.ceil(haloH / 2);
    ctx.fillStyle = haloInner;
    for (i = 0; i < hits.length; i++) {
      e = hits[i];
      ctx.fillRect(e.dx, y - glowH + haloH - innerH, e.w, innerH);
    }

    ctx.fillStyle = core;
    for (i = 0; i < hits.length; i++) {
      e = hits[i];
      ctx.fillRect(e.dx, y, e.w, coreH);
    }
  }

  function buildLayout(keyW) {
    keyLayout = [];
    var x = 0;
    for (var i = 0; i < 128; i++) {
      var b = Constants.isBlackKey(i % 12);
      var w = b ? Math.round(keyW * 0.6) : keyW;
      var kx = b ? Math.round(x - w * 0.5) : x;
      keyLayout.push({ x: kx, w: w, black: b });
      if (!b) x += keyW;
    }
    return x;
  }

  function build(keyW, kbH, is3d) {
    // Defensive default — external callers may omit the strip height.
    if (!kbH) kbH = height(null);
    var bh = blackHeight(kbH);
    var tw = buildLayout(keyW);
    if (!cacheCanvas) cacheCanvas = document.createElement('canvas');
    cacheCanvas.width  = Math.ceil(tw) + 4;
    cacheCanvas.height = kbH;
    var c = cacheCanvas.getContext('2d');

    // White-key fill — Visual → Piano Color (custom hex/rgba string,
    // default near-white). Read live from the Store so the sprite is
    // always in sync with the persisted setting.
    var pianoColor = '#f2f2f2';
    if (typeof Store !== 'undefined') {
      try {
        var s = Store.getState();
        if (s && typeof s.pianoColorHex === 'string' && s.pianoColorHex) {
          pianoColor = s.pianoColorHex;
        }
      } catch (e) {}
    }
    _lastPianoHex = pianoColor;

    for (var i = 0; i < 128; i++) {
      var k = keyLayout[i];
      if (k.black) continue;
      c.fillStyle = pianoColor;
      c.fillRect(k.x, 0, k.w - 1, kbH);
    }
    c.strokeStyle = '#aaa';
    c.lineWidth = 0.5;
    for (var j = 0; j < 128; j++) {
      var kj = keyLayout[j];
      if (kj.black) continue;
      c.strokeRect(kj.x, 0, kj.w - 1, kbH);
    }
    for (var m = 0; m < 128; m++) {
      var bm = keyLayout[m];
      if (!bm.black) continue;
      c.fillStyle = '#1a1a1a';
      c.fillRect(bm.x, 0, bm.w, bh);
      try {
        var g = c.createLinearGradient(bm.x, 0, bm.x, bh);
        g.addColorStop(0, '#444');
        g.addColorStop(0.5, '#222');
        g.addColorStop(1, '#0a0a0a');
        c.fillStyle = g;
        c.fillRect(bm.x + 1, bh * 0.05, bm.w - 2, bh * 0.9);
      } catch(e) {}
    }

    // 3D depth (Graphics → 3D View 'keyboard'/'both'): white keys carry a
    // soft shadow tucked under the bar; black keys catch a 1px light on
    // the top edge; every key gets a darker, slightly recessed FRONT face
    // split from the top surface by a horizontal crease — the classic 3D
    // key profile. Baked into the cached sprite — zero per-frame cost.
    if (is3d) {
      c.fillStyle = 'rgba(0,0,0,0.28)';
      for (var s3 = 0; s3 < 128; s3++) {
        var ks3 = keyLayout[s3];
        if (ks3.black) continue;
        c.fillRect(ks3.x, 0, ks3.w - 1, 3);
      }
      c.fillStyle = 'rgba(255,255,255,0.20)';
      for (var s4 = 0; s4 < 128; s4++) {
        var ks4 = keyLayout[s4];
        if (!ks4.black) continue;
        c.fillRect(ks4.x + 1, 0, ks4.w - 2, 1);
      }
      // Front face height: ~5% of the strip (min 2px so it shows at any size).
      var frontH = Math.max(2, Math.round(kbH * 0.05));
      var frontY = kbH - frontH;
      // White keys — front face darkened via a translucent black overlay
      // (works over ANY piano color), inset 1px each side so the face sits
      // back from the top surface.
      c.fillStyle = 'rgba(0,0,0,0.45)';
      for (var s5 = 0; s5 < 128; s5++) {
        var ks5 = keyLayout[s5];
        if (ks5.black) continue;
        c.fillRect(ks5.x + 1, frontY + 1, ks5.w - 3, frontH - 1);
      }
      // White keys — the crease: horizontal line separating top from front.
      c.fillStyle = 'rgba(0,0,0,0.5)';
      for (var s6 = 0; s6 < 128; s6++) {
        var ks6 = keyLayout[s6];
        if (ks6.black) continue;
        c.fillRect(ks6.x, frontY, ks6.w - 1, 1);
      }
      // Black keys — deeper front base, inset 1px each side, plus a subtle
      // light crease so the separation reads on the dark surface.
      var bhFront = Math.max(2, Math.round(bh * 0.05));
      c.fillStyle = 'rgba(0,0,0,0.5)';
      for (var s7 = 0; s7 < 128; s7++) {
        var ks7 = keyLayout[s7];
        if (!ks7.black) continue;
        c.fillRect(ks7.x + 1, bh - bhFront, ks7.w - 2, bhFront);
      }
      c.fillStyle = 'rgba(255,255,255,0.16)';
      for (var s8 = 0; s8 < 128; s8++) {
        var ks8 = keyLayout[s8];
        if (!ks8.black) continue;
        c.fillRect(ks8.x + 1, bh - bhFront, ks8.w - 2, 1);
      }
    }
  }

  function draw(state, ctx, w, h) {
    var kw = state.keyWidth || 16;
    try { if (typeof window.demoVisualValue === 'function') kw = window.demoVisualValue('keyWidth', kw); } catch (e) {}
    // Piano Size 'none' hides the strip entirely — nothing to draw.
    var kbH = height(state);
    if (!kbH) return;

    // 3D keyboard gate — Graphics → 3D View 'keyboard' or 'both'.
    var v3d = (state.view3d != null) ? state.view3d : 'both';
    try { if (typeof window.demoVisualValue === 'function') v3d = window.demoVisualValue('view3d', v3d); } catch (e) {}
    var kb3d = (v3d === 'keyboard' || v3d === 'both');
    var glowOn = keyGlowOn(state, kb3d);

    // Rebuild the spritesheet whenever keyWidth, strip size, color or the
    // 3D depth flag changed.
    var hexChanged = ((state.pianoColorHex || '#f2f2f2') !== _lastPianoHex);
    if (!cacheCanvas || !keyLayout.length ||
        _lastKeyW !== kw || _lastSize !== kbH || hexChanged || kb3d !== _lastView3d) {
      build(kw, kbH, kb3d);
      _lastKeyW = kw;
      _lastSize = kbH;
      _lastView3d = kb3d;
    }

    // Visible window — Keyboard Range [kbStart..kbEnd] replaces the old
    // camKey scroll (Left/Right are bound to seeking now).
    // kbSize 'dynamic' auto-expands past 88 keys for out-of-range notes.
    var _kbdr = (typeof Notes !== 'undefined' && Notes.dynRange)
      ? Notes.dynRange(state) : { start: null, end: null };
    var startN = (_kbdr.start != null) ? _kbdr.start
      : ((state.kbStart != null) ? state.kbStart : 21);
    var endN   = (_kbdr.end != null) ? _kbdr.end
      : ((state.kbEnd   != null) ? state.kbEnd   : 108);
    try {
      if (typeof window.demoVisualValue === 'function') {
        startN = window.demoVisualValue('kbStart', startN);
        endN   = window.demoVisualValue('kbEnd', endN);
      }
    } catch (e) {}
    startN = Math.max(0, Math.min(127, startN));
    endN   = Math.max(startN + 1, Math.min(127, endN));

    // Canvas height already excludes softkey band (see main.js _chromeH),
    // so the piano sits flush with the canvas bottom.
    var y = h - kbH;
    if (y < 0) y = 0;

    var bh2 = blackHeight(kbH);
    var x0 = keyLayout[startN].x;
    var lastK = keyLayout[endN];
    // Slice width: from first key in range to just past the last one.
    var sw = (lastK.x + lastK.w) - x0;

    if (sw > 0 && w > 0) {
      // Stretch the slice to the FULL canvas width. With float auto-fit
      // the scale factor is ~1.0 (sub-pixel); it only becomes noticeable
      // when the range starts/ends on black keys — and it guarantees
      // there is never dead space on the right edge of the piano.
      ctx.drawImage(cacheCanvas, x0, 0, sw, kbH, 0, y, w, kbH);
    }

    // Note labels (C/D/E/F/G/A/B) on white keys — opt-in via settings.
    // Text is scaled to each key's width and drawn at the BOTTOM of the
    // key (below the overhanging black-key region so nothing overlaps).
    try {
      var nl = state.noteLabels;
      // Store object can be a getter default bool false
      if (nl) {
        ctx.fillStyle = 'rgba(60,60,60,0.85)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        // Walk only the visible range [startN..endN]; emit label ONLY on
        // natural C..B white notes.
        for (var nn = startN; nn <= endN; nn++) {
          var bn = Constants.isBlackKey(nn % 12);
          if (bn) continue;
          // Emit the octave letter for every white key so users can pick
          // any scale quickly; octave number only on C.
          var noteName = NOTE_NAMES[nn % 12];
          var nm = noteName;
          if (showOctaveOnC(nn)) {
            nm = noteName + Math.floor(nn / 12 - 1); // MIDI 60 = C4
          }
          var klbl = keyLayout[nn];
          if (!klbl) continue;
          // Font scales with the key's width — narrower keys draw smaller
          // text so labels never overflow onto neighbours.
          var fs = Math.max(5, Math.min(9, Math.floor(klbl.w * 0.5)));
          ctx.font = 'bold ' + fs + 'px Arial, sans-serif';
          var px = klbl.x - x0 + Math.floor(klbl.w / 2);
          if (px < 0 || px > w) continue;
          // Draw at the bottom of the white key (2px above the strip edge).
          ctx.fillText(nm, px, y + kbH - 2);
        }
      }
    } catch (e) {}

    // Highlights
    try {
      var live = state._activeList;
      if (!live) {
        try {
          live = (typeof Sequencer.audioList === 'function')
            ? Sequencer.audioList()
            : Sequencer.activeList();
          // audioList empty → use activeList but only take up to 128 notes near nowSec
          // Fallback: audioList empty (Black MIDI notes too short)
          if (!live || !live.length) {
            var all = Sequencer.activeList();
            var ns2 = Sequencer.getTime();
            live = [];
            for (var fi = 0; fi < all.length; fi++) {
              var fa = all[fi];
              // Black MIDI: notes rat ngan, dung window rong de bat duoc
              if (fa.startSec <= ns2 + 0.5 && fa.endSec >= ns2 - 0.5) {
                live.push(fa);
                if (live.length >= 256) break;
              }
            }
          }
        } catch (e) { live = []; }
      }
      if (live && live.length) {
        var ns = Sequencer.getTime();
        var wh = [], bhl = [];
        // Dedupe per key: the TOP overlapping note wins — on the falling band
        // the last-drawn note covers the earlier ones, so the lit key shows
        // the SAME resulting color the falling notes display at the overlap
        // (later live entries overwrite earlier ones → "last wins"). Each key
        // still draws exactly ONCE so alpha never accumulates (no darkening).
        var _whMap = {}, _bhMap = {};
        var CH = (typeof Notes !== 'undefined' && Notes.channelColor) ? Notes.channelColor : null;
        var SCAN_LIMIT = 1180591620717411303424;
        // Trail: state.trail is a number 0.1..8.0 (seconds × scale)
        var trailMs = 0;
        var tl = state.trail;
        try { if (typeof window.demoVisualValue === 'function') tl = window.demoVisualValue('trail', tl); } catch (e) {}
        if (tl != null && isFinite(tl)) {
          trailMs = tl * 200; // 1.0 → 200ms, 8.0 → 1600ms, 0.1 → 20ms
        }
        for (var i = 0; i < live.length && i < SCAN_LIMIT; i++) {
          var nn = live[i].note;
          // Only notes inside the visible Keyboard Range light up keys
          if (nn < startN || nn > endN) continue;
          var kl = keyLayout[nn];
          if (!kl) continue;
          var ss = live[i].startSec != null ? live[i].startSec : 0;
          var es = live[i].endSec   != null ? live[i].endSec   : ss + 0.5;
          var nsLim = es + trailMs / 1000;
          if (ns < ss || ns > nsLim) continue;
          var dx = kl.x - x0;
          if (dx < -kl.w || dx > w) continue;
          // Overlapping same-pitch notes (fast rolls, doubled tracks) would
          // fill the semi-transparent highlight N times on ONE key → alpha
          // accumulates → the key reads darker than a single note. Dedupe
          // by key so every lit key is drawn exactly ONCE per frame.
          var col = CH ? CH(live[i].channel) : '#00C8FF';
          if (kl.black) {
            _bhMap[nn] = { dx: dx, w: kl.w, col: col, sx: kl.x };
          } else {
            _whMap[nn] = { dx: dx, w: kl.w, col: col };
          }
        }
        // Collapse the maps into the draw lists (key order = ascending note).
        for (var _wk in _whMap) wh.push(_whMap[_wk]);
        for (var _bk in _bhMap) bhl.push(_bhMap[_bk]);

        // White highlights (drawn UNDER the black keys — they are re-blitted
        // below so a lit white key's glow never washes over the black key
        // that overlaps it).
        if (wh.length > 0) {
          ctx.globalAlpha = kb3d ? 0.92 : 0.75;
          for (var wi = 0; wi < wh.length; wi++) {
            ctx.fillStyle = wh[wi].col;
            ctx.fillRect(wh[wi].dx, y, wh[wi].w, kbH);
          }
          ctx.globalAlpha = 1;
          // 3D pop: configurable impact glow where the lit key meets the bar.
          if (glowOn) drawKeyGlow(ctx, state, wh, y, 2, kbH);
        }

        // Re-blit EVERY black key in the visible window whenever a white
        // highlight was drawn. Black keys overhang onto the adjacent white
        // keys, so their base sprite must sit back on top of any white glow.
        if (wh.length > 0) {
          ctx.globalAlpha = 1;
          for (var bk = 0; bk < keyLayout.length; bk++) {
            var bky = keyLayout[bk];
            if (!bky.black) continue;
            if (bky.x < x0 || bky.x > lastK.x + lastK.w) continue;
            ctx.drawImage(cacheCanvas, bky.x, 0, bky.w, bh2,
                          Math.round(bky.x - x0), y, bky.w, bh2);
          }
        }

        // Black highlights (on top of the re-blitted black keys).
        if (bhl.length > 0) {
          ctx.globalAlpha = kb3d ? 0.92 : 0.75;
          for (var bj = 0; bj < bhl.length; bj++) {
            ctx.fillStyle = bhl[bj].col;
            ctx.fillRect(bhl[bj].dx, y, bhl[bj].w, bh2);
          }
          ctx.globalAlpha = 1;
          // 3D pop: configurable impact glow where the lit key meets the bar.
          if (glowOn) drawKeyGlow(ctx, state, bhl, y, 1, kbH);
        }
      }
    } catch(e) {}
  }

  /** Force sprite rebuild — call after piano color or size change. */
  function rebuild() {
    _lastKeyW     = -1; // invalidates the cache check in main.js + draw()
    _lastSize     = null;
    _lastPianoHex = null;
    _lastView3d   = null;
    cacheCanvas   = null;
  }

  /**
   * Effective visible range [startN..endN] — same math as draw()
   * (demo self-play forces 21..108 via demoVisualValue).
   */
  function _visibleRange(state) {
    var _vrdr = (typeof Notes !== 'undefined' && Notes.dynRange)
      ? Notes.dynRange(state) : { start: null, end: null };
    var startN = (_vrdr.start != null) ? _vrdr.start
      : ((state && state.kbStart != null) ? state.kbStart : 21);
    var endN   = (_vrdr.end != null) ? _vrdr.end
      : ((state && state.kbEnd   != null) ? state.kbEnd   : 108);
    try {
      if (typeof window.demoVisualValue === 'function') {
        startN = window.demoVisualValue('kbStart', startN);
        endN   = window.demoVisualValue('kbEnd', endN);
      }
    } catch (e) {}
    startN = Math.max(0, Math.min(127, startN));
    endN   = Math.max(startN + 1, Math.min(127, endN));
    return { startN: startN, endN: endN };
  }

  /**
   * Return the canvas x-coordinate of the CENTER of a MIDI note within
   * the currently visible range, or null if the note is outside it.
   * When `width` is given the slice is stretched to full canvas width
   * (same math as draw()'s blit), so the returned x FLEXES with the
   * keyboard layout — used by main.js to position the middle marker dot
   * dead-center on its key at any zoom.
   */
  function keyX(note, state, width) {
    if (!keyLayout.length) return null;
    var vr = _visibleRange(state);
    var startN = vr.startN, endN = vr.endN;
    if (note < startN || note > endN) return null;
    var x0 = keyLayout[startN].x;
    var off = keyLayout[note].x - x0;
    var kw2 = keyLayout[note].w / 2;
    // Horizontal scale draw() applies: source slice sw → canvas width.
    if (width != null && width > 0) {
      var lastK = keyLayout[endN];
      var sw = (lastK.x + lastK.w) - x0;
      if (sw > 0) {
        var scale = width / sw;
        return (off + kw2) * scale;
      }
    }
    return off + kw2;
  }

  /**
   * Canvas x-center of MIDDLE C (MIDI 60) within the visible range, or
   * null when C4 is outside it. Middle C is the conventional "middle of
   * the piano" mark (like the gray dot on real 88-key strips) — the
   * single source of truth for the middle marker dot.
   */
  var MIDDLE_C = 60;
  function middleCX(state, width) {
    if (!keyLayout.length) return null;
    var vr = _visibleRange(state);
    if (MIDDLE_C < vr.startN || MIDDLE_C > vr.endN) return null;
    return keyX(MIDDLE_C, state, width);
  }

  // Only show octave number on C (so the label is compact and not all-over)
  function showOctaveOnC(nn) {
    return SHOW_OCTAVE && (nn % 12) === 0;
  }

  return { draw: draw, build: build, rebuild: rebuild, height: height, blackHeight: blackHeight, keyX: keyX, middleCX: middleCX };
})();