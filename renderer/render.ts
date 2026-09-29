import * as cheerio from 'cheerio';
import { chromium, type Browser, type Page, type Response as PlaywrightResponse } from 'playwright';
import { classifyBlock } from '../shared/blockDetection.js';
import { logger } from '../shared/logger.js';
import type {
  ApiSnapshotRecord,
  BlockedResourceRecord,
  ExternalDependencyRecord,
  MirrorConfig,
  RenderResult,
} from '../shared/types.js';
import { isFetchableHttpUrl, isSameHost, safeParseUrl } from '../shared/urls.js';

// Chrome's own OS-level sandbox can conflict with a constrained host and surface as
// net::ERR_INVALID_HANDLE on navigation rather than at launch; --no-sandbox is Playwright's
// documented mitigation for exactly that class of restricted-environment failure.
const LAUNCH_ARGS = ['--no-sandbox'];

/**
 * Prefers the system-installed Chrome (no browser download required) and falls back to
 * Playwright's own bundled Chromium — useful on machines where that bundled download hasn't
 * been fetched (e.g. blocked by a CDN) but a regular Chrome install is already present.
 */
async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome', args: LAUNCH_ARGS });
  } catch (error) {
    logger.warn(
      `System Chrome unavailable (${(error as Error).message}); falling back to Playwright's bundled Chromium`,
    );
    return chromium.launch({ headless: true, args: LAUNCH_ARGS });
  }
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchChromium();
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** Scrolls to the current bottom repeatedly, waiting for lazy content, until page height stops growing. */
async function autoScrollToSettle(page: Page, maxAttempts: number): Promise<void> {
  let lastHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) return;
    lastHeight = newHeight;
  }
  logger.warn(`Reached max scroll attempts (${maxAttempts}) without the page height settling`);
}

function collectExternalEmbeds(html: string, pageUrl: string): ExternalDependencyRecord[] {
  const $ = cheerio.load(html);
  const records: ExternalDependencyRecord[] = [];
  $('iframe[src]').each((_, element) => {
    const src = $(element).attr('src');
    const resolved = src ? safeParseUrl(src, pageUrl) : null;
    if (!resolved || !isFetchableHttpUrl(resolved)) return;
    records.push({
      url: resolved.toString(),
      foundOnPages: [pageUrl],
      kind: 'iframe',
      reason: 'Live third-party embed (e.g. a map or video player); not recursively mirrored',
    });
  });
  return records;
}

async function saveApiSnapshot(
  response: PlaywrightResponse,
  pageUrl: string,
): Promise<ApiSnapshotRecord | null> {
  const url = response.url();
  const contentType = response.headers()['content-type'] ?? '';
  if (
    !contentType.includes('application/json') ||
    response.status() < 200 ||
    response.status() >= 300
  )
    return null;

  let body: string;
  try {
    body = await response.text();
    JSON.parse(body);
  } catch {
    return null;
  }

  return {
    endpoint: url,
    method: response.request().method(),
    body,
    contentType,
    capturedFromPage: pageUrl,
  };
}

export async function renderPage(
  browser: Browser,
  pageUrl: string,
  config: MirrorConfig,
): Promise<RenderResult> {
  const target = new URL(config.targetUrl);
  const context = await browser.newContext({ userAgent: config.userAgent });
  const page = await context.newPage();

  const requestedResourceUrls = new Set<string>();
  const apiSnapshots: ApiSnapshotRecord[] = [];
  const pendingResponseHandlers: Promise<void>[] = [];

  page.on('request', (request) => {
    const parsed = safeParseUrl(request.url());
    if (parsed && isFetchableHttpUrl(parsed)) requestedResourceUrls.add(parsed.toString());
  });

  page.on('response', (response) => {
    const parsed = safeParseUrl(response.url());
    if (!parsed || !isSameHost(parsed, target)) return;
    pendingResponseHandlers.push(
      saveApiSnapshot(response, pageUrl).then((record) => {
        if (record) apiSnapshots.push(record);
      }),
    );
  });

  try {
    let navigationResponse: PlaywrightResponse | null;
    try {
      navigationResponse = await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs,
      });
    } catch (error) {
      logger.error(`Navigation to ${pageUrl} failed: ${(error as Error).message}`);
      return emptyBlockedResult(pageUrl, {
        url: pageUrl,
        errorType: 'network-error',
        reason: (error as Error).message,
        detectedAt: new Date().toISOString(),
      });
    }

    const status = navigationResponse?.status();
    const bodySample = (await page.content()).slice(0, 5000);
    const blockRecord = classifyBlock(pageUrl, status, bodySample);
    if (blockRecord) {
      logger.error(
        `Blocked while rendering ${pageUrl}: ${blockRecord.errorType} — ${blockRecord.reason}`,
      );
      return emptyBlockedResult(pageUrl, blockRecord);
    }

    await page
      .waitForLoadState('networkidle', { timeout: config.networkIdleTimeoutMs })
      .catch(() => logger.warn(`Network never idled on ${pageUrl}; continuing anyway`));

    await autoScrollToSettle(page, config.maxScrollAttempts);

    await page
      .waitForLoadState('networkidle', { timeout: config.networkIdleTimeoutMs })
      .catch(() =>
        logger.warn(`Network still not idle on ${pageUrl} after scrolling; continuing anyway`),
      );
    await Promise.all(pendingResponseHandlers);

    const html = await page.content();
    const screenshotPngBuffer = await page.screenshot({ fullPage: true });
    const externalDependencies = collectExternalEmbeds(html, pageUrl);

    return {
      pageUrl,
      html,
      screenshotPngBuffer,
      requestedResourceUrls: [...requestedResourceUrls],
      apiSnapshots,
      externalDependencies,
      ...(status !== undefined ? { httpStatus: status } : {}),
    };
  } finally {
    await context.close();
  }
}

function emptyBlockedResult(pageUrl: string, blocked: BlockedResourceRecord): RenderResult {
  return {
    pageUrl,
    html: '',
    screenshotPngBuffer: Buffer.alloc(0),
    requestedResourceUrls: [],
    apiSnapshots: [],
    externalDependencies: [],
    blocked,
  };
}
