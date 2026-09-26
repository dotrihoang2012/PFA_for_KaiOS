/**
 * settings.js: Settings sub-page renderer + persistence.
 *
 * Two groups of settings, both surfaced as overlays reachable from
 * the Options menu:
 *
 *   - MIDI Output   (sound engine, waveform)
  *   - Visual        (render mode, speed, Note Trail,
  *                    note labels, Info Card Options, Keyboard Range,
  *                    Background/Bar/Piano Color, Piano Size, Graphics 3D effects)
 *   - Developer     (On-screen verbose status, Verbose while analyzing,
 *                    Export log)
 *
 * Level-2 sub-pages (drilled from Visual rows):
 *   - Keyboard Range â†’ two sliders (Start / End note), live-applied.
 *   - Color pickers  â†’ preset swatch grid + R/G/B/A sliders, live-applied.
 *
 * Persistence: localStorage.midiPlayer.settings = { midi:{...}, visual:{...} }
 * (per plan: avoids polluting Store's runtime state shape with persist-specific
 * fields; Store holds only the live values.)
 *
 * Navigation model â€” same as Options menu (see controls.js):
 *   ArrowUp/Down â†’ move focus
 *   Enter / SoftLeft / ArrowRight â†’ cycle value forward
 *   ArrowLeft â†’ cycle value backward
 *   Enter / ArrowRight on 'sub'/'color' rows â†’ drill into the sub-page
 *   Backspace / SoftRight â†’ exit (sub-page back to group, group to menu)
 *
 * Live-apply: every change pushes to Store via setState and triggers the
 * CSS-variable / sprite-rebuild subsystems in main.js + keyboard.js.
 */
