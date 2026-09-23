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
  // Pre-roll offset (seconds): when non-zero the clock starts at
  // nowSec = -offset so the first notes enter from the TOP of the band and
  // nothing touches the bottom (or fires audio) until `offset` seconds in.
  // Used by the bundled demo (1s pre-roll); reset to 0 on every load().
  var _startOffsetSec = 0;
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
    // A streaming provider must quack fully (at + readyAt) — a plain RAM
    // array on a modern engine has Array.prototype.at but must NOT count.
    isStr = !!(notes && typeof notes.at === 'function' && typeof notes.readyAt === 'function');
    _seekPending = null; _resumeSeek = false;
    var _sso = (typeof Store !== 'undefined' && Store.getState) ? Store.getState().skipSlowOpen : true;
    Tempo.setMap(tempoList, division, _sso);
    cursor = 0; tick = 0; _killActiveVoices(); passedCount = 0; _ended = false; stopPlay();
    _startOffsetSec = 0;  // pre-roll is demo-only; cleared when any file loads
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
    playing = true; ctxBase = audioNow() + _startOffsetSec; tickStart = tick;
    _refireSounding();
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
  function fullStop() { _seekPending = null; _resumeSeek = false; stopPlay(); _killActiveVoices(); cursor = 0; tick = 0; passedCount = 0; _ended = false; }
  function isEnded() { return _ended; }

  // Kill every voice the sequencer thinks is out there. The synth pool holds
  // scheduled envelopes (up to whole-note durations), so merely clearing the
  // lists would let the old position's audio drone over the new one.
  function _killActiveVoices() {
    if (fireOff) {
      for (var i = 0; i < active.length; i++) {
        try { fireOff(active[i].note, active[i].channel); } catch (e) {}
      }
    }
    active = []; audioActive = [];
  }

  // After a silence (pause) or a re-time (speed change), voices for notes
  // still under the playhead are gone but their `fired` flags say otherwise.
  // Clear the flags so the catch-up pass reschedules them with fresh timing
  // (their visual noteOff still lands exactly, ending them on time).
  function _refireSounding() {
    var nowSec = Tempo.toSec(tick);
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      if (a.startSec <= nowSec + 0.05 && a.endSec > nowSec - 0.05) a.fired = false;
    }
  }

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
    stopPlay(); _killActiveVoices();
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
    stopPlay(); _killActiveVoices(); tick = tt;
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
                      startSec: ss, endSec: esSec, velocity: n.v,
                      fired: (delay <= 0.05 && fireOn) });
      }
      cursor++;
    }

    // Catch-up fire: a note first encountered beyond the 50ms window is
    // never revisited by the drain loop above, so it would sit unvoiced
    // forever (→ no audio). Once its start enters the imminent ±50ms
    // window, fire it here; respects the same per-pulse budget.
    if (fireOn) {
      for (var ci = 0; ci < active.length; ci++) {
        var ca = active[ci];
        // Window and scheduling are wall-clock: divide the musical offsets
        // by speed (at 2x a note 40ms out is only 20ms away, and its wall
        // duration is halved). Without this every catch-up fire at speed≠1
        // lands late/early and rings speed× too long/short.
        if (ca.fired || (ca.startSec - nowSec) / speed > 0.05) continue;
        if (auCnt >= AUDIO_PER_PULSE) break;
        fireOn(ca.note, ca.channel, ca.velocity,
               Math.max(0, (ca.startSec - nowSec) / speed),
               (ca.endSec - ca.startSec) / speed);
        ca.fired = true;
        auCnt++;
      }
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
      ctxBase = audioNow() + _startOffsetSec;
      // Envelopes scheduled under the old speed would ring too long/short
      // while the playhead moves at the new one — kill the sounding voices
      // and let the catch-up pass refire them with fresh delay/dur (each
      // visual noteOff still lands exactly, so only a ≤33ms re-attack
      // separates the old envelope from the new one).
      var nowSec = Tempo.toSec(tick);
      for (var i = 0; i < active.length; i++) {
        var a = active[i];
        if (a.startSec <= nowSec + 0.05 && a.endSec > nowSec - 0.05) {
          if (fireOff) { try { fireOff(a.note, a.channel); } catch (e) {} }
          a.fired = false;
        }
      }
    }
    speed = s;
  },
  setStartOffset: function(s){ _startOffsetSec = (isFinite(s) && s > 0) ? s : 0; },
    noteDown: function(fn){fireOn=fn;},
    noteUp: function(fn){fireOff=fn;},
    onEnd: function(fn){fireEnd=fn;},
    activeList: list, audioList: audioList, passed: passed, bpm: function(){return Tempo.bpm(tick);},
  };
})();