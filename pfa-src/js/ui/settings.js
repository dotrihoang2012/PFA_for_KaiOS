/**
 * settings.js — Settings sub-page renderer + persistence.
 *
 * Two groups of settings, both surfaced as overlays reachable from
 * the Options menu:
 *
 *   - MIDI Output   (sound engine, waveform)
 *   - Visual        (render mode, speed, Note Trail,
 *                    note labels, Info Card Options, Keyboard Range,
 *                    Background/Bar/Piano Color, Piano Size)
 *   - Developer     (On-screen verbose status, Verbose while analyzing,
 *                    Export log)
 *
 * Level-2 sub-pages (drilled from Visual rows):
 *   - Keyboard Range → two sliders (Start / End note), live-applied.
 *   - Color pickers  → preset swatch grid + R/G/B/A sliders, live-applied.
 *
 * Persistence: localStorage.midiPlayer.settings = { midi:{...}, visual:{...} }
 * (per plan: avoids polluting Store's runtime state shape with persist-specific
 * fields; Store holds only the live values.)
 *
 * Navigation model — same as Options menu (see controls.js):
 *   ArrowUp/Down → move focus
 *   Enter / SoftLeft / ArrowRight → cycle value forward
 *   ArrowLeft → cycle value backward
 *   Enter / ArrowRight on 'sub'/'color' rows → drill into the sub-page
 *   Backspace / SoftRight → exit (sub-page back to group, group to menu)
 *
 * Live-apply: every change pushes to Store via setState and triggers the
 * CSS-variable / sprite-rebuild subsystems in main.js + keyboard.js.
 */
