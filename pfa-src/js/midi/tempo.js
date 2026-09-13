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