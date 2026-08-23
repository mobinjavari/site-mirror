import { mkdir, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { writeJsonFile } from '../shared/manifest.js';
import type {
  AssetInventory,
  BlockedResourceRecord,
  CrawlManifest,
  ExternalDependencyRecord,
  MirrorConfig,
  ValidationPageResult,
} from '../shared/types.js';

export interface ReportInputs {
  config: MirrorConfig;
  manifest: CrawlManifest;
  inventory: AssetInventory;
  downloadBlocked: BlockedResourceRecord[];
  externalDependencies: ExternalDependencyRecord[];
  unmirroredInternalLinks: string[];
  validationResults: ValidationPageResult[];
}

function buildValidationReport(inputs: ReportInputs): string {
  const {
    config,
    manifest,
    inventory,
    externalDependencies,
    unmirroredInternalLinks,
    validationResults,
  } = inputs;
  const renderedPages = manifest.pages.filter((page) => page.status === 'rendered');
  const failedAssets = inventory.assets.filter((asset) => asset.status === 'failed');
  const downloadedAssets = inventory.assets.filter((asset) => asset.status === 'downloaded');
  const passedChecks = validationResults.filter((result) => result.passed).length;

  const lines: string[] = [
    '# Validation Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Target: ${config.targetUrl}`,
    '',
    '## Pages Rendered',
    '',
  ];

  if (renderedPages.length === 0) {
    lines.push('_No pages were successfully rendered._');
  } else {
    for (const page of renderedPages) {
      lines.push(`- ${page.url} → \`${page.renderedHtmlPath}\``);
    }
  }

  const pagesWithHttpErrors = renderedPages.filter((page) => (page.httpStatus ?? 200) >= 400);
  lines.push('', '## HTTP Errors', '');
  if (pagesWithHttpErrors.length === 0) {
    lines.push('_None — every rendered page returned a successful status._');
  } else {
    for (const page of pagesWithHttpErrors) lines.push(`- ${page.url} → HTTP ${page.httpStatus}`);
  }

  lines.push('', '## Visual Comparison (online vs. local)', '');
  if (validationResults.length === 0) {
    lines.push('_No pages were configured for visual validation._');
  } else {
    lines.push('| Page | Local URL | Pixel Diff | Result |', '|---|---|---|---|');
    for (const result of validationResults) {
      const diffLabel =
        result.diffPixelRatio === null ? 'n/a' : `${(result.diffPixelRatio * 100).toFixed(2)}%`;
      const status = result.passed ? '✅ pass' : `❌ fail${result.note ? ` — ${result.note}` : ''}`;
      lines.push(`| ${result.url} | ${result.localUrl || 'n/a'} | ${diffLabel} | ${status} |`);
    }
  }

  lines.push('', '## Missing / Failed Assets', '');
  if (failedAssets.length === 0) {
    lines.push('_None — every discovered asset downloaded successfully._');
  } else {
    lines.push('| Source URL | Category | HTTP Status | Reason |', '|---|---|---|---|');
    for (const asset of failedAssets) {
      lines.push(
        `| ${asset.sourceUrl} | ${asset.category} | ${asset.httpStatus ?? 'n/a'} | ${asset.errorReason ?? 'unknown'} |`,
      );
    }
  }

  lines.push('', '## External Dependencies (left unchanged, not mirrored)', '');
  if (externalDependencies.length === 0) {
    lines.push('_None found._');
  } else {
    lines.push('| URL | Kind | Reason |', '|---|---|---|');
    for (const dependency of externalDependencies) {
      lines.push(`| ${dependency.url} | ${dependency.kind} | ${dependency.reason} |`);
    }
  }

  lines.push('', '## Internal Links Not Mirrored', '');
  if (unmirroredInternalLinks.length === 0) {
    lines.push('_None — every same-domain link discovered was also mirrored._');
  } else {
    for (const link of unmirroredInternalLinks) lines.push(`- ${link}`);
  }

  lines.push(
    '',
    '## Summary',
    '',
    `- Pages discovered: ${manifest.pages.length}`,
    `- Pages rendered: ${renderedPages.length}`,
    `- Assets downloaded: ${downloadedAssets.length} / ${inventory.assets.length}`,
    `- Visual checks passed: ${passedChecks} / ${validationResults.length}`,
    '',
  );

  return lines.join('\n');
}

function buildErrorReport(inputs: ReportInputs): string {
  const allBlocked = [...inputs.manifest.blocked, ...inputs.downloadBlocked];
  const lines: string[] = ['# Error Report', '', `Generated: ${new Date().toISOString()}`, ''];

  lines.push('## Blocked, Protected, or Disallowed Resources', '');
  if (allBlocked.length === 0) {
    lines.push(
      '_No CAPTCHAs, Cloudflare challenges, bot-verification walls, login walls, access-denied',
      'responses, or rate limiting were encountered while mirroring this site._',
    );
  } else {
    lines.push(
      '| URL | Error Type | HTTP Status | Reason | Detected At |',
      '|---|---|---|---|---|',
    );
    for (const record of allBlocked) {
      lines.push(
        `| ${record.url} | ${record.errorType} | ${record.httpStatus ?? 'n/a'} | ${record.reason} | ${record.detectedAt} |`,
      );
    }
  }

  lines.push(
    '',
    '_No bypass techniques (proxy rotation, fingerprint spoofing, CAPTCHA solving) were attempted for any of the above._',
    '',
  );
  return lines.join('\n');
}

export async function writeReports(inputs: ReportInputs): Promise<void> {
  const reportsDir = posix.join(inputs.config.outputDir, 'reports');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(
    posix.join(reportsDir, 'validation-report.md'),
    buildValidationReport(inputs),
    'utf8',
  );
  await writeFile(posix.join(reportsDir, 'error-report.md'), buildErrorReport(inputs), 'utf8');
  await writeJsonFile(posix.join(reportsDir, 'asset-inventory.json'), inputs.inventory);
}
