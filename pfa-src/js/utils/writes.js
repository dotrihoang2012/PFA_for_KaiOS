// Write-log: remembers every on-disk path this app wrote (run files + final
// .note), so "Clear" can delete them BY EXACT NAME. Needed because KaiOS
// DeviceStorage.enumerate() returns 0 entries on some devices/builds for this
// app — no enumerate means files can only be found if we already know the name.
(function () {
  var KEY = 'pfa_written_files';
  var MAX = 200;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function save(a) {
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {}
  }

  window.Written = {
    list: function () { return load(); },
    remember: function (path) {
      if (!path) return;
      var a = load();
      if (a.indexOf(path) === -1) a.push(path);
      if (a.length > MAX) a = a.slice(a.length - MAX);
      save(a);
    },
    rememberAll: function (paths) {
      var a = load();
      (paths || []).forEach(function (p) {
        if (p && a.indexOf(p) === -1) a.push(p);
      });
      if (a.length > MAX) a = a.slice(a.length - MAX);
      save(a);
    },
    forget: function (path) {
      var a = load();
      var i = a.indexOf(path);
      if (i !== -1) { a.splice(i, 1); save(a); }
    },
    purge: function (pred) {
      var a = load().filter(pred);
      save(a);
    },
    reset: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
    }
  };
})();