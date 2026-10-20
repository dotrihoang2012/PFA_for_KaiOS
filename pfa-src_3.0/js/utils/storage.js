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
    // HARD guard: a real write here (addNamed) re-opens the OS App Permissions
    // prompt if it hasn't been granted yet. Only write when confirmed granted;
    // otherwise report no path (read-only) — probeFree below still yields the
    // free space the console wants.
    if (_perm !== 'granted') { onDone(null, 'no-write-probe'); return; }
    _diagLogWrite('probePath');
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
    // HARD guard: when the permission is NOT granted (still pending, or
    // revoked/denied) do NOT touch freeSpace() — on some KaiOS builds
    // freeSpace() itself re-opens the OS App Permissions prompt, which is the
    // "second prompt right after deny" bug. Report no usable data instead;
    // the console already printed the free-space check as cancelled/held.
    if (_perm !== 'granted') {
      try { cb(infoFor(st, -1, 'perm-not-granted', null, 'no-write-probe')); } catch (e) {}
      return;
    }
    probeFree(st, function (free, freeErr) {
      try { cb(infoFor(st, free, freeErr, null, 'no-write-probe')); } catch (e) {}
    });
  }
  function _detectRaw(onDone, readOnly) {
    // HARD guarantee: never write unless the permission is already confirmed
    // granted. Issuing addNamed/probePath while the permission is pending or
    // denied makes the OS re-show its App Permissions prompt (the "fresh
    // install asks twice" bug) — writes are allowed here ONLY after grant.
    if (!readOnly && _perm !== 'granted') readOnly = true;
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
  // Focus/visibility returning while the gate's write is STILL unanswered
  // (`_gateWaiting`) means the prompt closed without the write resolving.
  // We NEVER conclude DENIED here: a "denied" read could be the OS auto-
  // dismissing the prompt after a timeout rather than the user pressing Deny,
  // and the requirement is to WAIT INDEFINITELY (no timeout → no auto-deny).
  // The ONLY trustworthy signal for a real user Deny is the gate write's
  // onerror (req.onerror → denied). So this path can only ever promote to
  // GRANTED — a timeout is never a false grant, so a read of "granted" here
  // is safe to accept.
  var _decidePerm = function () {
    if (_perm !== 'prompt' && _perm !== 'pending') return;
    // Only act while the gate's prompt-triggering write is STILL unanswered.
    // If the write already settled, the gate already decided via onsuccess/
    // onerror — never re-decide here.
    if (!_gateWaiting) return;
    _verifyNoPrompt(function (p) {
      if (_perm === 'granted' || _perm === 'denied') return;
      // A real user Deny always arrives through req.onerror; only a GRANT is
      // trusted here. Anything else (denied from an OS auto-timeout, or
      // unknown) → keep waiting, never conclude denied.
      if (p !== 'granted') return;
      console.log('[Storage] permission = granted — boot free-space check runs normally');
      setPerm('granted');
    });
  };
  function _listenWake() {
    function wake() {
      _wakeGate = true;
      // The OS permission prompt is MODAL: the window only regains focus /
      // visibility after the user answered it. When a write request then
      // NEVER calls back (this KaiOS build hangs on Not Allow), settle the
      // decision read-only right here: deny is detected instantly, and no
      // second write is ever issued (so no second prompt).
      if (_perm === 'pending') _decidePerm();
    }
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

  // Read-only permission state via the Permissions API — NO write, so it
  // NEVER triggers the OS "Allow device-storage:sdcard?" prompt. This stops
  // the app re-asking App Permissions on every reopen when the permission
  // was already denied/revoked. cb('granted' | 'denied' | 'prompt' | null
  // when unsupported).
  function queryPerm(cb) {
    var done = false;
    function ok(v) { if (!done) { done = true; try { cb(v); } catch (e) {} } }
    try {
      if (navigator.permissions && typeof navigator.permissions.query === 'function') {
        navigator.permissions.query({ name: 'device-storage:sdcard' }).then(
          function (r) {
            var s = (r && r.state) || '';
            ok((s === 'granted' || s === 'denied' || s === 'prompt') ? s : null);
          },
          function () { ok(null); }
        );
        return;
      }
    } catch (e) {}
    ok(null);
  }

  // ── Runtime storage-permission state ────────────────────────────────
  // Persisted across app opens so a denied permission is known WITHOUT a
  // single write on the next boot — a write while revoked is what makes the
  // OS re-show its App Permissions prompt on every reopen. The cache is only
  // a hint; _verifyNoPrompt() re-checks it with read-only API calls so a
  // permission re-granted in Settings is picked up automatically.
  var PERM_KEY = 'pfa.storage.perm';
  function _readsCachedPerm() {
    try {
      var v = localStorage.getItem(PERM_KEY);
      return (v === 'granted' || v === 'denied') ? v : null;
    } catch (e) { return null; }
  }
  function _writeCachedPerm(p) {
    try { localStorage.setItem(PERM_KEY, p); } catch (e) {}
  }
  // Resolve the permission with NO write and NO OS prompt:
  //   1. Permissions API query, when supported (definitive).
  //   2. Last session's persisted decision (cache) — for a GRANT only.
  //   3. null → truly unknown (fresh install, or OS query unsupported).
  // A cached "denied" is deliberately NOT trusted here: the user may have
  // re-granted in Settings after we last wrote the cache, so returning a stale
  // "denied" would make every reopen (and hot-open) show the deny error forever
  // even after a re-grant. Only the OS query's own "denied" is authoritative.
  // freeSpace() is deliberately NOT a signal: on KaiOS it returns a number even
  // when write access is refused, so it would report granted wrongly.
  // cb('granted' | 'denied' | null).
  function _verifyNoPrompt(cb) {
    queryPerm(function (qst) {
      if (qst === 'granted' || qst === 'denied') { cb(qst); return; }
      var c = _readsCachedPerm();
      cb(c === 'granted' ? 'granted' : null);
    });
  }
  // Always start as 'pending' — never trust the cache synchronously at load.
  // The OS may have reset the permission (reinstall clears OS state but NOT
  // localStorage), so a stale "denied" cache would make the error dialog pop
  // BEFORE the system prompt even appears. Let the async _validatePermCache
  // and the gate set the real value.
  var _perm = 'pending';
  var _permCbs = [];

  // ── Boot-time cache validation ───────────────────────────────────────────
  // On KaiOS, reinstalling the app clears the OS permission state but NOT
  // localStorage. So cache can say "denied" while the OS is back to "prompt"
  // and will show its "Allow memory card?" dialog again at launch. If we
  // blindly trust the stale cache, the error dialog pops BEFORE the user has
  // had a chance to press Allow/Cancel on the system prompt. Fix: re-check
  // with the read-only Permissions API at load. When the API says "prompt"
  // (or is unsupported/null) but cache says "denied", the cache is stale —
  // the user may have re-granted in Settings since we last wrote it — clear
  // it and let the gate re-determine via its real write (which succeeds
  // silently on a re-granted device).
  (function _validatePermCache() {
    queryPerm(function (qst) {
      // If the gate or _decidePerm already decided, don't override.
      if (_perm !== 'pending') return;
      if (qst === 'granted') { setPerm('granted'); return; }
      if (qst === 'denied')  { setPerm('denied');  return; }
      // query says 'prompt' or is unsupported (null) → the OS cannot confirm
      // a denial read-only. A cached "denied" from a previous session may now
      // be stale (user re-granted in Settings), so don't trust it — drop it
      // and let the gate re-detect. Only a confident read-only 'denied' from
      // the OS keeps the error dialog without any storage access.
      var cached = _readsCachedPerm();
      if (cached === 'denied') {
        console.log('[Storage] cached denied but OS query cannot confirm (' + qst + ') — clearing stale cache so a Settings re-grant is detected');
        try { localStorage.removeItem(PERM_KEY); } catch (e) {}
        setPerm('pending');
      }
    });
  })();
  var PERM_DENY = ['SecurityError', 'NotAllowedError', 'DeniedError',
                   'PermissionDeniedError', 'NoPermissionError'];
  function _isDenyName(n) { return !!n && PERM_DENY.indexOf(n) !== -1; }
  function setPerm(p) {
    if (p === _perm) return;
    _perm = p;
    if (p === 'granted' || p === 'denied') _writeCachedPerm(p);
    for (var i = 0; i < _permCbs.length; i++) {
      try { _permCbs[i](_perm); } catch (e) {}
    }
  }
  function permState() { return _perm; }
  function onPerm(cb) {
    if (typeof cb === 'function' && _permCbs.indexOf(cb) === -1) _permCbs.push(cb);
  }
  function markDenied() { setPerm('denied'); }

  // Read-only permission re-check. onDone(granted). NEVER writes: a bogus
  // write while the permission is revoked re-opens the OS App Permissions
  // prompt (the "asks again on every reopen" bug). Decision comes from
  // _verifyNoPrompt → query + freeSpace + last-session cache; existing
  // in-flight session/gate results take precedence when still deciding.
  function refreshPerm(onDone) {
    onDone = onDone || function () {};
    if (_perm === 'granted') { onDone(true); return; }
    if ((_session && !_session.final) || _gateBusy) {
      (_session && !_session.final
        ? _onSessionResult(function () { onDone(_perm === 'granted'); })
        : _gateWritable(function (ok) { onDone(ok); }));
      return;
    }
    _verifyNoPrompt(function (p) {
      // Unknown (null) is NOT a denial — don't guess "denied", or the error
      // dialog would appear before the user has actually declined. Set only
      // when we have real evidence (granted/denied from query or cache).
      if (!p) { onDone(_perm === 'granted'); return; }
      setPerm(p);
      onDone(p === 'granted');
    });
  }

  // Mutex around the gate: at most ONE addNamed loop may run at a time.
  // Two concurrent tiny-write loops while the OS permission prompt is
  // unanswered queue a SECOND permission prompt (the "fresh install asks
  // twice" bug). Late callers (refreshPerm, pickStorage's ensure, boot)
  // simply chain behind the running gate instead of issuing their own.
  var _gateBusy = false;
  var _gateQueue = [];
  // Session-scoped: the OS permission prompt may only ever be triggered once
  // per app session (by the FIRST real write). Every later gate resolves
  // read-only, so a deny that makes requests hang can never cause a SECOND
  // App Permissions prompt.
  var _gateWrote = false;
  // True while the gate's prompt-triggering write request is still unanswered
  // on the OS side (its dialog was shown). Used to detect "prompt closed" via
  // focus/visibility (a deny never calls back on this build) without ever
  // mis-resolving permission at plain app load.
  var _gateWaiting = false;
  // DIAGNOSTIC: total number of real DeviceStorage writes issued this session.
  // The OS App Permissions prompt appears once per unresolved write — if the
  // user ever reports seeing the prompt MORE than once, this counter shows how
  // many writes actually fired and helps pinpoint the extra call site.
  var _diagWrites = 0;
  function _diagLogWrite(src) {
    _diagWrites++;
    console.log('[Storage][DIAG] DeviceStorage WRITE #' + _diagWrites + ' from: ' + src + ' (perm=' + _perm + ', gateWrote=' + _gateWrote + ')');
  }
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
   * KaiOS permission dialog is shown — on this device the system labels its
   * buttons "Cancel" (= deny) and "OK" (= allow); the app cannot rename them.
   * Every request issued while the prompt is still pending just hangs (and on
   * some builds a Not-Allow never fires a callback at all).
   * The gate issues EXACTLY ONE tiny unique write and then WAITS for the user:
   * OK → onsuccess → granted; Cancel → onerror → denied. No second write is
   * ever issued here — a retry is what made the OS re-show its permission
   * dialog right after a deny (the "asks twice on fresh install" bug). If the
   * prompt never resolves (system stuck) the long cap releases the gate as
   * still-pending (no re-prompt); the first key that then reaches the app
   * (_decidePerm) settles the unanswered decision read-only.
   */
  function _gateWritableUnsafe(onReady) {
    if (!_storageList()[0]) { onReady(false); _releaseGate(); return; }
    (function tryOnce() {
      // The wake-check may have decided permission already while this loop was
      // waiting on a hanging prompt: abort to the decision instead of writing.
      if (_perm === 'denied') { onReady(false); _releaseGate(); return; }
      if (_perm === 'granted') { onReady(true); _releaseGate(); return; }
      // Read-only pre-check via the OS Permissions API — NOT the localStorage
      // cache. Only an authoritative read-only verdict lets us short-circuit
      // WITHOUT writing. We deliberately do NOT trust a cached "denied" here:
      // the user may have re-granted in Settings since the cache was written,
      // and trusting it would re-show the error on every reopen forever (the
      // "re-grant in Settings then reopen still errors" bug). So:
      //   granted → no prompt, granted;  denied → no prompt, error;
      //   prompt / unsupported / cache-only → do the ONE real write to
      //   re-verify (silent on an already-granted device).
      queryPerm(function (qst) {
        if (_perm === 'denied') { onReady(false); _releaseGate(); return; }
        if (_perm === 'granted') { onReady(true); _releaseGate(); return; }
        if (qst === 'granted') { setPerm('granted'); onReady(true); _releaseGate(); return; }
        if (qst === 'denied') { setPerm('denied'); onReady(false); _releaseGate(); return; }
        // The OS prompt can only appear from the FIRST real write of the
        // session. If a write already happened (even if the answer left the
        // request hanging instead of erroring), later gates NEVER write again —
        // they resolve read-only. This guarantees the permission dialog shows
        // at most once, even when a deny makes requests hang on the device.
        if (_gateWrote) {
          // Already asked this session — NEVER issue another write. Resolve
          // read-only only from the OS query; unknown stays pending rather
          // than guessing denied.
          if (qst === 'granted' || qst === 'denied') {
            setPerm(qst);
            console.log('[Storage] permission already asked this session — resolving read-only (' + qst + '), NOT re-asking');
            onReady(qst === 'granted'); _releaseGate(); return;
          }
          console.log('[Storage] permission already asked this session — still unresolved, NOT re-asking');
          onReady(false); _releaseGate(); return;
        }
        _gateWrote = true;
        _diagLogWrite('gate-doWrite');
        console.log('[Storage] === GATE WRITE #1 === perm=' + _perm + ' → addNamed → waiting for user to press Allow or Deny on the system prompt...');
        doWrite();
      });
      function doWrite() {
        var st = _storageList()[0];
        if (!st) { onReady(false); _releaseGate(); return; }
        var nm = 'others/pfa_tmp/.perm' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
        var settled = false;
        var req;
        try { req = st.addNamed(new Blob(['p'], { type: 'text/plain' }), nm); }
        catch (e) { onReady(false); _releaseGate(); return; }
        // The OS permission prompt is now visible. Wait INDEFINITELY for the
        // user to press Allow (onsuccess) or Cancel (onerror). No timeout,
        // no auto-conclusion — the app simply waits until the user decides.
        _gateWaiting = true;
        req.onsuccess = function () {
          if (settled) return; settled = true; _gateWaiting = false;
          try { st.delete(nm); } catch (e) {}
          setPerm('granted');
          onReady(true);
          _releaseGate();
        };
        req.onerror = function () {
          var en = (req.error && req.error.name) || '';
          if (settled) return; settled = true; _gateWaiting = false;
          console.log('[Storage][DIAG] gate write onerror — error.name=' + JSON.stringify(en) + ' isDenyName=' + _isDenyName(en));
          if (_isDenyName(en)) { setPerm('denied'); onReady(false); _releaseGate(); return; }
          console.log('[Storage] real write failed (' + (en || 'no error-name') + ') — leaving permission pending');
          onReady(false); _releaseGate();
        };
      }
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
      // If the gate did NOT return "granted", the permission is pending or
      // denied — NEVER issue a writable probe here (each addNamed while the
      // OS prompt is unanswered/un-granted re-opens it). Force read-only.
      var ro = (_perm !== 'granted') ? true : false;
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
  var _bootLogState = ''; // '' | 'granted' | 'cancelled'
  function _bootStorageLog(perm) {
    var p = perm || permState();
    if (p !== 'granted' && p !== 'denied') return; // pending → wait for the user's decision
    if (p === 'denied') {
      if (_bootLogState === 'cancelled') return;
      _bootLogState = 'cancelled';
      console.log('[Storage] permission not granted — free-space check cancelled');
      return;
    }
    if (_bootLogState === 'granted') return;
    _bootLogState = 'granted';
    // Granted: now (and only now) probe freeSpace and show the volumes.
    var vols = _storageList();
    if (!vols.length) {
      console.log('[Storage] no DeviceStorage available after grant');
      return;
    }
    console.log('[Storage] boot volumes:');
    vols.forEach(function (st, i) {
      probeFree(st, function (free, err) {
        var mb = free >= 0 ? (free / 1048576).toFixed(1) + 'MB' : '?';
        console.log('[Storage]   [' + i + '] name=' + (st.storageName || '?') +
          ' default=' + !!st['default'] + ' free=' + mb +
          (free < 0 && err ? ' (' + err + ')' : ''));
      });
    });
  }

  function log() {
    console.log('[Storage] probe started (distinguish internal vs SD)');
    // Free-space listing only AFTER the permission decision: granted → probe
    // and show the volumes; denied / not granted → one "cancelled" line and
    // no free-space probe; pending → wait for the user to choose Allow/Not
    // Allow on the OS prompt.
    _bootStorageLog();
    onPerm(_bootStorageLog);
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
    verifyNoPrompt: _verifyNoPrompt,
    refreshPerm: refreshPerm
  };
})();