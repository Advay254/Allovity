import { readFileSync } from 'node:fs';
import { ASSET_MANIFEST_PATH } from './paths.js';

export type AssetResolver = (name: string) => string;

/** Loads the manifest written by scripts/build-assets.mjs. */
export function loadAssetResolver(manifestPath = ASSET_MANIFEST_PATH): AssetResolver {
  let manifest: Record<string, string>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>;
  } catch {
    throw new Error('Asset manifest not found. Run "npm run build:assets" first.');
  }
  return (name: string): string => {
    const url = manifest[name];
    if (!url) throw new Error(`Unknown asset: ${name}`);
    return url;
  };
}

export function hasAsset(resolver: AssetResolver, name: string): boolean {
  try {
    resolver(name);
    return true;
  } catch {
    return false;
  }
}
