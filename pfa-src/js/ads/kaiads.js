(function (window) {
  'use strict';

  var KAIADS_PUBLISHER = '1e7f7115-127d-4268-ba4e-198ed4888e24';
  var KAIADS_APP = 'Piano From Above';
  var KAIADS_SLOT = 'fs-interstitial';
  var KAIADS_TEST = 0;
  var KAIADS_TIMEOUT_MS = 10000;
  var KAIADS_MIN_GAP_MS = 30000;
  var KAIADS_CADENCE = 5;

  var _available = function () { return typeof window.getKaiAd === 'function'; };
  var _preloaded = null;
  var _visible = false;
  var _sessions = 0;
  var _lastCount = 0;
  var _lastShown = -Infinity;
  var _launchShown = false;
  var _disabled = false;
  var _hookPause = null;
  var _hookResume = null;
  var _preloadInFlight = false;
  var _pendingDisplay = false;

  function _wire(ad) {
    try {
      ad.on('display', function () {
        console.log('[KaiAds] event: display fired');
        _visible = true;
        if (_hookPause) _hookPause();
      });
      ad.on('close', function () {
        console.log('[KaiAds] event: close fired');
        _visible = false;
        if (_hookResume) _hookResume();
      });
    } catch (e) {
      console.warn('[KaiAds] event wiring failed', e);
    }
  }

  function _request(cb) {
    if (!_available()) { cb(null); return; }
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      console.warn('[KaiAds] SDK lookup stalled (getKaiAd is still the bootstrap stub: ads-sdk dependency not delivered / Kai News not installed / offline). Check publisher account + device provisioning.');
      cb(null);
    }, KAIADS_TIMEOUT_MS + 3000);
    getKaiAd({
      publisher: KAIADS_PUBLISHER,
      app: KAIADS_APP,
      slot: KAIADS_SLOT,
      test: KAIADS_TEST,
      timeout: KAIADS_TIMEOUT_MS,
      onerror: function (err) {
        clearTimeout(timer);
        if (done) return;
        done = true;
        console.warn('[KaiAds] onerror code=', err && err.code !== undefined ? err.code : err);
        cb(null);
      },
      onready: function (ad) {
        clearTimeout(timer);
        if (done) return;
        done = true;
        console.log('[KaiAds] onready type=' + ad.type + ' adId=' + ad.adId + ' readyNow=' + ad.readyNow + ' fullscreen=' + ad.fullscreen);
        _wire(ad);
        var delay = ad.readyNow ? 0 : 400;
        setTimeout(function () { cb(ad); }, delay);
      }
    });
  }

  function _preload() {
    if (_disabled || _preloaded || !_available() || _preloadInFlight) return;
    _preloadInFlight = true;
    _request(function (ad) {
      _preloadInFlight = false;
      if (ad) _preloaded = ad;
      if (_pendingDisplay && _preloaded) {
        _pendingDisplay = false;
        var a = _preloaded;
        _preloaded = null;
        _display(a);
      }
    });
  }

  function _display(ad) {
    console.log('[KaiAds] _display calling ad.call("display") readyNow=' + ad.readyNow + ' type=' + ad.type);
    try { ad.call('display'); } catch (e) { console.warn('[KaiAds] display failed', e); }
    _preload();
  }

  function _show() {
    if (_disabled || _visible || !_available()) return false;
    var now = performance.now();
    if (now - _lastShown < KAIADS_MIN_GAP_MS) return false;
    _lastCount = _sessions;
    _lastShown = now;
    var ad = _preloaded;
    _preloaded = null;
    if (ad) { _display(ad); return true; }
    if (_preloadInFlight) {
      console.log('[KaiAds] _show: preload in flight, deferring display');
      _pendingDisplay = true;
      return true;
    }
    _request(function (a) { if (a) _display(a); });
    return true;
  }

  var KaiAds = {
    init: function () {
      console.log('[KaiAds] init: mozApps=' + !!(typeof navigator !== 'undefined' && navigator.mozApps) +
        ' getKaiAd=' + (typeof window.getKaiAd) +
        ' dummyStub=' + !!(window.getKaiAd && window.getKaiAd.dummy),
        '| loader>2.5 path needs system ads-sdk (Kai News); web path needs network');
      _preload();
    },
    launch: function () {
      if (_launchShown || _disabled) return;
      _launchShown = true;
      _lastCount = _sessions;
      _show();
    },
    onSession: function () {
      _sessions++;
      if (!_launchShown) return;
      if (_sessions - _lastCount >= KAIADS_CADENCE) _show();
    },
    setPauseHooks: function (pause, resume) {
      _hookPause = pause;
      _hookResume = resume;
    },
    disable: function () { _disabled = true; },
    get isReady() { return _available(); },
    get isVisible() { return _visible; }
  };

  window.KaiAds = KaiAds;
})(window);