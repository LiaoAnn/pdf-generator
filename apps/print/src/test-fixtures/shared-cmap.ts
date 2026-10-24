import { readCmap } from '../fonts/sfnt.ts';
import { tableBytes, withTables } from './read-ttf.ts';

// Keep patcher inputs adversarial after public/fonts is rebuilt. Reintroduce
// collisions into real outlines; never rely on shipping broken platform fonts.
export function withSharedCmap(font: Uint8Array, trueType = false) {
  const mapping = readCmap(font);
  const pairs = trueType
    ? [
        '清淸',
        '青靑',
        '真眞',
        '教敎',
        '值値',
        '溫温',
        '刪删',
        '宮宫',
        '鄉郷',
        '尚尙',
        '告吿',
        '侶侣',
        '〈〈',
        '～〜',
        '一豈',
      ]
    : ['∕／', '·・', '·•', '·‧', '…⋯'];
  // Restore sharing from the layout-covered en dash, even after fonts rebuild.
  for (const pair of [...pairs, '–‒', '-‑']) {
    const [first, second] = [...pair].map(
      char => char.codePointAt(0) as number,
    );
    const gid = mapping.get(first as number);
    if (gid === undefined) throw new Error(`Missing fixture glyph ${pair}`);
    mapping.set(second as number, gid);
  }
  const entries = [...mapping].sort((a, b) => a[0] - b[0]);
  const cmap = Buffer.alloc(28 + 12 * entries.length);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(10, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(12, 12);
  cmap.writeUInt32BE(cmap.length - 12, 16);
  cmap.writeUInt32BE(entries.length, 24);
  entries.forEach(([cp, gid], i) => {
    cmap.writeUInt32BE(cp, 28 + 12 * i);
    cmap.writeUInt32BE(cp, 32 + 12 * i);
    cmap.writeUInt32BE(gid, 36 + 12 * i);
  });
  // Recompress trailing equal advances so rebuilding still exercises compressed
  // hmtx/vmtx input rather than only the patcher's expanded output format.
  const extra: [string, Buffer][] = [['cmap', cmap]];
  const count = tableBytes(font, 'maxp').readUInt16BE(4);
  for (const [metricTag, headerTag] of [
    ['hmtx', 'hhea'],
    ['vmtx', 'vhea'],
  ] as const) {
    const header = Buffer.from(tableBytes(font, headerTag));
    const metrics = tableBytes(font, metricTag);
    const full = header.readUInt16BE(34);
    let compressed = full;
    while (
      compressed > 1 &&
      metrics.readUInt16BE((compressed - 2) * 4) ===
        metrics.readUInt16BE((full - 1) * 4)
    )
      compressed--;
    const bytes = Buffer.alloc(4 * compressed + 2 * (count - compressed));
    metrics.copy(bytes, 0, 0, 4 * compressed);
    for (let gid = compressed; gid < count; gid++) {
      const at = gid < full ? 4 * gid + 2 : 4 * full + 2 * (gid - full);
      bytes.writeInt16BE(
        metrics.readInt16BE(at),
        4 * compressed + 2 * (gid - compressed),
      );
    }
    header.writeUInt16BE(compressed, 34);
    extra.push([headerTag, header], [metricTag, bytes]);
  }
  return withTables(font, extra);
}
