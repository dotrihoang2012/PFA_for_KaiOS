/**
 * keyboard.js — Piano strip renderer (Keyboard Range window).
 * Pre-caches the full 128-key spritesheet, draws only the visible
 * [kbStart..kbEnd] slice per frame. Only re-blits black keys that have
 * highlights.
 *
 * Visual Settings integration:
 *   - pianoSize 'big'|'small'|'none' → strip height 60/32/0 px
 *   - kbStart/kbEnd                  → visible note window (21..108 default)
 *   - pianoColorHex                  → custom white-key fill color
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

  function build(keyW, kbH) {
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
  }

  function draw(state, ctx, w, h) {
    var kw = state.keyWidth || 16;
    try { if (typeof window.demoVisualValue === 'function') kw = window.demoVisualValue('keyWidth', kw); } catch (e) {}
    // Piano Size 'none' hides the strip entirely — nothing to draw.
    var kbH = height(state);
    if (!kbH) return;

    // Rebuild the spritesheet whenever keyWidth, strip size or color changed.
    var hexChanged = ((state.pianoColorHex || '#f2f2f2') !== _lastPianoHex);
    if (!cacheCanvas || !keyLayout.length ||
        _lastKeyW !== kw || _lastSize !== kbH || hexChanged) {
      build(kw, kbH);
      _lastKeyW = kw;
      _lastSize = kbH;
    }

    // Visible window — Keyboard Range [kbStart..kbEnd] replaces the old
    // camKey scroll (Left/Right are bound to seeking now).
    var startN = (state.kbStart != null) ? state.kbStart : 21;
    var endN   = (state.kbEnd   != null) ? state.kbEnd   : 108;
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
          // audioList rỗng → dùng activeList nhưng chỉ lấy tối đa 128 notes gần nowSec
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
          var col = CH ? CH(live[i].channel) : '#00C8FF';
          if (kl.black) bhl.push({ dx: dx, w: kl.w, col: col, sx: kl.x });
          else          wh.push({ dx: dx, w: kl.w, col: col });
        }

        // White highlights (drawn UNDER the black keys — they are re-blitted
        // below so a lit white key's glow never washes over the black key
        // that overlaps it).
        if (wh.length > 0) {
          ctx.globalAlpha = 0.75;
          for (var wi = 0; wi < wh.length; wi++) {
            ctx.fillStyle = wh[wi].col;
            ctx.fillRect(wh[wi].dx, y, wh[wi].w, kbH);
          }
          ctx.globalAlpha = 1;
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
          ctx.globalAlpha = 0.75;
          for (var bj = 0; bj < bhl.length; bj++) {
            ctx.fillStyle = bhl[bj].col;
            ctx.fillRect(bhl[bj].dx, y, bhl[bj].w, bh2);
          }
          ctx.globalAlpha = 1;
        }
      }
    } catch(e) {}
  }

  /** Force sprite rebuild — call after piano color or size change. */
  function rebuild() {
    _lastKeyW     = -1; // invalidates the cache check in main.js + draw()
    _lastSize     = null;
    _lastPianoHex = null;
    cacheCanvas   = null;
  }

  // Only show octave number on C (so the label is compact and not all-over)
  function showOctaveOnC(nn) {
    return SHOW_OCTAVE && (nn % 12) === 0;
  }

  return { draw: draw, build: build, rebuild: rebuild, height: height };
})();