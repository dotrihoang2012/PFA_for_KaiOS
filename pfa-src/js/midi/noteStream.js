/**
 * noteStream.js — PFA2 binary .note streaming reader.
 *
 * Opens a PFA2 .note File straight from DeviceStorage and serves note records
 * by index from a sliding in-RAM window (disk-backed), so a huge converted
 * file (millions of notes) can be PLAYED without ever holding all notes in
 * memory. The sequencer only ever touches the provider through:
 *     .length   → total note count (also used by HUD + seek gates)
 *     .at(i)    → {t,c,n,v,d} for note index i (readyAt(i) must be true)
 *     .readyAt(i)          → true when note i's window is loaded
 *     .prefetch(i)         → async, fire-and-forget ensure window(s) for i
 *     .prepare(tick)       → Promise<cursorIndex> first note with t >= tick
 *
 * Binary layout (StreamParser.buildHeader / packNotes):
 *   20-byte header  : magic "PFA2" (u32 LE), version (u32), div (u32),
 *                     numTempo (u32), numNotes (u32)
 *   numTempo × 8B   : tempo records {t: u32, u: u32}
 *   numNotes × 12B  : {t: u32, c: u8, n: u8, v: u8, rsv: u8, d: u32}
 * Notes are GLOBALLY sorted ascending by t.
 */
