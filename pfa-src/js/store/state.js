/**
 * state.js — Simple observable store for app-wide state.
 * No dependencies. Shallow-merge on setState().
 */
var Store = (function () {
  'use strict';

  var _state = {};
  var _listeners = [];

  var _initial = {
    // Playback
    play:     'stop',   // 'stop' | 'play' | 'pause'
    speed:    1.0,      // 0.25 … 4.0
    timeSec:  0,        // elapsed seconds

    // File (MIDI → JSON)
    fileName:  '',
    notes:     [],       // [{t, c, n, v, d}, …]
    tempoMap:  [{ t: 0, u: 500000 }],
    division:  480,
    format:    1,

    // Keyboard camera — which keys are visible
    keyWidth:  16,       // px per key (zoom)
    camKey:    48,       // leftmost visible MIDI note (0‥127)

    // Audio
    waveform:   'square',
    voiceLimit: 32,

    // MIDI Output settings (mirrored from localStorage by settings.js)
    engine:     'synth',     // 'synth' | 'soundbank'
    trail:      'medium',    // falling-note tail length

    // Keyboard range — the visible window of the piano strip.
    // kbStart = leftmost MIDI note drawn, kbEnd = rightmost (inclusive).
    // Standard 88-key piano defaults: A0 (21) .. C8 (108).
    kbStart: 21,
    kbEnd:   108,

    // Piano strip size: 'big' (60px) | 'small' (32px) | 'none' (hidden)
    pianoSize: 'big',

    // Custom colors. Hex ('#rrggbb'), rgba(...) string, or null.
    // bgColor null = fall back to the active --theme-bg CSS token.
    bgColor:       null,       // canvas background override
    barColor:      '#00ccff',  // separator/playhead line above the piano
    pianoColorHex: '#f2f2f2',  // white-key fill (replaces enum pianoColor)

    // Visual settings
    theme:        'dark',    // 'dark' | 'light' | 'blue' | 'purple'
    noteLabels:   false,     // draw C/D/E labels above white keys
    // Info card (HUD) toggles — master gate + per-stat switches
    infoCard:      true,
    infoNoteCount: true,
    infoSpeed:     true,
    infoTime:      true,
    infoFps:       true,

    // Playback helpers
    autoPlay:     false,   // start playing automatically after a MIDI load
    showDialog:   true,    // show "Analyzing MIDI…" / "Now playing" pills
    showOsd:      true,    // show the info-bar action OSD (+1 sec / 1.1x…)
    startDelay:    0,      // seconds to wait before playback (0 = Off, max 10)

    // Start Delay countdown (HUD time shows -0:05 → 0:00 while active)
    startCountdown: null,  // seconds remaining (null = inactive)
    cdRunning:      false, // true = ticking, false = held by pause

    // One-shot flag: the loader arms it so "Now playing: <file>" shows
    // exactly ONCE per loaded file (first play or Auto Play), never on
    // pause/resume. Cleared by whoever consumes the toast.
    npPending:    false,
    // (piano white-key color moved to pianoColorHex above)

    // Stats (r/o, updated by engine)
    activeNoteCount: 0,
    fps:              0,
    bpm:              120,

    // UI
    menu:        { open: false, focus: 0 },
    filePicker:  { open: false, focus: 0, files: [] },
  };

  /** Return current state ref (live — read only for subscribers). */
  function getState() { return _state; }

  /** Shallow-merge patch. Not notifies all subscribers. */
  function setState(patch) {
    if (!patch) return;
    for (var k in patch) {
      if (patch.hasOwnProperty(k)) _state[k] = patch[k];
    }
    notify();
  }

  /** Replace full state with with brand-new object. */
  function reset() {
    _state = shallowClone(_initial);
    notify();
  }

  function subscribe(fn) { _listeners.push(fn); }
  function unsubscribe(fn) {
    var i = _listeners.indexOf(fn);
    if (i >= 0) _listeners.splice(i, 1);
  }

  function notify() {
    for (var i = _listeners.length - 1; i >= 0; i--) {
      try { _listeners[i](_state); } catch (ignore) {}
    }
  }

  // — internal —
  function shallowClone(obj) {
    var out = {};
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) out[k] = obj[k];
    }
    return out;
  }

  // Auto-init
  _state = shallowClone(_initial);

  return {
    getState:    getState,
    setState:    setState,
    reset:       reset,
    subscribe:   subscribe,
    unsubscribe: unsubscribe,
  };
})();