import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Returns the fraction of mismatched pixels (0 = identical, 1 = fully different), or null if either capture is unusable. */
export function diffScreenshots(
  onlinePng: Buffer,
  localPng: Buffer,
): { ratio: number; diffPngBuffer: Buffer } | null {
  if (onlinePng.length === 0 || localPng.length === 0) return null;

  const online = PNG.sync.read(onlinePng);
  const local = PNG.sync.read(localPng);
  const width = Math.min(online.width, local.width);
  const height = Math.min(online.height, local.height);
  if (width === 0 || height === 0) return null;

  const onlineCropped = cropTo(online, width, height);
  const localCropped = cropTo(local, width, height);
  const diff = new PNG({ width, height });

  const mismatchedPixels = pixelmatch(
    onlineCropped.data,
    localCropped.data,
    diff.data,
    width,
    height,
    {
      threshold: 0.1,
    },
  );

  return { ratio: mismatchedPixels / (width * height), diffPngBuffer: PNG.sync.write(diff) };
}

function cropTo(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const cropped = new PNG({ width, height });
  PNG.bitblt(png, cropped, 0, 0, width, height, 0, 0);
  return cropped;
}
