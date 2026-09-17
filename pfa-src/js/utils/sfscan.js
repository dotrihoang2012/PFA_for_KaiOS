/**
 * sfscan.js — SoundFont discovery + reading on KaiOS storage.
 *
 * Scans BOTH DeviceStorage partitions (internal + removable SD — returned
 * together by navigator.getDeviceStorages('sdcard'), storageName "sdcard"
 * vs "sdcard1") for SoundFont files:
 *    .sf2   (SoundFont 2)
 *    .sf3   (SoundFont 3, Ogg-packed samples — listed, load may still work)
 *    .soundbank.json (the tool-generated compact bank)
 *
 * KaiOS DeviceStorage.enumerate() is shallow and, on some builds, returns
 * 0 results. To stay useful across devices the scanner:
 *   1. enumerates a set of well-known directories (root, Music, Fonts,
 *      Sounds, others, …) on each volume, AND
 *   2. for every file it does find, re-enumerates the file's PARENT
 *      directory (path-shape discovery) so the scan walks real folders up
 *      to a bounded depth without ever scanning the whole card blindly.
 * Both steps are capped (probes, matches, time) so a giant SD card can
 * never hang the Settings page.
 *
 * Persistence note: the app REMEMBERS which soundfonts were loaded via
 * Soundbank's registry (localStorage) — this module only catalogues and
 * reads files. Nothing is ever written to a partition by a scan.
 *
 * Public API:
 *   SfScan.list(onDone)                // [{ st, volName, path, name, size }]
 *   SfScan.readFile(entry)             // Promise<ArrayBuffer>
 *   SfScan.readByPath(volName, path)   // Promise<ArrayBuffer>
 */
