import * as cheerio from 'cheerio';
import { rewriteCssUrls } from '../shared/css.js';
import type { ApiSnapshotRecord, AssetRecord, CrawlManifestEntry } from '../shared/types.js';
import { isFetchableHttpUrl, isSameHost, relativeHref, safeParseUrl } from '../shared/urls.js';
import { buildApiSnapshotShim } from './apiSnapshotShim.js';

export interface RewriteMaps {
  assetBySourceUrl: ReadonlyMap<string, AssetRecord>;
  pageByUrl: ReadonlyMap<string, CrawlManifestEntry>;
  fontDataUris: ReadonlyMap<string, string>;
}

export interface RewriteResult {
  html: string;
  externalUrlsLeftUnchanged: string[];
  unmirroredInternalLinks: string[];
}

const ASSET_HREF_SELECTOR =
  'link[rel~="stylesheet"], link[rel~="preload"], link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]';
const ASSET_SRC_SELECTOR =
  'script[src], img[src], source[src], video[src], video[poster], audio[src]';
const PAGE_HREF_SELECTOR = 'a[href], link[rel="canonical"], link[rel="alternate"]';

/**
 * Rewrites one rendered page's DOM so every mirrored reference (assets by any host, internal
 * page links) points at its local file, leaves un-mirrored/external URLs untouched, and injects
 * the API-snapshot fetch-shim when this page made same-origin JSON calls during render.
 */
export function rewritePageHtml(
  html: string,
  pageUrl: string,
  pageLocalPath: string,
  target: URL,
  maps: RewriteMaps,
  apiSnapshots: ApiSnapshotRecord[],
): RewriteResult {
  const $ = cheerio.load(html);
  const externalUrlsLeftUnchanged = new Set<string>();
  const unmirroredInternalLinks = new Set<string>();

  const lookupAsset = (absoluteUrl: string): string | null => {
    const asset = maps.assetBySourceUrl.get(absoluteUrl);
    if (asset?.status === 'downloaded') return relativeHref(pageLocalPath, asset.localPath);
    externalUrlsLeftUnchanged.add(absoluteUrl);
    return null;
  };

  // CSS url()s get fonts inlined as data: URIs (see buildFontDataUris) instead of a linked file:
  // browsers block cross-origin @font-face loads under file://, which a linked path can't survive.
  // Attribute-based lookups (resolveAssetAttr below) keep linking to the real file — inlining there
  // too would just duplicate the font bytes into a preload hint that no longer needs to fetch anything.
  const lookupCssUrl = (absoluteUrl: string): string | null =>
    maps.fontDataUris.get(absoluteUrl) ?? lookupAsset(absoluteUrl);

  const resolveAssetAttr = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const resolved = safeParseUrl(raw, pageUrl);
    if (!resolved || !isFetchableHttpUrl(resolved)) return null;
    return lookupAsset(resolved.toString());
  };

  const resolvePageHref = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const resolved = safeParseUrl(raw, pageUrl);
    if (!resolved || !isFetchableHttpUrl(resolved)) return null;
    const hash = resolved.hash;
    resolved.hash = '';
    const key = resolved.toString();
    if (!isSameHost(resolved, target)) {
      externalUrlsLeftUnchanged.add(key);
      return null;
    }
    const page = maps.pageByUrl.get(key);
    if (page?.status === 'rendered' && page.renderedHtmlPath) {
      return relativeHref(pageLocalPath, page.renderedHtmlPath) + hash;
    }
    unmirroredInternalLinks.add(key);
    return null;
  };

  $(ASSET_HREF_SELECTOR).each((_, element) => {
    const replacement = resolveAssetAttr($(element).attr('href'));
    if (replacement) $(element).attr('href', replacement);
  });

  $(ASSET_SRC_SELECTOR).each((_, element) => {
    for (const attribute of ['src', 'poster'] as const) {
      const value = $(element).attr(attribute);
      if (value === undefined) continue;
      const replacement = resolveAssetAttr(value);
      if (replacement) $(element).attr(attribute, replacement);
    }
  });

  $('img[srcset], source[srcset]').each((_, element) => {
    const srcset = $(element).attr('srcset');
    if (srcset) $(element).attr('srcset', rewriteSrcsetValue(srcset, resolveAssetAttr));
  });

  $(PAGE_HREF_SELECTOR).each((_, element) => {
    const replacement = resolvePageHref($(element).attr('href'));
    if (replacement) $(element).attr('href', replacement);
  });

  $('[style]').each((_, element) => {
    const style = $(element).attr('style');
    if (style) $(element).attr('style', rewriteCssUrls(style, pageUrl, lookupCssUrl));
  });

  $('style').each((_, element) => {
    const cssText = $(element).html();
    if (cssText) $(element).html(rewriteCssUrls(cssText, pageUrl, lookupCssUrl));
  });

  const shim = buildApiSnapshotShim(apiSnapshots);
  if (shim) $('head').prepend(shim);

  const finalHtml = replaceEmbeddedAssetUrls($.html(), pageLocalPath, maps.assetBySourceUrl, {
    externalUrlsLeftUnchanged,
  });

  return {
    html: finalHtml,
    externalUrlsLeftUnchanged: [...externalUrlsLeftUnchanged],
    unmirroredInternalLinks: [...unmirroredInternalLinks],
  };
}

/**
 * Beyond attributes/CSS, mirrored asset URLs can also sit as plain text inside inline <script>
 * JSON config (see extractEmbeddedMediaUrls) — those never went through an attribute rewrite
 * above, so this does one literal find/replace pass over the whole serialized page for any
 * downloaded asset whose absolute source URL still appears verbatim, in either plain or
 * backslash-escaped-slash (JSON string) form.
 *
 * Longest source URL first: a host's bare origin (e.g. `https://static.tildacdn.net/`) is a
 * literal prefix of every deeper URL on that host, so replacing it first would splice its
 * replacement into the middle of those longer URLs before they get their own turn.
 */
function replaceEmbeddedAssetUrls(
  html: string,
  pageLocalPath: string,
  assetBySourceUrl: ReadonlyMap<string, AssetRecord>,
  tracking: { externalUrlsLeftUnchanged: Set<string> },
): string {
  const byUrlLengthDescending = [...assetBySourceUrl].sort(([a], [b]) => b.length - a.length);

  let result = html;
  for (const [sourceUrl, asset] of byUrlLengthDescending) {
    if (!result.includes(sourceUrl) && !result.includes(sourceUrl.replace(/\//g, '\\/'))) continue;
    if (asset.status !== 'downloaded') {
      tracking.externalUrlsLeftUnchanged.add(sourceUrl);
      continue;
    }
    const localHref = relativeHref(pageLocalPath, asset.localPath);
    result = result
      .replaceAll(sourceUrl, localHref)
      .replaceAll(sourceUrl.replace(/\//g, '\\/'), localHref.replace(/\//g, '\\/'));
  }
  return result;
}

function rewriteSrcsetValue(value: string, resolve: (raw: string) => string | null): string {
  return value
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      const [url, ...descriptor] = trimmed.split(/\s+/);
      if (!url) return entry;
      const replacement = resolve(url);
      return [replacement ?? url, ...descriptor].join(' ');
    })
    .join(', ');
}
