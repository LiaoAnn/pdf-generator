// Counting a deflate stream's blocks without inflating it. Inflating costs
// little per output byte but a lot per block: a dynamic block's header makes
// fflate build its code tables, and a 10 MiB entry of ~750,000 empty blocks
// took 4.4 s of CPU in workerd while producing nothing. Honest compressors
// end a block after thousands of symbols (zlib at 16K, fflate at 7K), so a
// stream may have only a few blocks more than one per 4 KiB it produces.
//
// The walk decodes every symbol to find where a block ends, as an inflater
// must, but writes nothing. Its tables are zlib's two-level ones: a 9-bit
// table, and a small subtable for each 9-bit prefix of longer codes, so a
// 15-bit code costs two lookups, and building them costs each block little.

/** Blocks any stream may have, whatever it produces. */
const freeBlocks = 8;
/** Output bytes that pay for one more block. */
const bytesPerBlock = 4096;

/** The most blocks a stream that inflates to `output` bytes may have. */
const blockBudget = (output: number) =>
  freeBlocks + Math.floor(output / bytesPerBlock);

export type BlockScan =
  | {
      ok: true;
      blocks: number;
      output: number;
      /** Bytes the stream uses; any after its final block are not deflate. */
      length: number;
    }
  | {
      ok: false;
      reason: 'too-many-blocks' | 'too-much-output' | 'invalid';
      blocks: number;
    };

class Invalid extends Error {}

/**
 * A code's decoding table, indexed by the next `rootBits` bits of input:
 * `length << 16 | symbol` where a code that short starts, or for longer
 * codes `link | bits << 16 | at`, a subtable at `at` indexed by the `bits`
 * bits after those. 0 where no code starts, as in an incomplete code.
 */
type Huffman = Int32Array;

const rootBits = 9;
const rootMask = (1 << rootBits) - 1;
const link = 1 << 20;

/** Each `rootBits`-bit number with its bits in reverse order. */
const reversed = new Uint16Array(1 << rootBits);
for (let n = 1; n < reversed.length; n++) {
  reversed[n] = ((reversed[n >> 1] ?? 0) >> 1) | ((n & 1) << (rootBits - 1));
}

/** `code`, `length` bits long and no longer than `rootBits`, reversed. */
const reverse = (code: number, length: number) =>
  (reversed[code] ?? 0) >> (rootBits - length);

// Scratch space for huffman(), which runs once per table: three for each
// dynamic block, so allocating it each time would cost more than it does.
const codes = new Uint16Array(320);
/** By root slot: how many bits its subtable is indexed by, 0 for none. */
const widest = new Uint8Array(1 << rootBits);
const offsets = new Uint16Array(1 << rootBits);

function huffman(lengths: Uint8Array): Huffman {
  const count = new Uint16Array(16);
  for (let value = 0; value < lengths.length; value++) {
    const length = lengths[value] ?? 0;
    count[length] = (count[length] ?? 0) + 1;
  }
  count[0] = 0;
  let left = 1;
  for (let length = 1; length < 16; length++) {
    left = left * 2 - (count[length] ?? 0);
    if (left < 0) throw new Invalid('over-subscribed code');
  }
  // Canonical codes, most significant bit first: each length's codes follow
  // the shorter ones', in symbol order.
  const next = new Uint16Array(16);
  for (let length = 1; length < 16; length++) {
    next[length] = ((next[length - 1] ?? 0) + (count[length - 1] ?? 0)) << 1;
  }
  // Longer codes sharing their first `rootBits` bits share a subtable, as
  // wide as the longest of them needs.
  const roots: number[] = [];
  for (let value = 0; value < lengths.length; value++) {
    const length = lengths[value] ?? 0;
    if (!length) continue;
    const code = next[length] ?? 0;
    next[length] = code + 1;
    codes[value] = code;
    if (length <= rootBits) continue;
    const root = reverse(code >> (length - rootBits), rootBits);
    if (!widest[root]) roots.push(root);
    widest[root] = Math.max(widest[root] ?? 0, length - rootBits);
  }
  let size = 1 << rootBits;
  for (const root of roots) {
    offsets[root] = size;
    size += 1 << (widest[root] ?? 0);
  }
  // Input bits come least significant first, so a code fills every slot
  // whose low bits are the code reversed.
  const table = new Int32Array(size);
  for (const root of roots) {
    table[root] = link | ((widest[root] ?? 0) << 16) | (offsets[root] ?? 0);
  }
  for (let value = 0; value < lengths.length; value++) {
    const length = lengths[value] ?? 0;
    if (!length) continue;
    const code = codes[value] ?? 0;
    const entry = (length << 16) | value;
    if (length <= rootBits) {
      const step = 1 << length;
      for (let slot = reverse(code, length); slot <= rootMask; slot += step) {
        table[slot] = entry;
      }
      continue;
    }
    const rest = length - rootBits;
    const root = reverse(code >> rest, rootBits);
    const base = offsets[root] ?? 0;
    const end = 1 << (widest[root] ?? 0);
    const step = 1 << rest;
    const first = reverse(code & ((1 << rest) - 1), rest);
    for (let slot = first; slot < end; slot += step) table[base + slot] = entry;
  }
  for (const root of roots) widest[root] = 0;
  return table;
}

const lengthBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const lengthExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const distanceExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
/** Order in which a dynamic header gives the code length code's lengths. */
const lengthOrder = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

/** The table entry for the code at the start of `buffer`, 0 if none. */
function lookup(table: Huffman, buffer: number) {
  const entry = table[buffer & rootMask] ?? 0;
  if (!(entry & link)) return entry;
  const sub = (buffer >>> rootBits) & ((1 << ((entry >>> 16) & 0xf)) - 1);
  return table[(entry & 0xffff) + sub] ?? 0;
}

