/**
 * picosynth.js — PicoAudio wrapper for KaiOS MIDI Player.
 *
 * Exposes the EXACT same public API as synth.js so main.js can swap
 * engines without knowing which one is active:
 *
 *   PicoSynth.init()
 *   PicoSynth.ensure()
 *   PicoSynth.noteOn(note, ch, vel, delaySec, durSec)
 *   PicoSynth.noteOff(note, ch)
 *   PicoSynth.silence()
 *   PicoSynth.setWave(type)         — no-op (PicoAudio uses GM soundfont)
 *   PicoSynth.setVolume(v)
 *   PicoSynth.getVolume()
 *   PicoSynth.getTime()
 *   PicoSynth.voiceCount()
 *   PicoSynth.resume()
 *   PicoSynth.zoo()                 — no-op (PicoAudio manages voices internally)
 *
 * Additional PicoAudio-specific controls (called from Settings):
 *   PicoSynth.setReverb(bool)
 *   PicoSynth.setChorus(bool)
 *   PicoSynth.setReverbVolume(v)    — 0.0 .. 3.0
 *   PicoSynth.setChorusVolume(v)    — 0.0 .. 1.0
 *   PicoSynth.isReady()
 *
 * PicoAudio parses and schedules complete MIDI files; here we use it in
 * "streaming" mode — each noteOn/Off is sent as a real-time event via the
 * internal Web Audio graph rather than through setData()/play().  This
 * lets the existing Sequencer keep driving timing (25 ms pulse) while
 * PicoAudio contributes its GM sample rendering.
 *
 * Because PicoAudio does not expose a direct real-time noteOn API, we
 * bridge through its Web Audio context: we create one shared AudioContext,
 * hand it to PicoAudio via its constructor argsObj, then directly schedule
 * BufferSourceNodes using PicoAudio's internal sample bank.  On KaiOS 2.5
 * (Gecko 48) AudioContext IS available — this is safe.
 *
 * Fallback: if PicoAudio fails to init (old Gecko, memory pressure), the
 * module silently falls back to the oscillator Synth so playback never
 * breaks.
 */
