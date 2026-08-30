/**
 * streamParser.js — streaming MIDI → binary .note writer (no full-RAM notes).
 *
 * Reads the source MIDI Blob one track at a time (blob.slice → FileReader),
 * parses each track and streams its notes to its OWN temp file (never keeping
 * more than one track in RAM at once), then k-way merges the track files
 * (each sorted by tick) into a final binary .note. Nothing ever holds all
 * notes in memory.
 *
 * Binary .note v2 layout (host-endian, little-endian on KaiOS ARM):
 *
 *   Header:
 *     0  4  "PFA2" magic
 *     4  4  Uint32 version = 2
 *     8  4  Uint32 div
 *    12  4  Uint32 numTempo
 *    16  4  Uint32 numNotes
 *    20  numTempo*8  tempo: { t:Uint32, u:Uint32 }
 *   Notes (NOTE_SIZE = 12 bytes each), sorted by tick ascending:
 *     t:Uint32, c:Uint8, n:Uint8, v:Uint8, rsv:Uint8, d:Uint32
 *
 * Temp files use the same 12-byte note layout (no MIDI header), just a raw
 * packed sequence of notes, one track per file.
 */
var StreamParser = (function () {
  'use strict';

  var MAGIC        = 0x32414650; // "PFA2" (LE bytes 'P','F','A','2')
  var VERSION      = 2;
  var NOTE_SIZE    = 12;
  var HEADER_BASE  = 20;         // bytes before tempo array
  var RUN_NOTES    = 12000;      // max notes held in RAM per run (~0.14MB .note)
                                // Halved from 60000: cuts per-flush peak object
                                // array + pack transient on old-Gecko heaps,
                                // at the cost of ~2× more run files (merge RAM
                                // stays flat either way).
  var MERGE_K      = 12;         // max files opened at once during merge
  var FIN_BATCH    = 16384;      // notes packed per final append
  var MERGE_WINDOW = 524280;     // per-run read window during merge (~512KB,
                                 // multiple of NOTE_SIZE so note boundaries never
                                 // split across windows). Keeps merge RAM at
                                 // ~MERGE_K × window instead of holding whole
                                 // (possibly multi-MB intermediate) runs.
  var MAX_TEMPO    = 512;        // cap on tempo-change records kept in the .note
                                 // header (8 bytes each; source MIDIs rarely need
                                 // more, and it bounds header size to ~4KB)

  // Single-flight conversion guard + per-conversion file token.
  // Two overlapping conversions share the same tmp dir on device; without this
  // each one's cleanTmpDir wipes the other's in-flight run files mid-write →
  // "missing run r<k>.bin" at merge time (seen on a real 400MB black MIDI).
  // Only one conversion may run at a time, and run names embed a per-run token
  // so leftover files from a crashed session are never confused with live ones.
  var _converting = false;
  // Cancel request (public cancel()); the running conversion checks it at
  // its yield points, deletes the partial tmp files via cleanUpSwept, then
  // rejects with a CancelError → midiToNote's catch calls opts.onCancel.
  var _convertCancel = false;
  function mkCancel() {
    var e = new Error('cancelled');
    e.name = 'CancelError';
    return e;
  }
  function cancel() {
    _convertCancel = true;
    console.log('[StreamParser] cancel requested');
  }
  function newToken() {
    return Date.now().toString(36) + Math.floor(Math.random() * 0xffffffff).toString(36);
  }

  // ── Low-level Blob read (FileReader, works on KaiOS 2.5) ───────────
  function readSliceAB(blob, start, len) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function doRes(v) { if (!settled) { settled = true; resolve(v); } }
      function doRej(e) { if (!settled) { settled = true; reject(e); } }
      var b = blob.slice(start, start + len);
      var fr = new FileReader();
      fr.onload = function () { clearTimeout(t); doRes(fr.result); };
      fr.onerror = function () { clearTimeout(t); doRej(new Error('readAsArrayBuffer failed')); };
      var t = setTimeout(function () { try { fr.abort(); } catch (e) {} doRej(new Error('readSliceAB timeout')); }, 20000);
      fr.readAsArrayBuffer(b);
    });
  }

  // ── DeviceStorage promise helpers ──────────────────────────────────
  // Every one is guarded by a timeout: on a real device a storage operation
  // can hang forever (permission prompt stuck, volume unresponsive). Timeout
  // resolves/rejects so the pipeline never deadlocks.
  function dsAddNamed(st, blob, path) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function doRes(v) { if (!settled) { settled = true; resolve(v); } }
      function doRej(e) { if (!settled) { settled = true; reject(e); } }
      var r = st.addNamed(blob, path);
      var t = setTimeout(function () { doRej(new Error('addNamed timeout ' + path)); }, 8000);
      r.onsuccess = function () { clearTimeout(t); doRes(r.result); };
      r.onerror = function () { clearTimeout(t); doRej(new Error('addNamed ' + (r.error && r.error.name))); };
    });
  }
  function dsAppendNamed(st, blob, path) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function doRes(v) { if (!settled) { settled = true; resolve(v); } }
      function doRej(e) { if (!settled) { settled = true; reject(e); } }
      var r = st.appendNamed(blob, path);
      var t = setTimeout(function () { doRej(new Error('appendNamed timeout ' + path)); }, 8000);
      r.onsuccess = function () { clearTimeout(t); doRes(r.result); };
      r.onerror = function () { clearTimeout(t); doRej(new Error('appendNamed ' + (r.error && r.error.name))); };
    });
  }
  // Window.Written records written paths so Clear can delete by exact name
