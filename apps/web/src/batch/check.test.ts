import { readdir, readFile } from 'node:fs/promises';
import { gtSchema } from '@pdf-generator/contract';
import { expect, test } from 'vitest';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { platformFonts, selfChecker } from './check.ts';

const fontsDirectory = new URL('../../../print/public/fonts/', import.meta.url);

// nameID 6 is the PostScript name PDF readers keep after the subset tag.
function postScriptName(font: Uint8Array): string {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  let nameTable: Uint8Array | undefined;
  for (let index = 0; index < tables; index++) {
    const entry = 12 + 16 * index;
    const tag = String.fromCharCode(
      font[entry] ?? 0,
      font[entry + 1] ?? 0,
      font[entry + 2] ?? 0,
      font[entry + 3] ?? 0,
    );
    if (tag !== 'name') continue;
    const offset = view.getUint32(entry + 8);
    const length = view.getUint32(entry + 12);
    nameTable = font.subarray(offset, offset + length);
  }
  if (!nameTable) throw new Error('font has no name table');
  const name = new DataView(
    nameTable.buffer,
    nameTable.byteOffset,
    nameTable.byteLength,
  );
  const count = name.getUint16(2);
  const stringOffset = name.getUint16(4);
  const found = new Set<string>();
  for (let index = 0; index < count; index++) {
    const base = 6 + 12 * index;
    const platformId = name.getUint16(base);
    const nameId = name.getUint16(base + 6);
    const length = name.getUint16(base + 8);
    const offset = name.getUint16(base + 10);
    if (nameId !== 6 || (platformId !== 0 && platformId !== 3)) continue;
    if (length % 2 !== 0) throw new Error('PostScript name is not UTF-16');
    const bytes = nameTable.subarray(
      stringOffset + offset,
      stringOffset + offset + length,
    );
    let text = '';
    for (let byte = 0; byte + 1 < bytes.length; byte += 2) {
      text += String.fromCharCode(
        ((bytes[byte] ?? 0) << 8) | (bytes[byte + 1] ?? 0),
      );
    }
    if (text !== '') found.add(text);
  }
  if (found.size !== 1) {
    throw new Error(
      `font has ${found.size} PostScript names: ${[...found].join(', ')}`,
    );
  }
  const [postScript] = found;
  if (!postScript) throw new Error('font has no PostScript name');
  return postScript;
}

test('platformFonts equals the PostScript names of the fonts the print Worker embeds', async () => {
  // Regression: a face added under apps/print/public/fonts but missing from
  // platformFonts makes every fixture's self-check report a font difference.
  const files = (await readdir(fontsDirectory))
    .filter(name => /\.(?:otf|ttf)$/i.test(name))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  const embedded = (
    await Promise.all(
      files.map(async file =>
        postScriptName(
          new Uint8Array(await readFile(new URL(file, fontsDirectory))),
        ),
      ),
    )
  ).sort();
  expect([...platformFonts].sort()).toEqual(embedded);
});

test('selfChecker rejects an unreadable PDF instead of reporting a pass', async () => {
  // Regression: a stub checker that always returns ok: true marks a PDF the
  // checker could not read as a passed fixture.
  const gt = gtSchema.parse(gtExample);
  await expect(
    selfChecker.check(new Uint8Array([1, 2, 3, 4]), gt),
  ).rejects.toThrow();
});
