// Seeded PRNG. Everything is 32-bit integer arithmetic (Math.imul, >>>) or
// exact integer doubles, so a stream is the same on every run and Node
// version. Never use Math.random or the clock in the generation path.

/** A seeded random stream. */
export interface Rng {
  /** Uniform integer in [min, max]; both safe integers, max - min a safe integer. */
  int(min: number, max: number): number;
  /** Uniformly chosen element. */
  pick<T>(items: readonly T[]): T;
  /** Element chosen with probability weights[i] / sum(weights). */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** True with probability `probability` (0 → never, 1 → always). */
  chance(probability: number): boolean;
}

const twoTo32 = 2 ** 32;
const twoTo53 = 2 ** 53;

// cyrb128: four 32-bit hashes of the UTF-16 code units of `text`.
function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

// sfc32: returns uint32 values.
function sfc32([seedA, seedB, seedC, seedD]: [number, number, number, number]) {
  let a = seedA;
  let b = seedB;
  let c = seedC;
  let d = seedD;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Discard the first outputs so similar seeds diverge.
  for (let i = 0; i < 15; i++) next();
  return next;
}

/** An independent stream for each (seed, path) pair. */
export function createRng(seed: string, path: string): Rng {
  // The length prefix keeps ("ab", "c") and ("a", "bc") apart.
  const next = sfc32(hash128(`${seed.length}:${seed}|${path}`));

  // Uniform integer in [0, n), n <= 2^53, by rejection sampling.
  const below = (n: number): number => {
    if (n <= twoTo32) {
      const limit = Math.floor(twoTo32 / n) * n;
      let x = next();
      while (x >= limit) x = next();
      return x % n;
    }
    const limit = Math.floor(twoTo53 / n) * n;
    let x: number;
    do x = (next() >>> 11) * twoTo32 + next();
    while (x >= limit);
    return x % n;
  };

  const int = (min: number, max: number): number => {
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min > max ||
      !Number.isSafeInteger(max - min)
    ) {
      throw new RangeError(`invalid integer range [${min}, ${max}]`);
    }
    return min + below(max - min + 1);
  };

  return {
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('cannot pick from nothing');
      return items[below(items.length)] as T;
    },
    weighted<T>(items: readonly T[], weights: readonly number[]): T {
      let largest = 0;
      for (const weight of weights) {
        if (!Number.isFinite(weight) || weight < 0) {
          throw new RangeError(`invalid weight ${weight}`);
        }
        largest = Math.max(largest, weight);
      }
      if (
        items.length === 0 ||
        weights.length !== items.length ||
        largest === 0
      ) {
        throw new RangeError(
          'weights need one finite entry per item and a positive sum',
        );
      }
      // Relative to the largest weight, so the total cannot overflow.
      const scaled = weights.map(weight => weight / largest);
      const total = scaled.reduce((sum, weight) => sum + weight, 0);
      const target = (below(twoTo53) / twoTo53) * total;
      let last = 0;
      let cumulative = 0;
      for (let i = 0; i < scaled.length; i++) {
        const weight = scaled[i] as number;
        if (weight === 0) continue;
        last = i;
        cumulative += weight;
        if (target < cumulative) return items[i] as T;
      }
      // Rounding can leave target at the total: take the last positive weight.
      return items[last] as T;
    },
    chance(probability: number): boolean {
      if (!(probability >= 0 && probability <= 1)) {
        throw new RangeError(`invalid probability ${probability}`);
      }
      // probability * 2^53 is exact: scaling by a power of two.
      return below(twoTo53) < probability * twoTo53;
    },
  };
}