// (enumerate() can be dead on KaiOS — see the clear debug saga).
  function wRemember(path) {
    try { if (typeof Written !== 'undefined' && Written.remember) Written.remember(path); } catch (e) {}
  }
  function wForget(path) {
    try { if (typeof Written !== 'undefined' && Written.forget) Written.forget(path); } catch (e) {}
  }

  function dsDelete(st, path) {
    return new Promise(function (resolve) {
      var settled = false;
      function doRes(v) { if (!settled) { settled = true; resolve(v); } }
      var r = st.delete(path);
      var t = setTimeout(function () { doRes(false); }, 8000);
      r.onsuccess = function () { clearTimeout(t); doRes(true); };
      r.onerror = function () { clearTimeout(t); doRes(false); };
    });
  }
  function dsGet(st, path) {
    return new Promise(function (resolve) {
      var settled = false;
      function doRes(v) { if (!settled) { settled = true; resolve(v); } }
      var r = st.get(path);
      var t = setTimeout(function () { doRes(null); }, 8000);
      r.onsuccess = function () { clearTimeout(t); doRes(r.result || null); };
      r.onerror = function () { clearTimeout(t); doRes(null); };
    });
  }

  function ensureDir(st, dir) {
    return dsGet(st, dir + '/.keep').then(function (f) {
      if (f) return;
      return dsAddNamed(st, new Blob([''], { type: 'text/plain' }), dir + '/.keep').catch(function () {});
    });
  }

  /**
   * Remove leftover intermediate files (*.bin) from the run dir. Called before
   * starting a new conversion so a previously aborted run can't leave junk.
   * Keeps *.note (playable persisted files) untouched.
   */
  function cleanTmpDir(st, dir, token) {
    return new Promise(function (resolve) {
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(); } }
      var timer = setTimeout(done, 3000); // enumerate hang → skip cleanup
      var request = st.enumerate(dir);
      request.onsuccess = function () {
        var file = request.result;
        if (!file) { clearTimeout(timer); done(); return; } // null = enumeration done
        var name = file.name || '';
        var base = name.split('/').pop() || '';
        // Only stale bins (from an earlier/crashed session) are removed. A bin
        // carrying THIS conversion's token is live — never touch it, even while
        // another conversion is scraping the same dir.
        if (endsWith(base, '.bin') && base.indexOf(token) === -1) dsDelete(st, name);
        request.continue();
      };
      request.onerror = function () { clearTimeout(timer); done(); };
    });
  }
  function endsWith(s, suffix) {
    return s.lastIndexOf(suffix) === s.length - suffix.length;
  }

  // ── Storage selection ──────────────────────────────────────────────
  function pickStorage(needBytes) {
    return new Promise(function (resolve) {
      function fail() { resolve(null); }
      function real() {
        // Guard against StorageSel.detect never firing its callback (e.g. a
        // storage permission prompt that hangs on the device). Fall back to
        // the plain 'sdcard' volume so the pipeline never deadlocks.
        var settled = false;
        function done(v) { if (!settled) { settled = true; resolve(v); } }
        var timer = setTimeout(function () {
          done({ st: navigator.getDeviceStorage('sdcard'), free: -1 });
        }, 4000);
        if (typeof StorageSel === 'undefined' || !StorageSel.detect) { clearTimeout(timer); done({ st: navigator.getDeviceStorage('sdcard'), free: -1 }); return; }
        StorageSel.detect(function (infos) {
          clearTimeout(timer);
          if (!infos.length) { done({ st: navigator.getDeviceStorage('sdcard'), free: -1 }); return; }
          // Use the single volume StorageSel chose (removable SD if mounted,
          // else internal). If that one is known full — or its free space
          // can't be read — switch to the volume with the most readable free
          // space so a full storage degrades to the other one instead of dying.
          var chosen = (typeof StorageSel.select === 'function') ? StorageSel.select(infos) : infos[0];
          var use = chosen;
          if (use && (use.free < 0 || use.free < needBytes)) {
            infos.forEach(function (inf) {
              if (inf.st !== use.st && inf.free >= 0 && inf.free > use.free) use = inf;
            });
          }
          if (!use || use.path == null) {
            // No writable volume. When the permission was truly revoked the
            // grant-path dialog is the ONLY message we may show — resolving
            // { blocked } lets midiToNote stop SILENTLY (onCancel) so the
            // error dialog can never overwrite the permission dialog.
            var denied = (typeof window !== 'undefined' && window.pfaStorageDenied &&
                          typeof window.pfaStorageDenied === 'function' &&
                          window.pfaStorageDenied());
            if (denied) {
              if (typeof window !== 'undefined' && typeof window.pfaStorageDeniedDialog === 'function') {
                window.pfaStorageDeniedDialog();
              }
              done({ blocked: true });
              return;
            }
            fail();
            return;
          }
          done(use ? { st: use.st, free: use.free } : null);
        });
      }
      // Permission not already granted: do ONE genuine write check first so
      // the OS "Allow device-storage:sdcard?" prompt appears (or re-appears
      // after a Not Allow). A decline → show the instructions dialog and
      // resolve { blocked } (NEVER reject → no "analyze failed" error dialog
      // on top of the permission dialog).
      var g = (typeof window !== 'undefined') ? window.pfaStorageGranted : null;
      if (typeof g !== 'function' || g()) { real(); return; }
      if (typeof StorageSel === 'undefined' || !StorageSel.ensure) { real(); return; }
      StorageSel.ensure(function (ok) {
        if (ok) { real(); return; }
        if (typeof window !== 'undefined' && typeof window.pfaStorageDeniedDialog === 'function') {
          window.pfaStorageDeniedDialog();
        }
        done({ blocked: true });
      });
    });
  }

  // ── MIDI helpers ───────────────────────────────────────────────────
  function readStr(dv, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  }
  // Bounded VLV: if the last byte would fall beyond maxLen (the end of the
  // current window's DataView), it fails instead of reading out of range.
  function readBoundedVLQ(dv, idx, maxLen) {
    var value = 0, b;
    do {
      if (idx >= maxLen) return { ok: false, value: 0, off: idx };
      b = dv.getUint8(idx);
      value = (value << 7) | (b & 0x7f);
      idx++;
    } while (b & 0x80);
    return { ok: true, value: value, off: idx };
  }

  // Read MThd + locate each MTrk block. Resolves { format, numTracks, div, tracks }
  function readHeader(blob) {
    return readSliceAB(blob, 0, 14).then(function (hdr) {
      var dv = new DataView(hdr);
      if (readStr(dv, 0, 4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd)');
      var hlen = dv.getUint32(4, false);
      if (hlen < 6) throw new Error('Bad header length ' + hlen);
      var format = dv.getUint16(8, false);
      var numTracks = dv.getUint16(10, false);
      var div = dv.getUint16(12, false);
      if (div === 0 || div > 0x7fff) div = 480;
      var tracks = [], offset = 14;
      function walk() {
        if (tracks.length >= numTracks || offset >= blob.size) return Promise.resolve();
        return readSliceAB(blob, offset, 8).then(function (t8) {
          var d = new DataView(t8);
          if (readStr(d, 0, 4) !== 'MTrk') throw new Error('Expected MTrk at ' + offset);
          var len = d.getUint32(4, false);
          tracks.push({ start: offset + 8, len: len });
          offset += 8 + len;
          return walk();
        });
      }
      return walk().then(function () {
        return { format: format, numTracks: numTracks, div: div, tracks: tracks };
      });
    });
  }

  // Pack notes [{t,c,n,v,d}] into a Uint8Array (NOTE_SIZE each).
  function packNotes(notes) {
    var buf = new ArrayBuffer(notes.length * NOTE_SIZE);
    var dv = new DataView(buf);
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i], o = i * NOTE_SIZE;
      dv.setUint32(o, n.t | 0, true);
      dv.setUint8(o + 4, n.c & 0xf);
      dv.setUint8(o + 5, n.n & 0x7f);
      dv.setUint8(o + 6, n.v & 0x7f);
      dv.setUint8(o + 7, 0);
      dv.setUint32(o + 8, n.d | 0, true);
    }
    return new Uint8Array(buf);
  }

  /**
   * Parse one track's full ArrayBuffer. Because a single huge track may not
   * fit RAM, callers pass the track bytes; for tracks that are themselves
   * huge this is the one spot that could grow — mitigate by yielding the
   * buffers after packing. Returns { chunks:[Uint8Array], noteCount, lastTick }.
   */
  function parseTrack(ab) {
    var state = createParseState();
    state.atEnd = true; // single-shot: whole track is in `ab`
    var chunks = [];
    var res;
    do {
      res = parseTrackChunk(ab, state, function (batch) { chunks.push(packNotes(batch)); });
    } while (!res.done);
    return { chunks: chunks, noteCount: state.noteCount, lastTick: state.maxTick };
  }

  /**
   * Progressive (backpressure) track parser.
   *
   * parseTrackChunk(ab, state, emit) parses the track ArrayBuffer in slices,
   * keeping NO full-track notes in memory: it parses events until it reaches
   * a RAM quota (state.quotaNotes / PARSE_QUOTA_BYTES), calls `emit(notes)`
   * once for that slice, and returns. State (byte offset, running status,
   * active-note map, ticks) is carried in `state`, so the caller can `await`
   * a temp-file write between calls — that write frees the emitted buffers
   * before the next slice is parsed. RAM stays bounded (~PARSE_QUOTA_BYTES).
   *
   * Returns { done, lastTick } — done=true when the track is fully consumed.
   */
