const theme = require('./tailwind.theme.cjs');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/admin/**/*.ejs', './views/partials/symbol.ejs', './views/partials/icon-*.ejs'],
  theme: { screens: theme.screens, extend: theme.extend },
  plugins: theme.plugins,
};
