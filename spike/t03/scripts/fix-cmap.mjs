// Rewrites a font's cmap so no glyph is reachable from both a CJK radical /
// compatibility code point and another code point. Chrome's PDF ToUnicode maps each
// glyph to one code point; with shared glyphs it can pick the radical (U+2F00 for 一),
// so extracted text differs from the source. Glyph data is left untouched.
// Usage: node scripts/fix-cmap.mjs in.otf out.otf
import { readFileSync, writeFileSync } from 'node:fs';
import * as fontkit from 'fontkit';

const [input, output] = process.argv.slice(2);
const src = readFileSync(input);
const font = fontkit.create(src);

const isAlias = (cp) =>
  (cp >= 0x2e80 && cp <= 0x2fdf) || // CJK Radicals Supplement + Kangxi Radicals
  (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
  (cp >= 0x2f800 && cp <= 0x2fa1f); // CJK Compatibility Ideographs Supplement
// Other shared glyphs where Chrome would pick the lower, non-Taiwanese code point.
const extraDrop = new Set([0x2329, 0x232a, 0x301c]); // 〈〉 (deprecated) and 〜 (wave dash; Taiwan uses ～)
const byGlyph = new Map();
for (const cp of font.characterSet) {
  const gid = font.glyphForCodePoint(cp).id;
  if (!byGlyph.has(gid)) byGlyph.set(gid, []);
  byGlyph.get(gid).push(cp);
}
const map = [];
const dropped = [];
for (const [gid, cps] of byGlyph) {
  const drop = (cp) => isAlias(cp) || extraDrop.has(cp);
  const shared = cps.length > 1 && cps.some((cp) => !drop(cp));
  for (const cp of cps) {
    if (shared && drop(cp)) dropped.push(cp);
    else map.push([cp, gid]);
  }
}
map.sort((a, b) => a[0] - b[0]);

// cmap with one subtable: (3,10) format 12, sequential groups.
const groups = [];
for (const [cp, gid] of map) {
  const g = groups[groups.length - 1];
  if (g && cp === g[1] + 1 && gid === g[2] + (cp - g[0])) g[1] = cp;
  else groups.push([cp, cp, gid]);
}
const sub = Buffer.alloc(16 + 12 * groups.length);
sub.writeUInt16BE(12, 0);
sub.writeUInt32BE(sub.length, 4);
sub.writeUInt32BE(groups.length, 12);
groups.forEach(([s, e, g], i) => {
  sub.writeUInt32BE(s, 16 + 12 * i);
  sub.writeUInt32BE(e, 20 + 12 * i);
  sub.writeUInt32BE(g, 24 + 12 * i);
});
const cmap = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 10, 0, 0, 0, 12]), sub]);

// Rebuild the sfnt with the new cmap; other tables are copied byte for byte.
const numTables = src.readUInt16BE(4);
const tables = [];
for (let i = 0; i < numTables; i++) {
  const o = 12 + 16 * i;
  const tag = src.toString('latin1', o, o + 4);
  const off = src.readUInt32BE(o + 8);
  const len = src.readUInt32BE(o + 12);
  tables.push({ tag, data: tag === 'cmap' ? cmap : src.subarray(off, off + len) });
}
const checksum = (buf) => {
  let sum = 0;
  const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
};
const header = Buffer.alloc(12 + 16 * numTables);
src.copy(header, 0, 0, 12);
let offset = header.length;
const bodies = [];
tables.forEach((t, i) => {
  const data = t.tag === 'head' ? Buffer.from(t.data) : t.data;
  if (t.tag === 'head') data.writeUInt32BE(0, 8); // checkSumAdjustment, fixed below
  t.out = data;
  const o = 12 + 16 * i;
  header.write(t.tag, o, 'latin1');
  header.writeUInt32BE(checksum(data), o + 4);
  header.writeUInt32BE(offset, o + 8);
  header.writeUInt32BE(data.length, o + 12);
  const pad = Buffer.alloc((4 - (data.length % 4)) % 4);
  bodies.push(data, pad);
  offset += data.length + pad.length;
});
const out = Buffer.concat([header, ...bodies]);
const head = tables.find((t) => t.tag === 'head');
const headOff = out.indexOf(head.out);
out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headOff + 8);
writeFileSync(output, out);

const check = fontkit.create(out);
console.log(JSON.stringify({
  input,
  mapped: map.length,
  dropped: dropped.length,
  droppedSample: String.fromCodePoint(...dropped.slice(0, 10)),
  outBytes: out.length,
  verify: { glyphs: check.numGlyphs, chars: check.characterSet.length, '一': check.glyphForCodePoint(0x4e00).id, '⼀': check.hasGlyphForCodePoint(0x2f00) },
}));
