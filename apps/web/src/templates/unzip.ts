// Unzipping an untrusted pack without trusting its headers. A zip entry may
// declare 10 bytes and hold a deflate stream of gigabytes; unzipSync inflates
// all of it and returns the declared 10. Here the zip is inflated as a stream,
// a few kilobytes of input at a time, counting what each entry really holds,
// and stops at the first entry larger than it says or once the pack is larger
// than `maxBytes`.
import type { PackIssue } from '@pdf-generator/template-tools';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';

/** Input per step: one step inflates to at most ~1000 times this. */
const slice = 8 * 1024;

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

const tooLarge = (size: number, maxBytes: number) =>
  whole(
    'pack-too-large',
    `the pack is more than ${size} bytes uncompressed, more than the limit of ${maxBytes}`,
  );

/**
 * The pack's files (directories and macOS metadata left out), or the one
 * issue that stops the upload: an unreadable zip, an entry whose data is
 * larger than its header says, or more than `maxBytes` in all.
 */
export function unzipBounded(
  zip: Uint8Array,
  maxBytes: number,
): { files: Record<string, Uint8Array> } | { issue: PackIssue } {
  // The central directory, read without inflating anything: what each entry
  // says it holds. Its errors read as checkPack's own zip-invalid.
  const declared = new Map<string, number>();
  let total = 0;
  try {
    unzipSync(zip, {
      filter: entry => {
        declared.set(entry.name, entry.originalSize);
        total += entry.originalSize;
        return false;
      },
    });
  } catch (error) {
    return {
      issue: whole(
        'zip-invalid',
        `not a readable zip file: ${(error as Error).message}`,
      ),
    };
  }
  if (total > maxBytes) return { issue: tooLarge(total, maxBytes) };

  const files: Record<string, Uint8Array> = {};
  let inflated = 0;
  let stop: PackIssue | undefined;
  const unzip = new Unzip(file => {
    if (ignored(file.name) || stop) return;
    const limit = declared.get(file.name) ?? 0;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (stop) return;
      if (error) {
        stop = whole(
          'zip-invalid',
          `not a readable zip file: ${file.name}: ${error.message}`,
        );
        return;
      }
      size += data.byteLength;
      inflated += data.byteLength;
      if (size > limit) {
        stop = {
          code: 'zip-invalid',
          file: file.name,
          message: `${file.name} holds more data than its zip header says (${limit} bytes)`,
        };
      } else if (inflated > maxBytes) {
        stop = tooLarge(maxBytes, maxBytes);
      }
      if (stop) {
        file.terminate();
        return;
      }
      chunks.push(data);
      if (final) {
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.byteLength;
        }
        files[file.name] = bytes;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let at = 0; at < zip.byteLength && !stop; at += slice) {
      const end = Math.min(at + slice, zip.byteLength);
      unzip.push(zip.subarray(at, end), end === zip.byteLength);
    }
  } catch (error) {
    stop ??= whole(
      'zip-invalid',
      `not a readable zip file: ${(error as Error).message}`,
    );
  }
  if (stop) return { issue: stop };
  return { files };
}
