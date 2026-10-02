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

  var WINDOW_NOTES = 131070; // 1572840 bytes per window (~1.5MB): at black-
                             // MIDI peak density a 43k window covers <1s of
                             // song → relentless reloads exactly when the CPU
                             // is busiest. 3x fewer loads, same total bytes;
                             // 4 slots pin ~6MB (fine on 512MB).

  // Per-read logging costs real time at ~1 window/s during dense passages;
  // enable it from the console with  window.PFA_DEBUG_STREAM = 1
  function dbg() { return typeof window !== 'undefined' && !!window.PFA_DEBUG_STREAM; }

  // Low-level Blob slice read. KaiOS 2.5 (Gecko 48) has no Blob.arrayBuffer(),
  // so use FileReader there; modern/Node use the spec path.
  function readSliceAB(blob, start, len) {
    var b;
    try { b = blob.slice(start, start + len); } catch (e) { return Promise.reject(e); }
    if (dbg()) console.log('[NoteStream] readSliceAB start=' + start + ' len=' + len + ' blob.size=' + blob.size + ' slice.size=' + b.size);
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
      fr.onload = function () { clearTimeout(t); if (dbg()) console.log('[NoteStream] FR.onload len=' + (fr.result && fr.result.byteLength)); doRes(fr.result); };
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

        // Window cache. History: two LRU slots + single-flight only on the
        // prefetch path meant a seek/fast-forward `prepare` could load a window
        // that was already (being) loaded, or evict the window the cursor was
        // reading; on a dense passage every window was then read 2-3x and the
        // sequencer stalled on !readyAt() while the notefall ran dry.
        //   * every window is read at most once at a time (inflight map)
        //   * the cursor's window (pinW) is never evicted
        //   * windows behind the cursor go first, then those far ahead
        //   * the next AHEAD windows are loaded in order, one read at a time
        var MAXSLOTS = 4;
        var AHEAD    = 2;
        var wins     = [];       // loaded windows: { w, ab, dv, first, tick, use }
        var inflight = {};       // w -> Promise<slot|null>
        var bound    = [];       // bound[w] = first tick of window w (lazy)
        var useSeq   = 0;
        var pinW     = 0;        // window holding the cursor
        var pumping  = false;
        var XV = { t: 0, c: 0, n: 0, v: 0, d: 0 };

        function slots() { return wins.slice(); }
        function slotFor(w) {
          for (var i = 0; i < wins.length; i++) if (wins[i].w === w) return wins[i];
          return null;
        }
        function winIdxOf(i) { return (i / WINDOW_NOTES) | 0; }

        function place(slot) {
          if (wins.length < MAXSLOTS) { wins.push(slot); return; }
          if (slot.w < pinW) return;                 // stale arrival, behind the cursor
          var vi = -1, i, s;
          for (i = 0; i < wins.length; i++) {        // farthest behind the cursor
            s = wins[i];
            if (s.w < pinW && (vi < 0 || s.w < wins[vi].w)) vi = i;
          }
          if (vi < 0) for (i = 0; i < wins.length; i++) {   // farthest ahead
            s = wins[i];
            if (s.w > pinW + AHEAD && (vi < 0 || s.w > wins[vi].w)) vi = i;
          }
          if (vi < 0) for (i = 0; i < wins.length; i++) {   // plain LRU, never pinW
            s = wins[i];
            if (s.w !== pinW && (vi < 0 || s.use < wins[vi].use)) vi = i;
          }
          if (vi < 0) vi = 0;
          wins[vi] = slot;
        }

        // Load window w into the cache, record bound[w]. Shared by prefetch,
        // seeks and whenReady; concurrent callers get the same promise.
        function load(w) {
          if (w < 0 || w >= numWins) return Promise.resolve(null);
          var have = slotFor(w);
          if (have) return Promise.resolve(have);
          if (inflight[w]) return inflight[w];
          var start = dataStart + w * winBytes;
          if (start >= blob.size) { bound[w] = Infinity; return Promise.resolve(null); }
          var len = Math.min(winBytes, blob.size - start);
          var p = readSliceAB(blob, start, len).then(function (ab) {
            delete inflight[w];
            var d = new DataView(ab);
            var slot = { w: w, ab: ab, dv: d, first: w * WINDOW_NOTES,
                         tick: (d.byteLength >= NOTE_SIZE) ? d.getUint32(0, true) : Infinity,
                         use: ++useSeq };
            if (bound[w] === undefined) bound[w] = slot.tick;
            place(slot);
            return slot;
          }, function (e) { delete inflight[w]; throw e; });
          inflight[w] = p;
          return p;
        }

        // Keep pinW .. pinW+AHEAD loaded, one background read at a time.
        function pump() {
          if (pumping) return;
          for (var k = 0; k <= AHEAD; k++) {
            var w = pinW + k;
            if (w >= numWins) break;
            if (!slotFor(w) && !inflight[w]) {
              pumping = true;
              load(w).then(function () { pumping = false; pump(); },
                           function () { setTimeout(function () { pumping = false; pump(); }, 200); });
              return;
            }
          }
        }

        function boundAsync(w) {
          if (w >= numWins) return Promise.resolve(Infinity);
          if (bound[w] !== undefined) return Promise.resolve(bound[w]);
          var s = slotFor(w);
          if (s) { bound[w] = s.tick; return Promise.resolve(bound[w]); }
          return boundProbe(w);
        }

        // Bound probe: first tick of window w via a 4-byte read — never a
        // full window load. Seeks used to full-load O(log n) windows
        // (~20MB storm per seek) just to compare boundary ticks.
        function boundProbe(w) {
          if (w < 0 || w >= numWins) return Promise.resolve(Infinity);
          if (bound[w] !== undefined) return Promise.resolve(bound[w]);
          var s = slotFor(w);
          if (s) { bound[w] = s.tick; return Promise.resolve(bound[w]); }
          var start = dataStart + w * winBytes;
          if (start >= blob.size) { bound[w] = Infinity; return Promise.resolve(Infinity); }
          return readSliceAB(blob, start, 4).then(function (ab) {
            var t = new DataView(ab).getUint32(0, true);
            bound[w] = t;
            return t;
          });
        }

        // First index with t >= tick inside a loaded window (binary search;
        // records are fixed-size and sorted), or -1 when every note in it is
        // earlier than tick.
        function lowerBound(slot, tick) {
          var cnt = Math.min(WINDOW_NOTES, numNotes - slot.first);
          var a = 0, b = cnt, dv = slot.dv;
          while (a < b) {
            var m = (a + b) >> 1;
            if (dv.getUint32(m * NOTE_SIZE, true) >= tick) b = m; else a = m + 1;
          }
          return a < cnt ? slot.first + a : -1;
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

          // Fire-and-forget: pin the window holding note i and keep it plus
          // the next AHEAD windows loaded. Called every sequencer pulse.
          prefetch: function (i) {
            var w = winIdxOf(Math.max(0, Math.min(i, numNotes - 1)));
            if (w < 0 || w >= numWins) return;
            pinW = w;
            pump();
          },

          prefetchNext: function () { pump(); },

          // Resolve when note i's window is loaded (used by tests).
          whenReady: function (i) {
            var w = winIdxOf(Math.max(0, Math.min(i, numNotes - 1)));
            if (w < 0 || w >= numWins) return Promise.resolve();
            return load(w).then(function () {});
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
              pinW = w;                               // protect the target window
              return load(w).then(function (slot) {
                if (!slot) return 0;
                var res = lowerBound(slot, tick);
                if (res >= 0) return res;
                // Not found in w → first note of the next window (or end of file).
                if (w + 1 >= numWins) return numNotes;
                pinW = w + 1;
                return load(w + 1).then(function (s2) {
                  if (!s2) return numNotes;
                  var r2 = lowerBound(s2, tick);
                  return r2 >= 0 ? r2 : numNotes;
                });
              }).then(function (idx) { pump(); return idx; });
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