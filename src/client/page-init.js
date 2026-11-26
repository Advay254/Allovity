// Runs in <head> before first paint. It adds the js class that the stylesheet
// uses for the no-JavaScript navigation fallback.
// External file on purpose: the content security policy forbids inline scripts.
document.documentElement.classList.add('js');
