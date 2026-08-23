import * as cheerio from 'cheerio';
import { logger } from '../shared/logger.js';
import { fetchResource, politeDelay } from '../shared/politeFetch.js';
import type { CrawlManifest, CrawlManifestEntry, MirrorConfig } from '../shared/types.js';
import { isFetchableHttpUrl, isSameHost, safeParseUrl } from '../shared/urls.js';
import type { RobotsChecker } from './robots.js';

export function extractInternalLinks(html: string, pageUrl: URL, target: URL): URL[] {
  const $ = cheerio.load(html);
  const found = new Map<string, URL>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const resolved = safeParseUrl(href, pageUrl.toString());
    if (!resolved || !isFetchableHttpUrl(resolved) || !isSameHost(resolved, target)) return;
    resolved.hash = '';
    found.set(resolved.toString(), resolved);
  });

  return [...found.values()];
}

interface QueueItem {
  url: URL;
  depth: number;
  parent: string | null;
}

/**
 * Discovery is a lightweight, un-rendered HTTP pass purely to find same-host page URLs;
 * the renderer stage does the authoritative JS-rendered capture of each discovered page.
 * A page whose only internal links are added by client-side JS won't be found here — an
 * accepted trade-off that keeps crawling fast and independent of a browser instance.
 */
export async function discoverPages(
  config: MirrorConfig,
  robots: RobotsChecker,
): Promise<CrawlManifest> {
  const target = new URL(config.targetUrl);
  const visited = new Set<string>();
  const pages: CrawlManifestEntry[] = [];
  const blocked: CrawlManifest['blocked'] = [];
  const queue: QueueItem[] = [{ url: target, depth: 0, parent: null }];

  while (queue.length > 0) {
    const item = queue.shift() as QueueItem;
    const key = item.url.toString();
    if (visited.has(key)) continue;
    visited.add(key);

    if (!robots.isAllowed(key)) {
      logger.warn(`robots.txt disallows ${key}; skipping`);
      blocked.push({
        url: key,
        errorType: 'robots-disallowed',
        reason: 'Blocked by a Disallow rule in robots.txt',
        detectedAt: new Date().toISOString(),
      });
      continue;
    }

    pages.push({
      url: key,
      depth: item.depth,
      parent: item.parent,
      status: 'pending',
      discoveredAt: new Date().toISOString(),
    });
    logger.info(`Discovered ${key} (depth ${item.depth})`);

    if (item.depth >= config.maxDepth) continue;

    await politeDelay(config);
    try {
      const response = await fetchResource(key, config);
      if (!response.ok) {
        logger.warn(`GET ${key} -> HTTP ${response.status}; no further links extracted from it`);
        continue;
      }
      const html = response.buffer.toString('utf8');
      for (const link of extractInternalLinks(html, item.url, target)) {
        if (!visited.has(link.toString())) {
          queue.push({ url: link, depth: item.depth + 1, parent: key });
        }
      }
    } catch (error) {
      logger.warn(`Failed to fetch ${key} for link discovery: ${(error as Error).message}`);
    }
  }

  return { targetUrl: config.targetUrl, generatedAt: new Date().toISOString(), pages, blocked };
}
