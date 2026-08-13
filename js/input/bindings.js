/**
 * bindings.js — Populate Constants.KEY_MAP with action names
 * keyed by KaiOS key codes / softkey strings.
 */
(function () {
  'use strict';
  var K = Constants.KEY;

  Constants.KEY_MAP = {
    // D-pad
    [K.ENTER]:      'playPause',
    [K.ARROW_UP]:   'zoomDeeper',
    [K.ARROW_DOWN]: 'zoomWider',
    [K.ARROW_LEFT]: 'scrollLeft',
    [K.ARROW_RIGHT]: 'scrollRight',

    // Soft keys
    [K.SOFT_LEFT]:  'menuOpen',
    [K.SOFT_RIGHT]: 'playPause',

    // Hardware keys (KaiOS)
    [K.END_CALL]:   'quitApp',
    [K.BACKSPACE]:   'back',       // physical Back button → keyCode 8

    // Numeric shortcuts
    [K.NUMBER_0]: 'stop',
    [K.NUMBER_1]: 'volumeDown',
    [K.NUMBER_3]: 'volumeUp',
    [K.NUMBER_7]: 'restart',

    // Speed — * slower, # faster
    [K.STAR]: 'speedDown',
    [K.HASH]:  'speedUp',
  };
})();