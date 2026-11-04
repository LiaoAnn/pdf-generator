import { expect, test } from 'vitest';
import { scanDeflate, tables } from './deflate-blocks.ts';
import { scanDeflateReference } from './deflate-blocks-reference.ts';
import { Bits, chain, dynamic } from './deflate-fixtures.test-support.ts';

const blockCount = 30_000;
// Permit every block before the final output-based budget check rejects it.
const maxOutput = 2 ** 30;
type Kind = 'dynamic-1' | 'dynamic-15' | 'chain-15';

// T15-1's empty dynamic-block bombs, reduced to keep the scans cheap.
function emptyBlock(bits: Bits, wide: boolean, final: boolean) {
  bits.put(Number(final), 1);
  bits.put(2, 2);
  bits.put(0, 5);
  bits.put(0, 5);
  bits.put(wide ? 15 : 14, 4);
  const order = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
  ];
  for (const symbol of order.slice(0, wide ? 19 : 18)) {
    bits.put(
      wide
        ? [0, 1, 15, 18].includes(symbol)
          ? 2
          : 0
        : symbol === 0
          ? 1
          : [1, 18].includes(symbol)
            ? 2
            : 0,
      3,
    );
  }
  // Canonical code-length codes, reversed: narrow 0=0,1=10,18=11;
  // wide 0=00,1=01,15=10,18=11. Repeat 256 zero literal lengths.
  for (const repeat of [138, 118]) {
    bits.put(3, 2);
    bits.put(repeat - 11, 7);
  }
  bits.put(1, 2);
  bits.put(wide ? 2 : 1, 2);
  bits.put(0, wide ? 15 : 1);
}

function streamFor(kind: Kind) {
  const bits = new Bits();
  const lengths = chain(15, 257, 256);
  for (let i = 0; i < blockCount; i++) {
    const final = i === blockCount - 1;
    if (kind === 'chain-15') {
      const block = dynamic(bits, lengths, [1], final);
      block.literal(14); // One literal using the longest code in each block.
      block.literal(256);
    } else {
      emptyBlock(bits, kind === 'dynamic-15', final);
    }
  }
  return bits.bytes();
}

/**
 * Codes longer than the tables' 9-bit root in each block's three codes:
 * none in dynamic-1, the end-of-block code in dynamic-15, and lengths 10–14
 * plus two 15-bit codes in chain-15.
 */
const longCodes: Record<Kind, number> = {
  'dynamic-1': 0,
  'dynamic-15': 1,
  'chain-15': 7,
};

test.each<Kind>(['dynamic-1', 'dynamic-15', 'chain-15'])(
  "builds three two-level code tables for each of %s's blocks",
  kind => {
    const stream = streamFor(kind);
    const expected = scanDeflateReference(stream, maxOutput);
    expect(expected).toEqual({
      ok: false,
      reason: 'too-many-blocks',
      blocks: blockCount,
    });
    // Timing this scan against T15-1's, even interleaved in the same run,
    // can fail under load (T09-4, PR #116), so count the tables it builds
    // instead. These ratios caught T15-4's first table builder (4.6x per
    // block, PR #57); a builder that makes bigger tables, more of them, or
    // more for each later block is still caught here; one as slow per table
    // with the same tables is not, and the next test counts what made it so.
    let built = 0;
    let entries = 0;
    const create = tables.create;
    tables.create = size => {
      built++;
      entries += size;
      return create(size);
    };
    let result: ReturnType<typeof scanDeflate>;
    try {
      result = scanDeflate(stream, maxOutput);
    } finally {
      tables.create = create;
    }
    expect(result).toEqual(expected);
    console.info(
      `${kind}: ${blockCount} blocks; tables: ${built}, entries: ${entries}`,
    );
    // A code-length, a literal/length and a distance table for every block.
    expect(built).toBe(3 * blockCount);
    // Each a 512-entry root, plus a subtable of at most 64 entries for each
    // code longer than 9 bits; a one-level table for 15-bit codes is 32,768.
    expect(entries).toBeLessThanOrEqual(
      blockCount * (3 * 2 ** 9 + longCodes[kind] * 2 ** 6),
    );
  },
  20_000,
);

/** Methods that call back once per element, as T15-4's first builder did. */
const callbacks = [
  'every',
  'filter',
  'find',
  'findIndex',
  'forEach',
  'map',
  'reduce',
  'some',
] as const;
const typedArrays = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
] as const;
type Prototype = Record<string, (...args: unknown[]) => unknown>;

/**
 * Runs `scan` counting element callbacks and the bytes of every typed array
 * it allocates; views of an existing buffer allocate nothing. Both are
 * counted by patching globals from here, so the scanner needs no seam.
 */
function countAllocations(scan: () => void) {
  const counted = { callbacks: 0, bytes: 0 };
  const prototypes = [
    Array.prototype,
    Object.getPrototypeOf(Uint8Array.prototype),
  ] as Prototype[];
  const methods = prototypes.map(prototype =>
    callbacks.map(name => prototype[name]),
  );
  const global = globalThis as unknown as Record<string, unknown>;
  const constructors = typedArrays.map(name => global[name]);
  for (const prototype of prototypes) {
    for (const name of callbacks) {
      const method = prototype[name];
      if (!method) continue;
      prototype[name] = function (this: unknown, fn: unknown, ...rest) {
        const counting = (...args: unknown[]) => {
          counted.callbacks++;
          return (fn as (...args: unknown[]) => unknown)(...args);
        };
        return method.call(this, counting, ...rest);
      };
    }
  }
  for (const [i, name] of typedArrays.entries()) {
    const Base = constructors[i] as Uint8ArrayConstructor;
    global[name] = class extends Base {
      constructor(...args: unknown[]) {
        super(...(args as [number]));
        if (!(args[0] instanceof ArrayBuffer)) counted.bytes += this.byteLength;
      }
    };
  }
  try {
    scan();
  } finally {
    for (const [p, prototype] of prototypes.entries()) {
      for (const [m, name] of callbacks.entries()) {
        const method = methods[p]?.[m];
        if (method) prototype[name] = method;
      }
    }
    for (const [i, name] of typedArrays.entries()) {
      global[name] = constructors[i];
    }
  }
  return counted;
}

test.each<Kind>(['dynamic-1', 'dynamic-15', 'chain-15'])(
  "builds %s's code tables in plain loops, with little scratch memory",
  kind => {
    const stream = streamFor(kind);
    let entries = 0;
    const create = tables.create;
    tables.create = size => {
      entries += size;
      return create(size);
    };
    let counted: ReturnType<typeof countAllocations>;
    try {
      counted = countAllocations(() => scanDeflate(stream, maxOutput));
    } finally {
      tables.create = create;
    }
    // Timed ratios caught T15-4's first builder, which built the same
    // tables 4.6x as slowly, and no table count can (T09-5). It called
    // back for every code length, and made scratch arrays as large as a
    // 512-slot root table for every table: each alone measured ~1.5x
    // slower (T09-6). Scanning needs a block's code lengths and two 16-entry
    // counters per table, a few hundred bytes: allow one root table, 2 KiB.
    const scratch = counted.bytes - 4 * entries;
    console.info(
      `${kind}: callbacks: ${counted.callbacks}, scratch bytes: ${scratch}`,
    );
    expect(counted.callbacks).toBe(0);
    expect(scratch).toBeLessThan(blockCount * 4 * 2 ** 9);
  },
  20_000,
);
