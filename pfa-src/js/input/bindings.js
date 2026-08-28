/**
 * bindings.js — Populate Constants.KEY_MAP with action names
 * keyed by KaiOS key codes / softkey strings.
 *
 * Gameplay layout (piano screen):
 *   Enter / SoftRight → play / pause        SoftLeft → Options menu
 *   ArrowLeft  → seek back 1s               ArrowRight → seek forward 1s
 *   ArrowUp    → OS volume up               ArrowDown  → OS volume down
 *   Key 1      → playback speed -0.1x       Key 3      → playback speed +0.1x
 *   Key 0      → stop                       Key 7      → restart from t=0
 *   Star (*)   → speed x0.5                 Hash (#)   → speed x2
 */
(function () {
  'use strict';
  var K = Constants.KEY;

  Constants.KEY_MAP = {
    // D-pad — Left/Right seek ±1 second, Up/Down step the OS media volume
    [K.ENTER]:      'playPause',
    [K.ARROW_UP]:   'volumeUp',
    [K.ARROW_DOWN]: 'volumeDown',
    [K.ARROW_LEFT]: 'seekBack',
    [K.ARROW_RIGHT]: 'seekForward',

    // Soft keys
    [K.SOFT_LEFT]:  'menuOpen',
    [K.SOFT_RIGHT]: 'playPause',

    // Hardware keys (KaiOS)
    [K.END_CALL]:   'quitApp',
    [K.BACKSPACE]:   'back',       // physical Back button → keyCode 8

    // Numeric shortcuts
    [K.NUMBER_0]: 'stop',
    [K.NUMBER_1]: 'speedStepDown',   // −0.1x (was: volume down)
    [K.NUMBER_3]: 'speedStepUp',     // +0.1x (was: volume up)
    [K.NUMBER_7]: 'restart',

    // Speed — * slower, # faster
    [K.STAR]: 'speedDown',
    [K.HASH]:  'speedUp',
  };
})();