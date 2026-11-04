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
 * Runs `run` with every seam wrapped to count, and restores them after.
 * Copies through `set` can't be told apart from fflate's own, about five
 * times the stream, so they aren't counted.
 */
export function countWork<T>(run: () => T): { result: T; work: Work } {
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
    return concat(chunks, size);
  };
  typedArray.slice = function (start, end) {
    const copy = slice.call(this, start, end);
    work.sliced += copy.length;
    return copy;
  };
  try {
    return { result: run(), work };
  } finally {
    tables.create = create;
    steps.inflater = inflater;
    steps.concat = concat;
    typedArray.slice = slice;
  }
}
