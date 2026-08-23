import robotsParserImport from 'robots-parser';
import { fetchResource } from '../shared/politeFetch.js';
import { logger } from '../shared/logger.js';
import type { MirrorConfig } from '../shared/types.js';

interface RobotsTxt {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
}

// robots-parser ships a broken index.d.ts (a shorthand `declare module` shadows its own real
// export), so TS sees no call signature on the default import; the runtime shape is correct.
const robotsParser = robotsParserImport as unknown as (url: string, robotstxt: string) => RobotsTxt;

export interface RobotsChecker {
  isAllowed: (url: string) => boolean;
  crawlDelaySeconds: number | null;
}

export async function loadRobotsChecker(config: MirrorConfig): Promise<RobotsChecker> {
  const target = new URL(config.targetUrl);
  const robotsUrl = new URL('/robots.txt', target.origin).toString();

  try {
    const response = await fetchResource(robotsUrl, config);
    const body = response.ok ? response.buffer.toString('utf8') : '';
    const robots = robotsParser(robotsUrl, body);
    const crawlDelaySeconds = robots.getCrawlDelay(config.userAgent) ?? null;
    logger.info(`Loaded robots.txt from ${robotsUrl} (HTTP ${response.status})`);
    return {
      // isAllowed can return `undefined` for URLs robots.txt has no opinion on; treat that as allowed.
      isAllowed: (url: string) => robots.isAllowed(url, config.userAgent) !== false,
      crawlDelaySeconds,
    };
  } catch (error) {
    logger.warn(
      `Could not fetch robots.txt (${(error as Error).message}); defaulting to allow-all`,
    );
    return { isAllowed: () => true, crawlDelaySeconds: null };
  }
}
