/**
 * bindings.js — Populate Constants.KEY_MAP with action names
 * keyed by KaiOS key codes / softkey strings.
 *
 * Gameplay layout (piano screen):
 *   Enter / SoftRight → play / pause        SoftLeft → Options menu
 *   ArrowLeft  → seek back 1s               ArrowRight → seek forward 1s
 *   ArrowUp    → OS volume up               ArrowDown  → OS volume down
 *   Key 0      → stop                       Key 1 → speed +0.1x
 *   Key 2      → render mode                Key 3 → speed −0.1x
 *   Key 4      → rotate screen              Key 5 → load MIDI / note file
 *   Key 6      → full screen toggle
 *   Key 7      → key range 88 ↔ 128 keys    Key 8 → clear MIDI
 *   Key 9      → keyboard piano panel size  Call → show/hide info card
 *   Star (*)   → note trail -0.1            Hash (#) → note trail +0.1
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

    // Numeric shortcuts (keyCode)
    [K.NUMBER_0]: 'stop',
    [K.NUMBER_1]: 'speedStepUp',      // speed +0.1x
    [K.NUMBER_2]: 'cycleRenderMode',
    [K.NUMBER_3]: 'speedStepDown',    // speed −0.1x
    [K.NUMBER_4]: 'rotateScreen',
    [K.NUMBER_5]: 'loadMidi',
    [K.NUMBER_6]: 'toggleFullscreen',
    [K.NUMBER_7]: 'toggleKeyRange',   // 88 keys ↔ 128 keys
    [K.NUMBER_8]: 'clearMidi',
    [K.NUMBER_9]: 'cyclePianoSize',   // keyboard piano panel size
    [K.CALL]:     'toggleInfoCard',   // show / hide the HUD info card

    // Numeric shortcuts (e.key string forms) — some KaiOS builds report
    // keyCode 0 with only e.key populated for these hardware keys.
    '0': 'stop', '1': 'speedStepUp', '2': 'cycleRenderMode',
    '3': 'speedStepDown', '4': 'rotateScreen', '5': 'loadMidi',
    '6': 'toggleFullscreen', '7': 'toggleKeyRange', '8': 'clearMidi',
    '9': 'cyclePianoSize',

    // e.key string forms for the rest (zero-keyCode devices)
    'Enter': 'playPause', 'ArrowLeft': 'seekBack', 'ArrowRight': 'seekForward',
    'ArrowUp': 'volumeUp', 'ArrowDown': 'volumeDown',
    'EndCall': 'quitApp', 'Backspace': 'back', 'Back': 'back',

    // KaiOS physical volume rocker — hardware side buttons. KaiOS sends
    // keyCode 175 (VolumeUp) / 174 (VolumeDown) with e.key 'VolumeUp' /
    // 'VolumeDown' on the ROCker — NOT ArrowUp/Down (38/40). Map BOTH
    // the keyCode and the e.key string so adjustVolume(±1) fires and the
    // user sees the OSD STEP, not just the static slide.
    'VolumeUp':   'volumeUp',
    'VolumeDown': 'volumeDown',
    [K.VOLUME_UP]:   'volumeUp',
    [K.VOLUME_DOWN]: 'volumeDown',

    // Trail — * slower, # longer (note trail length ±0.1)
    [K.STAR]: 'trailDown',
    [K.HASH]:  'trailUp',
    // e.key string forms for star/hash on zero-keyCode devices
    '*': 'trailDown', 'Star': 'trailDown',
    '#': 'trailUp',   'Hash':  'trailUp',
  };
})();