// Single source of truth for design tokens. Both Tailwind configs (public and
// admin) import this file, and the CSS custom properties are generated from
// it, so a colour is defined exactly once. Colours are exposed as RGB triplets
// so opacity utilities such as bg-primary/20 work.
const plugin = require('tailwindcss/plugin');

const palette = {
  dark: {
    bg: '#080D19',
    surface: '#151F32',
    raised: '#1B2842',
    fg: '#FFFFFF',
    muted: '#8BA3C8',
    primary: '#246BFE',
    'primary-hover': '#1B55D4',
    'primary-fg': '#FFFFFF',
    link: '#6A9CFF',
    line: '#24324D',
    'line-strong': '#5F7399',
    success: '#16C79A',
    warning: '#F4B740',
    danger: '#F05B69',
  },
  light: {
    bg: '#F7F9FC',
    surface: '#FFFFFF',
    raised: '#FFFFFF',
    fg: '#0B1220',
    muted: '#4A5B78',
    primary: '#246BFE',
    'primary-hover': '#1B55D4',
    'primary-fg': '#FFFFFF',
    link: '#1B55D4',
    line: '#D9E0EC',
    'line-strong': '#7A8BA8',
    success: '#0B7A5F',
    warning: '#8A5700',
    danger: '#C0293A',
  },
};

// Extra per-theme values that are not colours in the palette sense.
const effects = {
  dark: { glow: '0.22', shadow: '0 0 0' },
  light: { glow: '0.12', shadow: '11 18 32' },
};

function rgbTriplet(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function variables(theme) {
  const vars = {};
  for (const [name, hex] of Object.entries(palette[theme])) {
    vars[`--c-${name}`] = rgbTriplet(hex);
  }
  vars['--glow-alpha'] = effects[theme].glow;
  vars['--shadow-rgb'] = effects[theme].shadow;
  vars['color-scheme'] = theme;
  return vars;
}

const paletteVariables = plugin(({ addBase }) => {
  addBase({
    ':root': variables('dark'),
    '@media (prefers-color-scheme: light)': {
      ':root:not([data-theme])': variables('light'),
    },
    ':root[data-theme="light"]': variables('light'),
    ':root[data-theme="dark"]': variables('dark'),
  });
});

const colors = Object.fromEntries(
  Object.keys(palette.dark).map((name) => [name, `rgb(var(--c-${name}) / <alpha-value>)`]),
);

const fallbackSans = [
  'ui-sans-serif',
  'system-ui',
  '-apple-system',
  'Segoe UI',
  'Roboto',
  'Helvetica Neue',
  'Arial',
  'sans-serif',
];

module.exports = {
  palette,
  screens: { xs: '400px', sm: '640px', md: '768px', lg: '1024px', xl: '1280px' },
  extend: {
    colors,
    fontFamily: {
      display: ['"Space Grotesk Variable"', ...fallbackSans],
      sans: ['"Inter Variable"', '"Inter Fallback"', ...fallbackSans],
      mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
    },
    fontSize: {
      caption: ['0.8125rem', { lineHeight: '1.25rem' }],
      small: ['0.9375rem', { lineHeight: '1.5rem' }],
      body: ['1rem', { lineHeight: '1.65rem' }],
      lead: ['clamp(1.0625rem, 1rem + 0.35vw, 1.3125rem)', { lineHeight: '1.6' }],
      h3: [
        'clamp(1.25rem, 1.1rem + 0.6vw, 1.5rem)',
        { lineHeight: '1.3', letterSpacing: '-0.01em' },
      ],
      h2: [
        'clamp(1.875rem, 1.3rem + 2.4vw, 3rem)',
        { lineHeight: '1.1', letterSpacing: '-0.025em' },
      ],
      h1: [
        'clamp(2.25rem, 1.4rem + 3.6vw, 4rem)',
        { lineHeight: '1.05', letterSpacing: '-0.03em' },
      ],
      display: [
        'clamp(2.5rem, 1.2rem + 6.2vw, 5.5rem)',
        { lineHeight: '1.02', letterSpacing: '-0.035em' },
      ],
    },
    borderRadius: { sm: '6px', md: '10px', lg: '16px', xl: '24px' },
    boxShadow: {
      'elev-1': '0 1px 2px rgb(var(--shadow-rgb) / 0.22), 0 1px 1px rgb(var(--shadow-rgb) / 0.12)',
      'elev-2':
        '0 12px 32px -10px rgb(var(--shadow-rgb) / 0.45), 0 2px 6px rgb(var(--shadow-rgb) / 0.2)',
    },
    transitionDuration: { fast: '150ms', normal: '250ms' },
    keyframes: {
      'fade-up': {
        from: { opacity: '0', transform: 'translateY(8px)' },
        to: { opacity: '1', transform: 'translateY(0)' },
      },
      spin: { to: { transform: 'rotate(360deg)' } },
    },
    animation: {
      'fade-up': 'fade-up 250ms ease-out both',
      'fade-up-late': 'fade-up 250ms ease-out 80ms both',
      spin: 'spin 700ms linear infinite',
    },
  },
  plugins: [paletteVariables],
};
