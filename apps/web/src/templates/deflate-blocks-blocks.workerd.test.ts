import { expect, test } from 'vitest';
import { scanDeflate } from './deflate-blocks.ts';
import { scanDeflateReference } from './deflate-blocks-reference.ts';
import { Bits, chain, dynamic } from './deflate-fixtures.test-support.ts';

const blockCount = 30_000;
// Permit every block before the final output-based budget check rejects it.
const maxOutput = 2 ** 30;
type Kind = 'dynamic-1' | 'dynamic-15' | 'chain-15';

// T15-1's empty dynamic-block bombs, reduced to keep repeated scans cheap.
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

function measure(scan: typeof scanDeflate, stream: Uint8Array) {
  const start = performance.now();
  const result = scan(stream, maxOutput);
  return { result, elapsed: performance.now() - start };
}

function median(times: number[]) {
  return times.sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
}

test.each<Kind>(['dynamic-1', 'dynamic-15', 'chain-15'])(
  'scans every %s block within 1.25x the reference table-building cost',
  kind => {
    const stream = streamFor(kind);
    const expected = scanDeflateReference(stream, maxOutput);
    expect(expected).toEqual({
      ok: false,
      reason: 'too-many-blocks',
      blocks: blockCount,
    });
    expect(scanDeflate(stream, maxOutput)).toEqual(expected);

    const currentTimes: number[] = [];
    const referenceTimes: number[] = [];
    for (let run = 0; run < 5; run++) {
      // Alternate which scanner runs first to balance warm-up and scheduling.
      const scans =
        run % 2 === 0
          ? [scanDeflate, scanDeflateReference]
          : [scanDeflateReference, scanDeflate];
      for (const scan of scans) {
        const { result, elapsed } = measure(scan, stream);
        expect(result).toEqual(expected);
        (scan === scanDeflate ? currentTimes : referenceTimes).push(elapsed);
      }
    }
    const current = median(currentTimes);
    const reference = median(referenceTimes);
    console.info(
      `${kind}: ${blockCount} blocks; median of 5 (ms): new=${current}, reference=${reference}, ratio=${current / reference}`,
    );
    // The shared VM can preempt either scan. Interleaving and medians discard
    // isolated stalls; 25% headroom catches the prior 3–4.6x per-block slowdown.
    expect(current).toBeLessThanOrEqual(reference * 1.25);
  },
  20_000,
);
