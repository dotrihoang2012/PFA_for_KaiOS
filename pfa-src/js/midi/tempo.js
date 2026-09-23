/**
 * tempo.js — Convert between MIDI ticks and wall-clock seconds.
 */
var Tempo = {
  map:  [{ t: 0, u: 500000 }],
  div:  480,

  /** tick → seconds */
  toSec: function (tick) {
    var sec = 0, left = tick;
    for (var i = 0; i < this.map.length; i++) {
      var next = (i + 1 < this.map.length) ? this.map[i + 1].t : Infinity;
      var span = Math.min(left, next - this.map[i].t);
      sec += span * this.map[i].u / 1000000 / this.div;
      left -= span;
      if (left <= 0) break;
    }
    return sec;
  },

  /** Usec/qn at tick */
  at: function (tick) {
    for (var i = this.map.length - 1; i >= 0; i--) {
      if (this.map[i].t <= tick) return this.map[i].u;
    }
    return 500000;
  },

  /** Ticks per wall-second at given tick (for seek calc) */
  tps: function (tick) {
    return this.div / (this.at(tick) / 1000000);
  },

  /** seconds → tick (inverse of toSec) */
  toTick: function (sec) {
    var left = sec, tick = 0;
    for (var i = 0; i < this.map.length; i++) {
      var next = (i + 1 < this.map.length) ? this.map[i + 1].t : Infinity;
      var segTicks = next - this.map[i].t;
      var segSec   = segTicks * this.map[i].u / 1000000 / this.div;
      if (left <= segSec) {
        tick += left / (this.map[i].u / 1000000 / this.div);
        return tick;
      }
      tick += segTicks;
      left -= segSec;
    }
    // Past last tempo change
    return tick + left * this.tps(tick);
  },

  /** Current BPM */
  bpm: function (tick) {
    return 60000000 / this.at(tick);
  },

  // Opening-tempo floor (BPM): when a song's FIRST tempo entry is slower than
  // this and a faster tempo follows, the opening is treated as an "absurd
  // intro" (a black-MIDI/DJW style artifact) and playback starts at the NEXT
  // tempo instead. The sequencer-tick map for those files genuinely opens at
  // e.g. 10 BPM for tens of thousands of ticks, which reads as "broken" even
  // though it is faithful to the file.
  SLOW_OPEN_BPM: 30,

  // Upper bound for the in-RAM tempo map. Black MIDIs can carry MILLIONS of
  // tempo events (accelerando/ritardando ramps one or two ticks apart); the
  // map is resampled to roughly this many entries instead of being stored
  // wholesale or — worse — truncated (a truncated map froze the song at the
  // last kept tempo forever). Resampling keeps the end-of-ramp tempo exact.
  MAX_MAP: 65536,

  // Dead-air gap trim (black-MIDI "cut marker"). Some transcriptions author a
  // LONG near-silent stretch at a plain tempo (tens of thousands of ticks with
  // almost no notes) right before a hard tempo return — an edit marker, not
  // music. Playing it verbatim makes the song feel seconds behind where it
  // should be ("BPM hasn't risen yet"). trimDeadAir() compresses such a gap
  // down to DEADGAP.keepSec so the wall clock reaches the return when the
  // piece actually does. ONLY fires for gaps that look like cut markers:
  //   - gap wall length ≥ DEADGAP.minSec
  //   - interior noise ≤ DEADGAP.quietMax notes/second
  //   - BOTH flanks dense enough (≥ DEADGAP.busyFlank notes/second) that this
  //     is clearly a black-MIDI barrage interrupted, not a sung ballad pause
  //   - real notes BEFORE and AFTER the gap (never intro/outro silence)
  // Returns a NEW tempo list (pre-normalise) or null when nothing was cut.
  DEADGAP: {
    minSec: 8,         // an interval shorter than this is a real pause
    keepSec: 2.0,      // the gap is collapsed to roughly this long
quietMax: 12,     // note/sec inside the gap (still "silence")
    busyFlank: 25,     // note/sec on each side for a black-MIDI signature
    denseOverall: 60,  // WHOLE song avg note/sec gate — only ultra-dense
                       // transcriptions (black MIDIs) are ever trimmed, so a
                       // ballad's long real pause is never compressed
    tempoScan: 2,      // seconds AFTER the gap's end still inspected for tempo
                       // build, so a ramp that STARTS at w1 is not flattenable
    tempoLevels: 3,    // ≥3 distinct tempo levels around the window ⇒ the
                       // "quiet" stretch is a real build/bridge (dip/recover,
                       // accelerando), NOT dead air. A cut-marker blank is a
                       // plain hold + ONE return (2 levels max). Flattening a
                       // bridge to keepSec kills the ramp and plays a false
                       // "hold then jump" on the wall clock.
  },

  /** Compress a long dead-air gap found in a dense piece. `notes` must be the
   *  sorted note list [{t,...}] used for playback so density can be measured.
   *  Operates on a RAW tempo list the same way normalize() does. Returns a NEW
   *  tempo list (pre-normalise) or null when nothing was cut. */
  trimDeadAir: function (list, div, notes) {
    var g = this.DEADGAP;
    if (!Array.isArray(notes) || notes.length < 200) return null;
    var norm = this.normalize(list, div, false);
    var base = norm.map, divN = norm.div;
    var evWall = base.map(function (e) { return { t: e.t, u: e.u, w: this._wall(e.t, base, divN) }; }, this);
    var lastWall = evWall[evWall.length - 1].w;
    if (lastWall <= g.minSec + 2) return null;
    // Whole-song density gate: only near-barrages get trimmed.
    if (notes.length / lastWall < g.denseOverall) return null;

    // Note count per 1s bucket, then 2s window sums (bridges a stray louder
    // second that would otherwise fracture the middle of a real gap).
    var nbW = Math.ceil(lastWall / 2);
    var win = new Array(nbW);
    for (var wi = 0; wi < nbW; wi++) win[wi] = 0;
    var quietLim = g.quietMax * 2;
    for (var m = 0; m < notes.length; m++) {
      var nw = this._wall(notes[m].t, base, divN);
      if (nw >= lastWall) break;
      var b = (nw / 2) | 0;
      if (b < nbW) win[b]++;
    }

    var runs = [], r = null;
    for (var bi = 0; bi < nbW; bi++) {
      if (win[bi] <= quietLim) {
        if (!r) r = { s: bi, e: bi };
        else r.e = bi;
      } else if (r) { if (r.e - r.s + 1 >= g.minSec / 2) runs.push(r); r = null; }
    }
    if (r && r.e - r.s + 1 >= g.minSec / 2) runs.push(r);

    for (var ri = 0; ri < runs.length; ri++) {
      var run = runs[ri];
      var w0 = run.s * 2, w1 = (run.e + 1) * 2;
      var avgL = (run.s > 0) ? win[run.s - 1] / 2 : 0;   // notes/sec just before
      var avgR = (run.e + 1 < nbW) ? win[run.e + 1] / 2 : 0;
      if (avgL < g.busyFlank || avgR < g.busyFlank) continue;
      if (w0 <= 2 || w1 >= lastWall - 2) continue;

      var tickA = null, tickB = null, uA = 0, uB = 0;
      for (var ei = 0; ei < evWall.length; ei++) {
        if (evWall[ei].w <= w0) { tickA = evWall[ei].t; uA = evWall[ei].u; }
      }
      for (var ei2 = 0; ei2 < evWall.length; ei2++) {
        if (evWall[ei2].w >= w1) { tickB = evWall[ei2].t; uB = evWall[ei2].u; break; }
      }
      if (tickA === null || tickB === null || tickB <= tickA) continue;
      // The gap must be dead air, not a musical build. If the tempo near the
      // window (gap end + tempoScan lookahead) passes through ≥ tempoLevels
      // DISTINCT levels, this "quiet" stretch is a real bridge — a staircase
      // (dip/recover, accelerando) that the trim would otherwise delete and
      // flatten, making playback hold the old BPM then jump straight to the
      // return. Cut-marker blanks are a plain hold + ONE return, i.e. ≤ 2
      // distinct levels, and still get compressed as intended.
      var levels = {};
      for (var gk = 0; gk < evWall.length; gk++) {
        var gw = evWall[gk].w;
        if (gw < w0 - 1) continue;
        if (gw > w1 + g.tempoScan) break;
        var gb = Math.round(60000000 / evWall[gk].u / 2); // bucket by >2 BPM
        levels[gb] = true;
        if (Object.keys(levels).length >= g.tempoLevels) break;
      }
      if (Object.keys(levels).length >= g.tempoLevels) continue;
      var gapSec = w1 - w0;
      if (gapSec - g.keepSec < 2) continue;
      var uX = (g.keepSec * 1000000 * divN) / (tickB - tickA);
      if (!(uX > 0)) continue;

      var nmap = [];
      for (var k = 0; k < evWall.length; k++) {
        var e = evWall[k];
        if (e.t < tickA) nmap.push({ t: e.t, u: e.u });
        else if (e.t === tickA) nmap.push({ t: e.t, u: uX });
        else if (e.t < tickB) continue;
        else nmap.push({ t: e.t, u: e.u });
      }
      console.log('[Tempo] dead-air trim: ' + gapSec.toFixed(1) + 's gap @' + w0 +
        '-' + w1 + 's -> keep ' + g.keepSec + 's | flanks ' + avgL + '/' + avgR +
        ' n/s | ' + Math.round(60000000 / uA) + '->' + Math.round(60000000 / uB) + ' BPM');
      return nmap;
    }
    return null;
  },

  /** Wall time of one tick under a map (internal, non-mutating). */
  _wall: function (tick, map, div) {
    var sec = 0, left = tick;
    for (var i = 0; i < map.length; i++) {
      var next = (i + 1 < map.length) ? map[i + 1].t : Infinity;
      var span = Math.min(left, next - map[i].t);
      sec += span * map[i].u / 1000000 / div;
      left -= span;
      if (left <= 0) break;
    }
    return sec;
  },

  /** Build a safe, sorted tempo map from a raw list.
   *  - copies the list, keeps only numeric entries with u > 0
   *  - sorts by tick (stable), keeps the FIRST entry at any duplicated tick
   *    (conductor track wins in Format-1), so repeats never change the map
   *  - guarantees a tick-0 entry (spec default when the first change is later),
   *    so toSec/toTick never apply a mid-song tempo to the intro
   *  - optionally "fast-forwards" an absurdly slow opening (< SLOW_OPEN_BPM)
   *    to the next tempo when skipSlow is true (default), giving the
   *    "the song is really N BPM" reading most players report for those files
   *  - clamps non-positive/SMPTE divisions to 480 PPQ
   *  Returns { map: [{t,u}...], div } without mutating this.
   */
  normalize: function (list, div, skipSlow) {
    var d = Number(div);
    if (!(d > 0) || d > 0x7fff) d = 480;

    var raw = [];
    if (list) {
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e) continue;
        var t = Number(e.t), u = Number(e.u);
        if (isFinite(t) && t >= 0 && isFinite(u) && u > 0) raw.push({ t: t, u: u });
      }
    }
    if (!raw.length) return { map: [{ t: 0, u: 500000 }], div: d };

    raw.sort(function (a, b) { return a.t - b.t; });

    var map = [];
    var seenTick = null;
    for (var k = 0; k < raw.length; k++) {
      // Duplicated tick: keep only the FIRST occurrence — in a Format-1 MIDI
      // the conductor (first) track carries the authoritative tempo; later
      // tracks may repeat stale/wrong values (e.g. a leftover "default" or a
      // different-rate event). First-wins also makes the result independent
      // of how many tracks each duplicate appears in.
      if (seenTick !== null && raw[k].t === seenTick) continue;
      seenTick = raw[k].t;
      map.push({ t: raw[k].t, u: raw[k].u });
    }
    if (!map.length || map[0].t > 0) map.unshift({ t: 0, u: 500000 });

    if (skipSlow !== false && map.length >= 2 &&
        map[0].t === 0 && map[0].u > 60000000 / this.SLOW_OPEN_BPM &&
        map[1].u < map[0].u) {
      // Absurdly slow opening → the piece's real start is the next tempo.
      // Keep the boundary tick (the actual first tempo change) so note
      // timing from playback start stays correct, just replay it at the
      // faster tempo. The song's later tempo changes are untouched.
      map[0].u = map[1].u;
    }

    // Pathological maps (millions of events): resample to the budget, keeping
    // the FINAL entry so the song never freezes at a wrong mid-song tempo.
    if (map.length > this.MAX_MAP) {
      var stride = Math.ceil(map.length / this.MAX_MAP);
      var keep = [];
      for (var si = 0; si < map.length; si += stride) keep.push(map[si]);
      if (keep[keep.length - 1] !== map[map.length - 1]) keep.push(map[map.length - 1]);
      map = keep;
    }
    return { map: map, div: d };
  },

  /** Assign a normalised tempo map + division (used by Sequencer.load). */
  setMap: function (list, div, skipSlow) {
    var n = this.normalize(list, div, skipSlow);
    this.map = n.map;
    this.div = n.div;
  }
};