var SfScan = (function () {
  'use strict';

  var EXTS = ['.sf2', '.sf3', '.soundbank.json', '.soundbank'];
  var MAX_MATCHES = 200;   // hard cap on listed files across both volumes
  var MAX_PROBES = 30;     // directories enumerated per volume
  var MAX_DEPTH = 5;       // folder-walk depth guard
  var PROBE_TIMEOUT = 6000; // enumerate() may never call back on some builds
  var READ_TIMEOUT = 8000;  // st.get() / FileReader budget

  var KNOWN_DIRS = ['', 'Music', 'Fonts', 'Sounds', 'Soundfonts', 'MIDI',
                    'Midis', 'Samples', 'downloads', 'Documents', 'others',
                    'others/pfa_config', 'others/pfa_tmp'];

  function storageList() {
    try {
      if (navigator.getDeviceStorages) return navigator.getDeviceStorages('sdcard') || [];
      if (navigator.getDeviceStorage) return [navigator.getDeviceStorage('sdcard')];
    } catch (e) {}
    return [];
  }

  function endsWith(s, suffix) {
    return s && s.lastIndexOf(suffix) === s.length - suffix.length;
  }
  function hasSfExt(name) {
    var n = String(name || '').toLowerCase();
    for (var i = 0; i < EXTS.length; i++) if (endsWith(n, EXTS[i])) return true;
    return false;
  }
  function stripSlash(p) {
    p = String(p || '');
    while (p.charAt(0) === '/') p = p.substring(1);
    return p;
  }
  function basename(p) {
    var parts = String(p || '').split('/');
    return parts[parts.length - 1] || p;
  }
  function dirname(p) {
    p = String(p || '');
    var i = p.lastIndexOf('/');
    return i > 0 ? p.substring(0, i) : '';
  }

  /**
   * Enumerate ONE directory with a hard timeout (some KaiOS builds never
   * call back). resolve(Array of {name,size}); never throws.
   */
  function enumerateDir(st, dir) {
    return new Promise(function (resolve) {
      var out = [];
      var settled = false;
      var req;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { if (req && req.cancel) req.cancel(); } catch (e) {}
        resolve(out);
      }, PROBE_TIMEOUT);
      try { req = st.enumerate(dir); }
      catch (e) { clearTimeout(timer); resolve(out); return; }
      req.onsuccess = function () {
        var file = req.result;
        if (!file) { clearTimeout(timer); settled = true; resolve(out); return; }
        out.push({ name: file.name || '', size: file.size || 0 });
        try { req.continue(); } catch (e) { clearTimeout(timer); settled = true; resolve(out); }
      };
      req.onerror = function () { clearTimeout(timer); settled = true; resolve(out); };
    });
  }

  /**
   * Scan a single volume. Walks KNOWN_DIRS first then any parent folders
   * discovered from real files until the probe budget runs out.
   * onRange(entries) — incremental so the Settings page can paint matches
   * as they arrive; returns the final array too.
   */
  function scanVolume(st, onRange) {
    return new Promise(function (resolve) {
      var volName = st.storageName || '?';
      var entries = [];     // final matches for THIS volume
      var seen = {};        // dedupe by path
      var probed = {};      // directories already enumerated
      var stack = [];       // { dir, depth } queue (BFS)
      var probes = 0;

      function tryMatch(file, depth) {
        if (!hasSfExt(file.name)) {
          // Non-matching file still reveals its folder → adds to the walk.
          return;
        }
        if (entries.length >= MAX_MATCHES) return;
        var key = volName + '|' + file.name;
        if (seen[key]) return;
        seen[key] = true;
        var ent = {
          st: st,
          volName: volName,
          path: stripSlash(file.name),
          name: basename(file.name),
          size: file.size || 0
        };
        entries.push(ent);
        try { onRange(ent); } catch (e) {}
      }

      function pushDir(dir, depth) {
        dir = stripSlash(dir);
        if (dir !== '' && dir.charAt(dir.length - 1) === '/') dir = dir.substring(0, dir.length - 1);
        var key = (dir === '' ? '/' : dir);
        if (probed[key]) return;
        if (depth > MAX_DEPTH) return;
        probed[key] = true;
        stack.push({ dir: dir, depth: depth });
      }

      function drain() {
        if (!stack.length || probes >= MAX_PROBES) {
          // HARD STOP when the per-volume budget is exhausted; if we're
          // being quiet because budget hit, still resolve what we found.
          resolve(entries);
          return;
        }
        var job = stack.shift();
        probes++;
        // Fresh clone so `.result` buffers reset per enumerate (see the
        // cleanTmpDir pattern in streamParser.js).
        enumerateDir(st, job.dir).then(function (files) {
          if (!files.length) { drain(); return; }
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            tryMatch(f, job.depth);
            // Discover subfolders from paths returned by the enumeration:
            // /Music/Piano.sf2 → re-enumerate "Music", /A/B/x.sf2 → "A/B".
            var parent = dirname(f.name);
            if (parent && parent !== stripSlash(job.dir)) pushDir(parent, job.depth + 1);
          }
          // Also try the classic "samples/fonts live near the file" folders.
          for (var j = 0; j < KNOWN_DIRS.length; j++) {
            if (KNOWN_DIRS[j]) pushDir(KNOWN_DIRS[j], job.depth + 1);
          }
          drain();
        });
      }

      // Seed the walk.
      pushDir('', 0);
      for (var i = 0; i < KNOWN_DIRS.length; i++) pushDir(KNOWN_DIRS[i], 0);
      drain();
    });
  }

  /** Scan every partition. cb(entries) — all matches across all volumes. */
  function list(cb) {
    cb = cb || function () {};
    var vols = storageList();
    if (!vols.length) { cb([]); return; }
    var all = [];
    var chain = Promise.resolve();
    vols.forEach(function (vol) {
      chain = chain.then(function () {
        return scanVolume(vol, function () {}).then(function (ents) {
          for (var i = 0; i < ents.length; i++) {
            if (all.length >= MAX_MATCHES) break;
            all.push(ents[i]);
          }
        });
      });
    });
    chain.then(function () { cb(all); });
  }

  function blobToArrayBuffer(blob) {
    return new Promise(function (resolve, reject) {
      if (blob && typeof blob.arrayBuffer === 'function') {
        try {
          blob.arrayBuffer().then(resolve, function () { legacyRead(); });
          return;
        } catch (e) { legacyRead(); return; }
      }
      function legacyRead() {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error('FileReader failed')); };
        fr.readAsArrayBuffer(blob);
      }
      if (!blob) { reject(new Error('No blob for ArrayBuffer')); return; }
      legacyRead();
    });
  }

  function dsGet(st, path) {
    return new Promise(function (resolve) {
      var settled = false;
      var req;
      var timer = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, READ_TIMEOUT);
      var safePath = stripSlash(path);
      // DeviceStorage.get expects a path relative to the mount point.
      safePath = safePath.replace(/^(sdcard|sdcard1|internal|internal\/storage|volume)\//, '');
      try { req = st.get(safePath); }
      catch (e) { clearTimeout(timer); settled = true; resolve(null); return; }
      req.onsuccess = function () {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(req.result || null);
      };
      req.onerror = function () {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(null);
      };
    });
  }

  /** Read a catalogued entry → ArrayBuffer (for SfParser.parse). */
  function readFile(entry) {
    return new Promise(function (resolve, reject) {
      if (!entry || !entry.st) { reject(new Error('No storage entry')); return; }
      dsGet(entry.st, entry.path).then(function (file) {
        if (!file) { reject(new Error('Could not read ' + entry.name)); return; }
        blobToArrayBuffer(file).then(resolve, reject);
      });
    });
  }

  /** Read by volName+path (used by Soundbank.restore from the registry). */
  function readByPath(volName, path) {
    return new Promise(function (resolve, reject) {
      var vols = storageList();
      var found = null;
      for (var i = 0; i < vols.length; i++) {
        if (vols[i].storageName === volName) { found = vols[i]; break; }
      }
      if (!found) { reject(new Error('Volume not found: ' + volName)); return; }
      dsGet(found, path).then(function (file) {
        if (!file) { reject(new Error('Could not read ' + path)); return; }
        blobToArrayBuffer(file).then(resolve, reject);
      });
    });
  }

  return {
    list: list,
    readFile: readFile,
    readByPath: readByPath,
    hasSfExt: hasSfExt
  };
})();