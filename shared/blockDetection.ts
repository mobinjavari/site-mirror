import type { BlockErrorType, BlockedResourceRecord } from './types.js';

const CHALLENGE_MARKERS: Array<{ pattern: RegExp; errorType: BlockErrorType }> = [
  {
    pattern: /checking your browser|just a moment|cf-chl|cf-browser-verification/i,
    errorType: 'cloudflare-challenge',
  },
  { pattern: /h?captcha|recaptcha|are you a robot/i, errorType: 'captcha' },
  {
    pattern: /verify you are human|bot verification|unusual traffic/i,
    errorType: 'bot-verification',
  },
  { pattern: /sign in to continue|please log in|login required/i, errorType: 'login-wall' },
];

function makeRecord(
  url: string,
  errorType: BlockErrorType,
  reason: string,
  httpStatus: number | undefined,
): BlockedResourceRecord {
  return {
    url,
    errorType,
    reason,
    detectedAt: new Date().toISOString(),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

/**
 * Classifies a fetched response as a protection wall using only its status code and body —
 * never attempts to see past the wall (no header spoofing, no retries, no solving).
 */
export function classifyBlock(
  url: string,
  httpStatus: number | undefined,
  bodySample: string,
): BlockedResourceRecord | null {
  if (httpStatus === 429) {
    return makeRecord(url, 'rate-limited', 'Server returned 429 Too Many Requests', httpStatus);
  }
  if (httpStatus === 401) {
    return makeRecord(url, 'login-wall', 'Server returned 401 Unauthorized', httpStatus);
  }
  if (httpStatus === 403) {
    return makeRecord(url, 'access-denied', 'Server returned 403 Forbidden', httpStatus);
  }

  for (const { pattern, errorType } of CHALLENGE_MARKERS) {
    if (pattern.test(bodySample)) {
      return makeRecord(url, errorType, `Response body matched "${pattern.source}"`, httpStatus);
    }
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return makeRecord(url, 'http-error', `Server returned ${httpStatus}`, httpStatus);
  }

  return null;
}
