'use strict';

var ACT_DB = 'pfa-activity';
var ACT_STORE = 'pending';

function openActivityDb() {
  return new Promise(function (resolve, reject) {
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
  });
}

function saveActivity(rec) {
  return openActivityDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(ACT_STORE, 'readwrite');
      var store = tx.objectStore(ACT_STORE);
      try { store.put(rec); } catch (e) { reject(e); return; }
      tx.oncomplete = function () { resolve(rec); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}

function openActivityWindow(id) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var target = null;
    for (var i = 0; i < list.length; i++) {
      var u = (list[i] && list[i].url) || '';
      if (u && (u.indexOf('index.html') !== -1 || /\/$/.test(u))) {
        target = list[i];
        break;
      }
    }
    if (target) {
      try {
        target.postMessage({ type: 'pfa-activity', id: id });
        if (target.focus) target.focus();
        return;
      } catch (e) {}
    }
    return self.clients.openWindow('/index.html?pfa_activity=' + encodeURIComponent(id));
  });
}

function handleActivity(evt) {
  if (!evt || evt.name !== 'activity') return;
  var handler = null;
  try {
    var data = evt.data;
    if (data && typeof data.webActivityRequestHandler === 'function') handler = data.webActivityRequestHandler();
    else if (data && typeof data.WebActivityRequestHandler === 'function') handler = data.WebActivityRequestHandler();
  } catch (e) {}
  if (!handler) return;

  var src = handler.source || {};
  var id = 'a' + Date.now() + '-' + Math.random().toString(36).slice(2);
  var rec = { id: id, name: src.name || '', data: src.data || {}, ts: Date.now() };

  var work = saveActivity(rec).then(function () {
    return openActivityWindow(id);
  }).catch(function () {
    try { handler.postError('PFA activity handoff failed'); } catch (e) {}
  });

  if (evt.waitUntil) evt.waitUntil(work);
}

self.addEventListener('install', function (evt) {
  if (evt.waitUntil) evt.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (evt) {
  if (evt.waitUntil) evt.waitUntil(self.clients.claim());
});

self.onsystemmessage = handleActivity;
