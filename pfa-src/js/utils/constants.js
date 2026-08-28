/**
 * constants.js — MIDI note names, frequencies, KaiOS key codes, layout values.
 */
var Constants = {

  /** MIDI note names (0–127) */
  NOTE_NAMES: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],

  /** Pre-computed black-key lookup (C=0, C#=1, D=2, … B=11) */
  _BLACK_KEY: [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0],

  /** Check if note (mod 12) is a black piano key — zero allocation */
  isBlackKey: function (m) {
    return this._BLACK_KEY[m % 12] === 1;
  },

  /** A4 = 69 = 440 Hz */
  A4_MIDI_NOTE: 69,
  A4_FREQ: 440,

  /** Convert MIDI note number → frequency (Hz), equal temperament */
  noteToFreq: function (note) {
    return this.A4_FREQ * Math.pow(2, (note - this.A4_MIDI_NOTE) / 12);
  },

  /** Get note name, e.g. 60 → "C4" */
  noteName: function (note) {
    if (note == null) return '';
    return this.NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
  },

  /** KaiOS physical key codes */
  KEY: {
    ENTER:        13,
    BACKSPACE:     8,

    ARROW_LEFT:   37,
    ARROW_UP:     38,
    ARROW_RIGHT:  39,
    ARROW_DOWN:   40,

    SOFT_LEFT:  'SoftLeft',
    SOFT_RIGHT: 'SoftRight',
    CALL:       'Call',
    END_CALL:   'EndCall',
    BACK:       'Back',

    NUMBER_0: 48,
    NUMBER_1: 49,
    NUMBER_2: 50,
    NUMBER_3: 51,
    NUMBER_4: 52,
    NUMBER_5: 53,
    NUMBER_6: 54,
    NUMBER_7: 55,
    NUMBER_8: 56,
    NUMBER_9: 57,

    STAR: 42,
    HASH: 35,
  },

  /** Mutable key→action mapping (filled by bindings.js) */
  KEY_MAP: {},

  /** Visual defaults */
  UI: {
    HEADER_H:       28,
    SOFTKEY_H:      24,
    KEY_W_MIN:       3,   // low so wide Keyboard Range windows still fit (auto-fit)
    KEY_W_MAX:     120,   // high so narrow ranges can still fill the full screen width
    KEY_W_DEFAULT:  16,
    DEFAULT_SPEED: 1.0,
    VOICE_LIMIT:    32,
    LOOKAHEAD_SEC:  10,
  }
};