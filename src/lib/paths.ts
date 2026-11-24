import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Works from src/lib (tsx) and dist/lib (compiled): both sit two levels below the root.
const here = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(here, '..', '..');
export const VIEWS_DIR = resolve(ROOT_DIR, 'views');
export const MIGRATIONS_DIR = resolve(ROOT_DIR, 'migrations');
export const STATIC_DIR = resolve(ROOT_DIR, 'dist', 'static');
export const ROOT_FILES_DIR = resolve(ROOT_DIR, 'dist', 'root');
export const ASSET_MANIFEST_PATH = resolve(ROOT_DIR, 'dist', 'asset-manifest.json');
