// Runs in <head> before first paint so the chosen theme never flashes.
// External file on purpose: the content security policy forbids inline scripts.
(function () {
  var root = document.documentElement;
  var pref = 'system';
  root.classList.add('js');
  try {
    var stored = window.localStorage.getItem('allovity-theme');
    if (stored === 'light' || stored === 'dark') {
      pref = stored;
    }
  } catch (error) {
    // Storage can be blocked. Fall back to the system preference.
  }
  root.setAttribute('data-theme-pref', pref);
  if (pref === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref);
  }
})();
