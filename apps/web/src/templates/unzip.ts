// Unzipping an untrusted pack without trusting its headers. A zip entry may
// declare 10 bytes and hold a deflate stream of gigabytes; unzipSync inflates
// all of it and returns the declared 10. Here the zip is inflated as a stream,
// a few kilobytes of input at a time, counting what each entry really holds,
// and stops at the first entry larger than it says or once the pack is larger
// than `maxBytes`. Entries are counted too, directories included: walking
// hundreds of thousands of tiny ones takes seconds. A name may appear only
// once: with two, which file a reader gets depends on the reader. The pack's
// files are counted from the directory too, before anything is inflated. And
// a deflated entry's blocks are counted before it is inflated
// (deflate-blocks).
import type { PackIssue } from '@pdf-generator/template-tools';
import {
  type FlateError,
  Inflate,
  Unzip,
  type UnzipDecoder,
  unzipSync,
} from 'fflate';
import { scanDeflate } from './deflate-blocks.ts';

/** Input per step: one step inflates to at most ~1000 times this. */
const slice = 8 * 1024;
/** Most entries a pack's zip may have, directories included. */
const maxEntries = 1000;
/** Most files a pack may have, directories and macOS metadata left out. */
const maxFiles = 200;

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

const tooMany = () =>
  whole(
    'pack-too-many-files',
    `the zip has more than ${maxEntries} entries (files and folders)`,
  );

const tooManyFiles = (files: number) =>
  whole(
    'pack-too-many-files',
    `the pack has ${files} files, more than the limit of ${maxFiles}`,
  );

const tooLarge = (size: number, maxBytes: number) =>
  whole(
    'pack-too-large',
    `the pack is more than ${size} bytes uncompressed, more than the limit of ${maxBytes}`,
  );

const duplicate = (name: string): PackIssue => ({
  code: 'zip-duplicate-name',
  file: name,
  message: `${name} is in the zip more than once`,
});

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

const understated = (name: string, limit: number): PackIssue => ({
  code: 'zip-invalid',
  file: name,
  message: `${name} holds more data than its zip header says (${limit} bytes)`,
});

/** Why a deflated entry was refused before inflating it. */
class Refusal extends Error implements FlateError {
  code = 0;
  readonly issue: PackIssue;

  constructor(issue: PackIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

/**
 * fflate's inflater for deflated entries, run only once the entry's whole
 * stream has been scanned and stays within its block budget. A stream may
 * have at most the blocks the entry's size in the zip directory pays for.
 */
function blockCheckedInflate(declared: ReadonlyMap<string, number>) {
  return class implements UnzipDecoder {
    static compression = 8;
    ondata: UnzipDecoder['ondata'] = () => {};
    readonly #name: string;
    #chunks: Uint8Array[] = [];
    #size = 0;
    #stopped = false;

    constructor(name: string) {
      this.#name = name;
    }

    push(chunk: Uint8Array, final: boolean) {
      this.#chunks.push(chunk);
      this.#size += chunk.byteLength;
      if (!final) return;
      const stream = concat(this.#chunks, this.#size);
      this.#chunks = [];
      const limit = declared.get(this.#name) ?? 0;
      const scan = scanDeflate(stream, limit);
      if (!scan.ok) {
        const error =
          scan.reason === 'too-many-blocks'
            ? new Refusal({
                code: 'zip-too-many-blocks',
                file: this.#name,
                message: `${this.#name} is split into more deflate blocks than its data pays for (8, plus one per 4096 bytes)`,
              })
            : scan.reason === 'too-much-output'
              ? new Refusal(understated(this.#name, limit))
              : Object.assign(new Error('invalid deflate data'), { code: 1 });
        this.ondata(error, new Uint8Array(), true);
        return;
      }
      // Bytes after the final block are left out: fflate would copy them
      // again on every push, quadratic in their length.
      const deflated = stream.subarray(0, scan.length);
      const inflate = new Inflate((data, last) =>
        this.ondata(null, data, last),
      );
      try {
        for (let at = 0; at < deflated.byteLength && !this.#stopped; ) {
          const end = Math.min(at + slice, deflated.byteLength);
          inflate.push(deflated.subarray(at, end), end === deflated.byteLength);
          at = end;
        }
      } catch (error) {
        this.ondata(error as FlateError, new Uint8Array(), true);
      }
    }

    terminate() {
      this.#stopped = true;
    }
  };
}

/**
 * The pack's files (directories and macOS metadata left out), or the one
 * issue that stops the upload: an unreadable zip, a name used twice, more
 * than 200 files, an entry whose data is larger than its header says, or
 * more than `maxBytes` in all.
 */
export function unzipBounded(
  zip: Uint8Array,
  maxBytes: number,
): { files: Record<string, Uint8Array> } | { issue: PackIssue } {
  // The central directory, read without inflating anything: what each entry
  // says it holds. Its errors read as checkPack's own zip-invalid.
  const declared = new Map<string, number>();
  let total = 0;
  let listed = 0;
  let packFiles = 0;
  const overflow = new Error('too many entries');
  let repeated: string | undefined;
  try {
    unzipSync(zip, {
      filter: entry => {
        if (++listed > maxEntries) throw overflow;
        if (declared.has(entry.name)) {
          repeated = entry.name;
          throw overflow;
        }
        declared.set(entry.name, entry.originalSize);
        total += entry.originalSize;
        if (!ignored(entry.name)) packFiles++;
        return false;
      },
    });
  } catch (error) {
    if (repeated !== undefined) return { issue: duplicate(repeated) };
    if (error === overflow) return { issue: tooMany() };
    return {
      issue: whole(
        'zip-invalid',
        `not a readable zip file: ${(error as Error).message}`,
      ),
    };
  }
  if (total > maxBytes) return { issue: tooLarge(total, maxBytes) };
  // Counted from the directory, before inflating anything. A zip whose data
  // holds fewer of them than its directory lists is refused too: which files
  // a reader finds would depend on the reader.
  if (packFiles > maxFiles) return { issue: tooManyFiles(packFiles) };

  const files: Record<string, Uint8Array> = {};
  let inflated = 0;
  const seen = new Set<string>();
  let stop: PackIssue | undefined;
  const unzip = new Unzip(file => {
    if (stop) return;
    if (seen.size >= maxEntries) {
      stop = tooMany();
      return;
    }
    if (seen.has(file.name)) {
      stop = duplicate(file.name);
      return;
    }
    seen.add(file.name);
    const limit = declared.get(file.name);
    if (limit === undefined) {
      stop = {
        code: 'zip-invalid',
        file: file.name,
        message: `${file.name} is in the zip's data but not in its directory`,
      };
      return;
    }
    if (ignored(file.name)) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (stop) return;
      if (error instanceof Refusal) {
        stop = error.issue;
        return;
      }
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
        stop = understated(file.name, limit);
      } else if (inflated > maxBytes) {
        stop = tooLarge(maxBytes, maxBytes);
      }
      if (stop) {
        file.terminate();
        return;
      }
      chunks.push(data);
      if (final) files[file.name] = concat(chunks, size);
    };
    file.start();
  });
  unzip.register(blockCheckedInflate(declared));
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
