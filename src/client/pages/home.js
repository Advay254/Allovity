// Home page only: marks the navigation entry for the section in view.
(function () {
  'use strict';

  if (document.body.getAttribute('data-page') !== 'home') return;
  if (!('IntersectionObserver' in window)) return;

  var links = document.querySelectorAll('[data-nav-link]');
  var ids = [];
  Array.prototype.forEach.call(links, function (link) {
    var id = (link.getAttribute('href') || '').split('#')[1];
    if (id && ids.indexOf(id) === -1 && document.getElementById(id)) ids.push(id);
  });
  if (!ids.length) return;

  var visible = {};

  function update() {
    var active = null;
    ids.forEach(function (id) {
      if (visible[id]) active = id;
    });
    Array.prototype.forEach.call(links, function (link) {
      var id = (link.getAttribute('href') || '').split('#')[1];
      if (id && id === active) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        visible[entry.target.id] = entry.isIntersecting;
      });
      update();
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );

  ids.forEach(function (id) {
    observer.observe(document.getElementById(id));
  });
})();
