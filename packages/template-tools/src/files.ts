// Turning the input of checkPack (zip bytes or a file map) into pack files.
import { relativePathSchema } from '@pdf-generator/contract';
import { unzipSync } from 'fflate';
import type { PackIssue } from './issues.ts';

/** A pack's files by path relative to its root: bytes, or text already decoded. */
export type PackFiles = Record<string, Uint8Array | string>;

/** Default limit on a pack's total uncompressed size. */
const defaultMaxBytes = 100 * 1024 * 1024;

const encoder = new TextEncoder();

/** Directory entries and the metadata macOS adds to zips it makes. */
const isIgnored = (path: string) =>
  path.endsWith('/') ||
  path.startsWith('__MACOSX/') ||
  path === '.DS_Store' ||
  path.endsWith('/.DS_Store');

const whole = (code: string, message: string): PackIssue => ({
  code,
  file: '.',
  message,
});

const tooLarge = (size: number, maxBytes: number) =>
  whole(
    'pack-too-large',
    `the pack is ${size} bytes uncompressed, more than the limit of ${maxBytes}`,
  );

/**
 * The pack's files with valid paths, plus an issue for every invalid path;
 * or the one issue that stops every other check.
 */
export function readFiles(
  input: Uint8Array | PackFiles,
  maxBytes = defaultMaxBytes,
): { files: Record<string, Uint8Array>; issues: PackIssue[] } | PackIssue {
  let raw: Record<string, Uint8Array>;
  if (input instanceof Uint8Array) {
    let size = 0;
    try {
      raw = unzipSync(input, {
        filter: entry => {
          size += entry.originalSize;
          return size <= maxBytes && !isIgnored(entry.name);
        },
      });
    } catch (error) {
      return whole(
        'zip-invalid',
        `not a readable zip file: ${(error as Error).message}`,
      );
    }
    if (size > maxBytes) return tooLarge(size, maxBytes);
    // A zip can understate its sizes; count what was really extracted.
    const extracted = Object.values(raw).reduce(
      (sum, bytes) => sum + bytes.byteLength,
      0,
    );
    if (extracted > maxBytes) return tooLarge(extracted, maxBytes);
  } else {
    raw = Object.fromEntries(
      Object.entries(input)
        .filter(([path]) => !isIgnored(path))
        .map(([path, value]) => [
          path,
          typeof value === 'string' ? encoder.encode(value) : value,
        ]),
    );
    const size = Object.values(raw).reduce((sum, b) => sum + b.byteLength, 0);
    if (size > maxBytes) return tooLarge(size, maxBytes);
  }

  // No prototype: a pack path such as `constructor` is just a path.
  const files: Record<string, Uint8Array> = Object.create(null);
  const issues: PackIssue[] = [];
  for (const [path, bytes] of Object.entries(raw)) {
    if (relativePathSchema.safeParse(path).success) files[path] = bytes;
    else {
      issues.push({
        code: 'path-invalid',
        file: path,
        message: `${JSON.stringify(path)} is not a path inside the pack (no leading /, .., . or empty segments, or backslashes)`,
      });
    }
  }
  return { files, issues };
}
