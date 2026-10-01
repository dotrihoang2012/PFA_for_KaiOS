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
  // Active-entry pool: the drain pushes thousands of entries per pulse at
  // black-MIDI peaks (was a fresh object each → 200k allocs/s → GC storms
  // that stalled the whole browser). Pooled entries, same fields/order.
  var _apool = [];
  // Imminent-unfired list: catch-up used to scan ALL actives per pulse
  // (20k+ at peaks) for the few needing voices. Fused promotion keeps this
  // tiny (only notes within ~50ms of sounding, music time). Invariant:
  // every entry is also in `active` (pi = index here, -1 = out).
  var pending = [];
  var ffPending = false; // fast-forward prepare() in flight (streaming)
  var _ffGap = 0; // last behind-horizon gap (trend gate below)
  function pendDrop(e) {
    var i = e.pi;
    if (i < 0) return;
    var last = pending.pop();
    if (last !== e) { pending[i] = last; last.pi = i; }
    e.pi = -1;
  }
  var passedCount = 0;  // cumulative notes that have hit the band and moved on
  var _ended = false;   // true after natural song end (Play restarts from 0)
  var _seekPending = null;    // streaming provider seek window load
  var _resumeSeek  = false;   // play() was requested while a seek was pending

  var fireOn  = null;
  var fireOff = null;
  var fireEnd = null;

  var LK = 1.0;              // base lookahead (render needs 1/trail;
                             // holding 2x visible notes starved the CPU)
  var _baseLK = 1.0;
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
    if (_ended) { _ended = false; cursor = 0; tick = 0; active = []; audioActive = []; pending = []; passedCount = 0; }
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
    active = []; audioActive = []; pending = [];
  }

  // After a silence (pause) or a re-time (speed change), voices for notes
  // still under the playhead are gone but their `fired` flags say otherwise.
  // Clear the flags so the catch-up pass reschedules them with fresh timing
  // (their visual noteOff still lands exactly, ending them on time).
  function _refireSounding() {
    var nowSec = Tempo.toSec(tick);
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      if (a.startSec <= nowSec + 0.05 && a.endSec > nowSec - 0.05) {
        a.fired = false;
        if (a.pi < 0) { a.pi = pending.length; pending.push(a); }
      }
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
  // Maintenance throttle: above 8k actives the fused sweep runs every 2nd
  // pulse (66ms). Drain + catch-up stay every pulse so discovery/voicing
  // never stall. Below 6k it never engages — normal sections untouched.
  var _maintHalf = false; // maintenance (fused sweep) at 30Hz when swamped
  var AUDIO_PER_PULSE = 32; // visual-lag work: fewer schedules free main-
                             // thread for draws at peaks (audio differences
                             // there are inaudible mush; pool still voices).

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
      if (LK < 0.25) LK = 0.25; // floor covers render (1/trail) + 50ms audio
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
    var ESC_MAX = 8000; // per-pulse drain cap: must cover live intake up to
                          // ~240k/s (8k x 30) or the live window starves
                          // (blank fall + dark keys). Single pulses stay
                          // bounded; hopeless peaks rely on fast-forward.
    // Fast-forward: at ~1M notes/s even the cap can't keep the cursor on the
    // wall (8k/pulse << 33k/pulse intake) — it lags behind, and the drain
    // budget gets eaten walking dead backlog note-by-note while live notes
    // never get reached (a few stray bars + racing Passed). When behind,
    // jump the cursor over the dead backlog (binary jump, O(log n)) instead
    // of walking it (O(n) per pulse). Jumped notes count as passed (keeps
    // Passed/NPS honest; end-sync still forces exact full). TREND
    // gate: fire only when falling FURTHER behind (recovering gaps are left
    // alone — firing into a recovery visibly blinks the fall).
    if (cursor < notes.length && streamReady(cursor)) {
      var _ffss = Tempo.toSec(nAt(cursor).t);
      var _gap = hor - _ffss;
      if (_gap > 0.5 && _gap > _ffGap + 0.25) {
        _ffGap = _gap;
        var _fftick = Tempo.toTick(nowSec - 0.1);
        if (isStr) {
          if (!ffPending) {
            ffPending = true;
            notes.prepare(_fftick).then(function (idx) {
              ffPending = false;
              if (idx > cursor) {
                // Count the jumped backlog as passed (mostly long-dead; the
                // 0.1s grace voices normally). Keeps Passed/NPS honest.
                passedCount = Math.min(passedCount + (idx - cursor), notes.length);
                cursor = idx;
              }
            }).catch(function () { ffPending = false; });
          }
        } else {
          var _oldCur = cursor;
          var _lo = cursor, _hi = notes.length;
          while (_lo < _hi) {
            var _mid = (_lo + _hi) >> 1;
            if (notes[_mid].t < _fftick) _lo = _mid + 1; else _hi = _mid;
          }
          if (_lo > _oldCur) passedCount = Math.min(passedCount + (_lo - _oldCur), notes.length);
          cursor = _lo;
        }
      } else if (_gap < _ffGap) {
        _ffGap = _gap; // recovering: ratchet down, never fire into a recovery
      }
    }
    // Adaptive intake: behind the wall (>1s) → sprint bursts (32k) to refill
    // live walls (hitchy but complete); caught up → gentle 8k. (_gap is the
    // fast-forward tracker above; undefined until first computed → false.)
    if (_gap > 1.0) ESC_MAX = 32000;
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
        var willFire = false;
        if (delay <= 0.05 && auCnt < AUDIO_PER_PULSE && fireOn) {
          fireOn(n.n, n.c, n.v, Math.max(0, delay), dur);
          auCnt++; willFire = true;
        }
        var e = _apool.pop() || {};
        e.note = n.n; e.channel = n.c; e.tick = n.t; e.endTick = etk;
        e.startSec = ss; e.endSec = esSec; e.velocity = n.v;
        // Fired here, or promoted later when imminent — never silently
        // dropped (the old flag marked budget-cut notes fired-but-unvoiced).
        e.fired = willFire; e.pi = -1;
        active.push(e);
      }
      cursor++;
    }

    // Catch-up fire: notes the drain pushed early (or that lost the
    // per-pulse budget) get voiced once imminent. Iterates ONLY the tiny
    // pending list the fused pass maintains — never the whole active list.
    if (fireOn) {
      for (var ci = pending.length - 1; ci >= 0; ci--) {
        var ca = pending[ci];
        if (ca.fired) {
          var _lf = pending.pop();
          if (_lf !== ca) { pending[ci] = _lf; _lf.pi = ci; }
          ca.pi = -1; continue;
        }
        // Window and scheduling are wall-clock: divide the musical offsets
        // by speed (at 2x a note 40ms out is only 20ms away, and its wall
        // duration is halved). Without this every catch-up fire at speed≠1
        // lands late/early and rings speed× too long/short.
        if ((ca.startSec - nowSec) / speed > 0.05) continue;
        if (auCnt >= AUDIO_PER_PULSE) break;
        fireOn(ca.note, ca.channel, ca.velocity,
               Math.max(0, (ca.startSec - nowSec) / speed),
               (ca.endSec - ca.startSec) / speed);
        ca.fired = true; auCnt++;
        var _lv = pending.pop();
        if (_lv !== ca) { pending[ci] = _lv; _lv.pi = ci; }
        ca.pi = -1;
      }
    }

    // Maintenance throttle: above 8k actives the fused sweep (expiry, lit,
    // noteOff, promotion) runs every 2nd pulse (66ms). Drain + catch-up stay
    // every pulse so discovery and voicing never stall. Below 6k actives it
    // never engages — normal sections byte-identical.
    if (active.length > 8000) _maintHalf = true;
    else if (active.length < 6000) _maintHalf = false;
    if (!_maintHalf || ((_pls & 1) === 0)) {
    // Fused single pass (was cleanup + lit rebuild + noteOff scan = 3 full
    // sweeps per pulse over 55k+ actives): compact active in place, refill
    // the reused lit list, fire noteOffs. Same content/order/refs/notes.
    var w = 0;
    audioActive.length = 0;
    var immH = nowSec + 0.05 * speed; // imminent horizon, music time
    for (var i = 0; i < active.length; i++) {
      var a = active[i];
      if (a.endSec < nowSec - 0.05) { passedCount++; pendDrop(a); _apool.push(a); continue; } // hit the band
      if (a.startSec > hor) { pendDrop(a); _apool.push(a); continue; } // beyond lookahead: prune silently
      active[w++] = a;
      if (a.startSec <= nowSec + 0.1 && a.endSec >= nowSec - 0.5) audioActive.push(a);
      if (fireOff && a.endSec < nowSec && a.endSec >= nowSec - 0.08) fireOff(a.note, a.channel);
      // Promote unfired-imminent notes so catch-up stays tiny.
      if (!a.fired && a.pi < 0 && a.startSec <= immH) { a.pi = pending.length; pending.push(a); }
    }
    active.length = w;
    } // _maintHalf
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
          if (a.pi < 0) { a.pi = pending.length; pending.push(a); }
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