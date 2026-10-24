// Reads and rewrites the cmap of an sfnt font (OpenType or TrueType), adding
// glyph copies where code points share a glyph. Used to build the platform
// fonts (`pnpm fonts`).
import { copyGlyphs, type Table } from './copy-glyphs.ts';

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function readTables(font: Uint8Array): Table[] {
  const v = view(font);
  const count = v.getUint16(4);
  return Array.from({ length: count }, (_, i) => {
    const entry = 12 + 16 * i;
    const tag = String.fromCharCode(...font.subarray(entry, entry + 4));
    const offset = v.getUint32(entry + 8);
    const length = v.getUint32(entry + 12);
    return { tag, data: font.subarray(offset, offset + length) };
  });
}

function readFormat12(sub: DataView, map: Map<number, number>) {
  const groups = sub.getUint32(12);
  for (let i = 0; i < groups; i++) {
    const start = sub.getUint32(16 + 12 * i);
    const end = sub.getUint32(20 + 12 * i);
    const glyph = sub.getUint32(24 + 12 * i);
    for (let cp = start; cp <= end; cp++) map.set(cp, glyph + (cp - start));
  }
}

function readFormat4(sub: DataView, map: Map<number, number>) {
  const segments = sub.getUint16(6) / 2;
  const ends = 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const rangeOffsets = deltas + 2 * segments;
  for (let s = 0; s < segments; s++) {
    const start = sub.getUint16(starts + 2 * s);
    const end = sub.getUint16(ends + 2 * s);
    const delta = sub.getUint16(deltas + 2 * s);
    const rangeOffsetAt = rangeOffsets + 2 * s;
    const rangeOffset = sub.getUint16(rangeOffsetAt);
    for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const raw = sub.getUint16(
          rangeOffsetAt + rangeOffset + 2 * (cp - start),
        );
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(cp, glyph);
    }
  }
}

/**
 * Code point → glyph id from the font's Unicode cmap: (3,10) format 12 if
 * present, else (3,1) format 4.
 */
export function readCmap(font: Uint8Array): Map<number, number> {
  const cmap = readTables(font).find(t => t.tag === 'cmap');
  if (!cmap) throw new Error('font has no cmap table');
  const v = view(cmap.data);
  const subtables = Array.from({ length: v.getUint16(2) }, (_, i) => ({
    platform: v.getUint16(4 + 8 * i),
    encoding: v.getUint16(6 + 8 * i),
    offset: v.getUint32(8 + 8 * i),
  })).map(s => ({ ...s, format: v.getUint16(s.offset) }));
  const map = new Map<number, number>();
  const full = subtables.find(
    s => s.platform === 3 && s.encoding === 10 && s.format === 12,
  );
  if (full) {
    readFormat12(view(cmap.data.subarray(full.offset)), map);
    return map;
  }
  const bmp = subtables.find(
    s => s.platform === 3 && s.encoding === 1 && s.format === 4,
  );
  if (!bmp) throw new Error('font has no Windows Unicode cmap subtable');
  readFormat4(view(cmap.data.subarray(bmp.offset)), map);
  return map;
}

