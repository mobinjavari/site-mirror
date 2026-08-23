import { mkdir, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { RobotsChecker } from '../crawler/robots.js';
import { classifyBlock } from '../shared/blockDetection.js';
import { extractCssUrls } from '../shared/css.js';
import { logger } from '../shared/logger.js';
import { categorizeAsset, extensionForContentType } from '../shared/mime.js';
import { fetchResource, politeDelay } from '../shared/politeFetch.js';
import type {
  AssetInventory,
  AssetRecord,
  BlockedResourceRecord,
  MirrorConfig,
} from '../shared/types.js';
import {
  ensureExtension,
  isSameHost,
  localSitePathForAsset,
  safeParseUrl,
} from '../shared/urls.js';

export interface DownloadOutcome {
  inventory: AssetInventory;
  blocked: BlockedResourceRecord[];
}

/**
 * Downloads every asset URL discovered across all pages (any host — CSS/JS/fonts/media are
 * mirrored regardless of origin so the page renders offline), recursing into stylesheets for
 * their own url()/@import references. Only same-host URLs are checked against robots.txt,
 * since that's the only host the fetched robots.txt has authority over.
 */
export async function downloadAssets(
  seedUrls: ReadonlyMap<string, ReadonlySet<string>>,
  config: MirrorConfig,
  robots: RobotsChecker,
): Promise<DownloadOutcome> {
  const target = new URL(config.targetUrl);
  const visited = new Set<string>();
  const assets: AssetRecord[] = [];
  const blocked: BlockedResourceRecord[] = [];
  const queue: string[] = [...seedUrls.keys()];
  const foundOnPages = new Map<string, Set<string>>(
    [...seedUrls.entries()].map(([url, pages]) => [url, new Set(pages)]),
  );

  const pagesReferencing = (url: string): string[] => [...(foundOnPages.get(url) ?? [])];

  while (queue.length > 0) {
    const rawUrl = queue.shift() as string;
    if (visited.has(rawUrl)) continue;
    visited.add(rawUrl);

    const parsed = safeParseUrl(rawUrl);
    if (!parsed) continue;

    if (isSameHost(parsed, target) && !robots.isAllowed(rawUrl)) {
      logger.warn(`robots.txt disallows asset ${rawUrl}; skipping download`);
      blocked.push({
        url: rawUrl,
        errorType: 'robots-disallowed',
        reason: 'Blocked by a Disallow rule in robots.txt',
        detectedAt: new Date().toISOString(),
      });
      assets.push({
        sourceUrl: rawUrl,
        localPath: '',
        category: categorizeAsset(parsed, undefined),
        status: 'failed',
        foundOnPages: pagesReferencing(rawUrl),
        errorReason: 'Blocked by robots.txt',
      });
      continue;
    }

    await politeDelay(config);
    const record = await downloadOne(rawUrl, parsed, config, pagesReferencing(rawUrl));
    assets.push(record.asset);
    if (record.blocked) blocked.push(record.blocked);

    if (record.cssTextForRecursion) {
      for (const nested of extractCssUrls(record.cssTextForRecursion, rawUrl)) {
        const key = nested.toString();
        if (visited.has(key)) continue;
        if (!foundOnPages.has(key)) foundOnPages.set(key, new Set());
        for (const page of pagesReferencing(rawUrl)) foundOnPages.get(key)?.add(page);
        queue.push(key);
      }
    }
  }

  return { inventory: { generatedAt: new Date().toISOString(), assets }, blocked };
}

interface DownloadOneResult {
  asset: AssetRecord;
  blocked?: BlockedResourceRecord;
  cssTextForRecursion?: string;
}

async function downloadOne(
  rawUrl: string,
  parsed: URL,
  config: MirrorConfig,
  foundOnPages: string[],
): Promise<DownloadOneResult> {
  try {
    const response = await fetchResource(rawUrl, config);
    const isHtmlish = (response.contentType ?? '').includes('html');
    const blockRecord = classifyBlock(
      rawUrl,
      response.status,
      isHtmlish ? response.buffer.toString('utf8').slice(0, 5000) : '',
    );
    if (blockRecord) {
      logger.error(`Blocked downloading ${rawUrl}: ${blockRecord.errorType}`);
      return {
        blocked: blockRecord,
        asset: {
          sourceUrl: rawUrl,
          localPath: '',
          category: categorizeAsset(parsed, response.contentType),
          status: 'failed',
          foundOnPages,
          httpStatus: response.status,
          errorReason: blockRecord.reason,
        },
      };
    }

    if (!response.ok) {
      logger.warn(`GET ${rawUrl} -> HTTP ${response.status}`);
      return {
        asset: {
          sourceUrl: rawUrl,
          localPath: '',
          category: categorizeAsset(parsed, response.contentType),
          status: 'failed',
          foundOnPages,
          httpStatus: response.status,
          errorReason: `HTTP ${response.status}`,
        },
      };
    }

    const category = categorizeAsset(parsed, response.contentType);
    const localPath = ensureExtension(
      localSitePathForAsset(parsed),
      extensionForContentType(response.contentType),
    );
    const absolutePath = posix.join(config.outputDir, localPath);
    await mkdir(posix.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, response.buffer);
    logger.success(`Downloaded ${rawUrl} -> ${localPath}`);

    return {
      asset: {
        sourceUrl: rawUrl,
        localPath,
        category,
        status: 'downloaded',
        foundOnPages,
        bytes: response.buffer.byteLength,
        httpStatus: response.status,
        ...(response.contentType !== undefined ? { contentType: response.contentType } : {}),
      },
      ...(category === 'css' ? { cssTextForRecursion: response.buffer.toString('utf8') } : {}),
    };
  } catch (error) {
    logger.warn(`Failed to download ${rawUrl}: ${(error as Error).message}`);
    return {
      asset: {
        sourceUrl: rawUrl,
        localPath: '',
        category: categorizeAsset(parsed, undefined),
        status: 'failed',
        foundOnPages,
        errorReason: (error as Error).message,
      },
    };
  }
}
