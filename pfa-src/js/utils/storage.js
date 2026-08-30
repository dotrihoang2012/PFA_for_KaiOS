/**
 * storage.js — DeviceStorage helpers for PFA.
 *
 * KaiOS exposes storage volumes through navigator.getDeviceStorages('sdcard').
 * Which volume maps to "internal" vs a removable microSD card varies by
 * device / card state. On the Nokia 6300 4G used for testing:
 *   storageName "sdcard"  + path  /sdcard/...   = INTERNAL (plenty free)
 *   storageName "sdcard1" + path  /sdcard1/...  = the removable SD card
 * (and the `default` flag points at the SD card on this build — unreliable).
 * classify() uses the real probe result when available, then the storage NAME.
 *
 * The app deliberately uses a SINGLE volume for pfa_tmp/.note (never both):
 * pref INTERNAL, SD as fallback. detect() only probes (writes) the chosen
 * volume, so the other one is never touched and no stray folder is created.
 *
 * Note on robustness: at boot the storage subsystem may not be ready yet —
 * freeSpace()/addNamed() DOMRequests then simply NEVER complete (they do not
 * error). Every request therefore gets a timeout, and boot-time probing
 * (log/bootCheck) RETRIES only the volumes that were still failing until at
 * least one resolves or the budget runs out. Per-conversion call sites keep
 * the fast single-pass detect() because by then storage is warm.
 */
