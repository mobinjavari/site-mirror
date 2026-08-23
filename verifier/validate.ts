import { mkdir, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Browser } from 'playwright';
import type { RobotsChecker } from '../crawler/robots.js';
import { renderPage } from '../renderer/render.js';
import { logger } from '../shared/logger.js';
import { politeDelay } from '../shared/politeFetch.js';
import type { CrawlManifest, MirrorConfig, ValidationPageResult } from '../shared/types.js';
import { pageSlugForUrl } from '../shared/urls.js';
import { diffScreenshots } from './screenshotDiff.js';
import { startStaticServer } from './staticServer.js';

function toServerPath(outputRelativePath: string): string {
  return outputRelativePath.replace(/^site\//, '');
}

/**
 * Re-renders each configured page both online and from the locally served mirror, then diffs the
 * full-page screenshots — a fresh online render (not the one captured during mirroring) so the
 * report reflects the live site's current state at verification time.
 */
export async function runVisualValidation(
  browser: Browser,
  config: MirrorConfig,
  robots: RobotsChecker,
  manifest: CrawlManifest,
): Promise<ValidationPageResult[]> {
  const server = await startStaticServer(posix.join(config.outputDir, 'site'));
  const screenshotsDir = posix.join(config.outputDir, 'reports', 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  const results: ValidationPageResult[] = [];

  try {
    for (const pageUrl of config.verifyPages) {
      logger.step(`Validating ${pageUrl}`);

      if (!robots.isAllowed(pageUrl)) {
        results.push({
          url: pageUrl,
          localUrl: '',
          diffPixelRatio: null,
          passed: false,
          note: 'Skipped: disallowed by robots.txt',
        });
        continue;
      }

      const manifestEntry = manifest.pages.find((page) => page.url === pageUrl);
      if (!manifestEntry?.renderedHtmlPath) {
        results.push({
          url: pageUrl,
          localUrl: '',
          diffPixelRatio: null,
          passed: false,
          note: 'Page was not mirrored (absent from the crawl manifest)',
        });
        continue;
      }

      const localUrl = `${server.baseUrl}/${toServerPath(manifestEntry.renderedHtmlPath)}`;

      await politeDelay(config);
      const online = await renderPage(browser, pageUrl, config);
      const local = await renderPage(browser, localUrl, config);

      if (online.blocked) {
        results.push({
          url: pageUrl,
          localUrl,
          diffPixelRatio: null,
          passed: false,
          note: `Online page blocked: ${online.blocked.errorType} — ${online.blocked.reason}`,
        });
        continue;
      }
      if (local.blocked) {
        results.push({
          url: pageUrl,
          localUrl,
          diffPixelRatio: null,
          passed: false,
          note: `Local mirror failed to render: ${local.blocked.errorType} — ${local.blocked.reason}`,
        });
        continue;
      }

      const diff = diffScreenshots(online.screenshotPngBuffer, local.screenshotPngBuffer);
      if (!diff) {
        results.push({
          url: pageUrl,
          localUrl,
          diffPixelRatio: null,
          passed: false,
          note: 'Could not compare screenshots (empty capture)',
        });
        continue;
      }

      const slug = pageSlugForUrl(new URL(pageUrl));
      await writeFile(posix.join(screenshotsDir, `${slug}-online.png`), online.screenshotPngBuffer);
      await writeFile(posix.join(screenshotsDir, `${slug}-local.png`), local.screenshotPngBuffer);
      await writeFile(posix.join(screenshotsDir, `${slug}-diff.png`), diff.diffPngBuffer);

      const passed = diff.ratio <= config.screenshotDiffThreshold;
      results.push({
        url: pageUrl,
        localUrl,
        diffPixelRatio: diff.ratio,
        passed,
        ...(passed
          ? {}
          : {
              note: `Visual diff of ${(diff.ratio * 100).toFixed(2)}% exceeds the configured threshold`,
            }),
      });
      logger[passed ? 'success' : 'warn'](
        `${pageUrl} — pixel diff ${(diff.ratio * 100).toFixed(2)}%`,
      );
    }
  } finally {
    await server.close();
  }

  return results;
}
