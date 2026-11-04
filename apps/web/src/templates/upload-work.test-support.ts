// Counting the work an upload's unzip does, for tests that would otherwise
// time it: fixed millisecond bounds fail under load (T09-4, T09-6). The
// counts go through the seams the upload runs through (tables.create,
// steps.inflater and steps.concat), and every typed array `slice`.
import { tables } from './deflate-blocks.ts';
import { steps } from './unzip.ts';

/** What `countWork` counted while its callback ran. */
type Work = {
  /** Decoding tables the scan built. */
  tables: number;
  /** Inflaters made, one per entry inflated. */
  inflaters: number;
  /** Bytes of deflate data pushed into inflaters. */
  pushed: number;
  /** Bytes the inflaters produced. */
  inflated: number;
  /** Bytes copied by `steps.concat`. */
  concatenated: number;
  /** Bytes copied by typed array `slice`; fflate never calls it. */
  sliced: number;
};

/** Every typed array's `slice`, which copies. */
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as {
  slice(this: Uint8Array, start?: number, end?: number): Uint8Array;
};

/**
 * `copy`, recording in `read` how far into it anything reads, and refusing
 * reads past `limit` so a scan that would read all of it stops at once.
 */
function watched(copy: Uint8Array, limit: number, read: { bytes: number }) {
  return new Proxy(copy, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        read.bytes = Math.max(read.bytes, Number(key) + 1);
        if (read.bytes > limit) {
          throw new Error(`read byte ${key}, past the first ${limit}`);
        }
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Runs `run` with every seam wrapped to count, and restores them after.
 * Copies through `set` can't be told apart from fflate's own, about five
 * times the stream, so they aren't counted. With `readLimit`, every copy
 * `steps.concat` makes is watched: `read` is how far into one anything
 * read, and reading past `readLimit` throws.
 */
export function countWork<T>(
  run: () => T,
  { readLimit }: { readLimit?: number } = {},
): { result: T; work: Work; read: number } {
  const read = { bytes: 0 };
  const work: Work = {
    tables: 0,
    inflaters: 0,
    pushed: 0,
    inflated: 0,
    concatenated: 0,
    sliced: 0,
  };
  const create = tables.create;
  const inflater = steps.inflater;
  const concat = steps.concat;
  const slice = typedArray.slice;
  tables.create = size => {
    work.tables++;
    return create(size);
  };
  steps.inflater = ondata => {
    work.inflaters++;
    const inflate = inflater((data, final) => {
      work.inflated += data.length;
      ondata(data, final);
    });
    const push = inflate.push.bind(inflate);
    inflate.push = (chunk, final) => {
      work.pushed += chunk.length;
      push(chunk, final);
    };
    return inflate;
  };
  steps.concat = (chunks, size) => {
    work.concatenated += size;
    const copy = concat(chunks, size);
    return readLimit === undefined ? copy : watched(copy, readLimit, read);
  };
  typedArray.slice = function (start, end) {
    const copy = slice.call(this, start, end);
    work.sliced += copy.length;
    return copy;
  };
  try {
    return { result: run(), work, read: read.bytes };
  } finally {
    tables.create = create;
    steps.inflater = inflater;
    steps.concat = concat;
    typedArray.slice = slice;
  }
}
