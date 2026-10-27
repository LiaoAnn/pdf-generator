import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { stablePdf } from './stable-pdf.ts';

test('rejects overlapping edits when the real IDTree aliases the Info object', () => {
  const source = readFileSync(
    new URL('./test-fixtures/untitled-print-a.pdf', import.meta.url),
  ).toString('latin1');
  expect(source.split('/IDTree 30 0 R')).toHaveLength(2);
  // Same-width edit keeps every xref offset valid. This is an actual root
  // reference, not a forged reference inside a literal string.
  const changed = source.replace('/IDTree 30 0 R', '/IDTree  1 0 R');
  const bytes = new Uint8Array(Buffer.from(changed, 'latin1'));
  expect(bytes.length).toBe(Buffer.byteLength(source, 'latin1'));
  expect(() =>
    stablePdf(
      bytes,
      'http://127.0.0.1:46341/pack/20b6a469-c5f1-487e-81c8-edc637db5b83/index.html',
    ),
  ).toThrow(Error);
});
