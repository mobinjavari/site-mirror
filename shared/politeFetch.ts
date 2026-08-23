import type { MirrorConfig } from './types.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelayMs(range: MirrorConfig['requestDelayMs']): number {
  return range.min + Math.random() * (range.max - range.min);
}

export async function politeDelay(config: MirrorConfig): Promise<void> {
  await sleep(randomDelayMs(config.requestDelayMs));
}

export interface FetchedResource {
  ok: boolean;
  status: number;
  contentType: string | undefined;
  buffer: Buffer;
  finalUrl: string;
}

/**
 * Single-attempt, no-retry GET. Deliberately does not retry on failure/429s — retrying past a
 * rate limit or transient block is exactly the persistence this tool must not exhibit.
 */
export async function fetchResource(url: string, config: MirrorConfig): Promise<FetchedResource> {
  const response = await fetch(url, {
    headers: { 'User-Agent': config.userAgent },
    redirect: 'follow',
  });
  const arrayBuffer = await response.arrayBuffer();
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type') ?? undefined,
    buffer: Buffer.from(arrayBuffer),
    finalUrl: response.url || url,
  };
}
