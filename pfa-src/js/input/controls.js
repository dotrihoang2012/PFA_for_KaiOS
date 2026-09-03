/**
 * controls.js — KaiOS hardware key → Store state.
 *   SoftLeft  → left softkey
 *   SoftRight → right softkey
 *   Enter     → center (select)
 *   Backspace → back / exit overlay
 *   ArrowLeft/Right → seek -1s / +1s
 *   ArrowUp/Down    → OS media volume up / down
 *   Key 1 / Key 3   → playback speed -0.1x / +0.1x
 *   EndCall   → quit app
 *
 *   MozActivity picker for file loading (native KaiOS)
 *   Fullscreen toggle + Screen rotation
 */
(function () {
  console.log('[Controls] IIFE start');
  'use strict';

  var _focusedItemIndex = 0;

  function init() {
    window.addEventListener('keydown', onKeyDown, false);
  }

  function onKeyDown(e) {
    // Bootstrap AudioContext on first interaction
    try { if (typeof _engine === 'function') _engine().ensure(); else Synth.ensure(); } catch (ign) {}

    var key = e.keyCode || e.key;
    if (!key) return;

    var st = Store.getState();
    var menuOpen = st.menu && st.menu.open;

    // ── EndCall QUITS from anywhere (must run BEFORE menu/Settings check,
    //    otherwise menu-open swallows it and only closes the menu) ──
    if (key === 'EndCall' || key === Constants.KEY.END_CALL) {
      e.preventDefault();
      quitApp();
      return;
    }

    // ── Error dialog: top-most modal; Enter (centre OK) or Back closes it.
    //    Must be checked BEFORE About/menu so it blocks everything.
    var _errOpen = false;
    try {
      if (typeof window.isErrorDialogOpen === 'function') _errOpen = window.isErrorDialogOpen();
      else {
        var _ed = document.getElementById('error-dialog');
        _errOpen = !!(_ed && !_ed.classList.contains('hidden'));
      }
    } catch (ig) {}
    if (_errOpen) {
      e.preventDefault();
      if (key === 13 || key === Constants.KEY.ENTER || key === 'Enter' ||
          key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK) {
        if (typeof window.hideErrorDialog === 'function') window.hideErrorDialog();
        return;
      }
      // ArrowUp/Down scroll the dialog body (long Memory Stats lists,
      // error dumps). KaiOS has no touch input — the D-pad must do it,
      // mirroring the About panel scroll above.
      if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP ||
          key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
        var _nav = document.getElementById('error-dialog');
        if (_nav) {
          var _s = _nav.querySelector('.kai-dialog-container');
          if (_s) {
            var _step = 50; // ~5rem at the locked 10px root font-size
            var _down = (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN);
            _s.scrollTop += _down ? _step : -_step;
          }
        }
      }
      return;
    }

    // ── About panel: modal; Back / SoftRight / Enter dismiss it back
    //    to the piano screen. ArrowUp/Down SCROLL the content — KaiOS
    //    handsets have no touch input, so the D-pad must do it.
    if (aboutOpen()) {
      e.preventDefault();
      if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK ||
          key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === Constants.KEY.ENTER || key === 13) {
        hideAbout();
        return;
      }
      if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP ||
          key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
        var anav = document.getElementById('about-list');
        if (anav) {
          var astep = 50; // ~5rem at the locked 10px root font-size
          var adown = (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN);
          anav.scrollTop += adown ? astep : -astep;
        }
      }
      return;
    }

    // ── Back: closes menu / Settings if open, otherwise hands control to
    //    OS so the hardware Back button quits the app. ──
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
        key === 'Back' || key === Constants.KEY.BACK) {
      if (typeof Settings !== 'undefined' && Settings.isOpen && Settings.isOpen()) {
        e.preventDefault();
        // Delegate to Settings.handleKey: while a level-2 sub-page is
        // open it steps BACK to the group page (Visual Settings);
        // otherwise it closes the group page. Calling Settings.close()
        // directly here skipped the sub-page level entirely and dumped
        // the user out to the Options menu.
        if (typeof Settings.handleKey === 'function') {
          Settings.handleKey(key);
        } else {
          Settings.close();
        }
        return;
      }
      if (menuOpen) {
        e.preventDefault();
        closeMenuOverlay();
        return;
      }
      // Piano screen — real .mid/.note playing: keep it running in
      // background with "Now playing: name.mid/.note" notification (see
      // main.js showNowPlayingNotification, mirrors upgrade-tool
      // desktop-notification). Otherwise let Back bubble to OS (quit/minimize).
      var hasFileBg = !!(st && st.fileName);
      var isDemoBg = false;
      try { isDemoBg = typeof window.isDemoActive === 'function' && window.isDemoActive(); } catch (eBg) {}
      if (hasFileBg && !isDemoBg && st.play === 'play') {
        try { if (typeof window.showNowPlayingNotification === 'function') window.showNowPlayingNotification(st.fileName); } catch (eN) {}
        // Don't preventDefault — let system minimize to background so the
        // Sequencer (performance.now wall-clock) keeps running. Re-opening
        // restores via visibilitychange without losing position.
        return;
      }
      return;
    }

    // ── Overlay navigation (menu) ──
    if (menuOpen) {
      e.preventDefault();
      handleOverlayKey(e, key);
      return;
    }

    // ── Settings sub-page (MIDI Output / Visual) ──
    // Sits ABOVE gameplay so user can navigate settings while a MIDI
    // is loaded. handleKey returns true when it consumed the key.
    if (typeof Settings !== 'undefined' && Settings.isOpen && Settings.isOpen()) {
      // While a settings text field holds focus (KaiUI-style text entry),
      // printable keys must reach the input NATIVELY — preventDefault
      // here would silently kill typing. Only editing-control keys
      // (Back / Enter / RSK) are intercepted and routed to Settings.
      var ae = document.activeElement;
      var isTextField = !!(ae && ae.tagName === 'INPUT');
      var isEditKey = (key === 8 || key === 'Backspace' ||
                       key === 13 || key === Constants.KEY.ENTER ||
                       key === 'Back' || key === Constants.KEY.BACK);
      if (isTextField && !isEditKey) {
        return; // pass through untouched: digits, '*', '#', caret keys…
      }
      e.preventDefault();
      if (typeof Settings.handleKey === 'function') {
        Settings.handleKey(key);
        // Focus may have moved onto/off a drill-in row (or opened a
        // sub-page) — refresh the SELECT softkey label to match.
        updateSoftkeys();
      }
      return;
    }

    // ── Gameplay mode ──
    // ArrowUp/Down step the OS media volume directly (bindings.js), so no
    // temporary OSD input-lock is needed anymore — volume works everywhere
    // on the piano screen, and Left/Right always seek ±1s.
    // While an analysis is running, SoftRight (the visible Cancel softkey)
    // AND Enter both stop the pipeline at any point.
    if (analyzingNow()) {
      if (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === 13 || key === Constants.KEY.ENTER || key === 'Enter') {
        e.preventDefault();
        if (typeof window.cancelAnalyze === 'function') window.cancelAnalyze();
        return;
      }
    }
    var action = Constants.KEY_MAP[key];
    if (!action) return;
    e.preventDefault();
    dispatchAction(action);
  }

  // ── Quit app ──
  function quitApp() {
    try {
      if (typeof window !== 'undefined' && window.close) {
        window.close();
      }
    } catch (e) {}
  }

  // ── Overlay navigation ──
  function handleOverlayKey(e, key) {
    var items = document.querySelectorAll('#menu-list .kai-om-item:not(.hidden)');

    // Back = the ONLY way out of the Options menu. LSK/RSK are
    // strictly forbidden here (hardware Back key = keyCode 8 / 'Back').
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
        key === 'Back' || key === Constants.KEY.BACK) {
      closeMenuOverlay();
      return;
    }

    // ArrowUp / ArrowDown = move focus with WRAP-AROUND (bottom ↔ top)
    if (key === Constants.KEY.ARROW_UP || key === 'ArrowUp') {
      var nItems = items.length;
      if (!nItems) return;
      _focusedItemIndex = ((_focusedItemIndex - 1) % nItems + nItems) % nItems;
      focusOverlayItem(items, _focusedItemIndex);
      return;
    }
    if (key === Constants.KEY.ARROW_DOWN || key === 'ArrowDown') {
      var nItems2 = items.length;
      if (!nItems2) return;
      _focusedItemIndex = ((_focusedItemIndex + 1) % nItems2 + nItems2) % nItems2;
      focusOverlayItem(items, _focusedItemIndex);
      return;
    }

    // Enter/SELECT only -- LSK blocked for all Options items
    if (key === Constants.KEY.ENTER || key === 13) {
      selectMenuItem(_focusedItemIndex);
      return;
    }
  }

  /** Focus a specific item by index.
   *  CSS-only highlight — we DO NOT call .focus() on the item. On KaiOS
   *  Gecko 48, a div with tabindex="-1" can swallow keydown events after
   *  being .focus()ed, which breaks following Arrow Up/Down. Visual
   *  highlight is purely via the .focused class.
   *
   *  Also scroll the focused item into view so long lists (Options has
   *  6 items, Settings has 4) don't end up with the highlight off-screen.
   *  block:'nearest' = no scroll if item is already in view. */
  function focusOverlayItem(items, index) {
    _focusedItemIndex = index;
    for (var i = 0; i < items.length; i++) {
      if (i === index) {
        items[i].classList.add('focused');
      } else {
        items[i].classList.remove('focused');
      }
    }
    var focused = items[index];
    if (focused && typeof focused.scrollIntoView === 'function') {
      try { focused.scrollIntoView({ block: 'nearest' }); }
      catch (e) { try { focused.scrollIntoView(false); } catch (e2) {} }
    }
    // Refresh softkeys so the center SELECT label reflects the focused item
    // (hidden when it is a locked, non-interactive row).
    if (typeof updateSoftkeys === 'function') updateSoftkeys();
  }

  function closeAllOverlays() {
    closeMenuOverlay();
  }

  // Drop focus + state on overlay close. Visibility is owned by .hidden
  // in CSS — toggling it gives an instant show/hide.
  function closeMenuOverlay() {
    Store.setState({ menu: { open: false } });
    var app = document.getElementById('app');
    if (app) app.classList.remove('menu-open');
    var m = document.getElementById('menu-overlay');
    if (m) m.classList.add('hidden');
    // Drop focus highlight from all items — important so the menu doesn't
    // appear "still focused" right after picking Volume (OSD lock flow).
    var items = document.querySelectorAll('#menu-list .kai-om-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.remove('focused');
    }
    _focusedItemIndex = -1;
    updateSoftkeys();
  }

  function selectMenuItem(index) {
    var menuItems = document.querySelectorAll('#menu-list .kai-om-item:not(.hidden)');
    var action = menuItems[index] && menuItems[index].getAttribute('data-action');
    if (action) {
      // Demo-locked items (Note Color Randomise while the demo self-plays)
      // are non-interactive: consuming Enter keeps them inert.
      if (menuItems[index] && menuItems[index].classList.contains('demo-locked')) {
        if (typeof showToast === 'function') showToast('Locked during demo');
        return;
      }
      execMenuAction(action);
    }
  }

  /** Grey out (or un-grey) the Note Color Randomise Options item based on
   *  whether playback is locked (demo active OR finished but no file loaded). */
  function applyMenuDemoLock() {
    var items = document.querySelectorAll('#menu-list .kai-om-item');
    var on = false;
    try { on = typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked(); } catch (e) {}
    for (var i = 0; i < items.length; i++) {
      var a = items[i].getAttribute('data-action');
      if (a === 'random-colors') {
        if (on) items[i].classList.add('demo-locked');
        else    items[i].classList.remove('demo-locked');
      }
    }
  }
  function refreshDemoLock() { applyMenuDemoLock(); }
  window.refreshDemoLock = refreshDemoLock;
  window.applyMenuDemoLock = applyMenuDemoLock;

  // ── About panel ──
  // Static info page opened from Options → "About This App". Modal:
  // Back / SoftRight / Enter close it and drop the user back on the
  // piano screen (the Options menu stays closed).
  function aboutOpen() {
    var ov = document.getElementById('about-overlay');
    return !!(ov && !ov.classList.contains('hidden'));
  }

  function showAbout() {
    closeMenuOverlay();
    var ov = document.getElementById('about-overlay');
    if (ov) {
      // Reset scroll so long content starts from the top every time.
      var nav = ov.querySelector('#about-list');
      if (nav) nav.scrollTop = 0;
      ov.classList.remove('hidden');
    }
    updateSoftkeys();
  }

  function hideAbout() {
    var ov = document.getElementById('about-overlay');
    if (ov) ov.classList.add('hidden');
    updateSoftkeys();
  }

  function execMenuAction(action) {
    switch (action) {
      case 'cancel-analysis':
        closeMenuOverlay();
        if (typeof window.cancelAnalyze === 'function') {
          try { window.cancelAnalyze(); } catch (e) { console.error('[Ctrl] cancel-analysis error', e); }
        }
        return;
      case 'clear-midi':
        closeMenuOverlay();
        try {
          Sequencer.stop();
          Sequencer.load([], [], 480);
          Store.setState({ play: 'stop', notes: [], fileName: '', timeSec: 0 });
          if (typeof HUD !== 'undefined' && HUD.setTotal) HUD.setTotal(0);
          window._midiBlob = null;
          window._rawMidiBuffer = null;
          // Drop the on-disk conversion cache too — the in-RAM notes are gone,
          // so the pfa_tmp .r*.bin runs + final .note are pure garbage reclaimable
          // right now (device storage is measured in hundreds of free MB).
          if (typeof window.clearPfaTmp === 'function') {
            try { window.clearPfaTmp(); } catch (e) { console.error('[Ctrl] clearPfaTmp error', e); }
          }
          setTimeout(function() {
            if (typeof updateSoftkeys === 'function') updateSoftkeys();
          }, 0);
        } catch (e) { console.error('[Ctrl] clear-midi error', e); }
        return;
      case 'close':
        closeMenuOverlay();
        return;
      case 'load-midi':
        // Storage permission not granted (SFB Not Allowed / revoked):
        // the item is inert — tapping does nothing. The dialog hint was
        // already shown when the denial was detected.
        try {
          if (typeof window.pfaStorageGranted === 'function' && !window.pfaStorageGranted()) {
            if (typeof window.pfaGuardStorageLoad === 'function') window.pfaGuardStorageLoad(false);
            return;
          }
        } catch (e) {}
        launchFilePicker();
        return;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'rotate':
        rotateScreen();
        break;
      case 'volume':
        showOSDVolume();
        return;
      case 'random-colors':
        closeMenuOverlay();
        // Note Color Palette Randomise is locked until a real file is loaded
        // (demo active or finished but no file yet).
        try {
          if (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked()) {
            if (typeof showToast === 'function') showToast('Locked until a file loads');
            return;
          }
        } catch (e) {}
        try {
          if (typeof Notes !== 'undefined' && Notes.randomizePalette) {
            Notes.randomizePalette();
            showToast('Track colors randomised');
          }
        } catch (e) { console.error('[Ctrl] random-colors failed', e); }
        return;
      case 'midi-output':
        // BETA: MIDI-OUT is under construction. Show an informational dialog
        // instead of opening the (not yet built) settings group.
        closeMenuOverlay();
        if (typeof showErrorDialog === 'function') {
          showErrorDialog('This is BETA version, MIDI-OUT is under construction.', null, 'PFA');
        }
        return;
      case 'visual':
        openSettingsGroup('visual');
        return;
      case 'dev':
        openSettingsGroup('dev');
        return;
      case 'about':
        showAbout();
        return;
      default:
        console.log('[Ctrl] unknown menu action: ' + action);
    }
    closeMenuOverlay();
  }

  // ── File picker via MozActivity ──
  function launchFilePicker() {
    // Exit fullscreen before launching file picker
    var appEl = document.getElementById('app');
    if (appEl && appEl.classList.contains('fullscreen')) {
      appEl.classList.remove('fullscreen');
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      setTimeout(function () { if (typeof onResize === 'function') onResize(); }, 100);
    }
    // Close menu overlay but keep chrome visible for MozActivity
    Store.setState({ menu: { open: false } });
    if (appEl) appEl.classList.remove('menu-open');
    var m = document.getElementById('menu-overlay');
    if (m) m.classList.add('hidden');
    _focusedItemIndex = -1;

    try {
      var act = new MozActivity({ name: 'pick' });
      act.onsuccess = function (res) {
        // Restore fullscreen chrome state
        updateChromeAfterPicker();
        var blob = null;
        if (res.target && res.target.result) {
          blob = res.target.result.blob || res.target.result;
        } else if (res.result && res.result.blob) {
          blob = res.result.blob;
        } else if (res.blob) {
          blob = res.blob;
        } else if (res instanceof Blob) {
          blob = res;
        }
        if (blob) {
          window._midiBlob = blob; // expose for native audio — disk reference, no RAM copy
          window._midiName = blob.name || 'picked.mid';
          handlePickedBlob(blob, blob.name || 'picked.mid');
        }
      };
      act.onerror = function () {
        updateChromeAfterPicker();
        console.log('[Ctrl] MozActivity pick cancelled');
      };
    } catch (e) {
      updateChromeAfterPicker();
      console.error('[Ctrl] MozActivity error:', e);
    }
  }

  /** Restore chrome visibility after MozActivity closes */
  function updateChromeAfterPicker() {
    var app = document.getElementById('app');
    if (app && app.classList.contains('fullscreen')) {
      app.classList.remove('menu-open');
    }
    updateSoftkeys();
  }

  function handlePickedBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    // Show loading — .note/.json show "Reading Data...", .mid stays "Analyzing".
    if (typeof window.showParsing === 'function') {
      var plabel = (typeof window.midiParsingLabel === 'function')
        ? window.midiParsingLabel(name)
        : undefined;
      window.showParsing(plabel);
    }

    var isMidi = name.toLowerCase().endsWith('.mid');
    Store.setState({ fileName: name });

    // The user just committed to loading a file — drop fullscreen now so
    // they're not stuck looking at a chrome-less canvas if parse later
    // fails. exitFullscreenIfActive is idempotent (no-op when not in FS).
    if (typeof window.exitFullscreenIfActive === 'function') {
      window.exitFullscreenIfActive();
    }

    if (isMidi) {
      // Route through main.js: large .mid files are streamed straight from the
      // Blob to a binary .note (StreamParser) and never read fully into RAM;
      // smaller files are read and played in memory.
      if (typeof window.routeMidiBlob === 'function') {
        window.routeMidiBlob(blob, name);
      } else if (typeof window.analyzeAndLoadMIDI === 'function') {
        var reader2 = new FileReader();
        reader2.onload = function () {
          try { window.analyzeAndLoadMIDI(reader2.result, name, blob); }
          catch (e) {
            console.error('[Ctrl] MIDI parse error', e);
            if (typeof window.hideParsing === 'function') window.hideParsing();
          }
        };
        reader2.onerror = function () {
          console.error('[Ctrl] FileReader error');
          if (typeof window.hideParsing === 'function') window.hideParsing();
        };
        reader2.readAsArrayBuffer(blob);
      } else if (typeof window.loadMIDIData === 'function') {
        var reader3 = new FileReader();
        reader3.onload = function () {
          try {
            var midiData = MidiParser.parseMIDI(reader3.result);
            window.loadMIDIData(midiData);
          } catch (e) {
            console.error('[Ctrl] MIDI parse error', e);
            if (typeof window.hideParsing === 'function') window.hideParsing();
          }
        };
        reader3.onerror = function () {
          console.error('[Ctrl] FileReader error');
          if (typeof window.hideParsing === 'function') window.hideParsing();
        };
        reader3.readAsArrayBuffer(blob);
      }
} else {
      // Assume JSON — but .note may be a PFA2 binary (stream it instead).
      if (typeof window.openNoteFile === 'function') {
        window.openNoteFile(blob, name);
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        if (typeof window.loadMIDIJson === 'function') {
          window.loadMIDIJson(reader.result);
        }
      };
      reader.onerror = function () {
        console.error('[Ctrl] FileReader error');
        if (typeof window.hideParsing === 'function') window.hideParsing();
      };
      reader.readAsText(blob);
    }
  }

  // ── Refresh menu labels (fullscreen + orientation can change outside the menu) ──
  function refreshMenuLabels() {
    var appEl = document.getElementById('app');
    var inFS = !!(document.fullscreenElement || document.mozFullScreenElement) ||
               !!(appEl && appEl.classList.contains('fullscreen'));

    // Orientation state — read live from screen.orientation.type.
    // 'portrait-primary' / 'portrait-secondary' → currently portrait.
    // 'landscape-primary' / 'landscape-secondary' → currently landscape.
    // Some KaiOS builds (or no-API fallback) just expose 'portrait' / 'landscape'.
    var orientType = '';
    var rotSupported = false;
    try {
      if (screen && screen.orientation && screen.orientation.type) {
        orientType = screen.orientation.type;
        rotSupported = true;
      }
    } catch (e) {}
    var isLandscape =
      rotSupported &&
      (orientType === 'landscape-primary' ||
       orientType === 'landscape-secondary' ||
       orientType.slice(0, 8) === 'landscape');

    var items = document.querySelectorAll('#menu-list .kai-om-item');
    for (var i = 0; i < items.length; i++) {
      var a = items[i].getAttribute('data-action');
      if (a === 'fullscreen') {
        items[i].textContent = inFS ? 'Exit Full Screen' : 'Full Screen';
      } else if (a === 'rotate') {
        if (!rotSupported) {
          items[i].textContent = 'Rotate Screen';
        } else if (isLandscape) {
          items[i].textContent = 'Rotate To Portrait';
        } else {
          items[i].textContent = 'Rotate To Landscape';
        }
      } else if (a === 'volume') {
        items[i].textContent = 'Volume';
      }
    }
  }

  // ── Fullscreen toggle ──
  function toggleFullscreen() {
    var isFS = !!(document.fullscreenElement || document.mozFullScreenElement);
    var app = document.getElementById('app');

    if (isFS) {
      if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.exitFullscreen) document.exitFullscreen();
      if (app) app.classList.remove('fullscreen');
    } else {
      if (app) app.classList.add('fullscreen');
      var body = document.body;
      if (body.mozRequestFullScreen) body.mozRequestFullScreen();
      else if (body.requestFullscreen) body.requestFullscreen();
    }
    // Resize canvas after fullscreen change (KaiOS needs delay)
    setTimeout(function () {
      window.dispatchEvent(new Event('resize'));
      refreshMenuLabels();
    }, 300);
    // Refresh immediately too, in case the menu is already open or reopens
    refreshMenuLabels();
  }

  // ── Rotate screen ──
  function rotateScreen() {
    try {
      if (!('orientation' in screen) || !screen.orientation) {
        showToast('Rotation not supported');
        return;
      }
      var type = screen.orientation.type || '';
      if (type.indexOf('portrait') === -1) {
        screen.orientation.lock('portrait');
      } else {
        screen.orientation.lock('landscape');
      }
      // Refresh the label after a tick — the orientation.type changes
      // once the lock is actually applied.
      setTimeout(refreshMenuLabels, 250);
    } catch (e) {
      showToast('Rotation not supported');
    }
  }

  // ── Analyze-in-flight helper (piano only, pipeline busy) ──
  function analyzingNow() {
    try {
      return !!(window.isAnalyzingActive && window.isAnalyzingActive());
    } catch (e) { return false; }
  }
  // Pipeline busy REGARDLESS of screen — drives the Options menu's
  // "Cancel Analysis" item (visible while a conversion runs, even if the
  // user has opened the menu over it). Cancelling hides it again.
  function engineBusy() {
    try {
      return !!(window.isAnalyzing && window.isAnalyzing());
    } catch (e) { return false; }
  }
  function refreshAnalyzeCanItem() {
    var el = document.querySelector('#menu-list .kai-om-item[data-action="cancel-analysis"]');
    if (!el) return;
    var show = engineBusy();
    el.classList.toggle('hidden', !show);
  }
  window.refreshAnalyzeCanItem = refreshAnalyzeCanItem;

  // ── Gameplay actions ──
  // ── Playback start helpers ──
  // (Start Delay now uses the pausable countdown — see armCountdown.)

  // ── Start Delay countdown ──
  // While counting down, HUD time shows -0:05 → -0:04 → … → 0:00 and
  // playback starts. Pause HOLDS the countdown (value frozen); Play
  // resumes it; Stop (or clearing the file) cancels it.
  var _cdTimer = null;

  function cancelCountdown() {
    if (_cdTimer) {
      clearInterval(_cdTimer);
      _cdTimer = null;
    }
    if (Store.getState().startCountdown != null) {
      Store.setState({ startCountdown: null, cdRunning: false });
    }
  }

  function armCountdown(sec) {
    cancelCountdown();
    Store.setState({ startCountdown: sec, cdRunning: true, play: 'pause' });
    _cdTimer = setInterval(function () {
      var st = Store.getState();
      // Self-heal: file cleared or user stopped → tear down quietly
      if (st.startCountdown == null || st.play === 'stop') {
        cancelCountdown();
        return;
      }
      if (!st.cdRunning || st.play === 'play') return; // held
      var next = Math.round((st.startCountdown - 0.1) * 10) / 10;
      if (next <= 0) {
        cancelCountdown();
        beginPlaybackNow(true); // no Play label — the music says it all
      } else {
        Store.setState({ startCountdown: next });
      }
    }, 100);
  }

  function beginPlaybackNow(silent) {
    var st = Store.getState();
    Store.setState({ play: 'play' });
    // silent=true (countdown finished / seek flush): playback starting is
    // self-evident — don't flash the Play label over the info bar.
    if (!silent) showPlaybackOsd('Play');
    // Async entry points (countdown timer, Auto Play) bypass
    // dispatchAction, so the softkey PLAY→PAUSE swap must be done here.
    if (typeof updateSoftkeys === 'function') updateSoftkeys();
    // One-shot "Now playing: <file>" toast — the loader arms npPending,
    // so this fires exactly once per loaded file (never on resume).
    if (st.npPending && typeof window.showNowPlaying === 'function') {
      window.showNowPlaying(st.fileName);
      Store.setState({ npPending: false });
    }
  }

  // Entry point for Auto Play (Visual settings) — called by main.js
  // right after a MIDI finishes loading.
  window.pfaRequestStart = function () {
    var st = Store.getState();
    if (!st.fileName || st.play !== 'stop' || st.startCountdown != null) return;
    var d = Number(st.startDelay);
    if (d > 0) {
      armCountdown(d);
      showPlaybackOsd('Play');
      // Same once-per-file toast rule as the manual Play path.
      if (st.npPending && typeof window.showNowPlaying === 'function') {
        window.showNowPlaying(st.fileName);
        Store.setState({ npPending: false });
      }
    } else {
      beginPlaybackNow();
    }
    // Not reached via dispatchAction — keep the softkey label in sync.
    if (typeof updateSoftkeys === 'function') updateSoftkeys();
  };

  function dispatchAction(action) {
    // Demo track: transport AND speed hot-keys stay locked from the demo
    // start right through the end of the demo (HUD 0/0 + 0:00, PLAY/PAUSE
    // hidden) until a real file is loaded (isPlaybackLocked).
    if (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked()) {
      switch (action) {
        case 'playPause':
        case 'stop':
        case 'restart':
        case 'seekBack':
        case 'seekForward':
        case 'speedStepUp':
        case 'speedStepDown':
        case 'speedUp':
        case 'speedDown':
          return;
      }
    }
    var s = Store.getState();
    switch (action) {
      case 'playPause':
        if (!s.fileName) break; // no file loaded
        // Inside a countdown? Play/Pause toggles HOLD ↔ RESUME of the
        // remaining time — real playback only starts at 0:00.
        if (s.startCountdown != null) {
          if (s.cdRunning) {
            Store.setState({ cdRunning: false }); // hold
            showPlaybackOsd('Pause');
          } else {
            Store.setState({ cdRunning: true });  // resume
            showPlaybackOsd('Play');
          }
          break;
        }
        if (s.play === 'play') {
          Store.setState({ play: 'pause' });
          showPlaybackOsd('Pause');
          break;
        }
        // Countdown applies ONLY to a fresh start from the beginning
        // (play === 'stop'). Resume-from-pause must continue instantly.
        var delaySec = Number(s.startDelay);
        if (s.play === 'stop' && delaySec > 0) {
          armCountdown(delaySec);
          showPlaybackOsd('Play');
          // Now Playing fires the MOMENT Play is pressed — the countdown
          // only delays the audio, not the toast. Consuming npPending
          // here keeps it a once-per-file toast (no repeat at 0:00).
          if (s.npPending && typeof window.showNowPlaying === 'function') {
            window.showNowPlaying(s.fileName);
            Store.setState({ npPending: false });
          }
        } else {
          beginPlaybackNow();
        }
        break;
      case 'stop':
        cancelCountdown();
        Store.setState({ play: 'stop', timeSec: 0 });
        if (s.fileName) showInfoOsd('Stop');
        break;
      case 'seekBack':
        seekSeconds(-1);
        break;
      case 'seekForward':
        seekSeconds(+1);
        break;
      case 'speedStepUp':
        stepSpeed(+0.1);
        showSpeedOsd();
        break;
      case 'speedStepDown':
        stepSpeed(-0.1);
        showSpeedOsd();
        break;
      case 'speedUp':
        Store.setState({ speed: Math.min(4.0, s.speed * 2) });
        showSpeedOsd();
        break;
      case 'speedDown':
        Store.setState({ speed: Math.max(0.25, s.speed / 2) });
        showSpeedOsd();
        break;
      case 'menuOpen':
        openMenu();
        break;
      case 'quitApp':
        quitApp();
        break;
      case 'volumeDown':
        adjustVolume(-1);
        break;
      case 'volumeUp':
        adjustVolume(+1);
        break;
      case 'restart':
        Sequencer.stop();
        Sequencer.play();
        if (s.fileName) showInfoOsd('Restart');
        break;
      case 'back':
        break;
      default: break;
    }
    updateSoftkeys();
  }

  // ── Seek by ±N seconds (ArrowLeft / ArrowRight) ──
  // Sequencer.seek() internally stops the pulse timer and clears the
  // active-note windows, so if we were playing we must kick playback
  // off again directly (Store already says 'play', so routing through
  // setState would be a no-op — see main.js onStoreChange prevPlay guard).
  // ── Seek OSD accumulator ──
  // Repeated presses sum up (+1, +2, +3…) and the HUD info bar shows
  // the total instead of the four stats. 2s without a press hides the
  // OSD and resets the COUNTER only — playback speed/position and the
  // seek already applied are never undone.
  var _seekAccum = 0;
  var _seekAccumReset = null;

  // Central OSD entry — Visual → Show OSD = Off silences every info-bar
  // action label (seek totals, speed, Stop, Restart, Play, Pause).
  function showInfoOsd(text, holdMs) {
    if (Store.getState().showOsd === false) return;
    if (typeof HUD !== 'undefined' && HUD.showOsd) HUD.showOsd(text, holdMs || 2000);
  }

  // Play/Pause labels are FULLSCREEN-ONLY: outside fullscreen the
  // softkey bar already shows PLAY/PAUSE, so a second label on the
  // info bar is just noise.
  function showPlaybackOsd(text) {
    var appEl = document.getElementById('app');
    if (!(appEl && appEl.classList.contains('fullscreen'))) return;
    showInfoOsd(text, 3000);
  }

  function bumpSeekOsd(delta) {
    if (Store.getState().showOsd === false) return;
    // Opposite direction starts a FRESH count: at -3, pressing →
    // shows +1 (never -2, -1, +1 crawling back through zero).
    if (delta > 0 && _seekAccum < 0) _seekAccum = 0;
    if (delta < 0 && _seekAccum > 0) _seekAccum = 0;
    _seekAccum += delta;
    showInfoOsd((_seekAccum > 0 ? '+' : '') + _seekAccum + ' sec');
    if (_seekAccumReset) clearTimeout(_seekAccumReset);
    _seekAccumReset = setTimeout(function () { _seekAccum = 0; }, 2100);
  }

  // OSD for speed actions (1 / 3 / * / #) — shows the resulting speed
  // ("1.1x speed"); no accumulation, each press just refreshes the 2s hold.
  function showSpeedOsd() {
    var v = Number(Store.getState().speed) || 1;
    showInfoOsd(v.toFixed(1) + 'x speed');
  }

  function seekSeconds(delta) {
    var s = Store.getState();
    if (!s.notes || !s.notes.length) return;   // nothing loaded to seek in
    // Seeking while a countdown runs = user intent to go: tear the
    // countdown down and start playback immediately.
    if (s.startCountdown != null) {
      cancelCountdown();
      beginPlaybackNow(true); // seek OSD takes over the label anyway
    }
    // Feedback counts PRESSES — bump BEFORE touching the engine so no
    // seek/play quirk (e.g. clamped at t=0, or play() throwing after a
    // rejected seek) can ever skip the OSD update.
    bumpSeekOsd(delta);
    var wasPlaying = Sequencer.isPlaying();
    try { Sequencer.seek(delta); } catch (e) { return; }
    try {
      if (wasPlaying) {
        Sequencer.play();
      } else {
        Store.setState({ timeSec: Sequencer.getTime() });
      }
    } catch (e) { /* engine hiccup after a rejected seek — ignore */ }
  }

  // ── Playback speed stepping ±0.1x (Key 3 up / Key 1 down) ──
  // Round to one decimal so repeated presses never accumulate
  // floating-point drift (0.30000000004-style values).
  function stepSpeed(delta) {
    var s = Store.getState();
    var next = Math.round(((s.speed || 1.0) + delta) * 10) / 10;
    next = Math.min(8.0, Math.max(0.1, next));
    if (next !== s.speed) Store.setState({ speed: next });
  }

  // ── Menu open ──
  function openMenu() {
    Store.setState({ menu: { open: true } });
    var app = document.getElementById('app');
    if (app) app.classList.add('menu-open');
    var el = document.getElementById('menu-overlay');
    if (el) {
      // Instant show — remove .hidden so CSS rules take over visibility.
      el.classList.remove('hidden');
      refreshAnalyzeCanItem();
      var items = el.querySelectorAll('.kai-om-item:not(.hidden)');
      if (items.length > 0) {
        _focusedItemIndex = 0;
        focusOverlayItem(items, 0);
      }
    }
    // Make sure the labels reflect the current fullscreen/rotate state at
    // the moment the menu opens (the user may have flipped state via OS
    // gesture or hardware key without going through this app's menu).
    refreshMenuLabels();
    // Grey out Note Color Randomise while the bundled demo self-plays.
    refreshDemoLock();
    updateSoftkeys();
  }

  // ── Softkey labels ──
  function updateSoftkeys() {
    refreshAnalyzeCanItem();
    var leftE  = document.getElementById('sk-left');
    var rightE = document.getElementById('sk-right');
    var ctrE   = document.getElementById('sk-center');

    // Error dialog overrides every other softkey state (centre OK only)
    var _eOpen = false;
    try {
      if (typeof window.isErrorDialogOpen === 'function') _eOpen = window.isErrorDialogOpen();
      else {
        var _ed2 = document.getElementById('error-dialog');
        _eOpen = !!(_ed2 && !_ed2.classList.contains('hidden'));
      }
    } catch (ig2) {}
    if (_eOpen) {
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent   = 'OK';
      if (rightE) rightE.textContent = '';
      return;
    }

    var s = Store.getState();
    var menuOpen = s.menu && s.menu.open;
    var settingsOpen = (typeof Settings !== 'undefined' &&
                        Settings.isOpen && Settings.isOpen());

    if (aboutOpen()) {
      // About is read-only — only Back applies.
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent   = '';
      if (rightE) rightE.textContent = 'Back';
    } else if (menuOpen) {
      // Options menu — center SELECT activates the focused item. When the
      // focused item is locked (Note Color Randomise while demo / no file),
      // hide SELECT so it cannot be activated.
      var focusedItem = document.querySelector('#menu-list .kai-om-item.focused');
      // Hide SELECT when the focused item is locked (Note Color Randomise
      // while demo / no file) OR beta-locked (MIDI-OUT under construction) —
      // those rows can't be activated via the center key, so advertising a
      // SELECT label on them would be misleading. perm-locked keeps its
      // SELECT: pressing it routes to the grant-path dialog instead of the
      // picker (see 'load-midi' handler).
      var fLocked = focusedItem &&
        (focusedItem.classList.contains('demo-locked') ||
         focusedItem.classList.contains('beta-locked'));
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent   = fLocked ? '' : 'SELECT';
      if (rightE) rightE.textContent = '';
    } else if (settingsOpen) {
      // Drill-in rows (Keyboard Range / Info Card Options / color
      // pickers) advertise their action with a center SELECT label,
      // mirroring the Options menu. Plain value rows keep labels blank.
      var subOv = document.getElementById('subsettings-overlay');
      var subOpen = !!(subOv && !subOv.classList.contains('hidden'));
      var selRow = (!subOpen)
        ? document.querySelector('#settings-list .setting-row.focused')
        : null;
      var selType = selRow ? selRow.getAttribute('data-type') : null;
      // Drill-in ('sub' / color) AND one-shot action rows (Developer:
      // Memory Stats / Export Log / Storage Test) advertise the center
      // action with a "SELECT" label, mirroring the Options menu.
      if (ctrE) ctrE.textContent = (selType === 'sub' || selType === 'color' || selType === 'action') ? 'SELECT' : '';
      if (leftE)  leftE.textContent  = '';
      if (rightE) rightE.textContent = '';
    } else {
      // Analysis in flight (piano only): everything cedes to Cancel — the
      // right softkey is the big red button, centre is held idle so PLAY/
      // PAUSE can't be triggered mid-parse.
      if (analyzingNow()) {
        if (leftE)  leftE.textContent  = 'Options';
        if (ctrE)   ctrE.textContent   = '';
        if (rightE) rightE.textContent = 'Cancel';
      } else {
      // Demo self-play: hide PLAY/PAUSE and lock speed/stop/restart.
      // Options stays so a real .mid/.note can stop the demo at any time.
      var isDemo = false;
      try { isDemo = typeof window.isDemoActive === 'function' && window.isDemoActive(); } catch (igD) {}
      if (isDemo) {
        if (leftE)  leftE.textContent  = 'Options';
        if (ctrE)   ctrE.textContent   = '';
        if (rightE) rightE.textContent = '';
      } else {
      var hasFile = !!s.fileName;
      // PAUSE also while a countdown is RUNNING (press = hold it);
      // PLAY when idle, held, or stopped.
      var busy = (s.play === 'play') ||
                 (s.startCountdown != null && s.cdRunning);
      if (leftE)  leftE.textContent  = 'Options';
      if (ctrE)   ctrE.textContent   = hasFile ? (busy ? 'PAUSE' : 'PLAY') : '';
      if (rightE) rightE.textContent = '';
      }
      }
    }
  }

  function kaiOSVolumeManager() {
    return (typeof navigator !== 'undefined' && navigator.volumeManager) || null;
  }

  /**
   * Step the OS media volume up or down via KaiOS navigator.volumeManager.
   * Mirrors the Audio Visualizer reference implementation, which fires
   * requestUp/requestDown on Arrow Up/Down and the user sees the OS
   * OSD slide.
   *
   * @param dir  +1 to step up, -1 to step down
   */
  function adjustVolume(dir) {
    var vm = kaiOSVolumeManager();
    if (!vm) {
      // Fallback: show toast so the user knows nothing happened
      showToast('Volume: KaiOS API unavailable');
      return;
    }
    if (dir > 0) {
      try { vm.requestUp(); } catch (e) { showToast('Vol up failed'); return; }
    } else if (dir < 0) {
      try { vm.requestDown(); } catch (e) { showToast('Vol down failed'); return; }
    } else {
      try { vm.requestShow(); } catch (e) {}
      return;
    }
    // OS handles the OSD slide. We deliberately do NOT touch sk-center so
    // the softkey row stays as "SELECT" / "Back" while user adjusts volume
    // from inside the Options menu.
  }

  // ── OS volume OSD (picked from Options menu) ──
  // Close Options and ask the OS to slide in the media-volume OSD.
  // ArrowUp/Down already step volume during normal gameplay, so there
  // is no need for a temporary input lock here — the OSD is purely
  // visual feedback for the current level.
  function showOSDVolume() {
    closeMenuOverlay();
    var vm = kaiOSVolumeManager();
    if (!vm) {
      showToast('Volume: KaiOS API unavailable');
      return;
    }
    try { vm.requestShow(); } catch (e) {
      showToast('Volume show failed');
    }
  }

  // ── Settings sub-page launcher ──
  // Drill-in: instant hide of the Options menu overlay, then the
  // Settings overlay slides IN from the right. Back reverses: the
  // menu reappears beneath the Settings overlay as it slides OUT to
  // the right. We use the slide animations defined in kaiui.css.
  function openSettingsGroup(group) {
    if (typeof Settings === 'undefined') {
      console.error('[Ctrl] Settings module missing');
      closeMenuOverlay();
      return;
    }
    var appEl = document.getElementById('app');
    var m = document.getElementById('menu-overlay');

    // Drop focus highlight
    var items = document.querySelectorAll('#menu-list .kai-om-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.remove('focused');
    }

    // Hide menu, mark closed in Store
    Store.setState({ menu: { open: false, focus: _focusedItemIndex } });
    if (appEl) appEl.classList.remove('menu-open');
    if (m) {
      m.classList.add('hidden');
      m.style.display = '';
      m.style.transform = '';
    }

    // Open Settings panel. onClose restores Options menu.
    Settings.open(group, function () {
      if (m) {
        m.classList.remove('hidden');
        m.style.display = '';
        m.style.transform = '';
      }
      Store.setState({ menu: { open: true, focus: _focusedItemIndex } });
      if (appEl) appEl.classList.add('menu-open');
      var its = m ? m.querySelectorAll('.kai-om-item:not(.hidden)') : [];
      if (its.length) focusOverlayItem(its, _focusedItemIndex);
      if (typeof refreshMenuLabels === 'function') refreshMenuLabels();
      if (typeof updateSoftkeys === 'function') updateSoftkeys();
    });

    if (typeof updateSoftkeys === 'function') updateSoftkeys();
  }

  // ── Toast notification ──
  var _toastTimer = null;
  function showToast(msg) {
    var el = document.getElementById('now-playing');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('fade-out', 'hidden');
    el.classList.add('fade-in');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      el.classList.remove('fade-in');
      el.classList.add('fade-out');
    }, 2500);
  }

  // ── "Now Playing" center toast ──
  // Implemented in main.js (window.showNowPlaying) so the MozActivity
  // load path can reuse it. Playback start (dispatchAction playPause)
  // calls it from here — do NOT redefine it in this module, main.js
  // loads last and would silently override it.
  window.updateSoftkeys = updateSoftkeys;
  window.refreshMenuLabels = refreshMenuLabels;

  // ── Launch ──
  console.log('[Controls] calling init()');
  init();

  // Keep menu labels honest when the orientation flips outside the menu —
  // hardware key on KaiOS 2.5 (or manual phone rotation) can fire
  // orientationchange before the user opens Options.
  if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', refreshMenuLabels);
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('orientationchange', refreshMenuLabels);
  }
})();