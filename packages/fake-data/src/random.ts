// Seeded PRNG. Everything is 32-bit integer arithmetic (Math.imul, >>>) or
// exact integer doubles, so a stream is the same on every run and Node
// version. Never use Math.random or the clock in the generation path.

/** A seeded random stream. */
export interface Rng {
  /** Uniform integer in [min, max]; both safe integers, max - min a safe integer. */
  int(min: number, max: number): number;
  /** Uniformly chosen element. */
  pick<T>(items: readonly T[]): T;
  /**
   * Element chosen with probability weights[i] / sum(weights). Pass a
   * `weightTable` to draw many times from the same weights.
   */
  weighted<T>(items: readonly T[], weights: readonly number[] | WeightTable): T;
  /** True with probability `probability` (0 → never, 1 → always). */
  chance(probability: number): boolean;
}

const twoTo32 = 2 ** 32;
const twoTo53 = 2 ** 53;

/** Weights prepared once by `weightTable`, for many weighted draws. */
export type WeightTable = {
  /** Running sums of the weights, scaled so the largest is 1. */
  readonly cumulative: readonly number[];
  /** Index of the last positive weight. */
  readonly last: number;
};

/** Checks `weights` and sums them once, so each draw is a binary search. */
export function weightTable(weights: readonly number[]): WeightTable {
  let largest = 0;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`invalid weight ${weight}`);
    }
    largest = Math.max(largest, weight);
  }
  if (largest === 0) {
    throw new RangeError(
      'weights need one finite entry per item and a positive sum',
    );
  }
  // Relative to the largest weight, so the total cannot overflow. Zero
  // weights add nothing, so they are never the first sum above a target.
  const cumulative: number[] = [];
  let sum = 0;
  let last = 0;
  for (let i = 0; i < weights.length; i++) {
    const weight = (weights[i] as number) / largest;
    if (weight > 0) last = i;
    sum += weight;
    cumulative.push(sum);
  }
  return { cumulative, last };
}

/** A stream's 128-bit identity: four uint32 words. */
export type StreamId = readonly [number, number, number, number];

// cyrb128 over `length` 32-bit inputs (UTF-16 code units or uint32 words).
function hash128(length: number, at: (i: number) => number): StreamId {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < length; i++) {
    const k = at(i);
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

const hashText = (text: string): StreamId =>
  hash128(text.length, i => text.charCodeAt(i));

const hashWords = (words: readonly number[]): StreamId =>
  hash128(words.length, i => words[i] as number);

// Tags keep a key, an index and a blank draw under one parent apart.
const keyTag = 1;
const indexTag = 2;
const blankTag = 3;

/** The root stream of a seed. */
export const seedStream = (seed: string): StreamId => hashText(seed);

/**
 * A key's hash, to pass to `keyStream`. Hash each key once and reuse it, so
 * deriving a value's stream costs the same however long its keys are.
 */
export const keyHash = (key: string): StreamId => hashText(key);

/** The stream of the field whose key hashes to `key`, under `parent`. */
export const keyStream = (parent: StreamId, key: StreamId): StreamId =>
  hashWords([keyTag, ...parent, ...key]);

/** The stream of array item `index` (a safe integer >= 0) under `parent`. */
export const indexStream = (parent: StreamId, index: number): StreamId =>
  hashWords([
    indexTag,
    ...parent,
    index % twoTo32,
    Math.floor(index / twoTo32),
  ]);

/** The stream of a value's blank draw, apart from its value stream. */
export const blankStream = (parent: StreamId): StreamId =>
  hashWords([blankTag, ...parent]);

// sfc32: returns uint32 values.
function sfc32([seedA, seedB, seedC, seedD]: StreamId) {
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

/** An independent stream for each (seed, key) pair. */
export function createRng(seed: string, key: string): Rng {
  return streamRng(keyStream(seedStream(seed), keyHash(key)));
}

/** The random values of stream `id`. */
export function streamRng(id: StreamId): Rng {
  const next = sfc32(id);

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
    weighted<T>(
      items: readonly T[],
      weights: readonly number[] | WeightTable,
    ): T {
      const { cumulative, last } = Array.isArray(weights)
        ? weightTable(weights as readonly number[])
        : (weights as WeightTable);
      if (items.length === 0 || cumulative.length !== items.length) {
        throw new RangeError(
          'weights need one finite entry per item and a positive sum',
        );
      }
      const total = cumulative[cumulative.length - 1] as number;
      const target = (below(twoTo53) / twoTo53) * total;
      // The first running sum above target.
      let low = 0;
      let high = cumulative.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (target < (cumulative[middle] as number)) high = middle;
        else low = middle + 1;
      }
      // Rounding can leave target at the total: take the last positive weight.
      return items[low < cumulative.length ? low : last] as T;
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
