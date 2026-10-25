// Test support: the block scanner as T15-1 merged it (8eecdbf), frozen. It
// decodes codes longer than 9 bits one bit at a time, which is slow but
// simple: the differential tests check that the faster scanner in
// deflate-blocks.ts finds exactly what this one finds, on every stream.
// Don't change it.

// Counting a deflate stream's blocks without inflating it. Inflating costs
// little per output byte but a lot per block: a dynamic block's header makes
// fflate build its code tables, and a 10 MiB entry of ~750,000 empty blocks
// took 4.4 s of CPU in workerd while producing nothing. Honest compressors
// end a block after thousands of symbols (zlib at 16K, fflate at 7K), so a
// stream may have only a few blocks more than one per 4 KiB it produces.
//
// The walk decodes every symbol to find where a block ends, as an inflater
// must, but writes nothing and builds only small canonical tables (puff
// style, RFC 1951), so each block costs little more than its own bits.

/** Blocks any stream may have, whatever it produces. */
const freeBlocks = 8;
/** Output bytes that pay for one more block. */
const bytesPerBlock = 4096;

/** The most blocks a stream that inflates to `output` bytes may have. */
const blockBudget = (output: number) =>
  freeBlocks + Math.floor(output / bytesPerBlock);

type BlockScan =
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

interface Huffman {
  /** Codes of each length, 0 to 15. */
  count: Uint16Array;
  /** Symbols in canonical order. */
  symbol: Uint16Array;
  /**
   * By the next `fastBits` bits of input: `length << 16 | symbol` for codes
   * that short, 0 for longer ones.
   */
  fast: Int32Array;
}

const fastBits = 9;

function huffman(lengths: Uint8Array): Huffman {
  const count = new Uint16Array(16);
  for (const length of lengths) count[length] = (count[length] ?? 0) + 1;
  count[0] = 0;
  let left = 1;
  for (let length = 1; length < 16; length++) {
    left = left * 2 - (count[length] ?? 0);
    if (left < 0) throw new Invalid('over-subscribed code');
  }
  const offsets = new Uint16Array(16);
  for (let length = 1; length < 15; length++) {
    offsets[length + 1] = (offsets[length] ?? 0) + (count[length] ?? 0);
  }
  const symbol = new Uint16Array(lengths.length);
  lengths.forEach((length, value) => {
    if (!length) return;
    const slot = offsets[length] ?? 0;
    offsets[length] = slot + 1;
    symbol[slot] = value;
  });
  // Canonical codes are read most significant bit first, input bits least
  // significant first: each short code fills every slot it is a prefix of.
  const fast = new Int32Array(1 << fastBits);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= fastBits; length++) {
    for (let n = count[length] ?? 0; n > 0; n--, code++, index++) {
      let reversed = 0;
      for (let bit = 0; bit < length; bit++) {
        reversed |= ((code >> bit) & 1) << (length - 1 - bit);
      }
      const entry = (length << 16) | (symbol[index] ?? 0);
      for (let slot = reversed; slot < fast.length; slot += 1 << length) {
        fast[slot] = entry;
      }
    }
    code <<= 1;
  }
  return { count, symbol, fast };
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

/**
 * Walks a raw deflate stream block by block. Stops as soon as it produces
 * more than `maxOutput` bytes or has more blocks than `blockBudget(maxOutput)`,
 * the most any stream producing that much may have; otherwise checks the
 * count against what the stream really produces.
 */
export function scanDeflateReference(
  stream: Uint8Array,
  maxOutput: number,
): BlockScan {
  const cap = blockBudget(maxOutput);
  let at = 0;
  let buffer = 0;
  let held = 0;
  let blocks = 0;
  let output = 0;

  const bits = (need: number) => {
    while (held < need) {
      if (at >= stream.length) throw new Invalid('stream ends early');
      buffer |= (stream[at++] ?? 0) << held;
      held += 8;
    }
    const value = buffer & ((1 << need) - 1);
    buffer >>>= need;
    held -= need;
    return value;
  };

  const decode = (codes: Huffman) => {
    while (held < fastBits && at < stream.length) {
      buffer |= (stream[at++] ?? 0) << held;
      held += 8;
    }
    const entry = codes.fast[buffer & ((1 << fastBits) - 1)] ?? 0;
    const length = entry >>> 16;
    if (entry && length <= held) {
      buffer >>>= length;
      held -= length;
      return entry & 0xffff;
    }
    return decodeSlowly(codes);
  };

  const decodeSlowly = ({ count, symbol }: Huffman) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length < 16; length++) {
      code |= bits(1);
      const n = count[length] ?? 0;
      if (code - n < first) return symbol[index + code - first] ?? 0;
      index += n;
      first = (first + n) << 1;
      code <<= 1;
    }
    throw new Invalid('no such code');
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
        // Skip to the next byte; whole bytes read ahead go back.
        at -= held >> 3;
        buffer = 0;
        held = 0;
        if (at + 4 > stream.length) throw new Invalid('stream ends early');
        const length = (stream[at] ?? 0) | ((stream[at + 1] ?? 0) << 8);
        const check = (stream[at + 2] ?? 0) | ((stream[at + 3] ?? 0) << 8);
        if (length !== (~check & 0xffff))
          throw new Invalid('bad stored length');
        at += 4 + length;
        if (at > stream.length) throw new Invalid('stream ends early');
        output += length;
        if (output > maxOutput) {
          return { ok: false, reason: 'too-much-output', blocks };
        }
        continue;
      }
      if (type === 3) throw new Invalid('reserved block type');
      const { literals, distances } =
        type === 1 ? fixedCodes() : dynamicCodes();
      for (;;) {
        const symbol = decode(literals);
        if (symbol < 256) {
          output++;
        } else if (symbol === 256) {
          break;
        } else {
          const index = symbol - 257;
          if (index >= 29) throw new Invalid('bad length code');
          output += (lengthBase[index] ?? 0) + bits(lengthExtra[index] ?? 0);
          const distance = decode(distances);
          if (distance >= 30) throw new Invalid('bad distance code');
          bits(distanceExtra[distance] ?? 0);
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
  return { ok: true, blocks, output, length: at - (held >> 3) };
}
