var PfaPlatform = (function () {
  'use strict';

  function nav() {
    return (typeof navigator !== 'undefined') ? navigator : null;
  }

  function b2g() {
    var n = nav();
    return (n && n.b2g) ? n.b2g : null;
  }

  function getDeviceStorage(name) {
    var b = b2g();
    try {
      if (b && typeof b.getDeviceStorage === 'function') return b.getDeviceStorage(name);
      var n = nav();
      if (n && typeof n.getDeviceStorage === 'function') return n.getDeviceStorage(name);
    } catch (e) {}
    return null;
  }

  function getDeviceStorages(name) {
    var b = b2g();
    try {
      if (b && typeof b.getDeviceStorages === 'function') return b.getDeviceStorages(name) || [];
      var n = nav();
      if (n && typeof n.getDeviceStorages === 'function') return n.getDeviceStorages(name) || [];
    } catch (e) {}
    var one = getDeviceStorage(name);
    return one ? [one] : [];
  }

  function normalizeStoragePath(name, storage) {
    var p = String(name || '').replace(/^file:\/\/+/i, '');
    var vol = storage && storage.storageName;
    if (vol) {
      var vp = '/' + vol + '/';
      if (p.indexOf(vp) === 0) return p.substring(vp.length);
      var vr = vol + '/';
      if (p.indexOf(vr) === 0) return p.substring(vr.length);
    }
    p = p.replace(/^\/?(sdcard\d*|internal|volume)\//i, '');
    p = p.replace(/^\/?storage\/emulated\/\d+\//i, '');
    return p.replace(/^\/+/, '');
  }

  function enumerate(st, path, onFile, onDone) {
    var finished = false;
    var iterator = null;
    var cursor = null;

    function finish(err) {
      if (finished) return;
      finished = true;
      try { if (onDone) onDone(err || null); } catch (e) {}
    }

    function emit(file) {
      if (finished) return;
      try { if (onFile) onFile(file); } catch (e) { finish(e); }
    }

    var args = (path === undefined || path === null || path === '') ? [] : [path];
    var q;
    try { q = st.enumerate.apply(st, args); }
    catch (e) { finish(e); return { cancel: function () {} }; }

    if (q && typeof q.continue === 'function') {
      cursor = q;
      q.onsuccess = function () {
        if (finished) return;
        var file = q.result;
        if (!file) { finish(); return; }
        emit(file);
        if (finished) return;
        try { q.continue(); } catch (e) { finish(e); }
      };
      q.onerror = function (e) { finish(e); };
      try { q.continue(); } catch (e) { finish(e); }
      return {
        cancel: function () {
          if (finished) return;
          finished = true;
          try { if (cursor && cursor.cancel) cursor.cancel(); } catch (e) {}
        }
      };
    }

    try {
      if (q && typeof q.values === 'function') iterator = q.values();
      else if (q && typeof Symbol !== 'undefined' && Symbol.asyncIterator && q[Symbol.asyncIterator]) {
        iterator = q[Symbol.asyncIterator]();
      }
    } catch (e) { finish(e); return { cancel: function () {} }; }

    if (!iterator) { finish(new Error('DeviceStorage.enumerate unsupported')); return { cancel: function () {} }; }

    function step() {
      if (finished) return;
      var next;
      try { next = iterator.next(); }
      catch (e) { finish(e); return; }
      if (!next || typeof next.then !== 'function') {
        if (next && next.done) { finish(); return; }
        if (next && 'value' in next) {
          emit(next.value);
          if (!finished) step();
          return;
        }
        finish(new Error('DeviceStorage.enumerate did not return a Promise'));
        return;
      }
      next.then(function (res) {
        if (finished) return;
        if (!res || res.done) { finish(); return; }
        emit(res.value);
        if (!finished) step();
      }, function (e) { finish(e); });
    }

    step();
    return {
      cancel: function () {
        if (finished) return;
        finished = true;
        try { if (iterator && iterator.return) iterator.return(); } catch (e) {}
        try { if (q && q.cancel) q.cancel(); } catch (e) {}
      }
    };
  }

  var PICK_TYPES = [
    'audio/midi', 'audio/x-midi', 'audio/mpeg', 'audio/mp4', 'audio/aac',
    'audio/ogg', 'audio/wav', 'audio/x-wav', 'video/mp4',
    'application/json', 'text/plain', 'application/octet-stream',
    'application/x-soundfont'
  ];

  function inputPick() {
    return new Promise(function (resolve, reject) {
      try {
        var input = document.createElement('input');
        input.type = 'file';
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.onchange = function () {
          var file = input.files && input.files[0];
          try { if (input.parentNode) input.parentNode.removeChild(input); } catch (e) {}
          if (file) resolve(file);
          else reject(new Error('No file selected'));
        };
        document.body.appendChild(input);
        input.click();
      } catch (e) { reject(e); }
    });
  }

  function pickFile(data) {
    return new Promise(function (resolve, reject) {
      var seen = false;
      var settled = false;
      function markSeen() { seen = true; }
      function onVis() { if (document.hidden) seen = true; }
      function clean() {
        try { document.removeEventListener('visibilitychange', onVis); } catch (e) {}
        try { window.removeEventListener('blur', markSeen); } catch (e) {}
      }
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clean();
        fn(value);
      }
      try { document.addEventListener('visibilitychange', onVis); } catch (e) {}
      try { window.addEventListener('blur', markSeen); } catch (e) {}
      startActivity('pick', data || { type: PICK_TYPES }).then(function (res) {
        finish(resolve, res);
      }, function (err) {
        clean();
        if (isActivityCancel(err) && seen) { finish(reject, err); return; }
        console.log('[Platform] pick failed: ' + ((err && (err.name || err.message)) || err));
        console.log('[Platform] pick fallback input');
        inputPick().then(function (file) {
          finish(resolve, file);
        }, function (e) {
          finish(reject, e);
        });
      });
    });
  }

  function startActivity(name, data) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof WebActivity === 'function') {
          var web = data ? new WebActivity(name, data) : new WebActivity(name);
          if (!web || typeof web.start !== 'function') {
            reject(new Error('WebActivity unavailable'));
            return;
          }
          var started = web.start();
          if (started && typeof started.then === 'function') started.then(resolve, reject);
          else resolve(null);
          return;
        }
        if (typeof MozActivity === 'function') {
          var moz = data ? new MozActivity({ name: name, data: data }) : new MozActivity({ name: name });
          moz.onsuccess = function () { resolve(moz.result); };
          moz.onerror = function (e) { reject(e); };
          return;
        }
        reject(new Error('Activity API unavailable'));
      } catch (e) { reject(e); }
    });
  }

  function activityResult(res) {
    var r = res;
    if (r && r.target && r.target.result) r = r.target.result;
    else if (r && r.result && !(typeof Blob !== 'undefined' && r instanceof Blob)) r = r.result;
    return r;
  }

  function resultBlob(res) {
    var r = activityResult(res);
    if (!r) return null;
    if (typeof Blob !== 'undefined' && r instanceof Blob) return r;
    if (r.blob) return r.blob;
    if (r.blobs && r.blobs.length) return r.blobs[0];
    if (r.data) {
      if (r.data.blob) return r.data.blob;
      if (r.data.blobs && r.data.blobs.length) return r.data.blobs[0];
    }
    return null;
  }

  function resultPath(res) {
    var r = activityResult(res);
    if (!r) return '';
    if (typeof r === 'string') return r;
    if (r.filepath) return String(r.filepath);
    if (r.filepaths && r.filepaths.length) return String(r.filepaths[0]);
    if (r.path) return String(r.path);
    if (r.data) {
      if (r.data.filepath) return String(r.data.filepath);
      if (r.data.filepaths && r.data.filepaths.length) return String(r.data.filepaths[0]);
      if (r.data.path) return String(r.data.path);
    }
    return '';
  }

  function baseName(path) {
    return String(path || '').split('#')[0].split('?')[0].replace(/\\/g, '/').split('/').pop();
  }

  function resultName(res) {
    var r = activityResult(res);
    if (!r) return '';
    if (typeof Blob !== 'undefined' && r instanceof Blob) return String(r.name || '');
    var n = r.name || r.filename || (r.blob && r.blob.name) ||
      (r.data && (r.data.name || (r.data.blob && r.data.blob.name))) || '';
    return String(n || baseName(resultPath(r)) || '');
  }

  function isActivityCancel(err) {
    var s = '';
    try { s = String((err && (err.name || err.message)) || err || ''); } catch (e) {}
    return /cancel/i.test(s);
  }

  var ACT_DB = 'pfa-activity';
  var ACT_STORE = 'pending';
  var _actCbs = [];
  var _actQueue = [];
  var _actSeen = {};
  var _actStarted = false;

  function openActivityDb() {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
        var req = indexedDB.open(ACT_DB, 1);
        req.onupgradeneeded = function () {
          try {
            if (!req.result.objectStoreNames.contains(ACT_STORE)) {
              req.result.createObjectStore(ACT_STORE, { keyPath: 'id' });
            }
          } catch (e) {}
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
      } catch (e) { reject(e); }
    });
  }

  function readActivity(id) {
    return openActivityDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ACT_STORE, 'readwrite');
        var store = tx.objectStore(ACT_STORE);
        var rec = null;
        var req = store.get(id);
        req.onsuccess = function () {
          rec = req.result || null;
          if (rec) { try { store.delete(id); } catch (e) {} }
        };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { resolve(rec); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function deliverActivity(payload) {
    if (!_actCbs.length) { _actQueue.push(payload); return; }
    for (var i = 0; i < _actCbs.length; i++) {
      try { _actCbs[i](payload); } catch (e) {}
    }
  }

  function consumeActivity(id) {
    if (!id || _actSeen[id]) return;
    _actSeen[id] = true;
    readActivity(id).then(function (rec) {
      if (rec) deliverActivity({ name: rec.name || '', data: rec.data || {} });
    }, function () {});
  }

  function listenForActivity() {
    if (_actStarted) return;
    _actStarted = true;
    function onMessage(ev) {
      var d = ev && ev.data;
      if (d && d.type === 'pfa-activity' && d.id) consumeActivity(d.id);
    }
    try { window.addEventListener('message', onMessage, false); } catch (e) {}
    try {
      var n = nav();
      if (n && n.serviceWorker && n.serviceWorker.addEventListener) {
        n.serviceWorker.addEventListener('message', onMessage);
      }
    } catch (e2) {}
    try {
      var m = /[?&]pfa_activity=([^&]+)/.exec(String(window.location.search || ''));
      if (m) {
        var id = decodeURIComponent(m[1]);
        setTimeout(function () { consumeActivity(id); }, 0);
      }
    } catch (e2) {}
  }

  function onActivity(cb) {
    if (typeof cb !== 'function') return;
    _actCbs.push(cb);
    listenForActivity();
    if (_actQueue.length) {
      var q = _actQueue.slice();
      _actQueue = [];
      for (var i = 0; i < q.length; i++) {
        try { cb(q[i]); } catch (e) {}
      }
    }
  }

  function requestWakeLock(topic) {
    var b = b2g();
    try { if (b && typeof b.requestWakeLock === 'function') return b.requestWakeLock(topic); } catch (e) {}
    var n = nav();
    try { if (n && typeof n.requestWakeLock === 'function') return n.requestWakeLock(topic); } catch (e2) {}
    return null;
  }

  function getAudioChannelManager() {
    var n = nav();
    if (!n) return null;
    try { if (n.b2g && n.b2g.audioChannelManager) return n.b2g.audioChannelManager; } catch (e) {}
    try { if (n.mozAudioChannelManager) return n.mozAudioChannelManager; } catch (e2) {}
    try { if (n.audioChannelManager) return n.audioChannelManager; } catch (e3) {}
    return null;
  }

  var _channelLogged = false;

  function volumeChannelInfo() {
    var n = nav();
    var info = { b2g: false, moz: false, audio: false, b2gValue: '', mozValue: '', audioValue: '' };
    if (!n) return info;
    try {
      if (n.b2g && n.b2g.audioChannelManager) {
        info.b2g = true;
        info.b2gValue = String(n.b2g.audioChannelManager.volumeControlChannel || '');
      }
    } catch (e1) {}
    try {
      if (n.mozAudioChannelManager) {
        info.moz = true;
        info.mozValue = String(n.mozAudioChannelManager.volumeControlChannel || '');
      }
    } catch (e2) {}
    try {
      if (n.audioChannelManager) {
        info.audio = true;
        info.audioValue = String(n.audioChannelManager.volumeControlChannel || '');
      }
    } catch (e3) {}
    return info;
  }

  function setVolumeChannel() {
    var n = nav();
    if (!n) return false;
    var ok = false;
    var count = 0;
    function apply(acm, tag) {
      if (!acm) return;
      count++;
      try {
        var before = acm.volumeControlChannel;
        acm.volumeControlChannel = 'content';
        var after = acm.volumeControlChannel;
        if (after === 'content') ok = true;
        if (before !== 'content' || after !== 'content') {
          try { console.log('[Volume] ' + tag + ' channel ' + before + ' -> ' + after); } catch (eL) {}
        }
      } catch (e) {
        try { console.warn('[Volume] ' + tag + ' channel not settable', e); } catch (eL) {}
      }
    }
    try { if (n.b2g && n.b2g.audioChannelManager) apply(n.b2g.audioChannelManager, 'b2g'); } catch (e1) {}
    try { if (n.mozAudioChannelManager) apply(n.mozAudioChannelManager, 'moz'); } catch (e2) {}
    try { if (n.audioChannelManager) apply(n.audioChannelManager, 'audio'); } catch (e3) {}
    if (!_channelLogged) {
      _channelLogged = true;
      var origin = '';
      try { origin = (window.location && window.location.origin) || ''; } catch (e4) {}
      try {
        console.log('[Volume] channel managers b2g=' + (n.b2g && n.b2g.audioChannelManager ? 1 : 0) +
          ' moz=' + (n.mozAudioChannelManager ? 1 : 0) +
          ' audio=' + (n.audioChannelManager ? 1 : 0) +
          ' origin=' + origin);
      } catch (e5) {}
      if (!count) {
        try { console.warn('[Volume] no audioChannelManager; media channel cannot be forced'); } catch (e6) {}
      }
    }
    return ok;
  }

  var _channelWatch = false;

  function watchVolumeChannel() {
    if (_channelWatch) return;
    _channelWatch = true;
    function apply() { try { setVolumeChannel(); } catch (e) {} }
    apply();
    var canWatch = false;
    try { canWatch = !!(typeof document !== 'undefined' && document.addEventListener); } catch (e1) {}
    if (!canWatch) return;
    try { setTimeout(apply, 500); } catch (e2) {}
    try { setTimeout(apply, 1500); } catch (e3) {}
    try { setTimeout(apply, 3000); } catch (e4) {}
    try {
      document.addEventListener('visibilitychange', function () {
        try { if (!document.hidden) apply(); } catch (e) {}
      }, false);
    } catch (e5) {}
    try { window.addEventListener('focus', apply, false); } catch (e6) {}
    try { window.addEventListener('pageshow', apply, false); } catch (e7) {}
  }

  function getAudioContextCtor() {
    var b = b2g();
    try { if (b && typeof b.AudioContext === 'function') return b.AudioContext; } catch (e) {}
    if (typeof window !== 'undefined') return window.AudioContext || window.webkitAudioContext || null;
    return null;
  }

  function createAudioContext() {
    var ctors = [];
    var b = b2g();
    try { if (b && typeof b.AudioContext === 'function') ctors.push(b.AudioContext); } catch (e) {}
    try {
      if (typeof window !== 'undefined') {
        if (typeof window.AudioContext === 'function' && ctors.indexOf(window.AudioContext) === -1) ctors.push(window.AudioContext);
        if (typeof window.webkitAudioContext === 'function' && ctors.indexOf(window.webkitAudioContext) === -1) ctors.push(window.webkitAudioContext);
      }
    } catch (e2) {}
    var ctx = null;
    for (var i = 0; i < ctors.length && !ctx; i++) {
      try { ctx = new ctors[i]('content'); }
      catch (e3) { try { ctx = new ctors[i](); } catch (e4) {} }
    }
    if (!ctx) throw new Error('Web Audio API unavailable');
    try { if ('mozAudioChannelType' in ctx) ctx.mozAudioChannelType = 'content'; } catch (e5) {}
    return ctx;
  }

  var _avm = null;
  var _avmLoading = false;
  var _avmFailed = false;
  var _avmFailedAt = 0;
  var _avmQueue = [];

  function loadScript(src, cb) {
    var s = document.createElement('script');
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      s.onload = null;
      s.onerror = null;
      try { if (s.parentNode) s.parentNode.removeChild(s); } catch (e) {}
      if (!ok) { try { console.warn('[Volume] script load failed: ' + src); } catch (eL) {} }
      cb(ok);
    }
    s.onload = function () { finish(true); };
    s.onerror = function () { finish(false); };
    s.src = src;
    s.async = true;
    try { (document.head || document.documentElement).appendChild(s); }
    catch (e) { finish(false); return; }
    setTimeout(function () { finish(false); }, 8000);
  }

  function flushVolume(svc) {
    var q = _avmQueue.slice();
    _avmQueue = [];
    for (var i = 0; i < q.length; i++) {
      try { q[i](svc); } catch (e) {}
    }
  }

  function volumeFailed() {
    if (_avmFailed) return;
    _avmFailed = true;
    _avmFailedAt = Date.now();
    _avmLoading = false;
    try { console.warn('[Volume] AudioVolumeManager unavailable'); } catch (eL) {}
    flushVolume(null);
  }

  function volumeApiBases() {
    var bases = [];
    var port = '';
    try { port = (window.location && window.location.port) || ''; } catch (eL) {}
    function add(p) {
      var base = 'http://127.0.0.1' + (p ? ':' + p : '') + '/api/v1';
      if (bases.indexOf(base) === -1) bases.push(base);
    }
    if (port) add(port);
    add('8081');
    add('');
    return bases;
  }

  function connectVolumeService(base) {
    try {
      var host = 'localhost';
      var m = /^http:\/\/127\.0\.0\.1(?::(\d+))?\//.exec(base || '');
      if (m && m[1]) host = 'localhost:' + m[1];
      var session = new window.lib_session.Session();
      var state = {};
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        volumeFailed();
      }, 10000);
      state.onsessionconnected = function () {
        try {
          window.lib_audiovolume.AudioVolumeManager.get(session).then(function (svc) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            _avm = svc;
            _avmLoading = false;
            try { console.log('[Volume] AudioVolumeManager ready'); } catch (eL) {}
            flushVolume(svc);
          }, function () {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            volumeFailed();
          });
        } catch (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          volumeFailed();
        }
      };
      state.onsessiondisconnected = function () {
        _avm = null;
        try { console.warn('[Volume] AudioVolumeManager session disconnected'); } catch (eL) {}
      };
      session.open('websocket', host, 'secrettoken', state, true);
    } catch (e2) { volumeFailed(); }
  }

  function tryVolumeBase(bases, i) {
    if (i >= bases.length) { volumeFailed(); return; }
    var base = bases[i];
    try { console.log('[Volume] trying service at ' + base); } catch (eL) {}
    loadScript(base + '/shared/core.js', function (ok) {
      if (!ok) { tryVolumeBase(bases, i + 1); return; }
      loadScript(base + '/shared/session.js', function (ok2) {
        if (!ok2) { volumeFailed(); return; }
        loadScript(base + '/audiovolumemanager/service.js', function (ok3) {
          if (!ok3) { volumeFailed(); return; }
          try { console.log('[Volume] service scripts loaded from ' + base); } catch (eL) {}
          connectVolumeService(base);
        });
      });
    });
  }

  function getVolumeManager(cb) {
    var n = nav();
    if (n && n.volumeManager && !b2g()) { cb(n.volumeManager); return; }
    if (_avm) { cb(_avm); return; }
    if (_avmFailed) {
      if (n && n.volumeManager && !b2g()) { cb(n.volumeManager); return; }
      if (Date.now() - _avmFailedAt < 15000) { cb(null); return; }
      _avmFailed = false;
      _avmFailedAt = 0;
    }
    _avmQueue.push(cb);
    if (_avmLoading) return;
    _avmLoading = true;
    tryVolumeBase(volumeApiBases(), 0);
  }

  var _volumeProbe = null;

  function ensureVolumeProbe() {
    if (_volumeProbe) return _volumeProbe;
    try {
      var ctx = createAudioContext();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      try { gain.gain.value = 0; } catch (e1) { try { gain.gain.setValueAtTime(0, 0); } catch (e2) {} }
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(0);
      _volumeProbe = ctx;
    } catch (e3) {
      _volumeProbe = null;
    }
    return _volumeProbe;
  }

  function startVolumeProbe(cb) {
    var ctx = ensureVolumeProbe();
    if (!ctx) { cb(false, null); return; }
    var settled = false;
    var readyTimer = null;
    var maxTimer = null;
    function stop() {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
      try {
        if (typeof ctx.suspend === 'function') ctx.suspend();
        else if (typeof ctx.close === 'function') { ctx.close(); _volumeProbe = null; }
      } catch (e1) {}
    }
    function fail(e) {
      if (settled) return;
      settled = true;
      stop();
      try {
        var why = e ? ((e.name || '') + ' ' + (e.message || '')) : '';
        console.warn('[Volume] content probe failed ' + why + ' state=' + ctx.state);
      } catch (e2) {}
      cb(false, null);
    }
    function ready() {
      if (settled) return;
      if (ctx.state && ctx.state !== 'running') { fail(new Error('AudioContext state=' + ctx.state)); return; }
      settled = true;
      maxTimer = setTimeout(stop, 12000);
      try {
        var ch = ctx.mozAudioChannelType || (ctx.destination && ctx.destination.mozAudioChannelType) || '';
        console.log('[Volume] content probe active state=' + ctx.state + ' ch=' + ch);
      } catch (e3) {}
      cb(true, stop);
    }
    function activate() {
      if (ctx.state === 'running') { readyTimer = setTimeout(ready, 80); return; }
      var p;
      try { p = ctx.resume(); } catch (e4) { fail(e4); return; }
      if (p && typeof p.then === 'function') {
        p.then(function () { readyTimer = setTimeout(ready, 80); }, function (e) { fail(e); });
      } else {
        readyTimer = setTimeout(ready, 80);
      }
    }
    activate();
    setTimeout(function () { if (!settled) fail(); }, 10000);
  }

  function sendVolumeRequest(dir, cb, stop, skipChannel) {
    getVolumeManager(function (vm) {
      if (!skipChannel && !setVolumeChannel()) {
        if (stop) stop();
        cb(new Error('Media channel unavailable'));
        return;
      }
      if (!vm) {
        if (stop) stop();
        cb(new Error('VolumeManager unavailable'));
        return;
      }
      var p;
      var isNew = false;
      function done(err) {
        if (stop) stop();
        cb(err || null);
      }
      try {
        if (dir > 0) {
          if (typeof vm.requestVolumeUp === 'function') { isNew = true; p = vm.requestVolumeUp(); }
          else p = vm.requestUp ? vm.requestUp() : null;
        } else if (dir < 0) {
          if (typeof vm.requestVolumeDown === 'function') { isNew = true; p = vm.requestVolumeDown(); }
          else p = vm.requestDown ? vm.requestDown() : null;
        } else {
          if (typeof vm.requestVolumeShow === 'function') { isNew = true; p = vm.requestVolumeShow(); }
          else p = vm.requestShow ? vm.requestShow() : null;
        }
      } catch (e) { done(e); return; }
      if (p && typeof p.then === 'function') p.then(function () { done(null); }, function (e) { done(e || new Error('Volume request failed')); });
      else if (p === null) done(new Error('Volume request unsupported'));
      else if (isNew) done(new Error('Volume request did not resolve'));
      else done(null);
    });
  }

  function requestVolume(dir, cb) {
    cb = cb || function () {};
    if (setVolumeChannel()) {
      sendVolumeRequest(dir, cb, null, false);
      return;
    }
    startVolumeProbe(function (ok, stop) {
      if (!ok) { cb(new Error('Media channel unavailable')); return; }
      getVolumeManager(function (vm) {
        if (!vm) { stop(); cb(new Error('VolumeManager unavailable')); return; }
        sendVolumeRequest(dir, cb, stop, true);
      });
    });
  }

  function startServiceWorker() {
    try {
      var n = nav();
      if (!n || !n.serviceWorker || typeof n.serviceWorker.register !== 'function') return;
      n.serviceWorker.register('sw.js').then(function (reg) {
        try {
          if (reg && reg.systemMessageManager && reg.systemMessageManager.subscribe) {
            var p = reg.systemMessageManager.subscribe('activity');
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }
        } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  }

  startServiceWorker();
  watchVolumeChannel();

  return {
    getDeviceStorage: getDeviceStorage,
    getDeviceStorages: getDeviceStorages,
    enumerate: enumerate,
    normalizeStoragePath: normalizeStoragePath,
    startActivity: startActivity,
    pickFile: pickFile,
    activityResult: activityResult,
    resultBlob: resultBlob,
    resultPath: resultPath,
    resultName: resultName,
    isActivityCancel: isActivityCancel,
    onActivity: onActivity,
    requestWakeLock: requestWakeLock,
    getAudioChannelManager: getAudioChannelManager,
    volumeChannelInfo: volumeChannelInfo,
    setVolumeChannel: setVolumeChannel,
    watchVolumeChannel: watchVolumeChannel,
    getAudioContextCtor: getAudioContextCtor,
    createAudioContext: createAudioContext,
    requestVolume: requestVolume
  };
})();
