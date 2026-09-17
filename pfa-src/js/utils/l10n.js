/**
 * l10n.js — L10n bridge for Piano From Above (KaiOS 2.5).
 * 
 * KaiOS apps (like settings) use shared/js/l10n.js which provides navigator.mozL10n.
 * This file just provides a thin synchronous wrapper L10n.t() for the JS UI (like softkeys)
 * and ensures the UI updates when navigator.mozL10n emits 'localized'.
 */
var L10n = (function () {
  'use strict';

  var _ready = false;

  function t(key, fallback) {
    if (typeof navigator !== 'undefined' &&
        navigator.mozL10n &&
        typeof navigator.mozL10n.get === 'function') {
      try {
        var val = navigator.mozL10n.get(key);
        if (val && typeof val === 'string' && val !== key && val !== '') {
          return val;
        }
      } catch (e) { /* ignore */ }
    }
    return (fallback !== undefined) ? fallback : key;
  }

  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
    window.addEventListener('localized', function () {
      _ready = true;
      if (typeof window.updateSoftkeys === 'function') {
        window.updateSoftkeys();
      }
      if (typeof Settings !== 'undefined' &&
          typeof Settings.isOpen === 'function' && Settings.isOpen() &&
          typeof Settings.rebuildRows === 'function') {
        // We do not have Settings.refreshRows, so we'd need to re-open the sub-page.
        // It's usually fine since 'localized' fires once on boot.
      }
    });
  }

  return {
    t: t,
    isReady: function() { return _ready; },
    getLang: function () {
      if (typeof navigator !== 'undefined' &&
          navigator.mozL10n &&
          navigator.mozL10n.language &&
          navigator.mozL10n.language.code) {
        return navigator.mozL10n.language.code;
      }
      return 'en-US';
    }
  };
})();