let fixed: { literals: Huffman; distances: Huffman } | undefined;
function fixedCodes() {
  if (!fixed) {
    const literals = new Uint8Array(288);
    literals.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280);
    literals.fill(8, 280);
    fixed = {
      literals: huffman(literals),
      distances: huffman(new Uint8Array(30).fill(5)),
    };
  }
  return fixed;
}

/** At least 17 bits of `stream` from bit `pos` on, zeros past its end. */
function peek(stream: Uint8Array, pos: number) {
  const at = pos >> 3;
  return (
    ((stream[at] ?? 0) |
      ((stream[at + 1] ?? 0) << 8) |
      ((stream[at + 2] ?? 0) << 16)) >>>
    (pos & 7)
  );
}

/**
 * Walks a raw deflate stream block by block. Stops as soon as it produces
 * more than `maxOutput` bytes or has more blocks than `blockBudget(maxOutput)`,
 * the most any stream producing that much may have; otherwise checks the
 * count against what the stream really produces.
 */
export function scanDeflate(stream: Uint8Array, maxOutput: number): BlockScan {
  const cap = blockBudget(maxOutput);
  const end = stream.length * 8;
  /** Bits read so far. */
  let pos = 0;
  let blocks = 0;
  let output = 0;

  const bits = (need: number) => {
    const value = peek(stream, pos) & ((1 << need) - 1);
    pos += need;
    if (pos > end) throw new Invalid('stream ends early');
    return value;
  };

  const decode = (table: Huffman) => {
    const entry = lookup(table, peek(stream, pos));
    if (!entry) throw new Invalid('no such code');
    pos += entry >>> 16;
    if (pos > end) throw new Invalid('stream ends early');
    return entry & 0xffff;
  };

  const dynamicCodes = () => {
    const literalCount = bits(5) + 257;
    const distanceCount = bits(5) + 1;
    const lengthCount = bits(4) + 4;
    if (literalCount > 286 || distanceCount > 30) {
      throw new Invalid('too many codes');
    }
    const order = new Uint8Array(19);
    for (let i = 0; i < lengthCount; i++) order[lengthOrder[i] ?? 0] = bits(3);
    const lengthCode = huffman(order);
    const lengths = new Uint8Array(literalCount + distanceCount);
    for (let i = 0; i < lengths.length; ) {
      const symbol = decode(lengthCode);
      if (symbol < 16) {
        lengths[i++] = symbol;
        continue;
      }
      let value = 0;
      let repeat: number;
      if (symbol === 16) {
        if (i === 0) throw new Invalid('repeat with no length');
        value = lengths[i - 1] ?? 0;
        repeat = 3 + bits(2);
      } else if (symbol === 17) {
        repeat = 3 + bits(3);
      } else {
        repeat = 11 + bits(7);
      }
      if (i + repeat > lengths.length) throw new Invalid('too many lengths');
      lengths.fill(value, i, i + repeat);
      i += repeat;
    }
    if (!lengths[256]) throw new Invalid('no end-of-block code');
    return {
      literals: huffman(lengths.subarray(0, literalCount)),
      distances: huffman(lengths.subarray(literalCount)),
    };
  };

  try {
    let last = 0;
    while (!last) {
      if (++blocks > cap) {
        return { ok: false, reason: 'too-many-blocks', blocks };
      }
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        // Stored data starts at the next byte.
        let at = (pos + 7) >> 3;
        if (at + 4 > stream.length) throw new Invalid('stream ends early');
        const length = (stream[at] ?? 0) | ((stream[at + 1] ?? 0) << 8);
        const check = (stream[at + 2] ?? 0) | ((stream[at + 3] ?? 0) << 8);
        if (length !== (~check & 0xffff))
          throw new Invalid('bad stored length');
        at += 4 + length;
        if (at > stream.length) throw new Invalid('stream ends early');
        pos = at * 8;
        output += length;
        if (output > maxOutput) {
          return { ok: false, reason: 'too-much-output', blocks };
        }
        continue;
      }
      if (type === 3) throw new Invalid('reserved block type');
      const { literals, distances } =
        type === 1 ? fixedCodes() : dynamicCodes();
      // Most of a stream's bits: decoded inline, past the end of the stream
      // as if it went on with zeros, and checked once per symbol.
      for (;;) {
        let entry = lookup(literals, peek(stream, pos));
        if (!entry) throw new Invalid('no such code');
        pos += entry >>> 16;
        if (pos > end) throw new Invalid('stream ends early');
        const symbol = entry & 0xffff;
        if (symbol < 256) {
          output++;
        } else if (symbol === 256) {
          break;
        } else {
          const index = symbol - 257;
          if (index >= 29) throw new Invalid('bad length code');
          const extra = lengthExtra[index] ?? 0;
          output +=
            (lengthBase[index] ?? 0) + (peek(stream, pos) & ((1 << extra) - 1));
          pos += extra;
          entry = lookup(distances, peek(stream, pos));
          if (!entry) throw new Invalid('no such code');
          pos += entry >>> 16;
          const distance = entry & 0xffff;
          if (distance >= 30) throw new Invalid('bad distance code');
          pos += distanceExtra[distance] ?? 0;
          if (pos > end) throw new Invalid('stream ends early');
        }
        if (output > maxOutput) break;
      }
      if (output > maxOutput) {
        return { ok: false, reason: 'too-much-output', blocks };
      }
    }
  } catch (error) {
    if (error instanceof Invalid)
      return { ok: false, reason: 'invalid', blocks };
    throw error;
  }
  if (blocks > blockBudget(output)) {
    return { ok: false, reason: 'too-many-blocks', blocks };
  }
  return { ok: true, blocks, output, length: (pos + 7) >> 3 };
}