var StorageSel = (function () {
  'use strict';

  var PROBE = 'others/pfa_tmp/.storage_probe';
  var FREE_TIMEOUT = 8000;   // ms — generous: storage may still be mounting
  var PROBE_TIMEOUT = 8000;
  var LOW_FREE = 64 * 1024 * 1024; // 64 MB

  function errName(e) {
    try { return (e && e.name) || String(e); } catch (e2) { return 'unknown'; }
  }

  /**
   * Resolve the absolute path a storage would use for our probe file by
   * writing a tiny blob then deleting it. onDone(path|null, err|null).
   * addNamed REFUSES to overwrite (NoModificationAllowedError); a stale probe
   * from a crashed run is deleted once and the attempt retried.
   */
  function probePath(st, onDone) {
    var done = false;
    var attempt = 0;
    function finish(p, err) { if (done) return; done = true; onDone(p, err || null); }
    function run() {
      var req;
      try { req = st.addNamed(new Blob(['probe'], { type: 'text/plain' }), PROBE); }
      catch (e) { finish(null, 'throw:' + errName(e)); return; }
      var t = setTimeout(function () {
        if (done) return;
        try { st.delete(PROBE); } catch (e) {}
        finish(null, 'timeout');
      }, PROBE_TIMEOUT);
      req.onsuccess = function () {
        if (done) return;
        clearTimeout(t);
        var p = req.result || null;
        if (p == null) { finish(p, 'no-path'); return; }
        var del;
        try { del = st.delete(PROBE); } catch (e) { finish(p, null); return; }
        del.onsuccess = del.onerror = function () { finish(p, null); };
      };
      req.onerror = function () {
        if (done) return;
        clearTimeout(t);
        if (attempt === 0 && req.error && req.error.name === 'NoModificationAllowedError') {
          attempt = 1;
          try {
            var d = st.delete(PROBE);
            d.onsuccess = function () { run(); };
            d.onerror = function () { finish(null, errName(req.error)); };
          } catch (e2) { finish(null, errName(req.error)); }
          return;
        }
        finish(null, errName(req.error) || 'addNamedError');
      };
    }
    run();
  }

  // Rank used by select(): the removable SD card is PREFERRED for writes —
  // it has the room (user's unit: ~30GB free vs ~2.2GB internal) and .note
  // output is easy to move via card reader. Internal is the fallback.
  // classify() decides from probe path/name, not `default`.
  function rankOf(inf) {
    if (inf && inf.kind === 'sdcard') return 0;
    if (inf && inf.kind === 'internal') return 1;
    return 2;
  }

  /**
   * Pick the single volume the app will use for pfa_tmp/.note.
   * Preference: a volume that actually RESOLVED its write path (healthy)
   * beats one that couldn't (a broken/unmounted card must not be chosen);
   * among healthy volumes: removable SD first (rank), then more free space.
   */
  function select(infos) {
    if (!infos || !infos.length) return null;
    function healthy(x) { return !!(x && x.path != null); }
    var best = null;
    for (var i = 0; i < infos.length; i++) {
      var inf = infos[i];
      if (!best) { best = inf; continue; }
      var hI = healthy(inf), hB = healthy(best);
      if (hI && !hB) { best = inf; continue; }
      if (!hI && hB) continue;
      var rk = rankOf(inf), rkB = rankOf(best);
      var fI = (inf.free >= 0) ? inf.free : -1;
      var fB = (best.free >= 0) ? best.free : -1;
      if (rk < rkB || (rk === rkB && fI > fB)) best = inf;
    }
    return best;
  }

  /**
   * Classify a storage as internal / sdcard (removable).
   * Path is authoritative, then storage NAME (matches the 6300 4G), then the
   * `default` flag (least reliable — points at the SD here).
   */
  function classify(path, isDefault, name) {
    if (path) {
      if (/\/sdcard\//.test(path)) return 'internal';
      if (/\/sdcard1\//.test(path)) return 'sdcard';
      if (/\/external\//.test(path) || /\/extsdcard\//.test(path)) return 'sdcard';
      if (/\/emulated\/0/.test(path)) return 'internal';
    }
    var n = String(name || '');
    if (n === 'sdcard')  return 'internal';
    if (n === 'sdcard1') return 'sdcard';
    return isDefault ? 'internal' : 'sdcard';
  }

  /** freeSpace() with a timeout. cb(freeBytes, err). Never throws. */
  function probeFree(st, cb) {
    var fs;
    var settled = false;
    try { fs = st.freeSpace(); } catch (e) { cb(-1, 'throw:' + errName(e)); return; }
    if (!fs || typeof fs !== 'object') { cb(-1, 'no-request'); return; }
    var t = setTimeout(function () {
      if (settled) return;
      settled = true; cb(-1, 'timeout');
    }, FREE_TIMEOUT);
    try {
      fs.onsuccess = function () {
        if (settled) return; settled = true; clearTimeout(t); cb(fs.result, null);
      };
      fs.onerror = function (ev) {
        if (settled) return; settled = true; clearTimeout(t);
        cb(-1, errName(ev && ev.target && ev.target.error));
      };
    } catch (e) {
      if (settled) return;
      settled = true; clearTimeout(t); cb(-1, 'handler-attach');
    }
  }

  function infoFor(st, free, freeErr, path, pathErr) {
    return {
      st: st,
      name: st.storageName,
      'default': st['default'],
      free: free,
      freeErr: freeErr,
      path: path,
      pathErr: pathErr,
      kind: classify(path, st['default'], st.storageName)
    };
  }

  /**
   * Probe ONE volume (freeSpace → probePath). cb(info, ok). Never throws.
   * Used sequentially by detect() and, for failing volumes, by the boot retry.
   */
  function probeOne(st, cb) {
    probeFree(st, function (free, freeErr) {
      probePath(st, function (path, pathErr) {
        try { cb(infoFor(st, free, freeErr, path, pathErr)); } catch (e) {}
      });
    });
  }

  /** Single sequential probe pass over every volume (no coordinator). */
  function readProbe(st, cb) {
    probeFree(st, function (free, freeErr) {
      try { cb(infoFor(st, free, freeErr, null, 'no-write-probe')); } catch (e) {}
    });
  }
  function _detectRaw(onDone, readOnly) {
    var all;
    try { all = (navigator.getDeviceStorages && navigator.getDeviceStorages('sdcard')) || []; }
    catch (e) { all = []; }
    var infos = [];
    var idx = 0;
    (function next() {
      if (idx >= all.length) { onDone(infos); return; }
      var st = all[idx];
      var pr = readOnly ? function (inf) { return readProbe(st, inf); } : function (inf) { return probeOne(st, inf); };
      pr(function (inf) {
        infos.push(inf);
        idx++; next();
      });
    })();
  }

  /**
   * Detect all sdcard-type storages with { free, path, kind }. During an
   * active boot probe session this JOINS the session's snapshot instead of
   * running a competing probe chain (two chains hammering the same probe path
   * would lock up the storage). Otherwise it does one fast pass. Callers
   * during conversion use this.
   */
  function detect(onDone) {
    onDone = onDone || function () {};
    if (_session && !_session.final) { _onSessionResult(onDone); return; }
    _detectRaw(onDone);
  }

  /**
   * ONE genuine write-permission check via a real tiny write (gate). Used by
   * the conversion's pickStorage whenever permission isn't "granted" already:
   * the addNamed surfaces the OS "Allow device-storage:sdcard?" prompt (or a
   * re-prompt if the permission got revoked), and the gate waits for the
   * answer — Allow → ok(true); Not Allow → ok(false). Nothing hangs and the
   * caller can then fall back to its grant-path instructions.
   */
  function ensure(onDone) {
    onDone = onDone || function () {};
    if (_perm === 'granted') { onDone(true); return; }
    _gateWritable(function (ok) { onDone(ok); });
  }

  function _storageList() {
    try { return (navigator.getDeviceStorages && navigator.getDeviceStorages('sdcard')) || []; }
    catch (e) { return []; }
  }

  var _wakeGate = false;
  // Decided by key probe (see _listenWake): the OS permission prompt is a
  // MODAL — while it is up, keys never reach the app. So the first key that
  // DOES reach the app with permission still "pending" proves the prompt just
  // closed. A single bounded addNamed then decides it: Allow → granted
  // instantly; a Not Allow makes the request hang → the 1.5s cap declares
  // "denied" so the grant dialog appears promptly instead of a 90s timeout.
  function _decidePerm() {
    if (_perm === 'granted' || _perm === 'denied') return;
    console.log('[Storage] prompt closed / first key — running decisive single write check…');
    var st = _storageList()[0];
    if (!st) { setPerm('denied'); return; }
    var nm = 'others/pfa_tmp/.perm' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    var done = false;
    function finish(ok, perm) { if (done) return; done = true; setPerm(perm); }
    var req;
    try { req = st.addNamed(new Blob(['p'], { type: 'text/plain' }), nm); }
    catch (e) { finish(false, 'denied'); return; }
    var t = setTimeout(function () { finish(false, 'denied'); }, 1500);
    req.onsuccess = function () {
      clearTimeout(t);
      try { st.delete(nm); } catch (e) {}
      finish(true, 'granted');
    };
    req.onerror = function () {
      clearTimeout(t);
      var en = (req.error && req.error.name) || '';
      finish(false, _isDenyName(en) ? 'denied' : 'denied');
    };
  }
  function _listenWake() {
    function wake() { _wakeGate = true; }
    try {
      var doc = document;
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'visible') wake();
      }, false);
    } catch (e) {}
    try {
      window.addEventListener('focus', function () { wake(); }, false);
    } catch (e) {}
    // Foreground keys while pending = permission prompt dismissed.
    function key() { if (_perm === 'pending') _decidePerm(); }
    try { doc.addEventListener('keydown', key, false); } catch (e) {}
    try { doc.addEventListener('keyup', key, false); } catch (e) {}
  }

  // ── Runtime storage-permission state ────────────────────────────────
  // 'granted' → writes accepted; 'denied' → user refused / revoked via
  // Settings → App Permissions; 'pending' → dialog unanswered or unprovable
  // yet. Menu items that write to storage (Load MIDI, Export Log) yield and
  // show a grant-path hint whenever this isn't 'granted'.
  var _perm = 'pending';
  var _permCbs = [];
  var PERM_DENY = ['SecurityError', 'NotAllowedError', 'DeniedError',
                   'PermissionDeniedError', 'NoPermissionError'];
  function _isDenyName(n) { return !!n && PERM_DENY.indexOf(n) !== -1; }
  function setPerm(p) {
    if (p === _perm) return;
    _perm = p;
    for (var i = 0; i < _permCbs.length; i++) {
      try { _permCbs[i](_perm); } catch (e) {}
    }
  }
  function permState() { return _perm; }
  function onPerm(cb) {
    if (typeof cb === 'function' && _permCbs.indexOf(cb) === -1) _permCbs.push(cb);
  }
  function markDenied() { setPerm('denied'); }

  // One-shot writable check (short cap). onDone(granted). Keeps _perm in
  // sync. Uses a UNIQUE name so a stale .perm file can never trip
  // NoModificationAllowed into a false "blocked".
  // NEVER issues its own addNamed while a gate/session is deciding: a second
  // concurrent tiny write while the OS prompt is unanswered queues a SECOND
  // permission prompt (the "fresh install asks twice" bug).
  function refreshPerm(onDone) {
    onDone = onDone || function () {};
    if (_perm === 'granted') { onDone(true); return; }
    if ((_session && !_session.final) || _gateBusy) {
      (_session && !_session.final
        ? _onSessionResult(function () { onDone(_perm === 'granted'); })
        : _gateWritable(function (ok) { onDone(ok); }));
      return;
    }
    var once = false;
    function finish(ok, perm) {
      if (once) return;
      once = true;
      setPerm(perm);
      onDone(ok);
    }
    var st = _storageList()[0];
    if (!st) { setPerm('pending'); onDone(false); return; }
    var nm = 'others/pfa_tmp/.perm' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    var req;
    try { req = st.addNamed(new Blob(['p'], { type: 'text/plain' }), nm); }
    catch (e) { finish(false, 'denied'); return; }
    var t = setTimeout(function () { finish(false, 'pending'); }, 1200);
    req.onsuccess = function () {
      clearTimeout(t);
      try { st.delete(nm); } catch (e) {}
      finish(true, 'granted');
    };
    req.onerror = function () {
      clearTimeout(t);
      var en = (req.error && req.error.name) || '';
      finish(false, _isDenyName(en) ? 'denied' : 'pending');
    };
  }

  // Mutex around the gate: at most ONE addNamed loop may run at a time.
  // Two concurrent tiny-write loops while the OS permission prompt is
  // unanswered queue a SECOND permission prompt (the "fresh install asks
  // twice" bug). Late callers (refreshPerm, pickStorage's ensure, boot)
  // simply chain behind the running gate instead of issuing their own.
  var _gateBusy = false;
  var _gateQueue = [];
  function _gateWritable(onReady, maxElapsed) {
    if (_gateBusy) { _gateQueue.push(onReady); return; }
    _gateBusy = true;
    _gateWritableUnsafe(onReady, maxElapsed);
  }
  function _releaseGate() {
    _gateBusy = false;
    while (_gateQueue.length) {
      var nx = _gateQueue.shift();
      if (nx) { _gateWritableUnsafe(nx); return; }
    }
  }

  /**
   * Gate: waits until the storage subsystem ACCEPTS WRITES. On first launch a
   * KaiOS permission dialog ("Allow device-storage:sdcard?") is shown; every
   * request issued while it's still pending hangs, so the boot probe times
   * out → both volumes print "?". The gate instead retries ONE tiny unique
   * write with a short 900ms cap until it succeeds (permission answered:
   * Allow) or the wall-clock budget runs out. Only then does the heavy probe
   * run — so "allow after the dialog sat there for a while" recovers cleanly.
   */
  function _gateWritableUnsafe(onReady, maxElapsed) {
    var t0 = Date.now();
    var budget = maxElapsed || 90000;
    var st = _storageList()[0];
    if (!st) { onReady(false); _releaseGate(); return; }
    var n = 0, warned = false, sawDeny = false;
    function finish(ok) {
      if (!ok && !sawDeny && Date.now() - t0 <= budget) {
        if (!warned && Date.now() - t0 > 4000) {
          warned = true;
          console.log('[Storage] waiting for storage permission… (Allow device-storage:sdcard) — probing paused until granted');
        }
        setTimeout(tryOnce, _wakeGate ? 0 : 300);
        return;
      }
      // Budget ran dry without a deny → treat as denied so the UI knows the
      // write never became available.
      if (!ok && !sawDeny && _perm !== 'granted') setPerm('denied');
      onReady(ok);
      _releaseGate();
    }
    (function tryOnce() {
      // The wake-check may have decided permission already while this loop
      // was waiting on a hanging prompt: abort to the decision instead of
      // issuing more tiny writes (each one past a Not Allow waits 900ms and,
      // worse, can make the OS re-prompt the permission).
      if (_perm === 'denied') { onReady(false); _releaseGate(); return; }
      if (_perm === 'granted') { onReady(true); _releaseGate(); return; }
      var nm = 'others/pfa_tmp/.perm' + Date.now() + '-' + (n++) + '-' + Math.floor(Math.random() * 1e6);
      var settled = false;
      var req;
      try { req = st.addNamed(new Blob(['p'], { type: 'text/plain' }), nm); }
      catch (e) { finish(false); return; }
      var t = setTimeout(function () { if (settled) return; settled = true; finish(false); }, 900);
      req.onsuccess = function () {
        if (settled) return; settled = true; clearTimeout(t);
        try { st.delete(nm); } catch (e) {}
        setPerm('granted');
        finish(true);
      };
      req.onerror = function () {
        var en = (req.error && req.error.name) || '';
        if (settled) return; settled = true; clearTimeout(t);
        // Permission denied (Not Allow): STOP retrying immediately — hammering
        // addNamed while revoked can make the OS re-prompt the permission (the
        // "I had to say Not Allow twice" report) and destabilise the app.
        if (_isDenyName(en)) { sawDeny = true; setPerm('denied'); }
        finish(false);
      };
    }());
  }

  /**
   * Boot-time probing with recovery: waits for the storage service to accept
   * writes (_gateWritable handles the pending-permission case), then runs a
   * full pass; if no volume resolved a writable path yet, re-probe ONLY the
   * failing volumes until at least one succeeds or the budget/90s runs out.
   * onDone(infos, tries).
   */
  function detectWithRetry(onDone, maxTries) {
    onDone = onDone || function () {};
    var tries = 0;
    var t0 = Date.now();
    var budget = maxTries || 6;
    var MAX_ELAPSED = 90000;
    var START_DELAY = 500; // tiny settle; the gate mutex already prevents a second prompt
    var done = false;
    function finish(infos) { if (done) return; done = true; onDone(infos, tries); }
    function expired() { return Date.now() - t0 > MAX_ELAPSED; }
    function anyPath(infos) {
      for (var i = 0; i < infos.length; i++) if (infos[i].path != null) return true;
      return false;
    }
    function resolveLog(infos, suffix) {
      if (tries > 1) console.log('[Storage] resolved after ' + tries + ' probe attempt' + (tries > 1 ? 's' : '') + suffix);
    }
    var round = function () {
      if (done) return;
      var ro = (_perm !== 'granted');
      tries++;
      _detectRaw(function (infos) {
        if (done) return;
        // When the write gate came back NOT-granted, a writable pass would
        // issue addNamed while the permission is revoked → which makes the OS
        // RE-PROMPT the permission (a second dialog). Do a read-only pass
        // (freeSpace only) and finish: paths legitimately stay null.
        if (anyPath(infos) || tries >= budget || expired() || ro) {
          resolveLog(infos, '');
          if (ro && tries === 1) console.log('[Storage] write permission not granted — snapshot read-only (path will map to ?)');
          if (tries > 1 && !anyPath(infos)) console.log('[Storage] still no writable volume after ' + Math.round((Date.now() - t0) / 1000) + 's (permission?)');
          finish(infos);
          return;
        }
        setTimeout(function () {
          if (done) return;
          var failed = [];
          infos.forEach(function (inf, i) {
            if (inf.path == null) failed.push(i);
          });
          if (!failed.length) { finish(infos); return; }
          var left = failed.length;
          var merged = infos.slice();
          failed.forEach(function (i) {
            probeOne(infos[i].st, function (ninf) {
              if (done) return;
              merged[i] = ninf;
              if (--left === 0) {
                if (anyPath(merged)) {
                  resolveLog(infos, '');
                  finish(merged);
                } else {
                  round();
                }
              }
            });
          });
        }, _wakeGate ? 0 : 800);
      }, ro);
    };
    _listenWake();
    // Delay the START so the OS's own permission prompt (shown at app
    // launch on a fresh install) is answered BEFORE we issue our first
    // DeviceStorage write. Issuing addNamed while that prompt is still up
    // triggers a SECOND permission prompt (user sees it twice) and can
    // destabilise the launch.
    console.log('[Storage] waiting ' + (START_DELAY / 1000) + 's for the OS permission prompt to settle…');
    setTimeout(function () {
      if (done) return;
      _gateWritable(function (granted) {
        if (done) return;
        if (!granted) console.log('[Storage] storage permission NOT granted within budget — snapshot may show ?');
        round();
      });
    }, START_DELAY);
  }

  /**
   * Boot probing coordinator: log() AND bootCheck() both need the boot-time
   * snapshot. Running two independent probing chains (each addNamed/delete'ing
   * the SAME .storage_probe path on the same volume) from two chains at once
   * causes file-lock contention — every request hangs and times out. So a
   * single probe session is shared; late callers get the finished snapshot.
   */
  var _session = null;
  function _ensureSession() {
    if (_session) return _session;
    _session = { cbs: [], final: false, infos: null };
    detectWithRetry(function (infos, tries) {
      _session.final = true;
      _session.infos = infos;
      var cbs = _session.cbs.slice();
      _session.cbs = [];
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](infos); } catch (e) {} }
    });
    return _session;
  }
  function _onSessionResult(cb) {
    var s = _ensureSession();
    if (s.final) { try { cb(s.infos); } catch (e) {} return; }
    s.cbs.push(cb);
  }

  /**
   * Boot-time console log: prints each volume (internal vs SD) with the REAL
   * probed path/free and any per-request error so failures are diagnosable.
   */
  function log() {
    console.log('[Storage] probe started (distinguish internal vs SD)');
    _onSessionResult(function (infos) {
      if (!infos.length) {
        console.log('[Storage] no DeviceStorage available');
        return;
      }
      infos.forEach(function (inf, i) {
        var freeMB = inf.free >= 0 ? (inf.free / 1048576).toFixed(1) : '?';
        var dbg = (inf.free < 0 && inf.freeErr ? ' freeErr=' + inf.freeErr : '') +
                  (!inf.path && inf.pathErr ? ' pathErr=' + inf.pathErr : '');
        console.log('[Storage] [' + i + '] name=' + inf.name +
          ' default=' + inf['default'] +
          ' kind=' + inf.kind +
          ' path=' + (inf.path || '?') +
          ' free=' + freeMB + 'MB' + dbg);
      });
      var internal = null, sd = null;
      for (var i = 0; i < infos.length; i++) {
        if (infos[i].kind === 'internal' && !internal) internal = infos[i];
        else if (infos[i].kind === 'sdcard' && !sd) sd = infos[i];
      }
      var chosen = select(infos);
      vsLog('RESULT', internal, sd);
      if (chosen) {
        console.log('[Storage] USING: ' + chosen.name +
          ' (' + chosen.kind + ') path=' + (chosen.path || '?') +
          ' free=' + (chosen.free >= 0 ? (chosen.free / 1048576).toFixed(1) + 'MB' : '?'));
      }
      function vsLog(tag, a, b) {
        if (a && b) {
          console.log('[Storage] ' + tag + ': BOTH internal(' + (a.path || '?') +
            ') and SD(' + (b.path || '?') + ') available');
        } else if (a) {
          console.log('[Storage] ' + tag + ': using internal (' + (a.path || '?') + ')');
        } else if (b) {
          console.log('[Storage] ' + tag + ': using SD (' + (b.path || '?') + ')');
        } else {
          console.log('[Storage] ' + tag + ': no usable volume yet (' + infos.length + ' reported)');
        }
      }
    });
  }

  /**
   * Boot-time storage health check: reports whether there is a volume with
   * enough free space (>= LOW_FREE). onDone({ low, infos }). "low" is true
   * only when EVERY readable volume is below the floor. Unknown free (-1)
   * volumes are ignored so a flaky card doesn't spam a false warning.
   */
  function bootCheck(onDone) {
    _onSessionResult(function (infos) {
      var best = -1;
      for (var i = 0; i < infos.length; i++) {
        if (infos[i].free >= 0 && infos[i].free > best) best = infos[i].free;
      }
      onDone({ low: best >= 0 && best < LOW_FREE, infos: infos });
    });
  }

  return {
    detect: detect,
    ensure: ensure,
    log: log,
    probePath: probePath,
    select: select,
    bootCheck: bootCheck,
    permState: permState,
    onPerm: onPerm,
    markDenied: markDenied,
    refreshPerm: refreshPerm
  };
})();