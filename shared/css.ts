import { isFetchableHttpUrl, safeParseUrl } from './urls.js';

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_PATTERN = /@import\s+["']([^"']+)["']/gi;

/** Extracts `url(...)` and bare-string `@import` targets from CSS text, resolved against `baseUrl`. */
export function extractCssUrls(cssText: string, baseUrl: string): URL[] {
  const found = new Map<string, URL>();
  const add = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('data:')) return;
    const resolved = safeParseUrl(trimmed, baseUrl);
    if (resolved && isFetchableHttpUrl(resolved)) found.set(resolved.toString(), resolved);
  };

  for (const match of cssText.matchAll(CSS_URL_PATTERN)) add(match[2] ?? '');
  for (const match of cssText.matchAll(CSS_IMPORT_PATTERN)) add(match[1] ?? '');

  return [...found.values()];
}

/**
 * Rewrites every `url(...)`/`@import` reference in CSS text via `resolveToLocal`, which receives
 * the fully-resolved absolute source URL and returns a replacement path, or `null` to leave it as-is.
 */
export function rewriteCssUrls(
  cssText: string,
  baseUrl: string,
  resolveToLocal: (absoluteUrl: string) => string | null,
): string {
  const replacementFor = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('data:')) return null;
    const resolved = safeParseUrl(trimmed, baseUrl);
    return resolved ? resolveToLocal(resolved.toString()) : null;
  };

  const withUrlsRewritten = cssText.replace(
    CSS_URL_PATTERN,
    (full: string, quote: string, value: string) => {
      const replacement = replacementFor(value);
      return replacement ? `url(${quote}${replacement}${quote})` : full;
    },
  );

  return withUrlsRewritten.replace(CSS_IMPORT_PATTERN, (full: string, value: string) => {
    const replacement = replacementFor(value);
    return replacement ? full.replace(value, replacement) : full;
  });
}
