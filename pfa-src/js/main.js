/**
 * main.js — KaiOS Black MIDI Player entry point.
 * Boots canvas, wire Sequencer↔Synth, render loop, HUD.
 *
 * DATA FLOW:
 *   [SD .mid.json] → JSON.parse() → Store.notes[]
 *     → Sequencer.load() → pulse(25ms) → noteOn/off callbacks
 *     → Synth.noteOn/Off (Web Audio)
 *     → rAF loop → Keyboard.draw + Notes.draw + HUD.tick
 *
 * CACHE:
 *   .mid files → parse → hash → /data/local/tmp/<hash>.mid.json → load cached JSON
 *   Clear Cache menu option deletes cached .mid.json files
 */
(function () {
  'use strict';

  var canvas, ctx;
  var width, height;
  var rafId;
  var lastFrameTime = 0, fpsCounter = 0, fpsAcc = 0;

  // Pending activity payload — MozActivity may fire before boot()
  // has registered the canvas / wired the Synth. Park it here and
  // let boot() flush once the DOM and audio graph are ready.
  var _pendingActivity = null;

  // True from the moment any real-file activity (FM open/share/import) or
  // file picker load is being serviced until the file is loaded. Guards the
  // boot-time demo racer: when a hot load lands DURING boot (canvas already
  // wired but boot() still mid-flight), boot() would otherwise fall into its
  // else-branch and startDemo() — which calls loadMIDIData() → hideParsing()
  // and Sequencer.play(). That kills the analyzing/reading OSD and lets the
  // demo track play behind the real conversion.
  var _activityBusy = false;

  // ── Hot-open permission gate ──
  // A MIDI picked via File Manager (MozActivity 'open') is parsed in memory,
  // but conversion/export/WAV still need SD access, so when the storage
  // permission is NOT granted we block the load and show the same grant
  // dialog as Load MIDI / Export Log — OK exits the app. Resolution is
  // read-only (query + freeSpace + last-session cache), never a write, so a
  // reopen / hot-open can never make the OS re-show its App Permissions
  // prompt.
  function _gateHotOpen(cont) {
    if (typeof StorageSel === 'undefined' || !StorageSel.permState) { cont(); return; }
    if (StorageSel.permState() === 'granted') { cont(); return; }
    if (StorageSel.permState() === 'denied') { _blockHotOpen(); return; }
    // Still pending/unprovable → resolve read-only (query + last-session
    // cache). If truly unknown (fresh install, never decided), let ONE
    // bounded write surface the OS "Allow?" prompt a single time; its answer
    // sets the permission (DENY → denied → this dialog), then we decide.
    function finalize(ok) {
      if (ok) { cont(); return; }
      // Only block if explicitly denied — pending/timeout = still waiting
      if (StorageSel.permState && StorageSel.permState() === 'denied') {
        _blockHotOpen();
      } else {
        // Permission pending or timed out — let user answer OS dialog, then retry on focus
        _activityBusy = false;
      }
    }
    if (StorageSel.verifyNoPrompt) {
      StorageSel.verifyNoPrompt(function (p) {
        if (p === 'granted') { cont(); return; }
        if (p === 'denied') { _blockHotOpen(); return; }
        StorageSel.ensure(function (ok) { finalize(ok); });
      });
    } else {
      StorageSel.ensure(function (ok) { finalize(ok); });
    }
  }
  function _blockHotOpen() {
    console.log('[Activity] storage permission not granted — hot-open blocked');
    _activityBusy = false;
    if (typeof window.pfaStorageDeniedDialog === 'function') {
      window.pfaStorageDeniedDialog(true);
    }
  }
  window.pfaGateHotOpen = _gateHotOpen;

  // Set on the first boot; guards the low-storage warning from re-firing
  // if boot() is somehow invoked again within the same app instance.
  var _bootStorageWarned = false;

  // Demo track (bundled demo.note) auto-plays on the first boot of each
  // app entry. While active we hide PLAY/PAUSE, show HUD as 0/0 + 0:00,
  // and lock transport + speed controls. Loading a real .mid/.note (or the
  // demo finishing) unlocks everything again.
  var _demoActive = false;
  // True from demo start through the end of the demo AND after it finishes,
  // until a real .mid/.note is loaded. While true the speed/transport hot
  // keys and Note Color Randomise stay locked (greyed); loading a file is
  // the only way to unlock.
  var _lockNoFile = false;

  // ── Foreground focus helper ──
  // When the user picks our app from File Manager's action sheet, KaiOS
  // 2.5 starts the app in the background and routes an "activity"
  // message. The OS does NOT automatically bring our app to the
  // foreground — the user sees the File Manager and the app runs as
  // backdrop.
  //
  // There is no documented focus() API for a backgrounded packaged
  // app, but on KaiOS the appwindow can be promoted to front by
  // briefly calling requestAnimationFrame after the activity result
  // is posted: the B2G shell wake-up re-evaluates the topmost
  // window on the next frame and promotes any window that just
  // received an activity request whose source was the user-driven
  // open/share dialog. (Java.shifat100 works for the same reason.)
  function _foregroundAfterActivity() {
    try {
      // Bouncing visibilitychange wakes the compositor on some KaiOS
      // builds. Harmless on builds that ignore it.
      document.dispatchEvent(new Event('visibilitychange'));
    } catch (e) {}
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        try { window.focus(); } catch (e) {}
        try { document.documentElement.focus(); } catch (e) {}
      });
    } else {
      setTimeout(function () {
        try { window.focus(); } catch (e) {}
      }, 50);
    }
  }

  // ── B2G appwindow resize ──
  // KaiOS 2.5 fires mozbrowserresize (privileged) or fires
  // visibilitychange + resize on appwindow wake-up from a MozActivity
  // route. Listening to both ensures we catch whichever the build
  // actually emits.
  if (typeof window !== 'undefined' && window.addEventListener) {
    var reanch = function () {
      try { onResize(); } catch (e) {}
      try { resizeCanvas(); } catch (e) {}
      try { Keyboard && Keyboard.rebuild && Keyboard.rebuild(); } catch (e) {}
    };
    window.addEventListener('mozbrowserresize', reanch, false);
    window.addEventListener('mozbrowserlocationchange', reanch, false);
  }

  // ── Activity handler (Open with... from File Manager) ──
  // KaiOS File Manager routes differ between KaiOS 2.5 builds:
  //   - newer (KaiOS 3.x-ish):   activity.source.data.blob (Blob, name attr)
  //   - older (B2G-derived):      activity.source.data.blobs[0]
  //   - filepaths-only route:     activity.source.data.filepaths[0] (must fetch)
  //   - some File Manager:        activity.source.data.filename only (path given)
  // We probe all four. If we get only a path, fetch it via XHR → arraybuffer.
  if (typeof navigator !== 'undefined' && typeof navigator.mozSetMessageHandler === 'function') {
    navigator.mozSetMessageHandler('activity', function (activity) {
      try {
        console.log('[Activity] HANDLER FIRED');
        var src = activity && activity.source;
        console.log('[Activity] src=', src, 'name=', src && src.name);
        if (!src) { try { activity.postError('no source'); } catch (e3) {} return; }
        // We accept both 'open' (single file picker) and 'share' (route-out).
        if (src.name !== 'open' && src.name !== 'share' && src.name !== 'import') {
          console.log('[Activity] skip — name not in open/share/import:', src.name);
          return;
        }
        var data = src.data || src;
        try {
          console.log('[Activity] name=' + src.name + ' keys=' + Object.keys(data).join(','));
          console.log('[Activity] data=', JSON.stringify(data, function (k, v) {
            if (v instanceof Blob) return '[Blob name=' + v.name + ' size=' + v.size + ']';
            return v;
          }));
        } catch (e) {}

        var blob = null;
        var name = null;
        var filepath = null;

        if (data.blob)         { blob = data.blob; console.log('[Activity] got data.blob'); }
        if (data.blobs && data.blobs.length) { blob = data.blobs[0]; console.log('[Activity] got data.blobs[0]'); }
        if (!blob && data.target && data.target.result instanceof Blob) {
          blob = data.target.result;
          console.log('[Activity] got data.target.result blob');
        }

        if (blob && blob.name) name = blob.name;
        if (data.filename)  { name = data.filename; console.log('[Activity] name from data.filename:', name); }
        if (data.filenames && data.filenames.length) name = data.filenames[0];
        if (data.url)       name = data.url.split('/').pop();

        if (data.filepaths && data.filepaths.length) { filepath = data.filepaths[0]; console.log('[Activity] filepath:', filepath); }
        if (!filepath && typeof data.filename === 'string' && data.filename.indexOf('/') >= 0) {
          filepath = data.filename;
          console.log('[Activity] filepath from filename:', filepath);
        }

        console.log('[Activity] resolved: blob?', !!blob, 'filepath?', !!filepath, 'name=', name);

        // Promote our appwindow to foreground BEFORE we start the parse,
        // not after. On KaiOS 2.5 the OS sometimes pre-empts the
        // foreground if FileReader fires before the appwindow is
        // realised; doing it here gives a cleaner wake-up in practice.
        _foregroundAfterActivity();

        // Any real file serviced now means the auto-started demo must NOT
        // also boot under it (see boot()'s else-branch → startDemo()).
        _activityBusy = true;

        // Hot-open still needs storage permission for convert / export / WAV,
        // so when it is NOT granted we block the load and show the standard
        // grant dialog (OK exits the app) instead of parsing in memory only.
        window.pfaHandledHotOpen = true;
        _gateHotOpen(function () {
        // If boot() hasn't run yet (canvas/Synth not wired), queue this
        // payload and let boot() flush it. Otherwise handle inline.
        if (!canvas) {
          console.log('[Activity] boot() not yet run — queuing payload');
          _pendingActivity = { activity: activity, blob: blob, name: name, filepath: filepath };
          return;
        }

        if (blob) {
          if (!name) name = 'picked.mid';
          if (_isJsonName(name)) {
            console.log('[Activity] reading blob as .note/.json...');
            showParsing(_parsingLabel(name)); // Reading Data...
            Store.setState({ fileName: name });
            window._midiBlob = blob; // expose for native audio
            window._midiName = name;
            _openNoteFile(blob, name);
            _foregroundAfterActivity();
            return;
          }
          console.log('[Activity] routing MIDI blob, size=', blob.size);
          showParsing(_parsingLabel(name)); // Analyzing MIDI Data...
          Store.setState({ fileName: name });
          window._midiBlob = blob; // expose for native audio
          window._midiName = name;
          _routeMidiBlob(blob, name);
          // Do NOT call activity.postResult() — on some KaiOS 2.5
          // builds posting a result from within an async path is
          // interpreted as "handler finished" and the B2G shell
          // closes the app down to whatever the user was last
          // looking at (File Manager). Caller (File Manager) is
          // satisfied by the host app just by us having handled
          // the message handler.
          _foregroundAfterActivity();
          return;
        }

        if (filepath) {
          // Filepath-only route: fetch as Blob (stream from disk, no OOM for large files)
          var fname = name || filepath.split('/').pop() || 'picked.mid';
          showParsing(_parsingLabel(fname));
          Store.setState({ fileName: fname });
          var url = filepath;
          if (filepath[0] === '/') url = 'file://' + filepath;
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = 'blob';  // Blob = disk reference, not RAM copy
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
              var fileBlob = xhr.response;
              window._midiBlob = fileBlob; // expose for native audio
              window._midiName = fname;
              if (_isJsonName(fname)) {
                // .note/.json MIDI — PFA2 binary streams from disk, else restore
                // the legacy JSON text path.
                _openNoteFile(fileBlob, fname, _foregroundAfterActivity);
                return;
              }
              // Route MIDI blob (large files skip the full ArrayBuffer read)
              _routeMidiBlob(fileBlob, fname);
              _foregroundAfterActivity();
            } else {
              console.error('[Main] XHR fetch failed', xhr.status);
              hideParsing();
            }
          };
          xhr.onerror = function () {
            console.error('[Main] XHR fetch error');
            hideParsing();
          };
          try { xhr.send(); } catch (e) {
            console.error('[Main] XHR send failed', e);
            hideParsing();
          }
          return;
        }

        try { console.warn('[Activity] unhandled shape — no blob / filepath. data=', JSON.stringify(data)); } catch (e) {}
        try { activity.postError('No file blob or filepath received'); } catch (e2) {}
        });
      } catch (e) {
        console.error('[Main] activity handler error:', e);
        try { activity.postError(e.message); } catch (e2) {}
      }
    });
  }

  // ── BOOT ──

  function boot() {
    console.log('[Main] boot: DOMContentLoaded; canvas exists?', !!document.getElementById('main-canvas'));

    // ── App Launch Loading Screen (init.png + log + % + progress bar) ──
    var bootDlg = document.getElementById('app-boot-dialog');
    var bootSubtitleEl = document.getElementById('app-boot-subtitle');
    var bootListEl = document.getElementById('app-boot-list');
    var bootBarEl = document.getElementById('app-boot-bar');
    var bootPctEl = document.getElementById('app-boot-percent');

    function updateBootProgress(pct, logMsg, detailLog) {
      var val = Math.min(100, Math.max(0, Math.round(pct)));
      if (bootBarEl) bootBarEl.style.width = val + '%';
      if (bootPctEl) bootPctEl.textContent = val + '%';

      var showLog = false;
      try {
        var st = (typeof Store !== 'undefined' && Store.getState) ? Store.getState() : null;
        if (st && (st.verboseInit || st.verboseLoadLog)) showLog = true;
      } catch (e) {}

      if (bootSubtitleEl) {
        bootSubtitleEl.textContent = logMsg || '';
        bootSubtitleEl.style.display = (showLog && logMsg) ? 'block' : 'none';
      }
      if (bootListEl) {
        bootListEl.textContent = detailLog || '';
        bootListEl.style.display = (showLog && detailLog) ? 'block' : 'none';
      }
    }

    if (bootDlg) {
      bootDlg.classList.remove('hidden');
      updateBootProgress(5, L10n.t('boot_app_core', 'Initializing App Core...'), '');
    }

    // Boot-time storage log: distinguish internal vs removable SD card
    // (used by the incremental .note writer). Does not block boot.
    try { if (typeof StorageSel !== 'undefined' && StorageSel.log) StorageSel.log(); } catch (e) {}

    // ── SD-card permission UX ─────────────────────────────────────────
    // KaiOS answers device-storage permission via an OS dialog. FIRST INSTALL:
    // the storage gate does ONE bounded write → the OS "Allow?" prompt appears
    // exactly once. Allow → granted: no dialogs, every open runs the free-space
    // console scan. Not Allow → denied: EVERY app open shows this error dialog
    // (OK exits) and the free-space scan is cancelled until the user re-grants
    // in Settings. Hot-opening a MIDI/.note while not granted shows the same
    // dialog. Menu Load MIDI / Export Log stay silent (dimmed).
    function _grantHint() {
      return 'This app needs SD card access.\n\nTo allow it:\nSettings → Privacy & Security → App Permissions → PFA → Memory Card Storage → Grant.\n\nThen reopen the app / reload the file.\n\nOK closes the app.';
    }
    function storageGranted() {
      return !!(typeof StorageSel !== 'undefined' && StorageSel.permState &&
                StorageSel.permState() === 'granted');
    }
    window.pfaStorageGranted = storageGranted;
    // true ONLY when the user revoked the permission ("pending"/"granted" are
    // NOT denied — pending is still waiting for the OS Allow prompt).
    function storageDenied() {
      return !!(typeof StorageSel !== 'undefined' && StorageSel.permState &&
                StorageSel.permState() === 'denied');
    }
    window.pfaStorageDenied = storageDenied;
    var _permDeniedShown = false;
    var _permGrantedHandled = false;
    function refreshPermissionUI() {
      var state = (typeof StorageSel !== 'undefined' && StorageSel.permState)
                  ? StorageSel.permState() : 'pending';
      var granted = (state === 'granted');
      var denied  = (state === 'denied');

      var mk = document.querySelector('#menu-list .kai-om-item[data-action="load-midi"]');
      if (mk) mk.classList.toggle('perm-locked', !granted);
      var er = document.querySelector('#settings-list .setting-row[data-key="exportLog"]');
      if (er) er.classList.toggle('perm-locked', !granted);

      // Allow: dismiss the stale PERMISSION dialog only — leave any other
      // modal (e.g. the background-image-missing dialog raised at boot)
      // alone. Tracked via window._pfaAuthDialog.
      if (granted && !_permGrantedHandled) {
        _permGrantedHandled = true;
        _permDeniedShown = true; // block any stale deny dialog
        if (window._pfaAuthDialog && typeof hideErrorDialog === 'function') {
          hideErrorDialog();
        }
        if (typeof StorageSel !== 'undefined' && StorageSel.scanStorages) {
          try { StorageSel.scanStorages(); } catch (e) {}
        }
      }

      // Pending: OS dialog not answered yet — do nothing, wait
      if (!granted && !denied) return;

      // Deny: show error dialog exactly ONCE per session, OK exits app
      if (denied && !_permDeniedShown && !window.pfaHandledHotOpen) {
        _permDeniedShown = true;
        showErrorDialog(_grantHint(), _pfaExit, 'Error');
        window._pfaAuthDialog = true; // tag this dialog as the permission one
      }

      if (typeof window.updateSoftkeys === 'function') {
        try { window.updateSoftkeys(); } catch (e) {}
      }
    }
    // Load gate for the Options "Load MIDI" picker (in-app, no activity):
    // blocked = inert no-op (dimmed), NO dialog — the boot-open and hot-open
    // gates are the dialog points.
    function guardStorageLoad(force) {
      if (storageGranted()) return true;
      return false;
    }
    window.pfaGuardStorageLoad = guardStorageLoad;
    // One-shot per-session "grant SD card access" dialog. Used by the hot-open
    // gate (_gateHotOpen) when a MIDI/.note is picked while not granted; the
    // boot-open path (refreshPermissionUI) shows the identical dialog itself.
    // OK EXITS the app; the user then grants in system Settings and reopens.
    // force=true keeps an EXPLICIT action responsive even if the once-per-
    // session guard already fired.
    var _permDialogShownOnce = false;
    window.pfaStorageDeniedDialog = function (force) {
      // Never show when permission is granted or still pending
      if (typeof StorageSel !== 'undefined' && StorageSel.permState) {
        var ps = StorageSel.permState();
        if (ps === 'granted' || ps === 'pending') return;
      }
      if (_permDialogShownOnce && !force) return;
      _permDialogShownOnce = true;
      showErrorDialog(_grantHint(), _pfaExit, 'Error');
      window._pfaAuthDialog = true; // tag this dialog as the permission one
    };
    // Close the app cleanly on OK. On KaiOS 2.5 window.close() closes the
    // dedicated appwindow; the setTimeout fallbacks cover builds that block it.
    function _pfaExit() {
      try { window.close(); } catch (e) {}
      setTimeout(function () {
        try { if (document.mozCancelFullScreen) document.mozCancelFullScreen(); } catch (e2) {}
        try { window.history.back(); } catch (e3) {}
      }, 50);
    }
    window.pfaExit = _pfaExit;
    try {
      if (typeof StorageSel !== 'undefined' && StorageSel.onPerm) {
        StorageSel.onPerm(function (p) {
          console.log('[Storage] permission state: ' + p);
          try { refreshPermissionUI(); } catch (e) {}
        });
      }
    } catch (e) {}
    // Focus/visibility regained (permission dialog answered, or user re-grants
    // via Settings App Permissions while the app is alive) → re-verify.
    try {
      function _recheckPerm() {
        // Already granted - no need to recheck, avoid triggering OS dialog again
        if (typeof StorageSel !== 'undefined' && StorageSel.permState &&
            StorageSel.permState() === 'granted') {
          try { refreshPermissionUI(); } catch (e) {}
          return;
        }
        if (typeof StorageSel !== 'undefined' && StorageSel.refreshPerm) {
          StorageSel.refreshPerm(function (ok) {
            try { refreshPermissionUI(); } catch (e) {}
          });
        }
      }
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') _recheckPerm();
      }, false);
      window.addEventListener('focus', _recheckPerm, false);
    } catch (e) {}
    // Apply the lock/dim state immediately at boot — permission may still be
    // "pending" (dialog unanswered), and pending is NOT granted → dim now,
    // brighten only when a later re-check confirms 'granted'.
    try { refreshPermissionUI(); } catch (e) {}
    // Lifecycle instrumentation: pin down WHY a hot-open exits while the
    // permission dialog is up (pagehide = the shell is closing the app).
    try {
      window.addEventListener('pagehide', function () {
        console.log('[Lifecycle] pagehide ' + (new Date().toISOString()));
      }, false);
      window.addEventListener('beforeunload', function () {
        console.log('[Lifecycle] beforeunload ' + (new Date().toISOString()));
      }, false);
    } catch (e) {}

    // Boot-time storage health check: if EVERY readable volume is below the
    // usable floor, converting any large MIDI would fail — warn once via the
    // error dialog as soon as the app opens.
    _bootStorageWarned = false;
    try {
      if (typeof StorageSel !== 'undefined' && StorageSel.bootCheck) {
        StorageSel.bootCheck(function (res) {
          if (!res || !res.low || _bootStorageWarned) return;
          _bootStorageWarned = true;
          var parts = (res.infos || []).map(function (inf) {
            var mbf = inf.free >= 0 ? Math.floor(inf.free / 1048576) + 'MB' : '?';
            return (inf.name || 'sdcard') + ' (' + mbf + ' free)';
          });
          var msg = 'Storage is nearly full: ' +
            (parts.length ? parts.join(', ') : 'no usable space') +
            '. Converting very large MIDI files may fail.';
          setTimeout(function () {
            if (typeof showErrorDialog === 'function') {
              try { showErrorDialog(msg); } catch (e) {}
            } else {
              console.warn('[Main] ' + msg);
            }
          }, 0);
        });
      }
    } catch (e) { console.error('[Main] storage boot check failed', e); }
    canvas = document.getElementById('main-canvas');
    if (!canvas) {
      console.error('[Main] FATAL: no #main-canvas');
      return;
    }
    ctx = canvas.getContext('2d');
    resizeCanvas();

    // Audio context lazy — only on user gesture (Chrome autoplay policy)
    // Synth.noteOn will bootstrap on first note dispatch

    // Wire Sequencer → Synth (only built-in oscillator engine; Pico and
    // WildWebMIDI are removed). _engine() returns the live engine ref so
    // HUD and controls can ask it for voices without knowing the concrete
    // engine.
    _activeEngine = Synth; // default engine until Settings.load() runs
    Sequencer.noteDown(function (note, ch, vel, delay, dur) {
      _engine().noteOn(note, ch, vel, delay, dur);
      // Feed NoteBuffer for O(1) render
    var st = Store.getState();

    // Keep keyWidth fitted to the current range every frame — covers
    // Keyboard Range edits from settings sub-pages without relying on
    // resize events. No-op once converged (value equality check).
    fitKeyboardWidth(st);
      if (typeof NoteBuffer !== 'undefined' && NoteBuffer.isReady()) {
        NoteBuffer.onNote(note, ch, vel, delay, dur,
          st.kbStart || 21, st.keyWidth || 16);
      }
    });
    Sequencer.noteUp(function (note, ch) {
      _engine().noteOff(note, ch);
    });
    Sequencer.onEnd(function () {
      Store.setState({ play: 'stop' });
      // Natural end of the bundled demo: the demo stops playing so HUD and
      // PLAY/PAUSE return to normal, but hot keys and Note Color Randomise
      // stay LOCKED until a real .mid/.note is loaded (loadMIDIData unlocks).
      try { if (isDemoActive()) endDemoPlayback(); } catch (e) {}
      // KaiAds: a naturally finished track is a completed session (skip the
      // bundled demo). Fullscreen ads fire only at launch + every 5 sessions.
      try {
        if (typeof KaiAds !== 'undefined' && KaiAds.onSession) {
          var _demoA = (typeof isDemoActive === 'function') ? isDemoActive() : false;
          if (!_demoA) KaiAds.onSession();
        }
      } catch (e) {}
    });

    // Wire Store subscription → engine
    Store.subscribe(onStoreChange);

    // Settings: load persisted values, push to Store, apply theme.
    // Order matters: Settings.load() must run BEFORE the first frame so
    // the renderer's theme-aware fillStyle picks up the right background.
    updateBootProgress(25, L10n.t('boot_settings', 'Loading Settings & Preferences...'), '');
    try {
      if (typeof Settings !== 'undefined' && Settings.load) {
        console.log('[Main] calling Settings.load(), Settings=', typeof Settings);
        Settings.load();
      }
    } catch (e) { console.error('[Main] settings.load failed', e); }

    try { pfaSetDevOsd(!!Store.getState().osdLog); } catch (e) {}

    // Desktop-notification permission: must be requested while foregrounded
    // so the background "Now playing" notification persists in the panel.
    try { _ensureNotifPermission(); } catch (e) {}

    // KaiAds: preload an ad at boot and wire the pause/resume hooks so a
    // fullscreen ad pauses playback underneath (KaiAds best practice #3).
    try {
      if (typeof KaiAds !== 'undefined') {
        if (typeof KaiAds.setPauseHooks === 'function') {
          KaiAds.setPauseHooks(_adPausePlayback, _adResumePlayback);
        }
        if (typeof KaiAds.init === 'function') KaiAds.init();
      }
    } catch (e) {}

    // Preload-media <audio> element: create it early so its 'content'
    // channel is claimed before any playback (see _ensureMediaEl).
    try { _ensureMediaEl(); } catch (e) {}

    // Soundfont restoration or module loading stage (50% -> 85%)
    var _sfBootErrors = null;
    var bootSfPromise = new Promise(function (resolve) {
      updateBootProgress(50, L10n.t('boot_audio_engine', 'Initializing Audio Engine...'), '');
      try {
        var st = Store.getState();
        var isAudioOn = (st && st.audio !== false);

        if (isAudioOn && typeof Soundbank !== 'undefined' && Soundbank.restore) {
          var entries = (typeof Soundbank.readRegistry === 'function') ? Soundbank.readRegistry() : [];
          if (entries && entries.length > 0) {
            updateBootProgress(50, L10n.t('boot_soundfonts', 'Loading module: Soundfonts'), L10n.t('boot_prep_banks', 'Preparing banks...'));
            Soundbank.restore(function (sfPct, sfItemLog) {
              var mappedPct = 50 + Math.round((sfPct / 100) * 35);
              updateBootProgress(mappedPct, L10n.t('boot_soundfonts', 'Loading module: Soundfonts'), sfItemLog ? (L10n.t('loading_prefix', 'Loading: ') + sfItemLog) : '');
            }).then(function (res) {
              if (res && res.failed && res.failed.length > 0) {
                _sfBootErrors = res.failed;
              }
              resolve();
            }).catch(function () {
              resolve();
            });
            return;
          }
        }
      } catch (e) { console.error('[Main] Soundbank.restore failed', e); }
      // Fast path if soundbanks aren't loaded: simulate brief progress step
      setTimeout(function () {
        updateBootProgress(75, L10n.t('boot_audio_engine', 'Initializing Audio Engine...'), L10n.t('boot_synth_ready', 'Synth ready'));
        resolve();
      }, 100);
    });

    bootSfPromise.then(function () {
      try {
        if (typeof Soundbank !== 'undefined' && Soundbank.setVoices &&
            Store.getState() && Store.getState().sfVoices != null) {
          Soundbank.setVoices(Store.getState().sfVoices);
        }
      } catch (e) {}

      try {
        if (typeof window.applySystemSettings === 'function') window.applySystemSettings();
      } catch (e) {}

      try {
        var _st0 = Store.getState();
        if (_st0 && _st0.bgImageUrl && typeof window.pfaSetBgImage === 'function') {
          window.pfaSetBgImage(_st0.bgImageUrl, reportBgImageMissing);
        }
        if (_st0 && _st0.bgImagePath && typeof checkBgImageFile === 'function') {
          try { checkBgImageFile(_st0.bgImagePath, reportBgImageMissing); }
          catch (eF) {}
        }
      } catch (e) {}

      if (typeof updateSoftkeys === 'function') updateSoftkeys();
      bindErrorDialogControls();

      updateBootProgress(90, L10n.t('boot_display', 'Initializing Display & Canvas...'), '');
      lastFrameTime = performance.now();
      renderLoop(performance.now());

      if (typeof NoteBuffer !== 'undefined') {
        NoteBuffer.init(width, height);
        NoteBuffer.ensureKeyCache(Store.getState().kbStart || 21,
                                  Store.getState().keyWidth || 16);
      }

      updateBootProgress(100, L10n.t('boot_ready', 'Ready'), '');

      setTimeout(function () {
        if (bootDlg) bootDlg.classList.add('sf-loading-fade-out');

        // Wait for fade-out animation to finish completely (400ms) before starting demo
        setTimeout(function () {
          if (bootDlg) {
            bootDlg.classList.add('hidden');
            bootDlg.classList.remove('sf-loading-fade-out');
          }

          if (_sfBootErrors && _sfBootErrors.length > 0) {
            var errList = _sfBootErrors.map(function (n) { return '• ' + n; }).join('\n');
            var errMsgs = 'Failed to load SoundFont(s) (file moved, deleted, or corrupted):\n' + errList;
            _sfBootErrors = null;
            if (typeof showErrorDialog === 'function') {
              showErrorDialog(errMsgs, null, 'Error');
            }
          }

          if (_pendingActivity) {
            var p = _pendingActivity;
            _pendingActivity = null;
            _gateHotOpen(function () {
              if (p.blob) {
                handlePickedBlob(p.blob, p.name || 'picked.mid');
              } else if (p.filepath) {
                fetchAndLoad(p.filepath, p.name || p.filepath.split('/').pop() || 'picked.mid');
              }
            });
          } else {
            startDemo();
          }
          // KaiAds: show the launch fullscreen ad once the app is ready
          // (best practice — at launch and/or after a completed session).
          try { if (typeof KaiAds !== 'undefined' && KaiAds.launch) KaiAds.launch(); } catch (e) {}
        }, 400);
      }, 100);
    });
  }

  // Pulled out of inline handler so boot() can call it on the queued
  // payload. Same logic as the picker path in controls.js.
  function handlePickedBlob(blob, name) {
    _activityBusy = true;
    showParsing(_parsingLabel(name)); // Reading Data... for .note/.json
    Store.setState({ fileName: name });
    window._midiBlob = blob; // expose for native audio + debug
    window._midiName = name;
    if (_isJsonName(name)) {
      var readerT = new FileReader();
      readerT.onload = function () { loadMIDIJson(readerT.result); };
      readerT.onerror = function () { console.error('[Main] FileReader error'); hideParsing(); };
      readerT.readAsText(blob);
      return;
    }
    _routeMidiBlob(blob, name);
  }

  function fetchAndLoad(filepath, name) {
    var url = filepath;
    window._midiFilePath = filepath; // expose for native audio test
    window._midiName = name;
    if (filepath[0] === '/') url = 'file://' + filepath;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        try {
          _routeMidiBlob(xhr.response, name);
        } catch (e) {
          console.error('[Main] XHR MIDI parse error', e);
          hideParsing();
        }
      } else {
        console.error('[Main] XHR fetch failed', xhr.status);
        hideParsing();
      }
    };
    xhr.onerror = function () { console.error('[Main] XHR fetch error'); hideParsing(); };
    try { xhr.send(); } catch (e) { console.error('[Main] XHR send failed', e); hideParsing(); }
  }

  // MIDI files below this size are parsed + loaded directly (no disk write).
  // Larger ones are parsed then written incrementally to
  // <storage>/others/pfa_tmp/<name>.note (chunked append, yields CPU between
  // batches) so a huge .mid never freezes the UI or builds one giant JSON
  // string. Playback uses the already-parsed in-RAM notes.
  var LARGE_MIDI_BYTES = 512 * 1024; // 512 KB threshold

  // MIDI files at/above HUGE_MIDI_BYTES are streamed straight from the source
  // Blob into a binary .note (StreamParser, external sort, bounded RAM) and NOT
  // parsed in memory. Kept low because the RAM cost of a file is driven by its
  // number of notes (a few MB of MIDI can hold ~1M notes), not its byte size;
  // the device's remaining RAM above baseline is too small for that. A Black
  // MIDI with millions of notes compresses into well under 1 MB, so the
  // threshold cannot be large or those files would be parsed fully into RAM
  // (3.14M notes ≈ 225MB heap). 256KB catches every real multi-note MIDI while
  // letting tiny files (<256KB) still play in RAM without an on-disk round trip.
  var HUGE_MIDI_BYTES = 256 * 1024; // 256 KB

  // True while a conversion (.bin/.note writes) or a streamed .note open is in
  // flight. The pfa_tmp wipe-on-close must never run mid-pipeline, or it would
  // delete files out from under the very code that is writing/reading them.
  var _pipelineBusy = false;
  var _pipelineBusyAt = 0;
  /** True once the user pressed Cancel and the pipeline is unwinding. */
  var _cancelRequested = false;

  // Single choke point for the flag — also stamps WHEN it went busy so a
  // STUCK busy flag (hang upstream, unresolved open promise) can be detected
  // later and not block Clear forever.
  function _setPipelineBusy(v) {
    _pipelineBusy = v;
    if (v) _cancelRequested = false;   // fresh work, fresh cancel slate
    _pipelineBusyAt = v ? Date.now() : 0;
    // Refresh the softkeys + Options-nav so "Cancel" appears/disappears
    // exactly when analysis transitions (RSK on the piano, the Cancel
    // Analysis item in the Options menu).
    if (typeof window.updateSoftkeys === 'function') {
      try { window.updateSoftkeys(); } catch (e) {}
    }
  }

  // True while the "Analyzing MIDI Data..." pill/bar is live — used to
  // re-show it when the user returns to the piano screen mid-analysis.
  var _parseIndicatorActive = false;
  var _parseMode = '';   // 'indet' (sweep) | 'pct' (determinate growth) — live across overlay switches
  var _parsePct = 0;

  // ── Loading-bar presentation (Visual → Loading Bar) ──
  // pctBarVisible : hide/show the whole #parse-bar strip
  // loadAnimated  : sliding sweep vs gradual fill when BOTH % toggles agree
  // loadBarColor  : RGBA color of the bar fill (default blue)
  // pctColor      : RGBA color of the % readout text (default white)
  // pctAnalyze/pctMerge : per-phase % readout. A phase with its % OFF
  //   slides; a phase with its % ON grows 0→100%. When both toggles agree
  //   (both ON or both OFF) the master loadAnimated toggle decides.
  function _phaseShowPct(stage) {
    try {
      return (stage === 'merge')
        ? Store.getState().pctMerge !== false
        : Store.getState().pctAnalyze !== false;
    } catch (e) { return false; }
  }
  function _phaseAnimated(stage) {
    var showThis  = _phaseShowPct(stage);
    var showOther = _phaseShowPct(stage === 'merge' ? 'parse' : 'merge');
    var animated  = true;
    try { animated = Store.getState().loadAnimated !== false; } catch (e) {}
    // Mixed toggles — the hidden-% phase slides, the shown-% phase grows.
    if (showThis !== showOther) return !showThis;
    // Both toggles agree — follow the master Sliding Animation switch.
    return animated;
  }
  function _pctBarVisible() {
    try { return Store.getState().pctBarVisible !== false; }
    catch (e) { return true; }
  }
  function _loadBarColor() {
    var c = null;
    try { c = Store.getState().loadBarColor; } catch (e) {}
    return c || '#0088FF';
  }
  function _pctColor() {
    var c = null;
    try { c = Store.getState().pctColor; } catch (e) {}
    return c || '#FFFFFF';
  }
  function applyParseBarStyle() {
    var bar  = document.getElementById('parse-bar');
    var fill = document.getElementById('parse-bar-fill');
    var pctE = document.getElementById('parse-pct');
    var bootBar = document.getElementById('app-boot-bar');
    var sfBar = document.getElementById('sf-loading-bar');
    var color = _loadBarColor();
    if (fill) fill.style.background = color;
    if (bootBar) bootBar.style.background = color;
    if (sfBar) sfBar.style.background = color;
    if (pctE) pctE.style.color = _pctColor();
    if (bar) {
      // The strip appears ONLY while a MIDI/.note file is actually being
      // analyzed/merged — never persistently on idle. The toggle just
      // controls that show (a parse is active AND pctBarVisible is on).
      if (_pctBarVisible() && _parseIndicatorActive) bar.classList.remove('hidden');
      else bar.classList.add('hidden');
    }
  }
  window.applyParseBarStyle = applyParseBarStyle;

  // ── Center-pill (Dialog) presentation (Visual → Dialog) ──
  // showDialog     : master show/hide toggle (read live by showParsing /
  //                  now-playing paths; no DOM work needed here)
  // dialogTextColor: RGBA text color of #now-playing-text
  // dialogBgColor  : RGBA background of #now-playing-text
  function _dialogTextColor() {
    var c = null;
    try { c = Store.getState().dialogTextColor; } catch (e) {}
    return c || '#FFFFFF';
  }
  function _dialogBgColor() {
    var c = null;
    try { c = Store.getState().dialogBgColor; } catch (e) {}
    return c || '#000000';
  }
  function applyDialogStyle() {
    var t = document.getElementById('now-playing-text');
    if (t) {
      t.style.color = _dialogTextColor();
      t.style.background = _dialogBgColor();
    }
  }
  window.applyDialogStyle = applyDialogStyle;
  // Which pipeline stage the current determinate progress belongs to — drives
  // the Developer→"Show % while analyzing / merging" toggles in settings.
  var _pctStage = 'parse';   // 'parse' (analysis) | 'merge'

  /**
   * Route a picked MIDI Blob. For files >= HUGE_MIDI_BYTES we hand the Blob
   * straight to StreamParser and NEVER read the whole file as an ArrayBuffer
   * (that full read would itself eat RAM proportional to file size on a device
   * that has almost none to spare). Smaller files are read fully for playback.
   */
  function _routeMidiBlob(blob, name) {
    if (blob && blob.size >= HUGE_MIDI_BYTES && typeof StreamParser !== 'undefined') {
      _analyzeAndLoadMIDI(null, name, blob);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        _analyzeAndLoadMIDI(reader.result, name, blob);
      } catch (e) {
        console.error('[Main] MIDI parse error', e);
        hideParsing();
      }
    };
    reader.onerror = function () {
      console.error('[Main] FileReader error');
      hideParsing();
    };
    reader.readAsArrayBuffer(blob);
  }

  function _showParseProgress(label, indeterminate) {
    _devActive = true;
    _parseIndicatorActive = true;
    var animated = _phaseAnimated(_pctStage);
    _parseMode = animated ? 'indet' : 'pct';
    // Piano-only indicator: skip all DOM writes while the user is browsing
    // Options/menu/settings/about; it resumes when back on the player.
    if (!_onPlayerScreen()) return;
    var bar = document.getElementById('parse-bar');
    if (bar) {
      // Drop any determinate fill remnants so the sweep always restarts clean.
      var fill0 = document.getElementById('parse-bar-fill');
      if (fill0) { fill0.style.left = ''; fill0.style.width = ''; }
      bar.classList.remove('hidden');
      if (animated) bar.classList.add('indeterminate');
      else bar.classList.remove('indeterminate');
    }
    ensureParsePill();
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    var textEl = document.getElementById('now-playing-text');
    if (textEl && Store.getState().showDialog !== false) {
      _setParseText(label || L10n.t('analyzing_midi', 'Analyzing MIDI Data...'));
    }
    // No percentage known yet (phase just started) — hide the readout until
    // the first onProgress determinate update arrives.
    var pctEl0 = document.getElementById('parse-pct');
    if (pctEl0) { pctEl0.textContent = ''; pctEl0.classList.add('hidden'); }
    applyParseBarStyle();
  }
  function _updateParseProgress(pct) {
    if (pct > 100) pct = 100; else if (pct < 0) pct = 0;
    // Track the latest value even while off-piano, so re-entering the player
    // screen restores the bar at the current completion, not a stale one.
    var animated = _phaseAnimated(_pctStage);
    _parseMode = animated ? 'indet' : 'pct';
    _parsePct = pct;
    // Piano-only indicator (same rule as _showParseProgress): DOM writes are
    // deferred while browsing Options/menu/settings/about.
    if (!_onPlayerScreen()) return;
    ensureParsePill();
    var bar = document.getElementById('parse-bar');
    var fill = document.getElementById('parse-bar-fill');
    if (bar) {
      if (animated) {
        // Sliding sweep — keep the animation, drop stale determinate growth.
        bar.classList.add('indeterminate');
        if (fill) { fill.style.left = ''; fill.style.width = ''; }
      } else {
        // Gradual fill 0→100% driven by the live progress value.
        bar.classList.remove('indeterminate');
        if (fill) {
          fill.style.left = '0%';
          fill.style.width = pct.toFixed(1) + '%';
        }
      }
    }
    applyParseBarStyle();
    // Percentage readout — shown for the phase only when ITS % toggle is on.
    var pctEl = document.getElementById('parse-pct');
    var wantPct = _phaseShowPct(_pctStage);
    if (pctEl) {
      if (!wantPct) {
        pctEl.textContent = '';
        pctEl.classList.add('hidden');
      } else {
        pctEl.textContent = Math.round(pct) + '%';
        pctEl.classList.remove('hidden');
      }
    }
  }

  // The analyze pill is the primary progress voice during a conversion. If
  // anything else faded it out (a stray "Now playing" fade timer, the demo
  // racer, a leftover np-hide), re-assert it so progress is always visible.
  function ensureParsePill() {
    var overlay = document.getElementById('now-playing-overlay');
    if (overlay) {
      overlay.classList.remove('np-hide');
      if (window._nowPlayingTimer) {
        clearTimeout(window._nowPlayingTimer);
        window._nowPlayingTimer = null;
      }
    }
  }

  // ── CANCEL ANALYSIS ──
  // Reachable from the Options menu ("Cancel Analysis" item — shown only
  // while a conversion runs) and from SoftRight/Enter on the piano (see
  // controls.js). Stops the pipeline at ANY point — a few slices in or on
  // the last merge group. Stopping also clears the partial tmp files
  // written so far ("and clean up"): StreamParser/NoteWriter delete each
  // tracked path by exact name before reporting onCancel.
  function _cancelAnalyze() {
    if (!_pipelineBusy) return;
    if (_cancelRequested) return;   // already unwinding
    _cancelRequested = true;
    console.log('[Main] Cancel: cancellation requested — stopping the pipeline');
    _setParseText(L10n.t('cancelling', 'Cancelling...'));
    // Ask both engines (only the live one reacts); their onCancel clears the
    // partial tmp files and calls _setPipelineBusy(false) + hideParsing().
    try { if (window.StreamParser && StreamParser.cancel) StreamParser.cancel(); } catch (e) {}
    try { if (typeof NoteWriter !== 'undefined' && NoteWriter.cancel) NoteWriter.cancel(); } catch (e) {}
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  window.cancelAnalyze = _cancelAnalyze;
  window.isAnalyzingActive = function () {
    return _pipelineBusy && _onPlayerScreen();
  };
  window.isAnalyzing = function () { return _pipelineBusy; };

  // Cancel finished (engine reported onCancel): release the pipeline, drop
  // the parse UI, and RESET the picked-file state — otherwise the center
  // softkey would show PLAY for a file that was never fully loaded, and
  // pressing it would "play nothing". Mirrors the Clear action's teardown.
  function _onAnalyzeCancelled(msg) {
    console.log('[Main] Cancel: ' + msg);
    _setPipelineBusy(false);
    hideParsing();
    try { if (document.mozCancelFullScreen) document.mozCancelFullScreen(); } catch (e) {}
    try { if (typeof Sequencer.stop === 'function') Sequencer.stop(); } catch (e) {}
    try {
      Store.setState({ play: 'stop', fileName: '', notes: [], timeSec: 0, npPending: false });
    } catch (e) {}
    try { if (typeof HUD !== 'undefined' && HUD.setTotal) HUD.setTotal(0); } catch (e) {}
    window._midiBlob = null;
    window._rawMidiBuffer = null;
    window._midiNotePath = null;
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  window._onAnalyzeCancelled = _onAnalyzeCancelled;

  /**
   * Route a picked MIDI. `blob` is the source (needed for streaming huge files);
   * `arrayBuffer` is its full read (used for normal/large in-memory playback).
   *
   *  - blob.size >= HUGE_MIDI_BYTES  → StreamParser: stream to binary .note,
   *    do NOT load for playback (RAM too small). Notify when persisted.
   *  - otherwise → existing behavior (in-memory load; NoteWriter text copy
   *    for ≥ LARGE_MIDI_BYTES).
   */
  function _analyzeAndLoadMIDI(arrayBuffer, name, blob) {
    var bSize = (blob && blob.size !== undefined) ? blob.size : (arrayBuffer ? arrayBuffer.byteLength : 0);
    try { if (performance && performance.memory) console.log('[Heap] _analyzeAndLoadMIDI enter heapKB=' + Math.round(performance.memory.usedJSHeapSize / 1024) + ' bSize=' + bSize); } catch (e) {}
    console.log('[Main] _analyzeAndLoadMIDI name=' + name + ' blob=' + !!blob + ' bSize=' + bSize + ' hugeThresh=' + HUGE_MIDI_BYTES);

    if (_pipelineBusy) {
      // Entry is not gated below, so a second open while a conversion (or a
      // streamed .note open) is mid-flight must be refused — the second
      // conversion's tmp cleanup would delete the first one's in-flight run
      // files ("missing run r<k>.bin" on real giant black MIDIs).
      console.warn('[Main] pipeline busy — ignoring second open');
      if (typeof showErrorDialog === 'function') {
        try { showErrorDialog('Still analyzing the previous file — please wait.'); } catch (e) {}
      }
      return;
    }

    if (bSize >= HUGE_MIDI_BYTES && blob && typeof StreamParser !== 'undefined') {      _showParseProgress(L10n.t('parsing_midi_data', 'Parsing MIDI data...'), true);
      console.log('[StreamParser] huge MIDI ' + bSize + ' bytes → stream to binary .note (no RAM play)');
      _setPipelineBusy(true);
      StreamParser.midiToNote(blob, name, {
        onStage: function (s) {
          if (s === 'parse') { _pctStage = 'parse'; _showParseProgress(L10n.t('parsing_midi_data', 'Parsing MIDI data...'), true); }
          else if (s === 'merge') { _pctStage = 'merge'; _showParseProgress(L10n.t('merging_events', 'Merging events...'), false); }
        },
        onProgress: function (pct) { _updateParseProgress(pct); },
        onDone: function (path) {
          console.log('[StreamParser] wrote ' + path);
          window._midiNotePath = path;
          // Free the source MIDI Blob now that the .note is written and we're
          // about to stream it back from disk. Nothing consumes _midiBlob /
          // _rawMidiBuffer (they're only exposed "for native audio" that is
          // never wired up), so keeping them just pins ~25MB in RAM per load.
          window._midiBlob = null;
          window._rawMidiBuffer = null;
          // _pipelineBusy stays true until the stream playback is open, so an
          // app close exactly at this boundary can't wipe the file out from
          // under the reader. Do NOT loadMIDIData (would OOM) — stream the
          // binary .note back from disk instead.
          _openConvertedNote(path, name).then(
            function () { _setPipelineBusy(false); },
            function () { _setPipelineBusy(false); }
          );
        },
        onError: function (msg) {
          console.error('[StreamParser] ' + msg);
          _setPipelineBusy(false);
          hideParsing();
          if (typeof showErrorDialog === 'function') {
            try { showErrorDialog(L10n.t('err_stream_failed', 'Streaming MIDI analysis failed: ') + msg); } catch (e) {}
          }
        },
        onCancel: function (msg) {
          _onAnalyzeCancelled(msg);
        }
      });
      return;
    }

    var midiData = MidiParser.parseMIDI(arrayBuffer);
    window._rawMidiBuffer = arrayBuffer;

    var isLarge = arrayBuffer.byteLength >= LARGE_MIDI_BYTES;
    if (!isLarge || typeof NoteWriter === 'undefined') {
      loadMIDIData(midiData);
      return;
    }

    console.log('[NoteWriter] large MIDI ' + arrayBuffer.byteLength +
      ' bytes, ' + (midiData.notes ? midiData.notes.length : 0) + ' notes → incremental .note');
    _pctStage = 'parse';
    _showParseProgress();
    _setPipelineBusy(true);

    NoteWriter.write(midiData, name, {
      onProgress: function (pct) { _updateParseProgress(pct); },
      onDone: function (path) {
        console.log('[NoteWriter] wrote ' + path);
        window._midiNotePath = path;
        _setPipelineBusy(false);
        hideParsing();
        loadMIDIData(midiData);
      },
      onError: function (msg) {
        console.error('[NoteWriter] ' + msg);
        _setPipelineBusy(false);
        hideParsing();
        // If the failure is the SD-card permission being missing, the grant
        // dialog is already on screen (OK → exit). Do NOT fall back to
        // playback behind the dialog.
        if (typeof storageGranted === 'function') {
          try { if (storageGranted()) { loadMIDIData(midiData); return; } } catch (e) { loadMIDIData(midiData); return; }
        }
        loadMIDIData(midiData); // still play even if the copy failed
      },
      onCancel: function (msg) {
        _onAnalyzeCancelled(msg);
      }
    });
  }


  // ── PRELOAD MEDIA (Synth Engine = preload) ──
  // A media file (mp3/audio) plays alongside the MIDI, synced to the
  // transport: play/pause/stop, ±1s seek, and playback rate all follow.
  var _mediaEl = null;
  var _mediaTimer = null;
  var _mediaUrl = null;
  var _mediaErrShown = false;
  var _mediaStopped = true; // true = next play restarts at 0 (fresh start)

  function _ensureMediaEl() {
    if (_mediaEl) return _mediaEl;
    try {
      _mediaEl = document.createElement('audio');
      // KaiOS: a media element must claim the 'content' (media) channel
      // BEFORE it enters the DOM — otherwise it defaults to the notification
      // channel (volume OSD shows "Ringtones and Alerts" and the track can
      // be silent). Set it both ways to cover Gecko quirks.
      try { _mediaEl.mozAudioChannelType = 'content'; } catch (e) {}
      try { _mediaEl.setAttribute('mozAudioChannelType', 'content'); } catch (e) {}
      _mediaEl.preload = 'none'; // don't probe/load anything at boot
      _mediaEl.addEventListener('error', function () {
        try { console.warn('[Media] element error', _mediaEl.error ? _mediaEl.error.code : '?'); } catch (e) {}
        // Only surface a dialog when a real media file was loaded AND is
        // being played — ignore spurious idle/boot errors.
        if (_mediaErrShown || !_mediaActive()) return;
        _mediaErrShown = true;
        try {
          if (typeof window.showErrorDialog === 'function') {
            window.showErrorDialog(L10n.t('err_media_unsupported', 'This media format is not supported by the device. Try an MP3 / WAV / M4A file.'));
          }
        } catch (e) {}
      });
      _mediaEl.addEventListener('playing', function () { console.log('[Media] playing'); });
      document.body.appendChild(_mediaEl);
      _assertMediaChannel();
    } catch (e) {}
    return _mediaEl;
  }

  /** Point the OS volume rocker / OSD at the media ('content') channel. */
  function _assertMediaChannel() {
    try {
      var acm = navigator.mozAudioChannelManager || navigator.audioChannelManager;
      if (acm && typeof acm.volumeControlChannel === 'string') {
        acm.volumeControlChannel = 'content';
      }
    } catch (e) {}
  }

  function _mediaActive() {
    var st = Store.getState();
    return !!(st.synthEngine === 'preload' && st.mediaSrc);
  }

  function _mediaApplyMute() {
    var st = Store.getState();
    var on = (st.audio !== false);
    if (_mediaEl) { try { _mediaEl.muted = !on; } catch (e) {} }
  }

  function _mediaPlay() {
    if (!_mediaActive()) return;
    var el = _ensureMediaEl();
    if (!el) return;
    var st = Store.getState();
    var src = st.mediaSrc;
    try {
      if (el.src !== src) { el.src = src; el.load(); }
    } catch (e) {}
    clearTimeout(_mediaTimer);
    _mediaApplyMute();
    _mediaErrShown = false;
    _assertMediaChannel();
    try { console.log('[Media] ch=' + (el.mozAudioChannelType || '?') + ' muted=' + el.muted); } catch (e) {}
    var delay = Math.max(0, Number(st.mediaDelay) || 0);
    var kick = function () {
      try {
        var p = el.play();
        if (p && p.catch) p.catch(function (er) { console.warn('[Media] play blocked:', er); });
        else console.log('[Media] play() ok');
      } catch (e) { console.warn('[Media] play() threw:', e); }
    };
    // A FRESH start (from Stop) restarts the media at 0 and applies the
    // delay. Resuming from Pause keeps the current position and plays
    // immediately — no rewind, no re-applied delay.
    var fresh = _mediaStopped;
    _mediaStopped = false;
    if (fresh) {
      try { el.currentTime = 0; } catch (e) {}
      if (delay > 0) {
        _mediaTimer = setTimeout(kick, delay * 1000);
      } else {
        kick();
      }
    } else {
      kick();
    }
  }

  function _mediaPause() {
    clearTimeout(_mediaTimer);
    if (_mediaEl) { try { _mediaEl.pause(); } catch (e) {} }
  }

  function _mediaStop() {
    clearTimeout(_mediaTimer);
    _mediaStopped = true;
    if (_mediaEl) {
      try { _mediaEl.pause(); _mediaEl.currentTime = 0; } catch (e) {}
    }
  }

  function _mediaSeek(delta) {
    if (!_mediaEl || !_mediaActive()) return;
    try {
      var nt = (_mediaEl.currentTime || 0) + (Number(delta) || 0);
      if (nt < 0) nt = 0;
      var mx = _mediaEl.duration;
      if (isFinite(mx) && mx > 0 && nt > mx) nt = mx;
      _mediaEl.currentTime = nt;
    } catch (e) {}
  }

  function _mediaSetSpeed(sp) {
    if (!_mediaEl) return;
    try { _mediaEl.playbackRate = (sp && sp > 0) ? sp : 1.0; } catch (e) {}
  }

  window._mediaSeek = _mediaSeek; // hook for controls.js seekSeconds

  /** Accepted media extensions (blob.type may be empty on KaiOS). */
  function _isMediaFile(blob, name) {
    var t = (blob && blob.type) ? String(blob.type).toLowerCase() : '';
    if (t.indexOf('audio/') === 0) return true;
    if (t.indexOf('video/') === 0) return true;
    var ext = String(name || '').split('.').pop().toLowerCase();
    return ['mp3','wav','ogg','oga','m4a','aac','amr','opus','flac','3gp','mp4','m4v'].indexOf(ext) !== -1;
  }

  // Load / Change Media (Synth Settings → Preload): same MozActivity picker
  // as the MIDI loader, but validates the pick is an audio/media file.
  // The settings overlay stays OPEN so the user lands back here (not the
  // piano) with the fresh file name / Change Media label visible.
  window.launchMediaPicker = function () {
    // Exit fullscreen first so the MozActivity picker can cover the screen
    // properly (same as the MIDI loader does).
    try {
      var _fsApp = document.getElementById('app');
      if (_fsApp && _fsApp.classList.contains('fullscreen')) {
        _fsApp.classList.remove('fullscreen');
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
        setTimeout(function () { try { if (typeof onResize === 'function') onResize(); } catch (e) {} }, 100);
      }
    } catch (e) {}
    try {
      window._pickerOpen = true;
      var act = new MozActivity({ name: 'pick' });
      act.onsuccess = function (res) {
        window._pickerOpen = false;
        var blob = null;
        if (res.target && res.target.result) blob = res.target.result.blob || res.target.result;
        else if (res.result && res.result.blob) blob = res.result.blob;
        else if (res.blob) blob = res.blob;
        else if (res instanceof Blob) blob = res;
        if (!blob) return;
        var name = String(blob.name || 'media').split('/').pop();
        if (_isMediaFile(blob, name)) {
          var url = URL.createObjectURL(blob);
          try { if (_mediaUrl) URL.revokeObjectURL(_mediaUrl); } catch (e) {}
          _mediaUrl = url;
          _mediaErrShown = false;
          if (typeof Settings !== 'undefined' && Settings.setMedia) {
            try { Settings.setMedia(name, url); } catch (e) {}
          }
          Store.setState({ mediaName: name, mediaSrc: url });
          if (typeof Settings !== 'undefined' && Settings.refreshMidiGroup) {
            try { Settings.refreshMidiGroup(); } catch (e) {}
          }
        } else {
          if (typeof window.showErrorDialog === 'function') {
            try { window.showErrorDialog(L10n.t('err_not_media', 'Not a media file') + ':\n' + name, null, L10n.t('error', 'Error')); } catch (e) {}
          }
        }
      };
      act.onerror = function () { window._pickerOpen = false; };
    } catch (e) { window._pickerOpen = false; }
  };


  // ── KaiAds: pause/resume playback while a fullscreen ad covers the app ──
  // KaiAds best practice #3: content must pause under a fullscreen ad.
  var _adWasPlaying = false;
  function _adPausePlayback() {
    try {
      _adWasPlaying = (Store.getState().play === 'play');
      if (_adWasPlaying) Store.setState({ play: 'pause' });
    } catch (e) {}
  }
  function _adResumePlayback() {
    try {
      if (_adWasPlaying) { _adWasPlaying = false; Store.setState({ play: 'play' }); }
    } catch (e) {}
  }


  // ── STORE CHANGE HANDLER ──

  var _prevSpeed      = null;
  var _prevWave       = null;
  var _prevAudio      = null;
  var _prevSynthEngine = null;
  var _prevPctBarVis  = null;
  var _prevLoadAnim   = null;
  var _prevLoadColor  = null;
  var _prevDlgText     = null;
  var _prevDlgBg       = null;
  var _activeEngine   = null;   // live reference: Synth (built-in oscillator)

  /** Return the currently-selected engine object. */
  function _engine() {
    return _activeEngine || Synth;
  }
  // Expose the active engine so the HUD can report true voice polyphony
  // (number of actually-sounding voices) instead of the note-event window.
  window._engine = _engine;

  function onStoreChange(state) {
    // Playback control (avoid re-trigger from onEnd cycle)
    var prevPlay = Store._prevPlay;
    Store._prevPlay = state.play;

    if (state.play === 'play' && prevPlay !== 'play') {
      // Mark audible FIRST so ensure() (gated on the flag) actually boots
      // the context; otherwise the first Play would no-op the bootstrap.
      try { if (typeof _engine().setActive === 'function') _engine().setActive(true); } catch (eA) {}
      _engine().ensure();
      Sequencer.play();
      _mediaPlay();
      acquireCpuWakeLock();
      acquireScreenWakeLock();
    } else if (state.play === 'pause' && prevPlay !== 'pause') {
      Sequencer.pause();
      _engine().silence();
      _mediaPause();
      // No audible output → release the status-bar play indicator.
      try { if (typeof _engine().setActive === 'function') _engine().setActive(false); } catch (eA) {}
    } else if (state.play === 'stop' && prevPlay !== 'stop') {
      // Natural song end: the sequencer already soft-stopped with its
      // counters intact (Passed + Time stay on screen). A user Stop (or
      // restart / file unload) hits fullStop → resets time + passed to 0.
      var seqEnded = false;
      try { seqEnded = typeof Sequencer !== 'undefined' && Sequencer.isEnded && Sequencer.isEnded(); } catch (e) {}
      if (!seqEnded) { try { Sequencer.stop(); } catch (e) {} }
      _engine().silence();
      _mediaStop();
      // Nothing sounding anymore → suspend AudioContext so the OS status-bar
      // play icon disappears (a latent 'content'-channel context keeps showing
      // "playing" even after the song ends).
      try { if (typeof _engine().setActive === 'function') _engine().setActive(false); } catch (eA) {}
      releaseCpuWakeLock();
      releaseScreenWakeLock();
      hideNowPlayingNotification();
      // play:'stop' set elsewhere (onEnd) never refreshed the softkey —
      // flip center back to PLAY here.
      if (typeof window.updateSoftkeys === 'function') {
        try { window.updateSoftkeys(); } catch (e) {}
      }
    }

    // Waveform change (only when actually changed — setWave iterates 48 oscillators)
    if (state.waveform && state.waveform !== _prevWave) {
      _prevWave = state.waveform;
      Synth.setWave(state.waveform);
    }

    // Audio on/off (Settings → Synth → Audio). _prevAudio guards so the
    // toggle only fires Synth.mute on an actual change (mute() silences
    // instantly; the master gain write is direct, no param events).
    // NOTE: in preload mode the system synth stays muted regardless of
    // this toggle — toggling audio only mutes/unmutes the media itself.
    if (state.audio !== _prevAudio) {
      _prevAudio = state.audio;
      var _preAudio = (state.synthEngine === 'preload');
      Synth.mute(_preAudio || !state.audio);
      _mediaApplyMute();
      // Soundbank routes straight to the context destination, so the master
      // Audio On/Off toggle must mute it explicitly too (SF engine).
      if (typeof Soundbank !== 'undefined' && Soundbank.mute) {
        try { Soundbank.mute(_preAudio || !state.audio); } catch (eM) {}
      }
    }

    // Synth Engine (System / Preload): preload mode DISABLES the system
    // synth — only the media file sounds, playing alongside the MIDI.
    if (state.synthEngine !== _prevSynthEngine) {
      _prevSynthEngine = state.synthEngine;
      var _pre = (state.synthEngine === 'preload');
      try { Synth.mute(_pre || !state.audio); } catch (eS) {}
      if (typeof Soundbank !== 'undefined' && Soundbank.mute) {
        try { Soundbank.mute(_pre || !state.audio); } catch (eSB) {}
      }
    }

    // Loading-bar presentation (Visual → Loading Bar): re-apply live when
    // any of the three keys changes (only the .hidden + fill color shift).
    if (state.pctBarVisible !== _prevPctBarVis ||
        state.loadAnimated  !== _prevLoadAnim ||
        state.loadBarColor  !== _prevLoadColor) {
      _prevPctBarVis = state.pctBarVisible;
      _prevLoadAnim  = state.loadAnimated;
      _prevLoadColor = state.loadBarColor;
      try { applyParseBarStyle(); } catch (e) {}
    }

    // Center-pill colors (Visual → Dialog): re-apply on change.
    if (state.dialogTextColor !== _prevDlgText ||
        state.dialogBgColor   !== _prevDlgBg) {
      _prevDlgText = state.dialogTextColor;
      _prevDlgBg   = state.dialogBgColor;
      try { applyDialogStyle(); } catch (e) {}
    }

    // Speed (only when actually changed — avoids recalibration churn).
    // During the demo, or while playback is locked (no real file loaded),
    // the speed setting is ignored — the demo always plays at 1.0x and the
    // user's speed only takes effect once a real file is loaded. Guarding on
    // _lockNoFile (not just _demoActive) also stops a persisted speed from
    // being pushed to the sequencer at boot before the demo has started.
    if (state.speed != null && state.speed !== _prevSpeed && !_demoActive && !_lockNoFile) {
      _prevSpeed = state.speed;
      Sequencer.setSpeed(state.speed);
      _mediaSetSpeed(state.speed);
    }

    // File selected from picker
    if (state.loadFile) {
      triggerLoadFile(state.loadFile);
    }

    // Softkey labels handled by controls.js
  }

  // ── RENDER LOOP ──

  function renderLoop(now) {
    rafId = requestAnimationFrame(renderLoop);

    // FPS counter — update every second. Counted BEFORE the analyze
    // early-return so the HUD FPS stays live during conversions too.
    var dt = now - lastFrameTime;
    lastFrameTime = now;
    fpsCounter++;
    fpsAcc += dt;
    if (fpsAcc >= 1000) {
      Store.setState({ fps: Math.round(fpsCounter * 1000 / fpsAcc) });
      fpsCounter = 0;
      fpsAcc = 0;
      // Periodic zombie-voice cleanup (KaiOS onended never fires)
      try { var _eng = _engine(); if (_eng && _eng.zoo) _eng.zoo(); } catch (e) {}
    }

    // While a conversion runs the canvas is static behind the parse overlay —
    // skip per-frame drawing entirely (saves the single biggest source of
    // continuous allocations + GC + CPU pressure for the streaming parser).
    // RAF keeps being scheduled so the loop resumes cleanly when released.
    if (_pipelineBusy) return;

    var st = Store.getState();

    // NOTE: keyboard spritesheet rebuilds are handled inside
    // Keyboard.draw() (keyWidth / pianoSize / pianoColorHex trackers),
    // so no external build() call is needed here anymore.

    // ── Drawing order ──
    // Fetch active notes once per frame (shared across all renderers)
    var liveCount = 0;
    if (typeof Sequencer !== 'undefined') {
      try {
        st._activeList = Sequencer.activeList();
        liveCount = st._activeList ? st._activeList.length : 0;
      } catch (e) { st._activeList = []; }
    }

    // 1. Background — Visual → Background Color overrides the theme token
    //    when set; otherwise fall back to CSS var --theme-bg / dark gray.
    //    A loaded Background Image (Visual → Load Background Image) wins
    //    over both, stretched to fill — same demo lock as bgColor: while
    //    _demoActive / _lockNoFile the image is ignored (theme stays).
    var cs = getComputedStyle(document.documentElement);
    var themeBg = cs.getPropertyValue('--theme-bg').trim() || '#0a0a0a';
    // Demo lock: keep the demo background on the theme default (black) no
    // matter what Visual → Background Color says — until a real file loads.
    var bgImg = (_demoActive || _lockNoFile) ? null : _bgImage;
    if (bgImg) {
      try { ctx.drawImage(bgImg, 0, 0, width, height); }
      catch (e) { bgImg = null; }
    }
    if (!bgImg) {
      ctx.fillStyle = demoVisualValue('bgColor', st.bgColor) || themeBg;
      ctx.fillRect(0, 0, width, height);
    }

    // 2. Falling notes
    Notes.draw(st, ctx, width, height);

    // 3. Bar line — separator between falling notes and piano (Visual →
    //    Bar Color), sits just above the keyboard strip below the notes.
    //    Header removed; softkey (KaiOS 3rem at 10px = 30px) overlays bottom
    //    unless in fullscreen. Height follows Piano Size; hidden entirely
    //    when the piano strip is hidden ('none').
    var kbH = (typeof Keyboard !== 'undefined' && Keyboard.height)
      ? Keyboard.height(st) : 60;
    if (kbH > 0) {
      var lineY = height - kbH;
      if (lineY < 0) lineY = 0;
      ctx.strokeStyle = st.barColor || '#8B0000';
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(0, lineY);
      ctx.lineTo(width, lineY);
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      // 4. Keyboard strip (on top, just above the softkey overlay)
      Keyboard.draw(st, ctx, width, height);

      // Middle C marker — a small gray dot centered on the Middle C (C4)
      // white key, sitting in the white-key area below the black keys
      // (like the reference 88-key strip). Controlled by Visual →
      // Piano Settings → Middle C Marker. Dot FLEXES with the keys
      // (size follows keyWidth: bigger keys → bigger dot).
      var showMid = !(st.middleMarker === false);
      if (showMid && typeof Keyboard !== 'undefined' && Keyboard.middleCX) {
        var midX = Keyboard.middleCX(st, width);
        if (midX != null) {
          var dotSize = Math.max(2, Math.min(4, Math.round((st.keyWidth || 16) * 0.65)));
          var bhMid = (Keyboard.blackHeight) ? Keyboard.blackHeight(kbH) : Math.round(kbH * 0.6);
          var stripTop = height - kbH;
          var midY = stripTop + bhMid + Math.round((kbH - bhMid) / 2);
          ctx.fillStyle = '#888';
          ctx.fillRect(midX - Math.floor(dotSize / 2), midY - Math.floor(dotSize / 2), dotSize, dotSize);
        }
      }
    }

    // 5. HUD overlay (throttled DOM writes — internal 250ms interval)
    HUD.tick(st, liveCount);
  }

  // ── CANVAS RESIZE ──

  function _chromeH() {
    if (document.fullscreenElement || document.mozFullScreenElement) return 0;
    var appEl = document.getElementById('app');
    if (appEl && appEl.classList.contains('fullscreen')) return 0;
    var skEl = document.getElementById('softkey-bar');
    if (!skEl) return 30;
    var r = skEl.getBoundingClientRect();
    if (r.height > 0) return r.height;
    // Fallback: read CSS --softkeybar-height (3rem × 10px = 30px on KaiOS)
    var cssH = getComputedStyle(document.documentElement).getPropertyValue('--softkeybar-height');
    if (cssH && cssH.endsWith('rem')) {
      var rem = parseFloat(cssH);
      var fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
      return Math.round(rem * fs);
    }
    return 30;
  }

  // Auto-fit keyWidth so the WHOLE Keyboard Range spans the canvas width.
  // Uses EXACT float division (no floor) — integer rounding used to leave
  // a dark gap strip on the right edge (up to whitesInRange-1 px).
  // Called from resizeCanvas AND once per frame in renderLoop, so slider
  // edits to Keyboard Range refit immediately no matter which code path
  // wrote kbStart/kbEnd.
  function fitKeyboardWidth(st) {
    var rStart = (st.kbStart != null) ? st.kbStart : 21;
    var rEnd   = (st.kbEnd   != null) ? st.kbEnd   : 108;
    // During the demo / locked state, fit width from the FIXED demo range so
    // a saved Keyboard Range can never change the demo's note spacing.
    if (typeof window.demoVisualValue === 'function') {
      try {
        rStart = window.demoVisualValue('kbStart', rStart);
        rEnd   = window.demoVisualValue('kbEnd', rEnd);
      } catch (e) {}
    }
    rStart = Math.max(0, Math.min(127, rStart));
    rEnd   = Math.max(rStart + 1, Math.min(127, rEnd));
    // Count white keys inside the visible range
    var whitesInRange = 0;
    for (var rn = rStart; rn <= rEnd; rn++) {
      if (!Constants.isBlackKey(rn % 12)) whitesInRange++;
    }
    if (whitesInRange < 1 || width < 1) return;
    // Float keyWidth → keys tile edge-to-edge with zero remainder
    var newKeyW = width / whitesInRange;
    newKeyW = Math.max(Constants.UI.KEY_W_MIN,
              Math.min(Constants.UI.KEY_W_MAX, newKeyW));
    if ((st.keyWidth || 16) !== newKeyW) Store.setState({ keyWidth: newKeyW });
  }

  function resizeCanvas() {
    // Use the SMALLER of screen.availHeight / window.innerHeight to avoid
    // drawing into the system nav zone (KaiOS may paint nav above the
    // softkey, and availHeight includes it). window.innerHeight is the
    // viewport the app actually sees.
    var sw_raw = screen.availWidth  || window.innerWidth;
    var sh_raw = screen.availHeight || window.innerHeight;
    var iw = window.innerWidth  || sw_raw;
    var ih = window.innerHeight || sh_raw;
    // width = app viewport (smaller horizontal = safer against rotation drift)
    width  = Math.min(sw_raw, iw);
    // height = visible region MINUS softkey height so piano never renders behind softkey
    var chromeH = _chromeH();
    height = Math.max(120, Math.min(sh_raw, ih) - chromeH);

    canvas.width  = width;
    canvas.height = height;
    canvas.style.width  = width + 'px';
    canvas.style.height = height + 'px';

    // Auto-fit keyWidth so the WHOLE Keyboard Range fits the screen width.
    // keyWidth is derived (not user-zoomable anymore — D-pad Left/Right
    // are bound to seeking now), so it is recomputed on every resize.
    fitKeyboardWidth(Store.getState());
  }

  // ── ORIENTATION / RESIZE HANDLING ──
  // KaiOS fires 'orientationchange' + 'resize' when the phone is rotated.
  // Without this, the canvas keeps old dimensions and gets stretched/zoomed.
  function onResize() {
    if (!canvas) return;
    resizeCanvas();
    console.log('[Main] resized → ' + width + 'x' + height + ' keyW=' + (Store.getState().keyWidth));
  }

  window.addEventListener('resize', onResize, false);
  var _resizeTimer = null;
  var _resizeRafId = null;

  // Native fullscreen state changed (KaiOS / Gecko 48 fires this for both
  // mozCancelFullScreen and the App entering/exiting fullscreen). Sync the
  // #app.fullscreen class with reality and force a canvas resize so the
  // piano / notes redraw with the correct chrome offsets.
  function onFullscreenChange() {
    var appEl = document.getElementById('app');
    var inFS = !!(document.fullscreenElement || document.mozFullScreenElement);
    if (appEl) {
      if (inFS) appEl.classList.add('fullscreen');
      else      appEl.classList.remove('fullscreen');
    }
    if (canvas) resizeCanvas();
    setTimeout(function () {
      if (canvas) resizeCanvas();
      if (typeof window.refreshMenuLabels === 'function') {
        window.refreshMenuLabels();
      }
    }, 120);
  }
  document.addEventListener('mozfullscreenchange', onFullscreenChange, false);
  document.addEventListener('fullscreenchange',     onFullscreenChange, false);
  // Some KaiOS builds expose the same event on window.
  window.addEventListener('mozfullscreenchange',    onFullscreenChange, false);

  window.addEventListener('orientationchange', function () {
    // Clear pending resize — KaiOS fires this multiple times rapidly
    if (_resizeTimer) { clearTimeout(_resizeTimer); _resizeTimer = null; }
    if (_resizeRafId) { cancelAnimationFrame(_resizeRafId); _resizeRafId = null; }

    // Phase 1: immediate resize with current dimensions (prevents stretched canvas)
    resizeCanvas();

    // Phase 2: KaiOS reports correct dimensions ~300ms after orientationchange.
    // Run resize + invalidate caches once dimensions settle.
    _resizeTimer = setTimeout(function () {
      resizeCanvas();

      // Invalidate cached key layout so notes.render() doesn't draw at wrong positions
      if (typeof Keyboard !== 'undefined' && Keyboard._lastKeyW !== null) {
        Keyboard._lastKeyW = null;
      }

      // Give render loop one frame to pick up the new keyWidth before we rebuild
      _resizeRafId = requestAnimationFrame(function () {
        resizeCanvas();
        _resizeTimer = null;
        _resizeRafId = null;
      });
    }, 300);
  }, false);

  // ── BLUR / FOCUS — suspend audio + pause sequencer when backgrounded ──
  // Matches reference audio-visualizer pattern: on blur, suspend AudioContext
  // and pause playback so Gecko's audio thread doesn't compete with foreground app.
  // Player-screen guard: the center pills belong to the piano player
  // ONLY — never float above the Options menu, Settings/sub-settings
  // or the About panel.
  function _onPlayerScreen() {
    var ids = ['menu-overlay', 'settings-overlay', 'subsettings-overlay', 'about-overlay'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && !el.classList.contains('hidden')) return false;
    }
    return true;
  }

  window.showNowPlaying = function (fileName) {
    // Visual → Show Dialog = Off suppresses the pill entirely
    if (Store.getState().showDialog === false) return;
    if (!_onPlayerScreen()) return;
    // While a conversion is still running the pill belongs to the parse
    // progress — the toast must neither overwrite its text nor fade-it-out.
    if (_parseIndicatorActive || _pipelineBusy) return;
    var overlay = document.getElementById('now-playing-overlay');
    var text    = document.getElementById('now-playing-text');
    if (!overlay || !text) return;
    var name = (fileName || '').split('/').pop() || 'Unknown';
    text.textContent = L10n.t('now_playing', 'Now playing') + ': ' + name;
    // Fade in (CSS transition on opacity), hold 3s, then FADE OUT
    // gradually. Uses .np-hide instead of .hidden — the generic
    // .hidden is display:none !important, which kills the transition.
    overlay.classList.remove('np-hide');
    clearTimeout(window._nowPlayingTimer);
    window._nowPlayingTimer = setTimeout(function () {
      // A parse started in the meantime owns the pill — don't fade it.
      if (_parseIndicatorActive || _pipelineBusy) return;
      overlay.classList.add('np-hide');
    }, 3000);
  };

  // ── Background image (Visual → Load Background) ──
  // Persisted as a downscaled JPEG data URL that survives app restarts.
  // pfaSetBgImage(url, onFail) loads + shows it; pfaSetBgImage(null) clears
  // it. The render loop draws it stretched over the canvas behind the notes,
  // gated by the same demo lock as bgColor (hidden while the demo runs —
  // visible once a real file loads, without needing a reload).
  var _bgImage = null;
  window.pfaSetBgImage = function (url, onFail) {
    _bgImage = null;
    if (!url) return;
    var im = new Image();
    im.onload = function () {
      _bgImage = im;
    };
    im.onerror = function () {
      _bgImage = null;
      if (typeof onFail === 'function') onFail();
      else if (typeof showToast === 'function') showToast(L10n.t('toast_not_image', 'Not a valid image file'));
    };
    im.src = url;
  };

  // Verify the background image's SOURCE FILE still exists at boot
  // (deleted / renamed / moved elsewhere). DeviceStorage lookup; if the
  // API is unavailable the check is skipped silently. `missing` fires
  // only when every candidate path resolves to nothing on every storage.
  function checkBgImageFile(path, missing) {
    var storages = [];
    try {
      if (typeof navigator !== 'undefined' && navigator.getDeviceStorages) {
        storages = navigator.getDeviceStorages('sdcard');
      } else if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
        storages = [navigator.getDeviceStorage('sdcard')];
      }
    } catch (e) { storages = []; }
    if (!storages || !storages.length) return; // can't check — silent
    var p0 = String(path);
    var candidates = [p0];
    var mStripped = p0.match(/^\/[^/]+\/(.+)$/);
    if (mStripped) candidates.push(mStripped[1]); // strip '/sdcard' prefix
    var pending = 0, found = false, doneCalled = false;
    function settle() {
      pending--;
      if (pending <= 0 && !found && !doneCalled) {
        doneCalled = true;
        if (typeof missing === 'function') { try { missing(); } catch (e) {} }
      }
    }
    candidates.forEach(function (p) {
      storages.forEach(function (st) {
        pending++;
        var req;
        try { req = st.get(p); } catch (e) { settle(); return; }
        req.onsuccess = function (e) {
          if (e && e.target && e.target.result) found = true;
          settle();
        };
        req.onerror = function () { settle(); };
      });
    });
    if (pending === 0 && !found && !doneCalled) {
      doneCalled = true;
      if (typeof missing === 'function') { try { missing(); } catch (e) {} }
    }
  }

  window.addEventListener('blur', function () {
    // Background play: while anything is playing (real file OR demo), keep
    // Sequencer + audio running so no notes are lost and the song stays
    // exactly in place when the user returns. The notification is only
    // surfaced for real files on a genuine background exit (Back already
    // did, but Home/minimize also lands here) — not for our own activity
    // picker (the user is still effectively inside the app).
    var st = null; try { st = Store.getState(); } catch (eB) {}
    var hasFile = !!(st && st.fileName);
    var isDemo = false; try { isDemo = isDemoActive(); } catch (eD) {}
    if (st && st.play === 'play') {
      if (hasFile && !isDemo && !window._pickerOpen) {
        try { showNowPlayingNotification(st.fileName); } catch (eN) {}
      }
      try { acquireCpuWakeLock(); } catch (eW) {}
      try { releaseScreenWakeLock(); } catch (eS) {}
      // Do NOT silence/pause — let content-channel audio continue in background.
      return;
    }
    try { _engine().silence(); } catch (e) {}
    if (typeof Sequencer !== 'undefined' && Sequencer.pause) Sequencer.pause();
    // Idle in background: suspend so the status-bar play icon also clears
    // behind other apps (not just when the song ends in the foreground).
    try { if (typeof _engine().setActive === 'function') _engine().setActive(false); } catch (eBS) {}
  }, false);
  window.addEventListener('focus', function () {
    try { _engine().resume(); } catch (e) {}
    // Re-sync the audible flag: if we're not actually playing, keep the
    // AudioContext suspended so the OS status-bar play icon stays hidden.
    try {
      var _sf = Store.getState();
      if (_sf && _sf.play !== 'play' && typeof _engine().setActive === 'function') {
        _engine().setActive(false);
      }
    } catch (eS) {}
    // If Store still says 'play' but blur's direct Sequencer.pause() stopped the pulse,
    // restart it. (Background-play blur does NOT pause, so this is a no-op in that case.)
    try {
      var st2 = Store.getState();
      if (st2 && st2.play === 'play' && typeof Sequencer !== 'undefined') {
        var _isPl = false;
        try { _isPl = Sequencer.isPlaying ? Sequencer.isPlaying() : false; } catch (eP) {}
        if (!_isPl) Sequencer.play();
      }
      // Re-acquire screen wake lock for foreground play (released on blur).
      if (st2 && st2.play === 'play') acquireScreenWakeLock();
    } catch (eF) {}
    // Kick the rAF loop — it stalls while document is hidden (KaiOS throttles rAF).
    try {
      if (typeof cancelAnimationFrame === 'function' && rafId) cancelAnimationFrame(rafId);
    } catch (eC) {}
    try {
      lastFrameTime = performance.now();
      rafId = requestAnimationFrame(renderLoop);
    } catch (eR) {}
    try { onResize(); } catch (eO) {}
  }, false);

  // ── SOFTKEYS ──
  // (Softkey labels are now managed by controls.js via updateSoftkeys())

  // ── FILE LOADING ──

  /**
   * Exit fullscreen if currently active, so the chrome (header showing the
   * filename + softkey bar with PLAY/PAUSE) is visible after a MIDI load.
   *
   * Robust against:
   *  - class set but native API never entered FS (no permission) → only
   *    class removal needed.
   *  - native FS still active (mozFullScreenElement truthy) → class removal
   *    + mozCancelFullScreen, even if the latter throws silently.
   *  - canvas stale at fullscreen size after class remap → force TWO resizes
   *    (immediate + 100ms) since KaiOS screen.availHeight can lag behind
   *    the FS exit animation.
   */
  function exitFullscreenIfActive() {
    var appEl = document.getElementById('app');
    if (appEl && appEl.classList.contains('fullscreen')) {
      appEl.classList.remove('fullscreen');
    }
    // Only call B2G exit if the platform actually reports fullscreen.
    // When the user opens the app from File Manager (MozActivity
    // 'open'), KaiOS may briefly mark the window as fullscreen during
    // wake-up. Calling mozCancelFullScreen when we're not actually in
    // fullscreen makes the shell re-layout the window mid-load, which
    // shifts our chrome behind the system status bar.
    var inFs = !!(document.mozFullScreenElement ||
                  document.fullscreenElement);
    if (inFs) {
      try {
        if (document.mozCancelFullScreen) document.mozCancelFullScreen();
        else if (document.exitFullscreen) document.exitFullscreen();
      } catch (e) {}
    }

    // Recompute canvas dimensions immediately so the renderer doesn't stay
    // glued to the fullscreen size for a frame.
    resizeCanvas();
    // …and one more time after the system has actually torn down its
    // fullscreen chrome. Without this, on KaiOS 2.5 screen.availHeight can
    // still report the old fullscreen height for ~100-200ms.
    setTimeout(function () {
      resizeCanvas();
      if (typeof window.refreshMenuLabels === 'function') {
        window.refreshMenuLabels();
      }
    }, 100);
  }

  /**
   * Feed parsed MIDI data object directly to Sequencer + Store.
   * No JSON.stringify/parse round-trip — takes the already-parsed JS object.
   */
  // Wrap parseMIDI to expose buffer
  var _origParseMIDI = MidiParser.parseMIDI;
  MidiParser.parseMIDI = function(buf) {
    window._rawMidiBuffer = buf;
    return _origParseMIDI(buf);
  };

  function loadMIDIData(midiData) {
    var notes = midiData.notes || [];
    var tempo = midiData.tempo || [{ t: 0, u: 500000 }];
    var div   = midiData.div || 480;

    // Loading any real file ends the demo track and unlocks everything
    // (hot keys + Note Color Randomise). Must cover both the case where the
    // demo is still playing AND the case where it already finished (locked).
    if (_demoActive || _lockNoFile) clearDemo();

    // Loading a new file ends fullscreen — user wants the chrome.
    exitFullscreenIfActive();

    Sequencer.load(notes, tempo, div);

    // Store the NORMALISED map (deduped, sorted, guaranteed tick-0 entry) —
    // the loader's values may contain duplicates/unsorted rows/gaps that
    // would otherwise make BPM and playback speed disagree across files.
    var _nMap = (typeof Tempo !== 'undefined' && Array.isArray(Tempo.map)) ? Tempo.map.slice() : tempo;
    var _nDiv = (typeof Tempo !== 'undefined' && Tempo.div > 0) ? Tempo.div : div;

    console.log('[BPM] midiData tempo#' + (midiData.tempo ? midiData.tempo.length : 0) +
      ' -> norm#' + _nMap.length + ' ' + JSON.stringify(_nMap.slice(0, 8)) +
      ( _nMap.length > 8 ? ' ...total ' + _nMap.length : '') + ' div=' + _nDiv);

    Store.setState({
      notes:     notes,
      tempoMap:  _nMap,
      division:  _nDiv,
      format:    midiData.fmt || 1,
      timeSec:   0,
      play:      'stop',
      activeNoteCount: 0,
      // Arm the one-shot "Now playing" toast for THIS file — consumed by
      // the first playback start (manual Play or Auto Play), never on
      // pause/resume.
      npPending: true,
    });

    HUD.setTotal(notes.length);
    if (typeof NoteBuffer !== 'undefined' && NoteBuffer.isReady()) NoteBuffer.reset();

    // Hide analyzing overlay — load complete. ("Now playing: <file>" is
    // shown centered when the user presses Play — see controls.js.)
    hideParsing();

    // Update softkeys (show Play button)
    if (typeof window.updateSoftkeys === 'function') {
      window.updateSoftkeys();
    }

    // Auto Play (Visual settings): start playback right away — honours
    // Start Delay and fires the pending "Now playing" toast exactly once.
    var stAuto = Store.getState();
    if (stAuto.autoPlay && typeof window.pfaRequestStart === 'function') {
      try { window.pfaRequestStart(); } catch (e) {}
    }

    console.log('[Main] Loaded ' + notes.length + ' notes');

    // Re-sync window size 100ms after load. When the app is launched via
    // MozActivity 'open' from the File Manager, KaiOS sometimes reports
    // a stale window.innerHeight in the initial frames (the activity
    // wake-up animation hasn't finished). Without this re-sync the
    // canvas keeps its boot-time dimensions, the body scroll position
    // lands off-screen, and the HUD ends up behind the system status
    // bar. Force a resize so the renderer recalculates against the
    // current viewport.
    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        try { onResize(); } catch (e) {}
      }, 100);
    }

    return true;
  }

  // True when a blob/filepath name points at a MIDI-JSON file (converted
  // from .mid). Recognises both .json and .note — the .note extension is what
  // mid2note.js writes and is selectable via the native KaiOS File Manager.
  // Soundbank JSON is handled separately in triggerLoadFile.
  function _isJsonName(name) {
    if (!name) return false;
    var n = String(name).toLowerCase();
    if (n.endsWith('.soundbank.json')) return false;
    return n.endsWith('.json') || n.endsWith('.note');
  }

  // Parsing pill label: MIDI-JSON files (.json/.note) read as text show
  // "Reading Data...", raw .mid files keep "Analyzing MIDI Data...".
  function _parsingLabel(name) {
    return _isJsonName(name) ? L10n.t('reading_data', 'Reading Data...') : L10n.t('analyzing_midi', 'Analyzing MIDI Data...');
  }

  /**
   * Parse .mid.json/.note text → object → loadMIDIData.
   */
  function loadMIDIJson(jsonText) {
    try {
      var midi = JSON.parse(jsonText);
      loadMIDIData(midi);
      return true;
    } catch (e) {
      console.error('[Main] JSON parse error:', e);
      // File failed to parse — treat as no file loaded so PLAY/PAUSE and
      // the file name disappear, then show a KaiUI-style error dialog.
      resetLoadOnError();
      // Keep demo locked after the error (no restart) — unlock only on
      // a successful .mid/.note load via loadMIDIData -> clearDemo().
      showErrorDialog(L10n.t('err_cannot_read_midi', 'Could not read this file. It may not be a valid MIDI or (.note) export.'));
      return false;
    }
  }

  // ── Binary PFA2 .note playback (streaming from disk) ───────────────
  // A converted huge MIDI is a PFA2 binary .note on storage. Instead of
  // loading it as text/JSON (it isn't JSON), open it through NoteStream: the
  // sequencer reads notes on demand from a sliding disk window, so millions
  // of notes stream without ever materialising as objects in RAM.

  function _isPFA2(blob) {
    return new Promise(function (resolve) {
      console.log('[Main] _isPFA2 size=' + (blob ? blob.size : '?' ) + ' type=' + (blob ? blob.type : '?'));
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var dv = new DataView(fr.result);
          console.log('[Main] _isPFA2 head=' + [0,1,2,3].map(function(k){return dv.getUint8(k);}).join(','));
          resolve(dv.getUint8(0) === 0x50 && dv.getUint8(1) === 0x46 &&
                  dv.getUint8(2) === 0x41 && dv.getUint8(3) === 0x32);
        } catch (e) { console.error('[Main] _isPFA2 catch', e); resolve(false); }
      };
      fr.onerror = function (e) { console.error('[Main] _isPFA2 onerror', e); resolve(false); };
      try { fr.readAsArrayBuffer(blob.slice(0, 4)); }
      catch (e) { console.error('[Main] _isPFA2 slice threw', e); resolve(false); }
    });
  }

  function loadBinaryNoteFromFile(file, displayName) {
    if (typeof NoteStream === 'undefined') {
      console.warn('[NoteStream] not loaded');
      hideParsing();
      return Promise.reject(new Error('NoteStream unavailable'));
    }
    console.log('[Main] loadBinaryNoteFromFile size=' + (file ? file.size : '?'));
    return NoteStream.open(file).then(function (ns) {
      console.log('[Main] NoteStream.open OK length=' + ns.length);
      return loadBinaryNote(ns, displayName);
    }).catch(function (e) {
      console.error('[NoteStream] open failed', e && e.message, e && e.stack);
      hideParsing();
      return Promise.reject(e);
    });
  }

  function loadBinaryNote(ns, displayName) {
    if (_demoActive || _lockNoFile) clearDemo();
    exitFullscreenIfActive();
    try { if (performance && performance.memory) console.log('[Heap] loadBinaryNote stream OPEN heapKB=' + Math.round(performance.memory.usedJSHeapSize / 1024)); } catch (e) {}

    Sequencer.load(ns, ns.tempoMap, ns.div);

    var _nMap = (typeof Tempo !== 'undefined' && Array.isArray(Tempo.map)) ? Tempo.map.slice() : ns.tempoMap;
    var _nDiv = (typeof Tempo !== 'undefined' && Tempo.div > 0) ? Tempo.div : ns.div;

    console.log('[BPM] noteStream tempo#' + (ns.tempoMap ? ns.tempoMap.length : 0) +
      ' -> norm#' + _nMap.length + ' ' + JSON.stringify(_nMap.slice(0, 8)) +
      ( _nMap.length > 8 ? ' ...total ' + _nMap.length : '') + ' div=' + _nDiv);

    Store.setState({
      notes:     ns,
      tempoMap:  _nMap,
      division:  _nDiv,
      format:    1,
      timeSec:   0,
      play:      'stop',
      activeNoteCount: 0,
      fileName:  displayName,
      npPending: true,
    });

    HUD.setTotal(ns.length);
    if (typeof NoteBuffer !== 'undefined' && NoteBuffer.isReady()) NoteBuffer.reset();
    hideParsing();

    if (typeof window.updateSoftkeys === 'function') {
      window.updateSoftkeys();
    }

    var stAuto = Store.getState();
    if (stAuto.autoPlay && typeof window.pfaRequestStart === 'function') {
      try { window.pfaRequestStart(); } catch (e) {}
    }

    console.log('[NoteStream] streaming ' + ns.length + ' notes from disk');

    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        try { onResize(); } catch (e) {}
      }, 100);
    }
    return true;
  }

  // Open a .note that may be PFA2 binary (stream) or legacy JSON text.
  // onDone runs after the load finishes (activity foreground, etc.).
  function _openNoteFile(blob, name, onDone) {
    var display = String(name || 'file').split('/').pop();
    _isPFA2(blob).then(function (isBin) {
      if (isBin) {
        return loadBinaryNoteFromFile(blob, display).then(function () {
          if (onDone) { try { onDone(); } catch (e) {} }
        });
      }
      var r = new FileReader();
      r.onload = function () {
        try {
          loadMIDIJson(r.result);
        } catch (e) {
          console.error('[Main] JSON parse error', e);
          hideParsing();
        }
        if (onDone) { try { onDone(); } catch (e) {} }
      };
      r.onerror = function () {
        console.error('[Main] JSON FileReader error');
        hideParsing();
        if (onDone) { try { onDone(); } catch (e) {} }
      };
      r.readAsText(blob);
    });
  }
  window.openNoteFile = _openNoteFile;

  // After a huge-MIDI conversion: find the written .note on ANY sdcard
  // volume, open a streaming player for it, and hand it to the sequencer.
  // Resolves when playback is loaded (or the fallback notify fired).
  function _openConvertedNote(path, name) {
    console.log('[NoteStream] opening converted .note for playback: ' + path);
    // Re-note this path in the write-log — it may predate the log itself, and
    // (re)opening it from the cache means Clear should be able to drop it.
    try {
      if (typeof Written !== 'undefined' && Written.remember &&
          path.lastIndexOf('others/pfa_tmp/', 0) === 0) Written.remember(path);
    } catch (e) {}
    function fallback() {
      hideParsing();
      if (typeof showNowPlayingNotification === 'function') {
        try { showNowPlayingNotification('Saved .note: ' + name); } catch (e) {}
      }
    }
    if (typeof NoteStream === 'undefined') { fallback(); return Promise.resolve(); }
    return _locateNoteFile(path)
      .then(function (file) {
        if (!file) { console.error('[NoteStream] converted .note not found: ' + path); fallback(); return; }
        showParsing(L10n.t('reading_data', 'Reading Data...'));
        return loadBinaryNoteFromFile(file, name);
      })
      .catch(function (e) {
        console.error('[NoteStream] playback open failed', e);
        hideParsing();
      });
  }

  function _dsGetOnce(st, path) {
    return new Promise(function (resolve) {
      var r = st.get(path);
      var t = setTimeout(function () { resolve(null); }, 8000);
      r.onsuccess = function () { clearTimeout(t); resolve(r.result || null); };
      r.onerror = function () { clearTimeout(t); resolve(null); };
    });
  }

  function _locateNoteFile(path) {
    var tries = [];
    try {
      if (navigator.getDeviceStorages) tries = navigator.getDeviceStorages('sdcard') || [];
      else if (navigator.getDeviceStorage) tries = [navigator.getDeviceStorage('sdcard')];
    } catch (e) { tries = []; }
    var i = 0;
    function next() {
      if (i >= tries.length) return Promise.resolve(null);
      var st = tries[i++];
      return _dsGetOnce(st, path).then(function (f) { return f || next(); });
    }
    return next();
  }

  // Reset player state after a failed load so the app looks empty again
  // (no file name, no PLAY/PAUSE, no piano data).
  function resetLoadOnError() {
    try { if (typeof Sequencer !== 'undefined' && Sequencer.stop) Sequencer.stop(); } catch (ig3) {}
    try {
      if (typeof Sequencer !== 'undefined' && Sequencer.load) Sequencer.load([], [], 480);
    } catch (ig4) {}
    Store.setState({ play: 'stop', notes: [], fileName: '', timeSec: 0, startCountdown: null, cdRunning: false });
    if (typeof HUD !== 'undefined' && HUD.setTotal) HUD.setTotal(0);
    window._midiBlob = null;
    window._rawMidiBuffer = null;
    window._midiName = null;
    window._midiData = null;
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  // True while the built-in demo track is playing.
  function isDemoActive() { return _demoActive; }

  // True from demo start through its end, until a real file is loaded.
  // While true, speed/transport hot keys and Note Color Randomise are locked.
  function isPlaybackLocked() { return _lockNoFile; }

  // During the bundled demo — AND after it ends, while the app is still
  // "locked" (no real file loaded, _lockNoFile true) — visual settings are
  // ignored: the demo always renders with its fixed defaults installed in
  // Store at boot. This keeps the piano strip hidden ("no piano") from demo
  // start through its end, until a real .mid/.note is loaded, without ever
  // touching the user's saved Visual Settings (Options still shows Big). The
  // overrides only matter once a real file is loaded. Returns `current` when
  // not locked.
  var DEMO_VISUAL_DEFAULTS = {
    bgColor:      null,     // demo background stays on the theme token (black)
    renderMode: 'buffer',
    speed:      1.0,
    // Buffer-mode fall time = 1/trail (see notebuffer.js effectiveLK).
    // trail 1.0 → a note takes exactly 1.0s from the top of the band to
    // the bottom. Kept in sync with the 1s demo pre-roll so the opening
    // notes start at the top edge and reach the bottom 1s in.
    trail:      1.0,
    view3d:     'both',    // demo always renders 3D notes on
    kbStart:    21,
    kbEnd:      108,
    pianoSize:  'none',   // demo shows notes only — no piano keyboard
  };
  function demoVisualValue(key, current) {
    if (!(_demoActive || _lockNoFile)) return current;
    return (key in DEMO_VISUAL_DEFAULTS) ? DEMO_VISUAL_DEFAULTS[key] : current;
  }

  // End the demo cleanly (natural end of the demo track): the demo is no
  // longer "playing" so HUD/PLAY-PAUSE return to normal, but speed/transport
  // hot keys and Note Color Randomise STAY locked until a real file loads.
  function endDemoPlayback() {
    _demoActive = false;
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  // Full unlock: called only when a real .mid/.note is loaded. Clears the
  // demo flag and releases the hot-key / Note Color Randomise lock.
  function clearDemo() {
    _demoActive = false;
    _lockNoFile = false;
    // A real file is in — the demo's fixed track colors no longer apply;
    // the user's Note Color palette takes over.
    if (typeof Notes !== 'undefined' && Notes.setDemoOverride) {
      try { Notes.setDemoOverride(false); } catch (e) {}
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    // Un-grey the Note Color Randomise Options item.
    if (typeof window.refreshDemoLock === 'function') {
      try { window.refreshDemoLock(); } catch (e) {}
    }
    // A real file just loaded — un-hide the Info card and apply the Info
    // Card appearance settings that were dormant during the demo.
    if (typeof Settings !== 'undefined' && Settings.applyInfoCard) {
      try { Settings.applyInfoCard(); } catch (e) {}
    }
  }

  // Hard-stop the demo the instant a real file starts loading, even when it
  // is mid-play. Unlike endDemoPlayback (demo reached its natural end), this
  // also silences the synth + resets the sequencer so NO demo audio or notes
  // keep running behind a long analysis (sound + visuals + RAM). _lockNoFile
  // stays on purpose: only a successfully loaded real file clears it.
  function stopDemoPlayback() {
    if (!_demoActive && !_lockNoFile) return;
    _demoActive = false;
    try { _engine().silence(); } catch (e) {}
    if (typeof Sequencer !== 'undefined' && Sequencer.stop) {
      try { Sequencer.stop(); } catch (e) {}
    }
    try { Store.setState({ play: 'stop', npPending: false }); } catch (e) {}
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    if (typeof window.refreshDemoLock === 'function') {
      try { window.refreshDemoLock(); } catch (e) {}
    }
    console.log('[Main] demo playback stopped for file analysis');
  }

  // Play the bundled demo.note (auto-starts on first app entry). Loads it
  // exactly like a real file, then hides transport, forces HUD to 0/0 +
  // 0:00, and starts playing. Ends once (no loop); loading a real file or
  // a parse-error restart calls this again to re-run from the start.
  function startDemo() {
    // A pending real-file activity overrides the demo on this boot — and a
    // real file already being serviced (activity fired mid-boot, canvas was
    // already wired so it went inline) must also suppress it; otherwise the
    // demo's own loadMIDIData()→hideParsing() kills the analyze OSD and the
    // demo plays underneath the real conversion.
    if (_pendingActivity || _activityBusy) return;
    fetch('js/demo.note')
      .then(function (res) {
        if (!res.ok) throw new Error('js/demo.note missing (HTTP ' + res.status + ')');
        return res.text();
      })
      .then(function (txt) {
        var midi = JSON.parse(txt);
        loadMIDIData(midi);          // load notes/tempo/div, resets sequencer
        _demoActive = true;          // set AFTER load so clearDemo isn't triggered
        _lockNoFile = true;          // hot keys + Note Color Randomise stay locked
        // Force the two demo tracks' fixed colors (yellow + water blue),
        // overriding any Note Color palette until a real file loads.
        if (typeof Notes !== 'undefined' && Notes.setDemoOverride) {
          try { Notes.setDemoOverride(true); } catch (e) {}
        }
        // Demo is active now — force-hide the Info card and ignore Info Card
        // appearance until a real file loads.
        if (typeof Settings !== 'undefined' && Settings.applyInfoCard) {
          try { Settings.applyInfoCard(); } catch (e) {}
        }
        // The demo always plays at its fixed default 1.0x regardless of any
        // persisted / changed speed setting. (At boot, onStoreChange may have
        // already applied a saved speed before the demo became active — reset
        // it here so the demo is never affected by the user's saved speed.)
        if (typeof Sequencer !== 'undefined' && Sequencer.setSpeed) {
          try { Sequencer.setSpeed(1.0); } catch (e) {}
        }
        _prevSpeed = 1.0;
        // 1s pre-roll: the clock starts at -1s so the first notes begin at
        // the TOP edge of the band and fall down over exactly 1 second
        // (matching the demo trail 1.0 → 1s fall) instead of spawning
        // already at the bottom the instant the demo opens. Nothing touches
        // the bottom until 1 second in.
        if (typeof Sequencer !== 'undefined' && Sequencer.setStartOffset) {
          try { Sequencer.setStartOffset(1.0); } catch (e) {}
        }
        HUD.setTotal(0);             // HUD shows 0/0
        Sequencer.play();            // self-play with audio + visuals
        Store.setState({ play: 'play', npPending: false });
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        if (typeof window.refreshDemoLock === 'function') window.refreshDemoLock();
        console.log('[Main] demo track started');
      })
      .catch(function (e) {
        console.error('[Main] demo start failed:', e);
        _demoActive = false;
        _lockNoFile = false;
      });
  }
  window.triggerLoadFile = function (filePath) {
    // ALWAYS clear loadFile FIRST to prevent infinite re-trigger
    Store.setState({ fileName: filePath, loadFile: null });

    // Support optional soundbank loading via query param "sb"
    if (filePath && filePath.endsWith('.soundbank.json')) {
      if (window.Soundbank) {
        Soundbank.load(filePath).catch(e => console.error('[Main] Soundbank load error', e));
      }
      return;
    }
    // Binary SoundFont (.sf2 / .sf3) picked from the File Manager: read
    // the whole file and import it as a bank (same path the Settings scan
    // uses, minus the scanning).
    if (filePath && (filePath.endsWith('.sf2') || filePath.endsWith('.sf3'))) {
      _loadSfPicked(filePath);
      return;
    }
    _activityBusy = true;

    // Handle .mid files with caching
    if (filePath.endsWith('.mid')) {
      showParsing(_parsingLabel(filePath)); // Analyzing MIDI Data...

      if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
        var ds = navigator.getDeviceStorage('sdcard');
        // Strip /sdcard/ prefix — getDeviceStorage path is relative to storage root
        var dsPath = filePath.replace(/^\/sdcard\//, '');
        var req = ds.get(dsPath);

        req.onsuccess = function () {
          _routeMidiBlob(this.result, filePath);
        };

        req.onerror = function () {
          console.error('[Main] deviceStorage.get failed: ' + filePath);
          // Fallback: fetch via systemXHR as blob (stream from disk, no OOM)
          var url = filePath;
          if (filePath[0] === '/') url = 'file://' + filePath;
          var xhr = new XMLHttpRequest({mozSystem: true});
          xhr.open('GET', url, true);
          xhr.responseType = 'blob';
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
              var fileBlob = xhr.response;
              window._midiBlob = fileBlob;
              window._midiName = filePath.split('/').pop();
              _routeMidiBlob(fileBlob, filePath.split('/').pop());
            } else {
              console.error('[Main] XHR fallback failed', xhr.status);
              hideParsing();
            }
          };
          xhr.onerror = function () { console.error('[Main] XHR fallback error'); hideParsing(); };
          try { xhr.send(); } catch (e) { console.error('[Main] XHR send failed', e); hideParsing(); }
        };
      } else {
        // Desktop debug: XHR fetch
        var xhr = new XMLHttpRequest();
        xhr.open('GET', filePath, true);
        xhr.responseType = 'blob';
        xhr.onload = function () {
          if (xhr.status === 200) {
            _routeMidiBlob(xhr.response, filePath);
          } else {
            console.error('[Main] XHR status=' + xhr.status);
          }
        };
        xhr.onerror = function () {
          console.error('[Main] XHR error: ' + filePath);
          hideParsing();
        };
        xhr.send();
      }

      return;
    }

    // Existing code for other file types (.mid.json / .json / .note MIDI)
    showParsing(_parsingLabel(filePath)); // Reading Data... for .note/.json

    if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
      var ds = navigator.getDeviceStorage('sdcard');
      var req = ds.get(filePath);

      req.onsuccess = function () {
        // PFA2 binary .note streams from disk; legacy text restores JSON.
        _openNoteFile(this.result, filePath);
      };
      req.onerror = function () {
        console.error('[Main] deviceStorage.get failed: ' + filePath);
        hideParsing();
      };
    } else {
      // Desktop debug
      var xhr = new XMLHttpRequest();
      xhr.open('GET', filePath, true);
      xhr.onload = function () {
        if (xhr.status === 200) loadMIDIJson(xhr.responseText);
        else console.error('[Main] XHR status=' + xhr.status);
      };
      xhr.onerror = function () {
        console.error('[Main] XHR error: ' + filePath);
      };
      xhr.send();
    }
  };

  // ── SoundFont import from the File Manager ──
  // triggerLoadFile route for .sf2 / .sf3: resolve the volume by path
  // prefix (/sdcard… = SD card, /internal… = internal storage), read the
  // file whole, then import it as a Soundbank bank. Falls back to XHR for
  // desktop debug like every other loader.
  function _loadSfPicked(path) {
    var sfName = path.split('/').pop();
    if (typeof Soundbank === 'undefined' || !Soundbank.loadFromFile) {
      if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_sf_unavailable', 'Soundbank unavailable'));
      return;
    }

    // Check if already loaded in Soundbank
    var existingBanks = (typeof Soundbank.getBanks === 'function') ? Soundbank.getBanks() : [];
    var isAlreadyLoaded = existingBanks.some(function (b) {
      return (b.path && b.path === path) || (b.name && sfName && b.name === sfName);
    });

    if (isAlreadyLoaded) {
      var alreadyMsg = 'already loaded ' + sfName;
      if (typeof Settings !== 'undefined' && typeof Settings.openSfDoneDialog === 'function') {
        Settings.openSfDoneDialog(alreadyMsg);
      } else if (typeof window.showToast === 'function') {
        window.showToast(alreadyMsg);
      }
      return;
    }
    var volName = (path.indexOf('/sdcard') === 0) ? 'sdcard1' : 'internal';

    function readBlobToArrayBuffer(blob, cb) {
      var fr = new FileReader();
      fr.onload = function () { cb(fr.result); };
      fr.onerror = function () { cb(null); };
      fr.readAsArrayBuffer(blob);
    }

    function importAB(ab) {
      if (!ab) {
        if (typeof showErrorDialog === 'function') {
          showErrorDialog(L10n.t('err_sf_read_corrupt', 'Failed to read SoundFont "') + sfName + L10n.t('err_sf_corrupt_suffix', '". File may be moved, deleted, or corrupted.'), null, L10n.t('error', 'Error'));
        } else if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_sf_failed_read', 'Failed to read ') + sfName);
        return;
      }
      Soundbank.loadFromFile(sfName, path, volName, ab).then(function () {
        try { Store.setState({ engine: 'soundbank' }); } catch (e) {}
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_sf_loaded', 'Loaded ') + sfName);
      }, function (err) {
        if (typeof showErrorDialog === 'function') {
          showErrorDialog(L10n.t('toast_sf_failed_load', 'Failed to load ') + sfName + ': ' + ((err && err.message) || L10n.t('err_sf_file_error', 'file error, moved, or deleted.')), null, L10n.t('error', 'Error'));
        } else if (typeof window.showToast === 'function') {
          window.showToast(L10n.t('toast_sf_failed_load', 'Failed to load ') + sfName + ': ' + ((err && err.message) || 'parse error'));
        }
      });
    }

    if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
      // Try the volume hinted by the path prefix, else the other one.
      var tries = [volName];
      if (volName === 'sdcard1') tries.push('internal');
      else tries.push('sdcard');
      var attempt = 0;
      (function next() {
        if (attempt >= tries.length) {
          if (typeof window.showToast === 'function') window.showToast(L10n.t('error_file_read', 'Failed to read') + ' ' + sfName);
          return;
        }
        var storageKey = tries[attempt++];
        var ds = navigator.getDeviceStorage(storageKey);
        var rel = path.replace(/^\/(sdcard|sdcard1|internal|internal\/storage|volume)\//, '');
        var req = ds.get(rel);
        req.onsuccess = function () { readBlobToArrayBuffer(this.result, importAB); };
        req.onerror = function () { next(); };
      })();
    } else {
      // Desktop debug: XHR as arrayBuffer (mozSystem not needed there).
      var xhr = new XMLHttpRequest();
      xhr.open('GET', path, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () {
        if (xhr.status === 200 && xhr.response) importAB(xhr.response);
        else if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_sf_failed_read', 'Failed to read ') + sfName);
      };
      xhr.onerror = function () {
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_sf_failed_read', 'Failed to read ') + sfName);
      };
      xhr.send();
    }
  }

  // ── HASH FUNCTION FOR CACHING ---
  // Computes a hash of a string, returns a hex string (32-bit truncated)
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    // Return truncated 32-bit unsigned int as hex
    return Math.abs((hash >>> 0)).toString(16);
  }

  // ── KICKOFF ──

    var _booted = false;
  var _langPinned = false;   // one-shot: pin the saved manual language before boot
  function tryBoot() {
    if (_booted) return;
    if (!(typeof L10n !== 'undefined' && L10n.isReady && L10n.isReady())) return;
    // Boot in the user's pinned language, not the system one: switch first
    // and let the resulting 'localized' drive the actual boot (avoids a flash
    // of the wrong language). Auto change language (default) leaves the
    // system locale untouched.
    if (!_langPinned) {
      _langPinned = true;
      var want = null;
      try {
        if (typeof Settings !== 'undefined' && Settings.savedLanguage) want = Settings.savedLanguage();
      } catch (eL) {}
      var have = null;
      try {
        have = navigator.mozL10n && navigator.mozL10n.language &&
               navigator.mozL10n.language.code;
      } catch (eL2) {}
      if (want && want !== have) {
        var switched = false;
        try { navigator.mozL10n.language.code = want; switched = true; } catch (eL3) {}
        if (switched) {
          // Safety net: boot anyway if 'localized' never arrives.
          setTimeout(function () { if (!_booted) { _booted = true; boot(); } }, 1500);
          return;
        }
      }
    }
    _booted = true;
    boot();
  }

  // A locale switch (manual pick, boot pin, or system change) retranslates the
  // static DOM itself; dynamic settings rows are rebuilt through this hook.
  window.addEventListener('localized', function () {
    try {
      if (typeof Settings !== 'undefined' && Settings.onLocaleChanged) Settings.onLocaleChanged();
    } catch (e) {}
  });

  // While Auto change language is Off, a device language change must not
  // change the app language — re-assert the pinned locale.
  window.addEventListener('languagechange', function () {
    try {
      if (typeof Settings !== 'undefined' && Settings.applyLanguagePreference) {
        Settings.applyLanguagePreference();
      }
    } catch (e) {}
  });

  window.addEventListener('localized', tryBoot);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    tryBoot();
  } else {
    document.addEventListener('DOMContentLoaded', tryBoot);
  }

  // ── PARSING PROGRESS ──
  // Center-screen "Analyzing MIDI Data..." message while a file is being
  // read + parsed. Uses #now-playing-overlay/#now-playing-text (styles in
  // kaiui.css) — the same pill the Now Playing toast uses.
  // label: optional text; defaults to "Analyzing MIDI Data...". .note/.json
  // MIDI files show "Reading Data..." instead (see _parsingLabel).
  function showParsing(label) {
    var msgToken = (typeof label === 'string' && label.length) ? label : L10n.t('analyzing_midi', 'Analyzing MIDI Data...');
    // Developer → Verbose while analyzing: the newest pipeline log line is
    // shown UNDER the label inside the pill (suppressed when Show Dialog is
    // Off — same Visual gate as the pill itself).
    _devActive = true; _lastAnalyzeLog = '';
    // Kill the bundled demo right away (even mid-play) so its audio + notes
    // never compete with a real .mid/.note analysis.
    try { stopDemoPlayback(); } catch (e) {}
    // The analyze indicator belongs ONLY over the piano (player screen) —
    // never over Options/menu/settings/about. Off the piano: show nothing;
    // the indicator reappears when the user returns to the player screen.
    if (!_onPlayerScreen()) return;
    // Visual → Show Dialog = Off suppresses the pill; keep just the bar.
    if (Store.getState().showDialog === false) {
      var bar0 = document.getElementById('parse-bar');
      if (bar0) {
        bar0.classList.remove('hidden');
        bar0.classList.add('indeterminate');
      }
      _parseIndicatorActive = true;
      applyParseBarStyle();
      return;
    }
    _parseIndicatorActive = true;
    ensureParsePill();
    var overlay = document.getElementById('now-playing-overlay');
    var textEl  = document.getElementById('now-playing-text');
    var bar     = document.getElementById('parse-bar');
    if (textEl) _setParseText(msgToken);
    if (bar) {
      bar.classList.remove('hidden');
      bar.classList.add('indeterminate');
    }
    applyParseBarStyle();
  }

  // Reconcile the parse indicator when the user leaves/re-enters the player
  // screen mid-analysis: hide pill+bar over menus/settings/about, restore
  // them when back on the piano (progress is still running underneath).
  function _reconcileParseIndicator() {
    if (_parseIndicatorActive && !_onPlayerScreen()) {
      var ov = document.getElementById('now-playing-overlay');
      if (ov && !ov.classList.contains('np-hide')) ov.classList.add('np-hide');
      var bar = document.getElementById('parse-bar');
      if (bar && !bar.classList.contains('hidden')) {
        bar.classList.add('hidden');
        bar.classList.remove('indeterminate');
      }
      var pctH = document.getElementById('parse-pct');
      if (pctH) pctH.classList.add('hidden');
      return;
    }
    if (_parseIndicatorActive && _onPlayerScreen()) {
      var ov2 = document.getElementById('now-playing-overlay');
      if (ov2 && Store.getState().showDialog !== false &&
          ov2.classList.contains('np-hide')) {
        ov2.classList.remove('np-hide');
      }
      // Restore the BAR too (the hide branch stacked it to .hidden) — back on
      // the piano the indicator must reappear in the mode analysis is in.
      var bar2 = document.getElementById('parse-bar');
      if (bar2 && bar2.classList.contains('hidden')) {
        bar2.classList.remove('hidden');
        var f2 = document.getElementById('parse-bar-fill');
        if (_parseMode === 'indet') {
          bar2.classList.add('indeterminate');
          if (f2) { f2.style.left = ''; f2.style.width = ''; }
        } else {
          bar2.classList.remove('indeterminate');
          if (f2) { f2.style.left = '0%'; f2.style.width = _parsePct.toFixed(1) + '%'; }
        }
      }
      // Loading-bar visibility + color (Settings → Visual → Loading Bar).
      applyParseBarStyle();
      // Restore the percentage readout to the live value.
      var pctR = document.getElementById('parse-pct');
      if (pctR) {
        var wantPct2 = _phaseShowPct(_pctStage);
        // Hide only when the phase toggle is off, or when the sweep is
        // running before the first progress value arrives (no real number).
        if (!wantPct2 || (_parseMode === 'indet' && _parsePct <= 0)) {
          pctR.textContent = ''; pctR.classList.add('hidden');
        } else {
          pctR.textContent = Math.round(_parsePct) + '%';
          pctR.classList.remove('hidden');
        }
      }
    }
  }

  function hideParsing() {
    _parseIndicatorActive = false;
    _parseMode = '';
    _parsePct = 0;
    _devActive = false; _lastAnalyzeLog = '';
    var overlay = document.getElementById('now-playing-overlay');
    var bar     = document.getElementById('parse-bar');
    var pctE    = document.getElementById('parse-pct');
    if (overlay) overlay.classList.add('np-hide');
    if (bar) {
      bar.classList.remove('indeterminate');
      bar.classList.add('hidden');
    }
    if (pctE) {
      pctE.textContent = '';
      pctE.classList.add('hidden');
    }
  }

  // KaiUI-style error dialog — single centre OK on the softkey bar.
  // Mirrors KaiUI-master Dialog (header + white container, dim overlay).
  // Used when a .note/.json MIDI file fails to read or parse (see loadMIDIJson).
  var _errorDialogOpen = false;
  var _errorOnClose = null;   // optional callback invoked when the dialog is closed
  function isErrorDialogOpen() { return _errorDialogOpen; }

  function showErrorDialog(msg, onClose, header) {
    hideParsing();
    _errorOnClose = onClose || null;
    var msgEl = document.getElementById('error-dialog-msg');
    var dlg   = document.getElementById('error-dialog');
    if (dlg) {
      var hd = dlg.querySelector('.kai-dialog-header');
      if (hd) hd.textContent = header || 'Error';
    }
    if (msgEl) msgEl.textContent = msg || 'Could not read this file.';
    if (dlg) dlg.classList.remove('hidden');
    _errorDialogOpen = true;
    // Drive the softkey bar to centre OK (controls.js updateSoftkeys reads
    // this flag). Fallback to direct DOM if controls isn't wired yet.
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    else {
      var c = document.getElementById('sk-center');
      var l = document.getElementById('sk-left');
      var r = document.getElementById('sk-right');
      if (c) c.textContent = L10n.t('softkey-ok', 'OK');
      if (l) l.textContent = '';
      if (r) r.textContent = '';
    }
  }

  function hideErrorDialog() {
    window._pfaAuthDialog = false; // dialog gone → permission tag irrelevant
    var dlg = document.getElementById('error-dialog');
    var cb  = _errorOnClose;
    _errorOnClose = null;
    if (dlg) dlg.classList.add('hidden');
    _errorDialogOpen = false;
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    else {
      var c2 = document.getElementById('sk-center');
      if (c2) c2.textContent = '';
    }
    // Run any queued close handler (e.g. restart the demo track).
    if (cb) { try { cb(); } catch (e) {} }
  }

  // Desktop click fallback: tapping the dim overlay dismisses the dialog.
  function bindErrorDialogControls() {
    var dlg = document.getElementById('error-dialog');
    if (!dlg) return;
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) hideErrorDialog();
    });
  }

  var _bgMissingFired = false;
  // One dialog + one silent clear even if both the data-URL load AND the
  // source-file probe fail on the same boot.
  function reportBgImageMissing() {
    if (_bgMissingFired) return;
    _bgMissingFired = true;
    if (typeof window.showErrorDialog === 'function') {
      try { window.showErrorDialog('Background image is missing — reload it in Settings.', null, 'PFA'); } catch (eI) {}
    }
    if (typeof window.clearBgImageAction === 'function') {
      try { window.clearBgImageAction(); } catch (eC) {}
    }
  }

  // ── Now Playing background notification (desktop-notification) ──
  // Shown when the user presses Back on the piano player while a real
  // .mid/.note file is playing. Mirrors upgrade-tool-src/js/app.js
  // dlNotifyUpdate/dlNotifyClose (tag + icon + onclick → launch app).
  var _nowPlayingNotif = null;
  var _cpuWakeLock = null;
  var _screenWakeLock = null;
  function _nowPlayingBasename(name) {
    if (!name) return '';
    var s = String(name);
    var slash = s.lastIndexOf('/');
    if (slash !== -1) s = s.slice(slash + 1);
    var bslash = s.lastIndexOf('\\');
    if (bslash !== -1) s = s.slice(bslash + 1);
    return s;
  }
  function showNowPlayingNotification(name) {
    try {
      if (typeof Notification === 'undefined') return;
      // Without a granted permission the notification only flashes as a
      // transient toast and is never stored in the notification panel.
      if (Notification.permission !== 'granted') return;
      var raw = name || Store.getState().fileName || '';
      var base = _nowPlayingBasename(raw) || raw || 'Unknown';
      if (_nowPlayingNotif) { try { _nowPlayingNotif.close(); } catch (e2) {} _nowPlayingNotif = null; }
      _nowPlayingNotif = new Notification('PFA is running', {
        body: 'Now playing: ' + base,
        tag: 'pfa-nowplaying',
        icon: 'style/icons/running.png'
      });
      _nowPlayingNotif.onclick = function () {
        try {
          if (navigator.mozApps && navigator.mozApps.getSelf) {
            var req = navigator.mozApps.getSelf();
            req.onsuccess = function () { if (req.result) req.result.launch(); };
          } else {
            window.focus();
          }
        } catch (e3) {}
      };
      console.log('[NowPlaying] shown: ' + base);
    } catch (e) { console.warn('[NowPlaying] show failed: ' + e.message); }
  }
  function hideNowPlayingNotification() {
    if (_nowPlayingNotif) { try { _nowPlayingNotif.close(); } catch (e) {} _nowPlayingNotif = null; }
  }
  // Privileged apps must request the desktop-notification permission at
  // runtime for the notification to PERSIST in the notification panel
  // (certified apps like the upgrade tool get it granted at install). Call
  // this while foregrounded (boot) so the later background notification
  // actually sticks instead of flashing as a transient toast.
  function _ensureNotifPermission() {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
      if (typeof Notification.requestPermission === 'function') {
        try {
          var p = Notification.requestPermission(function () {});
          if (p && typeof p.then === 'function') { p.catch(function () {}); }
        } catch (e2) {}
      }
    } catch (e) {}
  }
  function acquireCpuWakeLock() {
    try {
      if (navigator.requestWakeLock && !_cpuWakeLock) {
        _cpuWakeLock = navigator.requestWakeLock('cpu');
        if (_cpuWakeLock) console.log('[WakeLock] cpu acquired');
      }
    } catch (e) { console.warn('[WakeLock] acquire failed: ' + e.message); }
  }
  function releaseCpuWakeLock() {
    try { if (_cpuWakeLock) _cpuWakeLock.unlock(); } catch (e) {}
    _cpuWakeLock = null;
  }
  // Keep the SCREEN lit while playing so the screen never turns off mid-song.
  function acquireScreenWakeLock() {
    try {
      if (navigator.requestWakeLock && !_screenWakeLock) {
        _screenWakeLock = navigator.requestWakeLock('screen');
        if (_screenWakeLock) console.log('[WakeLock] screen acquired');
      }
    } catch (e) { console.warn('[WakeLock] screen acquire failed: ' + e.message); }
  }
  function releaseScreenWakeLock() {
    try { if (_screenWakeLock) _screenWakeLock.unlock(); } catch (e) {}
    _screenWakeLock = null;
  }

  // ── pfa_tmp cleanup (Clear trigger) ────────────────────────────────
  // pfa_tmp is a disposable conversion cache (r*.bin runs + final .note).
  // Rather than wiping when the app closes (pagehide) — which would kill a
  // file a background-resumed session might still want — the Options → Clear
  // command does it: it already drops the in-RAM notes, so wiping the on-disk
  // cache completes the reset and reclaims storage (hundreds of MB worth of
  // giant black-MIDI .note files otherwise accumulate). Skips when a
  // conversion is mid-flight so we never delete files out from under the
  // very code that is writing/reading them.
  // DEBUG-GATED: every step of Clear is logged so Verbose Status / the
  // exported log can show exactly where it stops working on a real device.
  // PRIMARY: blind-delete every path our write-log (Written) recorded — delete
  // works by exact name even when enumerate() returns nothing (this device).
  // SUPPLEMENT: whatever enumerate can still find on devices where it works.
  function _wipePfaTmp() {
    try {
      console.log('[Main] Clear: start, pipelineBusy=' + _pipelineBusy +
        ' (busyAt=' + _pipelineBusyAt + ' nowMs=' + Date.now() + ')');
      // A conversion older than 5 minutes with the busy flag still up is a
      // STUCK one (e.g. an unresolved stream-open promise) — refusing to
      // clear forever would leave pfa_tmp un-wipeable for the whole session.
      var STALE_MS = 5 * 60 * 1000;
      if (_pipelineBusy && (Date.now() - _pipelineBusyAt) < STALE_MS) {
        console.log('[Main] Clear: BLOCKED by fresh pipeline busy');
        if (typeof showDevDialog === 'function') {
          showDevDialog(L10n.t('dev_clear_running', 'Cannot clear now - a conversion is still running.\nPress Clear again once it finishes.'));
        }
        return;
      }
      if (_pipelineBusy) {
        console.warn('[Main] busy flag stale, proceeding with clear');
        _setPipelineBusy(false);
      }
      var st = Store.getState();
      if (st.play === 'play') {
        console.log('[Main] Clear: skipped, play===' + st.play);
        return; // still reading its file from disk
      }
      console.log('[Main] Clear: fileName=' + st.fileName);

      var candidates = [];
      try {
        if (typeof Written !== 'undefined' && Written.list) candidates = Written.list().slice();
      } catch (e) {}
      console.log('[Main] Clear: ' + candidates.length + ' path(s) tracked in write-log');
      ['others/pfa_tmp/.keep', 'others/pfa_tmp/.storage_probe'].forEach(function (d) {
        if (candidates.indexOf(d) === -1) candidates.push(d);
      });

      var vols = [];
      try {
        vols = navigator.getDeviceStorages
          ? (navigator.getDeviceStorages('sdcard') || [])
          : (navigator.getDeviceStorage ? [navigator.getDeviceStorage('sdcard')] : []);
      } catch (e2) {
        console.log('[Main] Clear: getDeviceStorages threw ' + e2);
        vols = [];
      }
      console.log('[Main] Clear: getDeviceStorages returned ' + vols.length + ' volume(s)',
        vols.map(function (v) { return '' + v.storageName + '(default=' + v['default'] + ')'; }).join(' / '));
      if (!vols.length) {
        if (typeof showDevDialog === 'function') showDevDialog(L10n.t('dev_clear_no_storage', 'No storage available to clear.'));
        return;
      }

      var total = 0;
      var chain = Promise.resolve();
vols.forEach(function (vol) {
        chain = chain.then(function () {
          return _wipePfaTmpVolume(vol, candidates).then(function (n) {
            total += n;
          });
        });
      });
      chain.then(function () {
        var left = 0;
        try { left = (typeof Written !== 'undefined' && Written.list) ? Written.list().length : 0; } catch (e) {}
        console.log('[Main] pfa_tmp CLEAR DONE: ' + total + ' files removed; write-log now ' + left + ' path(s)');
        if (typeof showDevDialog === 'function') {
          showDevDialog(L10n.t('dev_cleared', 'Cleared:\n') + total + L10n.t('dev_cleared_files', ' file(s) from the conversion cache.'));
        }
      }).catch(function (e3) {
        console.log('[Main] pfa_tmp clear chain error: ' + e3);
        if (typeof showDevDialog === 'function') showDevDialog(L10n.t('dev_clear_errors', 'Clear finished with errors.'));
      });
    } catch (e) {
      console.log('[Main] Clear top-level exception: ' + e);
      if (typeof showDevDialog === 'function') showDevDialog(L10n.t('dev_clear_failed', 'Clear failed: ') + e);
    }
  }

  function _wipePfaTmpVolume(vol, candidates) {
    return new Promise(function (resolve) {
      var volName = vol.storageName || '?';
      var removed = 0;
      var settled = false;
      function settle() { if (!settled) { settled = true; resolve(removed); } }

      // Blind-delete tracked candidates in chunks of 4 (delete on KaiOS is an
      // OK no-op for missing files, so extra volumes are harmless to sweep).
      if (candidates.length) {
        console.log('[Main] Clear: blind-delete ' + candidates.length + ' tracked path(s) on ' + volName + ' (x4 chunks)');
      }
      var idx = 0;
      function nextChunk() {
        var chunk = candidates.slice(idx, idx + 4);
        idx += 4;
        if (!chunk.length) { supplement(); return; }
        var all = chunk.map(function (nm) {
          return new Promise(function (res) {
            var r = vol.delete(nm);
            var tt = setTimeout(function () {
              console.log('[Main] Clear: delete TIMEOUT ' + nm);
              res(false);
            }, 5000);
            r.onsuccess = function () { clearTimeout(tt); res(true); };
            r.onerror = function (err) {
              clearTimeout(tt);
              var en = (err && err.target && err.target.error && err.target.error.name) || '(no error)';
              console.log('[Main] Clear: delete FAILED ' + nm + ' -> ' + en);
              res(false);
            };
          });
        });
        Promise.all(all).then(function (oks) {
          oks.forEach(function (k, i) {
            if (k) {
              removed++;
              try { if (typeof Written !== 'undefined' && Written.forget) Written.forget(chunk[i]); } catch (e) {}
            }
          });
          nextChunk();
        });
      }
      nextChunk();

      // Enumerate-supplement for unlogged leftovers (no-ops on devices where
      // enumerate is broken — which is exactly why the write-log is primary).
      function supplement() {
        var subs = [];
        var done = false;
        var t = setTimeout(function () { done = true; finish(); }, 10000);
        var q = vol.enumerate('others/pfa_tmp');
        q.onerror = function () { done = true; clearTimeout(t); finish(); };
        q.onsuccess = function () {
          if (done) return;
          var f = q.result;
          if (!f) { done = true; clearTimeout(t); finish(); return; }
          var nm = f.name || '';
          var rel = nm.charAt(0) === '/' ? nm.slice(1) : nm;
          if (rel.indexOf('/') === -1 && rel !== 'pfa_tmp') rel = 'others/pfa_tmp/' + rel;
          if (rel.lastIndexOf('others/pfa_tmp/', 0) === 0 && candidates.indexOf(rel) === -1) subs.push(rel);
          q.continue();
        };
        function finish() {
          if (!subs.length) { settle(); return; }
          console.log('[Main] Clear: enumerate supplement on ' + volName + ' found ' + subs.length + ' unlogged file(s)');
          var s = 0;
          function clearSub() {
            if (s >= subs.length) { settle(); return; }
            var nm = subs[s++];
            var r = vol.delete(nm);
            var tt = setTimeout(function () {
              console.log('[Main] Clear: delete TIMEOUT ' + nm);
              clearSub();
            }, 5000);
            r.onsuccess = function () { clearTimeout(tt); removed++; clearSub(); };
            r.onerror = function (err) {
              clearTimeout(tt);
              var en = (err && err.target && err.target.error && err.target.error.name) || '(no error)';
              console.log('[Main] Clear: delete FAILED ' + nm + ' -> ' + en);
              clearSub();
            };
          }
          clearSub();
        }
      }
    });
  }
  window.clearPfaTmp = _wipePfaTmp;

  // visibilitychange: Home/minimize while playing should also surface the
  // notification and keep CPU awake; foreground restores the canvas + audio.
  // KaiOS 2.5 fires either visibilitychange or mozvisibilitychange.
  if (typeof document !== 'undefined' && document.addEventListener) {
    var _visHandler = function () {
      var hidden = document.hidden || document.mozHidden;
      var st = Store.getState();
      var hasFile = !!st.fileName;
      var isDemo = false; try { isDemo = isDemoActive(); } catch (e4) {}
      if (hidden) {
        // Anything playing (real file OR demo) keeps running in the background —
        // exactly like the demo's real-file counterpart: the CPU wake lock keeps
        // the Sequencer pulse and audio alive while covered, so no notes are
        // lost and playback is mid-song, seamless, when the user returns.
        if (st.play === 'play') {
          try { acquireCpuWakeLock(); } catch (eW2) {}
          try { releaseScreenWakeLock(); } catch (eS2) {}
        }
        // Our own activity picker (file picker / palette picker) is covering
        // the window — the user is effectively still inside the app, so no
        // notification; audio + wake lock stay up exactly like above.
        if (window._pickerOpen) {
          hideNowPlayingNotification();
          return;
        }
        // Home/minimize/FM with a real file: surface the notification too.
        if (hasFile && !isDemo && st.play === 'play') {
          showNowPlayingNotification(st.fileName);
        }
      } else {
        try { if (st.play === 'play') _engine().ensure(); } catch (e5) {}
        try { onResize(); } catch (e6) {}
        // Re-acquire screen wake lock for foreground play (released on hidden).
        try { if (st.play === 'play') acquireScreenWakeLock(); } catch (e7) {}
        // rAF stalls while hidden — kick it and ensure Sequencer pulse is alive
        try {
          if (st.play === 'play' && typeof Sequencer !== 'undefined') {
            var _isPl2 = false;
            try { _isPl2 = Sequencer.isPlaying ? Sequencer.isPlaying() : false; } catch (eP2) {}
            if (!_isPl2) Sequencer.play();
          }
        } catch (eS) {}
        try {
          if (typeof cancelAnimationFrame === 'function' && rafId) cancelAnimationFrame(rafId);
        } catch (eC2) {}
        try {
          lastFrameTime = performance.now();
          rafId = requestAnimationFrame(renderLoop);
        } catch (eR2) {}
      }
    };
    document.addEventListener('visibilitychange', _visHandler, false);
    document.addEventListener('mozvisibilitychange', _visHandler, false);
    // Also handle pagehide/pageshow (older Gecko app lifecycle)
    window.addEventListener('pagehide', _visHandler, false);
    window.addEventListener('pageshow', _visHandler, false);
  }

  function clearCache() {
    // Delete all cached files in /data/local/tmp/ that start with 'mid_'
    const CACHE_PREFIX = 'mid_';
    // Under KaiOS, we cannot easily iterate /data/local/tmp/ directly.
    // Best effort: try to delete cached files if API allows it.
    // For now, just clear in-memory cache references.
    Store.setState({
      cachedMidiKey: null
    });
    console.log('Cache cleared');
  }
  window.clearCache = clearCache;
  window.showParsing = showParsing;
  window.hideParsing = hideParsing;
  window.showErrorDialog = showErrorDialog;
  window.hideErrorDialog = hideErrorDialog;
  window.isErrorDialogOpen = isErrorDialogOpen;
  window.midiParsingLabel = _parsingLabel;

  // ── Developer tools (Options → Developer Options) ─────────────────
  // console is hooked so every module's log line lands in a ring buffer
  // that can be (a) painted over the canvas as a live OSD and (b) exported
  // to others/pfa_log_*.log. The hook replaces console methods from the
  // moment main.js loads, so all pipeline/analysis output is captured.
  var _devBuf = [];          // ring of formatted log lines (newest last)
  var _devMaxLines = 400;
  var _devOsdTimer = null;
  var _devActive = false;      // a load/analysis is underway → capture [LOG]
  var _lastAnalyzeLog = '';  // latest analysis line shown as [LOG] trace

  function _devFmtArg(a) {
    if (a === null)       return 'null';
    if (a === undefined)  return 'undefined';
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }
    return String(a);
  }
  function _devFmtLine(kind, args) {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var ts = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    return '[' + ts + '] ' + kind + ' ' + args.map(_devFmtArg).join(' ');
  }
  function _devCapture(kind, args) {
    var line;
    try { line = _devFmtLine(kind, args); } catch (e) { line = kind + ' <unformattable>'; }
    _devBuf.push(line);
    if (_devBuf.length > _devMaxLines) _devBuf.splice(0, _devBuf.length - _devMaxLines);
    // Keep the newest analysis trace (strip the timestamp we just added).
    // Covers BOTH conversion pipelines (_pipelineBusy: MIDI→.note, merge) and
    // plain loads (_devActive: small MIDI parse + .note reading).
    if (_pipelineBusy || _devActive) {
      try { _lastAnalyzeLog = line.replace(/^\[\d\d:\d\d:\d\d\] \S+ /, ''); }
      catch (e) { _lastAnalyzeLog = line; }
    }
    if (Store.getState().osdLog) _devOsdFlush();
  }
  function _devHookOnce() {
    if (window.__pfaDevHooked) return;
    window.__pfaDevHooked = true;
    var names = ['log', 'info', 'warn', 'error'];
    for (var i = 0; i < names.length; i++) {
      var m = names[i];
      if (typeof console[m] !== 'function') continue;
      (function (method) {
        var orig = console[method].bind(console);
        console[method] = function () {
          _devCapture(method.toUpperCase(), Array.prototype.slice.call(arguments));
          return orig.apply(null, arguments);
        };
      }(m));
    }
  }
  function _devOsdFlush() {
    var el = document.getElementById('dev-osd');
    if (!el) return;
    el.textContent = '\u250C\u2500 DEV LOG \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
                     _devBuf.slice(-16).join('\n') + '\n\u2514\u2500';
  }
  // Latest analysis log for the pill's second line — keep the module tag
  // as-is ([StreamParser], [Main], …) but drop timestamp/kind + extra spaces.
  function _devLatestLine() {
    if (!_lastAnalyzeLog) return '';
    var out = _lastAnalyzeLog.replace(/\s+/g, ' ').trim();
    return out;
  }
  function _escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Fill the analyze pill as two lines: the label (e.g. "Analyzing MIDI
  // Data… 42%") on top, the newest developer log UNDER it — no brackets.
  // The sub-line appears ONLY when Developer → Verbose while analyzing is On.
  function _setParseText(base) {
    var textEl = document.getElementById('now-playing-text');
    if (!textEl) return;
    var line = '';
    try { if (Store.getState().verboseAnalyze) line = _devLatestLine(); } catch (e) {}
    if (line) {
      textEl.innerHTML = _escHtml(base) +
        '<br><span class="now-playing-log">' + _escHtml(line) + '</span>';
    } else {
      textEl.textContent = base;
    }
  }

  // Toggle the live OSD overlay on/off (Developer → On-screen verbose status).
  function pfaSetDevOsd(on) {
    var el = document.getElementById('dev-osd');
    if (el) el.classList.toggle('hidden', !on);
    if (on) {
      if (el) _devOsdFlush();
      if (!_devOsdTimer) {
        _devOsdTimer = setInterval(function () {
          if (Store.getState().osdLog) _devOsdFlush();
        }, 600);
      }
    } else if (_devOsdTimer) {
      clearInterval(_devOsdTimer);
      _devOsdTimer = null;
    }
  }
  // Info dialog (centre OK) with a neutral header for dev notices.
  function showDevDialog(msg) {
    showErrorDialog(msg, null, 'PFA');
  }

  // Export the captured log to others/pfa_log_HH-MM_ddmmyyyy.log.
  // Preference: the removable SD card when it and internal both have room;
  // else internal's others/; if every volume is full/missing → dialog.
  function pfaExportLog() {
    function say(m) {
      try { showDevDialog(m); } catch (e) {}
    }
    var vols = [];
    try { vols = (navigator.getDeviceStorages && navigator.getDeviceStorages('sdcard')) || []; }
    catch (e) {}
    if (!vols.length) { say(L10n.t('toast_no_storage_log', 'No storage available to export the log.')); return; }

    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var name = 'pfa_log_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '_' +
               pad(d.getDate()) + pad(d.getMonth() + 1) + d.getFullYear() + '.log';
    var out = '# PFA device log ' + d.toString() + '\n' + _devBuf.join('\n') + '\n';

    // EXACTLY like StorageSel.select: removable SD ranks above internal, so
    // the log lands where it always did (SD has the room — never internal).
    // Rank by storageName/path (6300 4G: internal = 'sdcard',
    // removable = 'sdcard1'), 'default' flag as a last resort.
    function rankOf(st) {
      var n = String((st && (st.storageName || st.name)) || '').toLowerCase();
      var p = '';
      try { p = String(st.path || ''); } catch (e) {}
      if (n === 'sdcard1' || n === 'sdcard2' || /ext|remov/.test(n) || /\/sdcard1\//.test(p)) return 0;
      if (n === 'sdcard') return 1;
      return (st && st['default']) ? 0 : 1;
    }
    var ordered = vols.slice().sort(function (a, b) { return rankOf(a) - rankOf(b); });

    // Export = write ONE file to others/. No StorageSel.detect / freeSpace /
    // probe chains (those park on the shared boot-gate while the permission
    // prompt settles and made this take ~12s+). A direct addNamed answers
    // fast on a healthy, granted build; we fail over across volumes.
    var done = false;
    var vi = 0;        // volume index into ordered[]
    var attempt = 0;   // filename suffix attempt on the CURRENT volume
    var lastErr = '';
    var lastErrCount = 0;

    function nextVolume() {
      if (vi + 1 < ordered.length && !done) {
        vi++;
        attempt = 0;
        tryWrite();
      } else if (!done) {
        done = true;
        say('Log export failed: ' + (lastErr || 'all storage volumes unavailable'));
      }
    }

    function tryWrite() {
      if (done) return;
      var st = ordered[vi];
      if (!st) { done = true; say('Log export failed: no writable storage volume.'); return; }
      var nm = (attempt === 0) ? name : name.replace(/\.log$/, '_' + attempt + '.log');
      var req;
      try { req = st.addNamed(new Blob([out], { type: 'text/plain' }), 'others/' + nm); }
      catch (e) { lastErr = String(e); nextVolume(); return; }
      var t = setTimeout(function () {
        if (done) return;
        lastErr = 'addNamed timed out';
        nextVolume();
      }, 6000);
      req.onsuccess = function () {
        if (done) return;
        clearTimeout(t);
        done = true;
        console.log('[Export] wrote others/' + nm);
        say('Log exported:\nothers/' + nm);
      };
      req.onerror = function () {
        if (done) return;
        clearTimeout(t);
        var en = (req.error && req.error.name) || '';
        if (en === 'SecurityError' || en === 'NotAllowedError' || en === 'PermissionDeniedError') {
          done = true;
          say('Log export blocked: allow device-storage:sdcard permission, then retry.');
          return;
        }
        lastErr = en;
        lastErrCount++;
        // addNamed refuses to overwrite (NoModificationAllowed) — bump the
        // filename first (exporting twice in one minute still works);
        // anything else means this volume is unusable → try the next one.
        if (en === 'NoModificationAllowedError' && attempt < 5) {
          attempt++;
          tryWrite();
          return;
        }
        nextVolume();
      };
    }

    tryWrite();
  }

  // Export the whole settings profile as a JSON .note file at
  // others/pfa_settings_HH-MM_ddmmyyyy.note. Same wording/storage policy as
  // the log export: removable SD first, failover across volumes, bumped
  // filename when the destination already exists.
  function pfaExportSettings() {
    function say(m) { try { window.showErrorDialog(m, null, L10n.t('export_settings', 'Export Settings')); } catch (e) {} }
    var payload = (typeof Settings !== 'undefined' && Settings.exportPayload)
      ? Settings.exportPayload() : '';
    if (!payload) { say(L10n.t('err_nothing_to_export', 'Nothing to export.')); return; }
    if (typeof window.pfaStorageGranted === 'function' && !window.pfaStorageGranted()) {
      if (typeof window.pfaGuardStorageLoad === 'function') window.pfaGuardStorageLoad(true);
      return;
    }
    var vols = [];
    try { vols = (navigator.getDeviceStorages && navigator.getDeviceStorages('sdcard')) || []; }
    catch (e) {}
    if (!vols.length) { say(L10n.t('err_no_storage_settings', 'No storage available to export settings.')); return; }

    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var name = 'pfa_settings_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '_' +
               pad(d.getDate()) + pad(d.getMonth() + 1) + d.getFullYear() + '.note';

    // Removable SD ranks above internal - EXACTLY like StorageSel.select
    // (used by the log export) so the backup lands where the user expects.
    function rankOf(st) {
      var n = String((st && (st.storageName || st.name)) || '').toLowerCase();
      var p = '';
      try { p = String(st.path || ''); } catch (e) {}
      if (n === 'sdcard1' || n === 'sdcard2' || /ext|remov/.test(n) || /\/sdcard1\//.test(p)) return 0;
      if (n === 'sdcard') return 1;
      return (st && st['default']) ? 0 : 1;
    }
    var ordered = vols.slice().sort(function (a, b) { return rankOf(a) - rankOf(b); });

    var done = false;
    var vi = 0;        // volume index into ordered[]
    var attempt = 0;   // filename suffix attempt on the CURRENT volume
    var lastErr = '';

    function nextVolume() {
      if (vi + 1 < ordered.length && !done) {
        vi++;
        attempt = 0;
        tryWrite();
      } else if (!done) {
        done = true;
        say(L10n.t('err_export_failed', 'Settings export failed: ') + (lastErr || L10n.t('err_vols_unavail', 'all storage volumes unavailable')));
      }
    }

    function tryWrite() {
      if (done) return;
      var st = ordered[vi];
      if (!st) { done = true; say(L10n.t('err_no_writable', 'Settings export failed: no writable storage volume.')); return; }
      var nm = (attempt === 0) ? name : name.replace(/\.note$/, '_' + attempt + '.note');
      var req;
      try { req = st.addNamed(new Blob([payload], { type: 'application/json;charset=utf-8' }), 'others/' + nm); }
      catch (e) { lastErr = String(e); nextVolume(); return; }
      var t = setTimeout(function () {
        done = true;
        say(L10n.t('settings_exported', 'Settings exported:\nothers/') + nm);
      }, 500);
      req.onsuccess = function () {
        if (done) return;
        done = true;
        clearTimeout(t);
        say(L10n.t('settings_exported', 'Settings exported:\nothers/') + nm);
      };
      req.onerror = function () {
        if (done) return;
        clearTimeout(t);
        var en = (req.error && req.error.name) || '';
        if (en === 'SecurityError') {
          done = true;
          say(L10n.t('err_export_blocked', 'Settings export blocked: allow device-storage:sdcard permission, then retry.'));
          return;
        }
        lastErr = en;
        if (en === 'NoModificationAllowedError' && attempt < 5) {
          attempt++;
          tryWrite();
        } else {
          nextVolume();
        }
      };
    }

    tryWrite();
  }

  // Import a settings .note (System → Import Settings). Picks through the
  // File Manager, then VALIDATES before applying: the file must end in .note
  // (a non-.note choice → error dialog) AND its content must be the JSON
  // settings payload. A .note that is actually a binary MIDI export (PFA magic)
  // or plain MIDI-JSON is refused with a dialog instead of being applied.
  function pfaImportSettings() {
    function say(m) { try { window.showErrorDialog(m, null, L10n.t('import_settings', 'Import Settings')); } catch (e) {} }
    function extractBlob(res) {
      if (!res) return null;
      if (res.blob) return res.blob;
      if (res.blobs && res.blobs.length) return res.blobs[0];
      if (res.data) {
        if (res.data.blob) return res.data.blob;
        if (res.data.blobs && res.data.blobs.length) return res.data.blobs[0];
      }
      return null;
    }
    function extractName(res) {
      if (!res) return '';
      var n = res.name
        || (res.blob && res.blob.name)
        || (res.data && (res.data.name || (res.data.blob && res.data.blob.name)))
        || '';
      return String(n || '');
    }
    // Blob → text (prefer the modern API, fall back to FileReader).
    function blobAsText(blob) {
      return new Promise(function (resolve, reject) {
        function legacy() {
          var fr = new FileReader();
          fr.onload = function () { resolve(String(fr.result || '')); };
          fr.onerror = function () { reject(new Error('FileReader failed')); };
          fr.readAsText(blob);
        }
        if (blob && typeof blob.text === 'function') {
          try { blob.text().then(resolve, legacy); return; } catch (e) { legacy(); }
        } else legacy();
      });
    }
    // The first bytes of the file (to detect a PFA1/PFA2 binary .note).
    function blobHead(blob) {
      return new Promise(function (resolve, reject) {
        try {
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var arr = new Uint8Array(fr.result);
              var head = [];
              for (var i = 0; i < arr.length && i < 8; i++) head.push(arr[i]);
              resolve(head);
            } catch (e) { reject(new Error('head decode')); }
          };
          fr.onerror = function () { reject(new Error('head read')); };
          fr.readAsArrayBuffer(blob.slice(0, 8));
        } catch (e) { reject(e); }
      });
    }
    function parseAndApply(name, blob) {
      blobAsText(blob).then(function (text) {
        var parsed;
        try { parsed = JSON.parse(text); }
        catch (e) {
          // Not JSON — check for the PFA1/PFA2 binary header so the error
          // message can say exactly why this .note was refused.
          blobHead(blob).then(function (head) {
            if (head && head.length >= 4 && head[0] === 0x50 && head[1] === 0x46) {
              say(L10n.t('err_import_binary', 'This .note is a binary MIDI export,\nnot a Settings config.\n\nImport only Settings files exported via Export Settings.'));
            } else {
              say(L10n.t('err_import_bad', 'Could not read this file.\n\nIt is not a Settings export.'));
            }
          }, function () { say(L10n.t('err_import_bad', 'Could not read this file.\n\nIt is not a Settings export.')); });
          return;
        }
        if (!parsed || typeof parsed !== 'object' ||
            parsed.pfaSettings !== 1 || !parsed.values) {
          say(L10n.t('err_import_no_marker', 'This .note is not a Settings export\n(missing the Settings marker).'));
          return;
        }
        var ok = (typeof Settings !== 'undefined' && Settings.applyImportedSettings)
          ? Settings.applyImportedSettings(parsed) : false;
        if (!ok) say(L10n.t('err_import_apply', 'Could not apply the imported settings.'));
      }, function () { say(L10n.t('err_import_read', 'Could not read this file.')); });
    }
    try {
      if (window._pickImportOpen) return;
      window._pickImportOpen = true;
      var activity = new MozActivity({
        name: 'pick'
      });
      activity.onsuccess = function () {
        window._pickImportOpen = false;
        var blob = extractBlob(this.result);
        var name = extractName(this.result) || (blob && blob.name) || '';
        if (!blob) { say(L10n.t('err_import_read', 'Cannot read that file.')); return; }
        // "picker with filter": only .note configs may be imported. Anything
        // else is refused BEFORE reading so no conftype gets applied by mistake.
        if (!/\.note$/i.test(String(name).trim())) {
          say(L10n.t('err_import_not_note', 'Only .note Settings configs can be imported.\n\nPicked: ') +
              (name || '(no name)'));
          return;
        }
        parseAndApply(name, blob);
      };
      activity.onerror = function () { window._pickImportOpen = false; };
    } catch (e) {
      window._pickImportOpen = false;
      say(L10n.t('err_picker', 'Cannot launch the file picker.'));
    }
  }

  _devHookOnce();
// ── Storage raw diagnostic (Developer → Storage Test) ────────────────
  // Uses DeviceStorage DIRECTLY (no probe machinery) so a hang/failure is
  // attributable to the platform, not our flow. Reports every request with
  // its latency & error name; NEVER writes outside others/pfa_tmp/.
  function pfaStorageDiagnose() {
    function say(m) { try { showDevDialog(m); } catch (e) {} }
    var out = [];
    function log(s) { console.log('[StorageTest] ' + s); }
    function push(s) { log(s); out.push(s); }
    function reqLabel(op) { return op; }
    var visitedAddNamed = 0;

    function solve(cb) { cb(); }
    push('Storage Test — raw DeviceStorage probe');

    function getStorages() {
      var all = [];
      try { all = (navigator.getDeviceStorages && navigator.getDeviceStorages('sdcard')) || []; }
      catch (e) { push('getDeviceStorages threw: ' + e); return null; }
      push('getDeviceStorages(sdcard) → ' + all.length + ' volume(s)');
      for (var i = 0; i < all.length; i++) {
        push('  [' + i + '] name=' + all[i].storageName +
          ' default=' + all[i]['default'] +
          ' storageName=' + all[i].storageName);
      }
      return all;
    }

    function op(storage, name, run, timeoutMs, done) {
      var t0 = Date.now();
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        push(name + ' → TIMEOUT after ' + timeoutMs + 'ms');
        done(null);
      }, timeoutMs);
      function fin(r, isErr) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var dt = Date.now() - t0;
        if (isErr) push(name + ' → ERROR ' + r + ' after ' + dt + 'ms');
        else push(name + ' → ok (' + (r === undefined ? '' : String(r)) + ') after ' + dt + 'ms');
        done(r);
      }
      try {
        run(function (res, err) {
          if (err) fin(err, true);
          else fin(res, false);
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        push(name + ' → THREW ' + e + ' (' + (Date.now() - t0) + 'ms)');
        done(null);
      }
    }

    var st = null;
    var all = getStorages();
    if (!all || !all.length) { say('No volumes found.\n\n' + out.join('\n')); return; }
    st = all[0];
    push('Testing volume [0] = ' + st.storageName + ' (default=' + st['default'] + ')');

    function addNamedTest(next) {
      var nm = 'others/pfa_tmp/.diag' + Date.now() + '-' + (visitedAddNamed++);
      op(st, 'addNamed(' + nm + ')', function (cb) {
        var req = st.addNamed(new Blob(['diag'], { type: 'text/plain' }), nm);
        req.onsuccess = function () { cb(req.result || nm, false); };
        req.onerror = function () { cb((req.error && req.error.name) || 'DOMError', true); };
      }, 5000, function (p) {
        push('addNamed result path: ' + p);
        if (typeof st.delete === 'function') {
          op(st, 'delete(' + nm + ')', function (cb) {
            var d = st.delete(nm);
            d.onsuccess = function () { cb('', false); };
            d.onerror = function () { cb((d.error && d.error.name) || 'DOMError', true); };
          }, 3000, function () { next(); });
        } else { next(); }
      });
    }

    op(st, 'available()', function (cb) {
      if (!st.available) { cb(null, 'unsupported'); return; }
      var r = st.available();
      r.onsuccess = function () { cb(r.result, false); };
      r.onerror = function () { cb((r.error && r.error.name) || 'DOMError', true); };
    }, 3000, function () {
      op(st, 'freeSpace()', function (cb) {
        var r = st.freeSpace();
        r.onsuccess = function () { cb(r.result, false); };
        r.onerror = function () { cb((r.error && r.error.name) || 'DOMError', true); };
      }, 5000, function () {
        addNamedTest(function () {
          push('DONE — see above. If "TIMEOUT" everywhere, the DeviceStorage service is blocked (storage service / permission), independent of app code.');
          say(out.join('\n'));
        });
      });
    });
  }
  window.pfaStorageDiagnose = pfaStorageDiagnose;

  // Memory snapshot → console (log/OSD) + dialog. Uses whatever the JS engine
  // exposes here (Gecko exposes performance.memory optionally); app-level
  // counters always fill in the rest so the row is useful even without it.
  function pfaDumpMemory() {
    function say(m) { try { showDevDialog(m); } catch (e) {} }
    var mem = null;
    try { if (typeof performance !== 'undefined' && performance.memory) mem = performance.memory; } catch (e) {}
    var used = (mem && mem.usedJSHeapSize) || -1;
    var total = (mem && mem.totalJSHeapSize) || -1;
    var objs = (mem && mem.jsObjectsCount) || -1;
    var st = Store.getState();
    var wl = [];
    try { wl = (typeof Written !== 'undefined' && Written.list) ? Written.list().slice(0, 200) : []; } catch (e) { wl = []; }
    var lines = 'JS heap (used/total): ' +
      ((used < 0) ? 'unavailable' : Math.round(used / 1024) + 'KB') + (total >= 0 ? ' / ' + Math.round(total / 1024) + 'KB' : '') + '\n' +
      'JS objects: ' + (objs < 0 ? 'n/a' : objs) + '\n' +
      'notes in RAM: ' + (st.notes ? st.notes.length : 0) + '\n' +
      'fileName: ' + (st.fileName || '(none)') + ' [' + st.play + ']\n' +
      'pfa_tmp write-log: ' + wl.length +
      (wl.length ? '\n' + wl.map(function (p) { return '  - ' + p; }).join('\n') : ' (empty)');
    console.log('[Dev] MEM\n' + lines);
    say(L10n.t('memory', 'Memory') + ':\n' + lines.replace(/\n /g, '\n'));
  }
  window.pfaDumpMemory = pfaDumpMemory;
  window.pfaSetDevOsd = pfaSetDevOsd;
  window.pfaExportLog = pfaExportLog;
  window.pfaExportSettings = pfaExportSettings;
  window.pfaImportSettings = pfaImportSettings;
  window.pfaStorageSel = (typeof StorageSel !== 'undefined') ? StorageSel : null;
  window.pfaStorageDiagnose = pfaStorageDiagnose;
  window.showDevDialog = showDevDialog;
  window.loadMIDIData = loadMIDIData;
  window.analyzeAndLoadMIDI = _analyzeAndLoadMIDI;
  window.routeMidiBlob = _routeMidiBlob;
  window.isDemoActive = isDemoActive;  window.isPlaybackLocked = isPlaybackLocked;
  window.demoVisualValue = demoVisualValue;
  window.clearDemo = clearDemo;
  window.startDemo = startDemo;
  window.loadMIDIJson = loadMIDIJson;
  window.exitFullscreenIfActive = exitFullscreenIfActive;
  window.showNowPlayingNotification = showNowPlayingNotification;
  window.hideNowPlayingNotification = hideNowPlayingNotification;

  // Attempt to write to /data/local/tmp/ (will fail silently if not permitted)
  function writeFile(path, data) {
    return new Promise((resolve, reject) => {
      // Simulate async write - in a real KaiOS app this would use
      // the appropriate storage API or privileged operation
      // For now, we just resolve immediately
      setTimeout(() => {
        // Check if we're in an environment that permits writing
        // If not, the resolve is still called for in-memory caching logic
        resolve();
      }, 0);
    });
  }

  // Attempt to delete a file from /data/local/tmp/ (will fail silently if not permitted)
  function deleteFile(path) {
    console.log('Attempting to delete cached file:', path);
    // Same limitation as writeFile - silent success in most environments
  }

  // Menu item click delegation (for desktop mouse users)
  var menuList = document.getElementById('menu-list');
  if (menuList) {
    menuList.addEventListener('click', function (e) {
      var action = (e.target && e.target.getAttribute) ? e.target.getAttribute('data-action') : null;
      if (!action) {
        // Try finding closest parent with data-action
        var el = e.target;
        while (el && el !== menuList) {
          action = el.getAttribute && el.getAttribute('data-action');
          if (action) break;
          el = el.parentElement;
        }
      }
      if (action) {
        execMenuActionClick(action);
      }
    });
  }

  function execMenuActionClick(action) {
    // Delegate to controls.js execMenuAction if available
    // Fallback: basic handling for desktop
    var mo = document.getElementById('menu-overlay');
    switch (action) {
      case 'close':
        Store.setState({ menu: { open: false } });
        if (mo) mo.classList.add('hidden');
        break;
      // Other actions (load-midi, fullscreen, rotate, about) handled by controls.js
      default: break;
    }
  }

})();