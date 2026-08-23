import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { lookup as mimeLookup } from 'mime-types';
import type { AssetInventory } from '../shared/types.js';

const FALLBACK_FONT_MIME_TYPE = 'font/woff2';

/**
 * Reads every downloaded font once and returns its source URL mapped to a `data:` URI, for the
 * CSS rewriter to embed in place of a linked file — browsers block cross-origin @font-face loads
 * under the `file://` protocol, which breaks custom fonts the moment the mirror is opened without
 * a server; a data: URI carries no origin at all, so it loads identically served or opened directly.
 */
export async function buildFontDataUris(
  inventory: AssetInventory,
  outputDir: string,
): Promise<Map<string, string>> {
  const fontAssets = inventory.assets.filter(
    (asset) => asset.category === 'font' && asset.status === 'downloaded',
  );

  const entries = await Promise.all(
    fontAssets.map(async (asset) => {
      const bytes = await readFile(posix.join(outputDir, asset.localPath));
      const mimeType =
        asset.contentType?.split(';')[0]?.trim() ||
        mimeLookup(asset.localPath) ||
        FALLBACK_FONT_MIME_TYPE;
      return [asset.sourceUrl, `data:${mimeType};base64,${bytes.toString('base64')}`] as const;
    }),
  );

  return new Map(entries);
}
