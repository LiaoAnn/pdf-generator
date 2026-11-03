// The platform fonts over Chrome's 6.25 MiB batch-cache limit are committed
// as the font build's unicode-range chunks (T07-37): each must be exactly
// what the splitter makes of the committed whole font, and small enough to
// stay cached between the prints of a session.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { expect, test } from 'vitest';
import { splitFont } from './fonts/split.ts';

const fonts = (name: string) =>
  readFile(new URL(`../public/fonts/${name}`, import.meta.url));
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

// Regression: a stale or hand-edited chunk prints other glyphs than the font
// build's; one of 6.25 MiB or more is reloaded by every print of a batch.
test.each([
  'NotoSerifTC-Regular.otf',
  'NotoSerifTC-Bold.otf',
  'LXGWWenKaiTC-Regular.ttf',
])('committed chunks of %s are its split, each under 6 MiB', async name => {
  const chunks = await splitFont(new Uint8Array(await fonts(name)), name);
  expect(chunks).toHaveLength(4);
  for (const chunk of chunks) {
    const committed = await fonts(chunk.file);
    expect(sha(committed), chunk.file).toBe(sha(chunk.font));
    expect(committed.length, chunk.file).toBeLessThan(6 * 1024 * 1024);
  }
});
