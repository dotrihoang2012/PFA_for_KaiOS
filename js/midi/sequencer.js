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
  var active  = [];

  var fireOn  = null;
  var fireOff = null;
  var fireEnd = null;

  var LK = 2;
  var MAX_ACTIVE = 300;      // hard cap on active notes (reduced for KaiOS)

  // Wall-clock only — ctx.currentTime is frozen when AudioContext is suspended
  function audioNow() {
    return performance.now() / 1000;
  }

  function load(noteList, tempoList, division) {
    notes = noteList || [];
    Tempo.map = tempoList || [{ t: 0, u: 500000 }];
    Tempo.div = division || 480;
    cursor = 0; tick = 0; active = []; stopPlay();
  }

  function startPlay() {
    if (!notes.length || playing) return;
    playing = true; ctxBase = audioNow(); tickStart = tick;
    timer = setInterval(pulse, 80);
  }
  function stopPlay() { playing = false; if (timer) { clearInterval(timer); timer = null; } }
  function fullStop() { stopPlay(); cursor = 0; tick = 0; active = []; }

  function seekDelta(ds) {
    stopPlay(); active = [];
    var tps = Tempo.tps(tick); tick += ds * tps;
    if (tick < 0) tick = 0;
    cursor = 0;
    while (cursor < notes.length && notes[cursor].t < tick) cursor++;
  }
  function jumpTo(tt) {
    stopPlay(); active = []; tick = tt;
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

    var ctxNow = audioNow();
    tick = tickStart + (ctxNow - ctxBase) * speed * Tempo.tps(tick);
    var nowSec = Tempo.toSec(tick);
    var hor    = nowSec + LK;
    var esc = 0;
    var auCnt = 0;

    while (cursor < notes.length && esc < 30000) {
      esc++;
      var n = notes[cursor];
      var ss = Tempo.toSec(n.t);
      if (ss > hor) break;
      if (ss >= nowSec - 0.05) {
        var delay = (ss - nowSec) / speed;
        var dur   = (Tempo.toSec(n.t + n.d) - ss) / speed;
        var etk   = n.t + n.d;
        if (auCnt < AUDIO_PER_PULSE && fireOn) fireOn(n.n, n.c, n.v, delay, dur);
        auCnt++;
        if (active.length < MAX_ACTIVE) {
          active.push({
            note: n.n, channel: n.c, tick: n.t, endTick: etk,
            startSec: ss, endSec: Tempo.toSec(etk), velocity: n.v,
          });
        }
      }
      cursor++;
    }

    // cleanup
    for (var i = active.length - 1; i >= 0; i--) {
      if (active[i].endTick < tick) {
        if (fireOff) fireOff(active[i].note, active[i].channel);
        active.splice(i, 1);
      }
    }

    if (cursor >= notes.length && !active.length) { stopPlay(); if (fireEnd) fireEnd(); }
  }

  function list() { return active; }

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
    activeList: list, bpm: function(){return Tempo.bpm(tick);},
  };
})();