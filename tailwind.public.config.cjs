const theme = require('./tailwind.theme.cjs');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './src/client/**/*.js', '!./views/admin/**'],
  theme: { screens: theme.screens, extend: theme.extend },
  plugins: theme.plugins,
};
