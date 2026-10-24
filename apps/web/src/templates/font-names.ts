// The PostScript name (OpenType `name` table, nameID 6) of a pack's font
// file: the name Chrome embeds the font under in a printed PDF, so the batch
// self-check can allow the pack's own fonts. Reads TrueType/OpenType, WOFF
// (zlib) and WOFF2 (brotli) files; anything else reads as no name.
import { brotliDecompressSync, inflateSync } from 'node:zlib';

const nameTag = 0x6e616d65; // 'name'
const postScriptNameId = 6;

// WOFF2's known-table tags, by index (WOFF2 spec, 5.1); 'name' is 5.
const nameIndex = 5;
const glyfIndex = 10;
const locaIndex = 11;

/** The `name` table of a font file, or undefined if it has none we can read. */
function nameTable(font: Uint8Array): Uint8Array | undefined {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const signature = view.getUint32(0);
  if (signature === 0x774f4646) return woffName(font, view); // 'wOFF'
  if (signature === 0x774f4632) return woff2Name(font, view); // 'wOF2'
  if (signature === 0x00010000 || signature === 0x4f54544f) {
    // TrueType 1.0, 'OTTO'
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const record = 12 + 16 * i;
      if (view.getUint32(record) !== nameTag) continue;
      const offset = view.getUint32(record + 8);
      const length = view.getUint32(record + 12);
      return slice(font, offset, length);
    }
  }
  return undefined;
}

function slice(bytes: Uint8Array, offset: number, length: number) {
  if (offset + length > bytes.byteLength) throw new RangeError('truncated');
  return bytes.subarray(offset, offset + length);
}

function woffName(font: Uint8Array, view: DataView): Uint8Array | undefined {
  const count = view.getUint16(12);
  for (let i = 0; i < count; i++) {
    const entry = 44 + 20 * i;
    if (view.getUint32(entry) !== nameTag) continue;
    const offset = view.getUint32(entry + 4);
    const compressed = view.getUint32(entry + 8);
    const original = view.getUint32(entry + 12);
    const data = slice(font, offset, compressed);
    return compressed < original ? inflateSync(data) : data;
  }
  return undefined;
}

function woff2Name(font: Uint8Array, view: DataView): Uint8Array | undefined {
  const count = view.getUint16(12);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = view.getUint8(at++);
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new RangeError('bad UIntBase128');
  };
  // Tables follow each other in the decompressed stream, in directory order.
  let offset = 0;
  let name: { offset: number; length: number } | undefined;
  for (let i = 0; i < count; i++) {
    const flags = view.getUint8(at++);
    const index = flags & 0x3f;
    if (index === 0x3f) at += 4; // an explicit tag
    const length = base128();
    const transform = flags >> 6;
    const glyfOrLoca = index === glyfIndex || index === locaIndex;
    const stored = (glyfOrLoca ? transform !== 3 : transform !== 0)
      ? base128()
      : length;
    if (index === nameIndex) name = { offset, length: stored };
    offset += stored;
  }
  if (!name) return undefined;
  if (view.getUint32(4) === 0x74746366) return undefined; // 'ttcf' collection
  const compressed = view.getUint32(20);
  const stream = brotliDecompressSync(slice(font, at, compressed));
  return slice(stream, name.offset, name.length);
}

// Mac Roman's characters 0x80–0xff (0x00–0x7f are ASCII).
const macRoman =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function decodeName(
  record: { platform: number; encoding: number },
  bytes: Uint8Array,
): string | undefined {
  if (record.platform === 3 || record.platform === 0) {
    // UTF-16BE, decoded by hand: not every runtime's TextDecoder has it.
    let text = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
    }
    return text;
  }
  if (record.platform === 1 && record.encoding === 0) {
    return Array.from(bytes, byte =>
      byte < 0x80 ? String.fromCharCode(byte) : macRoman[byte - 0x80],
    ).join('');
  }
  return undefined;
}

/** The font's PostScript name, or undefined if the file can't be read. */
export function postScriptName(font: Uint8Array): string | undefined {
  try {
    const table = nameTable(font);
    if (!table) return undefined;
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const count = view.getUint16(2);
    const strings = view.getUint16(4);
    const found = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const record = 6 + 12 * i;
      if (view.getUint16(record + 6) !== postScriptNameId) continue;
      const platform = view.getUint16(record);
      const length = view.getUint16(record + 8);
      const offset = strings + view.getUint16(record + 10);
      const text = decodeName(
        { platform, encoding: view.getUint16(record + 2) },
        slice(table, offset, length),
      );
      if (text && !found.has(platform)) found.set(platform, text);
    }
    return found.get(3) ?? found.get(1) ?? found.get(0);
  } catch {
    return undefined;
  }
}
