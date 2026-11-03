// The platform fonts over Chrome's 6.25 MiB batch-cache limit are served as
// unicode-range chunks (T07-37). The repo holds only their whole patched
// fonts (apps/print/fonts/); wrangler's build command splits them into
// public/fonts/ before `wrangler dev`, `deploy` and the tests, so the chunks
// are never committed. Their bytes are pinned here: a splitter or harfbuzz
// change that alters what prints fails CI instead of slipping through.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { expect, test } from 'vitest';
import { splitFont } from './fonts/split.ts';
import { wholeFont } from './test-fixtures/whole-fonts.ts';

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

// sha256 of each chunk, by whole font, in part order (T07-37: the chunks
// whose 6 templates × 10 fixtures printed the same gt.json as main).
const pinned: Record<string, string[]> = {
  'NotoSerifTC-Regular.otf': [
    'a67844d597a37da0076866fe94760f33dbd0db01e66c98551c613df736a0d109',
    'af379fecce7aba33e3a594e39c8b58bbe0837fc0c13361f2b662e122e5eacdce',
    '108cd19c339bca759a69ce8d5e8cd8e156d4ac432ba7929541240ac44c93d477',
    'f7eb83e84a273254eba8e24bfb0129524c01aa50094b40f5a187c5c242c40370',
  ],
  'NotoSerifTC-Bold.otf': [
    '07829d240887ca9fc3401dfcb33b11cd795682ff9658c65d2b4c0640153db73f',
    '474e43156adb04e5b83e1f798d204afbc25e6c9b6bde95a9bfbc59f5b9dd155e',
    '4094bbd715d722ff16f31e44aadcc1f86ac281e51e84117ce4729ed09d9b3973',
    '8af4d0a2f3877e0020147de2fcad4c4d01715030a028233fb7a6a7eaa6440988',
  ],
  'LXGWWenKaiTC-Regular.ttf': [
    '9d0bb006903158259cd059ca730e98cab2d2f247d8670f2c253c59e9289d7a85',
    'a420be9dabfa10b7ea78352689df4ddf5a06e02754f748978f80e25753fe47f8',
    '934b82987e109b7914e8860438fb54fc69a74f2570b881147824a1fd94186fff',
    '8c9014bab0a739c9d7ddf247e2f2822d7852a711b7619e18ffa3ae6cdda1b8f3',
  ],
};

// Regression: a harfbuzzjs upgrade or a splitter change silently changes the
// printed glyphs or metrics; a chunk of 6.25 MiB or more is reloaded by every
// print of a batch.
test.each(Object.keys(pinned))(
  'the split of %s is pinned byte for byte, each chunk under 6 MiB',
  async name => {
    const chunks = await splitFont(
      new Uint8Array(await readFile(wholeFont(name))),
      name,
    );
    expect(chunks.map(chunk => sha(chunk.font))).toEqual(pinned[name]);
    for (const chunk of chunks) {
      expect(chunk.font.length, chunk.file).toBeLessThan(6 * 1024 * 1024);
    }
  },
);

// Regression: a build that skips the split (or leaves a stale chunk from an
// older split) serves missing or other fonts. A clean checkout has no
// chunks at all: the build command that started the Worker for this run
// (vitest's global setup) must have written them.
test.each(Object.keys(pinned))(
  'the build wrote the pinned chunks of %s into public/fonts',
  async name => {
    const files = [0, 1, 2, 3].map(part =>
      name.replace(/(\.[^.]*)$/, `.part${part}$1`),
    );
    const built = await Promise.all(
      files.map(async file =>
        sha(
          await readFile(new URL(`../public/fonts/${file}`, import.meta.url)),
        ),
      ),
    );
    expect(built).toEqual(pinned[name]);
  },
);
