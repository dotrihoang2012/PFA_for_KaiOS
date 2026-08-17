/**
 * sequencer.js — Playback engine.
 * All notes dispatched to synth (no rate cap — voice pool limits naturally).
 * 50ms pulse, 2s lookahead.
 */
var Sequencer = (function () {
  'use strict';

  var notes   = [];
  var cursor  = 0;
  var tick    = 0;
  var speed   = 1.0;
  var playing = false;
  var timer   = null;
  var ctxBase = 0;
  var tickStart = 0;
  var active  = [];   // visual list (LK lookahead)
  var audioActive = []; // keyboard/audio list (current notes only)

  var fireOn  = null;
  var fireOff = null;
  var fireEnd = null;

  var LK = 6.0;              // lookahead phải bằng VISUAL_LK trong notes.js
  var MAX_ACTIVE = 4096;

  // Wall-clock only — ctx.currentTime is frozen when AudioContext is suspended
  function audioNow() {
    return performance.now() / 1000;
  }

  function load(noteList, tempoList, division) {
    notes = noteList || [];
    Tempo.map = tempoList || [{ t: 0, u: 500000 }];
    Tempo.div = division || 480;
    cursor = 0; tick = 0; active = []; audioActive = []; stopPlay();
  }

  function startPlay() {
    if (!notes.length || playing) return;
    playing = true; ctxBase = audioNow(); tickStart = tick;
    timer = setInterval(pulse, 25);
  }
  function stopPlay() { playing = false; if (timer) { clearInterval(timer); timer = null; } }
  function fullStop() { stopPlay(); cursor = 0; tick = 0; active = []; audioActive = []; }

  function seekDelta(ds) {
    stopPlay(); active = []; audioActive = [];
    var tps = Tempo.tps(tick); tick += ds * tps;
    if (tick < 0) tick = 0;
    cursor = 0;
    while (cursor < notes.length && notes[cursor].t < tick) cursor++;
  }
  function jumpTo(tt) {
    stopPlay(); active = []; audioActive = []; tick = tt;
    if (tick < 0) tick = 0;
    cursor = 0;
    while (cursor < notes.length && notes[cursor].t < tick) cursor++;
  }

  var _pls = 0;
  var AUDIO_PER_PULSE = 112; // leaves room for voice pool turnover

  function pulse() {
    if (!playing) return;

    _pls++;
    if (_pls % 20 === 0) { try { if (typeof Synth !== 'undefined' && Synth.zoo) Synth.zoo(); } catch(e) {} }

    var ctxNow  = audioNow();
    var elapsed = (ctxNow - ctxBase) * speed;
    // toTick gives accurate tick from elapsed seconds, respecting all tempo changes
    tick = Tempo.toTick(Tempo.toSec(tickStart) + elapsed);
    var nowSec = Tempo.toSec(tick);
    var hor    = nowSec + LK;
    var esc = 0;
    var auCnt = 0;
    var ESC_MAX = 50000; // enough to fill 6s lookahead for normal MIDI
    while (cursor < notes.length && esc++ < ESC_MAX) {
      var n = notes[cursor];
      var ss = Tempo.toSec(n.t);
      if (ss > hor) break;
      var etk = n.t + n.d;
      var esSec = Tempo.toSec(etk);
      var delay = (ss - nowSec) / speed;
      var dur   = (esSec - ss) / speed;
      if (ss >= nowSec - 0.05) {
        if (delay <= 0.05 && auCnt < AUDIO_PER_PULSE && fireOn) {
          fireOn(n.n, n.c, n.v, Math.max(0, delay), dur);
          auCnt++;
        }
        if (active.length < MAX_ACTIVE) {
          active.push({ note: n.n, channel: n.c, tick: n.t, endTick: etk,
                        startSec: ss, endSec: esSec, velocity: n.v });
        }
      }
      cursor++;
    }

    // Cleanup: remove notes outside window [nowSec-0.5, nowSec+LK]
    for (var i = active.length - 1; i >= 0; i--) {
      var a = active[i];
      // Remove if note ended more than 0.5s ago OR starts after lookahead
      if (a.endSec < nowSec - 0.1 || a.startSec > hor) {
        active.splice(i, 1);
      }
    }
    // Rebuild audioActive: notes currently playing (keyboard highlight)
    // Deduplicate by note number to avoid double-counting same pitch
    audioActive = [];
    var _seen = {};
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      if (a.startSec <= nowSec + 0.05 && a.endSec >= nowSec - 0.05) {
        if (!_seen[a.note]) { _seen[a.note] = true; audioActive.push(a); }
      }
    }
    // Fire noteOff for notes that just ended
    if (fireOff) {
      for (var i = 0; i < active.length; i++) {
        if (active[i].endSec >= nowSec - 0.08 && active[i].endSec < nowSec) {
          fireOff(active[i].note, active[i].channel);
        }
      }
    }
    if (cursor >= notes.length && !active.length) { stopPlay(); if (fireEnd) fireEnd(); }
  }

  function list() { return active; }
  function audioList() { return audioActive; }

  return {
    load: load, play: startPlay, pause: stopPlay, stop: fullStop,
    seek: seekDelta, jumpTick: jumpTo,
    getTick: function(){return tick;},
    getTime: function(){return Tempo.toSec(tick);},
    isPlaying: function(){return playing;},
    setSpeed: function(s){
    // Recalibrate tick reference to avoid position jump on speed change
    if (playing && s !== speed) {
      tickStart = tick;
      ctxBase = audioNow();
    }
    speed = s;
  },
    noteDown: function(fn){fireOn=fn;},
    noteUp: function(fn){fireOff=fn;},
    onEnd: function(fn){fireEnd=fn;},
    activeList: list, audioList: audioList, bpm: function(){return Tempo.bpm(tick);},
  };
})();