var NoteStream = (function () {
  'use strict';

  var MAGIC        = 0x32414650; // "PFA2" (LE bytes 'P','F','A','2')
  var VERSION      = 2;
  var NOTE_SIZE    = 12;
  var HEADER_BASE  = 20;

  var WINDOW_NOTES = 43690; // 524280 bytes per window (multiple of NOTE_SIZE,
                            // same size as streamParser's merge window)

  // Low-level Blob slice read. KaiOS 2.5 (Gecko 48) has no Blob.arrayBuffer(),
  // so use FileReader there; modern/Node use the spec path.
  function readSliceAB(blob, start, len) {
    var b;
    try { b = blob.slice(start, start + len); } catch (e) { return Promise.reject(e); }
    console.log('[NoteStream] readSliceAB start=' + start + ' len=' + len + ' blob.size=' + blob.size + ' slice.size=' + b.size);
    if (typeof b.arrayBuffer === 'function') {
      return Promise.resolve(b.arrayBuffer()).then(function (ab) {
        if (!ab || ab.byteLength !== len) throw new Error('slice size mismatch got=' + (ab && ab.byteLength) + ' want=' + len);
        return ab;
      });
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      function doRes(v) { if (!settled) { settled = true; resolve(v); } }
      function doRej(e) { if (!settled) { settled = true; reject(e); } }
      var fr = new FileReader();
      fr.onload = function () { clearTimeout(t); console.log('[NoteStream] FR.onload len=' + (fr.result && fr.result.byteLength)); doRes(fr.result); };
      fr.onerror = function () { clearTimeout(t); console.error('[NoteStream] FR.onerror'); doRej(new Error('readSliceAB failed')); };
      var t = setTimeout(function () { try { fr.abort(); } catch (e) {} console.error('[NoteStream] readSliceAB TIMEOUT start=' + start + ' len=' + len); doRej(new Error('readSliceAB timeout')); }, 20000);
      fr.readAsArrayBuffer(b);
    });
  }

  function open(blob) {
    return readSliceAB(blob, 0, HEADER_BASE).then(function (hdr) {
      var dv = new DataView(hdr);
      if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a PFA2 .note file');
      if (dv.getUint32(4, true) !== VERSION) throw new Error('Unsupported PFA2 version');
      var div      = dv.getUint32(8, true);
      var numTempo = dv.getUint32(12, true);
      var numNotes = dv.getUint32(16, true);

      var tempoBytes = numTempo * 8;
      return readSliceAB(blob, HEADER_BASE, tempoBytes).then(function (tbuf) {
        var td = new DataView(tbuf);
        var tempo = [];
        for (var i = 0; i < numTempo; i++) {
          tempo.push({ t: td.getUint32(i * 8, true), u: td.getUint32(i * 8 + 4, true) });
        }
        if (!tempo.length) tempo.push({ t: 0, u: 500000 });

        var numWins = Math.ceil(numNotes / WINDOW_NOTES);
        var dataStart = HEADER_BASE + tempoBytes;
        var winBytes  = WINDOW_NOTES * NOTE_SIZE;

        var slotA = { w: -1, ab: null, dv: null, first: 0, tick: 0, use: 0 };
        var slotB = { w: -1, ab: null, dv: null, first: 0, tick: 0, use: 0 };
        var bound = [];          // bound[w] = first tick of window w (lazy, counter)
        var useSeq = 0;
        var loader = null;       // in-flight { w, p }
        var XV = { t: 0, c: 0, n: 0, v: 0, d: 0 };

        function slots() { return [slotA, slotB]; }
        function slotFor(w) {
          if (slotA.w === w) return slotA;
          if (slotB.w === w) return slotB;
          return null;
        }
        function pickSlot() {
          var a = slotA, b = slotB;
          if (a.w === -1) return a;
          if (b.w === -1) return b;
          return (a.use <= b.use) ? a : b;
        }

        function winIdxOf(i) { return (i / WINDOW_NOTES) | 0; }

        // Load window w → DataView into an LRU slot, record bound[w].
        function load(w) {
          if (w < 0 || w >= numWins) return Promise.resolve(null);
          var start = dataStart + w * winBytes;
          if (start >= blob.size) { bound[w] = Infinity; return Promise.resolve(null); }
          var len = Math.min(winBytes, blob.size - start);
          return readSliceAB(blob, start, len).then(function (ab) {
            var d = new DataView(ab);
            var slot = pickSlot();
            slot.w = w; slot.ab = ab; slot.dv = d;
            slot.first = w * WINDOW_NOTES;
            slot.tick = (d.byteLength >= NOTE_SIZE) ? d.getUint32(0, true) : Infinity;
            slot.use = ++useSeq;
            if (bound[w] === undefined) bound[w] = slot.tick;
            return slot;
          });
        }

        function boundAsync(w) {
          if (w >= numWins) return Promise.resolve(Infinity);
          if (bound[w] !== undefined) return Promise.resolve(bound[w]);
          var s = slotFor(w);
          if (s) { bound[w] = s.tick; return Promise.resolve(bound[w]); }
          return load(w).then(function (slot) {
            bound[w] = slot ? slot.tick : Infinity;
            return bound[w];
          });
        }

        // First index with t >= tick, walking within an already-loaded window.
        function scanGE(w, tick, minIdx) {
          var s = slotFor(w);
          if (!s || !s.dv) return -1;
          var from = Math.max(s.first, minIdx || 0);
          var to = Math.min(numNotes, s.first + WINDOW_NOTES);
          var dv = s.dv;
          for (var i = from; i < to; i++) {
            var o = (i - s.first) * NOTE_SIZE;
            if (dv.getUint32(o, true) >= tick) return i;
          }
          return -2; // not in this window → look ahead
        }

        var ns = {
          blob: blob,
          div: div,
          tempoMap: tempo,
          length: numNotes,
          dataStart: dataStart,
          WINDOW_NOTES: WINDOW_NOTES,

          count: function () { return numNotes; },
          winIdxOf: winIdxOf,
          slots: slots,

          readyAt: function (i) {
            if (i < 0 || i >= numNotes) return false;
            return !!slotFor(winIdxOf(i));
          },

          at: function (i) {
            var s = slotFor(winIdxOf(i));
            if (!s || !s.dv) return null;
            var o = (i - s.first) * NOTE_SIZE;
            var d = s.dv;
            XV.t = d.getUint32(o, true);
            XV.c = d.getUint8(o + 4);
            XV.n = d.getUint8(o + 5);
            XV.v = d.getUint8(o + 6);
            XV.d = d.getUint32(o + 8, true);
            return XV;
          },

          // Fire-and-forget: ensure the window containing note i (and, when a
          // slot is free, the NEXT one) is loaded. Single-flight.
          prefetch: function (i) {
            var w = winIdxOf(Math.max(0, Math.min(i, numNotes - 1)));
            if (w < 0 || w >= numWins) return;
            if (slotFor(w)) { this.prefetchNext(w); return; }
            if (loader) return;
            var self = this;
            loader = { w: w, p: load(w).then(function () {
              loader = null;
              try { self.prefetchNext(w); } catch (e) {}
            }).catch(function () { loader = null; }) };
          },

          prefetchNext: function (w) {
            var nw = w + 1;
            if (nw >= numWins || slotFor(nw) || loader) return;
            var self = this;
            loader = { w: nw, p: load(nw).then(function () {
              loader = null;
            }).catch(function () { loader = null; }) };
          },

          // Resolve when note i's window is loaded (used by tests).
          whenReady: function (i) {
            var w = winIdxOf(Math.max(0, Math.min(i, numNotes - 1)));
            if (w < 0 || w >= numWins) return Promise.resolve();
            if (slotFor(w)) return Promise.resolve();
            if (loader) {
              return loader.p.then(function () {
                return slotFor(w) ? Promise.resolve() : load(w).then(function () {});
              });
            }
            var self = this;
            var p = load(w);
            loader = { w: w, p: p.then(function () {
              loader = null;
            }).catch(function () { loader = null; }) };
            return p.then(function () {});
          },

          // Binary search over window boundary ticks → load the target window
          // → resolve the first index with t >= tick. O(log(numWins)) reads.
          prepare: function (tick) {
            if (numNotes === 0) return Promise.resolve(0);
            var lo = 0, hi = numWins;
            function step() {
              if (hi - lo <= 1) return settle(lo);
              var mid = (lo + hi) >> 1;
              return boundAsync(mid).then(function (t) {
                if (t <= tick) lo = mid; else hi = mid;
                return step();
              });
            }
            function settle(w) {
              if (w >= numWins) return numNotes;
              var s = slotFor(w);
              return (s ? Promise.resolve(s) : load(w)).then(function (slot) {
                if (!slot) return 0;
                var res = scanGE(w, tick, 0);
                if (res >= 0) return res;
                // Not found in w → move to the next window (or end of file).
                if (res === -2 && w + 1 < numWins) {
                  return load(w + 1).then(function () {
                    var r2 = scanGE(w + 1, tick, 0);
                    return r2 >= 0 ? r2 : numNotes;
                  });
                }
                return numNotes;
              });
            }
            return step();
          }
        };

        return ns;
      });
    });
  }

  return {
    open: open,
    WINDOW_NOTES: WINDOW_NOTES,
    NOTE_SIZE: NOTE_SIZE,
    HEADER_BASE: HEADER_BASE
  };
})();

// Node (tools / tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NoteStream;
}
if (typeof window !== 'undefined') {
  window.NoteStream = NoteStream;
}