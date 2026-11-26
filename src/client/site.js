// Shared behaviour for every public page: the mobile drawer.
(function () {
  'use strict';

  var root = document.documentElement;

  /* Mobile drawer ------------------------------------------------------- */
  var drawer = document.getElementById('site-drawer');
  var opener = document.querySelector('[data-drawer-open]');
  if (!drawer || !opener) return;

  var backgrounds = document.querySelectorAll('[data-drawer-background]');
  var desktopQuery = window.matchMedia('(min-width: 768px)');
  var FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function isOpen() {
    return drawer.getAttribute('data-open') === 'true';
  }

  function openDrawer() {
    if (isOpen()) return;
    drawer.removeAttribute('inert');
    drawer.setAttribute('data-open', 'true');
    opener.setAttribute('aria-expanded', 'true');
    Array.prototype.forEach.call(backgrounds, function (element) {
      element.setAttribute('inert', '');
    });
    root.classList.add('is-locked');
    var first = drawer.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeDrawer(restoreFocus) {
    if (!isOpen()) return;
    Array.prototype.forEach.call(backgrounds, function (element) {
      element.removeAttribute('inert');
    });
    drawer.setAttribute('data-open', 'false');
    drawer.setAttribute('inert', '');
    opener.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-locked');
    if (restoreFocus) opener.focus();
  }

  opener.addEventListener('click', openDrawer);

  Array.prototype.forEach.call(drawer.querySelectorAll('[data-drawer-close]'), function (element) {
    element.addEventListener('click', function () {
      closeDrawer(element.tagName === 'BUTTON');
    });
  });

  document.addEventListener('keydown', function (event) {
    if (!isOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer(true);
      return;
    }
    if (event.key !== 'Tab') return;
    var items = Array.prototype.filter.call(drawer.querySelectorAll(FOCUSABLE), function (element) {
      return element.offsetParent !== null;
    });
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!drawer.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  });

  var onViewportChange = function (event) {
    if (event.matches) closeDrawer(false);
  };
  if (desktopQuery.addEventListener) {
    desktopQuery.addEventListener('change', onViewportChange);
  } else if (desktopQuery.addListener) {
    desktopQuery.addListener(onViewportChange);
  }
})();
