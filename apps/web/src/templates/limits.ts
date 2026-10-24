// Size limits an uploaded template pack must meet before checkPack runs.
// checkPack's time grows faster than linearly with the size of a pack's text
// (T06, PR #12): measured on this VM, a 256 KB template of nested {{#if}}
// took 57 s and 256 KB of `@font-face{` 5 s, while at 64 KiB per text file
// the worst crafted pack took under 2 s. So text files are limited one by one
// and together; images and fonts are not parsed and only count toward the
// total size.
import type { PackFiles, PackIssue } from '@pdf-generator/template-tools';
import { unzipSync } from 'fflate';

/** Largest upload body: the zip as sent. */
export const maxUploadBytes = 10 * 1024 * 1024;
/** Largest pack once unzipped, binary files included. */
export const maxPackBytes = 20 * 1024 * 1024;
const maxFiles = 200;
const maxTextFileBytes = 64 * 1024;
const maxTextBytes = 256 * 1024;

const binary = /\.(?:png|jpe?g|gif|webp|woff2?|ttf|otf)$/i;

/** Directory entries and macOS metadata, which checkPack ignores too. */
const ignored = (path: string) =>
  path.endsWith('/') ||
  path.startsWith('__MACOSX/') ||
  path === '.DS_Store' ||
  path.endsWith('/.DS_Store');

const whole = (code: string, message: string): PackIssue => ({
  code,
  file: '.',
  message,
});

/**
 * The zip's files when it meets every limit, or the issues saying which it
 * breaks. A zip that doesn't unzip is left for checkPack to describe.
 */
export function unzipWithinLimits(
  zip: Uint8Array,
): { files: PackFiles } | { issues: PackIssue[] } | undefined {
  let files: Record<string, Uint8Array>;
  let declared = 0;
  try {
    files = unzipSync(zip, {
      filter: entry => {
        declared += entry.originalSize;
        return declared <= maxPackBytes && !ignored(entry.name);
      },
    });
  } catch {
    return undefined;
  }
  const entries = Object.entries(files);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
  if (declared > maxPackBytes || total > maxPackBytes) {
    const size = Math.max(declared, total);
    return {
      issues: [
        whole(
          'pack-too-large',
          `the pack is ${size} bytes uncompressed, more than the limit of ${maxPackBytes}`,
        ),
      ],
    };
  }
  if (entries.length > maxFiles) {
    return {
      issues: [
        whole(
          'pack-too-many-files',
          `the pack has ${entries.length} files, more than the limit of ${maxFiles}`,
        ),
      ],
    };
  }
  const issues: PackIssue[] = [];
  let text = 0;
  for (const [path, bytes] of entries) {
    if (binary.test(path)) continue;
    text += bytes.byteLength;
    if (bytes.byteLength > maxTextFileBytes) {
      issues.push({
        code: 'file-too-large',
        file: path,
        message: `${path} is ${bytes.byteLength} bytes, more than the limit of ${maxTextFileBytes} for a text file`,
      });
    }
  }
  if (text > maxTextBytes) {
    issues.push(
      whole(
        'pack-text-too-large',
        `the pack's text files are ${text} bytes together, more than the limit of ${maxTextBytes}`,
      ),
    );
  }
  return issues.length > 0 ? { issues } : { files };
}