// Code points Chrome may pick for a PDF's ToUnicode entry instead of the
// unified ideograph that shares their glyph (T03 §2.5).
const isAlias = (cp: number) =>
  (cp >= 0x2e80 && cp <= 0x2fdf) || // CJK Radicals Supplement, Kangxi Radicals
  (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
  (cp >= 0x2f800 && cp <= 0x2fa1f) || // CJK Compatibility Ideographs Supplement
  cp === 0x2329 || // 〈 (deprecated)
  cp === 0x232a || // 〉 (deprecated)
  cp === 0x301c; // 〜 wave dash (Taiwan uses ～)

function format12(mapping: [number, number][]): Uint8Array {
  const groups: [number, number, number][] = [];
  for (const [cp, glyph] of mapping) {
    const last = groups.at(-1);
    if (last && cp === last[1] + 1 && glyph === last[2] + (cp - last[0])) {
      last[1] = cp;
    } else {
      groups.push([cp, cp, glyph]);
    }
  }
  const out = new Uint8Array(12 + 16 + 12 * groups.length);
  const v = view(out);
  // cmap header: version 0, one subtable (3,10) at offset 12.
  v.setUint16(2, 1);
  v.setUint16(4, 3);
  v.setUint16(6, 10);
  v.setUint32(8, 12);
  v.setUint16(12, 12);
  v.setUint32(16, out.length - 12);
  v.setUint32(24, groups.length);
  groups.forEach(([start, end, glyph], i) => {
    v.setUint32(28 + 12 * i, start);
    v.setUint32(32 + 12 * i, end);
    v.setUint32(36 + 12 * i, glyph);
  });
  return out;
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word =
      ((bytes[i] ?? 0) << 24) |
      ((bytes[i + 1] ?? 0) << 16) |
      ((bytes[i + 2] ?? 0) << 8) |
      (bytes[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/**
 * Drops the radical and compatibility code points that share a glyph with
 * another code point, so a PDF's text layer maps that glyph back to the
 * unified ideograph (T03 Must 7). Then gives every code point still sharing
 * a glyph a copy of its own (`copied`), since a PDF's ToUnicode has one entry
 * per glyph (T07-13). Writes a single (3,10) format 12 cmap; tables without
 * glyph data are copied byte for byte.
 */
export function patchCmap(font: Uint8Array): {
  font: Uint8Array;
  dropped: number[];
  copied: number[];
} {
  const byGlyph = new Map<number, number[]>();
  for (const [cp, glyph] of readCmap(font)) {
    byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), cp]);
  }
  const kept: [number, number][] = [];
  const dropped: number[] = [];
  const sharing: [number, number][] = []; // code point, glyph it shares
  for (const [glyph, cps] of byGlyph) {
    const shared = cps.length > 1 && cps.some(cp => !isAlias(cp));
    const [first, ...rest] = cps
      .filter(cp => !(shared && isAlias(cp)))
      .sort((a, b) => a - b);
    dropped.push(...cps.filter(cp => shared && isAlias(cp)));
    if (first !== undefined) kept.push([first, glyph]);
    for (const cp of rest) sharing.push([cp, glyph]);
  }
  // The lowest code point keeps a shared glyph; each other one gets a copy
  // of it (T07-13), numbered in code point order after the font's glyphs.
  sharing.sort((a, b) => a[0] - b[0]);
  let tables = readTables(font);
  if (sharing.length > 0) {
    const copies = copyGlyphs(
      tables,
      sharing.map(([, glyph]) => glyph),
    );
    for (const [i, [cp]] of sharing.entries()) {
      kept.push([cp, copies.first + i]);
    }
    tables = copies.tables;
  }
  kept.sort((a, b) => a[0] - b[0]);
  dropped.sort((a, b) => a - b);

  tables = tables.map(t => {
    if (t.tag === 'cmap') return { tag: t.tag, data: format12(kept) };
    if (t.tag === 'head') {
      const head = new Uint8Array(t.data); // a copy, never a view of the input
      view(head).setUint32(8, 0); // checkSumAdjustment, set below
      return { tag: t.tag, data: head };
    }
    return t;
  });
  const directory = 12 + 16 * tables.length;
  const padded = (n: number) => (n + 3) & ~3;
  const size = tables.reduce((n, t) => n + padded(t.data.length), directory);
  const out = new Uint8Array(size);
  const v = view(out);
  out.set(font.subarray(0, 12));
  let offset = directory;
  let headOffset = -1;
  tables.forEach((t, i) => {
    const entry = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[entry + k] = t.tag.charCodeAt(k);
    v.setUint32(entry + 4, checksum(t.data));
    v.setUint32(entry + 8, offset);
    v.setUint32(entry + 12, t.data.length);
    out.set(t.data, offset);
    if (t.tag === 'head') headOffset = offset;
    offset += padded(t.data.length);
  });
  if (headOffset >= 0) {
    v.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return { font: out, dropped, copied: sharing.map(([cp]) => cp) };
}

/**
 * Empties every GSUB `locl` feature (zero lookups). In the Noto CJK TC fonts
 * it swaps digits, …, ASCII quotes and other punctuation for glyphs with no
 * cmap entry, which Chrome writes to the PDF's ToUnicode as U+0000 (T07-11).
 * Edits in place: only those lookup counts, the GSUB checksum and
 * head.checkSumAdjustment change.
 */
export function disableLocl(font: Uint8Array): {
  font: Uint8Array;
  features: number;
} {
  const out = font.slice();
  const v = view(out);
  const entries = Array.from({ length: v.getUint16(4) }, (_, i) => 12 + 16 * i);
  const tagAt = (at: number) =>
    String.fromCharCode(...out.subarray(at, at + 4));
  const gsub = entries.find(entry => tagAt(entry) === 'GSUB');
  if (gsub === undefined) return { font: out, features: 0 };
  const start = v.getUint32(gsub + 8);
  const featureList = start + v.getUint16(start + 6);
  let features = 0;
  for (let i = 0; i < v.getUint16(featureList); i++) {
    const record = featureList + 2 + 6 * i;
    if (tagAt(record) !== 'locl') continue;
    v.setUint16(featureList + v.getUint16(record + 4) + 2, 0);
    features++;
  }
  if (features === 0) return { font: out, features };
  v.setUint32(
    gsub + 4,
    checksum(out.subarray(start, start + v.getUint32(gsub + 12))),
  );
  const head = entries.find(entry => tagAt(entry) === 'head');
  if (head !== undefined) {
    const at = v.getUint32(head + 8) + 8;
    v.setUint32(at, 0);
    v.setUint32(at, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return { font: out, features };
}
