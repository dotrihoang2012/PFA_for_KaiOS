/**
 * controls.js — KaiOS hardware key → Store state.
 *   SoftLeft  → left softkey
 *   SoftRight → right softkey
 *   Enter     → center (select)
 *   Backspace → back / exit overlay
 *   ArrowUp/Down → focus-based list navigation
 *   EndCall  → quit app
 *
 *   MozActivity picker for file loading (native KaiOS)
 *   Fullscreen toggle + Screen rotation
 */
(function () {
  console.log('[Controls] IIFE start');
  'use strict';

  var _focusedItemIndex = 0;
  // Volume OSD lock: when user picks Volume in Options, we close the
  // menu, slide the OS OSD on, and for as long as the OSD is showing
  // arrow keys are routed to OS volume (not keyboard zoom/scroll).
  // The OS owns ArrowUp/Down inside the OSD, so this is mostly a
  // defence against the residual event when our app also sees it.
  var _osdVolumeLock = false;
  var _osdLockTimer = null;

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

    // ── Back: closes menu / Settings if open, otherwise hands control to
    //    OS so the hardware Back button quits the app. ──
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
        key === 'Back' || key === Constants.KEY.BACK) {
      if (typeof Settings !== 'undefined' && Settings.isOpen && Settings.isOpen()) {
        e.preventDefault();
        Settings.close();
        return;
      }
      if (menuOpen) {
        e.preventDefault();
        closeMenuOverlay();
        return;
      }
      // Piano screen — let Back bubble to OS so it quits the app.
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
      e.preventDefault();
      if (typeof Settings.handleKey === 'function') {
        Settings.handleKey(key);
      }
      return;
    }

    // ── OSD volume lock (after picking Volume in Options) ──
    // While the OS volume OSD is showing, ArrowUp/Down only step the
    // OS media volume; nothing else in our canvas should move (no
    // keyboard zoom, no scroll). Back can pre-empt the lock.
    if (_osdVolumeLock) {
      if (key === Constants.KEY.ARROW_UP || key === 'ArrowUp') {
        e.preventDefault();
        adjustVolume(+1);
        return;
      }
      if (key === Constants.KEY.ARROW_DOWN || key === 'ArrowDown') {
        e.preventDefault();
        adjustVolume(-1);
        return;
      }
      if (key === 'Backspace' || key === Constants.KEY.BACKSPACE) {
        e.preventDefault();
        releaseOSDVolumeLock();
        return;
      }
      // Any other key falls through to normal gameplay.
    }

    // ── Gameplay mode ──
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
    var items = document.querySelectorAll('#menu-list .kai-om-item');

    // Backspace / SoftRight = exit overlay
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
        key === Constants.KEY.SOFT_RIGHT || key === 'SoftRight') {
      closeMenuOverlay();
      return;
    }

    // ArrowUp / ArrowDown = move focus
    if (key === Constants.KEY.ARROW_UP || key === 'ArrowUp') {
      _focusedItemIndex = Math.max(0, _focusedItemIndex - 1);
      focusOverlayItem(items, _focusedItemIndex);
      return;
    }
    if (key === Constants.KEY.ARROW_DOWN || key === 'ArrowDown') {
      var max = Math.max(0, items.length - 1);
      _focusedItemIndex = Math.min(max, _focusedItemIndex + 1);
      if (_focusedItemIndex < 0) _focusedItemIndex = 0;
      focusOverlayItem(items, _focusedItemIndex);
      return;
    }

    // Enter / SoftLeft = select focused item
    if (key === Constants.KEY.ENTER || key === 13 ||
        key === Constants.KEY.SOFT_LEFT || key === 'SoftLeft') {
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
  }

  function closeAllOverlays() {
    closeMenuOverlay();
  }

  // Drop focus + state on overlay close. Visibility is owned by .hidden
  // in CSS — toggling it gives an instant show/hide.
  function closeMenuOverlay() {
    Store.setState({ menu: { open: false } });
    releaseOSDVolumeLock();
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
    var menuItems = document.querySelectorAll('#menu-list .kai-om-item');
    var action = menuItems[index] && menuItems[index].getAttribute('data-action');
    if (action) execMenuAction(action);
  }

  function execMenuAction(action) {
    switch (action) {
      case 'close':
        closeMenuOverlay();
        return;
      case 'load-midi':
        launchFilePicker();
        return;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'rotate':
        rotateScreen();
        break;
      case 'volume':
        enterOSDVolumeLock();
        return;
      case 'midi-output':
        openSettingsGroup('midi');
        return;
      case 'visual':
        openSettingsGroup('visual');
        return;
      default:
        console.log('[Ctrl] unknown menu action: ' + action);
    }
    closeMenuOverlay();
  }

  // ── File picker via MozActivity ──
  function launchFilePicker() {
    // Close menu overlay but keep chrome visible for MozActivity
    Store.setState({ menu: { open: false } });
    var appEl = document.getElementById('app');
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
    // Show loading
    if (typeof window.showParsing === 'function') window.showParsing();

    var isMidi = name.toLowerCase().endsWith('.mid');
    Store.setState({ fileName: name });

    // The user just committed to loading a file — drop fullscreen now so
    // they're not stuck looking at a chrome-less canvas if parse later
    // fails. exitFullscreenIfActive is idempotent (no-op when not in FS).
    if (typeof window.exitFullscreenIfActive === 'function') {
      window.exitFullscreenIfActive();
    }

    if (isMidi) {
      // Read as array buffer → parse MIDI
      var reader = new FileReader();
      reader.onload = function () {
        if (typeof MidiParser !== 'undefined') {
          try {
            var midiData = MidiParser.parseMIDI(reader.result);
            // Reference via window.* — loadMIDIData lives in main.js IIFE,
            // not in ours, so `typeof loadMIDIData` would be 'undefined'.
            if (typeof window.loadMIDIData === 'function') {
              window.loadMIDIData(midiData);
            }
          } catch (e) {
            console.error('[Ctrl] MIDI parse error', e);
            if (typeof window.hideParsing === 'function') window.hideParsing();
          }
        }
      };
      reader.onerror = function () {
        console.error('[Ctrl] FileReader error');
        if (typeof window.hideParsing === 'function') window.hideParsing();
      };
      reader.readAsArrayBuffer(blob);
    } else {
      // Assume JSON
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

  // ── Gameplay actions ──
  function dispatchAction(action) {
    var s = Store.getState();
    switch (action) {
      case 'playPause':
        Store.setState({ play: (s.play === 'play') ? 'pause' : 'play' });
        break;
      case 'stop':
        Store.setState({ play: 'stop', timeSec: 0 });
        break;
      case 'zoomDeeper':
        Store.setState({ keyWidth: Math.max(Constants.UI.KEY_W_MIN, s.keyWidth - 2) });
        break;
      case 'zoomWider':
        Store.setState({ keyWidth: Math.min(Constants.UI.KEY_W_MAX, s.keyWidth + 2) });
        break;
      case 'scrollLeft':
        Store.setState({ camKey: Math.max(0, s.camKey - 2) });
        break;
      case 'scrollRight':
        Store.setState({ camKey: Math.min(110, s.camKey + 2) });
        break;
      case 'speedUp':
        Store.setState({ speed: Math.min(4.0, s.speed * 2) });
        break;
      case 'speedDown':
        Store.setState({ speed: Math.max(0.25, s.speed / 2) });
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
        break;
      case 'back':
        break;
      default: break;
    }
    updateSoftkeys();
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
      var items = el.querySelectorAll('.kai-om-item');
      if (items.length > 0) {
        _focusedItemIndex = 0;
        focusOverlayItem(items, 0);
      }
    }
    // Make sure the labels reflect the current fullscreen/rotate state at
    // the moment the menu opens (the user may have flipped state via OS
    // gesture or hardware key without going through this app's menu).
    refreshMenuLabels();
    updateSoftkeys();
  }

  // ── Softkey labels ──
  function updateSoftkeys() {
    var leftE  = document.getElementById('sk-left');
    var rightE = document.getElementById('sk-right');
    var ctrE   = document.getElementById('sk-center');

    var s = Store.getState();
    var menuOpen = s.menu && s.menu.open;
    var settingsOpen = (typeof Settings !== 'undefined' &&
                        Settings.isOpen && Settings.isOpen());

    if (menuOpen) {
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent   = 'SELECT';
      if (rightE) rightE.textContent = '';
    } else if (settingsOpen) {
      // Settings rows are value-toggled with Left/Right and exited
      // with Backspace — no softkey labels needed. The user
      // navigates by feel; the keyboard layout is already cue
      // enough.
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent   = '';
      if (rightE) rightE.textContent = '';
    } else {
      var hasFile = !!s.fileName;
      if (leftE)  leftE.textContent  = 'Options';
      if (ctrE)   ctrE.textContent   = hasFile ? ((s.play === 'play') ? 'PAUSE' : 'PLAY') : '';
      if (rightE) rightE.textContent = '';
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

  // ── Volume OSD lock (picked from Options menu) ──
  // User asked: pressing Volume closes Options, leaves just piano,
  // and only Volume acts on arrow keys. So we kill the menu,
  // request the OSD, and for ~3.5s the ArrowUp/Down in our window
  // only step OS volume. Back is a manual escape hatch.
  function enterOSDVolumeLock() {
    // 1. close Options overlay immediately
    closeMenuOverlay();
    // 2. ask OS to show media-volume OSD
    var vm = kaiOSVolumeManager();
    if (!vm) {
      showToast('Volume: KaiOS API unavailable');
      return;
    }
    try { vm.requestShow(); } catch (e) {
      showToast('Volume show failed');
    }
    // 3. arm the lock
    _osdVolumeLock = true;
    if (_osdLockTimer) clearTimeout(_osdLockTimer);
    // OS HIDE_SOUND_DELAY=2000ms (sound_manager.js). Lock arrows for
    // exactly that window so user can toggle volume while OSD is up;
    // right after OSD hides, arrows return to nav.
    _osdLockTimer = setTimeout(releaseOSDVolumeLock, 2000);
    showToast('Volume - Up/Down adjust');
  }
  
  function releaseOSDVolumeLock() {
    _osdVolumeLock = false;
    if (_osdLockTimer) {
      clearTimeout(_osdLockTimer);
      _osdLockTimer = null;
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
    releaseOSDVolumeLock();
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
      var its = m ? m.querySelectorAll('.kai-om-item') : [];
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

  // ── "Now Playing" toast ──
  var _npTimer = null;
  function showNowPlaying(filePath) {
    var el = document.getElementById('now-playing');
    if (!el) return;
    var fileName = filePath.split('/').pop()
      .replace('.mid.json', '').replace('.mid', '').replace('.json', '');
    el.textContent = 'Now Playing: ' + fileName;
    el.classList.remove('fade-out', 'hidden');
    el.classList.add('fade-in');
    if (_npTimer) clearTimeout(_npTimer);
    _npTimer = setTimeout(function () {
      el.classList.remove('fade-in');
      el.classList.add('fade-out');
    }, 3000);
  }
  window.showNowPlaying = showNowPlaying;
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