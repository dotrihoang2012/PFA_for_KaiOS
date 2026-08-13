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

    // Visual settings
    theme:        'dark',    // 'dark' | 'light' | 'blue' | 'purple'
    noteLabels:   false,     // draw C/D/E labels above white keys
    showFps:      true,
    pianoColor:   'white',   // 'white' | 'ivory' | 'ebony'

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