var PARSE_QUOTA_BYTES = 256 * 1024;   // ~256KB of track bytes parsed per slice
                                        // Small windows = tiny transient churn, so
                                        // old Gecko's lazy GC keeps up even on
                                        // 256MB units (1MB windows ballooned to
                                        // ~300MB uncollected heap on the 6300).
  var NOTE_EMIT = 4096;                     // notes packed per emit call

  // Best-effort GC nudge for memory-tight devices (window.gc exists on some
  // B2G/KaiOS builds; harmless no-op elsewhere). Called after heavy steps so
  // old Gecko's lazy collector doesn't let transient heap balloon across the
  // many async windows of a giant black MIDI parse/merge.
  function collectGarbage() {
    try { if (typeof window !== 'undefined' && typeof window.gc === 'function') { window.gc(); return; } } catch (e) {}
    try { if (typeof window !== 'undefined' && typeof window.forceGC === 'function') { window.forceGC(); } } catch (e) {}
  }

  function createParseState() {
    return {
      off: 0, curTick: 0, runningStatus: 0, runningChannel: 0,
      active: {}, batch: [], noteCount: 0, maxTick: 0, closed: false, atEnd: false,
      tempo: []   // FF 51 set-tempo records {t, u} gathered for this track
    };
  }

  function parseTrackChunk(ab, state, emit, abBase) {
    abBase = abBase || 0;
    var dv = new DataView(ab);
    var winEnd = abBase + ab.byteLength; // absolute end of this window
    var off = state.off;                 // absolute position within the track
    var curTick = state.curTick;
    var runningStatus = state.runningStatus;
    var runningChannel = state.runningChannel;
    var active = state.active;
    var batch = state.batch;
    var noteCount = state.noteCount;
    var maxTick = state.maxTick;

    if (state.closed) return { done: true, lastTick: maxTick };

    function flush() {
      if (!batch.length) return;
      emit(batch);
      batch.length = 0;
    }

    var rewound = false;

    while (off < winEnd) {
      var evStart = off;
      // Size the event up first. Every byte it reads in THIS window must exist;
      // an event that would straddle the window edge is left WHOLE for the next
      // window (off rewinds to evStart), so a fresh window always starts on a
      // clean event boundary. Without this, a window ending mid-event read
      // past the DataView → "argument 1 accesses an index that is out of range"
      // on multi-2MB-window tracks.
      var vlq = readBoundedVLQ(dv, off - abBase, ab.byteLength);
      if (!vlq.ok || abBase + vlq.off > winEnd) { rewound = true; off = evStart; break; }
      var p = abBase + vlq.off;
      if (p >= winEnd) { rewound = true; off = evStart; break; }
      var type = dv.getUint8(p - abBase); p++;
      var status, channel, d0, d1, skip = 0, newStatus = false, tempoUsec = 0;
      if (type === 0xff) {
        var metaType = dv.getUint8(p - abBase);
        p++; // meta-type byte
        var ml2 = readBoundedVLQ(dv, p - abBase, ab.byteLength);
        if (!ml2.ok || abBase + ml2.off > winEnd) { rewound = true; off = evStart; break; }
        p = abBase + ml2.off;
        skip = ml2.value; // body is only skipped, may extend past the edge
        // Set-tempo (FF 51 03 tt tt tt, usec/quarter big-endian): record it when
        // the body fits this window. The event's tick is resolved at commit
        // (curTick advances after this sizing pass).
        if (metaType === 0x51 && ml2.value === 3 && (p + 3) <= winEnd) {
          var tu = (dv.getUint8(p - abBase) << 16) |
                   (dv.getUint8(p + 1 - abBase) << 8) |
                   dv.getUint8(p + 2 - abBase);
          if (tu > 0) tempoUsec = tu;
        }
      } else if (type === 0xf0 || type === 0xf7) {
        var sl2 = readBoundedVLQ(dv, p - abBase, ab.byteLength);
        if (!sl2.ok || abBase + sl2.off > winEnd) { rewound = true; off = evStart; break; }
        p = abBase + sl2.off;
        skip = sl2.value;
      } else {
        status = type & 0xf0; channel = type & 0x0f;
        if (status < 0x80) {
          // running status: `type` itself is data byte 0
          status = runningStatus; channel = runningChannel; d0 = type;
        } else {
          if (p >= winEnd) { rewound = true; off = evStart; break; } // d0 in next window
          d0 = dv.getUint8(p - abBase); p++;
          newStatus = true;
        }
        if (status === 0x80 || status === 0x90 || status === 0xa0 ||
            status === 0xb0 || status === 0xe0) {
          if (p >= winEnd) { rewound = true; off = evStart; break; } // d1 in next window
          d1 = dv.getUint8(p - abBase); p++;
        } else { d1 = 0; }
        if (newStatus) { runningStatus = status; runningChannel = channel; }
      }
      // All required bytes verified in-window → commit this event atomically.
      curTick += vlq.value;
      if (curTick > maxTick) maxTick = curTick;
      if (tempoUsec > 0) state.tempo.push({ t: curTick, u: tempoUsec });
      off = p + skip;

      if (status === 0x90 && d1 > 0) {
        var k9 = channel * 128 + d0, old = active[k9];
        if (old) {
          // Retrigger on an already-active key (common in black MIDI stacks):
          // don't swallow the first articulation — close it at this tick, then
          // start the new one.
          var udur = curTick - old.tick; if (udur < 0) udur = 0;
          batch.push({ t: old.tick, c: old.c, n: old.n, v: old.vel, d: udur });
          noteCount++;
          if (batch.length >= NOTE_EMIT) flush();
        }
        active[k9] = { tick: curTick, vel: d1, c: channel, n: d0 };
      } else if (status === 0x90 || status === 0x80) {
        var key = channel * 128 + d0, on = active[key];
        if (on) {
          var dur = curTick - on.tick; if (dur < 0) dur = 0;
          batch.push({ t: on.tick, c: on.c, n: on.n, v: on.vel, d: dur });
          noteCount++;
          delete active[key];
          if (batch.length >= NOTE_EMIT) flush();
        }
      }
    }

    var done = state.atEnd && (off >= winEnd || rewound);
    if (done) {
      // Close remaining active notes at the final tick.
      for (var k in active) {
        var a = active[k];
        var d2 = maxTick - a.tick; if (d2 < 0) d2 = 0;
        batch.push({ t: a.tick, c: a.c, n: a.n, v: a.vel, d: d2 });
        noteCount++;
      }
      flush();
      state.closed = true;
    } else {
      flush();
    }

    // Persist state for the next window.
    state.off = off;
    state.curTick = curTick;
    state.runningStatus = runningStatus;
    state.runningChannel = runningChannel;
    state.noteCount = noteCount;
    state.maxTick = maxTick;

    return { done: done, lastTick: maxTick };
  }

  // ── Merge temp files into final .note ──────────────────────────────
  /**
   * k-way merge from disk run files into outPath. Only a handful of promises
   * are created for the whole merge (one per window refill / batch flush) and
   * notes are copied as raw bytes — the merge loop itself allocates nothing,
   * so RAM stays flat (the old per-note {t,c,n,v,d} objects + per-note promise
   * chains made old Gecko/GC balloon at merge start).
   */
  function mergeRuns(st, inPaths, outPath, seedWrite, swept) {
    console.log('[StreamParser] mergeRuns start: ' + inPaths.length + ' runs → ' + outPath);
    if (swept) swept.push(outPath);
    var init = seedWrite
      ? seedWrite()
      : dsAddNamed(st, new Blob([''], { type: 'application/octet-stream' }), outPath);
    return init
      .then(function () {
        var readers = [];
        function openOne(path) {
          return dsGet(st, path).then(function (f) {
            if (!f) {
              // ENOSPC / metadata lag on sluggish SD cards can make a just-
              // written run invisible for a beat — retry once before giving up.
              return dsGet(st, path).then(function (f2) {
                if (!f2) throw new Error('missing run ' + path);
                return f2;
              });
            }
            return f;
          }).then(function (f) {
            var r = { f: f, size: f.size, pos: 0, eof: false, active: false,
                      buf: null, dv: null, o: 0, end: 0, t: 0, c: 0, n: 0, v: 0, d: 0 };
            readers.push(r);
            return refill(r);
          });
        }
        function openAll() {
          var i = 0;
          function next() {
            if (i >= inPaths.length) return Promise.resolve();
            return openOne(inPaths[i++]).then(next);
          }
          return next();
        }
        // Load the next MERGE_WINDOW of a run. Windows are a multiple of
        // NOTE_SIZE, so note boundaries never split across reads.
        function refill(r) {
          if (r.eof) { r.active = false; return Promise.resolve(); }
          var want = Math.min(MERGE_WINDOW, r.size - r.pos);
          if (want <= 0) { r.eof = true; r.active = false; r.buf = null; r.dv = null; return Promise.resolve(); }
          r.buf = null; r.dv = null; // drop the old window before loading the next
          return readSliceAB(r.f, r.pos, want).then(function (ab) {
            r.pos += want;
            if (r.pos >= r.size) r.eof = true;
            r.dv = new DataView(ab); r.o = 0; r.end = ab.byteLength;
            if (r.end >= NOTE_SIZE) {
              r.t = r.dv.getUint32(0, true); r.c = r.dv.getUint8(4);
              r.n = r.dv.getUint8(5); r.v = r.dv.getUint8(6); r.d = r.dv.getUint32(8, true);
              r.active = true;
            } else {
              r.active = false;
            }
            return Promise.resolve();
          });
        }
        function writeBatch(u8) {
          return dsAppendNamed(st, new Blob([u8.buffer], { type: 'application/octet-stream' }), outPath);
        }
        // Output is packed straight into a byte buffer — no per-note objects.
        var out = new Uint8Array(FIN_BATCH * NOTE_SIZE);
        var n = 0;       // notes currently packed in out
        var written = 0; // notes flushed to disk
        var loopLogAt = 0;
        function flush() {
          if (!n) return Promise.resolve();
          written += n;
          var part = new Uint8Array(n * NOTE_SIZE);
          part.set(out.subarray(0, n * NOTE_SIZE), 0);
          n = 0;
          return writeBatch(part);
        }
        function run() {
          while (true) {
            var bi = -1, bt = 0;
            for (var i = 0; i < readers.length; i++) {
              var rr = readers[i];
              if (!rr.active) continue;
              if (bi === -1 || rr.t < bt) { bi = i; bt = rr.t; }
            }
            if (bi === -1) {
              var total = written + n;
              console.log('[StreamParser] merge loop done, total notes=' + total);
              return flush().then(function () { return Promise.resolve(); });
            }
            var r = readers[bi];
            var o = n * NOTE_SIZE;
            out[o] = r.t & 0xff; out[o + 1] = (r.t >>> 8) & 0xff;
            out[o + 2] = (r.t >>> 16) & 0xff; out[o + 3] = (r.t >>> 24) & 0xff;
            out[o + 4] = r.c & 0xf; out[o + 5] = r.n & 0x7f;
            out[o + 6] = r.v & 0x7f; out[o + 7] = 0;
            out[o + 8] = r.d & 0xff; out[o + 9] = (r.d >>> 8) & 0xff;
            out[o + 10] = (r.d >>> 16) & 0xff; out[o + 11] = (r.d >>> 24) & 0xff;
            n++;
            r.o += NOTE_SIZE;
            if (r.o < r.end) {
              r.t = r.dv.getUint32(r.o, true); r.c = r.dv.getUint8(r.o + 4);
              r.n = r.dv.getUint8(r.o + 5); r.v = r.dv.getUint8(r.o + 6);
              r.d = r.dv.getUint32(r.o + 8, true);
            } else {
              // current reader exhausted this window (or its whole file)
              r.active = false;
              if (r.eof) continue;
              // need async refills: flush buffered bytes, refill every parked
              // reader, then resume.
              var doRefills = flush().then(function () {
                if (_convertCancel) return Promise.reject(mkCancel());
                if (written > loopLogAt) { loopLogAt = written + FIN_BATCH * 20; console.log('[StreamParser] merge progress notes=' + written); }
                var parked = [];
                for (var j = 0; j < readers.length; j++) {
                  var pj = readers[j];
                  if (!pj.active) parked.push(pj);
                }
                var k = 0;
                function nextRef() {
                  if (k >= parked.length) return run();
                  return refill(parked[k++]).then(nextRef);
                }
                return nextRef();
              });
              return doRefills;
            }
            if (n >= FIN_BATCH) {
              var doFlush = flush().then(function () {
                if (_convertCancel) return Promise.reject(mkCancel());
                if (written > loopLogAt) { loopLogAt = written + FIN_BATCH * 20; console.log('[StreamParser] merge progress notes=' + written); }
                return run();
              });
              return doFlush;
            }
          }
        }

        return openAll().then(function () {
          console.log('[StreamParser] merge openAll done, readers=' + readers.length);
          return run();
        }).then(function () {
          console.log('[StreamParser] merge loop done');
        });
      });
  }

  /**
   * Direct-to-final merge for the LAST merge level: writes the header, then
   * appends the k-way output straight into finalPath — no intermediate file,
   * no copy. Halves the SD I/O (the previous flow wrote ~2× the notes via an
   * intermediate + copy, which froze the device on large files).
   */
  function mergeToFinal(st, paths, finalPath, meta, swept) {
    console.log('[StreamParser] mergeToFinal: ' + paths.length + ' runs → ' + finalPath + ' (direct)');
    if (swept) swept.push(finalPath);
    var header = buildHeader(meta.div, meta.tempo, meta.numNotes);
    return mergeRuns(st, paths, finalPath, function () {
      return dsDelete(st, finalPath).then(function () {
        return dsAddNamed(st, new Blob([header.buffer], { type: 'application/octet-stream' }), finalPath);
      });
    }).then(function () {
      return Promise.all(paths.map(function (p) { return dsDelete(st, p); }));
    });
  }

  function parseNoteAt(dv, o) {
    return { t: dv.getUint32(o, true), c: dv.getUint8(o + 4), n: dv.getUint8(o + 5),
             v: dv.getUint8(o + 6), d: dv.getUint32(o + 8, true) };
  }

  function buildHeader(div, tempo, numNotes) {
    var buf = new ArrayBuffer(HEADER_BASE + tempo.length * 8);
    var dv = new DataView(buf);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, VERSION, true);
    dv.setUint32(8, div, true);
    dv.setUint32(12, tempo.length, true);
    dv.setUint32(16, numNotes, true);
    var off = HEADER_BASE;
    for (var i = 0; i < tempo.length; i++) {
      dv.setUint32(off, tempo[i].t, true); off += 4;
      dv.setUint32(off, tempo[i].u, true); off += 4;
    }
    return new Uint8Array(buf);
  }

  // ── Public pipeline ────────────────────────────────────────────────
  /**
   * Convert a MIDI Blob to binary .note at <storage>/others/pfa_tmp/<stem>.note.
   * opts: { onProgress(pct), onDone(path), onError(err) }
   *
   * External sort pipeline (bounded RAM for tiny-device memory):
   *  1. Walk each track in slices (PARSE_QUOTA_BYTES), collecting notes into a
   *     pooled in-RAM run. When it reaches RUN_NOTES, sort, pack, write as
   *     run file r<token>_<k>.bin, free the buffer.
   *  2. Still under one run → FAST PATH: sort in RAM and write the final .note
   *     in a single direct write.
   *  3. Otherwise merge all run files k-way (groups of MERGE_K; the last level
   *     merges straight into the final .note). At every stage RAM stays
   *     bounded (~RUN_NOTES notes + one merged write batch).
   */
  function midiToNote(blob, name, opts) {
    opts = opts || {};
    if (_converting) {
      // Refuse so we never start scraping the shared tmp dir while another
      // conversion is writing runs there. Callers consume onDone/onError, so
      // resolve (not reject) to avoid an unhandled rejection down the chain.
      var busy = 'A conversion is already running';
      console.error('[StreamParser] ' + busy);
      if (opts.onError) opts.onError(busy || 'stream parse failed');
      return Promise.resolve();
    }
    _converting = true;
    _convertCancel = false;
    var token = newToken(); // unique per conversion → run names never collide
    // Every path this conversion creates (run files, merge intermediates, the
    // final .note) is tracked here so a cancel can delete them by exact name
    // (enumerate() is unreliable on this device — blind-delete only).
    var swept = [];
    var st = null;    // assigned inside pickStorage; used by cleanUpSwept
    function track(path) { if (swept.indexOf(path) === -1) swept.push(path); }
    function cleanUpSwept() {
      var ps = swept.slice();
      swept.length = 0;
      if (!ps.length) return Promise.resolve();
      console.log('[StreamParser] cancel cleanup: deleting ' + ps.length + ' partial path(s)');
      return Promise.all(ps.map(function (p) {
        return dsDelete(st, p).then(function () { wForget(p); });
      }));
    }
    function stage(s) {
      if (opts.onStage) { try { opts.onStage(s); } catch (e) {} }
    }
    var stem = sanitize(name);

    return pickStorage(blob.size * 3).then(function (stInfo) {
      console.log('[StreamParser] pickStorage resolved: ' + (stInfo ? (stInfo.blocked ? 'BLOCKED (permission)' : 'st=' + (stInfo.st && stInfo.st.storageName ? stInfo.st.storageName : '?') + ' free=' + stInfo.free) : 'null'));
      if (stInfo && stInfo.blocked) {
        // Storage permission revoked and the OS prompt was declined: the
        // grant-path dialog is already on screen. Stop WITHOUT throwing so the
        // error dialog can never replace it. onCancel resets the busy flag and
        // hides the parsing pill, leaving the dialog visible.
        _converting = false;
        if (opts.onCancel) opts.onCancel('Storage permission denied — grant SD card access to convert');
        return;
      }
      if (!stInfo || !stInfo.st) throw new Error('No writable storage');
      st = stInfo.st;                     // outer `st` (cleanUpSwept needs it)
      var dir = 'others/pfa_tmp';
      var finalPath = dir + '/' + stem + '.note';
      var meta = { div: 480, tempo: [{ t: 0, u: 500000 }], numNotes: 0 };
      var runs = [];          // paths of intermediate run files
      var runBuf = [];        // in-RAM notes for the current run
      var trackTempos = [];   // per-track FF 51 tempo records

      // Store a sorted run: pack it and write it to disk as run file
      // r<token>_<k>.bin, then drop the in-RAM note objects. External sort
      // always — RAM on the device is too tight to buffer packed runs as well.
      function storeRun(notes) {
        runBuf = [];
        var u8 = packNotes(notes);
        var path = dir + '/r' + token + '_' + runs.length + '.bin';
        runs.push(path);
        track(path);
        wRemember(path);
        return dsAddNamed(st, new Blob([u8.buffer], { type: 'application/octet-stream' }), path)
          .then(function () { collectGarbage(); });
      }

      // Parse one track BY WINDOW straight from the Blob — never holding the
      // whole (possibly huge) track in RAM. Each window is read, parsed,
      // then released before the next is read.
      function processTrackBlob(tStart, tLen) {
        var state = createParseState();
        var tAbs = 0; // absolute offset within the track
        state.atEnd = false;
        function window() {
          // Cancel reached a yield point: delete the files written so far and
          // bail out with CancelError (the midiToNote catch handles the rest).
          if (_convertCancel) {
            return cleanUpSwept().then(function () { throw mkCancel(); });
          }
          if (tAbs >= tLen) {
            state.atEnd = true;
            // final pass closes off remaining active notes at the last tick
            function emit(notes) {
              for (var i = 0; i < notes.length; i++) runBuf.push(notes[i]);
              meta.numNotes += notes.length;
            }
            var finalRes = parseTrackChunk(new ArrayBuffer(0), state, emit, tAbs);
            return finalRes.done ? Promise.resolve() : Promise.resolve();
          }
          var winLen = Math.min(PARSE_QUOTA_BYTES, tLen - tAbs);
          return readSliceAB(blob, tStart + tAbs, winLen).then(function (buf) {
            var startPos = state.off;
            var res = parseTrackChunk(buf, state, function (notes) {
              for (var i = 0; i < notes.length; i++) runBuf.push(notes[i]);
              meta.numNotes += notes.length;
            }, tAbs);
            // Drop the strong ref BEFORE the yield/await below so the window's
            // ArrayBuffer is reclaimable immediately, not at the next slice.
            buf = null;
            // The next window must start where parsing actually stopped, which
            // may be BEFORE this window's end after an event-boundary rewind.
            if (state.off === startPos) {
              // Whole window yielded no event → corrupt/truncated track data.
              throw new Error('corrupt MIDI track: no parse progress at offset ' + tAbs);
            }
            tAbs = state.off;
            if (res.done) return Promise.resolve();
            collectGarbage();
            if (runBuf.length >= RUN_NOTES) {
              runBuf.sort(compareT);
              return storeRun(runBuf).then(function () {
                return new Promise(function (r) { setTimeout(r, 0); }).then(window);
              });
            }
            return new Promise(function (r) { setTimeout(r, 0); }).then(window);
          });
        }
        // Runs are pooled ACROSS tracks: keep parsing into the shared runBuf
        // and only flush a run when RUN_NOTES is reached. This collapses many
        // small tracks into few runs (each track is usually << RUN_NOTES on
        // real MIDI) — far less .bin files and far less SD I/O in the merge.
        function finish() {
          if (state.tempo && state.tempo.length) trackTempos.push(state.tempo);
          return Promise.resolve();
        }
        return window().then(finish);
      }

      // Drop leftover intermediate files from a previous (possibly aborted)
      // run before starting a fresh conversion, then ensure the dir exists.
      return cleanTmpDir(st, dir, token)
        .then(function () { console.log('[StreamParser] cleanTmpDir done'); return ensureDir(st, dir); })
        .then(function () { console.log('[StreamParser] ensureDir done'); return readHeader(blob); })
        .then(function (hdr) {
          console.log('[StreamParser] readHeader done: ' + hdr.tracks.length + ' tracks');
          stage('parse');
          meta.div = hdr.div;
          var ti = 0;
          function oneTrack() {
            if (ti >= hdr.tracks.length) return Promise.resolve();
            var t = hdr.tracks[ti++];
            console.log('[StreamParser] parse track ' + ti + '/' + hdr.tracks.length + ' len=' + t.len);
            return processTrackBlob(t.start, t.len).then(function () {
              var memKB = 0;
              try {
                if (typeof performance !== 'undefined' && performance.memory)
                  memKB = Math.round(performance.memory.usedJSHeapSize / 1024);
              } catch (e) {}
              console.log('[StreamParser] track ' + ti + ' done, runs=' + runs.length + ', mem=' + memKB + 'KB');
              return oneTrack();
            });
          }
          return oneTrack();
        })
        .then(function () {
          if (_convertCancel) {
            return cleanUpSwept().then(function () { throw mkCancel(); });
          }
          // Tempo was never exported before — every converted .note carried a
          // hardcoded 120 BPM default (500000 usec/qn), so a black MIDI whose
          // source was, say, 240 BPM played back at ~0.5× speed until the user
          // cranked the speed control to 2.0×. Now the FF 51 set-tempo events
          // gathered from all tracks are merged, deduped and written into the
          // .note header (which NoteStream + Sequencer already honour).
          meta.tempo = finalizeTempo(trackTempos, 500000);
          if (runs.length === 0) {
            // FAST PATH — every note fit in RAM (no run file was ever
            // written). Skip the external sort entirely: sort in place and
            // write the final .note in a single direct write. This is what
            // makes small/mid-size files load in seconds like before.
            console.log('[StreamParser] fast path (in-RAM): ' + runBuf.length + ' notes, no runs');
            runBuf.sort(compareT);
            var head = buildHeader(meta.div, meta.tempo, meta.numNotes);
            var payload = packNotes(runBuf);
            var out = new Uint8Array(head.length + payload.length);
            out.set(head, 0);
            out.set(payload, head.length);
            runBuf = [];
            // addNamed refuses to overwrite an existing file (NoModification
            // allowed) — drop the old .note first.
            return dsDelete(st, finalPath)
              .then(function () {
                return dsAddNamed(st, new Blob([out.buffer], { type: 'application/octet-stream' }), finalPath);
              })
              .then(function () { track(finalPath); wRemember(finalPath); console.log('[StreamParser] fast path wrote ' + finalPath); return finalPath; });
          }
          // external-sort path: flush the pooled tail as one more run, then merge.
          if (runBuf.length) {
            console.log('[StreamParser] flush tail run: ' + runBuf.length + ' notes');
            runBuf.sort(compareT);
            return storeRun(runBuf).then(function () { console.log('[StreamParser] tail run flushed, total runs=' + runs.length); });
          }
        })
        .then(function () {
          if (runs.length === 0) return finalPath; // fast path already wrote it
          stage('merge');
          return mergeTree(st, runs, finalPath, meta, opts, MERGE_K, dir, token, swept);
        })
        .then(function () {
          if (runs.length === 0) return finalPath; // nothing to clean
          if (opts.keepTemp) return finalPath;
          return Promise.all(runs.map(function (p) {
            return dsDelete(st, p).then(function () { wForget(p); });
          })).then(function () { return finalPath; });
        });
    }).then(function (path) {
      _converting = false;
      wRemember(path);
      if (opts.onDone) opts.onDone(path);
      return path;
    }).catch(function (e) {
      _converting = false;
      if (e && e.name === 'CancelError') {
        console.log('[StreamParser] conversion cancelled — partial files cleaned');
        cleanUpSwept().then(function () {
          if (opts.onCancel) opts.onCancel('Analysis cancelled');
          else if (opts.onError) opts.onError('Analysis cancelled');
        });
        return Promise.resolve();
      }
      console.error('[StreamParser] ' + (e && e.message));
      if (opts.onError) opts.onError((e && e.message) || 'stream parse failed');
    });
  }

  function compareT(a, b) { return a.t - b.t; }

  // Merge per-track FF 51 tempo records into one sorted, deduped map for the
  // .note header. Default (no tempo in the source) → the MIDI spec default of
  // 120 BPM (500000 usec/qn).
  function finalizeTempo(lists, defU) {
    var all = [];
    for (var i = 0; i < lists.length; i++) {
      var el = lists[i];
      for (var j = 0; j < el.length; j++) all.push(el[j]);
    }
    if (!all.length) return [{ t: 0, u: defU }];
    all.sort(function (a, b) { return a.t - b.t || (a.u - b.u); });
    var out = [];
    if (all[0].t > 0) out.push({ t: 0, u: defU }); // spec default until first change
    for (var k = 0; k < all.length && out.length < MAX_TEMPO; k++) {
      var c = all[k], u = (c.u > 0) ? c.u : defU;
      if (out.length && out[out.length - 1].t === c.t) { out[out.length - 1].u = u; continue; }
      if (out.length && out[out.length - 1].u === u) continue; // redundant repeat
      out.push({ t: c.t, u: u });
    }
    return out;
  }

  // Merge run files into the final .note. To avoid opening too many files at
  // once, merge groups of MERGE_K runs into one bigger intermediate run, then
  // repeat until a single (final) run remains.
  function mergeTree(st, runs, finalPath, meta, opts, k, dir, token, swept) {
    console.log('[StreamParser] mergeTree start: ' + runs.length + ' runs, k=' + k);
    var level = 0;
    function bail() {
      console.log('[StreamParser] merge cancelled');
      if (swept) { var ps = swept.slice(); swept.length = 0; return Promise.all(ps.map(function (p) { return dsDelete(st, p).then(function () { wForget(p); }); })); }
      return Promise.resolve();
    }
    function body(paths) {
      if (_convertCancel) return bail().then(function () { throw mkCancel(); });
      // Last level, single group → merge STRAIGHT into the final file (writes
      // header + notes directly, no intermediate .bin, no copy).
      if (paths.length > 1 && paths.length <= k) {
        return mergeToFinal(st, paths, finalPath, meta, swept);
      }
      if (paths.length === 1) {
        console.log('[StreamParser] mergeTree single run → copy to final');
        // single run left -> copy into the final .note with header, then drop it
        var header = buildHeader(meta.div, meta.tempo, meta.numNotes);
        // addNamed can't overwrite — drop an existing final first.
        return dsDelete(st, finalPath).then(function () {
          return dsAddNamed(st, new Blob([header.buffer], { type: 'application/octet-stream' }), finalPath);
        }).then(function () {
          if (swept) swept.push(finalPath);
          return copyRun(st, paths[0], finalPath, swept);
        }).then(function () { console.log('[StreamParser] mergeTree final copy done'); return dsDelete(st, paths[0]); });
      }
      var groups = [];
      for (var i = 0; i < paths.length; i += k) groups.push(paths.slice(i, i + k));
      console.log('[StreamParser] mergeTree level groups: ' + groups.length + ' groups (from ' + paths.length + ' paths)');
      var mergedPaths = [];
      var gi = 0;
      function nextGroup() {
        if (_convertCancel) return bail().then(function () { throw mkCancel(); });
        if (gi >= groups.length) {
          console.log('[StreamParser] mergeTree level complete, now ' + mergedPaths.length + ' paths');
          return body(mergedPaths);
        }
        var group = groups[gi++];
        var outPath = dir + '/m' + token + '_' + (level++) + '_' + gi + '.bin';
        return mergeRuns(st, group, outPath, null, swept).then(function () {
          // remove the consumed run files
          return Promise.all(group.map(function (p) { return dsDelete(st, p); }))
            .then(function () { mergedPaths.push(outPath); return nextGroup(); });
        });
      }
      return nextGroup();
    }
    return body(runs);
  }

  function copyRun(st, src, dst, swept) {
    return dsGet(st, src).then(function (f) {
      // Read the whole run in one shot (runs are ≤ RUN_NOTES notes ≈ 0.7MB).
      var pos = 0;
      function more() {
        if (_convertCancel) return Promise.reject(mkCancel());
        if (pos >= f.size) return Promise.resolve();
        return readSliceAB(f, pos, f.size - pos).then(function (ab) {
          pos += ab.byteLength;
          return dsAppendNamed(st, new Blob([ab], { type: 'application/octet-stream' }), dst).then(more);
        });
      }
      return more();
    });
  }

  function sanitize(name) {
    var s = String(name || 'midi').replace(/\.(mid|note|json)$/i, '');
    s = s.replace(/[^A-Za-z0-9._-]/g, '_');
    return s || 'midi';
  }

  return {
    MAGIC: MAGIC, VERSION: VERSION, NOTE_SIZE: NOTE_SIZE,
    midiToNote: midiToNote,
    cancel: cancel,
    readHeader: readHeader,
    parseTrack: parseTrack,
    packNotes: packNotes,
    buildHeader: buildHeader,
    pickStorage: pickStorage
  };
})();

// Node (tools / tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreamParser;
}
if (typeof window !== 'undefined') {
  window.StreamParser = StreamParser;
}
