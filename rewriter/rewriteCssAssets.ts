import { readFile, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { rewriteCssUrls } from '../shared/css.js';
import { logger } from '../shared/logger.js';
import type { AssetInventory, MirrorConfig } from '../shared/types.js';
import { relativeHref } from '../shared/urls.js';

/**
 * Downloaded stylesheets still contain their original absolute url()/@import references (fonts,
 * background images, nested imports); this rewrites each one in place against the full asset map,
 * run once all downloads are known so a CSS file can reference an asset fetched later in the queue.
 */
export async function rewriteDownloadedCssFiles(
  inventory: AssetInventory,
  config: MirrorConfig,
  fontDataUris: ReadonlyMap<string, string>,
): Promise<void> {
  const assetBySourceUrl = new Map(inventory.assets.map((asset) => [asset.sourceUrl, asset]));
  const cssAssets = inventory.assets.filter(
    (asset) => asset.category === 'css' && asset.status === 'downloaded',
  );

  for (const cssAsset of cssAssets) {
    const absolutePath = posix.join(config.outputDir, cssAsset.localPath);
    const original = await readFile(absolutePath, 'utf8');

    const rewritten = rewriteCssUrls(original, cssAsset.sourceUrl, (absoluteUrl) => {
      const dataUri = fontDataUris.get(absoluteUrl);
      if (dataUri) return dataUri;
      const referenced = assetBySourceUrl.get(absoluteUrl);
      return referenced?.status === 'downloaded'
        ? relativeHref(cssAsset.localPath, referenced.localPath)
        : null;
    });

    if (rewritten !== original) {
      await writeFile(absolutePath, rewritten, 'utf8');
      logger.info(`Rewrote url() references inside ${cssAsset.localPath}`);
    }
  }
}
