/**
 * settings.js — Settings sub-page renderer + persistence.
 *
 * Two groups of settings, both surfaced as overlays reachable from
 * the Options menu:
 *
 *   - MIDI Output   (3 settings: sound engine, waveform, trail)
 *   - Visual        (4 settings: theme, note labels, fps, piano color)
 *
 * Persistence: localStorage.midiPlayer.settings = { midi:{...}, visual:{...} }
 * (per plan: avoids polluting Store's runtime state shape with persist-specific
 * fields; Store holds only the live values.)
 *
 * Navigation model — same as Options menu (see controls.js #38/#39):
 *   ArrowUp/Down → move focus
 *   Enter / SoftLeft / ArrowRight → cycle value forward
 *   ArrowLeft → cycle value backward
 *   Backspace / SoftRight → exit sub-page (closes overlay, reopens menu)
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
      trail:        1.0,       // 0.1 .. 8.0
      reverb:       true,
      chorus:       true,
      reverbVolume: 1.5,       // 0.0 .. 3.0
    },
    visual: {
      renderMode:   'auto',    // 'auto' | 'individual' | 'heatmap'
      speed:        1.0,      // 0.1 .. 8.0 (slider)
      theme:        'dark',    // 'dark' | 'light' | 'blue' | 'purple'
      noteLabels:   false,
      showFps:      true,
      pianoColor:   'white',   // 'white' | 'ivory' | 'ebony'
    }
  };

  // ── Schema for each group (label, key, type, choices/values, fmt) ──
  var SCHEMA = {
    midi: [
      { key: 'engine',       label: 'Sound Engine',    type: 'enum',
        choices: [['synth','Synth'],['soundbank','Soundbank']] },
      { key: 'synthesizer',  label: 'Synthesizer',     type: 'enum',
        choices: [['osc','Oscillator'],['pico','PicoAudio'],['wild','WildWebMidi']] },
      { key: 'waveform',     label: 'Waveform',        type: 'enum',
        choices: [['sine','Sine'],['square','Square'],['saw','Saw'],['triangle','Triangle']] },
      { key: 'trail',        label: 'Note Trail',      type: 'number',
        min: 0.1, max: 8.0, step: 0.1, fmt: function (v) { return v.toFixed(1); } },
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
      { key: 'theme',      label: 'Theme',          type: 'enum',
        choices: [['dark','Dark'],['light','Light'],['blue','Blue'],['purple','Purple']] },
      { key: 'noteLabels', label: 'Show Note Labels',type: 'bool' },
      { key: 'showFps',    label: 'Show FPS',        type: 'bool' },
      { key: 'pianoColor', label: 'Piano Color',     type: 'enum',
        choices: [['white','White'],['ivory','Ivory'],['ebony','Ebony']] },
    ]
  };

  // ── Local state ──
  var _values = clone(DEFAULTS);
  var _openGroup = null;     // 'midi' | 'visual' | null
  var _focusIdx = 0;
  var _onCloseCb = null;     // notification when overlay closes

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
        }
      } catch (e) {
        console.warn('[Settings] corrupt persist; using defaults', e);
      }
    }
    // Push current values into Store + DOM. Order matters: theme must set
    // first so subsequent visual changes read the right tokens.
    Store.setState({
      waveform:     _values.midi.waveform,
      trail:        _values.midi.trail,
      engine:       _values.midi.engine,
      synthesizer:  _values.midi.synthesizer,
      reverb:       _values.midi.reverb,
      chorus:       _values.midi.chorus,
      reverbVolume: _values.midi.reverbVolume,
      renderMode:   _values.visual.renderMode,
      speed:        _values.visual.speed,
      theme:      _values.visual.theme,
      noteLabels: _values.visual.noteLabels,
      showFps:    _values.visual.showFps,
      pianoColor: _values.visual.pianoColor,
    });
    applyTheme(_values.visual.theme);
    applyShowFps(_values.visual.showFps);
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
        valEl.textContent = formatValue(def, val);
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
   */
  function handleKey(key) {
    if (!_openGroup) return false;

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

    // ArrowRight → cycle forward (Left/Right only — Enter/SoftLeft intentionally ignored)
    if (key === 'ArrowRight' || key === Constants.KEY.ARROW_RIGHT) {
      cycleValue(rows[_focusIdx], +1);
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

    // Side-effects (applyTheme, applyShowFps, keyboard rebuild, etc.)
    if (group === 'visual') {
      if (key === 'theme') {
        applyTheme(next);
      } else if (key === 'showFps') {
        applyShowFps(next);
      } else if (key === 'pianoColor') {
        if (typeof Keyboard !== 'undefined' && Keyboard.rebuild) {
          Keyboard.rebuild();
        }
      }
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
      if (key === 'trail')        return { trail: val };
      if (key === 'reverb')       return { reverb: val };
      if (key === 'chorus')       return { chorus: val };
      if (key === 'reverbVolume') return { reverbVolume: val };
    } else {
      if (key === 'renderMode') return { renderMode: val };
      if (key === 'speed')      return { speed: val };
      if (key === 'theme')      return { theme: val };
      if (key === 'noteLabels') return { noteLabels: val };
      if (key === 'showFps')    return { showFps: val };
      if (key === 'pianoColor') return { pianoColor: val };
    }
    return {};
  }

  // ── Visual theme application ──

  function applyTheme(theme) {
    // Set data-theme on <html>; CSS in app.css acts on each value.
    document.documentElement.setAttribute('data-theme', theme || 'dark');
  }

  function applyShowFps(show) {
    var fps = document.getElementById('hud-fps');
    if (fps) {
      if (show) fps.classList.remove('hidden');
      else      fps.classList.add('hidden');
    }
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
    applyShowFps:   applyShowFps,
  };
})();
