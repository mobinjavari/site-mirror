import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import { discoverPages } from './crawler/discover.js';
import { loadRobotsChecker, type RobotsChecker } from './crawler/robots.js';
import { downloadAssets } from './downloader/download.js';
import { extractAssetUrlsFromHtml } from './downloader/extractAssetUrls.js';
import { renderPage, withBrowser } from './renderer/render.js';
import { buildFontDataUris } from './rewriter/fontDataUris.js';
import { rewriteDownloadedCssFiles } from './rewriter/rewriteCssAssets.js';
import { rewritePageHtml } from './rewriter/rewriteHtml.js';
import { logger } from './shared/logger.js';
import { readJsonFile, writeJsonFile } from './shared/manifest.js';
import { politeDelay } from './shared/politeFetch.js';
import type {
  AssetInventory,
  CrawlManifest,
  CrawlManifestEntry,
  ExternalDependencyRecord,
  MirrorConfig,
  RenderResult,
  ValidationPageResult,
} from './shared/types.js';
import { localSitePathForPage, safeParseUrl } from './shared/urls.js';
import { runVisualValidation } from './verifier/validate.js';
import { writeReports } from './verifier/reports.js';

interface CliFlags {
  config: MirrorConfig;
  skipVerify: boolean;
  verifyOnly: boolean;
}

interface FlagHelp {
  readonly flag: string;
  readonly valueHint: string | null;
  readonly description: string;
}

const FLAG_HELP: readonly FlagHelp[] = [
  { flag: '--url', valueHint: '<url>', description: 'Seed URL to mirror' },
  { flag: '--depth', valueHint: '<n>', description: 'Max crawl depth' },
  { flag: '--delay-min', valueHint: '<ms>', description: 'Minimum delay between requests' },
  { flag: '--delay-max', valueHint: '<ms>', description: 'Maximum delay between requests' },
  { flag: '--out', valueHint: '<dir>', description: 'Output directory (default: output)' },
  {
    flag: '--config',
    valueHint: '<path>',
    description: 'Path to a config file (default: config.json)',
  },
  {
    flag: '--skip-verify',
    valueHint: null,
    description: 'Skip the online-vs-local screenshot comparison',
  },
  {
    flag: '--verify-only',
    valueHint: null,
    description:
      'Re-run just the validation step against an existing output/ (needs a previous full run)',
  },
  { flag: '--help', valueHint: null, description: 'Show this help and exit' },
];

function printHelp(): void {
  const usages = FLAG_HELP.map(({ flag, valueHint }) =>
    valueHint ? `${flag} ${valueHint}` : flag,
  );
  const width = Math.max(...usages.map((usage) => usage.length));
  console.log('Usage: npm run mirror -- [flags]');
  console.log('\nAll flags are optional and override config.json.\n');
  for (const [index, { description }] of FLAG_HELP.entries()) {
    console.log(`  ${(usages[index] ?? '').padEnd(width)}  ${description}`);
  }
}

