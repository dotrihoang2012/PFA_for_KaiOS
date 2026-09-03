/**
 * noteWriter.js — incremental .note writer.
 *
 * Writes a MIDI-JSON .note file to DeviceStorage ("others/pfa_tmp" in the
 * target storage) line-by-line in batches, yielding the event loop between
 * batches (setTimeout 0) so a large .mid never freezes the UI or builds a
 * giant JSON string in RAM at once.
 *
 * Output format is still a valid JSON document so it can be re-opened later
 * via loadMIDIJson/JSON.parse:
 *
 *   {"div":480,"tempo":[{"t":0,"u":500000}],"notes":[
 *   {"t":123,"c":0,"n":60,"v":100,"d":240},
 *   ...
 *   ]}
 *
 * Storage target selection mirrors StorageSel: prefer the volume with
 * enough free space (usually a big removable card), else internal.
 */
var NoteWriter = (function () {
  'use strict';

  var BATCH = 10000;   // notes per append

  // Cancel support: write() checks _nwCancel at every batch boundary; on
  // cancel it deletes the partial .note and reports via opts.onCancel.
  var _nwCancel = false;
  function cancel() {
    _nwCancel = true;
    console.log('[NoteWriter] cancel requested');
  }

  // ── storage selection ──────────────────────────────────────────────

  /**
   * Pick a storage that has room for `needBytes`, preferring the one with
   * the most free space among those that qualify. onDone(storageInfo|null).
   */
  function pickStorage(needBytes, onDone) {
    function real() {
      if (typeof StorageSel === 'undefined' || !StorageSel.detect) {
        // Fallback: whatever getDeviceStorage returns.
        var fallback = { st: navigator.getDeviceStorage('sdcard'), name: 'sdcard', free: -1, path: null, kind: 'unknown' };
        onDone(fallback);
        return;
      }
      StorageSel.detect(function (infos) {
        if (!infos.length) { onDone(null); return; }
        // Use the single volume StorageSel chose (removable SD if mounted,
        // else internal). If that one is known full — or its free space
        // can't be read — switch to the volume with the most readable free
        // space so a full storage degrades to the other one instead of dying.
        var chosen = (typeof StorageSel.select === 'function') ? StorageSel.select(infos) : infos[0];
        var best = chosen;
        if (best && (best.free < 0 || best.free < needBytes)) {
          infos.forEach(function (inf) {
            if (inf.st !== best.st && inf.free >= 0 && inf.free > best.free) best = inf;
          });
        }
        // No volume resolved a writable path → the OS prompt was already
        // shown (ensure/gate) and the user declined (or never answered).
        // NO dialog — the only permission dialog in the app is the hot-open
        // gate; here we just stop the analyze.
        if (!best || best.path == null) {
          onDone(null);
          return;
        }
        onDone(best || null);
      });
    }
    // Permission not already granted: do ONE genuine write check first so the
    // OS "Allow device-storage:sdcard?" prompt appears (or re-appears after a
    // Not Allow). A decline just stops the analyze — no instructions dialog.
    var g = (typeof window !== 'undefined') ? window.pfaStorageGranted : null;
    if (typeof g !== 'function' || g()) { real(); return; }
    if (typeof StorageSel === 'undefined' || !StorageSel.ensure) { real(); return; }
    StorageSel.ensure(function (ok) {
      if (ok) { real(); return; }
      onDone(null);
    });
  }

  // ── helpers ────────────────────────────────────────────────────────

  /** Deterministic-ish file stem from the source name (sanitised). */
  function stem(name) {
    var s = String(name || 'midi').replace(/\.(mid|note|json)$/i, '');
    s = s.replace(/[^A-Za-z0-9._-]/g, '_');
    return s || 'midi';
  }

  /** Ensure others/pfa_tmp exists by writing a keep file (idempotent). */
  function ensureDir(st, cb) {
    var check = st.get('others/pfa_tmp/.keep');
    check.onsuccess = function () { if (check.result) cb(); else touchKeep(); };
    check.onerror = touchKeep;
    function touchKeep() {
      var r = st.addNamed(new Blob([''], { type: 'text/plain' }), 'others/pfa_tmp/.keep');
      r.onsuccess = function () { cb(); };
      r.onerror = function () { cb(); }; // directory may still work
    }
  }

  /**
   * Write midiData (from MidiParser.parseMIDI) to
   * <storage>/others/pfa_tmp/<stem>.note incrementally.
   * opts: { onProgress(pct), onDone(path), onError(msg) }
   */
  function write(midiData, name, opts) {
    opts = opts || {};
    _nwCancel = false;
    var notes = (midiData && midiData.notes) || [];
    var tempo = (midiData && midiData.tempo) || [{ t: 0, u: 500000 }];
    var div   = (midiData && midiData.div) || 480;

    var est = 2 + (tempo.length * 24) + (notes.length * 30); // rough bytes

    pickStorage(est, function (stInfo) {
      if (!stInfo || !stInfo.st) {
        if (opts.onError) opts.onError('No writable storage found.');
        return;
      }
      var st = stInfo.st;
      var path = 'others/pfa_tmp/' + stem(name) + '.note';

      ensureDir(st, function () {
        var header = '{"div":' + div + ',"tempo":[' +
          tempo.map(function (tp) { return '{"t":' + tp.t + ',"u":' + tp.u + '}'; }).join(',') +
          '],"notes":[\n';

        // Start the file.
        var start = st.addNamed(new Blob([header], { type: 'text/plain' }), path);
        start.onsuccess = function () {
          try { if (typeof Written !== 'undefined' && Written.remember) Written.remember(path); } catch (e) {}
          flush(0);
        };
        start.onerror = function () {
          if (opts.onError) opts.onError('Could not create ' + path);
        };

        function flush(i) {
          if (_nwCancel) { dropPartial('Cancelled'); return; }
          var end = Math.min(i + BATCH, notes.length);
          var lastIdx = notes.length - 1;
          var parts = new Array(end - i);
          for (var k = i; k < end; k++) {
            var n = notes[k];
            var comma = (k < lastIdx) ? ',' : ''; // no trailing comma (valid JSON)
            parts[k - i] = '{"t":' + n.t + ',"c":' + n.c + ',"n":' + n.n +
              ',"v":' + n.v + ',"d":' + n.d + '}' + comma;
          }
          var chunkStr = parts.join('\n') + '\n';

          if (opts.onProgress) {
            opts.onProgress(notes.length ? Math.round(end / notes.length * 100) : 100);
          }

          if (end >= notes.length) {
            if (_nwCancel) { dropPartial('Cancelled'); return; }
            // Final chunk — close the array.
            var last = st.appendNamed(new Blob([chunkStr + ']}'], { type: 'text/plain' }), path);
            last.onsuccess = function () {
              if (opts.onProgress) opts.onProgress(100);
              if (opts.onDone) opts.onDone(path);
            };
            last.onerror = function () { if (opts.onError) opts.onError('Final write failed'); };
            return;
          }

          var req = st.appendNamed(new Blob([chunkStr], { type: 'text/plain' }), path);
          req.onsuccess = function () {
            parts = null; chunkStr = null; // release the batch
            setTimeout(function () { flush(end); }, 0);
          };
          req.onerror = function () {
            if (opts.onError) opts.onError('Append failed at batch ' + i);
          };
        }

        // Cancel: remove the partial .note by exact name (blind delete works,
        // enumerate doesn't — same story as Clear), forget it, report.
        function dropPartial(msg) {
          console.log('[NoteWriter] ' + msg + ' — deleting partial ' + path);
          try { if (typeof Written !== 'undefined' && Written.forget) Written.forget(path); } catch (e) {}
          var dr;
          try { dr = st.delete(path); } catch (e) { if (opts.onCancel) opts.onCancel(msg); return; }
          var dt = setTimeout(function () { if (opts.onCancel) opts.onCancel(msg); }, 8000);
          dr.onsuccess = function () { clearTimeout(dt); if (opts.onCancel) opts.onCancel(msg); };
          dr.onerror = function () { clearTimeout(dt); if (opts.onCancel) opts.onCancel(msg); };
        }
      });
    });
  }

  return {
    write: write,
    cancel: cancel,
    pickStorage: pickStorage
  };
})();