var Settings = (function () {
  'use strict';

  console.log('[Settings] module loaded');

  var STORAGE_KEY = 'midiPlayer.settings';

  var DEFAULTS = {
    midi: {
      engine:       'synth',   // 'synth' | 'soundbank'
      waveform:     'square',  // 'sine' | 'square' | 'saw' | 'triangle'
      audio:        true,      // master audio on/off toggle
      skipSlowOpen: true,      // skip an absurdly slow opening tempo (< 30 BPM)
    },
    visual: {
      renderMode:   'auto',    // 'auto' | 'individual' | 'buffer'
      speed:        1.0,       // 0.1 .. 8.0 (slider)
      trail:        1.0,       // Note Trail, 0.1 .. 8.0 (moved from MIDI group)
      autoPlay:     false,     // start playback automatically after load
      showDialog:   true,      // show "Analyzing MIDI…" / "Now playing" pills
      showOsd:      true,      // show the info-bar action OSD (+1 sec / 1.1x…)
      pctAnalyze:   false,     // show the % readout during analysis (parse) — Loading Bar page
      pctMerge:     false,     // show the % readout during the merge stage — Loading Bar page
      pctBarVisible: true,     // show/hide the loading bar itself — Loading Bar page
      loadAnimated: true,      // sliding sweep (true) vs. gradual 0→100% fill (false) — Loading Bar page
      loadBarColor: '#0088FF', // RGBA color of the loading bar (default blue) — Loading Bar page
      pctColor:     '#FFFFFF', // RGBA color of the % readout text (default white) — Loading Bar page
      dialogTextColor: '#FFFFFF', // center pill text RGBA (default white) — Dialog page
      dialogBgColor:   '#000000', // center pill background RGBA (default black) — Dialog page
      startDelay:   0,         // Start Delay seconds (0 = Off, slider 0..10)
      theme:        'dark',    // 'dark' | 'light' | 'blue' | 'purple'
      noteLabels:   false,
      middleMarker: true,    // square dot marking the middle note on the keys
      // Info card (HUD): master gate + per-stat switches
      infoCard:      true,
      infoNps:       true,
      infoNoteCount: true,
      infoPassed:    true,
      infoSpeed:     true,
      infoTime:      true,
      infoFps:       true,
      infoPolyphony:    true,
      infoRendered:     true,
      infoAudioBuffer:  true,
      infoTick:         true,
      infoBpm:          true,
      // Info card (HUD) appearance
      infoFloating:     false,    // detached "floating" style (gap from screen edge)
      infoBorder:       false,    // border around the card
      infoBorderColor:  '#ffffff',// border colour RGBA (only when infoBorder On)
      infoBgColor:      '#000000',// background RGBA (default black)
      infoTextColor:    '#ffffff',// text RGBA (default white)
      infoPos:          'left',   // 'left' | 'right'
      kbStart:      21,        // Keyboard Range first visible MIDI note (A0)
      kbEnd:        108,       // Keyboard Range last visible MIDI note (C8)
      kbSize:       '88',      // Keyboard Range preset: '88' | '128' | 'custom'
      bgColor:      null,      // null = follow --theme-bg CSS token
      bgImageUrl:   null,      // persisted data URL of the background image
      bgImageName:  '',        // source file name, shown in Settings
      bgImagePath:  '',        // source file path (empty = not checkable)
      barColor:     '#8B0000', // separator line between notes band and piano
      pianoColorHex:'#f2f2f2', // white-key fill
      pianoSize:    'big',     // 'big' | 'small' | 'none'
      view3d:       'both',    // 'keyboard' | 'notefall' | 'both' | 'none'
      palette:      'random',  // active note color palette id
    },
    dev: {
      osdLog:         false,   // On-screen verbose status overlay
      verboseAnalyze: false,   // show [LOG] detail in analysis progress
    },
    sys: {
      autoFullscreen: false,   // enter fullscreen automatically on launch
      autoRotate:     false,   // rotate to landscape automatically on launch
    }
  };

  // Preset swatch palette for the level-2 color picker (grid order).
  var SWATCHES = [
    '#FFFFFF','#CCCCCC','#999999','#666666','#333333',
    '#000000','#FF4477','#FF0000','#FF8800','#FFDD00',
    '#88DD00','#00CC44','#00DDAA','#00CCFF','#0088FF',
    '#3355FF','#6644EE','#9933FF','#DD33AA','#FF66AA',
    '#AA5500','#886600','#116655','#007799','#223377'
  ];

  // ── Schema for each group (label, key, type, choices/values, fmt) ──
  // Row types: 'enum' | 'number' | 'bool' | 'sub' (drill-in page) |
  //            'color' (drill-in to swatch grid + R/G/B/A sliders)
  var SCHEMA = {
    midi: [
      { key: 'audio',        label: 'Audio',            type: 'bool' },
      { key: 'engine',       label: 'Sound Engine',    type: 'enum',
        choices: [['synth','Synth'],['soundbank','Soundbank']] },
      { key: 'waveform',     label: 'Waveform',        type: 'enum',
        choices: [['sine','Sine'],['square','Square'],['saw','Saw'],['triangle','Triangle']] },
      { key: 'skipSlowOpen', label: 'Skip Slow Intro', type: 'bool' },
    ],
visual: [
      { key: 'general',     label: 'General',         type: 'sub', subkind: 'general' },
      { key: 'loadingBar',  label: 'Loading Bar',      type: 'sub', subkind: 'loadingBar' },
      { key: 'dialog',      label: 'Dialog',           type: 'sub', subkind: 'dialog' },
      { key: 'graphics',    label: 'Graphics',        type: 'sub', subkind: 'graphics' },
      { key: 'infoCard',    label: 'Info Card',        type: 'sub', subkind: 'bools' },
      { key: 'piano',       label: 'Piano',            type: 'sub', subkind: 'piano' },
      { key: 'palette',     label: 'Note Color',       type: 'sub', subkind: 'palettes' },
    ],
    dev: [
      { key: 'osdLog',         label: 'Verbose Status', type: 'bool' },
      { key: 'verboseAnalyze', label: 'Verbose while analyzing',  type: 'bool' },
      { key: 'memory',         label: 'Memory Stats',             type: 'action' },
      { key: 'exportLog',      label: 'Export Log',               type: 'action' },
      { key: 'storageTest',    label: 'Storage Test',             type: 'action' },
    ],
    sys: [
      { key: 'loadMidi',       label: 'Load MIDI/Note File', type: 'action', labelFn: sysLoadLabel },
      { key: 'cancelAnalysis', label: 'Cancel Analysis',     type: 'action', hidden: function () { return !_analysisBusy(); } },
      { key: 'clearMidi',      label: 'Clear',               type: 'action' },
      { key: 'fullscreen',     label: 'Full Screen',         type: 'action' },
      { key: 'rotate',         label: 'Rotate Screen',       type: 'action' },
      { key: 'volume',         label: 'Volume',              type: 'action' },
      { key: 'autoFullscreen', label: 'Auto Full Screen',    type: 'bool' },
      { key: 'autoRotate',     label: 'Auto Rotate Screen',  type: 'bool' },
      { key: 'resetAll',       label: 'Reset All Settings',  type: 'action' },
      { key: 'about',          label: 'About This App',      type: 'action' },
      { key: 'developer',      label: 'Developer',           type: 'sub', subkind: 'developer',
        hidden: function () {
          var en = false;
          try { en = !!(window.__devEnabled || (window.devEnabled && window.devEnabled())); } catch (e) {}
          return !en;
        } },
    ],
    hub: [
      { key: 'system',    label: 'System',    type: 'sub', subkind: 'system' },
      { key: 'visual',    label: 'Visual',    type: 'sub', subkind: 'visual' },
      { key: 'synth',     label: 'Synth',     type: 'sub', subkind: 'synth' },
    ]
  };

  // Hub → real settings group mapping (Options → Settings sub-menu).
  // subkind of a hub row selects which group its overlay shows. The
  // Developer row inside System opens as a SUBSETTINGS page (list-style),
  // so it intentionally has NO entry here.
  var HUB_GROUP_MAP = { synth: 'midi', visual: 'visual', system: 'sys' };

  /** Overlay header per settings group. */
  function groupHeader(g) {
    return g === 'hub'  ? 'Settings'
         : g === 'midi' ? 'Synth Settings'
         : g === 'dev'  ? 'Developer Settings'
         : g === 'sys'  ? 'System Settings'
         : 'Visual Settings';
  }

  // Dynamic label for the System → Load/Change MIDI/Note File action,
  // mirroring the old Options menu wording: "Load" until a real file
  // exists, "Change" afterwards (the bundled demo never counts).
  function sysLoadLabel() {
    try {
      var st = Store.getState();
      var hasRealFile = !!st.fileName &&
        (typeof window.isDemoActive !== 'function' || !window.isDemoActive());
      return hasRealFile ? 'Change MIDI/Note File' : 'Load MIDI/Note File';
    } catch (e) { return 'Load MIDI/Note File'; }
  }

  // ── Local state ──
  var _values = clone(DEFAULTS);
  var _openGroup = null;     // 'hub' | 'midi' | 'visual' | 'dev' | null
  var _groupReturn = null;   // group to return to on Back (non-hub drill-in)
  var _groupReturnIdx = 0;   // focus row to restore when backing to it
  var _focusIdx = 0;
  var _onCloseCb = null;     // notification when overlay closes

  // Pipeline busy (MIDI / note analysis running) — drives the System
  // "Cancel Analysis" row: only visible WHILE an analysis is in progress.
  function _analysisBusy() {
    try {
      return !!(typeof window !== 'undefined' &&
                typeof window.isAnalyzing === 'function' &&
                window.isAnalyzing());
    } catch (e) { return false; }
  }

  // Hub navigation: when a group was opened from the Settings hub, Back
  // returns to the hub instead of closing the overlay. _hubFocusIdx is the
  // hub row the user left from, so Back lands on the same row.
  var _hubReturn = false;
  var _hubFocusIdx = 0;

  // Level-2 sub-page state (null = none open):
  //   kind     : 'range' | 'color'
  //   key      : visual key driving the page ('kbRange'|'bgColor'|...)
  //   rgb      : working color {r,g,b,a} while a color page is open
  //   items    : flat focus model [{type:'def'|'swatch'|'slider', part?, idx?}]
  //   focusIdx : index into items
  var _sub = null;

  /** Number of swatch cells per visual row (flex-wrap column stride). */
  var SWATCH_COLS = 5;

  // ── Built-in palette definitions ──
  // Each palette is an object: { id, label, file, colors }.
  // `file` is the image filename under css/palettes/ (PNG).
  // `colors` is the number of distinct color strips in the PNG —
  // sampling this many points (at strip centers) avoids hitting
  // transitions between adjacent colors. The sampled array is then
  // cycled to fill 16 channels.
  var PALETTES = [
    { id: 'random',             label: 'Random',                file: 'Random.png',               colors: 16 },
    { id: 'randomAlpha',        label: 'Random Alpha Gradients', file: 'Random Alpha Gradients.png', colors: 16 },
    { id: 'randomGradients',    label: 'Random Gradients',      file: 'Random Gradients.png',      colors: 16 },
    { id: 'randomWithAlpha',    label: 'Random with Alpha',     file: 'Random with Alpha.png',     colors: 16 },
    { id: 'synth10',            label: 'Synthesia 10 Palette',  file: 'Synthesia 10 Palette.png',  colors: 10 },
    { id: 'synth9',             label: 'Synthesia 9-0.8 Palette', file: 'Synthesia 9-0.8 Palette.png', colors: 8 },
  ];

  // ── Loaded palette color caches ──
  // Keyed by palette id → array of hex strings extracted from the PNG.
  // Populated on demand (first open of the palette sub-page).
  var _paletteColors = {};

  // Path prefix for palette images (relative to index.html).
  var PALETTE_IMG_DIR = 'css/palettes/';

  /** Number of color cells to sample from each palette image. */
  var PALETTE_SAMPLE_N = 16;

  // ──────────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────────

  function load() {
    console.log('[Settings] load() invoked');
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    // Ensure the one-shot migration marker is always present so save()
    // persists it and the migration below never re-runs to clobber a value
    // the user later sets — even on a brand-new install (raw === null).
    _values.__upgraded = true;
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          _values = merge(DEFAULTS, parsed);
          // Migration (one-shot) for users of PREVIOUS builds: the first run
          // of this version forces Note Trail to its new default of 1.0 for
          // any persisted profile that predates this change (no __upgraded
          // marker). New installs have no raw to migrate, and their trail
          // already comes from DEFAULTS (1.0).
          if (!_values.__upgraded) {
            _values.visual.trail = 1.0;
            _values.__upgraded = true;
          }
          // Migration: Note Trail used to live in the MIDI group; older
          // persisted profiles still carry it at midi.trail. Lift it into
          // the Visual group unless a newer visual.trail already exists.
          if (parsed.midi && parsed.midi.trail != null &&
              (!parsed.visual || parsed.visual.trail == null)) {
            _values.visual.trail = parsed.midi.trail;
          }
          // Migration: "Show FPS" became part of Info Card Options —
          // carry the old toggle into infoFps when nothing newer exists.
          if (parsed.visual && parsed.visual.showFps != null &&
              parsed.visual.infoFps == null) {
            _values.visual.infoFps = parsed.visual.showFps;
          }
          // Migration: NPS / Note Count split — carry the old combined
          // infoNoteCount into the new infoNps / infoPassed switches.
          if (parsed.visual && parsed.visual.infoNoteCount != null) {
            if (parsed.visual.infoNps == null)
              _values.visual.infoNps = parsed.visual.infoNoteCount;
            if (parsed.visual.infoPassed == null)
              _values.visual.infoPassed = parsed.visual.infoNoteCount;
          }
          // Migration: Start Delay used to allow -1 (= Off); the slider
          // range is 0..10 with 0 meaning Off — normalize old values.
          if (_values.visual.startDelay == null ||
              _values.visual.startDelay < 0) {
            _values.visual.startDelay = 0;
          }
        }
      } catch (e) {
        console.warn('[Settings] corrupt persist; using defaults', e);
      }
    }
    // Push current values into Store + DOM. Order matters: theme must set
    // first so subsequent visual changes read the right tokens.
    Store.setState({
      waveform:      _values.midi.waveform,
      engine:        _values.midi.engine,
      audio:         _values.midi.audio,
      renderMode:    _values.visual.renderMode,
      speed:         _values.visual.speed,
      trail:         _values.visual.trail,
      autoPlay:      _values.visual.autoPlay,
      showDialog:    _values.visual.showDialog,
      showOsd:       _values.visual.showOsd,
      pctAnalyze:    _values.visual.pctAnalyze,
      pctMerge:      _values.visual.pctMerge,
      pctBarVisible: _values.visual.pctBarVisible,
      loadAnimated:  _values.visual.loadAnimated,
      loadBarColor:  _values.visual.loadBarColor,
      pctColor:      _values.visual.pctColor,
      dialogTextColor: _values.visual.dialogTextColor,
      dialogBgColor:   _values.visual.dialogBgColor,
      startDelay:    _values.visual.startDelay,
      theme:         _values.visual.theme,
      noteLabels:    _values.visual.noteLabels,
      middleMarker:  _values.visual.middleMarker,
      infoCard:      _values.visual.infoCard,
      infoNps:       _values.visual.infoNps,
      infoNoteCount: _values.visual.infoNoteCount,
      infoPassed:    _values.visual.infoPassed,
      infoSpeed:     _values.visual.infoSpeed,
      infoTime:      _values.visual.infoTime,
      infoFps:       _values.visual.infoFps,
      infoPolyphony:    _values.visual.infoPolyphony,
      infoRendered:     _values.visual.infoRendered,
      infoAudioBuffer:  _values.visual.infoAudioBuffer,
      infoTick:         _values.visual.infoTick,
      infoBpm:          _values.visual.infoBpm,
      infoFloating:     _values.visual.infoFloating,
      infoBorder:       _values.visual.infoBorder,
      infoBorderColor:  _values.visual.infoBorderColor,
      infoBgColor:      _values.visual.infoBgColor,
      infoTextColor:    _values.visual.infoTextColor,
      infoPos:          _values.visual.infoPos,
      kbStart:       _values.visual.kbStart,
      kbEnd:         _values.visual.kbEnd,
      kbSize:        _values.visual.kbSize,
      bgColor:       _values.visual.bgColor,
      bgImageUrl:    _values.visual.bgImageUrl,
      bgImageName:   _values.visual.bgImageName,
      bgImagePath:   _values.visual.bgImagePath,
      barColor:      _values.visual.barColor,
      pianoColorHex: _values.visual.pianoColorHex,
      pianoSize:     _values.visual.pianoSize,
      view3d:        _values.visual.view3d,
      palette:       _values.visual.palette,
      osdLog:        _values.dev.osdLog,
      verboseAnalyze: _values.dev.verboseAnalyze,
      autoFullscreen: _values.sys.autoFullscreen,
      autoRotate:     _values.sys.autoRotate,
    });
    applyTheme(_values.visual.theme);
    applyInfoCard();
    // Apply the persisted palette colors to the live channel palette
    // (16 colors from the chosen PNG, or randomized for 'random').
    _applyStoredPalette(_values.visual.palette);
    // Reflect the persisted OSD toggle once the overlay element exists.
    if (typeof window.pfaSetDevOsd === 'function') {
      setTimeout(function () {
        try { window.pfaSetDevOsd(!!Store.getState().osdLog); } catch (e) {}
      }, 0);
    }
    return _values;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_values));
    } catch (e) {
      console.warn('[Settings] persist failed:', e);
    }
  }

  function reset() {
    // Full factory reset: drop persisted values back to factory defaults,
    // re-apply every setting to Store + DOM, rebuild the piano spritesheet
    // and any settings UI currently open.
    _values = clone(DEFAULTS);
    _values.__upgraded = true;
    save();
    load();
    if (typeof Keyboard !== 'undefined' && Keyboard.rebuild) {
      try { Keyboard.rebuild(); } catch (e) {}
    }
    var overlay = document.getElementById('settings-overlay');
    if (overlay && _openGroup && !overlay.classList.contains('hidden')) {
      rebuildRows(overlay, _openGroup);
    }
    return _values;
  }

  // ──────────────────────────────────────────────────────────────────
  // Overlay open/close
  // ──────────────────────────────────────────────────────────────────

  /**
   * Open the settings overlay for one group.
   * @param group   'midi' | 'visual'
   * @param onClose Optional callback fired when overlay closes
   */
  function open(group, onClose) {
    if (group !== 'hub' && group !== 'midi' && group !== 'visual' && group !== 'dev' && group !== 'sys') {
      console.error('[Settings] unknown group: ' + group);
      return;
    }
    // Never inherit a stale level-2 page from a previous session.
    if (_sub) {
      var so = document.getElementById('subsettings-overlay');
      if (so) so.classList.add('hidden');
      _sub = null;
    }
    _openGroup = group;
    _focusIdx = 0;
    _hubReturn = false;
    _hubFocusIdx = 0;
    _groupReturn = null;   // fresh open — no pending group-nav return
    _onCloseCb = onClose || null;

    var overlay = document.getElementById('settings-overlay');
    if (!overlay) {
      console.error('[Settings] #settings-overlay missing');
      return;
    }
    var header = overlay.querySelector('header');
    if (header) header.textContent = groupHeader(group);
    overlay.setAttribute('data-group', group);

    // Build rows fresh every open so current values are reflected even
    // if storage was edited externally between sessions.
    rebuildRows(overlay, group);

    // Instant show — visibility toggle only, no slide animation.
    overlay.classList.remove('hidden');

    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider');
    if (rows.length) focusRow(rows, 0);

    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function close(suppressOnClose) {
    // Defensive: a level-2 page must never outlive its parent group.
    if (_sub) {
      var subOverlay = document.getElementById('subsettings-overlay');
      if (subOverlay) subOverlay.classList.add('hidden');
      _sub = null;
    }
    var overlay = document.getElementById('settings-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      _openGroup = null;
      _focusIdx = 0;
      _hubReturn = false;
      _hubFocusIdx = 0;
      _groupReturn = null;   // discard any pending group-nav return target
      if (_onCloseCb) {
        var cb = _onCloseCb;
        // Always drop the saved callback; only fire it when not suppressed
        // (e.g. factory reset from the System group should land on the
        // piano, not re-open the Options menu).
        _onCloseCb = null;
        if (!suppressOnClose) {
          try { cb(); } catch (e) {}
        }
      }
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function isOpen() { return !!_openGroup; }

  // ── Settings-hub navigation ──
  // Options → Settings is a hub listing Synth/Visual/Developer. Selecting
  // one swaps the overlay to that group's rows IN PLACE (same overlay,
  // rebuilt). Back then returns to the hub (same overlay, rebuilt) before
  // closing all the way back to the Options menu.

  function switchToGroup(group) {
    _hubReturn = true;
    // The hub index is only meaningful when leaving the hub itself; a
    // nested System → Developer switch must NOT clobber it (Back from
    // Developer goes System, Back from System goes to this saved hub row).
    if (_openGroup === 'hub') _hubFocusIdx = _focusIdx;
    // When leaving a non-hub group for another group (e.g. System →
    // Developer), remember where to Back-return. Coming from the hub,
    // Back already goes to the hub, so nothing is recorded.
    if (_openGroup && _openGroup !== 'hub') {
      _groupReturn = _openGroup;
      _groupReturnIdx = _focusIdx;
    }
    _openGroup = group;
    _focusIdx = 0;
    var overlay = document.getElementById('settings-overlay');
    if (!overlay) return;
    var header = overlay.querySelector('header');
    if (header) header.textContent = groupHeader(group);
    overlay.setAttribute('data-group', group);
    rebuildRows(overlay, group);
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider');
    if (rows.length) focusRow(rows, 0);
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  // Back out of a drilled group: return to the recorded non-hub group
  // (Developer opened inside System → System) or to the hub.
  function switchBack() {
    var target = _groupReturn || 'hub';
    var idx = _groupReturn ? _groupReturnIdx : ((_hubFocusIdx >= 0) ? _hubFocusIdx : 0);
    _groupReturn = null;
    _openGroup = target;
    _focusIdx = idx;
    _hubReturn = true;
    var overlay = document.getElementById('settings-overlay');
    if (!overlay) return;
    var header = overlay.querySelector('header');
    if (header) header.textContent = groupHeader(target);
    overlay.setAttribute('data-group', target);
    rebuildRows(overlay, target);
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider');
    if (rows.length) focusRow(rows, _focusIdx);
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function switchToHub() {
    _openGroup = 'hub';
    _focusIdx = (_hubFocusIdx >= 0) ? _hubFocusIdx : 0;
    var overlay = document.getElementById('settings-overlay');
    if (!overlay) return;
    var header = overlay.querySelector('header');
    if (header) header.textContent = groupHeader('hub');
    overlay.setAttribute('data-group', 'hub');
    rebuildRows(overlay, 'hub');
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider');
    if (rows.length) focusRow(rows, _focusIdx);
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  function openGroup() { return _openGroup; }

  // ──────────────────────────────────────────────────────────────────
  // Level-2 sub-pages — Keyboard Range (2 sliders) and Color pickers
  // (swatch grid + R/G/B/A sliders). Both apply live to the Store and
  // persist through the same save() path as regular rows.
  // ──────────────────────────────────────────────────────────────────

  /** Default value of a color key; Background defaults to theme (null). */
  function colorDefault(key) {
    if (key === 'barColor')      return DEFAULTS.visual.barColor;
    if (key === 'pianoColorHex') return DEFAULTS.visual.pianoColorHex;
    if (key === 'loadBarColor')  return DEFAULTS.visual.loadBarColor;
    if (key === 'pctColor')      return DEFAULTS.visual.pctColor;
    if (key === 'dialogTextColor') return DEFAULTS.visual.dialogTextColor;
    if (key === 'dialogBgColor')   return DEFAULTS.visual.dialogBgColor;
    return null;
  }

  /** Resolve the effective CSS color for a key (null → --theme-bg). */
  function colorCurrentValue(key) {
    var v = _values.visual[key];
    if (v) return v;
    try {
      return getComputedStyle(document.documentElement)
        .getPropertyValue('--theme-bg').trim() || '#0a0a0a';
    } catch (e) {
      return '#0a0a0a';
    }
  }

  /** '#rgb'/'#rrggbb' → {r,g,b,a:100}. */
  function hexToRgbObj(hex) {
    // Accept 'rgba(r, g, b, a)' / 'rgb(r, g, b)' persisted strings too.
    if (hex && /^rgba?\(/i.test(hex)) {
      var m = hex.match(/rgba?\(([^)]+)\)/i);
      var parts = m ? m[1].split(',').map(function (s) {
        return parseFloat(s.trim());
      }) : [];
      return {
        r: parts[0] || 0,
        g: parts[1] || 0,
        b: parts[2] || 0,
        a: parts.length > 3 && typeof parts[3] === 'number'
           ? Math.max(0, Math.min(100, Math.round(parts[3] * 100)))
           : 100
      };
    }
    var h = hex && hex.charAt(0) === '#' ? hex.substring(1) : (hex || '');
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    return {
      r: parseInt(h.substring(0, 2), 16) || 0,
      g: parseInt(h.substring(2, 4), 16) || 0,
      b: parseInt(h.substring(4, 6), 16) || 0,
      a: 100
    };
  }

  /** {r,g,b,a%} → '#rrggbb' (opaque) or 'rgba(...)' string. */
  function rgbToCss(rgb) {
    if (!rgb) return null;
    if (rgb.a >= 100) {
      function p2(n) { var s = n.toString(16); return n < 16 ? '0' + s : s; }
      return '#' + p2(rgb.r) + p2(rgb.g) + p2(rgb.b);
    }
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (rgb.a / 100).toFixed(2) + ')';
  }

  /**
   * Build a slider row reusing .setting-row-slider markup/styles.
   * Returns refs so keyboard navigation can drive it without touch.
   */
  function buildSubSliderRow(listEl, label, min, max, step, value, fmt) {
    var row = document.createElement('div');
    row.className = 'setting-row-slider';
    row.setAttribute('tabindex', '-1');

    var line = document.createElement('div');
    line.className = 'setting-row-slider-line';

    var hdr = document.createElement('span');
    hdr.className = 'setting-row-slider-header';
    hdr.textContent = label;
    line.appendChild(hdr);

    var trk = document.createElement('span');
    trk.className = 'setting-row-slider-tracker';
    trk.textContent = fmt(value);
    line.appendChild(trk);

    row.appendChild(line);

    var input = document.createElement('input');
    input.type = 'range';
    input.setAttribute('min', String(min));
    input.setAttribute('max', String(max));
    input.setAttribute('step', String(step));
    input.value = String(value);
    input.style.setProperty('--min', String(min));
    input.style.setProperty('--max', String(max));
    input.style.setProperty('--val', String(value));
    row.appendChild(input);

    listEl.appendChild(row);
    return { row: row, input: input, tracker: trk, min: min, max: max, step: step, fmt: fmt };
  }

  /** Push a slider's current value into its input + tracker display. */
  function syncSubSlider(slider, value) {
    slider.input.value = String(value);
    slider.input.style.setProperty('--val', String(value));
    slider.tracker.textContent = slider.fmt(value);
  }

  /** Note-number formatter for the range page trackers. */
  function noteFmt(v) {
    try { return v + ' \u00B7 ' + Constants.noteName(v); }
    catch (e) { return String(v); }
  }

  /**
   * Open a level-2 page.
   * @param kind 'range' | 'color' | 'bools' | 'palettes' | 'piano' | 'general'
   * @param key  visual settings key ('kbRange'|'bgColor'|'barColor'|'pianoColorHex')
   * @param label optional header label fallback (drill keys not in SCHEMA)
   */
  function openSub(kind, key, label) {
    var overlay = document.getElementById('subsettings-overlay');
    if (!overlay) { console.error('[Settings] #subsettings-overlay missing'); return; }

    var list = overlay.querySelector('#subsettings-list');
    var header = overlay.querySelector('header');
    while (list && list.firstChild) list.removeChild(list.firstChild);

    _sub = { kind: kind, key: key, items: [], focusIdx: 0, ui: {}, rgb: null };

    var def = findDef(_openGroup, key);
    if (header) header.textContent = label || (def ? def.label : 'Settings');

    if (kind === 'range') {
      // Keyboard range — Key Count preset enum row + Start/End sliders
      // (the sliders render only in 'custom' mode).
      buildRangePage(list);
    } else if (kind === 'bools') {
      // Boolean list page (Info Card Options) — built by buildBoolPage
      // so the master toggle can collapse/expand it in place.
      buildBoolPage(list);
    } else if (kind === 'palettes') {
      // Note Color Settings — palette selection page.
      buildPalettePage(list);
    } else if (kind === 'piano') {
      // Piano Settings — grouped Show Note Labels / Keyboard Range /
      // Bar Color / Piano Color / Piano Size page.
      buildPianoPage(list);
    } else if (kind === 'general') {
      // General settings — Speed / Note Trail / Start Delay / Auto Play /
      // Show Dialog / Show OSD / Background.
      buildGeneralPage(list);
    } else if (kind === 'loadingBar') {
      // Loading Bar settings — bar visibility / % readouts / color / animation.
      buildLoadingBarPage(list);
    } else if (kind === 'dialog') {
      // Dialog settings — the center "Analyzing…/Now playing" pill.
      buildDialogPage(list);
    } else if (kind === 'developer') {
      // Developer Settings — list-style page (System Settings → Developer):
      // Verbose toggles + one-shot dev actions.
      if (header) header.textContent = 'Developer Settings';
      buildDeveloperPage(list);
    } else if (kind === 'background') {
      // Background Settings — Background color + Load/Clear image actions.
      buildBackgroundSubPage(list);
    } else if (kind === 'graphics') {
      // Graphics settings — Render Mode (4 radio) + 3D View (4 radio).
      buildGraphicsPage(list);
    } else {
      // Working color from persisted value (or resolved theme color).
      var cur = _values.visual[key];
      _sub.rgb = hexToRgbObj(cur || colorCurrentValue(key));

      // Swatch grid — first cell restores the default/theme color.
      var grid = document.createElement('div');
      grid.className = 'swatch-grid';

      var defCell = document.createElement('div');
      defCell.className = 'swatch swatch-default';
      defCell.textContent = 'DEF';
      grid.appendChild(defCell);
      _sub.items.push({ type: 'def' });

      for (var i = 0; i < SWATCHES.length; i++) {
        var cell = document.createElement('div');
        cell.className = 'swatch';
        cell.style.background = SWATCHES[i];
        grid.appendChild(cell);
        _sub.items.push({ type: 'swatch', idx: i });
      }
      list.appendChild(grid);
      _sub.ui.grid = grid;

      // R/G/B/A sliders — live-mix on top of any selected swatch.
      _sub.ui.r = buildSubSliderRow(list, 'R', 0, 255, 8, _sub.rgb.r, function (v) { return String(Math.round(v)); });
      _sub.ui.g = buildSubSliderRow(list, 'G', 0, 255, 8, _sub.rgb.g, function (v) { return String(Math.round(v)); });
      _sub.ui.b = buildSubSliderRow(list, 'B', 0, 255, 8, _sub.rgb.b, function (v) { return String(Math.round(v)); });
      _sub.ui.a = buildSubSliderRow(list, 'A %', 0, 100, 5, _sub.rgb.a, function (v) { return Math.round(v) + '%'; });
      _sub.items.push({ type: 'slider', part: 'r' });
      _sub.items.push({ type: 'slider', part: 'g' });
      _sub.items.push({ type: 'slider', part: 'b' });
      _sub.items.push({ type: 'slider', part: 'a' });

      // Live preview chip under the sliders.
      var prow = document.createElement('div');
      prow.className = 'color-preview-row';
      var plbl = document.createElement('span');
      plbl.textContent = 'Preview';
      var pchip = document.createElement('span');
      pchip.className = 'color-chip color-preview-chip';
      prow.appendChild(plbl);
      prow.appendChild(pchip);
      list.appendChild(prow);
      _sub.ui.previewChip = pchip;
      updateSubPreview();
    }

    overlay.classList.remove('hidden');
    paintSubFocus();
  }

  /** Keyboard Range Key Count presets — 88 keys (A0..C8), 128 (full MIDI), custom. */
  var KB_SIZE_CHOICES = [['88', '88 Keys'], ['128', '128 Keys'], ['custom', 'Custom']];

  /** Human label for a Key Count preset id. */
  function kbSizeLabel(size) {
    for (var i = 0; i < KB_SIZE_CHOICES.length; i++) {
      if (KB_SIZE_CHOICES[i][0] === size) return KB_SIZE_CHOICES[i][1];
    }
    return 'Custom';
  }

  /**
   * Build the Keyboard Range page: a Key Count preset enum row
   * (88 Keys / 128 Keys / Custom — Left/Right cycles) plus, ONLY in
   * Custom mode, the Start/End note sliders.
   */
  function buildRangePage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    // Key Count preset row — cycling it rebuilds the page so the sliders
    // appear (custom) or vanish (88/128) right away.
    var sizeRow = document.createElement('div');
    sizeRow.className = 'setting-row';
    sizeRow.setAttribute('tabindex', '-1');
    sizeRow.setAttribute('data-type', 'enum');
    sizeRow.setAttribute('data-key', 'kbSize');
    var sLbl = document.createElement('span');
    sLbl.className = 'setting-row-label';
    sLbl.textContent = 'Key Count';
    var sVal = document.createElement('span');
    sVal.className = 'setting-row-value';
    sVal.textContent = kbSizeLabel(_values.visual.kbSize);
    sizeRow.appendChild(sLbl);
    sizeRow.appendChild(sVal);
    listEl.appendChild(sizeRow);
    _sub.ui.boolRows.kbSize = { row: sizeRow, valEl: sVal };
    _sub.items.push({ type: 'enum', part: 'kbSize', key: 'kbSize', choices: KB_SIZE_CHOICES });

    // Start/End sliders exist only in Custom mode.
    if (_values.visual.kbSize !== 'custom') return;
    _sub.ui.start = buildSubSliderRow(listEl, 'Start', 0, 127, 1, _values.visual.kbStart, noteFmt);
    _sub.ui.end   = buildSubSliderRow(listEl, 'End',   0, 127, 1, _values.visual.kbEnd,   noteFmt);
    _sub.items.push({ type: 'slider', part: 'start' });
    _sub.items.push({ type: 'slider', part: 'end' });
  }

  /**
   * Apply a Keyboard Range preset: '88' → A0..C8 (21..108), '128' → full
   * MIDI 0..127, 'custom' → keep kbStart/kbEnd and reveal the Start/End
   * sliders. Rebuilds the page in place so sliders appear/disappear per
   * the current mode and focus lands back on the Key Count row.
   */
  function applyKbPresetSize(size) {
    _values.visual.kbSize = size;
    Store.setState({ kbSize: size });
    if (size !== 'custom') {
      var start = (size === '128') ? 0 : 21;
      var end   = (size === '128') ? 127 : 108;
      _values.visual.kbStart = start;
      _values.visual.kbEnd   = end;
      Store.setState({ kbStart: start, kbEnd: end });
      // Re-fit keyWidth to the new visible range (main.js resize handler)
      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    }
    save();
    // If the Keyboard Range page is open, rebuild it so the Start/End
    // sliders appear or disappear per the current mode. During gameplay
    // (hotkey-toggled) the settings overlays are hidden — stay out of the way.
    var ov = document.getElementById('subsettings-overlay');
    if (ov && !ov.classList.contains('hidden')) {
      var list = document.getElementById('subsettings-list');
      if (list) {
        while (list.firstChild) list.removeChild(list.firstChild);
        buildRangePage(list);
        paintSubFocus();
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    }
  }

  /**
   * Drill from the Info Card Options page into a color sub-page.
   * Marks the sub-page to return to the bools list on close (Back),
   * so the user lands back in Info Card Options — not the Visual group.
   */
  function openInfoColor(key) {
    openSub('color', key);
    if (_sub) _sub.returnTo = 'bools';
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /** Header labels for drill-in rows whose keys are not in SCHEMA. */
  var DRILL_LABELS = {
    kbRange:       'Keyboard Range',
    barColor:      'Bar Color',
    pianoColorHex: 'Piano Color',
    bgColor:       'Background'
  };

  /**
   * Open the drill-in target of a focused sub-page row. 'color' rows
   * open the R/G/B/A page; 'sub' rows (Keyboard Range) open the Start/End
   * carrier page. The drilled page is marked to return to the CURRENT list
   * on Back (Piano Settings / General settings / Info Card Options), not
   * to hop straight back to the Visual group.
   */
  function drillSubRow(item) {
    if (!item || !_sub) return false;
    if (item.type === 'color' && _sub.kind === 'bools') {
      openInfoColor(item.key);
      return true;
    }
    if (item.type === 'sub' && item.part === 'bgSettings') {
      // Visual → General → Background Settings: dedicated image/color page.
      openSub('background', 'bgSettings', 'Background Settings');
      if (_sub) _sub.returnTo = 'general';
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return true;
    }
    if (item.type === 'sub' || item.type === 'color') {
      var retKind = (_sub.kind === 'general') ? 'general'
        : (_sub.kind === 'graphics') ? 'graphics'
        : (_sub.kind === 'background') ? 'background'
        : (_sub.kind === 'loadingBar') ? 'loadingBar'
        : (_sub.kind === 'dialog') ? 'dialog'
        : 'piano';
      openSub(item.type === 'sub' ? 'range' : 'color', item.key, DRILL_LABELS[item.key] || null);
      if (_sub) _sub.returnTo = retKind;
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return true;
    }
    return false;
  }

  /** Close the level-2 page and refresh parent group rows/chips. */
  function closeSub() {
    // Release the native built-in keyboard if a text field holds focus.
    if (_sub && _sub.ui && _sub.ui.text && _sub.ui.text.input) {
      try { _sub.ui.text.input.blur(); } catch (e) {}
    }
    var overlay = document.getElementById('subsettings-overlay');
    if (overlay) overlay.classList.add('hidden');

    // When the color page was opened from INSIDE Info Card Options
    // (a "color" row), Back should land back on that list — not on
    // the Visual group page.
    var _subReturn = _sub ? _sub.returnTo : null;
    var wasFromBools = _subReturn === 'bools';
    var returnFocusKey = _sub ? _sub.key : null;
    _sub = null;

    if (wasFromBools) {
      // Re-open the bools page (subsettings overlay) in place.
      var list2 = document.getElementById('subsettings-list');
      if (list2) {
        while (list2.firstChild) list2.removeChild(list2.firstChild);
        _sub = { kind: 'bools', key: 'infoCard', items: [], focusIdx: 0, ui: {} };
        buildBoolPage(list2);
        var ov2 = document.getElementById('subsettings-overlay');
        if (ov2) ov2.classList.remove('hidden');
        // Restore focus onto the row we drilled in from.
        if (returnFocusKey) {
          for (var bi = 0; bi < _sub.items.length; bi++) {
            if (_sub.items[bi].part === returnFocusKey) { _sub.focusIdx = bi; break; }
          }
        }
        paintSubFocus();
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return;
    }

    // A range/color page opened from INSIDE Piano Settings returns to
    // that list too (Back lands in Piano Settings, not the Visual group).
    var wasFromPiano = _subReturn === 'piano';
    if (wasFromPiano) {
      var listP = document.getElementById('subsettings-list');
      if (listP) {
        while (listP.firstChild) listP.removeChild(listP.firstChild);
        _sub = { kind: 'piano', key: 'piano', items: [], focusIdx: 0, ui: {} };
        buildPianoPage(listP);
        var ovP = document.getElementById('subsettings-overlay');
        if (ovP) ovP.classList.remove('hidden');
        if (returnFocusKey) {
          for (var pi = 0; pi < _sub.items.length; pi++) {
            if (_sub.items[pi].part === returnFocusKey) { _sub.focusIdx = pi; break; }
          }
        }
        paintSubFocus();
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return;
    }

    // A color page opened from INSIDE General settings returns to that
    // list too (Back lands in General settings, not the Visual group).
    var wasFromGeneral = _subReturn === 'general';
    if (wasFromGeneral) {
      var listG = document.getElementById('subsettings-list');
      if (listG) {
        while (listG.firstChild) listG.removeChild(listG.firstChild);
        _sub = { kind: 'general', key: 'general', items: [], focusIdx: 0, ui: {} };
        buildGeneralPage(listG);
        var ovG = document.getElementById('subsettings-overlay');
        if (ovG) ovG.classList.remove('hidden');
        if (returnFocusKey) {
          for (var gi = 0; gi < _sub.items.length; gi++) {
            if (_sub.items[gi].part === returnFocusKey) { _sub.focusIdx = gi; break; }
          }
        }
        paintSubFocus();
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return;
    }

    // A color page opened from INSIDE Graphics settings returns to that
    // list too (Back lands in Graphics settings, not the Visual group).
    var wasFromGraphics = _subReturn === 'graphics';
    var wasFromBackground = _subReturn === 'background';
    if (wasFromGraphics || wasFromBackground) {
      var listGr = document.getElementById('subsettings-list');
      if (listGr) {
        while (listGr.firstChild) listGr.removeChild(listGr.firstChild);
        if (wasFromBackground) {
          _sub = { kind: 'background', key: 'bgSettings', items: [], focusIdx: 0, ui: {} };
          buildBackgroundSubPage(listGr);
        } else {
          _sub = { kind: 'graphics', key: 'graphics', items: [], focusIdx: 0, ui: {} };
          buildGraphicsPage(listGr);
        }
        var ovGr = document.getElementById('subsettings-overlay');
        if (ovGr) ovGr.classList.remove('hidden');
        if (returnFocusKey) {
          for (var gri = 0; gri < _sub.items.length; gri++) {
            if (_sub.items[gri].part === returnFocusKey) { _sub.focusIdx = gri; break; }
          }
        }
        paintSubFocus();
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return;
    }

    // A color page opened from INSIDE Loading Bar / Dialog settings returns
    // to that list too (Back lands back in the sub-page, not the Visual group).
    var wasFromLoadBar = _subReturn === 'loadingBar';
    var wasFromDialog  = _subReturn === 'dialog';
    if (wasFromLoadBar || wasFromDialog) {
      var listLb = document.getElementById('subsettings-list');
      if (listLb) {
        while (listLb.firstChild) listLb.removeChild(listLb.firstChild);
        if (wasFromLoadBar) {
          _sub = { kind: 'loadingBar', key: 'loadingBar', items: [], focusIdx: 0, ui: {} };
          buildLoadingBarPage(listLb);
        } else {
          _sub = { kind: 'dialog', key: 'dialog', items: [], focusIdx: 0, ui: {} };
          buildDialogPage(listLb);
        }
        var ovLb = document.getElementById('subsettings-overlay');
        if (ovLb) ovLb.classList.remove('hidden');
        if (returnFocusKey) {
          for (var lbi = 0; lbi < _sub.items.length; lbi++) {
            if (_sub.items[lbi].part === returnFocusKey) { _sub.focusIdx = lbi; break; }
          }
        }
        paintSubFocus();
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return;
    }

// Default: rebuild the parent group so color chips/hex labels show new
      // values, then restore focus onto the row we drilled in from.
      var parent = document.getElementById('settings-overlay');
      if (parent && _openGroup) {
        rebuildRows(parent, _openGroup);
        var rows = parent.querySelectorAll('.setting-row, .setting-row-slider');
        if (rows.length) {
          if (_focusIdx >= rows.length) _focusIdx = rows.length - 1;
          focusRow(rows, _focusIdx);
        }
      }
      // The refocused row may be a drill-in row — refresh the SELECT
      // softkey label NOW instead of waiting for the next key press.
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    }

  /** Highlight the focused sub-page item (+ scroll into view). */
  function paintSubFocus() {
    if (!_sub) return;
    var overlay = document.getElementById('subsettings-overlay');
    if (!overlay) return;

    var cells = overlay.querySelectorAll('.swatch');
    for (var i = 0; i < cells.length; i++) cells[i].classList.remove('focused');

    var rows = overlay.querySelectorAll('.setting-row-slider, .setting-row, .kai-text-input');
    for (var j = 0; j < rows.length; j++) rows[j].classList.remove('focused');

    // Palette rows + loadmore
    var palRows = overlay.querySelectorAll('.palette-row, .palette-loadmore, .palette-action');
    for (var k = 0; k < palRows.length; k++) palRows[k].classList.remove('focused');

    var item = _sub.items[_sub.focusIdx];
    if (!item) return;

    if (item.type === 'bool' || item.type === 'enum' || item.type === 'color' || item.type === 'sub' || item.type === 'action') {
      var br = _sub.ui.boolRows && _sub.ui.boolRows[item.part];
      if (br && br.row) {
        br.row.classList.add('focused');
        try { br.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { br.row.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'randomaction') {
      if (_sub.ui.paletteRandom) {
        _sub.ui.paletteRandom.classList.add('focused');
        try { _sub.ui.paletteRandom.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { _sub.ui.paletteRandom.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'palette') {
      var pr = _sub.ui.paletteRows && _sub.ui.paletteRows.filter(function (p) { return p.id === item.part; })[0];
      if (pr && pr.row) {
        pr.row.classList.add('focused');
        try { pr.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { pr.row.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'loadmore') {
      if (_sub.ui.loadMore) {
        _sub.ui.loadMore.classList.add('focused');
        try { _sub.ui.loadMore.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { _sub.ui.loadMore.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'swatch') {
      // cells[] includes the DEF cell at index 0 → swatch idx i lives at
      // cells[i + 1]. (An off-by-one here highlighted the wrong cell.)
      var cell = cells[item.idx + 1];
      if (cell) {
        cell.classList.add('focused');
        try { cell.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { cell.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'def') {
      var dc = overlay.querySelector('.swatch-default');
      if (dc) {
        dc.classList.add('focused');
        try { dc.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { dc.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'radio') {
      // Radio row (Graphics page — renderMode / view3d group).
      var rArr = (item.key === 'renderMode')
        ? (_sub.ui.renderModeRows || [])
        : (_sub.ui.view3dRows || []);
      var rRow = null;
      for (var rri = 0; rri < rArr.length; rri++) {
        if (rArr[rri].value === item.value) { rRow = rArr[rri].row; break; }
      }
      if (rRow) {
        rRow.classList.add('focused');
        try { rRow.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { rRow.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'slider') {
      var r = _sub.ui[item.part];
      if (r && r.row) {
        r.row.classList.add('focused');
        try { r.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { r.row.scrollIntoView(false); } catch (e2) {} }
      }
    }
  }

  /** Live-apply the working color to Store + persistence. */
  function applyColorLive() {
    if (!_sub || _sub.kind !== 'color') return;
    var css = rgbToCss(_sub.rgb);
    _values.visual[_sub.key] = css;
    Store.setState(_mapToStore(_openGroup, _sub.key, css));
    if (_sub.key === 'pianoColorHex' &&
        typeof Keyboard !== 'undefined' && Keyboard.rebuild) {
      Keyboard.rebuild();
    }
    if (_sub.key === 'infoBgColor' || _sub.key === 'infoTextColor' ||
        _sub.key === 'infoBorderColor') {
      applyInfoCard();
    }
    save();
    updateSubPreview();
  }

  /** Update the Preview chip with the working color. */
  function updateSubPreview() {
    if (_sub && _sub.ui.previewChip) {
      _sub.ui.previewChip.style.background = rgbToCss(_sub.rgb) || 'transparent';
    }
  }

  /** Live-apply Start/End range values (keeps start < end). */
  function applyRangeValue(part, val) {
    val = Math.round(val);
    var start = _values.visual.kbStart;
    var end   = _values.visual.kbEnd;
    if (part === 'start') {
      start = Math.max(0, Math.min(126, val));
      if (start >= end) end = Math.min(127, start + 1);
    } else {
      end = Math.max(1, Math.min(127, val));
      if (end <= start) start = Math.max(0, end - 1);
    }
    _values.visual.kbStart = start;
    _values.visual.kbEnd   = end;
    syncSubSlider(_sub.ui.start, start);
    syncSubSlider(_sub.ui.end, end);
    Store.setState({ kbStart: start, kbEnd: end });
    save();
    // Re-fit keyWidth to the new visible range (main.js resize handler)
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }

  /** ArrowLeft/Right on the sub-page. */
  function adjustFocusedSub(dir) {
    if (!_sub) return;
    var item = _sub.items[_sub.focusIdx];
    if (!item) return;

    if (item.type === 'action') return; // one-shot rows never adjust
    if (item.type === 'bool') {
      // Left/Right toggles like Enter (no value scale to walk)
      toggleSubBool(item.part);
      return;
    }
    if (item.type === 'enum') {
      cycleSubEnum(item, dir);
      return;
    }
    if (item.type === 'slider') {
      if (_sub.kind === 'range') {
        var cur = (item.part === 'start') ? _values.visual.kbStart : _values.visual.kbEnd;
        applyRangeValue(item.part, cur + dir);
      } else if (_sub.kind === 'general') {
        // Speed / Note Trail / Start Delay — walk the numeric value
        // (same stepping/snap as the old group-page number rows).
        var gsl = _sub.ui[item.part];
        if (!gsl) return;
        var nv = parseFloat(gsl.input.value) + dir * gsl.step;
        nv = Math.max(gsl.min, Math.min(gsl.max, nv));
        if (gsl.step) {
          var prec = 0;
          var stepStr = String(gsl.step);
          var dot = stepStr.indexOf('.');
          if (dot >= 0) prec = stepStr.length - dot - 1;
          nv = Math.round(nv / gsl.step) * gsl.step;
          if (prec > 0) nv = parseFloat(nv.toFixed(prec));
        }
        _values.visual[item.part] = nv;
        Store.setState(_mapToStore(_openGroup, item.part, nv));
        save();
        syncSubSlider(gsl, nv);
      } else {
        // Color page R/G/B/A sliders.
        var sl = _sub.ui[item.part];
        var v = parseFloat(sl.input.value) + dir * sl.step;
        v = Math.max(sl.min, Math.min(sl.max, v));
        _sub.rgb[item.part] = Math.round(v);
        syncSubSlider(sl, v);
        applyColorLive();
      }
      return;
    }
    // DEF / swatch cells: arrows walk the flat item list
    moveSubFocus(dir);
  }

  /** Enter on the sub-page (apply swatch / reset default / toggle bool). */
  function activateFocusedSub() {
    if (!_sub) return;
    var item = _sub.items[_sub.focusIdx];
    if (!item) return;

    if (item.type === 'bool') {
      // Booleans are Left/Right only — Enter never toggles them.
      return;
    }
    if (item.type === 'action') {
      // One-shot actions (General → Full Screen / Rotate Screen).
      if (item.row && (item.part === 'memory' || item.part === 'exportLog' ||
                       item.part === 'storageTest')) {
        // Developer Settings action rows — reuse the group-page dispatcher.
        runDevAction(item.row);
        return;
      }
      if (item.part === 'fullscreen' && typeof window.toggleFullscreen === 'function') {
        try { window.toggleFullscreen(); } catch (e) {}
      } else if (item.part === 'rotate' && typeof window.rotateScreen === 'function') {
        try { window.rotateScreen(); } catch (e) {}
      } else if (item.part === 'bgImage') {
        _launchBgImagePicker();
      } else if (item.part === 'bgImageClear') {
        _clearBgImage();
      }
      return;
    }
    if (item.type === 'randomaction') {
      // Regenerate all 16 channel colours — mirrors the hotkey-4 action.
      try {
        if (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked()) {
          if (typeof showToast === 'function') showToast('Locked until a file loads');
          return;
        }
      } catch (e) {}
      try {
        if (typeof Notes !== 'undefined' && Notes.randomizePalette) {
          Notes.randomizePalette();
          if (typeof HUD !== 'undefined' && HUD.showOsd) HUD.showOsd('Track colors randomised', 2000);
        }
      } catch (e2) { if (typeof console !== 'undefined') console.error('[Settings] randomColors failed', e2); }
      return;
    }
    if (item.type === 'palette') {
      // Select this palette — persist, update radio highlight, and apply
      // its colors to the live channel palette.
      _values.visual.palette = item.part;
      Store.setState({ palette: item.part });
      save();
      _highlightPalette();
      _applyStoredPalette(item.part);
      if (typeof showToast === 'function') showToast('Palette: ' + _paletteLabel(item.part));
      return;
    }
    if (item.type === 'radio') {
      // Radio row in Graphics page (renderMode / view3d) — set value,
      // update radio highlight, persist to Store + localStorage.
      var rKey = item.key;
      var rVal = item.value;
      _values.visual[rKey] = rVal;
      Store.setState(_mapToStore(_openGroup, rKey, rVal));
      save();
      _highlightGraphicsRadio(rKey);
      if (typeof showToast === 'function') {
        var rLabel = (rKey === 'renderMode') ? 'Render Mode' : '3D View';
        showToast(rLabel + ': ' + item.value.charAt(0).toUpperCase() + item.value.slice(1));
      }
      return;
    }
    if (item.type === 'loadmore') {
      // Trigger MozActivity image picker for custom palette import.
      _launchPalettePicker();
      return;
    }
    if (item.type === 'swatch') {
      _sub.rgb = hexToRgbObj(SWATCHES[item.idx]);
      syncSubSlider(_sub.ui.r, _sub.rgb.r);
      syncSubSlider(_sub.ui.g, _sub.rgb.g);
      syncSubSlider(_sub.ui.b, _sub.rgb.b);
      syncSubSlider(_sub.ui.a, _sub.rgb.a);
      applyColorLive();
    } else if (item.type === 'def') {
      // Restore the factory default (Background → Auto/theme).
      var dflt = colorDefault(_sub.key);
      if (dflt) {
        _sub.rgb = hexToRgbObj(dflt);
        syncSubSlider(_sub.ui.r, _sub.rgb.r);
        syncSubSlider(_sub.ui.g, _sub.rgb.g);
        syncSubSlider(_sub.ui.b, _sub.rgb.b);
        syncSubSlider(_sub.ui.a, _sub.rgb.a);
      }
      _values.visual[_sub.key] = dflt; // may be null (= theme)
      Store.setState(_mapToStore(_openGroup, _sub.key, dflt));
      if (_sub.key === 'pianoColorHex' &&
          typeof Keyboard !== 'undefined' && Keyboard.rebuild) {
        Keyboard.rebuild();
      }
      if (_sub.key === 'infoBgColor' || _sub.key === 'infoTextColor' ||
        _sub.key === 'infoBorderColor') {
        applyInfoCard();
      }
      save();
      updateSubPreview();
    }
  }

  /** Jump to an absolute sub-page index with wrap-around. */
  function setSubFocus(idx) {
    if (!_sub) return;
    var n = _sub.items.length;
    if (!n) return;
    _sub.focusIdx = ((idx % n) + n) % n;
    paintSubFocus();
    // Focus moved — refresh the softkey label (SELECT on drill-in rows,
    // blank on bool/enum/slider rows so the bar mirrors the focused row).
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /** Move sub-page focus by ±step with WRAP-AROUND (bottom ↔ top). */
  function moveSubFocus(step) {
    if (!_sub) return;
    setSubFocus(_sub.focusIdx + step);
  }

  /**
   * Vertical navigation for the COLOR page.
   *   Grid (DEF + swatches): Up/Down stride by column (5 cells).
   *   Top row cols 1-4 ↑  → bottom cell of the SAME column.
   *   DEF ↑               → A slider (wrap to the very bottom).
   *   ANY grid cell at the bottom edge ↓ → R (first slider).
   *   Sliders stack linearly: A ↑ → B → G → R; R ↑ → S24
   *   (bottom of DEF's column). A ↓ → DEF (wrap to the very top).
   * (dir: -1 = up, +1 = down)
   */
  function moveColorVertical(dir) {
    var gLast = SWATCHES.length;        // 25 — last grid cell (S24)
    var firstSlider = gLast + 1;        // 26 — R
    var last = _sub.items.length - 1;   // 29 — A
    var i = _sub.focusIdx;
    var t;
    if (dir > 0) { // Down
      if (i <= gLast) {
        t = i + SWATCH_COLS;
        setSubFocus(t <= gLast ? t : firstSlider); // grid bottom edge → R
      } else {
        setSubFocus(i === last ? 0 : i + 1);       // A → DEF (wrap)
      }
    } else {       // Up
      if (i === 0) {
        setSubFocus(last);                          // DEF → A (bottom)
      } else if (i <= gLast) {
        t = i - SWATCH_COLS;
        setSubFocus(t >= 0 ? t : i + 20);           // top row → same column
      } else {
        t = i - 1;
        if (t < firstSlider) t = gLast;             // R ↑ → S24 (DEF column)
        setSubFocus(t);
      }
    }
  }

  /**
   * (Re)build the Info Card Settings list. The MASTER "Show Info Card"
   * row always sits first. When it is Off, the stat/behaviour rows are
   * REMOVED entirely — focus locks onto the master row alone; flipping
   * it back On restores the full list. Rows are split by separators:
   *   — Stats —  NPS … BPM           — Style —  Floating … Info Card Text
   *
   * Row kinds: 'bool' (Left/Right toggle), 'enum' (Left/Right cycle),
   *            'color' (drill-in to the R/G/B/A page).
   */
  function buildBoolPage(listEl) {
    var bdefs = [
      { key: 'infoCard',         label: 'Show Info Card',        type: 'bool' },
      // Stats section
      { key: 'infoNps',          label: 'NPS',                   type: 'bool' },
      { key: 'infoNoteCount',    label: 'Note Count',            type: 'bool' },
      { key: 'infoPassed',       label: 'Passed',                type: 'bool' },
      { key: 'infoSpeed',        label: 'Speed',                 type: 'bool' },
      { key: 'infoTime',         label: 'Time',                  type: 'bool' },
      { key: 'infoFps',          label: 'FPS',                   type: 'bool' },
      { key: 'infoPolyphony',    label: 'Polyphony',             type: 'bool' },
      { key: 'infoRendered',     label: 'Rendered Notes',        type: 'bool' },
      { key: 'infoAudioBuffer',  label: 'Audio Buffer',          type: 'bool' },
      { key: 'infoTick',         label: 'Tick',                  type: 'bool' },
      { key: 'infoBpm',          label: 'BPM',                   type: 'bool' },
      // Style section
      { key: 'infoFloating',     label: 'Floating',              type: 'bool' },
      { key: 'infoBorder',       label: 'Border',                type: 'bool' },
      { key: 'infoBorderColor',  label: 'Info Card Border',      type: 'color' },
      { key: 'infoPos',          label: 'Position',              type: 'enum',
        choices: [['left','Left'],['right','Right']] },
      { key: 'infoBgColor',      label: 'Background',            type: 'color' },
      { key: 'infoTextColor',    label: 'Info Card Text',        type: 'color' }
    ];
    var masterOn = !!_values.visual.infoCard;
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    function sepsis(text) {
      var s = document.createElement('div');
      s.className = 'kai-separator';
      var st = document.createElement('span');
      st.className = 'kai-separator-text';
      st.textContent = text;
      s.appendChild(st);
      listEl.appendChild(s);
    }

    // Master gate always sits first, above any separator.
    addSubRow(listEl, 'bool', 'infoCard', 'Show Info Card');
    // Collapsed: only the master row exists while infoCard is Off.
    if (!masterOn) return;

    var SEPS = { infoNps: 'Stats', infoFloating: 'Style' };
    for (var bi = 0; bi < bdefs.length; bi++) {
      var bd = bdefs[bi];
      if (bd.key === 'infoCard') continue; // master already added
      if (SEPS[bd.key]) sepsis(SEPS[bd.key]);
      addSubRow(listEl, bd.type, bd.key, bd.label, bd.choices || null);
    }
  }

  /**
   * Append one row to a sub-page list. Kinds:
   *   'bool'  → On/Off label (Left/Right toggles, never Enter)
   *   'enum'  → cycled value label (choices = [[value,label],..])
   *   'sub'   → drill-in row showing getVal() (e.g. Keyboard Range window)
   *   'color' → drill-in row with a color chip + getVal() hex label
   * Rows register in _sub.ui.boolRows so value labels + focus paint work.
   */
  function addSubRow(listEl, kind, key, label, choices, getVal) {
    var r = document.createElement('div');
    r.className = 'setting-row';
    r.setAttribute('tabindex', '-1');
    r.setAttribute('data-type', kind);
    r.setAttribute('data-key', key);

    var lbl = document.createElement('span');
    lbl.className = 'setting-row-label';
    lbl.textContent = label;
    r.appendChild(lbl);

    var valEl = null;
    if (kind === 'bool') {
      valEl = document.createElement('span');
      valEl.className = 'setting-row-value';
      valEl.textContent = getVal ? (getVal() ? 'On' : 'Off') : (_values.visual[key] ? 'On' : 'Off');
      r.appendChild(valEl);
    } else if (kind === 'enum') {
      valEl = document.createElement('span');
      valEl.className = 'setting-row-value';
      valEl.textContent = getVal ? getVal() : choiceLabel(choices, _values.visual[key]);
      r.appendChild(valEl);
    } else if (kind === 'sub' || kind === 'color') {
      r.classList.add('has-sub');
      if (kind === 'color') {
        var chip = document.createElement('span');
        chip.className = 'color-chip';
        chip.style.background = _values.visual[key] || 'transparent';
        r.appendChild(chip);
      }
      valEl = document.createElement('span');
      valEl.className = 'setting-row-value';
      valEl.textContent = getVal ? getVal() : (_values.visual[key] || '');
      r.appendChild(valEl);
    }

    listEl.appendChild(r);
    var item = { type: kind, part: key, key: key, choices: choices || null };
    _sub.items.push(item);
    _sub.ui.boolRows[key] = { row: r, valEl: valEl || null };
    return item;
  }

  /** One-shot action row (Enter fires, Right moves focus) — same look as
   *  the addSubRow rows so paintSubFocus highlights it the same way. */
  function addActionRow(listEl, part, label, getVal) {
    var r = document.createElement('div');
    r.className = 'setting-row has-sub';
    r.setAttribute('tabindex', '-1');
    r.setAttribute('data-type', 'action');
    r.setAttribute('data-key', part);

    var l = document.createElement('span');
    l.className = 'setting-row-label';
    l.textContent = label;
    r.appendChild(l);

    var v = document.createElement('span');
    v.className = 'setting-row-value';
    v.textContent = getVal ? getVal() : '';
    r.appendChild(v);

    listEl.appendChild(r);
    _sub.items.push({ type: 'action', part: part, row: r });
    _sub.ui.boolRows[part] = { row: r, valEl: v };
    return r;
  }

  /** Human label for a [value,label] choice pair; falls back to '' */
  function choiceLabel(choices, val) {
    if (!choices) return '';
    for (var i = 0; i < choices.length; i++) {
      if (choices[i][0] === val) return choices[i][1];
    }
    return (choices[0] && choices[0][1]) || '';
  }

  /**
   * Build the Piano Settings page.
   * Groups Show Note Labels, Keyboard Range, Piano Size, Bar Color and
   * Piano Color into separators (like the Note Color Settings page):
   *   — Notes —      Show Note Labels (bool)
   *   — Keyboard —   Keyboard Range (drill-in range), Piano Size (enum)
   *   — Colors —     Bar Color (drill-in), Piano Color (drill-in)
   * Row refs live in _sub.ui.boolRows so bool/enum value labels, focus
   * paint and toggles reuse the existing sub-page machinery.
   */
  function buildPianoPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    function sepsis(text) {
      var s = document.createElement('div');
      s.className = 'kai-separator';
      var st = document.createElement('span');
      st.className = 'kai-separator-text';
      st.textContent = text;
      s.appendChild(st);
      listEl.appendChild(s);
    }

    // Notes section
    sepsis('Notes');
    addSubRow(listEl, 'bool', 'noteLabels', 'Show Note Labels');

    // Keyboard section
    sepsis('Keyboard');
    addSubRow(listEl, 'sub', 'kbRange', 'Keyboard Range', null, function () {
      return _values.visual.kbStart + ' \u00B7 ' + _values.visual.kbEnd;
    });
    addSubRow(listEl, 'enum', 'pianoSize', 'Piano Size',
      [['big', 'Big'], ['small', 'Small'], ['none', 'No Piano']]);
    addSubRow(listEl, 'bool', 'middleMarker', 'Middle C Marker');

    // Colors section
    sepsis('Colors');
    addSubRow(listEl, 'color', 'barColor', 'Bar Color', null, function () {
      return _values.visual.barColor || 'Theme';
    });
    addSubRow(listEl, 'color', 'pianoColorHex', 'Piano Color', null, function () {
      return _values.visual.pianoColorHex || 'Theme';
    });
  }

  /**
   * Build the General settings page (no separators): Render Mode (enum),
   * the Speed / Note Trail / Start Delay sliders, the Auto Play / Show
   * Dialog / Show OSD toggles, and the Background color drill-in.
   */
  function buildGeneralPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    // Number sliders — same style as Note Trail in the main group.
    var sliderDefs = {
      speed:      { min: 0.1, max: 8.0, step: 0.1, fmt: function (v) { return v.toFixed(1) + 'x'; } },
      trail:      { min: 0.1, max: 8.0, step: 0.1, fmt: function (v) { return v.toFixed(1); } },
      startDelay: { min: 0, max: 10, step: 1, fmt: function (v) { return (v > 0) ? v + ' sec' : 'Off'; } }
    };
    var sliderKeys = ['speed', 'trail', 'startDelay'];
    for (var si = 0; si < sliderKeys.length; si++) {
      var sk = sliderKeys[si];
      var sd = sliderDefs[sk];
      var sdLabel = (sk === 'speed') ? 'Speed' : (sk === 'trail') ? 'Note Trail' : 'Start Delay';
      _sub.ui[sk] = buildSubSliderRow(listEl, sdLabel, sd.min, sd.max, sd.step, _values.visual[sk], sd.fmt);
      _sub.items.push({ type: 'slider', part: sk });
    }

    addSubRow(listEl, 'bool', 'autoPlay', 'Auto Play');
    addSubRow(listEl, 'bool', 'showOsd', 'Show OSD');

    // Background Settings — drills into its own page (color + image actions).
    addSubRow(listEl, 'sub', 'bgSettings', 'Background Settings', null, function () {
      return _values.visual.bgImageName || '';
    });
  }

  /**
   * Build the Loading Bar settings page: master bar visibility toggle,
   * the % readout toggles (analyze/merge), the bar color drill-in and
   * the sliding-vs-gradual animation toggle.
   */
  function buildLoadingBarPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    addSubRow(listEl, 'bool', 'pctBarVisible', 'Show Loading Bar');
    addSubRow(listEl, 'bool', 'pctAnalyze', 'Show % while analyzing');
    addSubRow(listEl, 'bool', 'pctMerge', 'Show % while merging');
    addSubRow(listEl, 'color', 'loadBarColor', 'Loading Color', null, function () {
      return _values.visual.loadBarColor || 'Blue';
    });
    addSubRow(listEl, 'color', 'pctColor', '% Text Color', null, function () {
      return _values.visual.pctColor || 'White';
    });
    addSubRow(listEl, 'bool', 'loadAnimated', 'Sliding Animation');
  }

  /**
   * Build the Dialog settings page: the center pill ("Analyzing…" /
   * "Now playing: …") master toggle plus its text + background colors.
   */
  function buildDialogPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    addSubRow(listEl, 'bool', 'showDialog', 'Show Dialog');
    addSubRow(listEl, 'color', 'dialogTextColor', 'Text Color', null, function () {
      return _values.visual.dialogTextColor || 'White';
    });
    addSubRow(listEl, 'color', 'dialogBgColor', 'Background Color', null, function () {
      return _values.visual.dialogBgColor || 'Black';
    });
  }

  /**
   * Build the Developer Settings page (System Settings → Developer):
   * the Verbose toggles plus the one-shot dev actions. Dev values live
   * in _values.dev (not .visual), so bool rows carry a getVal callback
   * and toggling routes through the 'dev' group mapping.
   */
  function buildDeveloperPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    addSubRow(listEl, 'bool', 'osdLog', 'Verbose Status', null, function () {
      return _values.dev.osdLog;
    });
    addSubRow(listEl, 'bool', 'verboseAnalyze', 'Verbose while analyzing', null, function () {
      return _values.dev.verboseAnalyze;
    });
    addActionRow(listEl, 'memory', 'Memory Stats');
    addActionRow(listEl, 'exportLog', 'Export Log');
    addActionRow(listEl, 'storageTest', 'Storage Test');
  }

  /**
   * Build the Background Settings page: the Background color drill-in
   * plus the Load Background image picker and (while one is loaded) the
   * Clear Background action.
   */
  function buildBackgroundSubPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    addSubRow(listEl, 'color', 'bgColor', 'Background', null, function () {
      return _values.visual.bgColor || '';
    });

    addActionRow(listEl, 'bgImage', 'Load Background', function () {
      return '';
    });
    if (_values.visual.bgImageUrl) {
      addActionRow(listEl, 'bgImageClear', 'Clear Background');
    }
  }

  /**
   * Build the Graphics settings page with two separators:
   *   — Render Mode — 3 radio-style rows (auto/individual/buffer)
   *   — 3D View —      4 radio-style rows (keyboard/notefall/both/none)
   * Radio rows use the same KaiUI radio-button glyph as the Note Color
   * palette page (kai-rbl icon via .palette-radio + .selected class).
   */
  function buildGraphicsPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.ui.renderModeRows = [];
    _sub.ui.view3dRows = [];
    _sub.focusIdx = 0;

    function sep(text) {
      var s = document.createElement('div');
      s.className = 'kai-separator';
      var st = document.createElement('span');
      st.className = 'kai-separator-text';
      st.textContent = text;
      s.appendChild(st);
      listEl.appendChild(s);
    }

    // ── Render Mode radio group ──
    sep('Render Mode');
    var renderModes = [
      ['auto',      'Auto'],
      ['individual','Individual'],
      ['buffer',    'Buffer']
    ];
    var curRender = _values.visual.renderMode || 'auto';
    for (var ri = 0; ri < renderModes.length; ri++) {
      var rm = renderModes[ri];
      var row = document.createElement('div');
      row.className = 'setting-row';
      row.setAttribute('tabindex', '-1');
      row.setAttribute('data-type', 'radio');
      row.setAttribute('data-key', 'renderMode');
      row.setAttribute('data-value', rm[0]);

      var lbl = document.createElement('span');
      lbl.className = 'setting-row-label';
      lbl.textContent = rm[1];
      row.appendChild(lbl);

      var radioEl = document.createElement('span');
      radioEl.className = 'palette-radio';
      row.appendChild(radioEl);

      if (rm[0] === curRender) row.classList.add('selected');

      listEl.appendChild(row);
      _sub.ui.renderModeRows.push({ value: rm[0], row: row });
      _sub.items.push({ type: 'radio', part: 'renderMode', key: 'renderMode', value: rm[0] });
    }

    // ── 3D View radio group ──
    sep('3D View');
    var view3dModes = [
      ['keyboard', 'Keyboard'],
      ['notefall', 'Note fall'],
      ['both',     'Both'],
      ['none',     'None']
    ];
    var curView = _values.visual.view3d || 'both';
    for (var vi = 0; vi < view3dModes.length; vi++) {
      var vm = view3dModes[vi];
      var vrow = document.createElement('div');
      vrow.className = 'setting-row';
      vrow.setAttribute('tabindex', '-1');
      vrow.setAttribute('data-type', 'radio');
      vrow.setAttribute('data-key', 'view3d');
      vrow.setAttribute('data-value', vm[0]);

      var vlbl = document.createElement('span');
      vlbl.className = 'setting-row-label';
      vlbl.textContent = vm[1];
      vrow.appendChild(vlbl);

      var vradioEl = document.createElement('span');
      vradioEl.className = 'palette-radio';
      vrow.appendChild(vradioEl);

      if (vm[0] === curView) vrow.classList.add('selected');

      listEl.appendChild(vrow);
      _sub.ui.view3dRows.push({ value: vm[0], row: vrow });
      _sub.items.push({ type: 'radio', part: 'view3d', key: 'view3d', value: vm[0] });
    }
  }

  /** Highlight the currently-selected radio row in the Graphics page. */
  function _highlightGraphicsRadio(key) {
    var rows, curVal;
    if (key === 'renderMode') {
      rows = _sub.ui.renderModeRows || [];
      curVal = _values.visual.renderMode || 'auto';
    } else if (key === 'view3d') {
      rows = _sub.ui.view3dRows || [];
      curVal = _values.visual.view3d || 'both';
    } else return;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].value === curVal) rows[i].row.classList.add('selected');
      else rows[i].row.classList.remove('selected');
    }
  }

  /**
   * Build the Note Color Settings page.
   * Renders a one-shot "Random note color" action row, a separator
   * ("Note color palette"), one radio-style row per built-in palette,
   * and a "Load more" row that triggers a MozActivity image picker.
   */
  function buildPalettePage(listEl) {
    _sub.items = [];
    _sub.ui.paletteRows = [];
    _sub.focusIdx = 0;

    // One-shot "Random note color" action — regenerates all 16 channel
    // colours. Locked until a real file is loaded (demo/tutorial mode).
    // Placed ABOVE the "Note color palette" separator.
    var rnd = document.createElement('div');
    rnd.className = 'palette-action';
    rnd.textContent = 'Random note color';
    rnd.setAttribute('tabindex', '-1');
    listEl.appendChild(rnd);
    _sub.ui.paletteRandom = rnd;
    _sub.items.push({ type: 'randomaction' });

    // Separator — matches KaiUI kai-separator style.
    var sep = document.createElement('div');
    sep.className = 'kai-separator';
    var sepText = document.createElement('span');
    sepText.className = 'kai-separator-text';
    sepText.textContent = 'Note color palette';
    sep.appendChild(sepText);
    listEl.appendChild(sep);

    // Currently selected palette id.
    var curId = _values.visual.palette || 'random';

    // Palette rows.
    for (var pi = 0; pi < PALETTES.length; pi++) {
      var pal = PALETTES[pi];
      var row = document.createElement('div');
      row.className = 'palette-row';
      row.setAttribute('tabindex', '-1');
      row.setAttribute('data-palette-id', pal.id);

      var nameEl = document.createElement('span');
      nameEl.className = 'palette-row-name';
      nameEl.textContent = pal.label;
      row.appendChild(nameEl);

      // KaiUI radio-button glyph (kai-rbl) — dot appears when selected.
      var radioEl = document.createElement('span');
      radioEl.className = 'palette-radio';
      row.appendChild(radioEl);

      listEl.appendChild(row);
      _sub.ui.paletteRows.push({ id: pal.id, row: row });
      _sub.items.push({ type: 'palette', part: pal.id, key: 'palette' });
    }

    // "Load more" row — triggers MozActivity image picker.
    var loadMore = document.createElement('div');
    loadMore.className = 'palette-loadmore';
    loadMore.textContent = 'Load more';
    loadMore.setAttribute('tabindex', '-1');
    listEl.appendChild(loadMore);
    _sub.items.push({ type: 'loadmore' });
    _sub.ui.loadMore = loadMore;

    // Tick the currently-selected palette (radio highlight).
    _highlightPalette();
  }

  /**
   * Sample colors from a palette image by drawing it to a canvas
   * and reading pixel data at evenly-spaced horizontal positions.
   * The +0.5 offset ensures each sample lands at the CENTER of its
   * color strip rather than on the boundary between two strips.
   */
  function _samplePaletteColors(img, count) {
    var canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var imageData = ctx.getImageData(0, 0, img.width, img.height);
    var data = imageData.data;

    var colors = [];
    for (var i = 0; i < count; i++) {
      var x = Math.floor(((i + 0.5) / count) * img.width);
      var y = Math.floor(img.height / 2); // sample middle row
      var idx = (y * img.width + x) * 4;
      var r = data[idx];
      var g = data[idx + 1];
      var b = data[idx + 2];
      colors.push('#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1));
    }
    return colors;
  }

  /** Highlight the currently selected palette row (radio-style). */
  function _highlightPalette() {
    if (!_sub || !_sub.ui.paletteRows) return;
    var curId = _values.visual.palette || 'random';
    for (var i = 0; i < _sub.ui.paletteRows.length; i++) {
      var pr = _sub.ui.paletteRows[i];
      if (pr.id === curId) pr.row.classList.add('selected');
      else                 pr.row.classList.remove('selected');
    }
  }

  /** Label for a palette id (for toast feedback). */
  function _paletteLabel(id) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === id) return PALETTES[i].label;
    }
    return id;
  }

  /**
   * Apply a stored palette to the live channel colors.
   * 'random' → regenerate random hues; others → sample from their
   * cached or PNG source and push 16 colors into Notes via setPaletteColors.
   */
  function _applyStoredPalette(id) {
    if (typeof Notes === 'undefined') return;
    if (id === 'random' || !id) {
      if (Notes.randomizePalette) Notes.randomizePalette();
      return;
    }
    // Cached custom palette (from "Load more" picker).
    if (_paletteColors[id]) {
      if (Notes.setPaletteColors) Notes.setPaletteColors(_paletteColors[id]);
      return;
    }
    // Built-in palette — sample from the PNG strip and cache.
    // Use def.colors (the actual number of strips in the PNG) rather
    // than PALETTE_SAMPLE_N (16) to avoid sampling at color transitions.
    var def = null;
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === id) { def = PALETTES[i]; break; }
    }
    if (!def || !def.file) return;
    var sampleCount = def.colors || PALETTE_SAMPLE_N;
    var img = new Image();
    img.onload = function () {
      var raw = _samplePaletteColors(img, sampleCount);
      // Cycle to 16 channels — synth10 (10) wraps channels 10-15 to 0-5,
      // synth9 (8) wraps channels 8-15 to 0-7, etc.
      var colors = [];
      for (var c = 0; c < 16; c++) colors.push(raw[c % raw.length]);
      _paletteColors[id] = colors;
      if (Notes.setPaletteColors) Notes.setPaletteColors(colors);
    };
    img.onerror = function () {
      if (Notes.randomizePalette) Notes.randomizePalette();
    };
    img.src = PALETTE_IMG_DIR + def.file;
  }

  /** Launch MozActivity picker for custom palette import. */
  function _launchPalettePicker() {
    // Extract a Blob from any activity-result shape. File manager /
    // gallery builds differ: some return result.blob directly, others
    // nest it under result.data.blob / .blobs[].
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

    function applyBlob(blob) {
      var img = new Image();
      img.onload = function () {
        var colors = _samplePaletteColors(img, PALETTE_SAMPLE_N);
        // Generate a unique id for the custom palette.
        var customId = 'custom_' + Date.now();
        var customLabel = 'Custom Palette';
        _paletteColors[customId] = colors;
        // Apply the sampled colors to the live channel palette.
        if (typeof Notes !== 'undefined' && Notes.setPaletteColors) {
          Notes.setPaletteColors(colors);
        }
        // Insert into PALETTES list and rebuild the page.
        PALETTES.push({ id: customId, label: customLabel, file: null });
        // Auto-select the new palette.
        _values.visual.palette = customId;
        Store.setState({ palette: customId });
        save();
        // Rebuild the palette list.
        var list = document.getElementById('subsettings-list');
        if (list) {
          while (list.firstChild) list.removeChild(list.firstChild);
          buildPalettePage(list);
          _highlightPalette();
          // Focus on the newly added palette.
          for (var j = 0; j < _sub.items.length; j++) {
            if (_sub.items[j].part === customId) {
              _sub.focusIdx = j;
              break;
            }
          }
          paintSubFocus();
        }
        if (typeof showToast === 'function') showToast('Custom palette loaded');
      };
      img.onerror = function () {
        if (typeof showToast === 'function') showToast('Not a valid image file');
      };
      img.src = URL.createObjectURL(blob);
    }

    var retried = false;
    function retryWithType() {
      if (retried) {
        if (typeof showToast === 'function') showToast('Image picker not available');
        return;
      }
      retried = true;
      launch({ type: 'image/*', multiple: false });
    }

    function launch(data) {
      try {
        window._pickerOpen = true;
        var activity = new MozActivity({
          name: 'pick',
          data: data
        });
        activity.onsuccess = function () {
          window._pickerOpen = false;
          var blob = extractBlob(this.result);
          if (blob) {
            applyBlob(blob);
          } else if (typeof showToast === 'function') {
            showToast('Cannot read that file');
          }
        };
        activity.onerror = function (e) {
          window._pickerOpen = false;
          // User-cancelled must NOT reopen the picker.
          var err = (e && (e.name || e.message)) || '';
          if (!/cancel/i.test(err)) retryWithType();
        };
      } catch (e) {
        window._pickerOpen = false;
        retryWithType();
      }
    }

    // Broad pick first (lists File Manager so the user can browse to an
    // exported palette PNG). Builds where that finds no handler fall
    // back to a typed pick (Gallery/Camera/File Manager for images).
    launch(null);
  }

  /**
   * Launch the image picker for the canvas background. Same MozActivity
   * pattern as the palette import, but the picked image is kept as a
   * downscaled, persisted data URL (survives app restarts) instead of
   * being sampled to colors.
   */
  function _launchBgImagePicker() {
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

    function applyBlob(blob, srcPath) {
      // The plain pick shows every file type — reject anything that isn't
      // an image (MIME 'image/*' or a known image extension), so a .mid
      // or other file never becomes the background.
      var mime = String(blob.type || '').toLowerCase();
      var ext = String(blob.name || '').toLowerCase().split('.').pop();
      var IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
      if (mime.indexOf('image/') !== 0 && IMG_EXT.indexOf(ext) === -1) {
        if (typeof showToast === 'function') showToast('Not an image file');
        return;
      }
      // Only keep the source path when it really looks like a storage path
      // (contains a slash) — a bare file name can't be checked at boot and
      // must not trigger a false "missing" dialog.
      var path = String(srcPath || '');
      if (path.indexOf('/') === -1 && path.indexOf('\\') === -1) path = '';
      _values.visual.bgImagePath = path;
      // Persist the image for future runs: downscale to a small JPEG data
      // URL (object URLs die with the app, full-size blobs blow the
      // localStorage quota). Cap the longest side so the stored string
      // stays comfortably tiny.
      var MAX_SIDE = 640;
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_SIDE / (img.width || 1), MAX_SIDE / (img.height || 1));
        var w = Math.max(1, Math.round((img.width || 1) * scale));
        var h = Math.max(1, Math.round((img.height || 1) * scale));
        var cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        var cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0, w, h);
        var dataUrl;
        try { dataUrl = cv.toDataURL('image/jpeg', 0.8); }
        catch (e) { dataUrl = cv.toDataURL(); }
        if (!dataUrl || dataUrl.length > 2500000) {
          if (typeof showToast === 'function') showToast('Image too large');
          return;
        }
        // The picker may hand back a full path — keep only the file name.
        _values.visual.bgImageUrl = dataUrl;
        _values.visual.bgImageName = (blob.name || 'Image').split('/').pop().split('\\').pop();
        save();
        Store.setState({
          bgImageUrl: dataUrl,
          bgImageName: _values.visual.bgImageName,
          bgImagePath: _values.visual.bgImagePath
        });
        if (typeof window.pfaSetBgImage === 'function') {
          window.pfaSetBgImage(dataUrl);
        }
        _rebuildSubRows();
        if (typeof showToast === 'function') showToast('Background image saved');
      };
      img.onerror = function () {
        if (typeof showToast === 'function') showToast('Not a valid image file');
      };
      img.src = URL.createObjectURL(blob);
    }

    var retried = false;
    function retryWithType() {
      if (retried) {
        if (typeof showToast === 'function') showToast('Image picker not available');
        return;
      }
      retried = true;
      launch({ type: 'image/*', multiple: false });
    }

    function launch(data) {
      try {
        window._pickerOpen = true;
        var activity = new MozActivity({ name: 'pick', data: data });
        activity.onsuccess = function () {
          window._pickerOpen = false;
          var res = this.result;
          var blob = extractBlob(res);
          if (blob) {
            // Source path for the boot existence check. Pickers return
            // name/path differently; blob.name may itself be a full path.
            var p = '';
            try {
              if (res && (res.path || res.name)) p = String(res.path || res.name);
              else if (blob.name) p = String(blob.name);
            } catch (e2) { p = ''; }
            applyBlob(blob, p);
          } else if (typeof showToast === 'function') {
            showToast('Cannot read that file');
          }
        };
        activity.onerror = function (e) {
          window._pickerOpen = false;
          var err = (e && (e.name || e.message)) || '';
          if (!/cancel/i.test(err)) retryWithType();
        };
      } catch (e) {
        window._pickerOpen = false;
        retryWithType();
      }
    }

    // Plain pick — the format that works on the device:
    //   new MozActivity({ name: 'pick' })
    // No type filter data (some builds ignore/fail the image/* hint).
    launch(null);
  }

  /** Clear the loaded background image (reset row, re-render). */
  function _clearBgImage(skipToast) {
    _values.visual.bgImageUrl = null;
    _values.visual.bgImageName = '';
    _values.visual.bgImagePath = '';
    save();
    Store.setState({ bgImageUrl: null, bgImageName: '', bgImagePath: '' });
    if (typeof window.pfaSetBgImage === 'function') {
      window.pfaSetBgImage(null);
    }
    _rebuildSubRows();
    if (!skipToast && typeof showToast === 'function') showToast('Background image cleared');
  }
  // Silent clear used at boot to drop a corrupt/unloadable saved image.
  window.clearBgImageAction = function () { _clearBgImage(true); };

  /** Rebuild the currently-open sub-page rows in place (keeps focus). */
  function _rebuildSubRows() {
    var list = document.getElementById('subsettings-list');
    if (!list || typeof _sub === 'undefined' || !_sub) return;
    var kind = _sub.kind;
    var idx = _sub.focusIdx || 0;
    _sub.items = [];
    _sub.ui.boolRows = {};
    while (list.firstChild) list.removeChild(list.firstChild);
    if (kind === 'background') buildBackgroundSubPage(list);
    else if (kind === 'general') buildGeneralPage(list);
    if (_sub && _sub.items.length) setSubFocus(Math.min(idx, _sub.items.length - 1));
  }

  /**
   * Cycle an enum row in the Info Card Options page (Left/Right).
   */
  function cycleSubEnum(item, dir) {
    if (!_sub || !item || !item.choices || !item.choices.length) return;
    var cur = _values.visual[item.part];
    var idx = indexOfChoice(item.choices, cur);
    var n = item.choices.length;
    idx = (idx + dir + n) % n;
    var next = item.choices[idx][0];
    // Keyboard Range Key Count: applying a preset rewrites kbStart/kbEnd
    // and rebuilds the page in place (sliders only exist in 'custom').
    if (item.part === 'kbSize' && _sub.kind === 'range') {
      applyKbPresetSize(next);
      return;
    }
    _values.visual[item.part] = next;
    Store.setState(_mapToStore(_openGroup, item.part, next));
    save();
    if (_sub.kind === 'bools') applyInfoCard();
    var ref = _sub.ui.boolRows && _sub.ui.boolRows[item.part];
    if (ref && ref.valEl) ref.valEl.textContent = item.choices[idx][1];
  }

  /**
   * Toggle one Info Card boolean (master gate or per-stat switch),
   * persist it and re-apply HUD visibility immediately.
   */
  function toggleSubBool(key) {
    if (!_sub || (_sub.kind !== 'bools' && _sub.kind !== 'piano' && _sub.kind !== 'general' &&
                 _sub.kind !== 'graphics' && _sub.kind !== 'loadingBar' && _sub.kind !== 'dialog' &&
                 _sub.kind !== 'developer')) return;
    if (_sub.kind === 'developer') {
      // Dev toggles persist under the 'dev' group, not .visual.
      var next = !_values.dev[key];
      _values.dev[key] = next;
      Store.setState(_mapToStore('dev', key, next));
      if (key === 'osdLog' && typeof window.pfaSetDevOsd === 'function') {
        // Live-toggle the on-screen verbose overlay (hook lives in main.js).
        setTimeout(function () { try { window.pfaSetDevOsd(!!_sub ? next : false); } catch (e) {} }, 0);
      }
      save();
      var dRef = _sub.ui.boolRows && _sub.ui.boolRows[key];
      if (dRef && dRef.valEl) dRef.valEl.textContent = next ? 'On' : 'Off';
      return;
    }
    var next = !_values.visual[key];
    _values.visual[key] = next;
    Store.setState(_mapToStore(_openGroup, key, next));
    save();
    if (_sub.kind === 'bools') {
      applyInfoCard();
      if (key === 'infoCard') {
        // Master flipped → rebuild the page collapsed/expanded in place.
        // Focus lands back on the master row (idx 0).
        var list = document.getElementById('subsettings-list');
        if (list) {
          while (list.firstChild) list.removeChild(list.firstChild);
          buildBoolPage(list);
          paintSubFocus();
        }
        return; // row refs were rebuilt — no stale valEl write
      }
    } else if (_sub.kind === 'loadingBar') {
      // Loading-bar presentation changed → live-apply while a parse runs.
      if (typeof window.applyParseBarStyle === 'function') {
        try { window.applyParseBarStyle(); } catch (e) {}
      }
    } else if (_sub.kind === 'dialog') {
      // showDialog is read live by the pill paths — nothing else to do.
    }
    var ref = _sub.ui.boolRows && _sub.ui.boolRows[key];
    if (ref && ref.valEl) ref.valEl.textContent = next ? 'On' : 'Off';
  }

  /**
   * Handle a key event while a level-2 page is open. Returns true when
   * consumed (always, except the guard case below).
   */
  function handleSubKey(key) {
    if (!_sub) return false;

    // Back → back to the group page. ONLY the hardware Back key exits —
    // LSK/RSK are strictly forbidden inside sub-pages.
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE) {
      closeSub();
      return true;
    }

    // Vertical: the COLOR page uses a column-aware grid walk (DEF ↕
    // bottom wrap, grid columns mapping onto R/G/B/A). Other pages:
    // swatches AND the DEF cell stride by SWATCH_COLS, rest step by one.
    // All movement wraps around (bottom ↔ top).
    if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) {
      var itU = _sub.items[_sub.focusIdx];
      if (_sub.kind === 'color' && itU &&
          (itU.type === 'swatch' || itU.type === 'def' || itU.type === 'slider')) {
        moveColorVertical(-1);
      } else {
        moveSubFocus(itU && (itU.type === 'swatch' || itU.type === 'def')
          ? -SWATCH_COLS : -1);
      }
      return true;
    }
    if (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
      var itD = _sub.items[_sub.focusIdx];
      if (_sub.kind === 'color' && itD &&
          (itD.type === 'swatch' || itD.type === 'def' || itD.type === 'slider')) {
        moveColorVertical(+1);
      } else {
        moveSubFocus(itD && (itD.type === 'swatch' || itD.type === 'def')
          ? +SWATCH_COLS : +1);
      }
      return true;
    }

    if (key === 'ArrowLeft' || key === Constants.KEY.ARROW_LEFT) {
      adjustFocusedSub(-1);
      return true;
    }
    if (key === 'ArrowRight' || key === Constants.KEY.ARROW_RIGHT) {
      // Color/sub rows drill into their sub-page on Right (like the group page)
      var itR = _sub.items[_sub.focusIdx];
      if (drillSubRow(itR)) return true;
      adjustFocusedSub(+1);
      return true;
    }

    // Enter activates drill-in rows / swatch/DEF cells — but NEVER toggles
    // booleans (Info Card / Piano rows are Left/Right only by design).
    if (key === Constants.KEY.ENTER || key === 13 || key === 'Enter') {
      var itE = _sub.items[_sub.focusIdx];
      if (drillSubRow(itE)) return true;
      if (itE && itE.type === 'bool') return true; // swallowed on purpose
      activateFocusedSub();
      return true;
    }

    return true; // modal page swallows everything else
  }

  // ── Row DOM ──

  function rebuildRows(overlay, group) {
    var list = overlay.querySelector('#settings-list');
    if (!list) return;
    // clear children
    while (list.firstChild) list.removeChild(list.firstChild);

    var schema = SCHEMA[group];
    var vals = _values[group] || {};
    for (var i = 0; i < schema.length; i++) {
      var def = schema[i];
      // Context-sensitive rows (e.g. Cancel Analysis: only while a
      // conversion is running) are skipped entirely when hidden.
      if (typeof def.hidden === 'function' && def.hidden()) continue;
      var val = vals[def.key];
      var row = document.createElement('div');
      row.setAttribute('tabindex', '-1');
      row.setAttribute('data-key', def.key);
      row.setAttribute('data-type', def.type);
      // Storage permission denied → dim "Export Log" (guard also in
      // runDevAction, but keep it visibly disabled).
      if (def.key === 'exportLog' && typeof window !== 'undefined' &&
          typeof window.pfaStorageGranted === 'function' && !window.pfaStorageGranted()) {
        row.classList.add('perm-locked');
      }
      if (def.type === 'sub') {
        row.setAttribute('data-subkind', def.subkind || 'range');
      }
      row.setAttribute('data-index', i);

      if (def.type === 'number') {
        // Slider variant: header row + live numeric tracker + range input.
        // CSS for `.setting-row-slider` (and the input[type=range] parts)
        // is in kaiui.css — it matches KaiUI-master's `--ratio`/`--sx`
        // fill calculation so focused/unfocused look matches KaiUI.
        row.className = 'setting-row-slider';

        var line = document.createElement('div');
        line.className = 'setting-row-slider-line';

        var hdr = document.createElement('span');
        hdr.className = 'setting-row-slider-header';
        hdr.textContent = def.label;
        line.appendChild(hdr);

        var trk = document.createElement('span');
        trk.className = 'setting-row-slider-tracker';
        trk.textContent = formatValue(def, val);
        line.appendChild(trk);

        row.appendChild(line);

        var input = document.createElement('input');
        input.type = 'range';
        input.setAttribute('min', String(def.min));
        input.setAttribute('max', String(def.max));
        if (def.step != null) input.setAttribute('step', String(def.step));
        input.value = String(val);
        // CSS expects --min/--max/--val custom props on the input.
        input.style.setProperty('--min', String(def.min));
        input.style.setProperty('--max', String(def.max));
        input.style.setProperty('--val', String(val));
        row.appendChild(input);

        // Keep tracker + CSS fill in sync on native input change.
        // IIFE closure captures input/def/trk to avoid .bind() arg-shift
        // where ev ended up as the 4th positional arg (undefined).
        (function (capturedInput, capturedDef, capturedTrk) {
          capturedInput.addEventListener('input', function () {
            var v = parseFloat(capturedInput.value);
            capturedTrk.textContent = formatValue(capturedDef, v);
            capturedInput.style.setProperty('--val', String(v));
          });
        }(input, def, trk));

        list.appendChild(row);
      } else {
        row.className = 'setting-row';

        var lbl = document.createElement('span');
        lbl.className = 'setting-row-label';
        lbl.textContent = (typeof def.labelFn === 'function') ? def.labelFn() : def.label;
        row.appendChild(lbl);

        var valEl = document.createElement('span');
        valEl.className = 'setting-row-value';

        if (def.type === 'sub') {
          // Drill-in row — forward arrow drawn by CSS via
          // .setting-row.has-sub::after (gaia-icons 'forward'), the SAME
          // glyph the Options menu uses for MIDI-OUT / Visual Settings.
          row.classList.add('has-sub');
          // Sub rows may still advertise their current value (e.g.
          // Start Delay "-1.0s" / "Off") next to the arrow. Number()
          // guards against a stringified value crashing toFixed().
          if (typeof def.fmt === 'function') {
            try { valEl.textContent = def.fmt(Number(val) || 0); }
            catch (e) { valEl.textContent = 'Off'; }
          }
        } else if (def.type === 'color') {
          // Color drill-in row — small chip previewing the current color;
          // bgColor null renders as 'Auto'. Same forward arrow as above.
          row.classList.add('has-sub');
          if (val) {
            var chip = document.createElement('span');
            chip.className = 'color-chip';
            chip.style.background = val;
            valEl.appendChild(chip);
            var hexTxt = document.createElement('span');
            hexTxt.textContent = String(val);
            valEl.appendChild(hexTxt);
          } else {
            valEl.textContent = 'Auto';
          }
        } else if (def.type === 'action') {
          // One-shot action row (Export Log) — arrow glyph, no value text;
          // Enter / ArrowRight fires the action, never cycles a value.
          row.classList.add('has-sub');
        } else {
          valEl.textContent = formatValue(def, val);
        }

        row.appendChild(valEl);

        list.appendChild(row);
      }
    }
  }

  function formatValue(def, val) {
    if (def.type === 'action') return '';
    if (def.type === 'bool') return val ? 'On' : 'Off';
    if (def.type === 'enum') {
      for (var i = 0; i < def.choices.length; i++) {
        if (def.choices[i][0] === val) return def.choices[i][1];
      }
      return String(val);
    }
    if (def.type === 'number') {
      if (typeof def.fmt === 'function') return def.fmt(val);
      return String(val);
    }
    return String(val);
  }

  function focusRow(rows, idx) {
    _focusIdx = idx;
    for (var i = 0; i < rows.length; i++) {
      if (i === idx) rows[i].classList.add('focused');
      else          rows[i].classList.remove('focused');
    }
    var focused = rows[idx];
    if (!focused) return;
    // Manual scroll in rAF to ensure layout is ready (rows just built
    // by rebuildRows inside Settings.open). scrollIntoView() triggers
    // synchronous layout + Gecko 48 swallows the following keydown.
    // rAF pushes scroll to next paint, avoiding the keydown swallow.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        var list = document.getElementById('settings-list');
        if (list && list.scrollHeight > list.clientHeight) {
          var top = focused.offsetTop;
          var bot = top + focused.offsetHeight;
          var listTop = list.scrollTop;
          var listBot = listTop + list.clientHeight;
          if (top < listTop)      list.scrollTop = top;
          else if (bot > listBot) list.scrollTop = bot - list.clientHeight;
        }
      });
    } else {
      var list = document.getElementById('settings-list');
      if (list && list.scrollHeight > list.clientHeight) {
        var top = focused.offsetTop;
        var bot = top + focused.offsetHeight;
        var listTop = list.scrollTop;
        var listBot = listTop + list.clientHeight;
        if (top < listTop)      list.scrollTop = top;
        else if (bot > listBot) list.scrollTop = bot - list.clientHeight;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Keyboard navigation when overlay is open
  // ──────────────────────────────────────────────────────────────────

  /**
   * Handle a key event while overlay is open. Returns true if consumed.
   * controls.js calls this BEFORE the menu path so settings wins priority.
   * A level-2 sub-page (range/color) intercepts all keys while open.
   */
  function handleKey(key) {
    if (!_openGroup) return false;

    // Level-2 page open → it owns the keyboard until Back/SoftRight
    if (_sub) return handleSubKey(key);

    var overlay = document.getElementById('settings-overlay');
    if (!overlay) return false;
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider');
    if (!rows.length) return false;

    // Back → return to the group we drilled in from (Developer inside
    // System → System; any hub page → hub), else close.
    // ONLY the hardware Back key — LSK/RSK are forbidden.
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE) {
      if (_hubReturn && _openGroup !== 'hub') {
        switchBack();
        return true;
      }
      close();
      return true;
    }

    // Enter on a drill-in row opens its sub-page. Plain rows cycle
    // values with Left/Right only — Enter is intentionally inert.
    // SoftLeft must NEVER open sub-pages (LSK forbidden in settings).
    if (key === Constants.KEY.ENTER || key === 13 || key === 'Enter') {
      var rowE = rows[_focusIdx];
      var t = rowE && rowE.getAttribute('data-type');
      if (t === 'sub') {
        // Group-switch rows (System/Visual/Synth hub pages + the Developer
        // row inside System settings) swap the overlay to their group;
        // everything else drills into its level-2 sub-page.
        var hg = HUB_GROUP_MAP[rowE.getAttribute('data-subkind')];
        if (hg) { switchToGroup(hg); return true; }
        openSub(rowE.getAttribute('data-subkind') || 'range',
                rowE.getAttribute('data-key'));
        return true;
      }
      if (t === 'color') {
        openSub('color', rowE.getAttribute('data-key'));
        return true;
      }
      if (t === 'action') {
        // One-shot dev action rows fire on Enter / ArrowRight.
        runDevAction(rowE);
        return true;
      }
      return true; // consumed but no-op for plain rows
    }

    // ArrowUp/Down: nav with WRAP-AROUND (bottom ↔ top)
    if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) {
      _focusIdx = (_focusIdx - 1 + rows.length) % rows.length;
      focusRow(rows, _focusIdx);
      return true;
    }
    if (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
      _focusIdx = (_focusIdx + 1) % rows.length;
      focusRow(rows, _focusIdx);
      return true;
    }

    // ArrowRight → drill-in on sub/color rows, otherwise cycle forward
    if (key === 'ArrowRight' || key === Constants.KEY.ARROW_RIGHT) {
      var rowR = rows[_focusIdx];
      var tR = rowR && rowR.getAttribute('data-type');
      if (tR === 'sub') {
        var hgR = HUB_GROUP_MAP[rowR.getAttribute('data-subkind')];
        if (hgR) { switchToGroup(hgR); return true; }
        openSub(rowR.getAttribute('data-subkind') || 'range',
                rowR.getAttribute('data-key'));
        return true;
      }
      if (tR === 'color') { openSub('color', rowR.getAttribute('data-key')); return true; }
      if (tR === 'action') {
        runDevAction(rowR);
        return true;
      }
      cycleValue(rowR, +1);
      return true;
    }
    if (key === 'ArrowLeft' || key === Constants.KEY.ARROW_LEFT) {
      cycleValue(rows[_focusIdx], -1);
      return true;
    }

    return false; // not consumed
  }

  function cycleValue(row, dir) {
    if (!row) return;
    var key = row.getAttribute('data-key');
    var type = row.getAttribute('data-type');
    var def = findDef(_openGroup, key);
    if (!def) return;
    if (type === 'action') return; // one-shot rows never cycle

    var current = _values[_openGroup][key];
    var next;
    if (type === 'bool') {
      next = !current;
    } else if (type === 'enum') {
      var idx = indexOfChoice(def.choices, current);
      var n = def.choices.length;
      idx = (idx + dir + n) % n;
      next = def.choices[idx][0];
    } else if (type === 'number') {
      // Compute next value by stepping forward/backward. The <input>
      // may or may not hold a different value (e.g. user dragged it),
      // but for key cycling we always delta from the stored current.
      var step = def.step || 0.1, mn = def.min || 0.1, mx = def.max || 8.0;
      next = (current || mn) + dir * step;
      next = Math.min(mx, Math.max(mn, next));

      // Snap to step grid + clamp. Gecko 48 occasionally surfaces
      // 0.30000000004 from a stepped range; round to step first,
      // then snap to fixed precision based on the step's decimal
      // places so we don't carry floating-point residue downstream.
      if (step) {
        var prec = 0;
        var stepStr = String(step);
        var dot = stepStr.indexOf('.');
        if (dot >= 0) prec = stepStr.length - dot - 1;
        next = Math.round(next / step) * step;
        if (prec > 0) next = parseFloat(next.toFixed(prec));
      }
      if (def.min != null) next = Math.max(def.min, next);
      if (def.max != null) next = Math.min(def.max, next);
    } else {
      return;
    }

    applyChange(_openGroup, key, next, def, row);
  }

  function inputValue(row) {
    var input = row && row.querySelector('input[type="range"]');
    return input ? parseFloat(input.value) : null;
  }

  // One-shot dev action rows: dispatch by row key.
  function runDevAction(rowE) {
    var k = rowE ? rowE.getAttribute('data-key') : '';
    try {
      if (k === 'randomColors') {
        // Note Color Palette Randomise — locked until a real file is loaded
        // (demo active or finished but no file yet). Mirrors Key 4 / the old
        // Options menu item.
        try {
          if (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked()) {
            if (typeof showToast === 'function') showToast('Locked until a file loads');
            return;
          }
        } catch (e) {}
        if (typeof Notes !== 'undefined' && Notes.randomizePalette) {
          Notes.randomizePalette();
          if (typeof HUD !== 'undefined' && HUD.showOsd) HUD.showOsd('Track colors randomised', 2000);
        }
      }
      else if (k === 'exportLog') {
        if (typeof window.pfaStorageGranted === 'function' && !window.pfaStorageGranted()) {
          // Explicit user action — always respond with the grant path
          // (force), never a silent no-op.
          if (typeof window.pfaGuardStorageLoad === 'function') window.pfaGuardStorageLoad(true);
          return;
        }
        if (typeof window.pfaExportLog === 'function') window.pfaExportLog();
      }
      else if (k === 'memory' && typeof window.pfaDumpMemory === 'function') window.pfaDumpMemory();
      else if (k === 'storageTest' && typeof window.pfaStorageDiagnose === 'function') window.pfaStorageDiagnose();
      else if (k === 'resetAll' && typeof window.openResetConfirm === 'function') window.openResetConfirm();
      else if (k === 'about' && typeof window.showAboutApp === 'function') window.showAboutApp();
      else if (k === 'loadMidi' && typeof window.launchPickerAction === 'function') window.launchPickerAction();
      else if (k === 'cancelAnalysis' && typeof window.cancelAnalyze === 'function') window.cancelAnalyze();
      else if (k === 'clearMidi' && typeof window.clearMidiAction === 'function') window.clearMidiAction();
      else if (k === 'fullscreen' && typeof window.toggleFullscreen === 'function') window.toggleFullscreen();
      else if (k === 'rotate' && typeof window.rotateScreen === 'function') window.rotateScreen();
      else if (k === 'volume' && typeof window.showOSDVolume === 'function') window.showOSDVolume();
    } catch (e) {
      // Never leave an explicit action unresponsive.
      try {
        if (typeof window.showDevDialog === 'function') window.showDevDialog('Action failed: ' + e);
      } catch (e2) {}
    }
  }

  function applyChange(group, key, next, def, row) {
    _values[group][key] = next;

    // Live-update DOM value text
    if (row) {
      if (def.type === 'number') {
        // Slider variant: nudge the <input> so the value stays the
        // single source of truth (CSS `--val` + thumb position read
        // from it). The header tracker is updated by the row's own
        // 'input' listener, but fire one synthetically so the tracker
        // is in lockstep without us wiring a second handler here.
        var input = row.querySelector('input[type="range"]');
        if (input) {
          input.value = String(next);
          input.style.setProperty('--val', String(next));
        }
        var trk = row.querySelector('.setting-row-slider-tracker');
        if (trk) trk.textContent = formatValue(def, next);
      } else {
        var valEl = row.querySelector('.setting-row-value');
        if (valEl) valEl.textContent = formatValue(def, next);
      }
    }

    // Push to store (shallow-merge; one key at a time is cheap)
    Store.setState(_mapToStore(group, key, next));

    // Side-effects (applyInfoCard, keyboard rebuild, etc.)
    if (group === 'visual') {
      if (key === 'infoCard' || key.indexOf('info') === 0) {
        applyInfoCard();
      } else if (key === 'pianoColorHex') {
        // White-key fill color changed → rebuild the piano spritesheet
        if (typeof Keyboard !== 'undefined' && Keyboard.rebuild) {
          Keyboard.rebuild();
        }
      } else if (key === 'kbRange' || key === 'kbStart' || key === 'kbEnd') {
        // Range changed → re-fit key width to the new visible window
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      } else if (key === 'pctBarVisible' || key === 'loadAnimated' || key === 'loadBarColor' ||
               key === 'pctColor' || key === 'pctAnalyze' || key === 'pctMerge') {
        // Loading-bar presentation changed → live-apply while a parse runs.
        if (typeof window.applyParseBarStyle === 'function') {
          try { window.applyParseBarStyle(); } catch (e) {}
        }
      } else if (key === 'dialogTextColor' || key === 'dialogBgColor') {
        // Center-pill colors changed → re-apply to the pill.
        if (typeof window.applyDialogStyle === 'function') {
          try { window.applyDialogStyle(); } catch (e) {}
        }
      }
      // pianoSize needs no hook — renderers read Keyboard.height() per frame
    }
    if (group === 'midi' && key === 'engine' && next === 'soundbank') {
      if (typeof window !== 'undefined' && window.Soundbank &&
          !Soundbank.isReady()) {
        if (typeof showToast === 'function') showToast('Soundbank not loaded');
      }
    }

    if (group === 'dev' && key === 'osdLog') {
      // Live-toggle the on-screen verbose overlay (window hook lives in
      // main.js; defer a tick so the overlay exists after first paint).
      if (typeof window.pfaSetDevOsd === 'function') {
        setTimeout(function () { try { window.pfaSetDevOsd(!!next); } catch (e) {} }, 0);
      }
    }

    if (group === 'sys' && (key === 'autoFullscreen' || key === 'autoRotate')) {
      // Launch-only behaviour — tell the user it takes effect next launch.
      if (typeof showToast === 'function') {
        setTimeout(function () {
          try { showToast(next ? 'Applied on next launch' : 'Off from next launch'); } catch (e) {}
        }, 0);
      }
    }

    // Persist
    save();
  }

  function _mapToStore(group, key, val) {
    if (group === 'midi') {
      if (key === 'engine')       return { engine: val };
      if (key === 'waveform')     return { waveform: val };
      if (key === 'audio')        return { audio: val };
      if (key === 'skipSlowOpen') return { skipSlowOpen: val };
    } else if (group === 'visual') {
      if (key === 'renderMode')    return { renderMode: val };
      if (key === 'speed')         return { speed: val };
      if (key === 'trail')         return { trail: val };
      if (key === 'autoPlay')      return { autoPlay: val };
      if (key === 'showDialog')    return { showDialog: val };
      if (key === 'showOsd')       return { showOsd: val };
      if (key === 'startDelay')    return { startDelay: val };
      if (key === 'noteLabels')    return { noteLabels: val };
      if (key === 'middleMarker') return { middleMarker: val };
      if (key === 'infoCard')      return { infoCard: val };
      if (key === 'infoNps')       return { infoNps: val };
      if (key === 'infoNoteCount') return { infoNoteCount: val };
      if (key === 'infoPassed')    return { infoPassed: val };
      if (key === 'infoSpeed')     return { infoSpeed: val };
      if (key === 'infoTime')      return { infoTime: val };
      if (key === 'infoFps')       return { infoFps: val };
      if (key === 'infoPolyphony')    return { infoPolyphony: val };
      if (key === 'infoRendered')     return { infoRendered: val };
      if (key === 'infoAudioBuffer')  return { infoAudioBuffer: val };
      if (key === 'infoTick')         return { infoTick: val };
      if (key === 'infoBpm')          return { infoBpm: val };
      if (key === 'infoFloating')     return { infoFloating: val };
      if (key === 'infoBorder')       return { infoBorder: val };
      if (key === 'infoBorderColor')  return { infoBorderColor: val };
      if (key === 'infoBgColor')      return { infoBgColor: val };
      if (key === 'infoTextColor')    return { infoTextColor: val };
      if (key === 'infoPos')          return { infoPos: val };
      if (key === 'kbStart')       return { kbStart: val };
      if (key === 'kbEnd')         return { kbEnd: val };
      if (key === 'kbSize')        return { kbSize: val };
      if (key === 'kbRange')       return { kbStart: _values.visual.kbStart, kbEnd: _values.visual.kbEnd };
      if (key === 'bgColor')       return { bgColor: val };
      if (key === 'barColor')      return { barColor: val };
      if (key === 'pianoColorHex') return { pianoColorHex: val };
      if (key === 'pianoSize')     return { pianoSize: val };
      if (key === 'view3d')        return { view3d: val };
      if (key === 'palette')       return { palette: val };
      if (key === 'pctAnalyze')    return { pctAnalyze: val };
      if (key === 'pctMerge')      return { pctMerge: val };
      if (key === 'pctBarVisible') return { pctBarVisible: val };
      if (key === 'loadAnimated')  return { loadAnimated: val };
      if (key === 'loadBarColor')  return { loadBarColor: val };
      if (key === 'pctColor')      return { pctColor: val };
      if (key === 'dialogTextColor') return { dialogTextColor: val };
      if (key === 'dialogBgColor')   return { dialogBgColor: val };
    } else if (group === 'dev') {
      if (key === 'osdLog')         return { osdLog: val };
      if (key === 'verboseAnalyze') return { verboseAnalyze: val };
    } else if (group === 'sys') {
      if (key === 'autoFullscreen') return { autoFullscreen: val };
      if (key === 'autoRotate')     return { autoRotate: val };
    }
    return {};
  }

  // ── Visual theme application ──

  function applyTheme(theme) {
    // Set data-theme on <html>; CSS in app.css acts on each value.
    document.documentElement.setAttribute('data-theme', theme || 'dark');
  }

  /**
   * Apply Info Card visibility + appearance. Each HUD stat shows only
   * when the master gate (infoCard) AND its own switch are both On.
   * Appearance (position/floating/border/bg/text) is applied onto #hud
   * via inline styles so Settings wins over the app.css defaults.
   */
  function applyInfoCard() {
    var v = _values.visual;

    // Read the LIVE runtime value from Store (not the boot cache) so the
    // Call-key / hot-key toggle (which only writes Store) takes effect here.
    var live = null;
    try { live = Store.getState(); } catch (e) { live = null; }
    var infoCard = live && live.infoCard != null ? live.infoCard : v.infoCard;

    // DEMO: while the bundled demo is playing (or the demo finished but no
    // real .mid/.note is loaded yet) the Info card stays hidden and none of
    // the Info Card appearance settings apply. They take effect only after
    // a real file loads. The card is force-hidden regardless of master gate.
    var demoLock;
    try {
      demoLock = (typeof window.isDemoActive === 'function' && window.isDemoActive())
              || (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked());
    } catch (e) { demoLock = false; }

    var hud = document.getElementById('hud');
    if (demoLock) {
      if (hud) {
        hud.style.display = 'none';
        hud.style.removeProperty('background');
        hud.style.removeProperty('border');
      }
      return;
    }

    function gate(id, on) {
      var el = document.getElementById(id);
      if (!el) return;
      if (infoCard && on) el.classList.remove('hidden');
      else                el.classList.add('hidden');
    }
    gate('hud-note-count', v.infoNps);
    gate('hud-nc',           v.infoNoteCount);
    gate('hud-passed',       v.infoPassed);
    gate('hud-speed',      v.infoSpeed);
    gate('hud-time',       v.infoTime);
    gate('hud-fps',        v.infoFps);
    gate('hud-polyphony',     v.infoPolyphony);
    gate('hud-rendered',      v.infoRendered);
    gate('hud-audio-buffer',  v.infoAudioBuffer);
    gate('hud-tick',          v.infoTick);
    gate('hud-bpm',           v.infoBpm);

    if (!hud) return;

    // Master gate off → hide the entire card (not just each stat).
    if (!infoCard) { hud.style.display = 'none'; return; }
    hud.style.display = '';

    // Position: left or right edge.
    var right = (v.infoPos === 'right');
    hud.style.left  = right ? 'auto' : '0px';
    hud.style.right = right ? '0px' : 'auto';
    hud.style.alignItems = right ? 'flex-end' : 'flex-start';
    hud.style.textAlign  = right ? 'right' : 'left';

    // Floating: detach from the edge with a small gap + rounded corners.
    var gap = v.infoFloating ? 6 : 0;
    var topEdge = v.infoFloating ? 6 : 0;
    hud.style.top  = topEdge + 'px';
    hud.style.left = right ? 'auto' : gap + 'px';
    hud.style.right = right ? gap + 'px' : 'auto';
    hud.style.borderRadius = v.infoFloating ? '4px' : '0px';

    // Border around the card (colour RGBA, only when Border is On).
    hud.style.border = v.infoBorder
      ? '1px solid ' + (v.infoBorderColor || '#ffffff')
      : 'none';

    // Background RGBA (default black).
    hud.style.background = v.infoBgColor || '#000000';

    // Text colour RGBA applied to every stat line.
    var color = v.infoTextColor || '#ffffff';
    hud.style.color = color;
    var stats = hud.querySelectorAll('.hud-stat');
    for (var i = 0; i < stats.length; i++) stats[i].style.color = color;
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────

  function findDef(group, key) {
    var arr = SCHEMA[group];
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].key === key) return arr[i];
    }
    return null;
  }

  function indexOfChoice(choices, val) {
    for (var i = 0; i < choices.length; i++) {
      if (choices[i][0] === val) return i;
    }
    return 0;
  }

  function clone(o) {
    var out = {};
    for (var k in o) {
      if (o.hasOwnProperty(k)) {
        if (o[k] && typeof o[k] === 'object') {
          out[k] = clone(o[k]);
        } else {
          out[k] = o[k];
        }
      }
    }
    return out;
  }

  function merge(base, patch) {
    var out = clone(base);
    if (!patch || typeof patch !== 'object') return out;
    for (var k in patch) {
      if (!patch.hasOwnProperty(k)) continue;
      if (patch[k] && typeof patch[k] === 'object' && base[k] && typeof base[k] === 'object') {
        out[k] = merge(base[k], patch[k]);
      } else if (patch[k] !== undefined) {
        out[k] = patch[k];
      }
    }
    return out;
  }

  /**
   * Apply a single Visual setting change from OUTSIDE the settings UI
   * (hotkeys in controls.js etc.). Mirrors applyChange's persist + side
   * effects so the Settings overlays reflect the live value next time
   * they open (e.g. hotkey-toggle 88/128 keys updates Key Count too).
   */
  function applyVisual(key, val) {
    try { applyChange('visual', key, val, null, null); }
    catch (e) {
      if (typeof console !== 'undefined') console.error('[Settings] applyVisual failed', key, e);
    }
  }

  /**
   * Apply a Keyboard Range preset from outside the settings UI (hotkeys):
   * '88' | '128' | 'custom' — same path as the in-page Key Count row.
   */
  function setKbPreset(size) {
    applyKbPresetSize(size);
  }

  /**
   * Rebuild the currently-open group's rows in place (used when a
   * context-sensitive row's visibility changes — e.g. Cancel Analysis
   * appears/disappears when an analysis starts/finishes). Preserves focus.
   */
  function refreshCurrentRows() {
    if (_sub) return; // level-2 page open — backbone rows not visible
    var overlay = document.getElementById('settings-overlay');
    if (!overlay || overlay.classList.contains('hidden') || !_openGroup) return;
    if (_openGroup === 'hub') return;
    rebuildRows(overlay, _openGroup);
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider');
    if (rows.length) focusRow(rows, Math.min(_focusIdx, rows.length - 1));
  }

  return {
    load:           load,
    save:           save,
    reset:          reset,
    open:           open,
    close:          close,
    isOpen:         isOpen,
    openGroup:      openGroup,
    handleKey:      handleKey,
    applyTheme:     applyTheme,
    applyInfoCard:  applyInfoCard,
    applyVisual:    applyVisual,
    setKbPreset:    setKbPreset,
    refreshCurrentRows: refreshCurrentRows,
  };
})();
