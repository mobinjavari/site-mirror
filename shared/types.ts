export interface MirrorConfig {
  targetUrl: string;
  maxDepth: number;
  requestDelayMs: { min: number; max: number };
  userAgent: string;
  outputDir: string;
  verifyPages: string[];
  screenshotDiffThreshold: number;
  navigationTimeoutMs: number;
  networkIdleTimeoutMs: number;
  maxScrollAttempts: number;
}

export type BlockErrorType =
  | 'captcha'
  | 'cloudflare-challenge'
  | 'bot-verification'
  | 'login-wall'
  | 'access-denied'
  | 'rate-limited'
  | 'robots-disallowed'
  | 'network-error'
  | 'http-error';

export interface BlockedResourceRecord {
  url: string;
  errorType: BlockErrorType;
  httpStatus?: number;
  reason: string;
  detectedAt: string;
}

export type PageStatus = 'pending' | 'rendered' | 'blocked' | 'failed';

export interface CrawlManifestEntry {
  url: string;
  depth: number;
  parent: string | null;
  status: PageStatus;
  discoveredAt: string;
  httpStatus?: number;
  renderedHtmlPath?: string;
}

export interface CrawlManifest {
  targetUrl: string;
  generatedAt: string;
  pages: CrawlManifestEntry[];
  blocked: BlockedResourceRecord[];
}

export type AssetCategory = 'css' | 'js' | 'image' | 'font' | 'svg' | 'favicon' | 'media' | 'other';
export type AssetStatus = 'downloaded' | 'failed';

export interface AssetRecord {
  sourceUrl: string;
  localPath: string;
  category: AssetCategory;
  status: AssetStatus;
  foundOnPages: string[];
  contentType?: string;
  bytes?: number;
  httpStatus?: number;
  errorReason?: string;
}

export interface AssetInventory {
  generatedAt: string;
  assets: AssetRecord[];
}

export interface ExternalDependencyRecord {
  url: string;
  foundOnPages: string[];
  kind: 'iframe' | 'script' | 'embed' | 'other';
  reason: string;
}

export interface ApiSnapshotRecord {
  endpoint: string;
  method: string;
  body: string;
  contentType: string;
  capturedFromPage: string;
}

export interface RenderResult {
  pageUrl: string;
  html: string;
  screenshotPngBuffer: Buffer;
  requestedResourceUrls: string[];
  apiSnapshots: ApiSnapshotRecord[];
  externalDependencies: ExternalDependencyRecord[];
  httpStatus?: number;
  blocked?: BlockedResourceRecord;
}

export interface ValidationPageResult {
  url: string;
  localUrl: string;
  diffPixelRatio: number | null;
  passed: boolean;
  note?: string;
}
