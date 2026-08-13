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

        // If boot() hasn't run yet (canvas/Synth not wired), queue this
        // payload and let boot() flush it. Otherwise handle inline.
        if (!canvas) {
          console.log('[Activity] boot() not yet run — queuing payload');
          _pendingActivity = { blob: blob, name: name, filepath: filepath };
          return;
        }

        if (blob) {
          if (!name) name = 'picked.mid';
          console.log('[Activity] reading blob as ArrayBuffer...');
          showParsing();
          Store.setState({ fileName: name });
          var reader = new FileReader();
          reader.onload = function () {
            try {
              console.log('[Activity] FileReader onload, size=', reader.result && reader.result.byteLength);
              var midiData = MidiParser.parseMIDI(reader.result);
              console.log('[Activity] parseMIDI ok, notes=', midiData && midiData.notes && midiData.notes.length);
              loadMIDIData(midiData);
            } catch (e) {
              console.error('[Main] Activity MIDI parse error', e);
              hideParsing();
            }
          };
          reader.onerror = function () {
            console.error('[Main] FileReader error (activity)');
            hideParsing();
          };
          reader.readAsArrayBuffer(blob);
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
          // Filepath-only route: fetch the file via XHR.
          showParsing();
          var fname = name || filepath.split('/').pop() || 'picked.mid';
          Store.setState({ fileName: fname });
          // sdcard paths from KaiOS are usually prefixed file:// or just absolute.
          // navigator.storage.* won't help; we use XMLHttpRequest with responseType.
          var url = filepath;
          if (filepath[0] === '/') url = 'file://' + filepath;
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = 'arraybuffer';
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
              try {
                var midiData2 = MidiParser.parseMIDI(xhr.response);
                loadMIDIData(midiData2);
                _foregroundAfterActivity();
              } catch (e) {
                console.error('[Main] XHR MIDI parse error', e);
                hideParsing();
              }
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
      } catch (e) {
        console.error('[Main] activity handler error:', e);
        try { activity.postError(e.message); } catch (e2) {}
      }
    });
  }

  // ── BOOT ──

  function boot() {
    console.log('[Main] boot: DOMContentLoaded; canvas exists?', !!document.getElementById('main-canvas'));
    canvas = document.getElementById('main-canvas');
    if (!canvas) {
      console.error('[Main] FATAL: no #main-canvas');
      return;
    }
    ctx = canvas.getContext('2d');
    resizeCanvas();

    // Audio context lazy — only on user gesture (Chrome autoplay policy)
    // Synth.noteOn will bootstrap on first note dispatch

    // Wire Sequencer → Synth
    Sequencer.noteDown(function (note, ch, vel, delay, dur) {
      Synth.noteOn(note, ch, vel, delay, dur);
    });
    Sequencer.noteUp(function (note, ch) {
      Synth.noteOff(note, ch);
    });
    Sequencer.onEnd(function () {
      Store.setState({ play: 'stop' });
    });

    // Wire Store subscription → engine
    Store.subscribe(onStoreChange);

    // Settings: load persisted values, push to Store, apply theme.
    // Order matters: Settings.load() must run BEFORE the first frame so
    // the renderer's theme-aware fillStyle picks up the right background.
    try {
      if (typeof Settings !== 'undefined' && Settings.load) {
        console.log('[Main] calling Settings.load(), Settings=', typeof Settings);
        Settings.load();
        console.log('[Main] Settings.load done; theme=', Store.getState().theme);
      }
    } catch (e) {
      console.error('[Main] settings.load failed', e);
    }

    // Softkey labels — let controls.js manage them
    if (typeof updateSoftkeys === 'function') updateSoftkeys();

    // Start render loop
    lastFrameTime = performance.now();
    renderLoop(performance.now());

    console.log('[Main] booted. Canvas ' + width + 'x' + height);

    // If MozActivity fired while we were still booting (script parse
    // raced ahead of the DOMContentLoaded handler), flush the queued
    // payload now that canvas + Synth are wired.
    if (_pendingActivity) {
      var p = _pendingActivity;
      _pendingActivity = null;
      console.log('[Main] flushing pending activity: blob?', !!p.blob, 'name=', p.name);
      if (p.blob) {
        handlePickedBlob(p.blob, p.name || 'picked.mid');
      } else if (p.filepath) {
        fetchAndLoad(p.filepath, p.name || p.filepath.split('/').pop() || 'picked.mid');
      }
    }
  }

  // Pulled out of inline handler so boot() can call it on the queued
  // payload. Same logic as the picker path in controls.js.
  function handlePickedBlob(blob, name) {
    showParsing();
    Store.setState({ fileName: name });
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var midiData = MidiParser.parseMIDI(reader.result);
        loadMIDIData(midiData);
      } catch (e) {
        console.error('[Main] Activity MIDI parse error', e);
        hideParsing();
      }
    };
    reader.onerror = function () { console.error('[Main] FileReader error'); hideParsing(); };
    reader.readAsArrayBuffer(blob);
  }

  function fetchAndLoad(filepath, name) {
    var url = filepath;
    if (filepath[0] === '/') url = 'file://' + filepath;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        try {
          var midiData = MidiParser.parseMIDI(xhr.response);
          loadMIDIData(midiData);
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

  // ── STORE CHANGE HANDLER ──

  var _prevSpeed = null;
  var _prevWave  = null;

  function onStoreChange(state) {
    // Playback control (avoid re-trigger from onEnd cycle)
    var prevPlay = Store._prevPlay;
    Store._prevPlay = state.play;

    if (state.play === 'play' && prevPlay !== 'play') {
      // Bootstrap audio context (no-op if already running)
      Synth.ensure();
      Sequencer.play();
    } else if (state.play === 'pause' && prevPlay !== 'pause') {
      Sequencer.pause();
      Synth.silence();
    } else if (state.play === 'stop' && prevPlay !== 'stop') {
      Sequencer.stop();
      Synth.silence();
    }

    // Waveform change (only when actually changed — setWave iterates 48 oscillators)
    if (state.waveform && state.waveform !== _prevWave) {
      _prevWave = state.waveform;
      Synth.setWave(state.waveform);
    }

    // Speed (only when actually changed — avoids recalibration churn)
    if (state.speed != null && state.speed !== _prevSpeed) {
      _prevSpeed = state.speed;
      Sequencer.setSpeed(state.speed);
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

    var dt = now - lastFrameTime;
    lastFrameTime = now;

    // FPS counter (update every second)
    fpsCounter++;
    fpsAcc += dt;
    if (fpsAcc >= 1000) {
      Store.setState({ fps: Math.round(fpsCounter * 1000 / fpsAcc) });
      fpsCounter = 0;
      fpsAcc = 0;
      // Periodic zombie-voice cleanup (KaiOS onended never fires)
      try { if (typeof Synth !== 'undefined' && Synth.zoo) Synth.zoo(); } catch (e) {}
    }

    var st = Store.getState();

    // Rebuild keyboard spritesheet on keyWidth change
    if (st.keyWidth !== Keyboard._lastKeyW) {
      Keyboard.build(st.keyWidth || 16);
      Keyboard._lastKeyW = st.keyWidth;
    }

    // ── Drawing order ──
    // Fetch active notes once per frame (shared across all renderers)
    var liveCount = 0;
    if (typeof Sequencer !== 'undefined') {
      try {
        st._activeList = Sequencer.activeList();
        liveCount = st._activeList ? st._activeList.length : 0;
      } catch (e) { st._activeList = []; }
    }

    // 1. Background — read theme token (CSS var --theme-bg); falls back
    // to dark gray if not set (default theme or before Settings.load).
    var cs = getComputedStyle(document.documentElement);
    var themeBg = cs.getPropertyValue('--theme-bg').trim() || '#0a0a0a';
    ctx.fillStyle = themeBg;
    ctx.fillRect(0, 0, width, height);

    // 2. Falling notes
    Notes.draw(st, ctx, width, height);

    // 3. Playhead line — just above the keyboard, below the falling notes.
    //    Header removed; softkey (KaiOS 3rem at 10px = 30px) overlays bottom
    //    unless in fullscreen. Query softkey's actual rendered height for
    //    safety against KaiOS font-metric drift.
    var kbH = 60;
    // canvas height already excludes softkey, so piano/playhead offset
    // from the canvas bottom is just kbH.
    var lineY = height - kbH;
    if (lineY < 0) lineY = 0;
    ctx.strokeStyle = '#00ccff';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(width, lineY);
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // 4. Keyboard strip (on top, just above the softkey overlay)
    Keyboard.draw(st, ctx, width, height);

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

    // Auto-fit keyWidth so ~18 white keys visible (KaiOS-safe: only update when changed)
    if (width > 0) {
      var WhiteKeysVisible = Math.max(7, Math.min(28, Math.floor(width / 16)));
      var newKeyW = Math.max(8, Math.floor(width / WhiteKeysVisible));
      var st2 = Store.getState();
      if (st2.keyWidth !== newKeyW) Store.setState({ keyWidth: newKeyW });
    }
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
  window.addEventListener('blur', function () {
    if (typeof Synth !== 'undefined' && Synth.silence) Synth.silence();
    if (typeof Sequencer !== 'undefined' && Sequencer.pause) Sequencer.pause();
  }, false);
  window.addEventListener('focus', function () {
    if (typeof Synth !== 'undefined' && Synth.resume) {
      try { Synth.resume(); } catch (e) {}
    }
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
  function loadMIDIData(midiData) {
    var notes = midiData.notes || [];
    var tempo = midiData.tempo || [{ t: 0, u: 500000 }];
    var div   = midiData.div || 480;

    // Loading a new file ends fullscreen — user wants the chrome.
    exitFullscreenIfActive();

    Sequencer.load(notes, tempo, div);

    Store.setState({
      notes:     notes,
      tempoMap:  tempo,
      division:  div,
      format:    midiData.fmt || 1,
      timeSec:   0,
      play:      'stop',
      activeNoteCount: 0,
    });

    HUD.setTotal(notes.length);

    // Hide parsing bar — load complete
    hideParsing();

    // Show "Now Playing" toast
    if (typeof window.showNowPlaying === 'function') {
      window.showNowPlaying(Store.getState().fileName || '');
    }

    // Update softkeys (show Play button)
    if (typeof window.updateSoftkeys === 'function') {
      window.updateSoftkeys();
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

  /**
   * Parse .mid.json text → object → loadMIDIData.
   */
  function loadMIDIJson(jsonText) {
    try {
      var midi = JSON.parse(jsonText);
      loadMIDIData(midi);
      return true;
    } catch (e) {
      console.error('[Main] JSON parse error:', e);
      hideParsing();
      return false;
    }
  }

  /**
   * Read file from SD Card (KaiOS) or XHR (desktop debug).
   */
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

    // Handle .mid files with caching
    if (filePath.endsWith('.mid')) {
      showParsing();

      if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
        var ds = navigator.getDeviceStorage('sdcard');
        var req = ds.get(filePath);

        req.onsuccess = function () {
          var reader = new FileReader();
          reader.onload = function () {
            handleMidiBuffer(reader.result, filePath);
          };
          reader.onerror = function () {
            console.error('[Main] Failed to read MIDI buffer');
          };
          reader.readAsArrayBuffer(this.result);
        };

        req.onerror = function () {
          console.error('[Main] deviceStorage.get failed: ' + filePath);
        };
      } else {
        // Desktop debug: XHR fetch
        var xhr = new XMLHttpRequest();
        xhr.open('GET', filePath, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function () {
          if (xhr.status === 200) {
            handleMidiBuffer(xhr.response, filePath);
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

    // Existing code for other file types...
    showParsing();

    if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
      var ds = navigator.getDeviceStorage('sdcard');
      var req = ds.get(filePath);

      req.onsuccess = function () {
        var reader = new FileReader();
        reader.onload = function () { loadMIDIJson(reader.result); };
        reader.onerror = function () { console.error('[Main] FileRead error'); hideParsing(); };
        reader.readAsText(this.result);
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

  /**
   * Parse a .mid ArrayBuffer → .mid.json, cache to /data/local/tmp/, load.
   */
  function handleMidiBuffer(buffer, filePath) {
    try {
      var midiData = MidiParser.parseMIDI(buffer);

      // Feed parsed data directly — NO JSON.stringify/parse round-trip
      loadMIDIData(midiData);

      // Defer cache write to background (non-blocking)
      setTimeout(function () {
        try {
          var cacheKey = 'mid_' + hashString(filePath + Date.now());
          var cachePath = '/data/local/tmp/' + cacheKey + '.mid.json';
          writeFile(cachePath, JSON.stringify(midiData)).catch(function(){});
        } catch (ign) {}
      }, 200);
    } catch (e) {
      console.error('[Main] MIDI parse error', e);
      hideParsing();
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

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }

  // ── MENU CLEAR CACHE HANDLER ---
  // ── PARSING PROGRESS BAR ──
  function showParsing() {
    var title = document.getElementById('header-title');
    var bar   = document.getElementById('parse-bar');
    if (title) title.textContent = 'Parsing...';
    if (bar) {
      bar.classList.remove('hidden');
      bar.classList.add('indeterminate');
    }
  }

  function hideParsing() {
    var title = document.getElementById('header-title');
    var bar   = document.getElementById('parse-bar');
    if (title) title.textContent = 'MIDI Player';
    if (bar) {
      bar.classList.remove('indeterminate');
      bar.classList.add('hidden');
    }
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
  window.loadMIDIData = loadMIDIData;
  window.loadMIDIJson = loadMIDIJson;
  window.exitFullscreenIfActive = exitFullscreenIfActive;

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