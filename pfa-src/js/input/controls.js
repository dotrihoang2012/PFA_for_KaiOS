/**
 * controls.js — KaiOS hardware key → Store state.
 *   SoftLeft  → left softkey
 *   SoftRight → right softkey
 *   Enter     → center (select)
 *   Backspace → back / exit overlay
 *   ArrowLeft/Right → seek -1s / +1s
 *   ArrowUp/Down    → OS media volume up / down
 *   Key 1..9 / * / # / Call → piano size, render mode, rotate, load MIDI,
 *   fullscreen, key range, clear, auto play, note trail, info card
 *   EndCall   → quit app
 *
 *   MozActivity picker for file loading (native KaiOS)
 *   Fullscreen toggle + Screen rotation
 */
(function () {
  console.log('[Controls] IIFE start');
  'use strict';

  var _focusedItemIndex = 0;
  var _devOkCount = 0;
  var _devOkTmr = null;

  function init() {
    window.addEventListener('keydown', onKeyDown, false);
    // Some KaiOS builds only surface the Star/Hash digits via the keypress
    // event (keydown gives keyCode 0 / empty e.key). Route those here too.
    window.addEventListener('keypress', onKeyPress, false);
  }

  function onKeyPress(e) {
    var k = e.keyCode || e.key;
    if (k !== 42 && k !== '*' && k !== 35 &&
        k !== '#' && k !== 'Star' && k !== 'Hash') return;
    e.preventDefault();
    dispatchAction(k === 42 || k === '*' || k === 'Star' ? 'trailDown' : 'trailUp');
  }

  function onKeyDown(e) {
    // Bootstrap AudioContext on first interaction
    try { if (typeof _engine === 'function') _engine().ensure(); else Synth.ensure(); } catch (ign) {}

    var key = e.keyCode || e.key;
    if (key === undefined || key === null || key === '') return;

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

    // ── Reset-confirm dialog: modal; LSK = OK, RSK / Back = Cancel.
    //    Checked right after the error dialog so it blocks menu/play too.
    if (isResetConfirmOpen()) {
      e.preventDefault();
      if (key === 'SoftLeft' || key === Constants.KEY.SOFT_LEFT ||
          key === 13 || key === Constants.KEY.ENTER || key === 'Enter') {
        doResetAll();
        return;
      }
      if (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK) {
        hideResetConfirm();
        return;
      }
      return;
    }

    if (typeof Settings !== 'undefined' && Settings.isSfDeleteConfirmOpen && Settings.isSfDeleteConfirmOpen()) {
      e.preventDefault();
      if (key === 'SoftLeft' || key === Constants.KEY.SOFT_LEFT ||
          key === 13 || key === Constants.KEY.ENTER || key === 'Enter') {
        Settings.doSfDelete();
        return;
      }
if (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK) {
        Settings.hideSfDeleteConfirm();
        return;
      }
      return;
    }

    // ── Clear-Media confirm dialog (Synth → Preload): LSK = OK,
    //    RSK / Back = Cancel.
    if (typeof Settings !== 'undefined' && Settings.isMediaClearConfirmOpen && Settings.isMediaClearConfirmOpen()) {
      e.preventDefault();
      if (key === 'SoftLeft' || key === Constants.KEY.SOFT_LEFT ||
          key === 13 || key === Constants.KEY.ENTER || key === 'Enter') {
        Settings.doMediaClear();
        return;
      }
      if (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK) {
        Settings.hideMediaClearConfirm();
        return;
      }
      return;
    }

    // ── Developer-menu dialogs (stack above About). Confirm: OK on LSK,
    //    Cancel on RSK/Back. Acknowledgment: single centre-OK.
    if (isDevConfirmOpen()) {
      e.preventDefault();
      if (key === 'SoftLeft' || key === Constants.KEY.SOFT_LEFT ||
          key === 13 || key === Constants.KEY.ENTER || key === 'Enter') {
        optInDeveloperMenu();
      } else if (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK) {
        hideDevConfirm();
      }
      return;
    }
    if (isDevDoneOpen()) {
      e.preventDefault();
      if (key === 13 || key === Constants.KEY.ENTER || key === 'Enter' ||
          key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
          key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK) {
        hideDevDone();
      }
      return;
    }

    // ── About panel: modal; Back / SoftRight dismiss it back
    //    to the piano screen. ArrowUp/Down SCROLL the content — KaiOS
    //    handsets have no touch input, so the D-pad must do it.
    //    The centre OK key counts presses: 5 in a row reveal the hidden
    //    Developer menu (easter egg).
    if (aboutOpen()) {
      e.preventDefault();
      if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
          key === 'Back' || key === Constants.KEY.BACK ||
          key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT) {
        hideAbout();
        return;
      }
      if (key === 13 || key === Constants.KEY.ENTER || key === 'Enter') {
        _devOkCount++;
        if (_devOkTmr) { clearTimeout(_devOkTmr); _devOkTmr = null; }
        if (_devOkCount >= 5) {
          _devOkCount = 0;
          openDevConfirm();
        } else {
          // Incomplete streak — if the user stops pressing for 5s the
          // count resets and the next OK starts over from 1.
          _devOkTmr = setTimeout(function () {
            _devOkCount = 0;
            _devOkTmr = null;
          }, 5000);
        }
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

    if (typeof Settings !== 'undefined') {
if (Settings.isSfDoneOpen && Settings.isSfDoneOpen()) {
        e.preventDefault();
        if (key === 13 || key === Constants.KEY.ENTER || key === 'Enter' ||
            key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
            key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
            key === 'Back' || key === Constants.KEY.BACK) {
          Settings.hideSfDoneDialog();
        }
        return;
      }
      if (Settings.isMediaClearedConfirmOpen && Settings.isMediaClearedConfirmOpen()) {
        e.preventDefault();
        if (key === 13 || key === Constants.KEY.ENTER || key === 'Enter' ||
            key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
            key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
            key === 'Back' || key === Constants.KEY.BACK) {
          Settings.hideMediaClearedConfirm();
        }
        return;
      }
      if (Settings.isSfLoading && Settings.isSfLoading()) {
        e.preventDefault();
        if (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT ||
            key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
            key === 'Back' || key === Constants.KEY.BACK) {
          Settings.cancelSfLoading();
        }
        return;
      }
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
      // KaiOS hardware VOLUME ROCKER stays LIVE inside System settings.
      // The rocker is keyCode 175 (VolumeUp) / 174 (VolumeDown) with e.key
      // 'VolumeUp'/'VolumeDown' — NOT ArrowUp/Down (38/40), which Settings
      // uses to navigate its list. Swallowing the rocker here would leave
      // ONLY the OSD showing with no actual step (exactly the bug: "it just
      // brings up the volume display, but doesn't raise/lower the volume").
      // Bypass the guard and let adjustVolume() step the OS media volume
      // (requestUp/Down slides the OSD AND changes the level).
      if (key === 'VolumeUp' || key === Constants.KEY.VOLUME_UP ||
          key === 'VolumeDown' || key === Constants.KEY.VOLUME_DOWN) {
        e.preventDefault();
        adjustVolume(key === 'VolumeUp' || key === Constants.KEY.VOLUME_UP ? +1 : -1);
        return;
      }
      // Many KaiOS handsets do NOT have a separate hardware volume rocker
      // (keyCode 175/174) — only a D-pad. On those devices the bypass branch
      // above never runs. Desired behavior: only once the user actually
      // PRESSES (Enter/OK) the "Volume" row — i.e. showOSDVolume() has run —
      // do we enter "volume-adjust mode" (_volumeAdjustActive = true); only
      // then do Up/Down adjust the volume. Just having FOCUS on that row
      // (without pressing Enter) still moves focus like any other row.
      if (_volumeAdjustActive) {
        if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP ||
            key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
          e.preventDefault();
          adjustVolume((key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) ? +1 : -1);
          // More activity → extend the timeout another 3s from this press.
          _armVolumeAdjustTimeout();
          return;
        }
        // On some KaiOS handsets, each physical volume-key press fires 2
        // keydown events back to back: a harmless "MicrophoneToggle" event
        // (does nothing) RIGHT BEFORE the real ArrowUp/ArrowDown event. This
        // must be ignored (not treated as exiting volume-adjust mode),
        // otherwise this spurious event would turn off _volumeAdjustActive
        // before the real Up/Down event gets a chance to run.
        if (key === 'MicrophoneToggle') {
          e.preventDefault();
          return;
        }
        // The first Back press only EXITS volume-adjust mode (back to normal
        // list browsing) — it doesn't close the Settings page as well.
        if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
            key === 'Back' || key === Constants.KEY.BACK) {
          e.preventDefault();
          _volumeAdjustActive = false;
          _clearVolumeAdjustTimeout();
          return;
        }
        // Any other key (Enter, Left/Right, changing row…) → exit
        // volume-adjust mode and let that key fall through to normal handling.
        _volumeAdjustActive = false;
        _clearVolumeAdjustTimeout();
      }
      // While a settings text field holds focus (KaiUI-style text entry),
      // printable keys must reach the input NATIVELY — preventDefault
      // here would silently kill typing. Only editing-control keys
      // (Back / Enter / RSK) are intercepted and routed to Settings.
      var ae = document.activeElement;
      var isTextField = !!(ae && ae.tagName === 'INPUT');
      var isEditKey = (key === 8 || key === 'Backspace' ||
                       key === 13 || key === Constants.KEY.ENTER ||
                       key === 'Back' || key === Constants.KEY.BACK ||
                       key === 'ArrowUp' || key === Constants.KEY.ARROW_UP ||
                       key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN);
      if (isTextField && !isEditKey) {
        return; // pass through untouched: digits, '*', '#', caret keys?
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
    var action = normalizeAction(key, e);
    if (!action) return;
    // Hardware Back (keyCode 8) = run the app in the BACKGROUND. Do NOT
    // consume it: let KaiOS's native Back background the app while its
    // process (track + audio) keeps running. End Call is the quit. (The
    // KEY_MAP now maps 8 -> 'back', so this no longer clears.)
    if (action === 'back') {
      return;
    }
    e.preventDefault();
    dispatchAction(action);
  }

  // Normalise the raw key code to an action name, with extra tolerance for
  // KaiOS quirks on the Star/Hash hardware keys (some builds report
  // keyCode 0, some report '8'/'9' with Alt/shift set, most populate e.key).
  function normalizeAction(key, ev) {
    // eager string forms
    var m = Constants.KEY_MAP[key];
    if (m) return m;
    // Star → '*'/'Star'; Hash → '#'/'Hash'
    if (key === 42 || key === '*' || key === 'Star') return 'trailDown';
    if (key === 35 || key === '#' || key === 'Hash') return 'trailUp';
    // Tolerate a shifted Key8 (56) that some builds use for '*'
    if (key === 56 && ev && (ev.altKey || ev.shiftKey)) key = 42;
    // Tolerate a shifted Key9 (57) used for '#'
    if (key === 57 && ev && (ev.altKey || ev.shiftKey)) key = 35;
    // Re-look-up after the shift-tolerant translation
    return Constants.KEY_MAP[key];
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
    // Menu path (legacy): close the menu so About reads as a modal.
    // Nested path (Settings → System → About): the menu is already
    // hidden by openSettingsGroup — closing it here would reset
    // _focusedItemIndex to -1 and lose the focus restore on return.
    var settingsOpen = !!(typeof Settings !== 'undefined' &&
                          Settings.isOpen && Settings.isOpen());
    if (!settingsOpen) closeMenuOverlay();
    var ov = document.getElementById('about-overlay');
    if (ov) {
      // Reset scroll so long content starts from the top every time.
      var nav = ov.querySelector('#about-list');
      if (nav) nav.scrollTop = 0;
      ov.classList.remove('hidden');
    }
    // Fresh press-count for the Developer easter egg each time About opens.
    if (_devOkTmr) { clearTimeout(_devOkTmr); _devOkTmr = null; }
    _devOkCount = 0;
    updateSoftkeys();
  }

  function hideAbout() {
    if (_devOkTmr) { clearTimeout(_devOkTmr); _devOkTmr = null; }
    _devOkCount = 0;
    var ov = document.getElementById('about-overlay');
    if (ov) ov.classList.add('hidden');
    updateSoftkeys();
  }

  // ── Developer-menu easter egg ──
  // Options → About This App → press the centre OK key 5× in a row → a
  // confirm dialog ("Enable developer menu mode?") pops over About. OK
  // reveals the Developer settings entry (menu + settings hub) and shows
  // a second acknowledgment dialog (About stays open). Cancel aborts and
  // keeps the Developer row hidden. Persisted in localStorage.
  var DEV_STORAGE_KEY = 'midiPlayer.devEnabled';
  function devEnabled() {
    try { return localStorage.getItem(DEV_STORAGE_KEY) === '1'; }
    catch (e) { return false; }
  }
  function setDevEnabled(on) {
    try {
      if (on) localStorage.setItem(DEV_STORAGE_KEY, '1');
      else localStorage.removeItem(DEV_STORAGE_KEY);
    } catch (e) {}
    if (typeof window !== 'undefined') window.__devEnabled = !!on;
    refreshDevVisibility();
    if (typeof updateSoftkeys === 'function') updateSoftkeys();
  }
  function refreshDevVisibility() {
    var m = document.getElementById('menu-list');
    if (!m) return;
    var row = m.querySelector('.kai-om-item[data-action="open-dev"]');
    if (row) {
      if (devEnabled()) row.classList.remove('hidden');
      else row.classList.add('hidden');
    }
  }
  function isDevConfirmOpen() {
    var ov = document.getElementById('devmenu-dialog');
    return !!(ov && !ov.classList.contains('hidden'));
  }
  function openDevConfirm() {
    var ov = document.getElementById('devmenu-dialog');
    if (ov) {
      var msg = ov.querySelector('.kai-dialog-content p');
      if (msg) {
        if (devEnabled()) {
          msg.setAttribute('data-l10n-id', 'disable_dev_menu');
          msg.textContent = typeof L10n !== 'undefined' ? L10n.t('disable_dev_menu', 'Disable developer menu mode?') : 'Disable developer menu mode?';
        } else {
          msg.setAttribute('data-l10n-id', 'enable_dev_menu');
          msg.textContent = typeof L10n !== 'undefined' ? L10n.t('enable_dev_menu', 'Enable developer menu mode?') : 'Enable developer menu mode?';
        }
      }
      ov.classList.remove('hidden');
    }
    updateSoftkeys();
  }
  function hideDevConfirm() {
    var ov = document.getElementById('devmenu-dialog');
    if (ov) ov.classList.add('hidden');
    updateSoftkeys();
  }
  function optInDeveloperMenu() {
    hideDevConfirm();
    var wasOn = devEnabled();
    setDevEnabled(!wasOn);
    openDevDone(wasOn);
  }
  function isDevDoneOpen() {
    var ov = document.getElementById('devmenu-done-dialog');
    return !!(ov && !ov.classList.contains('hidden'));
  }
  function openDevDone(wasOn) {
    var ov = document.getElementById('devmenu-done-dialog');
    if (ov) {
      var msg = ov.querySelector('.kai-dialog-content p');
      if (msg) {
        if (wasOn) {
          msg.setAttribute('data-l10n-id', 'dev_menu_disabled');
          msg.textContent = typeof L10n !== 'undefined' ? L10n.t('dev_menu_disabled', 'Developer menu disabled in settings') : 'Developer menu disabled in settings';
        } else {
          msg.setAttribute('data-l10n-id', 'dev_menu_enabled');
          msg.textContent = typeof L10n !== 'undefined' ? L10n.t('dev_menu_enabled', 'Developer menu enabled in settings') : 'Developer menu enabled in settings';
        }
      }
      ov.classList.remove('hidden');
    }
    updateSoftkeys();
  }
  function hideDevDone() {
    var ov = document.getElementById('devmenu-done-dialog');
    if (ov) ov.classList.add('hidden');
    updateSoftkeys();
  }

  // ── Reset-all confirm dialog ──
  // Modal asking for confirmation before a factory reset. Unlike the
  // error dialog (single centre OK), this one exposes OK on the LEFT
  // softkey and Cancel on the RIGHT softkey / Back so cancel is always
  // one press away. The menu stays open underneath — cancel drops the
  // user straight back into the Options list.
  function isResetConfirmOpen() {
    var ov = document.getElementById('confirm-dialog');
    return !!(ov && !ov.classList.contains('hidden'));
  }

  function openResetConfirm() {
    var ov = document.getElementById('confirm-dialog');
    if (ov) ov.classList.remove('hidden');
    updateSoftkeys();
  }

  function hideResetConfirm() {
    var ov = document.getElementById('confirm-dialog');
    if (ov) ov.classList.add('hidden');
    updateSoftkeys();
  }

  function doResetAll() {
    hideResetConfirm();
    closeMenuOverlay();
    try {
      if (typeof Settings !== 'undefined' && Settings.reset) {
        Settings.reset();
        // Reset-from-System-settings: silently drop the settings overlay
        // too (suppress its onClose so the Options menu does NOT reopen).
        // Net result — OK on the confirm dialog lands back on the piano.
        if (typeof Settings.close === 'function') Settings.close(true);
        if (typeof showToast === 'function') showToast('All settings reset');
      } else if (typeof showToast === 'function') {
        showToast('Reset unavailable');
      }
    } catch (e) {
      console.error('[Ctrl] reset-all error', e);
      if (typeof showToast === 'function') showToast('Reset failed');
    }
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
            showInfoOsd(L10n.t('osd_colors_randomised', 'Colors Randomised'));
          }
        } catch (e) { console.error('[Ctrl] random-colors failed', e); }
        return;
      case 'settings':
        openSettingsGroup('hub');
        return;
      case 'open-synth':
        openSettingsGroup('midi');
        return;
      case 'open-visual':
        openSettingsGroup('visual');
        return;
      case 'open-dev':
        // Developer menu stays hidden until the About easter egg unlocks
        // it — route a stray activation to the hub instead.
        if (devEnabled()) openSettingsGroup('dev');
        else openSettingsGroup('hub');
        return;
      case 'open-sys':
        openSettingsGroup('sys');
        return;
      case 'about':
        showAbout();
        return;
      case 'reset-all':
        // Confirm dialog: OK on LSK, Cancel on RSK/Back. Never reset
        // silently — a factory reset is destructive and hard to undo.
        openResetConfirm();
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
      // Own activity launched → the system may hide our window meanwhile; keep
      // the "PFA is running" notification suppressed while the picker is up
      // (our blur/visibilitychange handlers check window._pickerOpen).
      window._pickerOpen = true;
      var act = new MozActivity({ name: 'pick' });
      act.onsuccess = function (res) {
        window._pickerOpen = false;
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
        window._pickerOpen = false;
        updateChromeAfterPicker();
        console.log('[Ctrl] MozActivity pick cancelled');
      };
    } catch (e) {
      window._pickerOpen = false;
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
    // "Load MIDI/Note File" → "Change MIDI/Note File" while a real file is
    // loaded (not during the bundled demo — demo isn't "their" file).
    var hasRealFile = false;
    try {
      var stFile = Store.getState();
      hasRealFile = !!(stFile.fileName) &&
                    (typeof window.isDemoActive !== 'function' || !window.isDemoActive());
    } catch (eF) { hasRealFile = false; }
    for (var i = 0; i < items.length; i++) {
      var a = items[i].getAttribute('data-action');
      if (a === 'load-midi') {
        items[i].textContent = hasRealFile ? L10n.t('menu_change_file', 'Change MIDI/Note File') : L10n.t('menu_load_file', 'Load MIDI/Note File');
      } else if (a === 'fullscreen') {
        items[i].textContent = inFS ? L10n.t('exit_full_screen', 'Exit Full Screen') : L10n.t('fullscreen', 'Fullscreen');
      } else if (a === 'rotate') {
        if (!rotSupported) {
          items[i].textContent = L10n.t('rotate', 'Rotate Screen');
        } else if (isLandscape) {
          items[i].textContent = L10n.t('rotate_portrait', 'Rotate To Portrait');
        } else {
          items[i].textContent = L10n.t('rotate_landscape', 'Rotate To Landscape');
        }
      } else if (a === 'volume') {
        items[i].textContent = L10n.t('volume', 'Volume');
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
  // Fixed cycle: portrait-primary → landscape-primary →
  // landscape-secondary → portrait-secondary → portrait-primary …
  // (press 1 = landscape-primary, 2 = landscape-secondary,
  // 3 = portrait-secondary, 4 = back to portrait-primary).
  var ROT_CYCLE = ['portrait-primary', 'landscape-primary',
                   'landscape-secondary', 'portrait-secondary'];
  function rotateScreen() {
    try {
      if (!('orientation' in screen) || !screen.orientation || !screen.orientation.lock) {
        showToast('Rotation not supported');
        return;
      }
      var type = '';
      try { type = screen.orientation.type || ''; } catch (e) {}
      var idx = 0; // portrait-primary, plain 'portrait', or unknown
      if (type.indexOf('landscape-primary') === 0) idx = 1;
      else if (type.indexOf('landscape-secondary') === 0) idx = 2;
      else if (type.indexOf('portrait-secondary') === 0) idx = 3;
      var next = ROT_CYCLE[(idx + 1) % ROT_CYCLE.length];
      var r = screen.orientation.lock(next);
      if (r && r.catch) r.catch(function () { try { showToast('Rotation not supported'); } catch (e2) {} });
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
    if (el) {
      var show = engineBusy();
      el.classList.toggle('hidden', !show);
    }
    // Settings' System group carries its own Cancel Analysis row — rebuild
    // it live so it appears during an analysis and disappears when one ends.
    if (typeof Settings !== 'undefined' && Settings.refreshCurrentRows) {
      try { Settings.refreshCurrentRows(); } catch (e) {}
    }
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
    if (!silent) showPlaybackOsd(L10n.t('osd_play', 'Play'));
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
      showPlaybackOsd(L10n.t('osd_play', 'Play'));
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
      var lockedActions = {
        playPause: 1, stop: 1, restart: 1,
        seekBack: 1, seekForward: 1,
        speedStepUp: 1, speedStepDown: 1, speedUp: 1, speedDown: 1,
        trailUp: 1, trailDown: 1,
        cyclePianoSize: 1, cycleRenderMode: 1, toggleKeyRange: 1
      };
      if (lockedActions[action]) {
        if (typeof showToast === 'function') showToast('Locked until a file loads');
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
            showPlaybackOsd(L10n.t('osd_pause', 'Pause'));
          } else {
            Store.setState({ cdRunning: true });  // resume
            showPlaybackOsd(L10n.t('osd_play', 'Play'));
          }
          break;
        }
        if (s.play === 'play') {
          Store.setState({ play: 'pause' });
          showPlaybackOsd(L10n.t('osd_pause', 'Pause'));
          break;
        }
        // Countdown applies ONLY to a fresh start from the beginning
        // (play === 'stop'). Resume-from-pause must continue instantly.
        var delaySec = Number(s.startDelay);
        if (s.play === 'stop' && delaySec > 0) {
          armCountdown(delaySec);
          showPlaybackOsd(L10n.t('osd_play', 'Play'));
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
        if (s.fileName) showInfoOsd(L10n.t('osd_stop', 'Stop'));
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
        setVisual('speed', Math.min(4.0, s.speed * 2));
        showSpeedOsd();
        break;
      case 'speedDown':
        setVisual('speed', Math.max(0.25, s.speed / 2));
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
        if (s.fileName) showInfoOsd(L10n.t('osd_restart', 'Restart'));
        break;
      case 'loadMidi':
        // Same storage-permission guard as the Options menu item.
        try {
          if (typeof window.pfaStorageGranted === 'function' && !window.pfaStorageGranted()) {
            if (typeof window.pfaGuardStorageLoad === 'function') window.pfaGuardStorageLoad(false);
            break;
          }
        } catch (e) {}
        launchFilePicker();
        break;
      case 'clearMidi':
        // Mirrors execMenuAction('clear-midi'): hard-stop + drop the track.
        try {
          Sequencer.stop();
          Sequencer.load([], [], 480);
          Store.setState({ play: 'stop', notes: [], fileName: '', timeSec: 0 });
          if (typeof HUD !== 'undefined' && HUD.setTotal) HUD.setTotal(0);
          window._midiBlob = null;
          window._rawMidiBuffer = null;
          if (typeof window.clearPfaTmp === 'function') {
            try { window.clearPfaTmp(); } catch (eC) {}
          }
          if (s.fileName) showInfoOsd(L10n.t('osd_clear', 'Clear'));
        } catch (e) { console.error('[Ctrl] clearMidi error', e); }
        break;
      case 'toggleFullscreen':
        var _wasFS = !!(document.fullscreenElement || document.mozFullScreenElement);
        toggleFullscreen();
        showInfoOsd(_wasFS ? L10n.t('exit_full_screen', 'Exit Full Screen') : L10n.t('fullscreen', 'Fullscreen'));
        break;
      case 'rotateScreen':
        rotateScreen();
        showInfoOsd(L10n.t('rotate', 'Rotate'));
        break;
      case 'cycleRenderMode':
        _cycleStoreOpts(['auto', 'individual', 'buffer'], 'renderMode', 'Render');
        break;
      case 'toggleAutoPlay':
        var _ap = !s.autoPlay;
        setVisual('autoPlay', _ap);
        showInfoOsd(L10n.t('opt_autoplay', 'Auto Play') + ': ' + (_ap ? L10n.t('opt_on', 'On') : L10n.t('opt_off', 'Off')));
        break;
      case 'cyclePianoSize':
        _cycleStoreOpts(['big', 'small', 'none'], 'pianoSize', 'Piano size');
        break;
      case 'toggleKeyRange':
        // 88 keys (A0–C8: 21..108) ↔ 128 keys (0..127). Routed through
        // Settings.setKbPreset so the Key Count preset in Visual →
        // Keyboard Range stays in sync with the hotkey.
        var _is128 = (Number(s.kbStart) <= 0 && Number(s.kbEnd) >= 127);
        if (typeof Settings !== 'undefined' && Settings.setKbPreset) {
          Settings.setKbPreset(_is128 ? '88' : '128');
        } else {
          if (_is128) {
            Store.setState({ kbStart: 21, kbEnd: 108 });
          } else {
            Store.setState({ kbStart: 0, kbEnd: 127 });
          }
        }
        showInfoOsd(_is128 ? L10n.t('opt_88', '88 Keys') : L10n.t('opt_128', '128 Keys'));
        try { window.dispatchEvent(new Event('resize')); } catch (eR) {}
        break;
      case 'toggleInfoCard':
        var _ic = !s.infoCard;
        setVisual('infoCard', _ic); // applyInfoCard side-effect runs inside applyVisual
        // OSD (same style as "+1 sec") — not a toast, not a stat row.
        showInfoOsd(L10n.t('opt_infocard', 'Info Card') + ': ' + (_ic ? L10n.t('opt_show', 'Show') : L10n.t('opt_hide', 'Hide')));
        break;
      case 'trailUp':
        stepTrail(+0.1);
        break;
      case 'trailDown':
        stepTrail(-0.1);
        break;
      case 'randomColors':
        // Mirrors the Options→Random note color track action: locked until a
        // real file is loaded, then regenerates all 16 channel colours.
        try {
          if (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked()) {
            if (typeof showToast === 'function') showToast('Locked until a file loads');
            break;
          }
        } catch (e) {}
        try {
          if (typeof Notes !== 'undefined' && Notes.randomizePalette) {
            Notes.randomizePalette();
            showInfoOsd(L10n.t('osd_colors_randomised', 'Colors Randomised'));
          }
        } catch (e) { console.error('[Ctrl] randomColors failed', e); }
        break;
      case 'toggleAudio':
        // RSK on the piano screen: mute / unmute the master audio. Routed
        // through Settings.setAudio so the Synth → Audio Output row AND the
        // persisted value stay in sync with this runtime toggle.
        var _audioNext = (s.audio === false);
        if (typeof Settings !== 'undefined' && Settings.setAudio) {
          Settings.setAudio(_audioNext);
        } else {
          Store.setState({ audio: _audioNext });
        }
        // Audio OSD is FULLSCREEN-ONLY (showPlaybackOsd checks #app.fullscreen),
        // and during the demo #hud is hidden so nothing shows anyway.
        showPlaybackOsd(L10n.t('audio_output', 'Audio') + ': ' + (_audioNext ? L10n.t('on', 'On') : L10n.t('off', 'Off')));
        break;
      case 'back':
        // Handled before dispatch in onKeyDown (pass-through to the OS so it
        // backgrounds the app). Reached only via other paths — no-op.
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
    showInfoOsd(v.toFixed(1) + 'x ' + L10n.t('hud_speed', 'Speed').replace('Speed: ', '').replace('Speed', 'Speed'));
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
    // Preload media follows the ±1s seek too (main.js hook).
    if (typeof window._mediaSeek === 'function') { try { window._mediaSeek(delta); } catch (e) {} }
    // Integrated platform audio follows seeks the same way.
    if (typeof window._integSeek === 'function') { try { window._integSeek(delta); } catch (e) {} }
    try {
      if (wasPlaying) {
        Sequencer.play();
      } else {
        Store.setState({ timeSec: Sequencer.getTime() });
      }
    } catch (e) { /* engine hiccup after a rejected seek — ignore */ }
  }

  // Mirror a hotkey value change back into Visual settings (persistence +
  // the settings module's _values copy), so the Settings overlays show the
  // live value next time they open. Falls back to a plain Store write if
  // the settings module isn't ready.
  function setVisual(key, val) {
    if (typeof Settings !== 'undefined' && Settings.applyVisual) {
      Settings.applyVisual(key, val);
    } else {
      var p = {};
      p[key] = val;
      Store.setState(p);
    }
  }

  // ── Playback speed stepping ±0.1x (Key 3 up / Key 1 down) ──
  // Round to one decimal so repeated presses never accumulate
  // floating-point drift (0.30000000004-style values).
  function stepSpeed(delta) {
    var s = Store.getState();
    var next = Math.round(((s.speed || 1.0) + delta) * 10) / 10;
    next = Math.min(8.0, Math.max(0.1, next));
    if (next !== s.speed) setVisual('speed', next);
  }

  // Note Trail via Store setState — the render path is polled by the
  // sequencer/notes every frame, so no extra side-effects needed.
  function stepTrail(delta) {
    var s = Store.getState();
    var next = Math.round(((typeof s.trail === 'number' ? s.trail : 1.0) + delta) * 10) / 10;
    next = Math.min(8.0, Math.max(0.1, next));
    if (next !== s.trail) setVisual('trail', next);
    showInfoOsd(L10n.t('opt_trail', 'Trail') + ' ' + next.toFixed(1));
  }

  // Cycle an enum Store key forwards through `values`, then show an OSD.
  // Visual enums are mirrored into the settings module so the General /
  // Piano pages reflect the hotkey choice.
  function _cycleStoreOpts(values, key, label) {
    var s = Store.getState();
    var idx = values.indexOf(s[key]);
    idx = (idx < 0 ? -1 : idx);
    var next = values[(idx + 1) % values.length];
    setVisual(key, next);
    var tLabel = L10n.t('opt_' + key, label) || label;
    var tNext = next;
    // Map values to translations
    if (next === 'auto') tNext = L10n.t('opt_auto', 'Auto');
    if (next === 'individual') tNext = L10n.t('opt_individual', 'Individual');
    if (next === 'buffer') tNext = L10n.t('opt_buffer', 'Buffer');
    if (next === 'big') tNext = L10n.t('opt_big', 'Big');
    if (next === 'small') tNext = L10n.t('opt_small', 'Small');
    if (next === 'none') tNext = L10n.t('opt_none', 'None');
    showInfoOsd(tLabel + ': ' + tNext);
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
    // Keep the Developer row honest (hidden until the About easter egg).
    refreshDevVisibility();
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
      if (ctrE)   ctrE.textContent = L10n.t('softkey_ok', 'OK');
      if (rightE) rightE.textContent = '';
      return;
    }

    // Developer-menu confirm dialog: LSK = OK, RSK = Cancel.
    if (isDevConfirmOpen()) {
      if (leftE)  leftE.textContent = L10n.t('softkey_ok', 'OK');
      if (ctrE)   ctrE.textContent   = '';
      if (rightE) rightE.textContent = L10n.t('softkey_cancel', 'Cancel');
      return;
    }

    // Developer-menu acknowledgment dialog: centre OK only.
    if (isDevDoneOpen()) {
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent = L10n.t('softkey_ok', 'OK');
      if (rightE) rightE.textContent = '';
      return;
    }

    if (typeof Settings !== 'undefined') {
if (Settings.isSfDoneOpen && Settings.isSfDoneOpen()) {
        if (leftE)  leftE.textContent  = '';
        if (ctrE)   ctrE.textContent   = L10n.t('softkey_ok', 'OK');
        if (rightE) rightE.textContent = '';
        return;
      }
      if (Settings.isMediaClearedConfirmOpen && Settings.isMediaClearedConfirmOpen()) {
        if (leftE)  leftE.textContent  = '';
        if (ctrE)   ctrE.textContent   = L10n.t('softkey_ok', 'OK');
        if (rightE) rightE.textContent = '';
        return;
      }
      if (Settings.isSfLoading && Settings.isSfLoading()) {
        if (leftE)  leftE.textContent  = '';
        if (ctrE)   ctrE.textContent   = '';
        if (rightE) rightE.textContent = L10n.t('softkey_cancel', 'Cancel');
        return;
      }
    }


    // Reset-confirm dialog: LSK = OK, RSK = Cancel, centre held idle.
    if (isResetConfirmOpen()) {
      if (leftE)  leftE.textContent = L10n.t('softkey_ok', 'OK');
      if (ctrE)   ctrE.textContent   = '';
      if (rightE) rightE.textContent = L10n.t('softkey_cancel', 'Cancel');
      return;
    }

    if (typeof Settings !== 'undefined' && Settings.isSfDeleteConfirmOpen && Settings.isSfDeleteConfirmOpen()) {
      if (leftE)  leftE.textContent = L10n.t('softkey_ok', 'OK');
      if (ctrE)   ctrE.textContent   = '';
      if (rightE) rightE.textContent = L10n.t('softkey_cancel', 'Cancel');
      return;
    }

    // Clear-Media confirm dialog — same OK / Cancel bar as above.
    if (typeof Settings !== 'undefined' && Settings.isMediaClearConfirmOpen && Settings.isMediaClearConfirmOpen()) {
      if (leftE)  leftE.textContent = L10n.t('softkey_ok', 'OK');
      if (ctrE)   ctrE.textContent   = '';
      if (rightE) rightE.textContent = L10n.t('softkey_cancel', 'Cancel');
      return;
    }

    var s = Store.getState();
    var menuOpen = s.menu && s.menu.open;
    var settingsOpen = (typeof Settings !== 'undefined' &&
                        Settings.isOpen && Settings.isOpen());
    // RSK on the piano toggles the master audio — reflect the live state.
    var audioLabel = L10n.t('softkey_audio', 'Audio') + ': ' +
                     ((s.audio !== false) ? L10n.t('on', 'On') : L10n.t('off', 'Off'));

    if (aboutOpen()) {
      // About is read-only — only Back applies.
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent   = '';
      if (rightE) rightE.textContent = L10n.t('softkey_back', 'Back');
    } else if (menuOpen) {
      // Options menu — center SELECT activates the focused item. When the
      // focused item is locked (Note Color Randomise while demo / no file),
      // hide SELECT so it cannot be activated.
      var focusedItem = document.querySelector('#menu-list .kai-om-item.focused');
      // Hide SELECT when the focused item is locked (Note Color Randomise
      // while demo / no file) OR beta-locked (Synth under construction) —
      // those rows can't be activated via the center key, so advertising a
      // SELECT label on them would be misleading. perm-locked keeps its
      // SELECT: pressing it routes to the grant-path dialog instead of the
      // picker (see 'load-midi' handler).
      var fLocked = focusedItem &&
        (focusedItem.classList.contains('demo-locked') ||
         focusedItem.classList.contains('beta-locked'));
      if (leftE)  leftE.textContent  = '';
      if (ctrE)   ctrE.textContent = fLocked ? '' : L10n.t('softkey_select', 'Select').toUpperCase();
      if (rightE) rightE.textContent = '';
    } else if (settingsOpen) {
      // Drill-in rows (Keyboard Range / Info Card Options / color
      // pickers) advertise their action with a center SELECT label,
      // mirroring the Options menu. Plain value rows keep labels blank.
      var subOv = document.getElementById('subsettings-overlay');
      var subOpen = !!(subOv && !subOv.classList.contains('hidden'));

      // ── SoundFont loader ───────────────────────────────────────────
      // Scan sub-page (subkind 'soundfonts'): LSK = All / Deselect All,
      // center = Select (Scan checkbox rows), RSK = Finish. Replaces the
      // generic settings softkeys on that ONE page.
      var sfSub = (subOpen && typeof Settings.subKind === 'function' &&
                   Settings.subKind() === 'soundfonts');
      if (sfSub) {
        var sfSel = !!document.querySelector('#subsettings-list .sf-row.focused') ||
                    (function () {
                      var sfA = document.querySelector('#subsettings-list .setting-row.focused');
                      return !!(sfA && sfA.getAttribute && sfA.getAttribute('data-type') === 'action');
                    })();
        if (leftE)  leftE.textContent = Settings.sfAllChecked() ? L10n.t('softkey_deselect_all', 'Deselect All') : L10n.t('softkey_select_all', 'Select All');
        if (ctrE)   ctrE.textContent = sfSel ? L10n.t('softkey_select', 'Select') : '';
        if (rightE) rightE.textContent = L10n.t('softkey_finish', 'Finish');
        return;
      }

      var selT = null;
      if (subOpen) {
        // Inside a sub-page: SELECT on any row that drills in further
        // (color page within Info Card Options / sliders are plain rows).
        var fRow = document.querySelector('#subsettings-list .setting-row.focused');
        if (fRow) selT = fRow.getAttribute('data-type');
        // Palette rows and loadmore also accept Enter → SELECT.
        if (!selT) {
          var fPal = document.querySelector('#subsettings-list .palette-row.focused');
          if (fPal) selT = 'palette';
        }
        if (!selT) {
          var fPalAct = document.querySelector('#subsettings-list .palette-action.focused');
          if (fPalAct) selT = 'action';
        }
        if (!selT) {
          var fLoad = document.querySelector('#subsettings-list .palette-loadmore.focused');
          if (fLoad) selT = 'action';
        }
      } else {
        var selRow = document.querySelector('#settings-list .setting-row.focused');
        if (selRow) selT = selRow.getAttribute('data-type');
      }

      // Loaded-SoundFont row in the Synth group: LSK = Delete,
      // center = Select, RSK = Move / Done (Move mode toggle).
      if (selT === 'sfrow') {
        var moveMode = (typeof Settings.isMoveMode === 'function' && Settings.isMoveMode());
        if (leftE)  leftE.textContent = moveMode ? L10n.t('softkey_done', 'Done') : L10n.t('softkey_move', 'Move');
        if (ctrE)   ctrE.textContent = moveMode ? '' : L10n.t('softkey_select', 'Select');
        if (rightE) rightE.textContent = moveMode ? L10n.t('softkey_cancel', 'Cancel') : L10n.t('softkey_delete', 'Delete');
        return;
      }
      // AND Graphics radio rows advertise the center action with a
      // "SELECT" label.
      if (ctrE) ctrE.textContent = (selT === 'sub' || selT === 'color' || selT === 'action' || selT === 'sfaction' || selT === 'palette' || selT === 'radio') ? L10n.t('softkey_select', 'Select').toUpperCase() : '';
      if (leftE)  leftE.textContent  = '';
      if (rightE) rightE.textContent = '';
    } else {
      // Analysis in flight (piano only): everything cedes to Cancel — the
      // right softkey is the big red button, centre is held idle so PLAY/
      // PAUSE can't be triggered mid-parse.
      if (analyzingNow()) {
        if (leftE)  leftE.textContent = L10n.t('softkey_settings', 'Settings');
        if (ctrE)   ctrE.textContent   = '';
        if (rightE) rightE.textContent = L10n.t('softkey_cancel', 'Cancel');
      } else {
      // Demo self-play: hide PLAY/PAUSE and lock speed/stop/restart.
      // Settings stays so a real .mid/.note can stop the demo at any time.
      var isDemo = false;
      try { isDemo = typeof window.isDemoActive === 'function' && window.isDemoActive(); } catch (igD) {}
      if (isDemo) {
        if (leftE)  leftE.textContent = L10n.t('softkey_settings', 'Settings');
        if (ctrE)   ctrE.textContent   = '';
        if (rightE) rightE.textContent = audioLabel;
      } else {
      var hasFile = !!s.fileName;
      // PAUSE also while a countdown is RUNNING (press = hold it);
      // PLAY when idle, held, or stopped.
      var busy = (s.play === 'play') ||
                 (s.startCountdown != null && s.cdRunning);
      if (leftE)  leftE.textContent = L10n.t('softkey_settings', 'Settings');
      if (ctrE)   ctrE.textContent = hasFile ? (busy ? L10n.t('osd_pause', 'Pause').toUpperCase() : L10n.t('osd_play', 'Play').toUpperCase()) : '';
      if (rightE) rightE.textContent = audioLabel;
      }
      }
    }
  }

  // True only while the user is in "volume-adjust mode" inside Settings —
  // turned on by showOSDVolume() (when Enter/OK is pressed on the "Volume"
  // row) and turned off when leaving that mode (see onKeyDown +
  // openSettingsGroup) or after 3 seconds with no key press (_armVolumeAdjustTimeout).
  var _volumeAdjustActive = false;
  var _volumeAdjustTimer = null;

  function _clearVolumeAdjustTimeout() {
    if (_volumeAdjustTimer) { clearTimeout(_volumeAdjustTimer); _volumeAdjustTimer = null; }
  }
  // (Re)start the 3s countdown: once it elapses with no further key press →
  // auto-cancel volume-adjust mode (the OS's own OSD hides itself too).
  function _armVolumeAdjustTimeout() {
    _clearVolumeAdjustTimeout();
    _volumeAdjustTimer = setTimeout(function () {
      _volumeAdjustActive = false;
      _volumeAdjustTimer = null;
    }, 3000);
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
    // Skip closeMenuOverlay when launched from Settings (menu already
    // hidden by openSettingsGroup) — closing it here would reset
    // _focusedItemIndex to -1 and lose the focus restore on return.
    var settingsOpen = !!(typeof Settings !== 'undefined' &&
                          Settings.isOpen && Settings.isOpen());
    if (!settingsOpen) closeMenuOverlay();
    var vm = kaiOSVolumeManager();
    if (!vm) {
      showToast('Volume: KaiOS API unavailable');
      return;
    }
    try { vm.requestShow(); } catch (e) {
      showToast('Volume show failed');
      return;
    }
    // The user just ACTIVELY pressed the "Volume" row → turn on
    // volume-adjust mode so Up/Down (D-pad) adjusts the volume instead of
    // moving the list focus. After 3s with no further key press, auto-cancel.
    if (settingsOpen) {
      _volumeAdjustActive = true;
      _armVolumeAdjustTimeout();
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

    // Starting a fresh Settings session → always begin in list-browsing state.
    _volumeAdjustActive = false;
    _clearVolumeAdjustTimeout();

    // Open Settings panel. onClose restores Options menu.
    Settings.open(group, function () {
      _volumeAdjustActive = false;
      _clearVolumeAdjustTimeout();
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

  // ── Info-card feedback (formerly the bottom-left white-text toast) ──
  // Every popup-style message ("Locked until a file loads", "Palette: …",
  // "Rotation not supported", …) now renders INSIDE the info card via the
  // seek-OSD slot (#hud-osd) and auto-hides after 3s — one feedback surface
  // instead of a floating white pill. Locked-type warnings show simply as
  // "Locked". Exposed on window so settings.js shares the same sink.
  function _toastLabel(msg) {
    return (/^Locked/i.test(msg)) ? 'Locked' : msg;
  }
  function showToast(msg) {
    try {
      if (typeof HUD === 'undefined' || !HUD.showOsd) return;
      HUD.showOsd(_toastLabel(String(msg)), 3000);
    } catch (e) { try { console.error('[Ctrl] toast->osd', e); } catch (e2) {} }
  }
  window.showToast = showToast;

  // ── "Now Playing" center toast ──
  // Implemented in main.js (window.showNowPlaying) so the MozActivity
  // load path can reuse it. Playback start (dispatchAction playPause)
  // calls it from here — do NOT redefine it in this module, main.js
  // loads last and would silently override it.
  window.updateSoftkeys = updateSoftkeys;
  window.refreshMenuLabels = refreshMenuLabels;
  window.devEnabled = devEnabled;
  window.openDevConfirm = openDevConfirm;
  window.hideDevConfirm = hideDevConfirm;
  window.hideDevDone = hideDevDone;

  // ── Hooks for Settings (System group) + boot ──
  window.showAboutApp = showAbout;
  window.openResetConfirm = openResetConfirm;
  window.toggleFullscreen = toggleFullscreen;
  window.rotateScreen = rotateScreen;
  window.showOSDVolume = showOSDVolume;

  // Clear the loaded MIDI (System → Clear). Same work as the old Options
  // "Clear" item, minus overlay manipulation: called from Settings, the
  // menu isn't open, and resetting _focusedItemIndex would break the
  // focus restore when the user backs out.
  window.clearMidiAction = function () {
    try {
      Sequencer.stop();
      Sequencer.load([], [], 480);
      Store.setState({ play: 'stop', notes: [], fileName: '', timeSec: 0 });
      if (typeof HUD !== 'undefined' && HUD.setTotal) HUD.setTotal(0);
      window._midiBlob = null;
      window._rawMidiBuffer = null;
      if (typeof window.clearPfaTmp === 'function') {
        try { window.clearPfaTmp(); } catch (e) { console.error('[Ctrl] clearPfaTmp error', e); }
      }
      setTimeout(function () {
        if (typeof updateSoftkeys === 'function') updateSoftkeys();
      }, 0);
    } catch (e) { console.error('[Ctrl] clear-midi error', e); }
  };

  // Launch the MozActivity file picker (System → Load/Change MIDI/Note
  // File). Storage-permission guard mirrors the old Options item. When
  // opened from Settings, the settings overlay is dropped silently so
  // the user lands back on the piano after the picker returns.
  window.launchPickerAction = function () {
    try {
      if (typeof window.pfaStorageGranted === 'function' && !window.pfaStorageGranted()) {
        if (typeof window.pfaGuardStorageLoad === 'function') window.pfaGuardStorageLoad(false);
        return;
      }
    } catch (e) {}
    try {
      if (typeof Settings !== 'undefined' && Settings.isOpen && Settings.isOpen() &&
          typeof Settings.close === 'function') {
        Settings.close(true);
      }
    } catch (e) {}
    launchFilePicker();
  };

  // Apply launch-time System settings (Auto Full Screen / Auto Rotate).
  // main.js calls this right after Settings.load() so Store holds the
  // persisted toggle values. Guarded so a missing API never breaks boot.
  window.applySystemSettings = function () {
    var st;
    try { st = Store.getState(); } catch (e) { return; }
    if (!st) return;
    var app = document.getElementById('app');
    var fsOn = !!(document.fullscreenElement || document.mozFullScreenElement) ||
               !!(app && app.classList.contains('fullscreen'));
    if (st.autoFullscreen && !fsOn) {
      try { toggleFullscreen(); } catch (e) { console.error('[Ctrl] auto-fullscreen failed', e); }
    }
    if (st.autoRotate) {
      try {
        var t = (screen.orientation && screen.orientation.type) || '';
        if (t.indexOf('landscape') === -1) rotateScreen();
      } catch (e) { console.error('[Ctrl] auto-rotate failed', e); }
    }
  };

  // ── Launch ──
  console.log('[Controls] calling init()');
  init();

  // Desktop click fallback for the reset dialog: tapping the dim overlay
  // cancels (mirrors the error dialog behaviour in main.js).
  (function () {
    var cd = document.getElementById('confirm-dialog');
    if (cd) {
      cd.addEventListener('click', function (e) {
        if (e.target === cd) hideResetConfirm();
      });
    }
  })();

  // Desktop click fallback for the dev-menu dialogs (dim overlay cancels).
  (function () {
    var cd1 = document.getElementById('devmenu-dialog');
    if (cd1) {
      cd1.addEventListener('click', function (e) {
        if (e.target === cd1) hideDevConfirm();
      });
    }
    var cd2 = document.getElementById('devmenu-done-dialog');
    if (cd2) {
      cd2.addEventListener('click', function (e) {
        if (e.target === cd2) hideDevDone();
      });
    }
  })();

  // Keep the Developer row honest at boot (persisted unlock state).
  refreshDevVisibility();

  // Keep menu labels honest when the orientation flips outside the menu —
  // hardware key on KaiOS 2.5 (or manual phone rotation) can fire
  // orientationchange before the user opens Options.
  if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', refreshMenuLabels);
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('orientationchange', refreshMenuLabels);
  }
})();