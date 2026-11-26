// Prevents double submission: after a form is sent, its submit buttons are disabled and
// marked busy. The page is replaced by the response, so nothing needs to be re-enabled,
// except when the browser restores the page from its back/forward cache.
(function () {
  'use strict';

  function lock(form) {
    Array.prototype.forEach.call(form.querySelectorAll('button[type="submit"]'), function (button) {
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-disabled', 'true');
    });
    form.setAttribute('data-submitting', 'true');
  }

  function unlock(form) {
    Array.prototype.forEach.call(form.querySelectorAll('button[type="submit"]'), function (button) {
      button.removeAttribute('aria-busy');
      button.removeAttribute('aria-disabled');
    });
    form.removeAttribute('data-submitting');
  }

  Array.prototype.forEach.call(
    document.querySelectorAll('form[data-submit-once]'),
    function (form) {
      form.addEventListener('submit', function (event) {
        if (form.getAttribute('data-submitting') === 'true') {
          event.preventDefault();
          return;
        }
        lock(form);
      });
    },
  );

  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    Array.prototype.forEach.call(document.querySelectorAll('form[data-submit-once]'), unlock);
  });
})();