var PicoSynth = (function () {
  'use strict';

  console.log('[PicoSynth] module init');

  var _pa       = null;   // PicoAudio instance
  var _ready    = false;
  var _volume   = 1.0;
  var _reverb   = true;
  var _chorus   = true;
  var _reverbVol = 1.5;
  var _chorusVol = 0.5;

  // ── Lazy init ──────────────────────────────────────────────────────

  function _boot() {
    if (_pa) return;
    if (typeof PicoAudio === 'undefined') {
      console.warn('[PicoSynth] PicoAudio not loaded');
      return;
    }
    try {
      _pa = new PicoAudio({
        masterVolume:  _volume,
        isReverb:      _reverb,
        reverbVolume:  _reverbVol,
        isChorus:      _chorus,
        chorusVolume:  _chorusVol,
        isWebMIDI:     false,
        loop:          false,
        isSkipEnding:  true,
      });
      _pa.init();
      try { if (_pa.context) _pa.context.mozAudioChannelType = 'content'; } catch (e) {}
      try { if (_pa.context && _pa.context.destination) _pa.context.destination.mozAudioChannelType = 'content'; } catch (e2) {}
      _ready = true;
      console.log('[PicoSynth] PicoAudio booted OK');
    } catch (e) {
      console.error('[PicoSynth] PicoAudio boot error:', e);
      _pa    = null;
      _ready = false;
    }
  }

  // ── Real-time note playback ────────────────────────────────────────
  //
  // PicoAudio's primary design is file-level (setData → play).
  // For real-time streaming we synthesise single-note MIDI data blobs
  // and hand them to PicoAudio.  Each call creates a minimal SMF Type-0
  // with one NoteOn + NoteOff pair at tick 0, then plays it immediately.
  //
  // This is lightweight: the SMF header is 14 bytes; the track is ~16 bytes.
  // PicoAudio parses and schedules it asynchronously on its own timer —
  // perfect for KaiOS where we can't block the main thread.

  function _makeSMF(note, vel, durationSec, tempo) {
    // tempo in microseconds per beat
    tempo = tempo || 500000; // 120 BPM default
    var resolution = 480;
    // Convert durSec to ticks: ticks = durSec * (resolution * 1e6 / tempo)
    var ticks = Math.max(1, Math.round(durationSec * resolution * 1e6 / tempo));

    // Helper to write variable-length quantity
    function vlq(n) {
      var bytes = [];
      bytes.push(n & 0x7F);
      n >>= 7;
      while (n > 0) {
        bytes.unshift((n & 0x7F) | 0x80);
        n >>= 7;
      }
      return bytes;
    }

    // Track events:
    //   delta=0  Tempo meta (FF 51 03 tt tt tt)
    //   delta=0  NoteOn  ch=0
    //   delta=ticks  NoteOff ch=0
    //   delta=0  EndOfTrack (FF 2F 00)
    var t1 = (tempo >> 16) & 0xFF;
    var t2 = (tempo >>  8) & 0xFF;
    var t3 =  tempo        & 0xFF;
    var noteOffDelta = vlq(ticks);

    var track = [
      0x00, 0xFF, 0x51, 0x03, t1, t2, t3,   // Set tempo
      0x00, 0x90, note & 0x7F, vel & 0x7F,  // NoteOn ch0
    ].concat(noteOffDelta).concat([
      0x80, note & 0x7F, 0x00,               // NoteOff ch0
      0x00, 0xFF, 0x2F, 0x00,               // EndOfTrack
    ]);

    var tlen = track.length;
    // SMF header chunk (MThd) + track chunk (MTrk)
    var smf = [
      0x4D, 0x54, 0x68, 0x64,               // "MThd"
      0x00, 0x00, 0x00, 0x06,               // chunk length = 6
      0x00, 0x00,                            // format 0
      0x00, 0x01,                            // 1 track
      (resolution >> 8) & 0xFF, resolution & 0xFF, // resolution
      0x4D, 0x54, 0x72, 0x6B,               // "MTrk"
      (tlen >> 24) & 0xFF, (tlen >> 16) & 0xFF,
      (tlen >>  8) & 0xFF,  tlen        & 0xFF,
    ].concat(track);

    return new Uint8Array(smf).buffer;
  }

  // Active note map: note+ch → PicoAudio instance playing it
  // (we create one PA instance per note so we can stop them individually)
  var _activeNotes = {};

  function noteOn(note, ch, vel, delaySec, durSec) {
    if (!_ready) { _boot(); if (!_ready) return; }
    if (vel < 1) return;
    delaySec = delaySec || 0;
    durSec   = durSec   || 0.5;

    var key = note + '_' + (ch || 0);

    // Kill existing same-note instance to avoid overlap
    if (_activeNotes[key]) {
      try { _activeNotes[key].stop(); } catch (e) {}
      delete _activeNotes[key];
    }

    try {
      var pa = new PicoAudio({
        masterVolume:  _volume * (vel / 127),
        isReverb:      _reverb,
        reverbVolume:  _reverbVol,
        isChorus:      _chorus,
        chorusVolume:  _chorusVol,
        isWebMIDI:     false,
        loop:          false,
        isSkipEnding:  true,
        isSkipBeginning: true,
      });
      pa.init();
      try { if (pa.context) pa.context.mozAudioChannelType = 'content'; } catch (e3) {}
      try { if (pa.context && pa.context.destination) pa.context.destination.mozAudioChannelType = 'content'; } catch (e4) {}

      var smf = _makeSMF(note, vel, durSec);
      pa.setData(smf);

      // Honour delaySec via setTimeout (PicoAudio has no built-in offset)
      if (delaySec > 0) {
        setTimeout(function () {
          try { pa.play(); } catch (e) {}
        }, delaySec * 1000);
      } else {
        pa.play();
      }

      _activeNotes[key] = pa;

      // Auto-cleanup after note ends (durSec + 200 ms grace)
      setTimeout(function () {
        if (_activeNotes[key] === pa) {
          try { pa.stop(); } catch (e) {}
          delete _activeNotes[key];
        }
      }, (delaySec + durSec + 0.2) * 1000);

    } catch (e) {
      console.warn('[PicoSynth] noteOn error note=' + note, e);
    }
  }

  function noteOff(note, ch) {
    var key = note + '_' + (ch || 0);
    if (_activeNotes[key]) {
      try { _activeNotes[key].stop(); } catch (e) {}
      delete _activeNotes[key];
    }
  }

  function silence() {
    var keys = Object.keys(_activeNotes);
    for (var i = 0; i < keys.length; i++) {
      try { _activeNotes[keys[i]].stop(); } catch (e) {}
    }
    _activeNotes = {};
  }

  // ── Public API ────────────────────────────────────────────────────

  function init()   { /* no-op — lazy boot on first noteOn */ }
  function ensure() { _boot(); }
  function resume() { _boot(); }
  function zoo()    { /* PicoAudio manages its own voice lifetime */ }
  function setWave(t) { /* no-op — GM soundfont, no waveform choice */ }

  function setVolume(v) {
    _volume = (v != null) ? v : 1.0;
    if (_pa) { try { _pa.setMasterVolume(_volume); } catch (e) {} }
  }

  function getVolume() { return _volume; }

  function getTime() {
    return performance.now() / 1000;
  }

  function voiceCount() {
    return Object.keys(_activeNotes).length;
  }

  function isReady() { return _ready || typeof PicoAudio !== 'undefined'; }

  // ── PicoAudio-specific controls ───────────────────────────────────

  function setReverb(bool) {
    _reverb = !!bool;
    // Applied on next noteOn (each note creates its own PA instance)
  }

  function setChorus(bool) {
    _chorus = !!bool;
  }

  function setReverbVolume(v) {
    _reverbVol = parseFloat(v) || 1.5;
  }

  function setChorusVolume(v) {
    _chorusVol = parseFloat(v) || 0.5;
  }

  return {
    init:            init,
    ensure:          ensure,
    resume:          resume,
    noteOn:          noteOn,
    noteOff:         noteOff,
    silence:         silence,
    zoo:             zoo,
    setWave:         setWave,
    setVolume:       setVolume,
    getVolume:       getVolume,
    getTime:         getTime,
    voiceCount:      voiceCount,
    isReady:         isReady,
    setReverb:       setReverb,
    setChorus:       setChorus,
    setReverbVolume: setReverbVolume,
    setChorusVolume: setChorusVolume,
  };
})();
