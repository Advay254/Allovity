// Builds every static asset into dist/static with content-hashed file names and
// writes dist/asset-manifest.json so the server can resolve logical names.
//
//   fonts      copied from the @fontsource-variable packages (self-hosted)
//   css        public and admin bundles compiled with Tailwind
//   client js  copied from src/client
//   brand      PNG icons and the social image rasterised from brand/*.svg
//
// No binary file is committed to the repository: raster assets are produced here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = join(root, 'dist', 'static');
const rootFilesDir = join(root, 'dist', 'root');
const buildDir = join(root, 'build');
const manifest = {};

rmSync(staticDir, { recursive: true, force: true });
rmSync(rootFilesDir, { recursive: true, force: true });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(staticDir, { recursive: true });
mkdirSync(rootFilesDir, { recursive: true });
mkdirSync(join(buildDir, 'generated'), { recursive: true });
mkdirSync(join(buildDir, 'css'), { recursive: true });

function hashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 10);
}

/** Writes a buffer as <name>.<hash>.<ext> under dist/static and records it. */
function emit(logicalName, fileName, buffer) {
  const ext = extname(fileName);
  const hashed = `${basename(fileName, ext)}.${hashOf(buffer)}${ext}`;
  writeFileSync(join(staticDir, hashed), buffer);
  manifest[logicalName] = `/static/${hashed}`;
  return manifest[logicalName];
}

// 1. Fonts ----------------------------------------------------------------
const fonts = [
  {
    key: 'font.space-grotesk',
    pkg: '@fontsource-variable/space-grotesk',
    file: 'space-grotesk-latin-wght-normal.woff2',
    family: 'Space Grotesk Variable',
    weight: '300 700',
  },
  {
    key: 'font.inter',
    pkg: '@fontsource-variable/inter',
    file: 'inter-latin-wght-normal.woff2',
    family: 'Inter Variable',
    weight: '100 900',
  },
  {
    key: 'font.jetbrains-mono',
    pkg: '@fontsource-variable/jetbrains-mono',
    file: 'jetbrains-mono-latin-wght-normal.woff2',
    family: 'JetBrains Mono Variable',
    weight: '100 800',
  },
];
const latinRange =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

let fontCss = '';
for (const font of fonts) {
  const source = join(dirname(require.resolve(`${font.pkg}/package.json`)), 'files', font.file);
  const url = emit(font.key, font.file, readFileSync(source));
  fontCss += `@font-face{font-family:'${font.family}';font-style:normal;font-display:swap;font-weight:${font.weight};src:url(${url}) format('woff2');unicode-range:${latinRange}}\n`;
}
// Metric-matched fallback so the swap from Arial to Inter moves text very little.
fontCss +=
  "@font-face{font-family:'Inter Fallback';src:local('Arial');ascent-override:90.49%;descent-override:22.56%;line-gap-override:0%;size-adjust:107.06%}\n";
writeFileSync(join(buildDir, 'generated', 'fonts.css'), fontCss);

// 2. CSS -------------------------------------------------------------------
const tailwindCli = require.resolve('tailwindcss/lib/cli.js');
for (const [name, config] of [
  ['public', 'tailwind.public.config.cjs'],
  ['admin', 'tailwind.admin.config.cjs'],
]) {
  const out = join(buildDir, 'css', `${name}.css`);
  execFileSync(
    process.execPath,
    [
      tailwindCli,
      '-c',
      join(root, config),
      '-i',
      join(root, 'src/styles', `${name}.css`),
      '-o',
      out,
      '--minify',
    ],
    {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  emit(`${name}.css`, `${name}.css`, readFileSync(out));
}

// 3. Client scripts ----------------------------------------------------------
function collectScripts(dir, prefix = '') {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectScripts(full, `${prefix}${entry}/`);
    } else if (entry.endsWith('.js')) {
      emit(`${prefix}${entry}`, entry, readFileSync(full));
    }
  }
}
collectScripts(join(root, 'src', 'client'));

// 4. Brand assets (placeholders, see brand/README.md) -------------------------
const brandDir = join(root, 'brand');
const symbolSvg = readFileSync(join(brandDir, 'symbol.svg'));
const appIconSvg = readFileSync(join(brandDir, 'app-icon.svg'));
const ogSvg = readFileSync(join(brandDir, 'og-image.svg'));

const raster = (svg, size) =>
  sharp(svg, { density: 1200 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

emit('brand.symbol.svg', 'symbol.svg', symbolSvg);
emit('brand.favicon-16.png', 'favicon-16x16.png', await raster(symbolSvg, 16));
emit('brand.favicon-32.png', 'favicon-32x32.png', await raster(symbolSvg, 32));
emit('brand.apple-touch-icon.png', 'apple-touch-icon.png', await raster(appIconSvg, 180));
emit('brand.icon-192.png', 'icon-192.png', await raster(appIconSvg, 192));
emit('brand.icon-512.png', 'icon-512.png', await raster(appIconSvg, 512));
emit(
  'brand.og-image.png',
  'og-image.png',
  await sharp(ogSvg, { density: 96 }).resize(1200, 630).png({ compressionLevel: 9 }).toBuffer(),
);

// favicon.ico at a stable URL (browsers and crawlers request /favicon.ico directly).
const icoSizes = [16, 32, 48];
const pngs = await Promise.all(icoSizes.map((size) => raster(symbolSvg, size)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const entries = pngs.map((png, index) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(icoSizes[index], 0);
  entry.writeUInt8(icoSizes[index], 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  return entry;
});
writeFileSync(join(rootFilesDir, 'favicon.ico'), Buffer.concat([header, ...entries, ...pngs]));

// 5. Manifest -----------------------------------------------------------------
writeFileSync(join(root, 'dist', 'asset-manifest.json'), JSON.stringify(manifest, null, 2));
if (!existsSync(join(root, 'dist', 'asset-manifest.json'))) {
  throw new Error('Asset manifest was not written');
}
console.log(`Built ${Object.keys(manifest).length} assets into dist/static`);
