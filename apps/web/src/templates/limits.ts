// Size limits an uploaded template pack must meet before checkPack runs.
// checkPack's time grows faster than linearly with the size of a pack's text
// (T06, PR #12): measured on this VM, a 256 KB template of nested {{#if}}
// took 57 s and 256 KB of `@font-face{` 5 s, while at 64 KiB per text file
// the worst crafted pack took under 2 s. So text files are limited one by one
// and together. Images and fonts only count toward the total size, and
// checkPack gets them empty: it only checks that they exist, and a stylesheet
// that @imports or <link>s one must not make it parse megabytes of CSS.
import type { PackFiles, PackIssue } from '@pdf-generator/template-tools';
import { unzipBounded } from './unzip.ts';

/** Largest upload body: the zip as sent. */
export const maxUploadBytes = 10 * 1024 * 1024;
/** Largest pack once unzipped, binary files included. */
export const maxPackBytes = 20 * 1024 * 1024;
/**
 * Largest single file: the print Worker refuses a pack file over 16 MiB
 * (apps/print packLimits.fileBytes), so such a pack could never print. Its
 * 24 MiB for the whole pack is above maxPackBytes.
 */
const maxFileBytes = 16 * 1024 * 1024;
const maxTextFileBytes = 64 * 1024;
const maxTextBytes = 256 * 1024;

const binary = /\.(?:png|jpe?g|gif|webp|woff2?|ttf|otf)$/i;

const whole = (code: string, message: string): PackIssue => ({
  code,
  file: '.',
  message,
});

/**
 * The zip's files to check (images and fonts emptied) when it meets every
 * limit, or the issues saying which it breaks.
 */
export function unzipWithinLimits(
  zip: Uint8Array,
): { files: PackFiles } | { issues: PackIssue[] } {
  const unzipped = unzipBounded(zip, maxPackBytes);
  if ('issue' in unzipped) return { issues: [unzipped.issue] };
  const entries = Object.entries(unzipped.files);
  const issues: PackIssue[] = [];
  let text = 0;
  for (const [path, bytes] of entries) {
    if (bytes.byteLength > maxFileBytes) {
      issues.push({
        code: 'file-too-large',
        file: path,
        message: `${path} is ${bytes.byteLength} bytes, more than the print limit of ${maxFileBytes} per file`,
      });
    }
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
  if (issues.length > 0) return { issues };
  const empty = new Uint8Array();
  return {
    files: Object.fromEntries(
      entries.map(([path, bytes]) => [path, binary.test(path) ? empty : bytes]),
    ),
  };
}
