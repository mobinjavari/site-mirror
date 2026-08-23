import { posix } from 'node:path';

const SITE_ROOT = 'site';
const ASSETS_DIR = '_assets';

export function safeParseUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

export function isFetchableHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

const MEDIA_EXTENSIONS = 'png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav';
const EMBEDDED_MEDIA_URL_PATTERN = new RegExp(
  `https?://[^\\s"'<>\\\\]+?\\.(?:${MEDIA_EXTENSIONS})(?:\\?[^\\s"'<>\\\\]*)?`,
  'gi',
);

/**
 * Finds absolute media URLs embedded as plain text rather than in an HTML attribute or CSS
 * `url(...)` — e.g. the "original full-size image" fields page builders like Tilda embed in
 * inline `<script>` JSON config, which their JS only dereferences on interactions (breakpoint
 * changes, lightbox zoom) a single headless render never triggers, so those URLs never show up
 * as a DOM attribute or a live network request.
 */
export function extractEmbeddedMediaUrls(text: string, baseUrl: string): URL[] {
  const unescaped = text.replace(/\\\//g, '/');
  const found = new Map<string, URL>();
  for (const match of unescaped.match(EMBEDDED_MEDIA_URL_PATTERN) ?? []) {
    const resolved = safeParseUrl(match, baseUrl);
    if (resolved && isFetchableHttpUrl(resolved)) found.set(resolved.toString(), resolved);
  }
  return [...found.values()];
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

export function isSameHost(url: URL, target: URL): boolean {
  return normalizedHostname(url.hostname) === normalizedHostname(target.hostname);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeSegment(segment: string): string {
  const decoded = safeDecodeURIComponent(segment);
  const cleaned = decoded.replace(/[\0<>:"|?*\\]/g, '_');
  return cleaned === '.' || cleaned === '..' || cleaned === '' ? '_' : cleaned;
}

function splitPathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(sanitizeSegment);
}

/** Short deterministic hash, used wherever a URL needs to become a collision-free filename fragment. */
export function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function insertBeforeExtension(filename: string, suffix: string): string {
  const ext = posix.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return `${base}${suffix}${ext}`;
}

/** Manifest-friendly identifier for a page, used for screenshot/report filenames. */
export function pageSlugForUrl(url: URL): string {
  const segments = splitPathSegments(url.pathname);
  return segments.length === 0 ? 'index' : segments.join('__');
}

/**
 * Pages are laid out as clean-URL directories (`/foo` -> `site/foo/index.html`) so that both
 * a real static host and `python -m http.server` resolve the mirrored page the same way the
 * live site's URL structure implied.
 */
export function localSitePathForPage(url: URL): string {
  const segments = splitPathSegments(url.pathname);
  if (segments.length === 0) {
    return posix.join(SITE_ROOT, 'index.html');
  }
  const last = segments[segments.length - 1] as string;
  if (posix.extname(last).toLowerCase() === '.html') {
    return posix.join(SITE_ROOT, ...segments);
  }
  return posix.join(SITE_ROOT, ...segments, 'index.html');
}

/** Assets are namespaced by source host so same-path files from different origins never collide. */
export function localSitePathForAsset(url: URL): string {
  const segments = splitPathSegments(url.pathname);
  const host = sanitizeSegment(normalizedHostname(url.hostname));
  if (segments.length === 0) {
    return posix.join(SITE_ROOT, ASSETS_DIR, host, 'index');
  }
  const last = segments[segments.length - 1] as string;
  const filename = url.search ? insertBeforeExtension(last, `__q-${shortHash(url.search)}`) : last;
  return posix.join(SITE_ROOT, ASSETS_DIR, host, ...segments.slice(0, -1), filename);
}

export function ensureExtension(localPath: string, extensionWithoutDot: string | null): string {
  if (posix.extname(localPath) || !extensionWithoutDot) return localPath;
  return `${localPath}.${extensionWithoutDot}`;
}

export function relativeHref(fromLocalFile: string, toLocalFile: string): string {
  const rel = posix.relative(posix.dirname(fromLocalFile), toLocalFile);
  return rel.startsWith('.') ? rel : `./${rel}`;
}
