/**
 * settings.js — Settings sub-page renderer + persistence.
 *
 * Two groups of settings, both surfaced as overlays reachable from
 * the Options menu:
 *
 *   - MIDI Output   (sound engine, synthesizer, waveform, reverb,
 *                    chorus, reverb volume)
 *   - Visual        (render mode, speed, Note Trail,
 *                    note labels, Info Card Options, Keyboard Range,
 *                    Background/Bar/Piano Color, Piano Size)
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
      synthesizer:  'osc',     // 'osc' | 'pico' | 'wild'
      waveform:     'square',  // 'sine' | 'square' | 'saw' | 'triangle'
      reverb:       true,
      chorus:       true,
      reverbVolume: 1.5,       // 0.0 .. 3.0
    },
    visual: {
      renderMode:   'auto',    // 'auto' | 'individual' | 'heatmap' | 'buffer'
      speed:        1.0,       // 0.1 .. 8.0 (slider)
      trail:        1.0,       // Note Trail, 0.1 .. 8.0 (moved from MIDI group)
      theme:        'dark',    // 'dark' | 'light' | 'blue' | 'purple'
      noteLabels:   false,
      // Info card (HUD): master gate + per-stat switches
      infoCard:      true,
      infoNoteCount: true,
      infoSpeed:     true,
      infoTime:      true,
      infoFps:       true,
      kbStart:      21,        // Keyboard Range first visible MIDI note (A0)
      kbEnd:        108,       // Keyboard Range last visible MIDI note (C8)
      bgColor:      null,      // null = follow --theme-bg CSS token
      barColor:     '#00ccff', // separator line between notes band and piano
      pianoColorHex:'#f2f2f2', // white-key fill
      pianoSize:    'big',     // 'big' | 'small' | 'none'
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
      { key: 'engine',       label: 'Sound Engine',    type: 'enum',
        choices: [['synth','Synth'],['soundbank','Soundbank']] },
      { key: 'synthesizer',  label: 'Synthesizer',     type: 'enum',
        choices: [['osc','Oscillator'],['pico','PicoAudio'],['wild','WildWebMidi']] },
      { key: 'waveform',     label: 'Waveform',        type: 'enum',
        choices: [['sine','Sine'],['square','Square'],['saw','Saw'],['triangle','Triangle']] },
      { key: 'reverb',       label: 'Reverb',          type: 'bool' },
      { key: 'chorus',       label: 'Chorus',          type: 'bool' },
      { key: 'reverbVolume', label: 'Reverb Volume',   type: 'number',
        min: 0.0, max: 3.0, step: 0.1, fmt: function (v) { return v.toFixed(1); } },
    ],
    visual: [
      { key: 'renderMode', label: 'Render Mode',    type: 'enum',
        choices: [['auto','Auto'],['individual','Individual'],['heatmap','Heatmap'],['buffer','Buffer']] },
      { key: 'speed',      label: 'Speed',          type: 'number',
        min: 0.1, max: 8.0, step: 0.1, fmt: function (v) { return v.toFixed(1) + 'x'; } },
      { key: 'trail',      label: 'Note Trail',     type: 'number',
        min: 0.1, max: 8.0, step: 0.1, fmt: function (v) { return v.toFixed(1); } },
      { key: 'noteLabels', label: 'Show Note Labels',type: 'bool' },
      { key: 'infoCard',   label: 'Info Card Options', type: 'sub', subkind: 'bools' },
      { key: 'kbRange',       label: 'Keyboard Range',   type: 'sub' },
      { key: 'bgColor',       label: 'Background Color', type: 'color' },
      { key: 'barColor',      label: 'Bar Color',        type: 'color' },
      { key: 'pianoColorHex', label: 'Piano Color',      type: 'color' },
      { key: 'pianoSize',     label: 'Piano Size',       type: 'enum',
        choices: [['big','Big'],['small','Small'],['none','No Piano']] },
    ]
  };

  // ── Local state ──
  var _values = clone(DEFAULTS);
  var _openGroup = null;     // 'midi' | 'visual' | null
  var _focusIdx = 0;
  var _onCloseCb = null;     // notification when overlay closes

  // Level-2 sub-page state (null = none open):
  //   kind     : 'range' | 'color'
  //   key      : visual key driving the page ('kbRange'|'bgColor'|...)
  //   rgb      : working color {r,g,b,a} while a color page is open
  //   items    : flat focus model [{type:'def'|'swatch'|'slider', part?, idx?}]
  //   focusIdx : index into items
  var _sub = null;

  /** Number of swatch cells per visual row (flex-wrap column stride). */
  var SWATCH_COLS = 5;

  // ──────────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────────

  function load() {
    console.log('[Settings] load() invoked');
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          _values = merge(DEFAULTS, parsed);
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
      synthesizer:   _values.midi.synthesizer,
      reverb:        _values.midi.reverb,
      chorus:        _values.midi.chorus,
      reverbVolume:  _values.midi.reverbVolume,
      renderMode:    _values.visual.renderMode,
      speed:         _values.visual.speed,
      trail:         _values.visual.trail,
      theme:         _values.visual.theme,
      noteLabels:    _values.visual.noteLabels,
      infoCard:      _values.visual.infoCard,
      infoNoteCount: _values.visual.infoNoteCount,
      infoSpeed:     _values.visual.infoSpeed,
      infoTime:      _values.visual.infoTime,
      infoFps:       _values.visual.infoFps,
      kbStart:       _values.visual.kbStart,
      kbEnd:         _values.visual.kbEnd,
      bgColor:       _values.visual.bgColor,
      barColor:      _values.visual.barColor,
      pianoColorHex: _values.visual.pianoColorHex,
      pianoSize:     _values.visual.pianoSize,
    });
    applyTheme(_values.visual.theme);
    applyInfoCard();
    return _values;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_values));
    } catch (e) {
      console.warn('[Settings] persist failed:', e);
    }
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
    if (group !== 'midi' && group !== 'visual') {
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
    _onCloseCb = onClose || null;

    var overlay = document.getElementById('settings-overlay');
    if (!overlay) {
      console.error('[Settings] #settings-overlay missing');
      return;
    }
    var header = overlay.querySelector('header');
    if (header) {
      header.textContent = group === 'midi' ? 'MIDI-OUT Settings' : 'Visual Settings';
    }
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

  function close() {
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
      if (_onCloseCb) {
        var cb = _onCloseCb;
        _onCloseCb = null;
        try { cb(); } catch (e) {}
      }
    }
    if (typeof window.updateSoftkeys === 'function') window.updateSoftkeys();
  }

  function isOpen() { return !!_openGroup; }
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
   * @param kind 'range' | 'color'
   * @param key  visual settings key ('kbRange'|'bgColor'|'barColor'|'pianoColorHex')
   */
  function openSub(kind, key) {
    var overlay = document.getElementById('subsettings-overlay');
    if (!overlay) { console.error('[Settings] #subsettings-overlay missing'); return; }

    var list = overlay.querySelector('#subsettings-list');
    var header = overlay.querySelector('header');
    while (list && list.firstChild) list.removeChild(list.firstChild);

    _sub = { kind: kind, key: key, items: [], focusIdx: 0, ui: {}, rgb: null };

    var def = findDef(_openGroup, key);
    if (header) header.textContent = def ? def.label : 'Settings';

    if (kind === 'range') {
      // Two sliders — Start / End note — same visual style as Note Trail.
      var startV = _values.visual.kbStart;
      var endV   = _values.visual.kbEnd;
      _sub.ui.start = buildSubSliderRow(list, 'Start', 0, 127, 1, startV, noteFmt);
      _sub.ui.end   = buildSubSliderRow(list, 'End',   0, 127, 1, endV,   noteFmt);
      _sub.items.push({ type: 'slider', part: 'start' });
      _sub.items.push({ type: 'slider', part: 'end' });
    } else if (kind === 'bools') {
      // Boolean list page (Info Card Options). The MASTER show/hide gate
      // sits first; the four stat switches follow. Effective visibility
      // of a stat = infoCard AND its own switch.
      var bdefs = [
        { key: 'infoCard',      label: 'Show Info Card' },
        { key: 'infoNoteCount', label: 'Note Count' },
        { key: 'infoSpeed',     label: 'Speed' },
        { key: 'infoTime',      label: 'Time' },
        { key: 'infoFps',       label: 'FPS' }
      ];
      _sub.ui.boolRows = {};
      for (var bi = 0; bi < bdefs.length; bi++) {
        var bd = bdefs[bi];
        var bRow = document.createElement('div');
        bRow.className = 'setting-row';
        bRow.setAttribute('tabindex', '-1');

        var blbl = document.createElement('span');
        blbl.className = 'setting-row-label';
        blbl.textContent = bd.label;
        bRow.appendChild(blbl);

        var bVal = document.createElement('span');
        bVal.className = 'setting-row-value';
        bVal.textContent = _values.visual[bd.key] ? 'On' : 'Off';
        bRow.appendChild(bVal);

        list.appendChild(bRow);
        _sub.ui.boolRows[bd.key] = { row: bRow, valEl: bVal };
        _sub.items.push({ type: 'bool', part: bd.key });
      }
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

  /** Close the level-2 page and refresh parent group rows/chips. */
  function closeSub() {
    var overlay = document.getElementById('subsettings-overlay');
    if (overlay) overlay.classList.add('hidden');
    _sub = null;

    // Rebuild the parent group so color chips/hex labels show new values,
    // then restore focus onto the row we drilled in from.
    var parent = document.getElementById('settings-overlay');
    if (parent && _openGroup) {
      rebuildRows(parent, _openGroup);
      var rows = parent.querySelectorAll('.setting-row, .setting-row-slider');
      if (rows.length) {
        if (_focusIdx >= rows.length) _focusIdx = rows.length - 1;
        focusRow(rows, _focusIdx);
      }
    }
  }

  /** Highlight the focused sub-page item (+ scroll into view). */
  function paintSubFocus() {
    if (!_sub) return;
    var overlay = document.getElementById('subsettings-overlay');
    if (!overlay) return;

    var cells = overlay.querySelectorAll('.swatch');
    for (var i = 0; i < cells.length; i++) cells[i].classList.remove('focused');

    var rows = overlay.querySelectorAll('.setting-row-slider, .setting-row');
    for (var j = 0; j < rows.length; j++) rows[j].classList.remove('focused');

    var item = _sub.items[_sub.focusIdx];
    if (!item) return;

    if (item.type === 'bool') {
      var br = _sub.ui.boolRows && _sub.ui.boolRows[item.part];
      if (br && br.row) {
        br.row.classList.add('focused');
        try { br.row.scrollIntoView({ block: 'nearest' }); }
        catch (e) { try { br.row.scrollIntoView(false); } catch (e2) {} }
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

    if (item.type === 'bool') {
      // Left/Right toggles like Enter (no value scale to walk)
      toggleSubBool(item.part);
      return;
    }
    if (item.type === 'slider') {
      if (_sub.kind === 'range') {
        var cur = (item.part === 'start') ? _values.visual.kbStart : _values.visual.kbEnd;
        applyRangeValue(item.part, cur + dir);
      } else {
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
      toggleSubBool(item.part);
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
      save();
      updateSubPreview();
    }
  }

  /** Move sub-page focus by ±step with clamping. */
  function moveSubFocus(step) {
    if (!_sub) return;
    _sub.focusIdx = Math.max(0, Math.min(_sub.items.length - 1, _sub.focusIdx + step));
    paintSubFocus();
  }

  /**
   * Toggle one Info Card boolean (master gate or per-stat switch),
   * persist it and re-apply HUD visibility immediately.
   */
  function toggleSubBool(key) {
    if (!_sub || _sub.kind !== 'bools') return;
    var next = !_values.visual[key];
    _values.visual[key] = next;
    Store.setState(_mapToStore(_openGroup, key, next));
    save();
    applyInfoCard();
    var ref = _sub.ui.boolRows && _sub.ui.boolRows[key];
    if (ref && ref.valEl) ref.valEl.textContent = next ? 'On' : 'Off';
  }

  /**
   * Handle a key event while a level-2 page is open. Returns true when
   * consumed (always, except the guard case below).
   */
  function handleSubKey(key) {
    if (!_sub) return false;

    // Back / SoftRight → back to the group page
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
        key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT) {
      closeSub();
      return true;
    }

    // Vertical: swatches jump by grid columns, other rows step by one
    if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) {
      var itU = _sub.items[_sub.focusIdx];
      moveSubFocus(itU && itU.type === 'swatch' ? -SWATCH_COLS : -1);
      return true;
    }
    if (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
      var itD = _sub.items[_sub.focusIdx];
      moveSubFocus(itD && itD.type === 'swatch' ? +SWATCH_COLS : +1);
      return true;
    }

    if (key === 'ArrowLeft' || key === Constants.KEY.ARROW_LEFT) {
      adjustFocusedSub(-1);
      return true;
    }
    if (key === 'ArrowRight' || key === Constants.KEY.ARROW_RIGHT) {
      adjustFocusedSub(+1);
      return true;
    }

    // Enter activates the focused swatch/DEF cell
    if (key === Constants.KEY.ENTER || key === 13) {
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
    var vals = _values[group];
    for (var i = 0; i < schema.length; i++) {
      var def = schema[i];
      var val = vals[def.key];
      var row = document.createElement('div');
      row.setAttribute('tabindex', '-1');
      row.setAttribute('data-key', def.key);
      row.setAttribute('data-type', def.type);
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
        lbl.textContent = def.label;
        row.appendChild(lbl);

        var valEl = document.createElement('span');
        valEl.className = 'setting-row-value';

        if (def.type === 'sub') {
          // Drill-in row — forward arrow drawn by CSS via
          // .setting-row.has-sub::after (gaia-icons 'forward'), the SAME
          // glyph the Options menu uses for MIDI-OUT / Visual Settings.
          row.classList.add('has-sub');
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
        } else {
          valEl.textContent = formatValue(def, val);
        }

        row.appendChild(valEl);

        list.appendChild(row);
      }
    }
  }

  function formatValue(def, val) {
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

    // Back / SoftRight → close
    if (key === 'Backspace' || key === Constants.KEY.BACKSPACE ||
        key === 'SoftRight' || key === Constants.KEY.SOFT_RIGHT) {
      close();
      return true;
    }

    // Enter / SoftLeft on a drill-in row opens its sub-page. Plain rows
    // cycle values with Left/Right only — Enter is intentionally inert.
    if (key === Constants.KEY.ENTER || key === 13 ||
        key === Constants.KEY.SOFT_LEFT || key === 'SoftLeft') {
      var rowE = rows[_focusIdx];
      var t = rowE && rowE.getAttribute('data-type');
      if (t === 'sub') {
        openSub(rowE.getAttribute('data-subkind') || 'range',
                rowE.getAttribute('data-key'));
        return true;
      }
      if (t === 'color') {
        openSub('color', rowE.getAttribute('data-key'));
        return true;
      }
      return true; // consumed but no-op for plain rows
    }

    // ArrowUp/Down: nav
    if (key === 'ArrowUp' || key === Constants.KEY.ARROW_UP) {
      _focusIdx = Math.max(0, _focusIdx - 1);
      focusRow(rows, _focusIdx);
      return true;
    }
    if (key === 'ArrowDown' || key === Constants.KEY.ARROW_DOWN) {
      _focusIdx = Math.min(rows.length - 1, _focusIdx + 1);
      if (_focusIdx < 0) _focusIdx = 0;
      focusRow(rows, _focusIdx);
      return true;
    }

    // ArrowRight → drill-in on sub/color rows, otherwise cycle forward
    if (key === 'ArrowRight' || key === Constants.KEY.ARROW_RIGHT) {
      var rowR = rows[_focusIdx];
      var tR = rowR && rowR.getAttribute('data-type');
      if (tR === 'sub') {
        openSub(rowR.getAttribute('data-subkind') || 'range',
                rowR.getAttribute('data-key'));
        return true;
      }
      if (tR === 'color') { openSub('color', rowR.getAttribute('data-key')); return true; }
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
      }
      // pianoSize needs no hook — renderers read Keyboard.height() per frame
    }
    if (group === 'midi' && key === 'engine' && next === 'soundbank') {
      if (typeof window !== 'undefined' && window.Soundbank &&
          !Soundbank.isReady()) {
        if (typeof showToast === 'function') showToast('Soundbank not loaded');
      }
    }
    if (group === 'midi' && typeof PicoSynth !== 'undefined') {
      if (key === 'synthesizer') {
        if (next === 'pico') PicoSynth.ensure();
        if (next === 'wild' && typeof WildSynth !== 'undefined') WildSynth.ensure();
      }
      if (key === 'reverb')       PicoSynth.setReverb(next);
      if (key === 'chorus')       PicoSynth.setChorus(next);
      if (key === 'reverbVolume') PicoSynth.setReverbVolume(next);
    }

    // Persist
    save();
  }

  function _mapToStore(group, key, val) {
    if (group === 'midi') {
      if (key === 'engine')       return { engine: val };
      if (key === 'synthesizer')  return { synthesizer: val };
      if (key === 'waveform')     return { waveform: val };
      if (key === 'reverb')       return { reverb: val };
      if (key === 'chorus')       return { chorus: val };
      if (key === 'reverbVolume') return { reverbVolume: val };
    } else {
      if (key === 'renderMode')    return { renderMode: val };
      if (key === 'speed')         return { speed: val };
      if (key === 'trail')         return { trail: val };
      if (key === 'noteLabels')    return { noteLabels: val };
      if (key === 'infoCard')      return { infoCard: val };
      if (key === 'infoNoteCount') return { infoNoteCount: val };
      if (key === 'infoSpeed')     return { infoSpeed: val };
      if (key === 'infoTime')      return { infoTime: val };
      if (key === 'infoFps')       return { infoFps: val };
      if (key === 'kbStart')       return { kbStart: val };
      if (key === 'kbEnd')         return { kbEnd: val };
      if (key === 'kbRange')       return { kbStart: _values.visual.kbStart, kbEnd: _values.visual.kbEnd };
      if (key === 'bgColor')       return { bgColor: val };
      if (key === 'barColor')      return { barColor: val };
      if (key === 'pianoColorHex') return { pianoColorHex: val };
      if (key === 'pianoSize')     return { pianoSize: val };
    }
    return {};
  }

  // ── Visual theme application ──

  function applyTheme(theme) {
    // Set data-theme on <html>; CSS in app.css acts on each value.
    document.documentElement.setAttribute('data-theme', theme || 'dark');
  }

  /**
   * Apply Info Card visibility: each HUD stat shows only when the
   * master gate (infoCard) AND its own switch are both On.
   */
  function applyInfoCard() {
    var v = _values.visual;
    function gate(id, on) {
      var el = document.getElementById(id);
      if (!el) return;
      if (v.infoCard && on) el.classList.remove('hidden');
      else                  el.classList.add('hidden');
    }
    gate('hud-note-count', v.infoNoteCount);
    gate('hud-speed',      v.infoSpeed);
    gate('hud-time',       v.infoTime);
    gate('hud-fps',        v.infoFps);
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

  return {
    load:           load,
    save:           save,
    open:           open,
    close:          close,
    isOpen:         isOpen,
    openGroup:      openGroup,
    handleKey:      handleKey,
    applyTheme:     applyTheme,
    applyInfoCard:  applyInfoCard,
  };
})();
