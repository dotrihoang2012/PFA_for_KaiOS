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

  /** Current BPM */
  bpm: function (tick) {
    return 60000000 / this.at(tick);
  }
};