function parseNumericFlag(
  flagName: string,
  rawValue: string | undefined,
  fallback: number,
): number {
  if (rawValue === undefined) return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative number, got "${rawValue}".`);
  }
  return parsed;
}

async function resolveConfig(): Promise<CliFlags | null> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      depth: { type: 'string' },
      'delay-min': { type: 'string' },
      'delay-max': { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string', default: 'config.json' },
      'skip-verify': { type: 'boolean', default: false },
      'verify-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    printHelp();
    return null;
  }

  const base = JSON.parse(await readFile(values.config, 'utf8')) as MirrorConfig;

  const targetUrl = values.url ?? base.targetUrl;
  if (!targetUrl) {
    throw new Error(
      'Target URL is required — pass --url <url> or set "targetUrl" in your config file.',
    );
  }

  const maxDepth = parseNumericFlag('--depth', values.depth, base.maxDepth);
  const delayMin = parseNumericFlag('--delay-min', values['delay-min'], base.requestDelayMs.min);
  const delayMax = parseNumericFlag('--delay-max', values['delay-max'], base.requestDelayMs.max);
  if (delayMin > delayMax) {
    throw new Error(`--delay-min (${delayMin}) cannot be greater than --delay-max (${delayMax}).`);
  }

  const config: MirrorConfig = {
    ...base,
    targetUrl,
    maxDepth,
    outputDir: values.out ?? base.outputDir,
    requestDelayMs: { min: delayMin, max: delayMax },
    // No page list configured → at least screenshot-diff the seed page itself.
    verifyPages: base.verifyPages.length > 0 ? base.verifyPages : [targetUrl],
  };

  return {
    config,
    skipVerify: values['skip-verify'] === true,
    verifyOnly: values['verify-only'] === true,
  };
}

async function runVerifyOnly(config: MirrorConfig, robots: RobotsChecker): Promise<void> {
  const manifest = await readJsonFile<CrawlManifest>(posix.join(config.outputDir, 'manifest.json'));
  if (!manifest) {
    throw new Error(
      'No output/manifest.json found — run a full mirror before using --verify-only.',
    );
  }
  const inventory = (await readJsonFile<AssetInventory>(
    posix.join(config.outputDir, 'reports', 'asset-inventory.json'),
  )) ?? {
    generatedAt: new Date().toISOString(),
    assets: [],
  };

  const validationResults = await withBrowser((browser) =>
    runVisualValidation(browser, config, robots, manifest),
  );
  await writeReports({
    config,
    manifest,
    inventory,
    downloadBlocked: [],
    externalDependencies: [],
    unmirroredInternalLinks: [],
    validationResults,
  });
  logger.success('Verification complete — see output/reports/.');
}

async function main(): Promise<void> {
  const resolved = await resolveConfig();
  if (!resolved) return;
  const { config, skipVerify, verifyOnly } = resolved;
  const target = new URL(config.targetUrl);
  const robots = await loadRobotsChecker(config);

  if (verifyOnly) {
    await runVerifyOnly(config, robots);
    return;
  }

  logger.step('Crawling');
  const manifest = await discoverPages(config, robots);
  await writeJsonFile(posix.join(config.outputDir, 'manifest.json'), manifest);

  logger.step('Rendering');
  const renderResults = new Map<string, RenderResult>();
  await withBrowser(async (browser) => {
    for (const page of manifest.pages) {
      await politeDelay(config);
      const result = await renderPage(browser, page.url, config);
      renderResults.set(page.url, result);
      if (result.blocked) {
        page.status = 'blocked';
        manifest.blocked.push(result.blocked);
        logger.error(`${page.url} blocked: ${result.blocked.errorType} — ${result.blocked.reason}`);
      } else {
        page.status = 'rendered';
        page.renderedHtmlPath = localSitePathForPage(new URL(page.url));
        if (result.httpStatus !== undefined) page.httpStatus = result.httpStatus;
      }
    }
  });
  await writeJsonFile(posix.join(config.outputDir, 'manifest.json'), manifest);

  logger.step('Collecting asset references');
  const assetSeeds = new Map<string, Set<string>>();
  const addSeed = (url: URL, pageUrl: string): void => {
    const key = url.toString();
    if (!assetSeeds.has(key)) assetSeeds.set(key, new Set());
    assetSeeds.get(key)?.add(pageUrl);
  };
  for (const [pageUrl, result] of renderResults) {
    if (result.blocked) continue;
    for (const url of extractAssetUrlsFromHtml(result.html, pageUrl)) addSeed(url, pageUrl);
    for (const rawUrl of result.requestedResourceUrls) {
      const parsed = safeParseUrl(rawUrl);
      if (parsed) addSeed(parsed, pageUrl);
    }
  }

  logger.step('Downloading assets');
  const { inventory, blocked: downloadBlocked } = await downloadAssets(assetSeeds, config, robots);

  logger.step('Embedding fonts as data URIs');
  const fontDataUris = await buildFontDataUris(inventory, config.outputDir);

  logger.step('Rewriting stylesheets');
  await rewriteDownloadedCssFiles(inventory, config, fontDataUris);

  logger.step('Rewriting pages & writing final HTML');
  const assetBySourceUrl = new Map(inventory.assets.map((asset) => [asset.sourceUrl, asset]));
  const pageByUrl = new Map<string, CrawlManifestEntry>(
    manifest.pages.map((page) => [page.url, page]),
  );
  const externalDependenciesByUrl = new Map<string, ExternalDependencyRecord>();
  const unmirroredInternalLinks = new Set<string>();

  for (const [pageUrl, result] of renderResults) {
    if (result.blocked) continue;
    const pageEntry = pageByUrl.get(pageUrl);
    if (!pageEntry?.renderedHtmlPath) continue;

    const rewritten = rewritePageHtml(
      result.html,
      pageUrl,
      pageEntry.renderedHtmlPath,
      target,
      { assetBySourceUrl, pageByUrl, fontDataUris },
      result.apiSnapshots,
    );

    const absolutePath = posix.join(config.outputDir, pageEntry.renderedHtmlPath);
    await mkdir(posix.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, rewritten.html, 'utf8');
    logger.success(`Wrote ${pageEntry.renderedHtmlPath}`);

    for (const url of rewritten.unmirroredInternalLinks) unmirroredInternalLinks.add(url);

    for (const dependency of result.externalDependencies) {
      const existing = externalDependenciesByUrl.get(dependency.url);
      if (existing) existing.foundOnPages.push(...dependency.foundOnPages);
      else externalDependenciesByUrl.set(dependency.url, { ...dependency });
    }
    for (const url of rewritten.externalUrlsLeftUnchanged) {
      if (!externalDependenciesByUrl.has(url)) {
        externalDependenciesByUrl.set(url, {
          url,
          foundOnPages: [pageUrl],
          kind: 'other',
          reason:
            'Referenced by the page but not available locally (download failed or was blocked)',
        });
      }
    }
  }

  await writeJsonFile(posix.join(config.outputDir, 'manifest.json'), manifest);

  let validationResults: ValidationPageResult[] = [];
  if (skipVerify) {
    logger.warn('Skipping visual validation (--skip-verify)');
  } else {
    logger.step('Validating mirrored pages');
    validationResults = await withBrowser((browser) =>
      runVisualValidation(browser, config, robots, manifest),
    );
  }

  logger.step('Writing reports');
  await writeReports({
    config,
    manifest,
    inventory,
    downloadBlocked,
    externalDependencies: [...externalDependenciesByUrl.values()],
    unmirroredInternalLinks: [...unmirroredInternalLinks],
    validationResults,
  });

  const renderedCount = manifest.pages.filter((page) => page.status === 'rendered').length;
  if (renderedCount === 0) {
    logger.error('No pages were mirrored — every discovered page was blocked or failed to render.');
    logger.info(`See ${posix.join(config.outputDir, 'reports', 'error-report.md')} for details.`);
    process.exitCode = 1;
    return;
  }

  logger.success(
    `Done. Mirrored ${renderedCount} page(s) to: ${posix.join(config.outputDir, 'site')}`,
  );
  logger.info(`Reports: ${posix.join(config.outputDir, 'reports')}`);
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