var Settings = (function () {
  'use strict';

  var keyMap = {
    verboseSfLoad: 'verbose_while_reading_soundfonts',
    verboseAnalyze: 'verbose_while_analyzing',
    verboseInit: 'verbose_while_init',
    osdLog: 'verbose_status',
    exportLog: 'export_log',
    memory: 'memory_stats',
      // Visual
      kbRange: 'keyboard_range',
      barColor: 'bar_color',
      pianoColorHex: 'piano_color',
      bgColor: 'background_color',
      focusColor: 'focus_color',
      loadBarColor: 'loading_color',
      noteLabels: 'show_note_labels',
      pianoSize: 'piano_size',
      view3d: 'view_3d',
      view3dFallOpacity: 'note_fall_fade',
      view3dKeyGlow: 'key_glow',
      view3dGlowColor: 'effects_colors',
      middleMarker: 'middle_c_marker',
      autoPlay: 'auto_play',
      showOsd: 'show_osd',
      pctBarVisible: 'show_loading_bar',
      pctAnalyze: 'show_pct_analyzing',
      pctMerge: 'show_pct_merging',
      loadAnimated: 'sliding_animation',
      infoCard: 'show_info_card',
      bgSettings: 'background_settings',
      bgImage: 'load_background',
      bgImageClear: 'clear_background',
      showDialog: 'show_dialog_screen',
      dialogTextColor: 'dialog_text_color',
      dialogBgColor: 'dialog_bg_color',
      pctColor: 'pct_text_color',
      osdLog: 'verbose_status',
      verboseAnalyze: 'verbose_while_analyzing',
      verboseInit: 'verbose_while_init',
      // Hub
      system: 'system_settings',
      visual: 'visual_settings',
      synth: 'synth_settings',
      // Synth
      audio: 'audio_output',
      engine: 'sound_engine',
      sfsettings: 'soundfont_settings',
      waveform: 'synth_waveform',
      skipSlowOpen: 'skip_slow_intro',
      // System & Dev
      memory: 'memory_stats',
      exportLog: 'export_log',
      storageTest: 'storage_test',
      loadMidi: 'load_midi_file',
      cancelAnalysis: 'cancel_analysis',
      clearMidi: 'clear_midi',
      themeSettings: 'theme_settings',
      languageSettings: 'language',
      autoLang: 'auto_change_language',
      fullscreen: 'full_screen',
      rotate: 'rotate_screen',
      volume: 'volume',
      importSettings: 'import_settings',
      exportSettings: 'export_settings',
      autoFullscreen: 'auto_fullscreen',
      autoRotate: 'auto_rotate',
      resetAll: 'reset_all_settings',
      about: 'about_this_app',
      developer: 'developer'
    };

  console.log('[Settings] module loaded');

  var STORAGE_KEY = 'midiPlayer.settings';

  var DEFAULTS = {
    midi: {
      engine:       'synth',   // 'synth' | 'soundbank'
      synthEngine:  'system',  // 'system' | 'preload' — preload plays a media alongside the MIDI
      mediaName:    '',        // display name of the preloaded media (no path)
      mediaSrc:     '',        // internal blob URL of the preloaded media
      mediaDelay:   0,         // seconds before the media starts, 0 = off
      waveform:     'square',  // 'sine' | 'square' | 'saw' | 'triangle'
      audio:        true,      // master audio on/off toggle
      skipSlowOpen: true,      // skip an absurdly slow opening tempo (< 30 BPM)
      sfBuffer:     1024,      // Soundfont planning buffer length (samples) â€” text input
      sfVoices:     32,        // max simultaneous Soundfont voices â€” text input
      sfNoFx:       false,     // Soundfont: bypass post FX chain (persisted; engine reads)
    },
    visual: {
      renderMode:   'auto',    // 'auto' | 'individual' | 'buffer'
      speed:        1.0,       // 0.1 .. 8.0 (slider)
      trail:        1.0,       // Note Trail, 0.1 .. 8.0 (moved from MIDI group)
      autoPlay:     false,     // start playback automatically after load
      showDialog:   true,      // show "Analyzing MIDIâ€¦" / "Now playing" pills
      showOsd:      true,      // show the info-bar action OSD (+1 sec / 1.1xâ€¦)
      pctAnalyze:   false,     // show the % readout during analysis (parse) â€” Loading Bar page
      pctMerge:     false,     // show the % readout during the merge stage â€” Loading Bar page
      pctBarVisible: true,     // show/hide the loading bar itself â€” Loading Bar page
      loadAnimated: true,      // sliding sweep (true) vs. gradual 0â†’100% fill (false) â€” Loading Bar page
      loadBarColor: '#0088FF', // RGBA color of the loading bar (default blue) â€” Loading Bar page
      pctColor:     '#FFFFFF', // RGBA color of the % readout text (default white) â€” Loading Bar page
      dialogTextColor: '#FFFFFF', // center pill text RGBA (default white) â€” Dialog page
      dialogBgColor:   '#000000', // center pill background RGBA (default black) â€” Dialog page
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
      view3dFallOpacity: 100,  // Note-fall fade in 3D mode, 0..100 (0 = no fade)
      view3dKeyGlow: true,     // 3D keyboard impact glow on/off
      view3dGlowColor: '#FFFFFF', // 3D keyboard glow RGBA color (default white)
      palette:      'random',  // active note color palette id
    },
    dev: {
        osdLog:         false,   // On-screen verbose status overlay
        verboseSfLoad:  false,
      verboseAnalyze: false,   // show [LOG] detail in analysis progress
      verboseInit:    false,   // show text log above % in launch/boot screen (default false/Off)
      verboseLoadLog: false,   // show text log in launch/soundfont loading screen (default false/Off)
    },
    sys: {
      autoFullscreen: false,   // enter fullscreen automatically on launch
      autoRotate:     false,   // rotate to landscape automatically on launch
      focusColor:     '#0066cc', // focus highlight RGBA color
      autoLang:       true,    // follow the system language (true) or a fixed one
      language:       '',      // chosen locale code (used only when autoLang is false)
    }
  };

  // Preset swatch palette for the level-2 color picker (grid order).
  var SWATCHES = [
    '#FFFFFF','#CCCCCC','#999999','#666666','#333333',
    '#000000','#FF4477','#FF0000','#FF8800','#FFDD00',
    '#FFFF00','#AAEE00','#00FF00','#00FFCC','#00FFFF',
    '#0088FF','#0000FF','#9900FF','#FF00FF','#FF88CC'
  ];

  /**
   * Static settings hierarchy: schema of every option row across all 4
   * top-level groups (Midi, Visual, Dev, System).
   */
  // Preload engine: the system synth rows are hidden and the media rows
  // (Load/Change Media, file name, Delay Start) appear instead.
  function _isPreload() { return _values.midi.synthEngine === 'preload'; }
  function _isIntegrated() { return _values.midi.synthEngine === 'integrated'; }

  var SCHEMA = {
    midi: [
      { key: 'audio',       l10nKey: 'audio_output',     label: 'Audio Output', type: 'bool' },
      { key: 'synthEngine', l10nKey: 'synth_engine',     label: 'Synth Engine', type: 'enum',
        choices: [['system','System'],['preload','Preload'],['integrated','Integrated']] },
      { key: 'integNote',   l10nKey: 'integrated_note',  label: 'Note',
        labelFn: function () { return ''; }, type: 'info',
        staticText: 'This synthesizer is not supported for black MIDI, and .note file',
        hidden: function () { return !_isIntegrated(); } },
      { key: 'engine',      l10nKey: 'sound_engine',     label: 'Sound Engine', type: 'enum',
        choices: [['synth','Oscillator'],['soundbank','SoundFont']],
        hidden: function () { return _isPreload() || _isIntegrated(); } },
      { key: 'sfsettings',  l10nKey: 'soundfont_settings', label: 'Soundfont Settings', type: 'sub', subkind: 'sfsettings',
        // Soundfont engine options — only meaningful while the engine is
        // Soundbank. Hidden when the engine is System or the preload media
        // mode is on (the group re-renders from applyChange on the row).
        hidden: function () { return _isPreload() || _isIntegrated() || _values.midi.engine !== 'soundbank'; } },
      { key: 'waveform',    l10nKey: 'synth_waveform',   label: 'Synth Waveform', type: 'enum',
        choices: [['sine','Sine'],['square','Square'],['saw','Saw'],['triangle','Triangle']],
        hidden: function () { return _isPreload() || _isIntegrated(); } },
      { key: 'skipSlowOpen', l10nKey: 'skip_slow_intro', label: 'Skip Slow Intro', type: 'bool',
        hidden: function () { return _isPreload(); } },
      // Preload media rows — only while Synth Engine = Preload.
      { key: 'mediaLoad',   l10nKey: 'load_media',       label: 'Load Media', type: 'action', labelFn: mediaLoadLabel,
        hidden: function () { return !_isPreload(); } },
      // Clear Media — only once a media file is loaded. Hidden again after a
      // Clear so only the Load Media row remains.
      { key: 'mediaClear',  l10nKey: 'clear_media',      label: 'Clear Media', type: 'action', noArrow: true,
        hidden: function () { return !_isPreload() || !_values.midi.mediaName; } },
      // File-name + Delay Start rows appear only once a media is loaded.
      { key: 'mediaName',   l10nKey: 'media_file',       label: 'Media File', type: 'info',
        hidden: function () { return !_isPreload() || !_values.midi.mediaName; } },
      { key: 'mediaDelay',  l10nKey: 'media_delay',      label: 'Media Delay', type: 'medtext',
        hidden: function () { return !_isPreload() || !_values.midi.mediaName; } },
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
      { key: 'osdLog',         l10nKey: 'verbose_status',           label: 'Verbose Status', type: 'bool' },
      { key: 'verboseAnalyze', l10nKey: 'verbose_while_analyzing',  label: 'Verbose while analyzing',  type: 'bool' },
      { key: 'verboseSfLoad', l10nKey: 'verbose_while_reading_soundfonts', label: 'Verbose while reading soundfonts', type: 'bool' },
        { key: 'verboseInit',    l10nKey: 'verbose_while_init',       label: 'Verbose while init',       type: 'bool' },
      { key: 'memory',         l10nKey: 'memory_stats',             label: 'Memory Stats',             type: 'action' },
      { key: 'exportLog',      l10nKey: 'export_log',               label: 'Export Log',               type: 'action' },
      { key: 'storageTest',    l10nKey: 'storage_test',             label: 'Storage Test',             type: 'action' },
    ],
    sys: [
      { key: 'loadMidi',       l10nKey: 'load_midi_file',    label: 'Load MIDI/Note File', type: 'action', labelFn: sysLoadLabel },
      { key: 'cancelAnalysis', l10nKey: 'cancel_analysis',   label: 'Cancel Analysis',     type: 'action', hidden: function () { return !_analysisBusy(); } },
      { key: 'clearMidi',      l10nKey: 'clear_midi',        label: 'Clear',               type: 'action' },
      { key: 'themeSettings',  l10nKey: 'theme_settings',    label: 'Theme',               type: 'sub', subkind: 'themeSettings' },
      { key: 'fullscreen',     l10nKey: 'full_screen',       label: 'Full Screen',         type: 'action' },
      { key: 'rotate',         l10nKey: 'rotate_screen',     label: 'Rotate Screen',       type: 'action' },
      { key: 'volume',         l10nKey: 'volume',            label: 'Volume',              type: 'action' },
      // Language picker — Auto change language On/Off plus a radio list of
      // all bundled locales. Auto follows the system locale; Off pins the
      // chosen language until Auto is switched back On.
      { key: 'languageSettings', l10nKey: 'language', label: 'Language', type: 'sub', subkind: 'languageSettings' },
      // Backup / restore the whole settings profile as a JSON .note file
      // in others/. Import validates the file (extension + content marker);
      // a picked .note that is really a MIDI export is refused with a dialog.
      { key: 'importSettings', l10nKey: 'import_settings',   label: 'Import Settings', type: 'action' },
      { key: 'exportSettings', l10nKey: 'export_settings',   label: 'Export Settings', type: 'action' },
      { key: 'autoFullscreen', l10nKey: 'auto_fullscreen',   label: 'Auto Full Screen',    type: 'bool' },
      { key: 'autoRotate',     l10nKey: 'auto_rotate',       label: 'Auto Rotate Screen',  type: 'bool' },
      { key: 'resetAll',       l10nKey: 'reset_all_settings', label: 'Reset All Settings',  type: 'action' },
      { key: 'about',          l10nKey: 'about_this_app',    label: 'About This App',      type: 'action' },
      { key: 'developer',      l10nKey: 'developer',         label: 'Developer',           type: 'sub', subkind: 'developer',
        hidden: function () {
          var en = false;
          try { en = !!(window.__devEnabled || (window.devEnabled && window.devEnabled())); } catch (e) {}
          return !en;
        } },
    ],
    hub: [
      { key: 'system',    l10nKey: 'system_settings',  label: 'System',    type: 'sub', subkind: 'system' },
      { key: 'visual',    l10nKey: 'visual_settings',  label: 'Visual',    type: 'sub', subkind: 'visual' },
      { key: 'synth',     l10nKey: 'synth_settings',   label: 'Synth',     type: 'sub', subkind: 'synth' },
    ]
  };

  // Hub â†’ real settings group mapping (Options â†’ Settings sub-menu).
  // subkind of a hub row selects which group its overlay shows. The
  // Developer row inside System opens as a SUBSETTINGS page (list-style),
  // so it intentionally has NO entry here.
  var HUB_GROUP_MAP = { synth: 'midi', visual: 'visual', system: 'sys' };

  /** Overlay header per settings group. */
  function groupHeader(g) {
    return g === 'hub'  ? L10n.t('settings', 'Settings')
         : g === 'midi' ? L10n.t('synth_settings', 'Synth Settings')
         : g === 'dev'  ? L10n.t('developer_settings', 'Developer Settings')
         : g === 'sys'  ? L10n.t('system_settings', 'System Settings')
         : L10n.t('visual_settings', 'Visual Settings');
  }

  function sysLoadLabel() {
    try {
      var st = Store.getState();
      var hasRealFile = !!st.fileName &&
        (typeof window.isDemoActive !== 'function' || !window.isDemoActive());
      return hasRealFile ? L10n.t('change_midi_file', 'Change MIDI/Note File') : L10n.t('load_midi_file', 'Load MIDI/Note File');
    } catch (e) { return L10n.t('load_midi_file', 'Load MIDI/Note File'); }
  }

  function sfLoadLabel() {
    try {
      if (typeof Soundbank !== 'undefined' && Soundbank.getBanks &&
          Soundbank.getBanks().length) return L10n.t('load_more_soundfont', 'Load more');
    } catch (e) {}
    return L10n.t('load_soundfont', 'Load Soundfont');
  }

  // Preload media row label — "Change Media" once a media file is loaded.
  function mediaLoadLabel() {
    try {
      var mn = _values.midi.mediaName || '';
      return mn ? L10n.t('change_media', 'Change Media') : L10n.t('load_media', 'Load Media');
    } catch (e) { return L10n.t('load_media', 'Load Media'); }
  }

  // â”€â”€ Local state â”€â”€
  var _values = clone(DEFAULTS);
  var _openGroup = null;     // 'hub' | 'midi' | 'visual' | 'dev' | null
  var _groupReturn = null;   // group to return to on Back (non-hub drill-in)
  var _groupReturnIdx = 0;   // focus row to restore when backing to it
  var _focusIdx = 0;
  var _onCloseCb = null;     // notification when overlay closes
  var _medRow = null;        // current preload Media Delay text-box row (if any)

  // Pipeline busy (MIDI / note analysis running) â€” drives the System
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
  // SoundFont move mode in the Synth group list (RSK enters, â–²â–¼ reorders,
  // OK/RSK leaves). Only meaningful while an sf-row holds focus.
  var _sfMove = false;
  var _sfDeleteTargets = null;

  /** Number of swatch cells per visual row (flex-wrap column stride). */
  var SWATCH_COLS = 5;

  // â”€â”€ Built-in palette definitions â”€â”€
  // Each palette is an object: { id, label, file, colors }.
  // `file` is the image filename under style/palettes/ (PNG).
  // `colors` is the number of distinct color strips in the PNG â€”
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

  // â”€â”€ Loaded palette color caches â”€â”€
  // Keyed by palette id â†’ array of hex strings extracted from the PNG.
  // Populated on demand (first open of the palette sub-page).
  var _paletteColors = {};

  // Path prefix for palette images (relative to index.html).
  var PALETTE_IMG_DIR = 'style/palettes/';

  /** Number of color cells to sample from each palette image. */
  var PALETTE_SAMPLE_N = 16;

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Persistence
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function load() {
    console.log('[Settings] load() invoked');
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    // Ensure the one-shot migration marker is always present so save()
    // persists it and the migration below never re-runs to clobber a value
    // the user later sets â€” even on a brand-new install (raw === null).
    _values.__upgraded = true;
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          _values = merge(DEFAULTS, parsed);
          // Preload media is SESSION-ONLY: a fresh "Load Media" row every
          // launch (the blob URL dies with the app anyway). Only the Media
          // Delay value persists across restarts.
          _values.midi.mediaName = '';
          _values.midi.mediaSrc = '';
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
          // Migration: "Show FPS" became part of Info Card Options â€”
          // carry the old toggle into infoFps when nothing newer exists.
          if (parsed.visual && parsed.visual.showFps != null &&
              parsed.visual.infoFps == null) {
            _values.visual.infoFps = parsed.visual.showFps;
          }
          // Migration: NPS / Note Count split â€” carry the old combined
          // infoNoteCount into the new infoNps / infoPassed switches.
          if (parsed.visual && parsed.visual.infoNoteCount != null) {
            if (parsed.visual.infoNps == null)
              _values.visual.infoNps = parsed.visual.infoNoteCount;
            if (parsed.visual.infoPassed == null)
              _values.visual.infoPassed = parsed.visual.infoNoteCount;
          }
          // Migration: Start Delay used to allow -1 (= Off); the slider
          // range is 0..10 with 0 meaning Off â€” normalize old values.
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
      synthEngine:   _values.midi.synthEngine,
      mediaName:     _values.midi.mediaName,
      mediaSrc:      _values.midi.mediaSrc,
      mediaDelay:    _values.midi.mediaDelay,
      audio:         _values.midi.audio,
      sfBuffer:      _values.midi.sfBuffer,
      sfVoices:      _values.midi.sfVoices,
      sfNoFx:        _values.midi.sfNoFx,
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
      view3dFallOpacity: _values.visual.view3dFallOpacity,
      view3dKeyGlow: _values.visual.view3dKeyGlow,
      view3dGlowColor: _values.visual.view3dGlowColor,
      palette:       _values.visual.palette,
      osdLog:        _values.dev.osdLog,
      verboseAnalyze: _values.dev.verboseAnalyze,
        verboseSfLoad:  _values.dev.verboseSfLoad,
      verboseInit:    _values.dev.verboseInit || _values.dev.verboseLoadLog || false,
      verboseLoadLog: _values.dev.verboseInit || _values.dev.verboseLoadLog || false,
      autoFullscreen: _values.sys.autoFullscreen,
      autoRotate:     _values.sys.autoRotate,
      autoLang:       _values.sys.autoLang !== false,
      language:       _values.sys.language || '',
      focusColor:     _values.sys.focusColor || '#0066cc',
    });
    applyTheme(_values.visual.theme);
    applyFocusColor(_values.sys.focusColor || '#0066cc');
    // Re-assert the language preference (Auto = follow system; Off = pin the
    // saved code). Keeps the chosen language across resets and imports too.
    applyLanguagePreference();
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
    if (typeof window !== 'undefined' && window.Soundbank && window.Soundbank.unload) {
      try { window.Soundbank.unload(); } catch (e) {}
    }
    var overlay = document.getElementById('settings-overlay');
    if (overlay && _openGroup && !overlay.classList.contains('hidden')) {
      rebuildRows(overlay, _openGroup);
    }
    return _values;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Overlay open/close
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    _groupReturn = null;   // fresh open â€” no pending group-nav return
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

    // Instant show â€” visibility toggle only, no slide animation.
    overlay.classList.remove('hidden');

    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
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

  // â”€â”€ Settings-hub navigation â”€â”€
  // Options â†’ Settings is a hub listing Synth/Visual/Developer. Selecting
  // one swaps the overlay to that group's rows IN PLACE (same overlay,
  // rebuilt). Back then returns to the hub (same overlay, rebuilt) before
  // closing all the way back to the Options menu.

  function switchToGroup(group) {
    _hubReturn = true;
    // The hub index is only meaningful when leaving the hub itself; a
    // nested System â†’ Developer switch must NOT clobber it (Back from
    // Developer goes System, Back from System goes to this saved hub row).
    if (_openGroup === 'hub') _hubFocusIdx = _focusIdx;
    // When leaving a non-hub group for another group (e.g. System â†’
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
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
    if (rows.length) focusRow(rows, 0);
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  // Back out of a drilled group: return to the recorded non-hub group
  // (Developer opened inside System â†’ System) or to the hub.
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
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
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
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
    if (rows.length) focusRow(rows, _focusIdx);
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  function openGroup() { return _openGroup; }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Level-2 sub-pages â€” Keyboard Range (2 sliders) and Color pickers
  // (swatch grid + R/G/B/A sliders). Both apply live to the Store and
  // persist through the same save() path as regular rows.
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Default value of a color key; Background defaults to theme (null). */
  function colorDefault(key) {
    if (key === 'barColor')      return DEFAULTS.visual.barColor;
    if (key === 'pianoColorHex') return DEFAULTS.visual.pianoColorHex;
    if (key === 'loadBarColor')  return DEFAULTS.visual.loadBarColor;
    if (key === 'focusColor')    return DEFAULTS.sys.focusColor;
    if (key === 'pctColor')      return DEFAULTS.visual.pctColor;
    if (key === 'dialogTextColor') return DEFAULTS.visual.dialogTextColor;
    if (key === 'dialogBgColor')   return DEFAULTS.visual.dialogBgColor;
    if (key === 'view3dGlowColor') return DEFAULTS.visual.view3dGlowColor;
    return null;
  }

  /** Resolve the effective CSS color for a key (null â†’ --theme-bg). */
  function colorCurrentValue(key) {
    var v = (key === 'focusColor') ? (_values.sys.focusColor || _values.visual.focusColor) : _values.visual[key];
    if (v) return v;
    if (key === 'focusColor') return '#0066cc';
    try {
      return getComputedStyle(document.documentElement)
        .getPropertyValue('--theme-bg').trim() || '#0a0a0a';
    } catch (e) {
      return '#0a0a0a';
    }
  }

  /** '#rgb'/'#rrggbb' â†’ {r,g,b,a:100}. */
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

  /** {r,g,b,a%} â†’ '#rrggbb' (opaque) or 'rgba(...)' string. */
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
    if (header) header.textContent = label || (def ? L10n.t(def.l10nKey || def.key, def.label) : getDrillLabel(key));

    if (kind === 'range') {
      // Keyboard range â€” Key Count preset enum row + Start/End sliders
      // (the sliders render only in 'custom' mode).
      buildRangePage(list);
    } else if (kind === 'bools') {
      // Boolean list page (Info Card Options) â€” built by buildBoolPage
      // so the master toggle can collapse/expand it in place.
      buildBoolPage(list);
    } else if (kind === 'palettes') {
      // Note Color Settings â€” palette selection page.
      buildPalettePage(list);
    } else if (kind === 'piano') {
      // Piano Settings â€” grouped Show Note Labels / Keyboard Range /
      // Bar Color / Piano Color / Piano Size page.
      buildPianoPage(list);
    } else if (kind === 'general') {
      // General settings â€” Speed / Note Trail / Start Delay / Auto Play /
      // Show Dialog / Show OSD / Background.
      buildGeneralPage(list);
    } else if (kind === 'loadingBar') {
      // Loading Bar settings â€” bar visibility / % readouts / color / animation.
      buildLoadingBarPage(list);
    } else if (kind === 'dialog') {
      // Dialog settings â€” the center "Analyzingâ€¦/Now playing" pill.
      buildDialogPage(list);
    } else if (kind === 'developer') {
      // Developer Settings — list-style page (System Settings → Developer):
      // Verbose toggles + one-shot dev actions.
      if (header) header.textContent = L10n.t('developer_settings', 'Developer Settings');
      buildDeveloperPage(list);
    } else if (kind === 'themeSettings') {
      // Theme Settings — Focus Color + Loading Color RGBA pickers.
      if (header) header.textContent = L10n.t('theme_settings', 'Theme');
      buildThemePage(list);
    } else if (kind === 'languageSettings') {
      // Language Settings — Auto change language toggle + a radio list of
      // every bundled locale (hidden while Auto is On).
      if (header) header.textContent = L10n.t('language', 'Language');
      buildLanguagePage(list);
    } else if (kind === 'background') {
      // Background Settings â€” Background color + Load/Clear image actions.
      buildBackgroundSubPage(list);
    } else if (kind === 'graphics') {
      // Graphics settings â€” Render Mode (4 radio) + 3D View (4 radio).
      buildGraphicsPage(list);
    } else if (kind === 'soundfonts') {
      // SoundFont loader â€” scans both partitions (internal + SD) and lets
      // the user tick square checkboxes to load one or several banks.
      if (header) header.textContent = L10n.t('load_soundfont', 'Load SoundFont');
      buildSoundFontPage(list);
    } else if (kind === 'sfsettings') {
      // Soundfont Settings â€” Buffer length + Voices (numeric text boxes,
      // KaiUI kai-text-input style) and the Disable Soundfont FX toggle,
      // grouped by separators.
      if (header) header.textContent = L10n.t('soundfont_settings', 'Soundfont Settings');
      buildSfSettingsPage(list);
    } else {
      // Working color from persisted value (or resolved theme color).
      var cur = _values.visual[key];
      _sub.rgb = hexToRgbObj(cur || colorCurrentValue(key));

      // Swatch grid â€” first cell restores the default/theme color.
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

      // R/G/B/A sliders â€” live-mix on top of any selected swatch.
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
      plbl.textContent = L10n.t('color_preview', 'Preview');
      prow.appendChild(plbl);var pchip = document.createElement('span');
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

  /** Keyboard Range Key Count presets â€” 88 keys (A0..C8), 128 (full MIDI), custom. */
  var KB_SIZE_CHOICES = [['88', '88 Keys'], ['128', '128 Keys'], ['custom', 'Custom'], ['dynamic', 'Dynamic']];

  /** Human label for a Key Count preset id. */
  function kbSizeLabel(size) {
    for (var i = 0; i < KB_SIZE_CHOICES.length; i++) {
      if (KB_SIZE_CHOICES[i][0] === size) return L10n.t('opt_' + KB_SIZE_CHOICES[i][0], KB_SIZE_CHOICES[i][1]);
    }
    return L10n.t('opt_custom', 'Custom');
  }

  /**
   * Build the Keyboard Range page: a Key Count preset enum row
   * (88 Keys / 128 Keys / Custom â€” Left/Right cycles) plus, ONLY in
   * Custom mode, the Start/End note sliders.
   */
  function buildRangePage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    // Key Count preset row â€” cycling it rebuilds the page so the sliders
    // appear (custom) or vanish (88/128) right away.
    var sizeRow = document.createElement('div');
    sizeRow.className = 'setting-row';
    sizeRow.setAttribute('tabindex', '-1');
    sizeRow.setAttribute('data-type', 'enum');
    sizeRow.setAttribute('data-key', 'kbSize');
    var sLbl = document.createElement('span');
    sLbl.className = 'setting-row-label';
    sLbl.textContent = L10n.t('key_count', 'Key Count');
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
    _sub.ui.start = buildSubSliderRow(listEl, L10n.t('opt_kbStart', 'Start'), 0, 127, 1, _values.visual.kbStart, noteFmt);
    _sub.ui.end   = buildSubSliderRow(listEl, L10n.t('opt_kbEnd', 'End'),   0, 127, 1, _values.visual.kbEnd,   noteFmt);
    _sub.items.push({ type: 'slider', part: 'start' });
    _sub.items.push({ type: 'slider', part: 'end' });
  }

  /**
   * Apply a Keyboard Range preset: '88' â†’ A0..C8 (21..108), '128' â†’ full
   * MIDI 0..127, 'custom' â†’ keep kbStart/kbEnd and reveal the Start/End
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
    // (hotkey-toggled) the settings overlays are hidden â€” stay out of the way.
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
   * so the user lands back in Info Card Options â€” not the Visual group.
   */
  function openInfoColor(key) {
    openSub('color', key);
    if (_sub) _sub.returnTo = 'bools';
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /** Header labels for drill-in rows whose keys are not in SCHEMA. */
  function getDrillLabel(key) {
    var map = {
      kbRange:          'keyboard_range',
      barColor:         'bar_color',
      pianoColorHex:    'piano_color',
      bgColor:          'background_color',
      focusColor:       'focus_color',
      loadBarColor:     'loading_color',
      infoBorderColor:  'infoBorderColor',
      infoBgColor:      'infoBgColor',
      infoTextColor:    'infoTextColor',
      dialogTextColor:  'dialog_text_color',
      dialogBgColor:    'dialog_bg_color',
      view3dGlowColor:  'effects_colors',
      pctColor:         'pct_text_color'
    };
    var fallbacks = {
      kbRange:          'Keyboard Range',
      barColor:         'Bar Color',
      pianoColorHex:    'Piano Color',
      bgColor:          'Background Color',
      focusColor:       'Focus Color',
      loadBarColor:     'Loading Color',
      infoBorderColor:  'Info Card Border',
      infoBgColor:      'Background',
      infoTextColor:    'Info Card Text',
      dialogTextColor:  'Text Color',
      dialogBgColor:    'Background Color',
      view3dGlowColor:  'Effects Colors',
      pctColor:         'Percentage Color'
    };
    var l10nKey = map[key] || key;
    return L10n.t(l10nKey, fallbacks[key] || key);
  }

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
      // Visual â†’ General â†’ Background Settings: dedicated image/color page.
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
        : (_sub.kind === 'themeSettings') ? 'themeSettings'
        : 'piano';
      openSub(item.type === 'sub' ? 'range' : 'color', item.key, getDrillLabel(item.key));
      if (_sub) _sub.returnTo = retKind;
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return true;
    }
    if (item.type === 'sfaction' && item.part === 'loadSf') {
      // Drill into the SoundFont scanner from Soundfont Settings.
      openSub('soundfonts', 'soundfont');
      if (_sub) _sub.returnTo = 'sfsettings';
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
    // (a "color" row), Back should land back on that list â€” not on
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

    // A color page opened from INSIDE Loading Bar / Dialog / Theme settings returns
    // to that list too (Back lands back in the sub-page, not the parent group).
    var wasFromLoadBar = _subReturn === 'loadingBar';
    var wasFromDialog  = _subReturn === 'dialog';
    var wasFromTheme   = _subReturn === 'themeSettings';
    if (wasFromLoadBar || wasFromDialog || wasFromTheme) {
      var listLb = document.getElementById('subsettings-list');
      if (listLb) {
        while (listLb.firstChild) listLb.removeChild(listLb.firstChild);
        if (wasFromLoadBar) {
          _sub = { kind: 'loadingBar', key: 'loadingBar', items: [], focusIdx: 0, ui: {} };
          buildLoadingBarPage(listLb);
        } else if (wasFromDialog) {
          _sub = { kind: 'dialog', key: 'dialog', items: [], focusIdx: 0, ui: {} };
          buildDialogPage(listLb);
        } else {
          _sub = { kind: 'themeSettings', key: 'themeSettings', items: [], focusIdx: 0, ui: {} };
          buildThemePage(listLb);
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

    // A soundfonts page opened from INSIDE Soundfont Settings returns to
    // that list too (Back lands in Soundfont Settings, not the Synth group).
    var wasFromSfSettings = _subReturn === 'sfsettings';
    if (wasFromSfSettings) {
      var listSf = document.getElementById('subsettings-list');
      if (listSf) {
        while (listSf.firstChild) listSf.removeChild(listSf.firstChild);
        _sub = { kind: 'sfsettings', key: 'sfSettings', items: [], focusIdx: 0, ui: {} };
        _sub.ui.boolRows = {};
        _sub.ui.text = null;
        buildSfSettingsPage(listSf);
        var ovSf = document.getElementById('subsettings-overlay');
        if (ovSf) {
          ovSf.classList.remove('hidden');
          var header = ovSf.querySelector('header');
          if (header) header.textContent = L10n.t('soundfont_settings', 'Soundfont Settings');
        }
        if (returnFocusKey) {
          for (var sfi = 0; sfi < _sub.items.length; sfi++) {
            if (_sub.items[sfi].part === returnFocusKey) { _sub.focusIdx = sfi; break; }
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
        var rows = parent.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
        if (rows.length) {
          if (_focusIdx >= rows.length) _focusIdx = rows.length - 1;
          focusRow(rows, _focusIdx);
        }
      }
      // The refocused row may be a drill-in row â€” refresh the SELECT
      // softkey label NOW instead of waiting for the next key press.
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    }

  /** Highlight the focused sub-page item (+ scroll into view). */
  function paintSubFocus() {
    if (!_sub) return;
    var overlay = document.getElementById('subsettings-overlay');
    if (!overlay) return;

    var listEl = document.getElementById('subsettings-list');
    if (listEl) {
      if (_sfMove) listEl.classList.add('sf-move-mode');
      else listEl.classList.remove('sf-move-mode');
    }

    var cells = overlay.querySelectorAll('.swatch');
    for (var i = 0; i < cells.length; i++) cells[i].classList.remove('focused');

    var rows = overlay.querySelectorAll('.setting-row-slider, .setting-row, .sf-row, .kai-text-input');
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
    } else if (item.type === 'sfcheck') {
      // SoundFont scan checkbox row â€” focus highlights the square.
      var s = _sub.ui.sfRowEls && _sub.ui.sfRowEls[item.path];
      if (s && s.row) {
        s.row.classList.add('focused');
        try { s.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { s.row.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'sfaction' || item.type === 'sfrow') {
      // Soundfont Settings drill-in or loaded sfrow action row â€” highlight directly from item.row.
      if (item.row) {
        item.row.classList.add('focused');
        try { item.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { item.row.scrollIntoView(false); } catch (e2) {} }
      }
    } else if (item.type === 'sftext') {
      // Soundfont Settings numeric text box â€” highlight + open the native
      // keyboard so digits can be typed straight away.
      if (item.row) {
        item.row.classList.add('focused');
        try { item.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { item.row.scrollIntoView(false); } catch (e2) {} }
      }
      if (item.input) {
        _sub.ui.text = { input: item.input };
        try { item.input.focus(); } catch (e) {}
      }
    } else if (item.type === 'gentext' || item.type === 'gfxtext') {
      // Numeric text boxes — same focus/native-keyboard behavior as sftext.
      if (item.row) {
        item.row.classList.add('focused');
        try { item.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { item.row.scrollIntoView(false); } catch (e2) {} }
      }
      if (item.input) {
        _sub.ui.text = { input: item.input };
        try { item.input.focus(); } catch (e) {}
      }
    } else if (item.type === 'swatch') {
      // cells[] includes the DEF cell at index 0 â†’ swatch idx i lives at
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
      // Radio row (Graphics page â€” renderMode / view3d group).
      var rArr = (_sub.ui.radioGroups && _sub.ui.radioGroups[item.key])
        || ((item.key === 'renderMode')
              ? (_sub.ui.renderModeRows || [])
              : (_sub.ui.view3dRows || []));
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

  /** Dynamically apply custom focus highlight color to CSS variable. */
  function applyFocusColor(color) {
    var c = color || (_values.sys && _values.sys.focusColor) || '#0066cc';
    try {
      document.documentElement.style.setProperty('--color-focus', c);
    } catch (e) {}
  }
  window.applyFocusColor = applyFocusColor;

  /** Live-apply the working color to Store + persistence. */
  function applyColorLive() {
    if (!_sub || _sub.kind !== 'color') return;
    var css = rgbToCss(_sub.rgb);
    if (_openGroup === 'sys' || _sub.key === 'focusColor') {
      if (!_values.sys) _values.sys = {};
      _values.sys[_sub.key] = css;
    }
    _values.visual[_sub.key] = css;
    Store.setState(_mapToStore(_openGroup, _sub.key, css));
    if (_sub.key === 'focusColor') {
      applyFocusColor(css);
    }
    if (_sub.key === 'loadBarColor' || _sub.key === 'pctBarVisible' || _sub.key === 'loadAnimated' || _sub.key === 'pctColor') {
      if (typeof window.applyParseBarStyle === 'function') {
        try { window.applyParseBarStyle(); } catch (e) {}
      }
    }
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
        // Speed / Note Trail / Start Delay â€” walk the numeric value
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

    if (item.type === 'sftext') {
      // Soundfont Settings text box â€” Enter commits the typed number.
      sfCommitText(item);
      return;
    }
    if (item.type === 'gentext') {
      // General Settings text box — Enter commits the typed number.
      genCommitText(item);
      return;
    }
    if (item.type === 'gfxtext') {
      // Graphics Settings text box — Enter commits the typed number.
      gfxCommitText(item);
      return;
    }
    if (item.type === 'sfrow') {
      if (_sfMove) {
        _sfMove = false;
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      } else {
        toggleSfRow(item.id);
      }
      return;
    }
    if (item.type === 'sfaction' && item.part === 'loadSf') {
      // Load Soundfont action inside Soundfont Settings â€” drill into the
      // SoundFont scanner page; Back returns here (sfsettings).
      openSub('soundfonts', 'soundfont');
      if (_sub) _sub.returnTo = 'sfsettings';
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return;
    }
    if (item.type === 'bool') {
      // Booleans are Left/Right only â€” Enter never toggles them.
      return;
    }
    if (item.type === 'action') {
      // One-shot actions (General â†’ Full Screen / Rotate Screen).
      if (item.row && (item.part === 'memory' || item.part === 'exportLog' ||
                       item.part === 'storageTest')) {
        // Developer Settings action rows â€” reuse the group-page dispatcher.
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
      // Regenerate all 16 channel colours â€” mirrors the hotkey-4 action.
      try {
        if (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked()) {
          if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_locked', 'Locked until a file loads'));
          return;
        }
      } catch (e) {}
      try {
        if (typeof Notes !== 'undefined' && Notes.randomizePalette) {
          Notes.randomizePalette();
          if (typeof HUD !== 'undefined' && HUD.showOsd) HUD.showOsd(L10n.t('osd_colors_randomised', 'Track colors randomised'), 2000);
        }
      } catch (e2) { if (typeof console !== 'undefined') console.error('[Settings] randomColors failed', e2); }
      return;
    }
    if (item.type === 'palette') {
      // Select this palette â€” persist, update radio highlight, and apply
      // its colors to the live channel palette.
      _values.visual.palette = item.part;
      Store.setState({ palette: item.part });
      save();
      _highlightPalette();
      _applyStoredPalette(item.part);
      if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_palette', 'Palette: ') + _paletteLabel(item.part));
      return;
    }
    if (item.type === 'radio' && item.key === 'language') {
      // Language row — pin the chosen locale (radio, exactly one selected).
      selectLanguage(item.value);
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
      if (_sub.kind === 'graphics' && rKey === 'view3d') {
        // Changing the 3D mode can add or remove the effects separator and
        // its controls. Rebuild this page so the list always matches it.
        var list = document.getElementById('subsettings-list');
        if (list) {
          var keepIdx = _sub.focusIdx;
          while (list.firstChild) list.removeChild(list.firstChild);
          buildGraphicsPage(list);
          _sub.focusIdx = Math.max(0, Math.min(keepIdx, _sub.items.length - 1));
          paintSubFocus();
          if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        }
      }
      if (typeof window.showToast === 'function') {
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
      // Restore the factory default (Background â†’ Auto/theme).
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
    // Leaving a Soundfont text box commits its value (and blurs it) so
    // the keyboard closes and nothing typed is dropped on the floor.
    var cur = _sub.items[_sub.focusIdx];
    if (cur && cur.type === 'sftext') sfCommitText(cur);
    if (cur && cur.type === 'gentext') genCommitText(cur);
    if (cur && cur.type === 'gfxtext') gfxCommitText(cur);
    var n = _sub.items.length;
    if (!n) return;
    _sub.focusIdx = ((idx % n) + n) % n;
    paintSubFocus();
    // Focus moved â€” refresh the softkey label (SELECT on drill-in rows,
    // blank on bool/enum/slider rows so the bar mirrors the focused row).
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /** Move sub-page focus by Â±step with WRAP-AROUND (bottom â†” top). */
  function moveSubFocus(step) {
    if (!_sub) return;
    setSubFocus(_sub.focusIdx + step);
  }

  /**
   * Vertical navigation for the COLOR page.
   *   Grid (DEF + swatches): Up/Down stride by column (5 cells).
   *   Top row cols 1-4 â†‘  â†’ bottom cell of the SAME column.
   *   DEF â†‘               â†’ A slider (wrap to the very bottom).
   *   ANY grid cell at the bottom edge â†“ â†’ R (first slider).
   *   Sliders stack linearly: A â†‘ â†’ B â†’ G â†’ R; R â†‘ â†’ S24
   *   (bottom of DEF's column). A â†“ â†’ DEF (wrap to the very top).
   * (dir: -1 = up, +1 = down)
   */
  function moveColorVertical(dir) {
    var gLast = SWATCHES.length;        // 25 â€” last grid cell (S24)
    var firstSlider = gLast + 1;        // 26 â€” R
    var last = _sub.items.length - 1;   // 29 â€” A
    var i = _sub.focusIdx;
    var t;
    if (dir > 0) { // Down
      if (i <= gLast) {
        t = i + SWATCH_COLS;
        setSubFocus(t <= gLast ? t : firstSlider); // grid bottom edge â†’ R
      } else {
        setSubFocus(i === last ? 0 : i + 1);       // A â†’ DEF (wrap)
      }
    } else {       // Up
      if (i === 0) {
        setSubFocus(last);                          // DEF â†’ A (bottom)
      } else if (i <= gLast) {
        t = i - SWATCH_COLS;
        setSubFocus(t >= 0 ? t : i + 20);           // top row â†’ same column
      } else {
        t = i - 1;
        if (t < firstSlider) t = gLast;             // R â†‘ â†’ S24 (DEF column)
        setSubFocus(t);
      }
    }
  }

  /**
   * (Re)build the Info Card Settings list. The MASTER "Show Info Card"
   * row always sits first. When it is Off, the stat/behaviour rows are
   * REMOVED entirely â€” focus locks onto the master row alone; flipping
   * it back On restores the full list. Rows are split by separators:
   *   â€” Stats â€”  NPS â€¦ BPM           â€” Style â€”  Floating â€¦ Info Card Text
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
      st.textContent = L10n.t('sep_' + text.toLowerCase().replace(/ /g, '_'), text);
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
   *   'bool'  â†’ On/Off label (Left/Right toggles, never Enter)
   *   'enum'  â†’ cycled value label (choices = [[value,label],..])
   *   'sub'   â†’ drill-in row showing getVal() (e.g. Keyboard Range window)
   *   'color' â†’ drill-in row with a color chip + getVal() hex label
   * Rows register in _sub.ui.boolRows so value labels + focus paint work.
   */
  function addSubRow(listEl, kind, key, label, choices, getVal) {
    var r = document.createElement('div');
    r.className = 'setting-row';
    r.setAttribute('tabindex', '-1');
    r.setAttribute('data-type', kind);
    r.setAttribute('data-key', key);

    // Map internal JS keys to their standard localization keys if they exist
        var l10nKey = keyMap[key] || key;

    var lbl = document.createElement('span');
    lbl.className = 'setting-row-label';
    lbl.textContent = L10n.t(l10nKey, label);
    r.appendChild(lbl);

    var valEl = null;
    if (kind === 'bool') {
      valEl = document.createElement('span');
      valEl.className = 'setting-row-value';
      var st = Store.getState();
      var val = st[key] !== undefined ? st[key] : _values.visual[key];
      valEl.textContent = getVal ? (getVal() ? L10n.t('on', 'On') : L10n.t('off', 'Off')) : (val ? L10n.t('on', 'On') : L10n.t('off', 'Off'));
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

  /** One-shot action row (Enter fires, Right moves focus) â€” same look as
   *  the addSubRow rows so paintSubFocus highlights it the same way. */
  function addActionRow(listEl, part, label, getVal) {
    var r = document.createElement('div');
    r.className = 'setting-row has-sub';
    r.setAttribute('tabindex', '-1');
    r.setAttribute('data-type', 'action');
    r.setAttribute('data-key', part);

    var l = document.createElement('span');
    l.className = 'setting-row-label';
    var l10nKey = keyMap[part] || part;
    l.textContent = L10n.t(l10nKey, label);
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
      if (choices[i][0] === val) return L10n.t('opt_' + choices[i][0], choices[i][1]);
    }
    return (choices[0] && choices[0][1]) ? L10n.t('opt_' + choices[0][0], choices[0][1]) : '';
  }

  /**
   * Build the Piano Settings page.
   * Groups Show Note Labels, Keyboard Range, Piano Size, Bar Color and
   * Piano Color into separators (like the Note Color Settings page):
   *   â€” Notes â€”      Show Note Labels (bool)
   *   â€” Keyboard â€”   Keyboard Range (drill-in range), Piano Size (enum)
   *   â€” Colors â€”     Bar Color (drill-in), Piano Color (drill-in)
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
      st.textContent = L10n.t('sep_' + text.toLowerCase().replace(/ /g, '_'), text);
      s.appendChild(st);
      listEl.appendChild(s);
    }

    // Notes section
    sepsis('Notes');
    addSubRow(listEl, 'bool', 'noteLabels', 'Show Note Labels');

    // Keyboard section
    sepsis('Keyboard');
    addSubRow(listEl, 'sub', 'kbRange', 'Keyboard Range', null, function () {
      // Outside summary follows the Key Count mode: preset labels for
      // every known mode, raw numbers only as a legacy fallback.
      var sz = _values.visual.kbSize;
      if (sz === 'dynamic') return kbSizeLabel('dynamic');
      if (sz === '128') return kbSizeLabel('128');
      if (sz === '88') return kbSizeLabel('88');
      if (sz === 'custom') return kbSizeLabel('custom');
      return _values.visual.kbStart + ' \u00B7 ' + _values.visual.kbEnd;
    });
    addSubRow(listEl, 'enum', 'pianoSize', 'Piano Size',
      [['big', 'Big'], ['small', 'Small'], ['none', 'No Piano']]);
    addSubRow(listEl, 'bool', 'middleMarker', 'Middle C Marker');

    // Colors section
    sepsis('Colors');
    addSubRow(listEl, 'color', 'barColor', 'Bar Color', null, function () {
      return _values.visual.barColor || L10n.t('color_theme', 'Theme');
    });
    addSubRow(listEl, 'color', 'pianoColorHex', 'Piano Color', null, function () {
      return _values.visual.pianoColorHex || L10n.t('color_theme', 'Theme');
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
      trail:      { min: 0.1, max: 8.0, step: 0.1, fmt: function (v) { return v.toFixed(1); } }
    };
    var sliderKeys = ['speed', 'trail'];
    for (var si = 0; si < sliderKeys.length; si++) {
      var sk = sliderKeys[si];
      var sd = sliderDefs[sk];
      var sdLabel = L10n.t(sk === 'speed' ? 'speed' : 'opt_' + sk, (sk === 'speed') ? 'Speed' : 'Note Trail');
      _sub.ui[sk] = buildSubSliderRow(listEl, sdLabel, sd.min, sd.max, sd.step, _values.visual[sk], sd.fmt);
      _sub.items.push({ type: 'slider', part: sk });
    }

    // Start Delay — text box (seconds, 0 = Off)
    addGeneralTextRow(listEl, 'startDelay', 'Start Delay',
      'Delay before playback in seconds (0 = Off)', 0, 9999999);

    addSubRow(listEl, 'bool', 'autoPlay', 'Auto Play');
    addSubRow(listEl, 'bool', 'showOsd', 'Show OSD');

    // Background Settings — drills into its own page (color + image actions).
    addSubRow(listEl, 'sub', 'bgSettings', 'Background Settings', null, function () {
      return _values.visual.bgImageName || '';
    });
  }

  /** One numeric text box row for the General settings page (kai-text-input layout). */
  function addGeneralTextRow(listEl, key, label, hint, min, max) {
    var w = document.createElement('div');
    w.className = 'kai-text-input';
    w.setAttribute('tabindex', '-1');
    w.setAttribute('data-type', 'gentext');
    w.setAttribute('data-key', key);

    var lab = document.createElement('label');
    lab.className = 'kai-text-input-label';
    var l10nKey = key; lab.textContent = L10n.t(l10nKey, label);
    w.appendChild(lab);

    var input = document.createElement('input');
    input.className = 'kai-text-input-input';
    input.type = 'tel';
    var curVal = _values.visual[key];
    var initVal = (curVal != null && !isNaN(Number(curVal))) ? Number(curVal) : 0;
    input.value = String(initVal);
    w.appendChild(input);

    var hintEl = document.createElement('div');
    hintEl.className = 'kai-text-input-hint';
    var hintKey = key + '_hint'; hintEl.textContent = L10n.t(hintKey, hint);
    w.appendChild(hintEl);

    listEl.appendChild(w);
    var item = { type: 'gentext', part: key, row: w, input: input, min: min, max: max, lastValidValue: initVal };
    _sub.items.push(item);

    input.addEventListener('input', function () {
      // Track last valid number while typing — decimals with '.' or ','.
      var numStr = input.value.trim().replace(/,/g, '.').replace(/[^\d.]/g, '');
      if (numStr.length > 0) {
        var num = parseFloat(numStr);
        if (isFinite(num) && num >= 0) {
          item.lastValidValue = num;
        }
      }
    });

    _sub.ui[key + 'Text'] = { row: w, input: input };
    return { row: w, input: input };
  }

  /** Commit a General-page text box: parse, clamp, persist. Preserves last valid number if input is cleared. */
  function genCommitText(item) {
    if (!item || item.type !== 'gentext') return;
    if (item.input && document.activeElement === item.input) {
      try { item.input.blur(); } catch (e) {}
    }
    var raw = item.input ? item.input.value : '';
    // Decimals with either '.' or ',' as the separator (e.g. "1.5" / "1,5").
    var numStr = String(raw).trim().replace(/,/g, '.').replace(/[^\d.]/g, '');
    var n;
    if (numStr.length === 0) {
      n = (item.lastValidValue != null) ? item.lastValidValue : (_values.visual[item.part] != null ? _values.visual[item.part] : 0);
    } else {
      n = parseFloat(numStr);
      if (!isFinite(n)) {
        n = (item.lastValidValue != null) ? item.lastValidValue : 0;
      }
    }
    n = Math.max(item.min, Math.min(item.max, n));
    item.lastValidValue = n;
    if (item.input) item.input.value = String(n);
    _values.visual[item.part] = n;
    Store.setState(_mapToStore('visual', item.part, n));
    save();
    if (typeof window.showToast === 'function') {
      var display = (n > 0) ? n + ' sec' : 'Off';
      window.showToast(L10n.t('toast_start_delay', 'Start Delay: ') + display);
    }
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
      return _values.visual.loadBarColor || L10n.t('color_blue', 'Blue');
    });
    addSubRow(listEl, 'color', 'pctColor', '% Text Color', null, function () {
      return _values.visual.pctColor || L10n.t('color_white', 'White');
    });
    addSubRow(listEl, 'bool', 'loadAnimated', 'Sliding Animation');
  }

  /**
   * Build the Dialog settings page: the center pill ("Analyzingâ€¦" /
   * "Now playing: â€¦") master toggle plus its text + background colors.
   */
  function buildDialogPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    addSubRow(listEl, 'bool', 'showDialog', 'Show Dialog');
    addSubRow(listEl, 'color', 'dialogTextColor', 'Text Color', null, function () {
      return _values.visual.dialogTextColor || L10n.t('color_white', 'White');
    });
    addSubRow(listEl, 'color', 'dialogBgColor', 'Background Color', null, function () {
      return _values.visual.dialogBgColor || L10n.t('color_black', 'Black');
    });
  }

  /**
   * Build the Developer Settings page (System Settings â†’ Developer):
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
    addSubRow(listEl, 'bool', 'verboseSfLoad', 'Verbose while reading soundfonts', null, function () {
      return _values.dev.verboseSfLoad;
    });
    addSubRow(listEl, 'bool', 'verboseInit', 'Verbose while init', null, function () {
      return _values.dev.verboseInit || _values.dev.verboseLoadLog;
    });
    addActionRow(listEl, 'memory', 'Memory Stats');
    addActionRow(listEl, 'exportLog', 'Export Log');
    addActionRow(listEl, 'storageTest', 'Storage Test');
  }

  /**
   * Build the Theme Settings page (System Settings -> Theme):
   * Focus Color and Loading Color RGBA color pickers.
   */
  function buildThemePage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;

    addSubRow(listEl, 'color', 'focusColor', 'Focus Color', null, function () {
      return _values.sys.focusColor || _values.visual.focusColor || '#0066cc';
    });
    addSubRow(listEl, 'color', 'loadBarColor', 'Loading Color', null, function () {
      return _values.visual.loadBarColor || '#0088FF';
    });
  }

  // -- Language Settings --------------------------------------------------
  // All 68 bundled locales, each shown in its own language. Codes match the
  // locales-obj/*.json files and the manifest availableLanguages list exactly.
  var LANGS = [
    ['af-ZA', 'Afrikaans'],
    ['ar-SA', '\u0627\u0644\u0639\u0631\u0628\u064A\u0629'],
    ['az-Latn-AZ', 'Az\u0259rbaycan dili'],
    ['be-BY', '\u0411\u0435\u043B\u0430\u0440\u0443\u0441\u043A\u0430\u044F'],
    ['bg-BG', '\u0411\u044A\u043B\u0433\u0430\u0440\u0441\u043A\u0438'],
    ['bn-BD', '\u09AC\u09BE\u0982\u09B2\u09BE'],
    ['bn-IN', '\u09AC\u09BE\u0982\u09B2\u09BE'],
    ['bs-BA', 'Bosanski'],
    ['cs-CZ', '\u010Ce\u0161tina'],
    ['da-DK', 'Dansk'],
    ['de-DE', 'Deutsch'],
    ['el-GR', '\u0395\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC'],
    ['en-GB', 'English (UK)'],
    ['en-NG', 'English (Nigeria)'],
    ['en-US', 'English (US)'],
    ['es-ES', 'Espa\u00F1ol (Espa\u00F1a)'],
    ['es-US', 'Espa\u00F1ol (Estados Unidos)'],
    ['et-EE', 'Eesti'],
    ['fa-IR', '\u0641\u0627\u0631\u0633\u06CC'],
    ['fi-FI', 'Suomi'],
    ['fil-PH', 'Filipino'],
    ['fr-CA', 'Fran\u00E7ais (Canada)'],
    ['fr-FR', 'Fran\u00E7ais'],
    ['he-IL', '\u05E2\u05D1\u05E8\u05D9\u05EA'],
    ['hi-IN', '\u0939\u093F\u0928\u094D\u0926\u0940'],
    ['hr-HR', 'Hrvatski'],
    ['hu-HU', 'Magyar'],
    ['hy-AM', '\u0540\u0561\u0575\u0565\u0580\u0565\u0576'],
    ['id-ID', 'Bahasa Indonesia'],
    ['is-IS', '\u00CDslenska'],
    ['it-IT', 'Italiano'],
    ['ka-GE', '\u10E5\u10D0\u10E0\u10D7\u10E3\u10DA\u10D8'],
    ['kk-KZ', '\u049A\u0430\u0437\u0430\u049B \u0442\u0456\u043B\u0456'],
    ['km-KH', '\u1781\u17D2\u1798\u17C2\u179A'],
    ['lo-LA', '\u0EA5\u0EB2\u0EA7'],
    ['lt-LT', 'Lietuvi\u0173'],
    ['lv-LV', 'Latvie\u0161u'],
    ['mk-MK', '\u041C\u0430\u043A\u0435\u0434\u043E\u043D\u0441\u043A\u0438'],
    ['mo-RO', 'Moldoveneasc\u0103'],
    ['ms-MY', 'Bahasa Melayu'],
    ['nb-NO', 'Norsk bokm\u00E5l'],
    ['ne-IN', '\u0928\u0947\u092A\u093E\u0932\u0940'],
    ['nl-NL', 'Nederlands'],
    ['pl-PL', 'Polski'],
    ['ps-AF', '\u067E\u069A\u062A\u0648'],
    ['pt-BR', 'Portugu\u00EAs (Brasil)'],
    ['pt-PT', 'Portugu\u00EAs'],
    ['ro-RO', 'Rom\u00E2n\u0103'],
    ['ru-RU', '\u0420\u0443\u0441\u0441\u043A\u0438\u0439'],
    ['si-LK', '\u0DC3\u0DD2\u0D82\u0DC4\u0DBD'],
    ['sk-SK', 'Sloven\u010Dina'],
    ['sl-SI', 'Sloven\u0161\u010Dina'],
    ['sq-AL', 'Shqip'],
    ['sr-Latn-CS', 'Srpski'],
    ['sv-SE', 'Svenska'],
    ['sw-ZA', 'Kiswahili'],
    ['ta-IN', '\u0BA4\u0BAE\u0BBF\u0BB4\u0BCD'],
    ['th-TH', '\u0E44\u0E17\u0E22'],
    ['tr-TR', 'T\u00FCrk\u00E7e'],
    ['uk-UA', '\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430'],
    ['ur-PK', '\u0627\u0631\u062F\u0648'],
    ['uz-Cyrl-UZ', '\u040E\u0437\u0431\u0435\u043A'],
    ['vi-VN', 'Ti\u1EBFng Vi\u1EC7t'],
    ['xh-ZA', 'isiXhosa'],
    ['zh-CN', '\u7B80\u4F53\u4E2D\u6587'],
    ['zh-HK', '\u7E41\u9AD4\u4E2D\u6587\uFF08\u9999\u6E2F\uFF09'],
    ['zh-TW', '\u7E41\u9AD4\u4E2D\u6587'],
    ['zu-ZA', 'isiZulu']
  ];

  /** Native display name for a locale code (falls back to the code). */
  function langName(code) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i][0] === code) return LANGS[i][1];
    }
    return code || '';
  }

  /** The locale code currently active in the l10n runtime. */
  function currentLocaleCode() {
    try {
      if (typeof navigator !== 'undefined' && navigator.mozL10n &&
          navigator.mozL10n.language && navigator.mozL10n.language.code) {
        return navigator.mozL10n.language.code;
      }
    } catch (e) {}
    return 'en-US';
  }

  /**
   * Switch the runtime language. No-op when already on `code` so we never
   * trigger a redundant locale reload (keeps 'localized' from looping).
   */
  function setLanguageRuntime(code) {
    if (!code) return;
    try {
      if (typeof navigator === 'undefined' || !navigator.mozL10n ||
          !navigator.mozL10n.language) return;
      if (navigator.mozL10n.language.code === code) return;
      navigator.mozL10n.language.code = code;
    } catch (e) {}
  }

  /** Re-request the runtime locale from the device (Auto change = On). */
  function syncLanguageToSystem() {
    try {
      if (typeof navigator === 'undefined' || !navigator.mozL10n) return;
      var cur = (navigator.mozL10n.language && navigator.mozL10n.language.code) || '';
      var langs = (navigator.languages && navigator.languages.length)
        ? navigator.languages : [navigator.language || 'en-US'];
      for (var i = 0; i < langs.length; i++) {
        if (langs[i] === cur) return; // already on a system locale
      }
      var ctx = navigator.mozL10n.ctx;
      if (ctx && typeof ctx.requestLocales === 'function') {
        ctx.requestLocales.apply(ctx, langs);
      } else if (navigator.mozL10n.language) {
        navigator.mozL10n.language.code = langs[0];
      }
    } catch (e) {}
  }

  /**
   * Re-assert the persisted language preference. Called from load() so the
   * choice survives boot, reset and settings import. Auto = follow the
   * system; Off = pin the saved code.
   */
  function applyLanguagePreference() {
    if (_values.sys.autoLang !== false) {
      syncLanguageToSystem();
      return;
    }
    if (_values.sys.language) setLanguageRuntime(_values.sys.language);
  }

  /** Read the saved manual language straight from localStorage (pre-boot). */
  function savedLanguage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (p && p.sys && p.sys.autoLang === false && p.sys.language) return p.sys.language;
    } catch (e) {}
    return null;
  }

  /** Build the Language Settings page (toggle + separator + 68 radio rows). */
  function buildLanguagePage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.ui.radioGroups = { language: [] };
    _sub.focusIdx = 0;

    // Auto change language — always the first row.
    addSubRow(listEl, 'bool', 'autoLang', 'Auto change language');

    // Auto On: the locale list is hidden; the device language rules.
    if (_values.sys.autoLang !== false) return;

    // Separator + one radio row per bundled locale.
    var sep = document.createElement('div');
    sep.className = 'kai-separator';
    var st = document.createElement('span');
    st.className = 'kai-separator-text';
    st.textContent = L10n.t('language_separator', 'Language separator');
    sep.appendChild(st);
    listEl.appendChild(sep);

    var cur = _values.sys.language || '';
    for (var i = 0; i < LANGS.length; i++) {
      var code = LANGS[i][0];
      var row = document.createElement('div');
      row.className = 'setting-row';
      row.setAttribute('tabindex', '-1');
      row.setAttribute('data-type', 'radio');
      row.setAttribute('data-key', 'language');
      row.setAttribute('data-value', code);

      var lbl = document.createElement('span');
      lbl.className = 'setting-row-label';
      lbl.textContent = LANGS[i][1];
      row.appendChild(lbl);

      var radioEl = document.createElement('span');
      radioEl.className = 'palette-radio';
      row.appendChild(radioEl);

      if (code === cur) row.classList.add('selected');

      listEl.appendChild(row);
      _sub.ui.radioGroups.language.push({ value: code, row: row });
      _sub.items.push({ type: 'radio', part: 'language', key: 'language', value: code });
    }
  }

  /** Re-render the Language page in place (Auto toggle / locale change). */
  function rebuildLanguagePage() {
    if (!_sub || _sub.kind !== 'languageSettings') return;
    var listEl = document.getElementById('subsettings-list');
    if (!listEl) return;
    var oldIdx = _sub.focusIdx;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    buildLanguagePage(listEl);
    // Re-assert the header: a locale switch retranslates the shared
    // data-l10n-id header back to its generic label.
    var hdr = document.getElementById('subsettings-header');
    if (hdr) hdr.textContent = L10n.t('language', 'Language');
    _sub.focusIdx = Math.min(oldIdx, Math.max(0, _sub.items.length - 1));
    paintSubFocus();
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /** Tick the radio of the active manual language. */
  function _highlightLanguageRadio() {
    if (!_sub || !_sub.ui.radioGroups) return;
    var rows = _sub.ui.radioGroups.language || [];
    var cur = _values.sys.language || '';
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].value === cur) rows[i].row.classList.add('selected');
      else rows[i].row.classList.remove('selected');
    }
  }

  /** Select (pin) a language from the radio list. */
  function selectLanguage(code) {
    if (!code) return;
    _values.sys.language = code;
    if (_values.sys.autoLang !== false) {
      _values.sys.autoLang = false;
      Store.setState(_mapToStore('sys', 'autoLang', false));
    }
    Store.setState(_mapToStore('sys', 'language', code));
    save();
    setLanguageRuntime(code);            // runtime switch (fires 'localized')
    _highlightLanguageRadio();
    if (typeof window.showToast === 'function') window.showToast(langName(code));
  }

  /**
   * Re-render whatever settings list is open in the new language. Dynamic
   * rows are built with L10n.t at build time, so they must be rebuilt after
   * a locale switch (the static data-l10n-id nodes retranslate themselves).
   */
  function onLocaleChanged() {
    if (!isOpen()) return;
    if (_sub) {
      if (_sub.kind === 'languageSettings') rebuildLanguagePage();
    } else {
      refreshCurrentRows();
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  // â”€â”€ SoundFont loader page (Synth â†’ Load Soundfont) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Scans BOTH partitions via SfScan; each found file renders as a square
  // CHECKBOX row (LSK = All/Deselect, OK = select, RSK = Finish to load).
  // Loading never writes to a partition â€” banks + selection are persisted
  // in the Soundbank registry (localStorage).

  /**
   * Build the SoundFont discovery page. Scanning is async: the page first
   * shows a "Scanningâ€¦" hint, then replaces the
   * list with the found files once SfScan.list() resolves.
   */
  function buildSoundFontPage(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.focusIdx = 0;
    _sub.ui.scanning = true;
    _sub.ui.found = [];
    _sub.ui.selected = {};
    _sub.ui.sfRowEls = {};

    var hint = document.createElement('div');
    hint.className = 'sf-hint';
    hint.textContent = L10n.t('scanning', 'Scanning\u2026');
    listEl.appendChild(hint);
    _sub.items.push({ type: 'sfhint' });

    if (typeof SfScan === 'undefined' || !SfScan.list) {
      hint.textContent = L10n.t('scanner_unavailable', 'SoundFont scanner unavailable');
      return;
    }
    SfScan.list(function (entries) {
      if (!_sub || _sub.kind !== 'soundfonts') return; // page closed meanwhile
      _sub.ui.scanning = false;
      _sub.ui.found = entries || [];
      if (listEl) {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        _renderFoundRows(listEl);
      }
      paintSubFocus();
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    });
  }

  // Rebuild the scan list DOM once SfScan answered.
  function _renderFoundRows(listEl) {
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.ui.sfRowEls = {};
    _sub.focusIdx = 0;

    var entries = _sub.ui.found || [];
    if (!entries.length) {
      var none = document.createElement('div');
      none.className = 'sf-hint';
      none.textContent = L10n.t('no_sf_files_found', 'No .sf2 / .sf3 / .soundbank files found.\nPut one on the card, then scan again.');
      listEl.appendChild(none);
      _sub.items.push({ type: 'sfhint' });
      return;
    }

    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      var row = document.createElement('div');
      row.className = 'sf-row';
      row.setAttribute('tabindex', '-1');

      var check = document.createElement('span');
      check.className = 'sf-check';
      row.appendChild(check);

      var lbl = document.createElement('span');
      lbl.className = 'sf-row-label';
      lbl.textContent = ent.name;
      row.appendChild(lbl);

      listEl.appendChild(row);
      _sub.ui.sfRowEls[ent.path] = { row: row, check: check };
      _sub.items.push({
        type: 'sfcheck',
        path: ent.path,
        name: ent.name,
        volName: ent.volName,
        st: ent.st
      });
    }
  }

  /** Re-paint which scan rows are ticked (square checkbox highlight). */
  function refreshSfChecks() {
    for (var p in _sub.ui.sfRowEls) {
      if (!_sub.ui.sfRowEls.hasOwnProperty(p)) continue;
      var ref = _sub.ui.sfRowEls[p];
      var on = !!_sub.ui.selected[p];
      ref.row.classList.toggle('selected', on);
      ref.check.classList.toggle('selected', on);
    }
  }

  /** Move scan focus by Â±1 over tickable rows (wrap-around). */
  function sfStep(dir) {
    var n = _sub.items.length;
    if (!n) return;
    for (var k = 0; k < n; k++) {
      _sub.focusIdx = (_sub.focusIdx + (dir > 0 ? 1 : n - 1)) % n;
      var it = _sub.items[_sub.focusIdx];
      if (it && it.type === 'sfcheck') break;
    }
    paintSubFocus();
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /** LSK on the scan page: select all / deselect all (whichever is needed). */
  function sfSelectAll() {
    var checked = 0, total = 0;
    for (var i = 0; i < _sub.items.length; i++) {
      if (_sub.items[i].type !== 'sfcheck') continue;
      total++;
      if (_sub.ui.selected[_sub.items[i].path]) checked++;
    }
    var toAll = (checked !== total);
    for (var j = 0; j < _sub.items.length; j++) {
      if (_sub.items[j].type === 'sfcheck') _sub.ui.selected[_sub.items[j].path] = toAll;
    }
    refreshSfChecks();
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    if (typeof window.showToast === 'function') window.showToast(toAll ? L10n.t('toast_all_selected', 'All selected') : L10n.t('toast_selection_cleared', 'Selection cleared'));
  }

  var _sfLoadingActive = false;
  var _sfLoadingCancel = false;
  var _sfInitialBankIds = [];

  function isSfLoading() {
    return _sfLoadingActive;
  }

  function isSfLoadingCancelled() {
    return _sfLoadingCancel;
  }

  function cancelSfLoading() {
    if (!_sfLoadingActive && !_sfLoadingCancel) return;
    _sfLoadingCancel = true;
    _sfLoadingActive = false;
    var dlg = document.getElementById('sf-loading-dialog');
    if (dlg) dlg.classList.add('hidden');

    // Rollback any banks added during this cancelled session
    if (typeof Soundbank !== 'undefined' && Soundbank.getBanks && Soundbank.removeBank) {
      var currentBanks = Soundbank.getBanks() || [];
      currentBanks.forEach(function (b) {
        if (_sfInitialBankIds.indexOf(b.id) === -1) {
          try { Soundbank.removeBank(b.id); } catch (e) {}
        }
      });
    }

    // Close scanner page if open, or rebuild sfsettings
    if (_sub && _sub.kind === 'soundfonts') {
      closeSub();
    } else if (_sub && _sub.kind === 'sfsettings') {
      var listEl = document.getElementById('subsettings-list');
      if (listEl) {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        buildSfSettingsPage(listEl);
        paintSubFocus();
      }
    }

    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_loading_cancelled', 'Loading cancelled'));
  }

  function startBootSfLoading(restoreTaskFn) {
    var dlg = document.getElementById('sf-loading-dialog');
    var subtitleEl = document.getElementById('sf-loading-subtitle');
    var listEl = document.getElementById('sf-loading-list');
    var barEl = document.getElementById('sf-loading-bar');
    var pctEl = document.getElementById('sf-loading-percent');
    if (!dlg) {
      if (typeof restoreTaskFn === 'function') restoreTaskFn(function () {}, function () {});
      return;
    }

    _sfLoadingActive = true;
    _sfLoadingCancel = false;
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();

    if (subtitleEl) {
      subtitleEl.textContent = L10n.t('loading_soundfont', 'Loading SoundFont...');
      subtitleEl.style.display = 'block';
    }
    if (listEl) {
      listEl.textContent = '';
      listEl.style.display = 'block';
    }
    if (barEl) barEl.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
    dlg.classList.remove('hidden');

    function onProgress(pct, itemLog) {
      if (_sfLoadingCancel) return;
      var val = Math.min(100, Math.max(0, Math.round(pct)));
      if (barEl) barEl.style.width = val + '%';
      if (pctEl) pctEl.textContent = val + '%';
      if (itemLog) {
        if (subtitleEl) subtitleEl.textContent = L10n.t('loading_prefix', 'Loading: ') + itemLog;
        if (listEl) listEl.textContent = itemLog;
      }
    }

    function onDone() {
      _sfLoadingActive = false;
      dlg.classList.add('hidden');
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    }

    if (typeof restoreTaskFn === 'function') {
      restoreTaskFn(onProgress, onDone);
    }
  }

  function isSfDoneOpen() {
    var ov = document.getElementById('sf-done-dialog');
    return !!(ov && !ov.classList.contains('hidden'));
  }

  function openSfDoneDialog(msg) {
    var ov = document.getElementById('sf-done-dialog');
    if (ov) {
      var msgEl = document.getElementById('sf-done-msg');
      if (msgEl && msg) msgEl.textContent = msg;
      ov.classList.remove('hidden');
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function hideSfDoneDialog() {
    var ov = document.getElementById('sf-done-dialog');
    if (ov) ov.classList.add('hidden');
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /** RSK on the scan page: load every ticked file into its own bank. */
  function sfFinish() {
    if (_sub.ui.scanning) {
      if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_still_scanning', 'Still scanning\u2026'));
      return;
    }
    var selected = [];
    for (var i = 0; i < _sub.items.length; i++) {
      var it = _sub.items[i];
      if (it.type === 'sfcheck' && _sub.ui.selected[it.path]) selected.push(it);
    }
    if (!selected.length) {
      if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_nothing_selected', 'Nothing selected to load'));
      return;
    }

    // Record initial bank IDs for rollback if cancelled
    var initialBanks = (typeof Soundbank !== 'undefined' && Soundbank.getBanks) ? Soundbank.getBanks() : [];
    _sfInitialBankIds = initialBanks.map(function (b) { return b.id; });

    // Filter out items that are ALREADY loaded in initialBanks
    var alreadyLoaded = [];
    var toLoad = [];

    selected.forEach(function (it) {
      var name = it.name || (it.path ? it.path.split('/').pop() : '');
      var isDup = initialBanks.some(function (b) {
        return (b.path && b.path === it.path) || (b.name && name && b.name === name);
      });
      if (isDup) {
        alreadyLoaded.push(it);
      } else {
        toLoad.push(it);
      }
    });

    if (!toLoad.length) {
      // ALL selected files are ALREADY loaded!
      var names = alreadyLoaded.map(function (it) {
        return it.name || (it.path ? it.path.split('/').pop() : 'SoundFont');
      }).join(', ');
      openSfDoneDialog(L10n.t('already_loaded', 'already loaded ') + names);
      return;
    }

    // ── Show loading dialog ──
    var dlg = document.getElementById('sf-loading-dialog');
    var subtitleEl = document.getElementById('sf-loading-subtitle');
    var listEl = document.getElementById('sf-loading-list');
    var barEl = document.getElementById('sf-loading-bar');
    var pctEl = document.getElementById('sf-loading-percent');
    if (!dlg || !listEl) return;

    var done = 0, failed = 0, failedNames = [];
    var totalFiles = toLoad.length;
    var fileIdx = 0;

    var firstFileName = toLoad[0] ? (toLoad[0].name || (toLoad[0].path ? toLoad[0].path.split('/').pop() : '')) : '';
    if (subtitleEl) {
      subtitleEl.textContent = firstFileName ? (L10n.t('loading_prefix', 'Loading: ') + firstFileName) : L10n.t('loading_soundfont', 'Loading SoundFont...');
      subtitleEl.style.display = 'block';
    }
    if (listEl) {
      if (_values.dev && _values.dev.verboseSfLoad) {
        listEl.textContent = totalFiles > 1 ? ('1 / ' + totalFiles) : L10n.t('reading_file', 'Reading file...');
        listEl.style.display = 'block';
      } else {
        listEl.style.display = 'none';
      }
    }

    _sfLoadingActive = true;
    _sfLoadingCancel = false;
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();

    if (barEl) barEl.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
    dlg.classList.remove('hidden');

    function updateOverallProgress(samplesDone, samplesTotal) {
      if (_sfLoadingCancel) return;
      var fileBase = fileIdx / totalFiles;
      var fileFrac = (samplesTotal > 0) ? (samplesDone / samplesTotal) : 1;
      var overall = Math.min(100, Math.round((fileBase + fileFrac / totalFiles) * 100));
      if (barEl) barEl.style.width = overall + '%';
      if (pctEl) pctEl.textContent = overall + '%';
      var currentName = toLoad[fileIdx] ? (toLoad[fileIdx].name || (toLoad[fileIdx].path ? toLoad[fileIdx].path.split('/').pop() : '')) : '';
      if (subtitleEl && currentName) {
        subtitleEl.textContent = (totalFiles > 1 ? ('[' + (fileIdx + 1) + '/' + totalFiles + '] ') : '') + L10n.t('loading_prefix', 'Loading: ') + currentName;
      }
      if (listEl) {
        if (_values.dev && _values.dev.verboseSfLoad) {
          listEl.textContent = samplesTotal > 0 ? (L10n.t('decoding_samples', 'Decoding samples (') + samplesDone + '/' + samplesTotal + ')') : L10n.t('decoding_samples_dots', 'Decoding samples...');
        }
      }
    }

    var chain = Promise.resolve();
    toLoad.forEach(function (sel, idx) {
      chain = chain.then(function () {
        if (_sfLoadingCancel || !_sfLoadingActive) return;
        fileIdx = idx;
        var fileName = sel.name || (sel.path ? sel.path.split('/').pop() : 'SoundFont');
        if (subtitleEl) {
          subtitleEl.textContent = (totalFiles > 1 ? ('[' + (idx + 1) + '/' + totalFiles + '] ') : '') + L10n.t('loading_prefix', 'Loading: ') + fileName;
        }
        if (listEl) {
          if (_values.dev && _values.dev.verboseSfLoad) {
            listEl.textContent = L10n.t('reading_file', 'Reading file...');
          }
        }
        if (typeof SfScan === 'undefined' || !SfScan.readFile) return;
        return SfScan.readFile({ st: sel.st, path: sel.path, name: sel.name, volName: sel.volName })
          .then(function (ab) {
            if (_sfLoadingCancel || !_sfLoadingActive) throw new Error('Cancelled');
            if (typeof Soundbank === 'undefined' || !Soundbank.loadFromFile) throw new Error('Soundbank unavailable');
            return Soundbank.loadFromFile(sel.name, sel.path, sel.volName, ab, updateOverallProgress);
          })
          .then(function () {
            if (_sfLoadingCancel) return;
            done++;
          }, function (err) {
            if (_sfLoadingCancel) return;
            failed++;
            failedNames.push(fileName);
          });
      });
    });
    chain.then(function () {
      if (_sfLoadingCancel || !_sfLoadingActive) {
        _sfLoadingActive = false;
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        return;
      }
      _sfLoadingActive = false;
      // Fill bar to 100%
      if (barEl) barEl.style.width = '100%';
      if (pctEl) pctEl.textContent = '100%';

      // Auto-close dialog after a brief moment
      setTimeout(function () {
        dlg.classList.add('hidden');

        // Auto-select the soundbank engine now that banks exist.
        try {
          _values.midi.engine = 'soundbank';
          Store.setState({ engine: 'soundbank' });
          save();
        } catch (e) {}
        closeSub();
        
        // If we returned to the sfsettings sub-page, we need to rebuild it to show the new banks.
        if (_sub && _sub.kind === 'sfsettings') {
          var sfListEl = document.getElementById('subsettings-list');
          if (sfListEl) {
            while (sfListEl.firstChild) sfListEl.removeChild(sfListEl.firstChild);
            buildSfSettingsPage(sfListEl);
            // Auto-focus the first newly loaded SoundFont so the user sees it immediately
            for (var i = 0; i < _sub.items.length; i++) {
              if (_sub.items[i].type === 'sfrow') {
                _sub.focusIdx = i;
                break;
              }
            }
            paintSubFocus();
          }
        } else {
          var parent = document.getElementById('settings-overlay');
          if (parent && _openGroup) {
            rebuildRows(parent, _openGroup);
            var rows = parent.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
            if (rows.length) focusRow(rows, Math.min(_focusIdx, rows.length - 1));
          }
        }
        
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        if (failedNames.length > 0 && typeof window.showErrorDialog === 'function') {
          var errList = failedNames.map(function (n) { return '• ' + n; }).join('\n');
          window.showErrorDialog(L10n.t('failed_load_sf', 'Failed to load SoundFont(s) (file moved, deleted, or corrupted):\n') + errList, null, L10n.t('error', 'Error'));
        } else {
          var msg = failed ? (done + ' ' + L10n.t('loaded_sf_short', 'loaded, ') + failed + ' ' + L10n.t('failed_sf_short', 'failed')) : (L10n.t('loaded_prefix', 'Loaded ') + done + ' ' + L10n.t('toast_soundfonts', 'soundfont(s)'));
          if (alreadyLoaded.length > 0) {
            var alNames = alreadyLoaded.map(function(it){ return it.name || (it.path ? it.path.split('/').pop() : ''); }).join(', ');
            msg += ' (' + L10n.t('already_loaded', 'already loaded ') + alNames + ')';
          }
          openSfDoneDialog(msg);
        }
      }, 300);
    });
  }



  /**
   * Keyboard for the SoundFont scan sub-page.
   *   â–²â–¼ / â—€â–¶  move focus      OK        toggle the ticked checkbox
   *   LSK       All / Deselect all
   *   RSK       Finish â†’ load everything ticked
   *   Back      back to the Synth group (nothing loads)
   */
  function sfScanKey(key) {
    var isBack = (key === 'Backspace' || key === Constants.KEY.BACKSPACE);
    if (isBack) { closeSub(); return true; }

    var focused = _sub.items[_sub.focusIdx];

    if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) { sfStep(-1); return true; }
    if (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) { sfStep(+1); return true; }
    if (key === 'ArrowLeft' || key === Constants.KEY.ARROW_LEFT) { sfStep(-1); return true; }
    if (key === 'ArrowRight' || key === Constants.KEY.ARROW_RIGHT) {
      sfStep(+1);
      return true;
    }
    if (key === Constants.KEY.ENTER || key === 13 || key === 'Enter') {
      if (focused && focused.type === 'sfcheck') {
        _sub.ui.selected[focused.path] = !_sub.ui.selected[focused.path];
        refreshSfChecks();
      }
      return true;
    }
    if (key === 'SoftLeft' || key === Constants.KEY.SOFT_LEFT) { sfSelectAll(); return true; }
    if (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT) { sfFinish(); return true; }

    return true; // modal page swallows everything else
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
   *   â€” Render Mode â€” 3 radio-style rows (auto/individual/buffer)
   *   â€” 3D View â€”      4 radio-style rows (keyboard/notefall/both/none)
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
      st.textContent = L10n.t('sep_' + text.toLowerCase().replace(/ /g, '_'), text);
      s.appendChild(st);
      listEl.appendChild(s);
    }

    // â”€â”€ Render Mode radio group â”€â”€
    sep(L10n.t('sep_render_mode', 'Render Mode'));
    var renderModes = [
      ['auto', L10n.t('opt_auto', 'Auto')],
      ['individual', L10n.t('opt_individual', 'Individual')],
      ['buffer', L10n.t('opt_buffer', 'Buffer')]
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
      lbl.textContent = L10n.t('opt_' + rm[0], rm[1]);
      row.appendChild(lbl);

      var radioEl = document.createElement('span');
      radioEl.className = 'palette-radio';
      row.appendChild(radioEl);

      if (rm[0] === curRender) row.classList.add('selected');

      listEl.appendChild(row);
      _sub.ui.renderModeRows.push({ value: rm[0], row: row });
      _sub.items.push({ type: 'radio', part: 'renderMode', key: 'renderMode', value: rm[0] });
    }

    // â”€â”€ 3D View radio group â”€â”€
    sep(L10n.t('sep_3d_view', '3D View'));
    var view3dModes = [
      ['keyboard', L10n.t('opt_keyboard', 'Keyboard')],
      ['notefall', L10n.t('opt_notefall', 'Note fall')],
      ['both', L10n.t('opt_both', 'Both')],
      ['none', L10n.t('opt_none', 'None')]
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
      vlbl.textContent = L10n.t('opt_' + vm[0], vm[1]);
      vrow.appendChild(vlbl);

      var vradioEl = document.createElement('span');
      vradioEl.className = 'palette-radio';
      vrow.appendChild(vradioEl);

      if (vm[0] === curView) vrow.classList.add('selected');

      listEl.appendChild(vrow);
      _sub.ui.view3dRows.push({ value: vm[0], row: vrow });
      _sub.items.push({ type: 'radio', part: 'view3d', key: 'view3d', value: vm[0] });
    }

    // 3D effects appear only when 3D is enabled for notes, keys, or both.
    // The mode controls which rows belong under the separator.
    var showFall3d = (curView === 'notefall' || curView === 'both');
    var showKey3d = (curView === 'keyboard' || curView === 'both');
    if (curView !== 'none') {
      sep(L10n.t('sep_3d_effects', '3D Effects'));
      if (showFall3d) {
        addGraphicsTextRow(listEl, 'view3dFallOpacity', 'Note Fall Fade',
          'Note fade strength (0–100; 0 = no fade)', 0, 100);
      }
      if (showKey3d) {
        addSubRow(listEl, 'bool', 'view3dKeyGlow', 'Key Glow');
        addSubRow(listEl, 'color', 'view3dGlowColor', 'Effects Colors', function () {
          return _values.visual.view3dGlowColor || '#FFFFFF';
        });
      }
    }
  }

  /** One integer text box for the Graphics page, using General's kai-text-input style. */
  function addGraphicsTextRow(listEl, key, label, hint, min, max) {
    var w = document.createElement('div');
    w.className = 'kai-text-input';
    w.setAttribute('tabindex', '-1');
    w.setAttribute('data-type', 'gfxtext');
    w.setAttribute('data-key', key);

    var lab = document.createElement('label');
    lab.className = 'kai-text-input-label';
    lab.textContent = L10n.t(keyMap[key] || key, label);
    w.appendChild(lab);

    var input = document.createElement('input');
    input.className = 'kai-text-input-input';
    input.type = 'tel';
    var curVal = _values.visual[key];
    var initVal = (curVal != null && !isNaN(Number(curVal)))
      ? Math.round(Number(curVal))
      : max;
    initVal = Math.max(min, Math.min(max, initVal));
    input.value = String(initVal);
    w.appendChild(input);

    var hintEl = document.createElement('div');
    hintEl.className = 'kai-text-input-hint';
    hintEl.textContent = L10n.t((keyMap[key] || key) + '_hint', hint);
    w.appendChild(hintEl);

    listEl.appendChild(w);
    var item = { type: 'gfxtext', part: key, row: w, input: input, min: min, max: max, lastValidValue: initVal };
    _sub.items.push(item);
    _sub.ui[key + 'Text'] = { row: w, input: input };
    return { row: w, input: input };
  }

  /** Commit a Graphics-page numeric text box: whole numbers only, clamped to range. */
  function gfxCommitText(item) {
    if (!item || item.type !== 'gfxtext') return;
    if (item.input && document.activeElement === item.input) {
      try { item.input.blur(); } catch (e) {}
    }
    var raw = item.input ? item.input.value : '';
    // Respect decimal separators, then round to an integer 0–100. This keeps
    // entries such as "99.6" meaningful instead of concatenating their digits.
    var numStr = String(raw).trim().replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
    var n = Math.round(parseFloat(numStr));
    if (!isFinite(n)) {
      n = (item.lastValidValue != null)
        ? item.lastValidValue
        : ((_values.visual[item.part] != null && !isNaN(Number(_values.visual[item.part])))
          ? Math.round(Number(_values.visual[item.part])) : item.max);
    }
    n = Math.max(item.min, Math.min(item.max, n));
    item.lastValidValue = n;
    if (item.input) item.input.value = String(n);
    _values.visual[item.part] = n;
    Store.setState(_mapToStore('visual', item.part, n));
    save();
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

    // One-shot "Random note color" action â€” regenerates all 16 channel
    // colours. Locked until a real file is loaded (demo/tutorial mode).
    // Placed ABOVE the "Note color palette" separator.
    var rnd = document.createElement('div');
    rnd.className = 'palette-action';
    rnd.textContent = L10n.t('random_note_color', 'Random note color');
    rnd.setAttribute('tabindex', '-1');
    listEl.appendChild(rnd);
    _sub.ui.paletteRandom = rnd;
    _sub.items.push({ type: 'randomaction' });

    // Separator â€” matches KaiUI kai-separator style.
    var sep = document.createElement('div');
    sep.className = 'kai-separator';
    var sepText = document.createElement('span');
    sepText.className = 'kai-separator-text';
    sepText.textContent = L10n.t('sep_note_color_palette', 'Note color palette');
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
      nameEl.textContent = L10n.t('palette_' + pal.id, pal.label);
      row.appendChild(nameEl);

      // KaiUI radio-button glyph (kai-rbl) â€” dot appears when selected.
      var radioEl = document.createElement('span');
      radioEl.className = 'palette-radio';
      row.appendChild(radioEl);

      listEl.appendChild(row);
      _sub.ui.paletteRows.push({ id: pal.id, row: row });
      _sub.items.push({ type: 'palette', part: pal.id, key: 'palette' });
    }

    // "Load more" row â€” triggers MozActivity image picker.
    var loadMore = document.createElement('div');
    loadMore.className = 'palette-loadmore';
    loadMore.textContent = L10n.t('load_more', 'Load more');
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
   * 'random' â†’ regenerate random hues; others â†’ sample from their
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
    // Built-in palette â€” sample from the PNG strip and cache.
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
      // Cycle to 16 channels â€” synth10 (10) wraps channels 10-15 to 0-5,
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
        var customLabel = L10n.t('palette_custom_loaded', 'Custom Palette');
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
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_custom_palette', 'Custom palette loaded'));
      };
      img.onerror = function () {
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_invalid_image', 'Not a valid image file'));
      };
      img.src = URL.createObjectURL(blob);
    }

    var retried = false;
    function retryWithType() {
      if (retried) {
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_no_picker', 'Image picker not available'));
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
          } else if (typeof window.showToast === 'function') {
            showToast(L10n.t('toast_cannot_read', 'Cannot read that file'));
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
      // The plain pick shows every file type â€” reject anything that isn't
      // an image (MIME 'image/*' or a known image extension), so a .mid
      // or other file never becomes the background.
      var mime = String(blob.type || '').toLowerCase();
      var ext = String(blob.name || '').toLowerCase().split('.').pop();
      var IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
      if (mime.indexOf('image/') !== 0 && IMG_EXT.indexOf(ext) === -1) {
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_not_image', 'Not an image file'));
        return;
      }
      // Only keep the source path when it really looks like a storage path
      // (contains a slash) â€” a bare file name can't be checked at boot and
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
          if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_image_too_large', 'Image too large'));
          return;
        }
        // The picker may hand back a full path â€” keep only the file name.
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
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_bg_saved', 'Background image saved'));
      };
      img.onerror = function () {
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_invalid_image', 'Not a valid image file'));
      };
      img.src = URL.createObjectURL(blob);
    }

    var retried = false;
    function retryWithType() {
      if (retried) {
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_no_picker', 'Image picker not available'));
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
          } else if (typeof window.showToast === 'function') {
            showToast(L10n.t('toast_cannot_read', 'Cannot read that file'));
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

    // Plain pick â€” the format that works on the device:
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
    if (!skipToast && typeof window.showToast === 'function') window.showToast(L10n.t('toast_bg_cleared', 'Background image cleared'));
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
    if (ref && ref.valEl) ref.valEl.textContent = L10n.t('opt_' + item.choices[idx][0], item.choices[idx][1]);
  }

  /**
   * Toggle one Info Card boolean (master gate or per-stat switch),
   * persist it and re-apply HUD visibility immediately.
   */
  function toggleSubBool(key) {
    if (!_sub || (_sub.kind !== 'bools' && _sub.kind !== 'piano' && _sub.kind !== 'general' &&
                 _sub.kind !== 'graphics' && _sub.kind !== 'loadingBar' && _sub.kind !== 'dialog' &&
                 _sub.kind !== 'developer' && _sub.kind !== 'sfsettings' &&
                 _sub.kind !== 'languageSettings')) return;
    if (_sub.kind === 'sfsettings') {
      // Soundfont Settings row â€” lives under the MIDI group, not Visual.
      var next = !_values.midi[key];
      _values.midi[key] = next;
      Store.setState(_mapToStore('midi', key, next));
      save();
      var sRef = _sub.ui.boolRows && _sub.ui.boolRows[key];
      if (sRef && sRef.valEl) sRef.valEl.textContent = next ? L10n.t('on', 'On') : L10n.t('off', 'Off');
      return;
    }
    if (_sub.kind === 'languageSettings') {
      // Language row (autoLang) — persists under the 'sys' group. Flipping it
      // rebuilds the page (the locale list shows only while Off) and
      // re-syncs the runtime language (system vs pinned).
      var nextL = !_values.sys[key];
      _values.sys[key] = nextL;
      Store.setState(_mapToStore('sys', key, nextL));
      save();
      if (key === 'autoLang') {
        if (nextL) {
          syncLanguageToSystem();            // On — follow the system again
        } else {
          if (!_values.sys.language) _values.sys.language = currentLocaleCode();
          setLanguageRuntime(_values.sys.language); // Off — pin it
        }
        rebuildLanguagePage();
      }
      var lRef = _sub.ui.boolRows && _sub.ui.boolRows[key];
      if (lRef && lRef.valEl) lRef.valEl.textContent = nextL ? L10n.t('on', 'On') : L10n.t('off', 'Off');
      return;
    }
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
      if (dRef && dRef.valEl) dRef.valEl.textContent = next ? L10n.t('on', 'On') : L10n.t('off', 'Off');
      return;
    }
    var next = !_values.visual[key];
    _values.visual[key] = next;
    Store.setState(_mapToStore(_openGroup, key, next));
    save();
    if (_sub.kind === 'bools') {
      applyInfoCard();
      if (key === 'infoCard') {
        // Master flipped â†’ rebuild the page collapsed/expanded in place.
        // Focus lands back on the master row (idx 0).
        var list = document.getElementById('subsettings-list');
        if (list) {
          while (list.firstChild) list.removeChild(list.firstChild);
          buildBoolPage(list);
          paintSubFocus();
        }
        return; // row refs were rebuilt â€” no stale valEl write
      }
    } else if (_sub.kind === 'loadingBar') {
      // Loading-bar presentation changed â†’ live-apply while a parse runs.
      if (typeof window.applyParseBarStyle === 'function') {
        try { window.applyParseBarStyle(); } catch (e) {}
      }
    } else if (_sub.kind === 'dialog') {
      // showDialog is read live by the pill paths â€” nothing else to do.
    }
    var ref = _sub.ui.boolRows && _sub.ui.boolRows[key];
    if (ref && ref.valEl) ref.valEl.textContent = next ? L10n.t('on', 'On') : L10n.t('off', 'Off');
  }

  /**
   * Handle a key event while a level-2 page is open. Returns true when
   * consumed (always, except the guard case below).
   */
  function handleSubKey(key) {
    if (!_sub) return false;

    // SoundFont scan page has its own key map (LSK All/Deselect, RSK
    // Finish, OK toggles the square checkbox). Runs before the generic
    // sub-page handling so softkeys are usable inside this one page.
    if (_sub.kind === 'soundfonts') return sfScanKey(key);

    // Back â†’ back to the group page. ONLY the hardware Back key exits â€”
    // LSK/RSK are strictly forbidden inside sub-pages. A focused Soundfont
    // text box commits before closing so typed digits are never lost.
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE) {
      if (_sfMove) {
        cancelSfMove();
        return true;
      }
      if (_sub.kind === 'sfsettings') {
        var curB = _sub.items[_sub.focusIdx];
        if (curB && curB.type === 'sftext') sfCommitText(curB);
      }
      if (_sub.kind === 'general') {
        var curG = _sub.items[_sub.focusIdx];
        if (curG && curG.type === 'gentext') genCommitText(curG);
      }
      if (_sub.kind === 'graphics') {
        var curFx = _sub.items[_sub.focusIdx];
        if (curFx && curFx.type === 'gfxtext') gfxCommitText(curFx);
      }
      closeSub();
      return true;
    }

    // Vertical: the COLOR page uses a column-aware grid walk (DEF â†•
    // bottom wrap, grid columns mapping onto R/G/B/A). Other pages:
    // swatches AND the DEF cell stride by SWATCH_COLS, rest step by one.
    // All movement wraps around (bottom â†” top).
    if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) {
      var itU = _sub.items[_sub.focusIdx];
      if (_sfMove && itU && itU.type === 'sfrow') {
        _sfMoveRows(itU.row, -1);
        return true;
      }
      if (_sub.kind === 'color' && itU &&
          (itU.type === 'swatch' || itU.type === 'def' || itU.type === 'slider')) {
        moveColorVertical(-1);
      } else {
        moveSubFocus(itU && (itU.type === 'swatch' || itU.type === 'def')
          ? -SWATCH_COLS : -1);
      }
      if (_sfMove) { cancelSfMove(); }
      return true;
    }
    if (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
      var itD = _sub.items[_sub.focusIdx];
      if (_sfMove && itD && itD.type === 'sfrow') {
        _sfMoveRows(itD.row, +1);
        return true;
      }
      if (_sub.kind === 'color' && itD &&
          (itD.type === 'swatch' || itD.type === 'def' || itD.type === 'slider')) {
        moveColorVertical(+1);
      } else {
        moveSubFocus(itD && (itD.type === 'swatch' || itD.type === 'def')
          ? +SWATCH_COLS : +1);
      }
      if (_sfMove) { cancelSfMove(); }
      return true;
    }

    if (key === 'ArrowLeft' || key === Constants.KEY.ARROW_LEFT) {
      var itL = _sub.items[_sub.focusIdx];
      if (_sub.kind === 'sfsettings' && itL && itL.type === 'sftext') {
        sfCaretStep(itL, -1);
        return true;
      }
      if (_sub.kind === 'general' && itL && itL.type === 'gentext') {
        sfCaretStep(itL, -1);
        return true;
      }
      if (_sub.kind === 'graphics' && itL && itL.type === 'gfxtext') {
        sfCaretStep(itL, -1);
        return true;
      }
      adjustFocusedSub(-1);
      return true;
    }
    if (key === 'ArrowRight' || key === Constants.KEY.ARROW_RIGHT) {
      var itR = _sub.items[_sub.focusIdx];
      if (_sub.kind === 'sfsettings' && itR && itR.type === 'sftext') {
        sfCaretStep(itR, +1);
        return true;
      }
      if (_sub.kind === 'general' && itR && itR.type === 'gentext') {
        sfCaretStep(itR, +1);
        return true;
      }
      if (_sub.kind === 'graphics' && itR && itR.type === 'gfxtext') {
        sfCaretStep(itR, +1);
        return true;
      }
      if (drillSubRow(itR)) return true;
      adjustFocusedSub(+1);
      return true;
    }

    // Enter activates drill-in rows / swatch/DEF cells â€” but NEVER toggles
    // booleans (Info Card / Piano rows are Left/Right only by design).
    if (key === Constants.KEY.ENTER || key === 13 || key === 'Enter') {
      if (_sfMove) {
        commitSfMove();
        return true;
      }
      var itE = _sub.items[_sub.focusIdx];
      if (drillSubRow(itE)) return true;
      if (itE && itE.type === 'bool') return true; // swallowed on purpose
      activateFocusedSub();
      return true;
    }

    if (key === 'SoftLeft' || key === Constants.KEY.SOFT_LEFT || key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT) {
      if (handleSfSoftKey(key)) return true;
    }

    return true; // modal page swallows everything else
  }

  // â”€â”€ Row DOM â”€â”€

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
      // Storage permission denied â†’ dim "Export Log" (guard also in
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
        // is in kaiui.css â€” it matches KaiUI-master's `--ratio`/`--sx`
        // fill calculation so focused/unfocused look matches KaiUI.
        row.className = 'setting-row-slider';

        var line = document.createElement('div');
        line.className = 'setting-row-slider-line';

        var hdr = document.createElement('span');
        hdr.className = 'setting-row-slider-header';
        hdr.textContent = L10n.t(def.l10nKey || def.key, def.label);
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
      } else if (def.type === 'medtext') {
        // In-list numeric text box — EXACT same markup/style as the Visual
        // General page's Start Delay box (pure .kai-text-input, no
        // .setting-row chrome); the value is stored to midi.mediaDelay.
        row.className = 'kai-text-input';
        var mtLab = document.createElement('label');
        mtLab.className = 'kai-text-input-label';
        mtLab.textContent = L10n.t(def.l10nKey || def.key, def.label);
        row.appendChild(mtLab);
        var mtInput = document.createElement('input');
        mtInput.className = 'kai-text-input-input';
        mtInput.type = 'tel';
        var mtVal = (val != null && !isNaN(Number(val))) ? Number(val) : 0;
        mtInput.value = String(mtVal);
        row.appendChild(mtInput);
        var mtHint = document.createElement('div');
        mtHint.className = 'kai-text-input-hint';
        mtHint.textContent = L10n.t((def.l10nKey || def.key) + '_hint', 'Delay before the media starts (seconds, 0 = Off)');
        row.appendChild(mtHint);
        list.appendChild(row);
        _medRow = { row: row, input: mtInput };
      } else {
        row.className = 'setting-row';

        var lbl = document.createElement('span');
        lbl.className = 'setting-row-label';
        lbl.textContent = (typeof def.labelFn === 'function') ? def.labelFn() : L10n.t(def.l10nKey || def.key, def.label);
        row.appendChild(lbl);

        var valEl = document.createElement('span');
        valEl.className = 'setting-row-value';

        if (def.type === 'sub') {
          // Drill-in row â€” forward arrow drawn by CSS via
          // .setting-row.has-sub::after (gaia-icons 'forward'), the SAME
          // glyph the Options menu uses for MIDI-OUT / Visual Settings.
          row.classList.add('has-sub');
          // Sub rows may still advertise their current value (e.g.
          // Start Delay "-1.0s" / "Off") next to the arrow. Number()
          // guards against a stringified value crashing toFixed().
          if (typeof def.fmt === 'function') {
            try { valEl.textContent = def.fmt(Number(val) || 0); }
            catch (e) { valEl.textContent = L10n.t('off', 'Off'); }
          }
        } else if (def.type === 'color') {
          // Color drill-in row â€” small chip previewing the current color;
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
            valEl.textContent = L10n.t('opt_auto', 'Auto');
          }
} else if (def.type === 'action') {
          // One-shot action row (Export Log) — arrow glyph, no value text;
          // Enter / ArrowRight fires the action, never cycles a value.
          // def.noArrow (Clear Media) suppresses the '>' glyph.
          if (!def.noArrow) row.classList.add('has-sub');
        } else if (def.type === 'info') {
          // Read-only display row (preloaded media file name). The file name
          // sits on its OWN line below the "Media File" label, wrapping long
          // names instead of clipping.
          row.style.flexDirection = 'column';
          row.style.alignItems = 'flex-start';
          row.style.gap = '0.3rem';
          valEl.style.whiteSpace = 'normal';
          valEl.style.wordBreak = 'break-all';
          valEl.style.textAlign = 'left';
          valEl.style.marginLeft = '0';
          valEl.style.width = '100%';
          valEl.textContent = def.staticText
            ? L10n.t(def.l10nKey || def.key, def.staticText)
            : (_values.midi.mediaName || L10n.t('opt_none', 'None'));
        } else {
          valEl.textContent = formatValue(def, val);
        }

        row.appendChild(valEl);

        list.appendChild(row);
      }
    }

    // Synth group extra: the loaded-SoundFont list (a checkbox row per
    // imported bank) renders BELOW the schema rows. Own navigation â€”
    // LSK = Delete, OK = select, RSK = Move (â–²â–¼ reorder). The rows are
    // regular .setting-row elements, so group ArrowUp/Down wrap through

  }

  /**
   * Append the loaded-SoundFont checkbox rows under the Synth (midi) group.
   * Each row reflects a bank in Soundbank.getBanks(): ticked = the bank is
   * SELECTED and therefore plays (layered) when the soundbank engine is on.
   */
  function appendLoadedSfRows(list) {
    var banks = [];
    try {
      if (typeof Soundbank !== 'undefined' && Soundbank.getBanks) {
        banks = Soundbank.getBanks() || [];
      }
    } catch (e) {}

    var sep = document.createElement('div');
    sep.className = 'kai-separator';
    var st = document.createElement('span');
    st.className = 'kai-separator-text';
    st.textContent = L10n.t('sep_loaded_soundfonts', 'Loaded Soundfonts');
    sep.appendChild(st);
    list.appendChild(sep);

    if (!banks.length) {
      var noRow = document.createElement('div');
      noRow.className = 'setting-row';
      var noLbl = document.createElement('span');
      noLbl.className = 'setting-row-label';
      noLbl.textContent = L10n.t('no_soundfonts_loaded', 'No soundfonts loaded');
      noLbl.style.opacity = '0.5';
      noRow.appendChild(noLbl);
      list.appendChild(noRow);
      return;
    }

    for (var i = 0; i < banks.length; i++) {
      var b = banks[i];
      var row = document.createElement('div');
      row.className = 'setting-row sf-row';
      if (b.selected) row.classList.add('selected');
      row.setAttribute('tabindex', '-1');
      row.setAttribute('data-type', 'sfrow');
      row.setAttribute('data-id', String(b.id));

      var check = document.createElement('span');
      check.className = 'sf-check';
      if (b.selected) check.classList.add('selected');
      row.appendChild(check);

      var lbl = document.createElement('span');
      lbl.className = 'setting-row-label';
      lbl.textContent = b.name;
      if (b.path) lbl.title = b.path;
      row.appendChild(lbl);

      var val = document.createElement('span');
      val.className = 'setting-row-value';
      val.textContent = b.selected ? L10n.t('on', 'On') : L10n.t('off', 'Off');
      row.appendChild(val);

      list.appendChild(row);
      if (_sub && _sub.kind === 'sfsettings') {
        _sub.items.push({ type: 'sfrow', id: b.id, row: row });
      }
    }
  }

  // â”€â”€ Soundfont Settings page (Synth â†’ Soundfont Settings) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Buffer length + Voices are KaiUI-style numeric text boxes (.kai-text-input
  // â€” small gray label over a bordered input line): focus opens the native
  // keyboard, digits type into the box, Enter commits (clamped to range).
  // "Disable Soundfont effects" is a plain On/Off row grouped by separators.

  function buildSfSettingsPage(listEl) {
    var prevFocusIdx = (_sub && typeof _sub.focusIdx === 'number') ? _sub.focusIdx : 0;
    _sub.items = [];
    _sub.ui.boolRows = {};
    _sub.ui.text = null;

    function sepsis(text) {
      var s = document.createElement('div');
      s.className = 'kai-separator';
      var st = document.createElement('span');
      st.className = 'kai-separator-text';
      st.textContent = L10n.t('sep_' + text.toLowerCase().replace(/ /g, '_'), text);
      s.appendChild(st);
      listEl.appendChild(s);
    }

    // ── Load Soundfont action ──
    sepsis('SoundFont');
    addSfActionRow(listEl, 'loadSf', sfLoadLabel());

    // ── Audio ──
    sepsis('Audio');
    addSfTextRow(listEl, 'sfBuffer', 'Buffer length',
      'Planning buffer in samples (512\u20138192)', 512, 8192);
    addSfTextRow(listEl, 'sfVoices', 'Voices',
      'Max simultaneous notes (1\u2013256)', 1, 256);

    // ── Effects ──
    sepsis('Effects');
    addSfBoolRow(listEl, 'sfNoFx', 'Disable sound effects');

    // ── Loaded SoundFonts ──
    appendLoadedSfRows(listEl);

    _sub.focusIdx = Math.max(0, Math.min(prevFocusIdx, _sub.items.length - 1));
  }

  /** One numeric text box row (KaiUI kai-text-input layout). */
  function addSfTextRow(listEl, key, label, hint, min, max) {
    var w = document.createElement('div');
    w.className = 'kai-text-input';
    w.setAttribute('tabindex', '-1');
    w.setAttribute('data-type', 'sftext');
    w.setAttribute('data-key', key);

    var lab = document.createElement('label');
    lab.className = 'kai-text-input-label';
    lab.textContent = L10n.t(key === 'sfVoices' ? 'sf_voices' : 'sf_buffer_length', label);
    w.appendChild(lab);

    var input = document.createElement('input');
    input.className = 'kai-text-input-input';
    input.type = 'tel';
    input.value = String(_values.midi[key] != null ? _values.midi[key] :
                         (key === 'sfBuffer' ? 1024 : 32));
    w.appendChild(input);

    var hintEl = document.createElement('div');
    hintEl.className = 'kai-text-input-hint';
    hintEl.textContent = L10n.t(key === 'sfVoices' ? 'sf_voices_hint' : 'sf_buffer_hint', hint);
    w.appendChild(hintEl);


    listEl.appendChild(w);
    _sub.items.push({ type: 'sftext', part: key, row: w, input: input, min: min, max: max });
    _sub.ui[key] = { row: w, input: input };
    if (!_sub.ui.text) _sub.ui.text = { input: input };
    return { row: w, input: input };
  }

  /** On/Off row backed by a MIDI-group value (mirrors addSubRow bool). */
  function addSfBoolRow(listEl, key, label) {
    var r = document.createElement('div');
    r.className = 'setting-row';
    r.setAttribute('tabindex', '-1');
    r.setAttribute('data-type', 'bool');
    r.setAttribute('data-key', key);

    var lbl = document.createElement('span');
    lbl.className = 'setting-row-label';
    lbl.textContent = L10n.t(key, label);
    r.appendChild(lbl);

    var valEl = document.createElement('span');
    valEl.className = 'setting-row-value';
    valEl.textContent = _values.midi[key] ? L10n.t('on', 'On') : L10n.t('off', 'Off');
    r.appendChild(valEl);

    listEl.appendChild(r);
    _sub.items.push({ type: 'bool', part: key, key: key });
    _sub.ui.boolRows[key] = { row: r, valEl: valEl };
    return { row: r, valEl: valEl };
  }

  /** Drill-in action row inside Soundfont Settings (opens another sub-page). */
  function addSfActionRow(listEl, partKey, label) {
    var r = document.createElement('div');
    r.className = 'setting-row';
    r.classList.add('has-sub');
    r.setAttribute('tabindex', '-1');
    r.setAttribute('data-type', 'sfaction');
    r.setAttribute('data-key', partKey);

    var lbl = document.createElement('span');
    lbl.className = 'setting-row-label';
    lbl.textContent = label;
    r.appendChild(lbl);

    var valEl = document.createElement('span');
    valEl.className = 'setting-row-value';
    r.appendChild(valEl);

    listEl.appendChild(r);
    _sub.items.push({ type: 'sfaction', part: partKey, row: r });
    return { row: r };
  }

  /** Commit a text box: parse digits, clamp to its min/max, persist, and
   *  push voices into the running Soundbank engine. Blurs the field so the
   *  native keyboard closes (Enter / leaving the row / closing the page). */
  function sfCommitText(item) {
    if (!item || item.type !== 'sftext') return;
    if (item.input && document.activeElement === item.input) {
      try { item.input.blur(); } catch (e) {}
    }
    var raw = item.input ? item.input.value : '';
    var n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    if (isNaN(n)) n = (item.part === 'sfBuffer') ? 1024 : 32;
    n = Math.max(item.min, Math.min(item.max, n));
    if (item.input) item.input.value = String(n);
    if (_values.midi[item.part] === n) return;
    _values.midi[item.part] = n;
    Store.setState(_mapToStore('midi', item.part, n));
    save();
    if (item.part === 'sfVoices' && typeof Soundbank !== 'undefined' &&
        Soundbank.setVoices) {
      try { Soundbank.setVoices(n); } catch (e) {}
    }
    if (typeof window.showToast === 'function') {
      showToast((item.part === 'sfVoices' ? L10n.t('toast_voices', 'Voices: ') : L10n.t('toast_buffer', 'Buffer: ')) + n);
    }
  }

  /** â—€â–¶ on a focused text box: step the caret (typed digits still land
   *  natively â€” controls.js only blocks Back/Enter on text fields). */
  function sfCaretStep(item, dir) {
    if (!item || (item.type !== 'sftext' && item.type !== 'gentext' && item.type !== 'gfxtext') || !item.input) return;
    var input = item.input;
    var pos = input.selectionStart != null ? input.selectionStart : input.value.length;
    pos += dir;
    if (pos < 0) pos = 0;
    if (pos > input.value.length) pos = input.value.length;
    try { input.setSelectionRange(pos, pos); } catch (e) {}
  }

  // ——— Loaded-SoundFont list navigation (Synth group rows) ———————————

  function sfRowFor(row) {
    return !!(row && row.getAttribute && row.getAttribute('data-type') === 'sfrow');
  }
  function sfRowId(row) {
    return row ? row.getAttribute('data-id') : null;
  }
  function _sfBankIndexById(id) {
    if (typeof Soundbank === 'undefined' || !Soundbank.getBanks) return -1;
    var banks;
    try { banks = Soundbank.getBanks(); } catch (e) { return -1; }
    for (var i = 0; i < banks.length; i++) if (String(banks[i].id) === String(id)) return i;
    return -1;
  }
  function _rebuildGroupRows() {
    var parent = document.getElementById('settings-overlay');
    if (!parent || !_openGroup) return;
    rebuildRows(parent, _openGroup);
    var rows = parent.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
    if (rows.length) focusRow(rows, Math.min(_focusIdx, rows.length - 1));
  }

  /** OK on a loaded-SoundFont row: toggle its layering selection. */
  function toggleSfRow(id) {
    if (typeof Soundbank === 'undefined' || !Soundbank.toggleSelect) return;
    try { Soundbank.toggleSelect(id); } catch (e) { return; }
    
    if (_sub && _sub.kind === 'sfsettings') {
      var listEl = document.getElementById('subsettings-list');
      if (listEl) {
        var oldIdx = _sub.focusIdx;
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        buildSfSettingsPage(listEl);
        _sub.focusIdx = Math.min(oldIdx, Math.max(0, _sub.items.length - 1));
        paintSubFocus();
      }
    } else {
      _rebuildGroupRows();
    }
    
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function openSfDeleteConfirm(focusedRow) {
    var banks = (typeof Soundbank !== 'undefined' && Soundbank.getBanks) ? Soundbank.getBanks() : [];
    var focusId = focusedRow ? sfRowId(focusedRow) : null;
    var target = focusId ? [focusId] : (banks.length ? [banks[0].id] : []);
    if (!target.length) {
      if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_no_sf_to_delete', 'No soundfont to delete'));
      return;
    }
    _sfDeleteTargets = target;
    var ov = document.getElementById('sf-delete-dialog');
    if (ov) ov.classList.remove('hidden');
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function hideSfDeleteConfirm() {
    _sfDeleteTargets = null;
    var ov = document.getElementById('sf-delete-dialog');
    if (ov) ov.classList.add('hidden');
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function doSfDelete() {
    var targets = _sfDeleteTargets;
    hideSfDeleteConfirm();
    if (!targets || !targets.length) return;
    targets.forEach(function (id) {
      try { if (Soundbank.removeBank) Soundbank.removeBank(id); } catch (e) {}
    });
    // If the rows are in the sub-page, rebuild it; otherwise rebuild the root group
    if (_sub && _sub.kind === 'sfsettings') {
      var listEl = document.getElementById('subsettings-list');
      if (listEl) {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        buildSfSettingsPage(listEl);
        paintSubFocus();
      }
    } else {
      _rebuildGroupRows();
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_deleted', 'Deleted ') + targets.length + L10n.t('toast_soundfonts', ' soundfont(s)'));
  }

  var _sfPreMoveBankIds = null;

  function cancelSfMove() {
    if (!_sfMove) return;
    _sfMove = false;
    if (_sfPreMoveBankIds && typeof Soundbank !== 'undefined' && Soundbank.setBankOrder) {
      Soundbank.setBankOrder(_sfPreMoveBankIds);
    }
    _sfPreMoveBankIds = null;

    if (_sub && _sub.kind === 'sfsettings') {
      var listEl = document.getElementById('subsettings-list');
      if (listEl) {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        buildSfSettingsPage(listEl);
        paintSubFocus();
      }
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_move_cancelled', 'Move cancelled'));
  }

  function commitSfMove() {
    if (!_sfMove) return;
    _sfMove = false;
    _sfPreMoveBankIds = null;
    if (_sub && _sub.kind === 'sfsettings') {
      paintSubFocus();
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
    if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_arrangement_saved', 'Arrangement saved'));
  }

  /** LSK / RSK while a loaded-SoundFont row (or move mode) is active. */
  function handleSfSoftKey(key, row) {
    var isLeft = (key === 'SoftLeft' || key === Constants.KEY.SOFT_LEFT);
    var isRight = (key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT);
    if (!isLeft && !isRight) return false;
    // Sub-page handles its own sf keys now, so we only bypass if it's NOT sfsettings.
    if (_sub && _sub.kind !== 'sfsettings') return false; 
    
    // In sfsettings, we might pass a null row from handleSubKey. We can find it:
    if (_sub && _sub.kind === 'sfsettings' && !row) {
      row = _sub.items[_sub.focusIdx];
    }
    
    if (!row || !sfRowFor(row.row || row)) {
      if (_sfMove) cancelSfMove();
      return false;
    }
    if (isRight) {
      if (_sfMove) {
        cancelSfMove();
      } else {
        openSfDeleteConfirm(row.row || row);
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return true;
    }
    if (isLeft) {
      if (_sfMove) {
        commitSfMove();
      } else {
        _sfMove = true;
        var banks = (typeof Soundbank !== 'undefined' && Soundbank.getBanks) ? Soundbank.getBanks() : [];
        _sfPreMoveBankIds = banks.map(function (b) { return b.id; });
        paintSubFocus();
        if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_move_help', 'Move: \u25B2\u25BC to reorder, OK to save'));
      }
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      return true;
    }
    return true;
  }

  function formatValue(def, val) {
    if (def.type === 'action') return '';
    if (def.type === 'bool') return val ? L10n.t('on', 'On') : L10n.t('off', 'Off');
    if (def.type === 'enum') {
      for (var i = 0; i < def.choices.length; i++) {
        if (def.choices[i][0] === val) return L10n.t('opt_' + def.choices[i][0], def.choices[i][1]);
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
    var listEl = document.getElementById('settings-list');
    if (listEl) {
      if (_sfMove) listEl.classList.add('sf-move-mode');
      else listEl.classList.remove('sf-move-mode');
    }
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
    // Media Delay text box: selecting the row focuses its <input> directly
    // (same as the Visual General page) so digits type straight away.
    try {
      if (focused.getAttribute && focused.getAttribute('data-type') === 'medtext') {
        var _mi = focused.querySelector('input');
        if (_mi) { _mi.focus(); }
      }
    } catch (e) {}
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Keyboard navigation when overlay is open
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Commit the preload Media Delay text box: parse digits, clamp, persist.
   * Empty input keeps the last valid value; garbage resolves to 0.
   */
  function _medCommit() {
    var m = _medRow;
    if (!m || !m.input) return;
    if (document.activeElement === m.input) { try { m.input.blur(); } catch (e) {} }
    // Decimals with either '.' or ',' as the separator (e.g. "1.5" / "1,5").
    var raw = String(m.input.value).trim().replace(/,/g, '.').replace(/[^\d.]/g, '');
    var n = parseFloat(raw);
    if (!isFinite(n) || n < 0) {
      n = (_values.midi.mediaDelay != null && !isNaN(_values.midi.mediaDelay))
        ? _values.midi.mediaDelay : 0;
    }
    _values.midi.mediaDelay = n;
    m.input.value = String(n);
    Store.setState({ mediaDelay: n });
    save();
  }

  /**
   * Handle a key event while overlay is open. Returns true if consumed.
   * controls.js calls this BEFORE the menu path so settings wins priority.
   * A level-2 sub-page (range/color) intercepts all keys while open.
   */
  function handleKey(key) {
    if (!_openGroup) return false;

    // Level-2 page open â†’ it owns the keyboard until Back/SoftRight
    if (_sub) return handleSubKey(key);

    var overlay = document.getElementById('settings-overlay');
    if (!overlay) return false;
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
    if (!rows.length) return false;

    // Preload Media Delay text box editing: while its <input> is focused,
    // printable digits reach it natively (controls.js pass-through); these
    // keys behave like the Visual General box — Backspace deletes a digit
    // (empty → commit + exit), Enter/RSK commit + exit, and Up/Down commit
    // then fall through to the normal navigation below.
    if (_medRow && _medRow.input && document.activeElement === _medRow.input) {
      if (key === 'Backspace' || key === Constants.KEY.BACKSPACE) {
        var _medVal = String(_medRow.input.value || '');
        if (_medVal.length > 0) {
          _medRow.input.value = _medVal.slice(0, -1);
          return true;
        }
        _medCommit();
        try { _medRow.input.blur(); } catch (e) {}
        return true;
      }
      if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP ||
          key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
        _medCommit();
        try { _medRow.input.blur(); } catch (e) {}
        // fall through to the ArrowUp/Down handlers below (move away)
      } else if (key === Constants.KEY.ENTER || key === 13 || key === 'Enter' ||
                 key === Constants.KEY.SOFT_RIGHT || key === 'SoftRight') {
        _medCommit();
        try { _medRow.input.blur(); } catch (e) {}
        return true;
      }
    }

    // Back â†’ return to the group we drilled in from (Developer inside
    // System â†’ System; any hub page â†’ hub), else close.
    // ONLY the hardware Back key â€” LSK/RSK are forbidden.
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE) {
      if (_hubReturn && _openGroup !== 'hub') {
        switchBack();
        return true;
      }
      close();
      return true;
    }

    // SoftLeft / SoftRight with focus on a loaded-SoundFont row are NOT
    // forbidden â€” they run the row's own actions (Delete / Move).
    if (handleSfSoftKey(key, rows[_focusIdx])) return true;

    // Enter on a drill-in row opens its sub-page. Plain rows cycle
    // values with Left/Right only â€” Enter is intentionally inert.
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
      if (t === 'medtext') {
        // Focus the numeric text box — editing starts (digits reach the
        // input natively); Back/Enter/RSK commit and return to list nav.
        if (_medRow && _medRow.row === rowE && _medRow.input) {
          try { _medRow.input.focus(); _medRow.input.select(); } catch (e) {}
        }
        return true;
      }
      if (t === 'sfrow') {
        // Loaded-SoundFont row: Enter toggles layering, or â€” in Move
        // mode (RSK) â€” finishes the arrangement ("OK to finish").
        if (_sfMove) {
          _sfMove = false;
          if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        } else {
          toggleSfRow(sfRowId(rowE));
        }
        return true;
      }
      return true; // consumed but no-op for plain rows
    }

    // ArrowUp/Down: nav with WRAP-AROUND (bottom â†” top). In SoundFont
    // Move mode the arrows reorder the focused bank instead of moving
    // the cursor, and leaving the sf rows cancels move mode.
    if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) {
      if (_sfMove && sfRowFor(rows[_focusIdx])) { _sfMoveRows(rows[_focusIdx], -1); return true; }
      _focusIdx = (_focusIdx - 1 + rows.length) % rows.length;
      if (_sfMove && !sfRowFor(rows[_focusIdx])) {
        _sfMove = false;
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      }
      focusRow(rows, _focusIdx);
      return true;
    }
    if (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
      if (_sfMove && sfRowFor(rows[_focusIdx])) { _sfMoveRows(rows[_focusIdx], +1); return true; }
      _focusIdx = (_focusIdx + 1) % rows.length;
      if (_sfMove && !sfRowFor(rows[_focusIdx])) {
        _sfMove = false;
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      }
      focusRow(rows, _focusIdx);
      return true;
    }

    // ArrowRight â†’ drill-in on sub/color rows, otherwise cycle forward
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
      if (tR === 'medtext') {
        // Same as Enter: focus the Media Delay text box for editing.
        if (_medRow && _medRow.row === rowR && _medRow.input) {
          try { _medRow.input.focus(); _medRow.input.select(); } catch (e) {}
        }
        return true;
      }
      if (tR === 'sfrow') {
        if (_sfMove) { _sfMove = false; }
        else { toggleSfRow(sfRowId(rowR)); return true; }
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        return true;
      }
      cycleValue(rowR, +1);
      return true;
    }
    if (key === 'ArrowLeft' || key === Constants.KEY.ARROW_LEFT) {
      var rowL = rows[_focusIdx];
      if (rowL && rowL.getAttribute('data-type') === 'sfrow') {
        if (_sfMove) { _sfMove = false; }
        else { toggleSfRow(sfRowId(rowL)); return true; }
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
        return true;
      }
      cycleValue(rowL, -1);
      return true;
    }

    return false; // not consumed
  }

  function _sfMoveRows(row, dir) {
    var id = (row && typeof sfRowId === 'function') ? sfRowId(row) : null;
    if (!id && row && row.getAttribute) id = row.getAttribute('data-id');
    if (!id && _sub && _sub.items && _sub.items[_sub.focusIdx]) id = _sub.items[_sub.focusIdx].id;
    if (!id) return;
    var banks = (typeof Soundbank !== 'undefined' && Soundbank.getBanks) ? Soundbank.getBanks() : [];
    var idx = -1;
    for (var i = 0; i < banks.length; i++) {
      if (String(banks[i].id) === String(id)) { idx = i; break; }
    }
    if (idx < 0) return;
    var nBanks = banks.length;
    if (nBanks <= 1) return;
    var targetIdx = ((idx + dir) % nBanks + nBanks) % nBanks;

    if (typeof Soundbank !== 'undefined' && Soundbank.moveBank) {
      Soundbank.moveBank(idx, targetIdx);
    }

    if (_sub && _sub.kind === 'sfsettings') {
      var listEl = document.getElementById('subsettings-list');
      if (listEl) {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        buildSfSettingsPage(listEl);
        // Find new focusIdx for the moved bank
        for (var j = 0; j < _sub.items.length; j++) {
          if (_sub.items[j].type === 'sfrow' && String(_sub.items[j].id) === String(id)) {
            _sub.focusIdx = j;
            break;
          }
        }
        paintSubFocus();
      }
    } else {
      _rebuildGroupRows();
      var overlay = document.getElementById('settings-overlay');
      if (!overlay) return;
      var rows2 = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
      for (var k = 0; k < rows2.length; k++) {
        if (sfRowFor(rows2[k]) && sfRowId(rows2[k]) === String(id)) {
          focusRow(rows2, k);
          break;
        }
      }
    }
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
        // Note Color Palette Randomise â€” locked until a real file is loaded
        // (demo active or finished but no file yet). Mirrors Key 4 / the old
        // Options menu item.
        try {
          if (typeof window.isPlaybackLocked === 'function' && window.isPlaybackLocked()) {
            if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_locked', 'Locked until a file loads'));
            return;
          }
        } catch (e) {}
        if (typeof Notes !== 'undefined' && Notes.randomizePalette) {
          Notes.randomizePalette();
          if (typeof HUD !== 'undefined' && HUD.showOsd) HUD.showOsd(L10n.t('osd_colors_randomised', 'Track colors randomised'), 2000);
        }
      }
      else if (k === 'exportLog') {
        if (typeof window.pfaStorageGranted === 'function' && !window.pfaStorageGranted()) {
          // Explicit user action â€” always respond with the grant path
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
      else if (k === 'mediaLoad' && typeof window.launchMediaPicker === 'function') window.launchMediaPicker();
      else if (k === 'mediaClear') openMediaClearConfirm();
      else if (k === 'cancelAnalysis' && typeof window.cancelAnalyze === 'function') window.cancelAnalyze();
      else if (k === 'clearMidi' && typeof window.clearMidiAction === 'function') window.clearMidiAction();
      else if (k === 'fullscreen' && typeof window.toggleFullscreen === 'function') window.toggleFullscreen();
      else if (k === 'rotate' && typeof window.rotateScreen === 'function') window.rotateScreen();
      else if (k === 'volume' && typeof window.showOSDVolume === 'function') window.showOSDVolume();
      else if (k === 'exportSettings' && typeof window.pfaExportSettings === 'function') window.pfaExportSettings();
      else if (k === 'importSettings' && typeof window.pfaImportSettings === 'function') window.pfaImportSettings();
    } catch (e) {
      // Never leave an explicit action unresponsive.
      try {
        if (typeof window.showDevDialog === 'function') window.showDevDialog(L10n.t('dev_action_failed', 'Action failed: ') + e);
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
        // White-key fill color changed â†’ rebuild the piano spritesheet
        if (typeof Keyboard !== 'undefined' && Keyboard.rebuild) {
          Keyboard.rebuild();
        }
      } else if (key === 'kbRange' || key === 'kbStart' || key === 'kbEnd') {
        // Range changed â†’ re-fit key width to the new visible window
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      } else if (key === 'pctBarVisible' || key === 'loadAnimated' || key === 'loadBarColor' ||
               key === 'pctColor' || key === 'pctAnalyze' || key === 'pctMerge') {
        // Loading-bar presentation changed â†’ live-apply while a parse runs.
        if (typeof window.applyParseBarStyle === 'function') {
          try { window.applyParseBarStyle(); } catch (e) {}
        }
      } else if (key === 'dialogTextColor' || key === 'dialogBgColor') {
        // Center-pill colors changed â†’ re-apply to the pill.
        if (typeof window.applyDialogStyle === 'function') {
          try { window.applyDialogStyle(); } catch (e) {}
        }
      }
      // pianoSize needs no hook â€” renderers read Keyboard.height() per frame
    }
    if (group === 'midi' && key === 'engine' && next === 'soundbank') {
      if (typeof window !== 'undefined' && window.Soundbank && !Soundbank.isReady()) {
        var entries = (typeof Soundbank.readRegistry === 'function') ? Soundbank.readRegistry() : [];
        if (entries && entries.length > 0) {
          if (typeof startBootSfLoading === 'function') {
            startBootSfLoading(function (onProgress, onDone) {
              Soundbank.restore(onProgress).then(onDone).catch(onDone);
            });
          } else {
            Soundbank.restore();
          }
        } else {
          if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_no_sf_loaded', 'No soundfont loaded'));
        }
      }
    }
    // Engine row: show/hide the Soundfont Settings row immediately (it only
    // exists while the engine is 'soundbank') â€” re-render the group in place.
    // Engine row: show/hide the Soundfont Settings row immediately (it only
    // exists while the engine is 'soundbank') — re-render the group in place.
    if ((group === 'midi' && key === 'engine' && !_sub) ||
        (group === 'midi' && key === 'synthEngine' && !_sub)) {
      _medRow = null;
      var ovE = document.getElementById('settings-overlay');
      if (ovE && !ovE.classList.contains('hidden')) {
        rebuildRows(ovE, 'midi');
        var rowsE = ovE.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
        if (rowsE.length) focusRow(rowsE, Math.min(_focusIdx, rowsE.length - 1));
        if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      }
    }
    // Voices change â†’ live-apply the polyphony cap to the soundbank engine.
    if (group === 'midi' && key === 'sfVoices' &&
        typeof Soundbank !== 'undefined' && Soundbank.setVoices) {
      try { Soundbank.setVoices(next); } catch (e) {}
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
      if (typeof window.showToast === 'function') {
        setTimeout(function () {
          try { showToast(next ? L10n.t('toast_applied_next_launch', 'Applied on next launch') : L10n.t('toast_off_next_launch', 'Off from next launch')); } catch (e) {}
        }, 0);
      }
    }

    if (key === 'focusColor') {
      applyFocusColor(next);
    }

    // Persist
    save();
  }

  function _mapToStore(group, key, val) {
    if (group === 'midi') {
      if (key === 'engine')       return { engine: val };
      if (key === 'synthEngine')  return { synthEngine: val };
      if (key === 'mediaName')    return { mediaName: val };
      if (key === 'mediaSrc')     return { mediaSrc: val };
      if (key === 'mediaDelay')   return { mediaDelay: val };
      if (key === 'waveform')     return { waveform: val };
      if (key === 'audio')        return { audio: val };
      if (key === 'skipSlowOpen') return { skipSlowOpen: val };
      if (key === 'sfBuffer')     return { sfBuffer: val };
      if (key === 'sfVoices')     return { sfVoices: val };
      if (key === 'sfNoFx')       return { sfNoFx: val };
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
      if (key === 'view3dFallOpacity') return { view3dFallOpacity: val };
      if (key === 'view3dKeyGlow') return { view3dKeyGlow: val };
      if (key === 'view3dGlowColor') return { view3dGlowColor: val };
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
        if (key === 'verboseSfLoad') return { verboseSfLoad: val };
      if (key === 'verboseInit')    return { verboseInit: val, verboseLoadLog: val };
      if (key === 'verboseLoadLog') return { verboseInit: val, verboseLoadLog: val };
    } else if (group === 'sys') {
      if (key === 'autoFullscreen') return { autoFullscreen: val };
      if (key === 'autoRotate')     return { autoRotate: val };
      if (key === 'autoLang')       return { autoLang: val };
      if (key === 'language')       return { language: val };
      if (key === 'focusColor')     return { focusColor: val };
    }
    if (key === 'focusColor') return { focusColor: val };
    return {};
  }

  // â”€â”€ Visual theme application â”€â”€

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

    // Master gate off â†’ hide the entire card (not just each stat).
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Internals
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
   * Set the master Audio On/Off (Synth → Audio Output) from OUTSIDE the
   * settings UI — used by the piano RSK audio toggle so the persisted value
   * and the "Audio Output" row stay in sync with the runtime toggle.
   */
  function setAudio(on) {
    var next = !!on;
    _values.midi.audio = next;
    Store.setState(_mapToStore('midi', 'audio', next));
    save();
  }

  /** Set the preload media file (name for display + src for playback).
   *  SESSION-ONLY: never persisted — a fresh "Load Media" on next launch.
   *  Only the Media Delay value survives a restart. */
  function setMedia(name, src) {
    _values.midi.mediaName = name || '';
    _values.midi.mediaSrc = src || '';
    Store.setState({ mediaName: _values.midi.mediaName, mediaSrc: _values.midi.mediaSrc });
  }

  /** Unload the preload media ("Clear Media" row): drop name/src, release the
   *  blob in main.js and re-render the rows so only "Load Media" remains.
   *  SESSION-ONLY like setMedia — nothing to persist. */
  function clearMedia() {
    _values.midi.mediaName = '';
    _values.midi.mediaSrc = '';
    _medRow = null;
    Store.setState({ mediaName: '', mediaSrc: '' });
    if (typeof window.pfaReleaseMedia === 'function') {
      try { window.pfaReleaseMedia(); } catch (e) {}
    }
    refreshMidiGroup();
  }

  // ── "Clear Media" confirm dialog ──
  // Modal asking before unloading the preload media. Follows the SoundFont
  // delete-confirm pattern: settings.js owns the state and controls.js hooks
  // the softkeys (LSK = OK → doMediaClear, RSK/Back = cancel).
  var _mediaClearOpen = false;
  function openMediaClearConfirm() {
    _mediaClearOpen = true;
    var ov = document.getElementById('media-clear-dialog');
    if (ov) ov.classList.remove('hidden');
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  function hideMediaClearConfirm() {
    _mediaClearOpen = false;
    var ov = document.getElementById('media-clear-dialog');
    if (ov) ov.classList.add('hidden');
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  function doMediaClear() {
    hideMediaClearConfirm();
    clearMedia();
    openMediaClearedConfirm();
  }

  // ── "Media cleared" acknowledgment dialog ──
  // Single centre-OK toast-style confirmation shown AFTER the media has been
  // unloaded. Same pattern as the SoundFont Load Done dialog.
  var _mediaClearedOpen = false;
  function openMediaClearedConfirm() {
    _mediaClearedOpen = true;
    var ov = document.getElementById('media-cleared-dialog');
    if (ov) ov.classList.remove('hidden');
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  function hideMediaClearedConfirm() {
    _mediaClearedOpen = false;
    var ov = document.getElementById('media-cleared-dialog');
    if (ov) ov.classList.add('hidden');
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }
  function isMediaClearedConfirmOpen() { return _mediaClearedOpen; }

  /**
   * Apply a Keyboard Range preset from outside the settings UI (hotkeys):
   * '88' | '128' | 'custom' â€” same path as the in-page Key Count row.
   */
  function setKbPreset(size) {
    applyKbPresetSize(size);
  }

  /**
   * Rebuild the currently-open group's rows in place (used when a
   * context-sensitive row's visibility changes â€” e.g. Cancel Analysis
   * appears/disappears when an analysis starts/finishes). Preserves focus.
   */
  function refreshCurrentRows() {
    if (_sub) return; // level-2 page open â€” backbone rows not visible
    var overlay = document.getElementById('settings-overlay');
    if (!overlay || overlay.classList.contains('hidden') || !_openGroup) return;
    if (_openGroup === 'hub') return;
    rebuildRows(overlay, _openGroup);
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
    if (rows.length) focusRow(rows, Math.min(_focusIdx, rows.length - 1));
  }

  /**
   * Refresh the Synth (midi) group rows in place — used after a preload
   * media file is picked so the Load → Change label and the file-name row
   * update live. Exposed as window.refreshSynthMediaRow for main.js.
   */
  function refreshMidiGroup() {
    if (_sub) return;
    var overlay = document.getElementById('settings-overlay');
    if (!overlay || overlay.classList.contains('hidden') || _openGroup !== 'midi') return;
    _medRow = null;
    rebuildRows(overlay, 'midi');
    var rows = overlay.querySelectorAll('.setting-row, .setting-row-slider, .kai-text-input');
    if (rows.length) focusRow(rows, Math.min(_focusIdx, rows.length - 1));
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  /**
   * Serialize the whole settings profile as the export payload for the
   * System â†’ Export Settings action. Stored as a `.note` (like the app's
   * own MIDI exports) but its content is GENERIC JSON â€” distingushed from a
   * binary MIDI `.note` by the leading `pfaSettings` marker on import.
   */
  function exportPayload() {
    return JSON.stringify({
      pfaSettings: 1,             // marker: this is a Settings config, not MIDI data
      version: 1,
      app: 'midiPlayer',
      saved: new Date().toISOString(),
      values: _values
    });
  }

  /**
   * Apply an imported settings profile (from the System â†’ Import Settings
   * picker). The caller has already validated shape + marker; this merges the
   * payload over the factory defaults, persists + re-pushes to Store, then
   * re-applies every runtime side effect (theme, info card, piano sprites,
   * soundfont engine, auto fullscreen/rotate) and refreshes the open list.
   * Returns true on success.
   */
  function applyImportedSettings(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.pfaSettings !== 1 || !parsed.values || typeof parsed.values !== 'object') {
      return false;
    }
    try {
      _values = merge(DEFAULTS, parsed.values);
      _values.__upgraded = true;
      save();
      load(); // re-push Store + re-apply theme / info card / palette / OSD
      if (typeof Keyboard !== 'undefined' && Keyboard.rebuild) {
        try { Keyboard.rebuild(); } catch (e) {}
      }
      if (typeof Soundbank !== 'undefined' && Soundbank.setVoices &&
          _values.midi.sfVoices != null) {
        try { Soundbank.setVoices(_values.midi.sfVoices); } catch (e) {}
      }
      if (typeof window.applySystemSettings === 'function') {
        try { window.applySystemSettings(); } catch (e) {}
      }
      refreshCurrentRows();
      if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
      if (typeof window.showToast === 'function') window.showToast(L10n.t('toast_settings_imported', 'Settings imported'));
      return true;
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[Settings] applyImportedSettings failed', e);
      return false;
    }
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
    setAudio:       setAudio,
    setMedia:       setMedia,
    doMediaClear: doMediaClear,
    hideMediaClearConfirm: hideMediaClearConfirm,
    isMediaClearConfirmOpen: function () { return _mediaClearOpen; },
    hideMediaClearedConfirm: hideMediaClearedConfirm,
    isMediaClearedConfirmOpen: isMediaClearedConfirmOpen,
    setKbPreset:    setKbPreset,
    refreshCurrentRows: refreshCurrentRows,
    refreshMidiGroup:   refreshMidiGroup,
    exportPayload:      exportPayload,
    applyImportedSettings: applyImportedSettings,
    // Read-only helpers for controls.js softkeys: whether a sub-page is
    // open (+ which kind), SoundFont Move mode, and the scan page's
    // all-ticked state (drives the LSK All/Deselect label).
    subKind:        function () { return _sub ? _sub.kind : null; },
    // Language preference helpers for main.js (pre-boot pin + locale guard).
    savedLanguage:         savedLanguage,
    applyLanguagePreference: applyLanguagePreference,
    onLocaleChanged:       onLocaleChanged,
    isMoveMode:     function () { return _sfMove; },
    sfAllChecked:   function () {
      if (!_sub || _sub.kind !== 'soundfonts') return false;
      var total = 0, checked = 0;
      for (var i = 0; i < _sub.items.length; i++) {
        if (_sub.items[i].type !== 'sfcheck') continue;
        total++;
        if (_sub.ui.selected[_sub.items[i].path]) checked++;
      }
      return total > 0 && checked === total;
    },
    isSfDeleteConfirmOpen: function () { return !!_sfDeleteTargets; },
    hideSfDeleteConfirm: hideSfDeleteConfirm,
    doSfDelete: doSfDelete,
    isSfDoneOpen: isSfDoneOpen,
    openSfDoneDialog: openSfDoneDialog,
    hideSfDoneDialog: hideSfDoneDialog,
    isSfLoading: isSfLoading,
    isSfLoadingCancelled: isSfLoadingCancelled,
    cancelSfLoading: cancelSfLoading,
    startBootSfLoading: startBootSfLoading
  };
})();

