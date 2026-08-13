/**
 * l10n.js — Simple locale loader for KaiOS.
 * Loads /locales/{lang}/app.json. Falls back to key if missing.
 * Usage: L10n.t('softkey_menu') → hoặc 'Menu'
 */
var L10n = (function () {
  'use strict';

  var _lang = 'en';
  var _strings = {};

  /**
   * Detect device language or use default.
   * KaiOS 2.5: navigator.language = 'en' / 'vi' / etc.
   */
  function init(callback) {
    if (typeof navigator !== 'undefined' && navigator.language) {
      var code = navigator.language;
      if (code.indexOf('-') > -1) code = code.split('-')[0];
      _lang = code;
    }
    loadBundle(_lang, callback);
  }

  function loadBundle(lang, callback) {
    var url = '/locales/' + lang + '/app.json';
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          _strings = JSON.parse(xhr.responseText);
        } catch (e) {
          _strings = {};
        }
      } else if (lang !== 'en') {
        loadBundle('en', callback);
        return;
      }
      if (callback) callback();
    };
    xhr.onerror = function () {
      if (lang !== 'en') { loadBundle('en', callback); return; }
      if (callback) callback();
    };
    xhr.send();
  }

  /** Translate a key. Returns key itself if not found. */
  function t(key) {
    return _strings[key] || key;
  }

  return {
    init:     init,
    t:        t,
    getLang:  function () { return _lang; },
    getStrings: function () { return _strings; },
  };
})();