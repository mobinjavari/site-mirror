import * as cheerio from 'cheerio';
import { extractCssUrls } from '../shared/css.js';
import { extractEmbeddedMediaUrls, isFetchableHttpUrl, safeParseUrl } from '../shared/urls.js';

function parseSrcsetUrls(srcset: string): string[] {
  return srcset
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((url): url is string => Boolean(url));
}

// `link[href]` excludes canonical/alternate: those point at HTML pages and are handled by the
// page-link rewriter instead, so treating them as assets would trigger a pointless extra fetch.
const ASSET_ATTRIBUTE_SELECTORS: ReadonlyArray<readonly [selector: string, attribute: string]> = [
  ['link[href]:not([rel="canonical"]):not([rel="alternate"])', 'href'],
  ['script[src]', 'src'],
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['audio[src]', 'src'],
];

/** Extracts every static asset URL referenced by a rendered page's DOM: tags, srcset, and inline CSS. */
export function extractAssetUrlsFromHtml(html: string, pageUrl: string): URL[] {
  const $ = cheerio.load(html);
  const found = new Map<string, URL>();

  const addUrl = (raw: string | undefined): void => {
    if (!raw) return;
    const resolved = safeParseUrl(raw, pageUrl);
    if (resolved && isFetchableHttpUrl(resolved)) found.set(resolved.toString(), resolved);
  };
  const mergeUrls = (urls: URL[]): void => {
    for (const url of urls) found.set(url.toString(), url);
  };

  for (const [selector, attribute] of ASSET_ATTRIBUTE_SELECTORS) {
    $(selector).each((_, element) => addUrl($(element).attr(attribute)));
  }

  $('img[srcset], source[srcset]').each((_, element) => {
    const srcset = $(element).attr('srcset');
    if (srcset) parseSrcsetUrls(srcset).forEach(addUrl);
  });

  $('[style]').each((_, element) => {
    const style = $(element).attr('style');
    if (style) mergeUrls(extractCssUrls(style, pageUrl));
  });

  $('style').each((_, element) => {
    const cssText = $(element).html();
    if (cssText) mergeUrls(extractCssUrls(cssText, pageUrl));
  });

  // Catches media URLs embedded as plain text (e.g. inline <script> JSON config) that no
  // attribute/CSS selector above would see — see extractEmbeddedMediaUrls for why that happens.
  mergeUrls(extractEmbeddedMediaUrls(html, pageUrl));

  return [...found.values()];
}
