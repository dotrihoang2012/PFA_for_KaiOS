/**
 * keyboard.js — 128-key piano strip renderer.
 * Pre-caches full 128-key spritesheet, draws visible slice per frame.
 * Only re-blits black keys that have highlights.
 */
var Keyboard = (function () {
  'use strict';
  console.log('[Keyboard] module init', typeof Store);

  var cacheCanvas = null;
  var keyLayout   = [];
  var KB_H    = 60;
  var BLACK_H = 36;

  // Piano white-key color presets (Visual → pianoColor setting).
  // Black keys always use the dark palette below.
  var PIANO_COLORS = {
    white: '#f2f2f2',
    ivory: '#f5ecd9',
    ebony: '#d8d2c4',
  };
  var _lastPianoColor = null;
  var _lastKeyW = -1;

  // Note-label state (only painted when Visual → noteLabels=true and theme labels on)
  var NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  var SHOW_OCTAVE = true;

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

  function build(keyW) {
    var tw = buildLayout(keyW);
    if (!cacheCanvas) cacheCanvas = document.createElement('canvas');
    cacheCanvas.width  = Math.ceil(tw) + 4;
    cacheCanvas.height = KB_H;
    var c = cacheCanvas.getContext('2d');

    // Read pianoColor from store; default 'white' keeps parity with original.
    var pianoColor = '#f2f2f2';
    if (typeof Store !== 'undefined') {
      try {
        var s = Store.getState();
        if (s && s.pianoColor && PIANO_COLORS[s.pianoColor]) {
          pianoColor = PIANO_COLORS[s.pianoColor];
        }
      } catch (e) {}
    }
    _lastPianoColor = pianoColor;

    for (var i = 0; i < 128; i++) {
      var k = keyLayout[i];
      if (k.black) continue;
      c.fillStyle = pianoColor;
      c.fillRect(k.x, 0, k.w - 1, KB_H);
    }
    c.strokeStyle = '#aaa';
    c.lineWidth = 0.5;
    for (var j = 0; j < 128; j++) {
      var kj = keyLayout[j];
      if (kj.black) continue;
      c.strokeRect(kj.x, 0, kj.w - 1, KB_H);
    }
    for (var m = 0; m < 128; m++) {
      var bm = keyLayout[m];
      if (!bm.black) continue;
      c.fillStyle = '#1a1a1a';
      c.fillRect(bm.x, 0, bm.w, BLACK_H);
      try {
        var g = c.createLinearGradient(bm.x, 0, bm.x, BLACK_H);
        g.addColorStop(0, '#444');
        g.addColorStop(0.5, '#222');
        g.addColorStop(1, '#0a0a0a');
        c.fillStyle = g;
        c.fillRect(bm.x + 1, BLACK_H * 0.05, bm.w - 2, BLACK_H * 0.9);
      } catch(e) {}
    }
  }

  function draw(state, ctx, w, h) {
    var kw = state.keyWidth || 16;
    // Sync pianoColor from state each frame so live setting changes apply
    // without needing an explicit rebuild path from settings.js.
    if (state.pianoColor && state.pianoColor !== _lastPianoColor) {
      _lastPianoColor = state.pianoColor;
      _lastKeyW = -1; // invalidate cache → rebuild
    }
    if (!cacheCanvas || !keyLayout.length || _lastKeyW === -1) build(kw);
    _lastKeyW = kw;

    var ck = state.camKey || 48;
    // Canvas height already excludes softkey band (see main.js _chromeH),
    // so the piano sits flush with the canvas bottom. KB_H margin guards
    // against tiny h races.
    var y = h - KB_H;
    if (y < 0) y = 0;
    var sx = (ck < 128) ? keyLayout[ck].x : 0;
    var sw = Math.min(w, cacheCanvas.width - sx);

    if (sw > 0) {
      ctx.drawImage(cacheCanvas, sx, 0, sw, KB_H, 0, y, sw, KB_H);
    }
    if (sw < w) {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(sw, y, w - sw, KB_H);
    }

    // Note labels (C/D/E/F/G/A/B) above each white key — opt-in via settings
    try {
      var nl = state.noteLabels;
      // Store object can be a getter default bool false
      if (nl) {
        ctx.fillStyle = 'rgba(60,60,60,0.85)';
        ctx.font = 'bold 8px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var kw2 = kw;
        // Walk 0..127; emit label ONLY on natural C..B white notes.
        for (var nn = 0; nn < 128; nn++) {
          var bn = Constants.isBlackKey(nn % 12);
          if (bn) continue;
          // Only C explicitly (or could emit all natural notes — here we
          // emit the octave letter for every white key so users can pick
          // any scale quickly).
          var noteName = NOTE_NAMES[nn % 12];
          var nm = noteName;
          if (showOctaveOnC(nn)) {
            nm = noteName + Math.floor(nn / 12 - 1); // MIDI 60 = C4
          }
          var klbl = keyLayout[nn];
          if (!klbl) continue;
          if (klbl.x < sx - kw2 || klbl.x > sx + w) continue;
          var px = klbl.x - sx + Math.floor(klbl.w / 2);
          if (px < 0 || px > w) continue;
          ctx.fillText(nm, px, y + 2);
        }
      }
    } catch (e) {}

    // Highlights
    try {
      var live = state._activeList;
      if (!live) live = Sequencer.activeList();
      if (live && live.length) {
        var ns = Sequencer.getTime();
        var wh = [], bh = [];
        var MAX = 80;
        var CH = (typeof Notes !== 'undefined' && Notes.channelColor) ? Notes.channelColor : null;

        var SCAN_LIMIT = 200;
        // ── Trail length: how long past note end does the keyboard stay lit ──
        var trailMs = 0;
        var tl = state.trail;
        if (tl === 'short')       trailMs = 100;
        else if (tl === 'medium') trailMs = 350;
        else if (tl === 'long')   trailMs = 800;
        for (var i = 0; i < live.length && i < SCAN_LIMIT; i++) {
          var nn = live[i].note;
          if (nn < ck || nn > 127) continue;
          var kl = keyLayout[nn];
          if (!kl) continue;
          var ss = live[i].startSec != null ? live[i].startSec : 0;
          var es = live[i].endSec   != null ? live[i].endSec   : ss + 0.5;
          var nsLim = es + trailMs / 1000;
          if (ns < ss || ns > nsLim) continue;
          if (wh.length + bh.length >= MAX) break;
          var dx = kl.x - sx;
          if (dx < -kl.w || dx > w) continue;
          var col = CH ? CH(live[i].channel) : '#00C8FF';
          if (kl.black) bh.push({ dx: dx, w: kl.w, col: col, sx: kl.x });
          else          wh.push({ dx: dx, w: kl.w, col: col });
        }

        // White highlights
        if (wh.length > 0) {
          ctx.globalAlpha = 0.75;
          for (var wi = 0; wi < wh.length; wi++) {
            ctx.fillStyle = wh[wi].col;
            ctx.fillRect(wh[wi].dx, y, wh[wi].w, KB_H);
          }
          ctx.globalAlpha = 1;
        }

        // Re-blit highlighted black keys only
        if (bh.length > 0) {
          ctx.globalAlpha = 1;
          var done = {};
          for (var bi = 0; bi < bh.length; bi++) {
            var sx = bh[bi].sx;
            if (!done[sx]) {
              done[sx] = 1;
              for (var m = 0; m < keyLayout.length; m++) {
                if (keyLayout[m].black && keyLayout[m].x === sx) {
                  ctx.drawImage(cacheCanvas, sx, 0, keyLayout[m].w, BLACK_H,
                                Math.round(bh[bi].dx), y, keyLayout[m].w, BLACK_H);
                  break;
                }
              }
            }
          }
          // Black highlights
          ctx.globalAlpha = 0.75;
          for (var bj = 0; bj < bh.length; bj++) {
            ctx.fillStyle = bh[bj].col;
            ctx.fillRect(bh[bj].dx, y, bh[bj].w, BLACK_H);
          }
          ctx.globalAlpha = 1;
        }
      }
    } catch(e) {}
  }

  /** Force sprite rebuild — call after pianoColor or theme change. */
  function rebuild() {
    _lastKeyW = -1; // invalidates the cache check in main.js
    cacheCanvas = null;
  }

  // Only show octave number on C (so the label is compact and not all-over)
  function showOctaveOnC(nn) {
    return SHOW_OCTAVE && (nn % 12) === 0;
  }

  return { draw: draw, build: build, rebuild: rebuild };
})();