/**
 * sequencer.js — Playback engine.
 * All notes dispatched to synth (no rate cap — voice pool limits naturally).
 * 50ms pulse, 2s lookahead.
 */
var Sequencer = (function () {
  'use strict';

  var notes   = [];
  var isStr   = false;        // notes is a streaming provider (NoteStream .at)
  var cursor  = 0;
  var tick    = 0;
  var speed   = 1.0;
  var playing = false;
  var timer   = null;
  var ctxBase = 0;
  var tickStart = 0;
  var active  = [];   // visual list (LK lookahead)
  var audioActive = []; // keyboard/audio list (current notes only)
  var passedCount = 0;  // cumulative notes that have hit the band and moved on
  var _ended = false;   // true after natural song end (Play restarts from 0)
  var _seekPending = null;    // streaming provider seek window load
  var _resumeSeek  = false;   // play() was requested while a seek was pending

  var fireOn  = null;
  var fireOff = null;
  var fireEnd = null;

  var LK = 2.0;              // base lookahead
  var _baseLK = 2.0;
  var MAX_ACTIVE = 1180591620717411303424;

  // Wall-clock only — ctx.currentTime is frozen when AudioContext is suspended
  function audioNow() {
    return performance.now() / 1000;
  }

  function load(noteList, tempoList, division) {
    notes = noteList || [];
    isStr = !!(notes && typeof notes.at === 'function');
    _seekPending = null; _resumeSeek = false;
    Tempo.map = tempoList || [{ t: 0, u: 500000 }];
    Tempo.div = division || 480;
    cursor = 0; tick = 0; active = []; audioActive = []; passedCount = 0; _ended = false; stopPlay();
  }

  // Streaming provider: return a resolved note object for index i (must have
  // been made ready first — see readyAt below), else the in-RAM note.
  function nAt(i) {
    return isStr ? notes.at(i) : notes[i];
  }
  function streamReady(i) {
    return !isStr || notes.readyAt(i);
  }

  function _beginTimer() {
    playing = true; ctxBase = audioNow(); tickStart = tick;
    if (isStr && notes.prefetch) { try { notes.prefetch(cursor); } catch (e) {} }
    timer = setInterval(pulse, 33);
  }
  function startPlay() {
    if (!notes.length || playing) return;
    if (_ended) { _ended = false; cursor = 0; tick = 0; active = []; audioActive = []; passedCount = 0; }
    if (_seekPending) { _resumeSeek = true; return; }
    _beginTimer();
  }
  function stopPlay() { playing = false; if (timer) { clearInterval(timer); timer = null; } }
  function fullStop() { _seekPending = null; _resumeSeek = false; stopPlay(); cursor = 0; tick = 0; active = []; audioActive = []; passedCount = 0; _ended = false; }
  function isEnded() { return _ended; }

  function _finishSeek(idx) {
    cursor = (idx > 0) ? idx : 0;
    // Notes before the new cursor position have effectively "passed" — sync
    // the passed counter so the info card shows the correct count (and the
    // skipped-over notes aren't silently dropped from the tally).
    passedCount = Math.min(cursor, notes ? notes.length : cursor);
    _seekPending = null;
    if (_resumeSeek) { _resumeSeek = false; _beginTimer(); }
  }

  function seekDelta(ds) {
    stopPlay(); active = []; audioActive = [];
    var tps = Tempo.tps(tick); tick += ds * tps;
    if (tick < 0) tick = 0;
    if (isStr) {
      _seekPending = notes.prepare(tick).then(function (idx) { _finishSeek(idx); })
        .catch(function () { _finishSeek(0); });
      return;
    }
    cursor = 0;
    while (cursor < notes.length && notes[cursor].t < tick) cursor++;
    passedCount = Math.min(cursor, notes.length);
  }
  function jumpTo(tt) {
    stopPlay(); active = []; audioActive = []; tick = tt;
    if (tick < 0) tick = 0;
    if (isStr) {
      _seekPending = notes.prepare(tick).then(function (idx) { _finishSeek(idx); })
        .catch(function () { _finishSeek(0); });
      return;
    }
    cursor = 0;
    while (cursor < notes.length && notes[cursor].t < tick) cursor++;
    passedCount = Math.min(cursor, notes.length);
  }

  var _pls = 0;
  var AUDIO_PER_PULSE = 112; // leaves room for voice pool turnover

  function pulse() {
    if (!playing) return;

    _pls++;
    if (_pls % 20 === 0) { try { if (typeof Synth !== 'undefined' && Synth.zoo) Synth.zoo(); } catch(e) {} }
    // Streaming: keep the window around the cursor (and the next) loaded.
    if (isStr && notes.prefetch) { try { notes.prefetch(cursor); } catch (e) {} }

    // Sync LK voi trail setting de activeList luon du cho renderer
    try {
      var _tr = Store.getState().trail;
      if (typeof window.demoVisualValue === 'function') _tr = window.demoVisualValue('trail', _tr);
      LK = (isFinite(_tr) && _tr > 0) ? (_baseLK / _tr) : _baseLK;
      if (LK < 0.5) LK = 0.5;
      if (LK > 3)   LK = 3; // cap 3s - giam activeList size
    } catch(e) {}
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
      if (!streamReady(cursor)) break;   // next window still loading — retry next pulse
      var n = nAt(cursor);
      var ss = Tempo.toSec(n.t);
      if (ss > hor) break;
      var etk = n.t + n.d;
      var esSec = Tempo.toSec(etk);
      var delay = (ss - nowSec) / speed;
      var dur   = (esSec - ss) / speed;
      // When the pulse runs late the note may already be dead — count it as
      // passed immediately (it never renders, it already went by). Otherwise
      // push it so the renderer shows it and cleanup counts it as passed when
      // it expires. Never DROP notes: Passed must reach NC at song end.
      if (esSec < nowSec - 0.05) {
        passedCount++;
      } else {
        if (delay <= 0.05 && auCnt < AUDIO_PER_PULSE && fireOn) {
          fireOn(n.n, n.c, n.v, Math.max(0, delay), dur);
          auCnt++;
        }
        active.push({ note: n.n, channel: n.c, tick: n.t, endTick: etk,
                      startSec: ss, endSec: esSec, velocity: n.v });
      }
      cursor++;
    }

    // Cleanup: remove notes outside window [nowSec-0.5, nowSec+LK]
    for (var i = active.length - 1; i >= 0; i--) {
      var a = active[i];
      // Remove if note ended more than 0.5s ago OR starts after lookahead
      if (a.endSec < nowSec - 0.05 || a.startSec > hor) {
        if (a.endSec < nowSec - 0.05) passedCount++; // note already hit the band
        active.splice(i, 1);
      }
    }
    // Rebuild audioActive: notes currently playing + trail window
    // Keep notes for 0.5s after they end so keyboard stays lit
    audioActive = [];
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      if (a.startSec <= nowSec + 0.1 && a.endSec >= nowSec - 0.5) {
        audioActive.push(a);
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
    if (cursor >= notes.length && !active.length) {
      // Natural end: every note has been emitted/hit the band. Notes that were
      // pushed into `active` inside the lookahead and then pruned by
      // `startSec > hor` (cleanup above) are never re-counted there, so force
      // Passed up to the full track total so HUD shows Passed === NC at the end.
      _ended = true; passedCount = notes.length; audioActive = []; stopPlay(); if (fireEnd) fireEnd();
    }
  }

  function list() { return active; }
  function audioList() { return audioActive; }
  function passed() {
    // Clamp so Passed never exceeds the track's total (tail boundary artifacts /
    // duplicate-row edges can momentarily overcount; the user expects ≤ NC).
    return Math.min(passedCount, notes ? notes.length : passedCount);
  }

  return {
    load: load, play: startPlay, pause: stopPlay, stop: fullStop,
    seek: seekDelta, jumpTick: jumpTo,
    getTick: function(){return tick;},
    getTime: function(){return Tempo.toSec(tick);},
    isEnded: isEnded,
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
    activeList: list, audioList: audioList, passed: passed, bpm: function(){return Tempo.bpm(tick);},
  };
})();