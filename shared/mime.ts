import { extension as mimeExtension, lookup as mimeLookup } from 'mime-types';
import { posix } from 'node:path';
import type { AssetCategory } from './types.js';

export function extensionForContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const bareType = contentType.split(';')[0]?.trim();
  if (!bareType) return null;
  const ext = mimeExtension(bareType);
  return ext || null;
}

const CATEGORY_BY_EXTENSION: Record<string, AssetCategory> = {
  css: 'css',
  js: 'js',
  mjs: 'js',
  svg: 'svg',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  eot: 'font',
  ico: 'favicon',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  mp4: 'media',
  mov: 'media',
  webm: 'media',
  mp3: 'media',
  wav: 'media',
  ogg: 'media',
};

export function categorizeAsset(url: URL, contentType: string | undefined): AssetCategory {
  const path = url.pathname.toLowerCase();
  if (path.includes('favicon')) return 'favicon';

  const ext = posix.extname(path).replace('.', '');
  if (ext && CATEGORY_BY_EXTENSION[ext]) return CATEGORY_BY_EXTENSION[ext];

  const mimeType = contentType?.split(';')[0]?.trim() ?? (mimeLookup(path) || '');
  if (mimeType === 'image/svg+xml') return 'svg';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('font/') || mimeType.includes('font')) return 'font';
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return 'media';
  if (mimeType === 'text/css') return 'css';
  if (mimeType === 'application/javascript' || mimeType === 'text/javascript') return 'js';

  return 'other';
}
