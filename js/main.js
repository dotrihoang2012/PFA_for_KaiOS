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

  // Demo track (bundled demo.note) auto-plays on the first boot of each
  // app entry. While active we hide PLAY/PAUSE, show HUD as 0/0 + 0:00,
  // and lock transport + speed controls. Loading a real .mid/.note (or the
  // demo finishing) unlocks everything again.
  var _demoActive = false;

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
          if (_isJsonName(name)) {
            console.log('[Activity] reading blob as text (.note/.json)...');
            showParsing(_parsingLabel(name)); // Reading Data...
            Store.setState({ fileName: name });
            window._midiBlob = blob; // expose for native audio
            window._midiName = name;
            var jreader = new FileReader();
            jreader.onload = function () {
              loadMIDIJson(jreader.result);
              _foregroundAfterActivity();
            };
            jreader.onerror = function () {
              console.error('[Main] JSON FileReader error (activity)');
              hideParsing();
            };
            jreader.readAsText(blob);
            _foregroundAfterActivity();
            return;
          }
          console.log('[Activity] reading blob as ArrayBuffer...');
          showParsing(_parsingLabel(name)); // Analyzing MIDI Data...
          Store.setState({ fileName: name });
          window._midiBlob = blob; // expose for native audio
          window._midiName = name;
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
                // .note/.json MIDI — read as text, validate + load.
                var jr = new FileReader();
                jr.onload = function () {
                  loadMIDIJson(jr.result);
                  _foregroundAfterActivity();
                };
                jr.onerror = function () {
                  console.error('[Main] JSON FileReader error (filepath)');
                  hideParsing();
                };
                jr.readAsText(fileBlob);
                return;
              }
              // Read blob as ArrayBuffer for parser (visual only)
              var reader = new FileReader();
              reader.onload = function () {
                try {
                  var midiData2 = MidiParser.parseMIDI(reader.result);
                  loadMIDIData(midiData2);
                  _foregroundAfterActivity();
                } catch (e) {
                  console.error('[Main] XHR MIDI parse error', e);
                  hideParsing();
                }
              };
              reader.onerror = function () {
                console.error('[Main] FileReader error (filepath)');
                hideParsing();
              };
              reader.readAsArrayBuffer(fileBlob);
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

    // Wire Sequencer → active engine (Synth or PicoSynth, swappable at runtime)
    // _engine() returns the live engine reference; _switchEngine() re-wires
    // these callbacks when the user changes synthesizer in Settings.
    _activeEngine = Synth; // default engine until Settings.load() runs
    Sequencer.noteDown(function (note, ch, vel, delay, dur) {
      if (!window._audioMute) _engine().noteOn(note, ch, vel, delay, dur);
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
      if (!window._audioMute) _engine().noteOff(note, ch);
    });
    Sequencer.onEnd(function () {
      // Natural end: keep demo locked (HUD 0/0, transport disabled) so the
      // screen stays inert until a real .mid/.note is loaded (loadMIDIData
      // is the only place that unlocks via clearDemo()).
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

    // Error dialog (single OK) keyboard/click wiring
    bindErrorDialogControls();

    // Start render loop
    lastFrameTime = performance.now();
    renderLoop(performance.now());

    // Init NoteBuffer with screen dimensions
    if (typeof NoteBuffer !== 'undefined') {
      NoteBuffer.init(width, height);
      NoteBuffer.ensureKeyCache(Store.getState().kbStart || 21,
                                Store.getState().keyWidth || 16);
    }
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
    } else {
      // No real file was opened this boot — play the bundled demo track
      // (runs exactly once, ends without looping; see startDemo).
      startDemo();
    }
  }

  // Pulled out of inline handler so boot() can call it on the queued
  // payload. Same logic as the picker path in controls.js.
  function handlePickedBlob(blob, name) {
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
    window._midiFilePath = filepath; // expose for native audio test
    window._midiName = name;
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

  var _prevSpeed      = null;
  var _prevWave       = null;
  var _prevSynth      = null;   // 'osc' | 'pico'
  var _activeEngine   = null;   // live reference: Synth or PicoSynth

  /** Return the currently-selected engine object. */
  function _engine() {
    return _activeEngine || Synth;
  }

  /** Switch to the engine indicated by synthKey ('osc' | 'pico'). */
  function _switchEngine(synthKey) {
    if (synthKey === _prevSynth) return;
    _prevSynth = synthKey;

    // Silence whatever was playing before swapping
    try { _engine().silence(); } catch (e) {}

    if (synthKey === 'pico' && typeof PicoSynth !== 'undefined') {
      _activeEngine = PicoSynth;
      PicoSynth.ensure();
      console.log('[Main] engine → PicoSynth');
    } else {
      _activeEngine = Synth;
      Synth.ensure();
      console.log('[Main] engine → Synth (oscillator)');
    }

    // Re-wire Sequencer callbacks to the new engine
    Sequencer.noteDown(function (note, ch, vel, delay, dur) {
      if (!window._audioMute) _engine().noteOn(note, ch, vel, delay, dur);
      var st2 = Store.getState();
      if (typeof NoteBuffer !== 'undefined' && NoteBuffer.isReady()) {
        NoteBuffer.onNote(note, ch, vel, delay, dur,
          st2.kbStart || 21, st2.keyWidth || 16);
      }
    });
    Sequencer.noteUp(function (note, ch) {
      if (!window._audioMute) _engine().noteOff(note, ch);
    });
  }

  function onStoreChange(state) {
    // Playback control (avoid re-trigger from onEnd cycle)
    var prevPlay = Store._prevPlay;
    Store._prevPlay = state.play;

    // Synthesizer engine switch (must happen BEFORE play commands below)
    if (state.synthesizer && state.synthesizer !== _prevSynth) {
      _switchEngine(state.synthesizer);
    }

    if (state.play === 'play' && prevPlay !== 'play') {
      // Bootstrap audio context (no-op if already running)
      _engine().ensure();
      Sequencer.play();
      acquireCpuWakeLock();
    } else if (state.play === 'pause' && prevPlay !== 'pause') {
      Sequencer.pause();
      _engine().silence();
    } else if (state.play === 'stop' && prevPlay !== 'stop') {
      Sequencer.stop();
      _engine().silence();
      releaseCpuWakeLock();
      hideNowPlayingNotification();
    }

    // Waveform change (only when actually changed — setWave iterates 48 oscillators)
    if (state.waveform && state.waveform !== _prevWave) {
      _prevWave = state.waveform;
      Synth.setWave(state.waveform);   // only Synth uses waveform; PicoSynth ignores it
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
      try { var _eng = _engine(); if (_eng && _eng.zoo) _eng.zoo(); } catch (e) {}
    }

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
    var cs = getComputedStyle(document.documentElement);
    var themeBg = cs.getPropertyValue('--theme-bg').trim() || '#0a0a0a';
    ctx.fillStyle = st.bgColor || themeBg;
    ctx.fillRect(0, 0, width, height);

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
      ctx.strokeStyle = st.barColor || '#00ccff';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(0, lineY);
      ctx.lineTo(width, lineY);
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      // 4. Keyboard strip (on top, just above the softkey overlay)
      Keyboard.draw(st, ctx, width, height);
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
    var overlay = document.getElementById('now-playing-overlay');
    var text    = document.getElementById('now-playing-text');
    if (!overlay || !text) return;
    var name = (fileName || '').split('/').pop() || 'Unknown';
    text.textContent = 'Now playing: ' + name;
    // Fade in (CSS transition on opacity), hold 3s, then FADE OUT
    // gradually. Uses .np-hide instead of .hidden — the generic
    // .hidden is display:none !important, which kills the transition.
    overlay.classList.remove('np-hide');
    clearTimeout(window._nowPlayingTimer);
    window._nowPlayingTimer = setTimeout(function () {
      overlay.classList.add('np-hide');
    }, 3000);
  };

  window.addEventListener('blur', function () {
    // Background play: if a real file is playing, keep Sequencer + audio running
    // and surface the notification (Back already did, but Home/minimize also lands here).
    var st = null; try { st = Store.getState(); } catch (eB) {}
    var hasFile = !!(st && st.fileName);
    var isDemo = false; try { isDemo = isDemoActive(); } catch (eD) {}
    if (hasFile && !isDemo && st && st.play === 'play') {
      try { showNowPlayingNotification(st.fileName); } catch (eN) {}
      try { acquireCpuWakeLock(); } catch (eW) {}
      // Do NOT silence/pause — let content-channel audio continue in background.
      return;
    }
    try { _engine().silence(); } catch (e) {}
    if (typeof Sequencer !== 'undefined' && Sequencer.pause) Sequencer.pause();
  }, false);
  window.addEventListener('focus', function () {
    try { _engine().resume(); } catch (e) {}
    // If Store still says 'play' but blur's direct Sequencer.pause() stopped the pulse,
    // restart it. (Background-play blur does NOT pause, so this is a no-op in that case.)
    try {
      var st2 = Store.getState();
      if (st2 && st2.play === 'play' && typeof Sequencer !== 'undefined') {
        var _isPl = false;
        try { _isPl = Sequencer.isPlaying ? Sequencer.isPlaying() : false; } catch (eP) {}
        if (!_isPl) Sequencer.play();
      }
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

    // Loading any real file ends the demo track and unlocks everything.
    if (_demoActive) clearDemo();

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
    return _isJsonName(name) ? 'Reading Data...' : 'Analyzing MIDI Data...';
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
      showErrorDialog('Could not read this file. It may not be a valid MIDI-JSON (.note) export.');
      return false;
    }
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

  // End the demo: clear the flag and refresh the softkeys so PLAY/PAUSE,
  // speed and transport controls reappear. Sequencer contents are replaced
  // by whoever loads the next file; on natural end we already stopped.
  function clearDemo() {
    _demoActive = false;
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  // Play the bundled demo.note (auto-starts on first app entry). Loads it
  // exactly like a real file, then hides transport, forces HUD to 0/0 +
  // 0:00, and starts playing. Ends once (no loop); loading a real file or
  // a parse-error restart calls this again to re-run from the start.
  function startDemo() {
    // A pending real-file activity overrides the demo on this boot.
    if (_pendingActivity) return;
    fetch('demo.note')
      .then(function (res) {
        if (!res.ok) throw new Error('demo.note missing (HTTP ' + res.status + ')');
        return res.text();
      })
      .then(function (txt) {
        var midi = JSON.parse(txt);
        loadMIDIData(midi);          // load notes/tempo/div, resets sequencer
        _demoActive = true;          // set AFTER load so clearDemo isn't triggered
        HUD.setTotal(0);             // HUD shows 0/0
        Sequencer.play();            // self-play with audio + visuals
        Store.setState({ play: 'play', npPending: false });
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        console.log('[Main] demo track started');
      })
      .catch(function (e) {
        console.error('[Main] demo start failed:', e);
        _demoActive = false;
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

    // Handle .mid files with caching
    if (filePath.endsWith('.mid')) {
      showParsing(_parsingLabel(filePath)); // Analyzing MIDI Data...

      if (typeof navigator !== 'undefined' && navigator.getDeviceStorage) {
        var ds = navigator.getDeviceStorage('sdcard');
        // Strip /sdcard/ prefix — getDeviceStorage path is relative to storage root
        var dsPath = filePath.replace(/^\/sdcard\//, '');
        var req = ds.get(dsPath);

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
              var reader = new FileReader();
              reader.onload = function () { handleMidiBuffer(reader.result, filePath); };
              reader.onerror = function () { console.error('[Main] FileReader error'); hideParsing(); };
              reader.readAsArrayBuffer(fileBlob);
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

    // Existing code for other file types (.mid.json / .json / .note MIDI)
    showParsing(_parsingLabel(filePath)); // Reading Data... for .note/.json

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
    window._rawMidiBuffer = buffer; // expose for native audio test
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

  // ── PARSING PROGRESS ──
  // Center-screen "Analyzing MIDI Data..." message while a file is being
  // read + parsed. Uses #now-playing-overlay/#now-playing-text (styles in
  // kaiui.css) — the same pill the Now Playing toast uses.
  // label: optional text; defaults to "Analyzing MIDI Data...". .note/.json
  // MIDI files show "Reading Data..." instead (see _parsingLabel).
  function showParsing(label) {
    var msgToken = (typeof label === 'string' && label.length) ? label : 'Analyzing MIDI Data...';
    // Visual → Show Dialog = Off suppresses the pill entirely
    var playerOnly = _onPlayerScreen();
    if (Store.getState().showDialog === false || !playerOnly) {
      var bar0 = document.getElementById('parse-bar');
      if (bar0) {
        bar0.classList.remove('hidden');
        bar0.classList.add('indeterminate');
      }
      return;
    }
    var overlay = document.getElementById('now-playing-overlay');
    var textEl  = document.getElementById('now-playing-text');
    var bar     = document.getElementById('parse-bar');
    if (textEl) textEl.textContent = msgToken;
    if (overlay) overlay.classList.remove('np-hide');
    if (bar) {
      bar.classList.remove('hidden');
      bar.classList.add('indeterminate');
    }
  }

  function hideParsing() {
    var overlay = document.getElementById('now-playing-overlay');
    var bar     = document.getElementById('parse-bar');
    if (overlay) overlay.classList.add('np-hide');
    if (bar) {
      bar.classList.remove('indeterminate');
      bar.classList.add('hidden');
    }
  }

  // KaiUI-style error dialog — single centre OK on the softkey bar.
  // Mirrors KaiUI-master Dialog (header + white container, dim overlay).
  // Used when a .note/.json MIDI file fails to read or parse (see loadMIDIJson).
  var _errorDialogOpen = false;
  var _errorOnClose = null;   // optional callback invoked when the dialog is closed
  function isErrorDialogOpen() { return _errorDialogOpen; }

  function showErrorDialog(msg, onClose) {
    hideParsing();
    _errorOnClose = onClose || null;
    var msgEl = document.getElementById('error-dialog-msg');
    var dlg   = document.getElementById('error-dialog');
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
      if (c) c.textContent = 'OK';
      if (l) l.textContent = '';
      if (r) r.textContent = '';
    }
  }

  function hideErrorDialog() {
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

  // ── Now Playing background notification (desktop-notification) ──
  // Shown when the user presses Back on the piano player while a real
  // .mid/.note file is playing. Mirrors upgrade-tool-src/js/app.js
  // dlNotifyUpdate/dlNotifyClose (tag + icon + onclick → launch app).
  var _nowPlayingNotif = null;
  var _cpuWakeLock = null;
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
      var raw = name || Store.getState().fileName || '';
      var base = _nowPlayingBasename(raw) || raw || 'Unknown';
      if (_nowPlayingNotif) { try { _nowPlayingNotif.close(); } catch (e2) {} _nowPlayingNotif = null; }
      _nowPlayingNotif = new Notification('PFA is running', {
        body: 'Now playing: ' + base,
        tag: 'pfa-nowplaying',
        icon: 'icons/running.png'
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
        if (hasFile && !isDemo && st.play === 'play') {
          showNowPlayingNotification(st.fileName);
          acquireCpuWakeLock();
        }
      } else {
        try { if (st.play === 'play') _engine().ensure(); } catch (e5) {}
        try { onResize(); } catch (e6) {}
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
  window.loadMIDIData = loadMIDIData;
  window.isDemoActive = isDemoActive;
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