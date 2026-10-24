// Appends copies of existing glyphs to an sfnt font, so that code points that
// shared one glyph can each have their own: Chrome writes one ToUnicode entry
// per glyph, for the lowest code point that reaches it (T07-13). A copy has
// the source glyph's outline and metrics; GSUB, GPOS and GDEF don't cover it.

export interface Table {
  tag: string;
  data: Uint8Array;
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// Tables with per-glyph data this module doesn't extend.
const unsupported = [
  'CFF2',
  'gvar',
  'HVAR',
  'VVAR',
  'hdmx',
  'LTSH',
  'sbix',
  'CBDT',
  'CBLC',
  'EBDT',
  'EBLC',
  'COLR',
  'SVG ',
];

// --- CFF (CID-keyed) ------------------------------------------------------

interface Index {
  end: number;
  items: Uint8Array[];
}

function readIndex(cff: Uint8Array, at: number): Index {
  const v = view(cff);
  const count = v.getUint16(at);
  if (count === 0) return { end: at + 2, items: [] };
  const size = cff[at + 2] ?? 0;
  const offset = (i: number) => {
    let value = 0;
    for (let k = 0; k < size; k++) {
      value = value * 256 + (cff[at + 3 + i * size + k] ?? 0);
    }
    return value;
  };
  const base = at + 2 + (count + 1) * size; // offsets are 1-based
  const items = Array.from({ length: count }, (_, i) =>
    cff.subarray(base + offset(i), base + offset(i + 1)),
  );
  return { end: base + offset(count), items };
}

function writeIndex(items: Uint8Array[]): Uint8Array {
  if (items.length === 0) return new Uint8Array(2);
  const total = items.reduce((n, item) => n + item.length, 0) + 1;
  const size =
    total < 0x100 ? 1 : total < 0x10000 ? 2 : total < 0x1000000 ? 3 : 4;
  const head = new Uint8Array(3 + (items.length + 1) * size);
  view(head).setUint16(0, items.length);
  head[2] = size;
  let offset = 1;
  for (let i = 0; i <= items.length; i++) {
    for (let k = 0; k < size; k++) {
      head[3 + i * size + k] = (offset >>> (8 * (size - 1 - k))) & 0xff;
    }
    offset += items[i]?.length ?? 0;
  }
  return concat([head, ...items]);
}

interface Entry {
  /** The operator: b0, or 1200 + b1 for the two-byte (12 b1) operators. */
  op: number;
  /** The operands as encoded. */
  raw: Uint8Array;
  /** The integer operands (a real number reads as NaN). */
  values: number[];
}

function readDict(dict: Uint8Array): Entry[] {
  const v = view(dict);
  const entries: Entry[] = [];
  let start = 0;
  let values: number[] = [];
  let at = 0;
  while (at < dict.length) {
    const b0 = dict[at] ?? 0;
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + (dict[at + 1] ?? 0) : b0;
      entries.push({ op, raw: dict.subarray(start, at), values });
      at += b0 === 12 ? 2 : 1;
      start = at;
      values = [];
    } else if (b0 === 28) {
      values.push(v.getInt16(at + 1));
      at += 3;
    } else if (b0 === 29) {
      values.push(v.getInt32(at + 1));
      at += 5;
    } else if (b0 === 30) {
      at++;
      while (at < dict.length) {
        const nibbles = dict[at++] ?? 0xff;
        if ((nibbles & 0x0f) === 0x0f || nibbles >> 4 === 0x0f) break;
      }
      values.push(Number.NaN);
    } else if (b0 <= 246) {
      values.push(b0 - 139);
      at++;
    } else if (b0 <= 250) {
      values.push((b0 - 247) * 256 + (dict[at + 1] ?? 0) + 108);
      at += 2;
    } else if (b0 <= 254) {
      values.push(-(b0 - 251) * 256 - (dict[at + 1] ?? 0) - 108);
      at += 2;
    } else {
      throw new Error(`CFF: bad DICT byte ${b0}`);
    }
  }
  return entries;
}

/** A DICT with the given operators' operands replaced, as 5-byte integers. */
function writeDict(entries: Entry[], replace: Map<number, number[]>) {
  return concat(
    entries.flatMap(({ op, raw }) => {
      const values = replace.get(op);
      const operands = values
        ? values.map(value => {
            const bytes = new Uint8Array(5);
            bytes[0] = 29;
            view(bytes).setInt32(1, value);
            return bytes;
          })
        : [raw];
      const operator = op >= 1200 ? [12, op - 1200] : [op];
      return [...operands, Uint8Array.from(operator)];
    }),
  );
}

const operand = (entries: Entry[], op: number) =>
  entries.find(e => e.op === op)?.values;

function readCharset(cff: Uint8Array, at: number, glyphs: number) {
  const v = view(cff);
  const cids = [0];
  const format = cff[at];
  let p = at + 1;
  while (cids.length < glyphs) {
    if (format === 0) {
      cids.push(v.getUint16(p));
      p += 2;
    } else if (format === 1 || format === 2) {
      const first = v.getUint16(p);
      const left = format === 1 ? (cff[p + 2] ?? 0) : v.getUint16(p + 2);
      for (let k = 0; k <= left; k++) cids.push(first + k);
      p += format === 1 ? 3 : 4;
    } else {
      throw new Error(`CFF: charset format ${format}`);
    }
  }
  return cids.slice(0, glyphs);
}

function writeCharset(cids: number[]): Uint8Array {
  const ranges: [number, number][] = []; // first CID, number left
  for (const cid of cids.slice(1)) {
    const last = ranges.at(-1);
    if (last && cid === last[0] + last[1] + 1 && last[1] < 0xffff) last[1]++;
    else ranges.push([cid, 0]);
  }
  const out = new Uint8Array(1 + 4 * ranges.length);
  out[0] = 2;
  ranges.forEach(([first, left], i) => {
    view(out).setUint16(1 + 4 * i, first);
    view(out).setUint16(3 + 4 * i, left);
  });
  return out;
}

function readFdSelect(cff: Uint8Array, at: number, glyphs: number) {
  const v = view(cff);
  const format = cff[at];
  if (format === 0) return [...cff.subarray(at + 1, at + 1 + glyphs)];
  if (format !== 3) throw new Error(`CFF: FDSelect format ${format}`);
  const fds: number[] = [];
  const ranges = v.getUint16(at + 1);
  for (let r = 0; r < ranges; r++) {
    const first = v.getUint16(at + 3 + 3 * r);
    const next = v.getUint16(at + 6 + 3 * r); // next first, or the sentinel
    for (let g = first; g < next; g++) fds[g] = cff[at + 5 + 3 * r] ?? 0;
  }
  return fds;
}

function writeFdSelect(fds: number[]): Uint8Array {
  const ranges: [number, number][] = []; // first glyph, FD
  fds.forEach((fd, glyph) => {
    if (ranges.at(-1)?.[1] !== fd) ranges.push([glyph, fd]);
  });
  const out = new Uint8Array(5 + 3 * ranges.length);
  const v = view(out);
  out[0] = 3;
  v.setUint16(1, ranges.length);
  ranges.forEach(([first, fd], i) => {
    v.setUint16(3 + 3 * i, first);
    out[5 + 3 * i] = fd;
  });
  v.setUint16(3 + 3 * ranges.length, fds.length);
  return out;
}

const ROS = 1230;
const CID_COUNT = 1234;
const CHARSET = 15;
const CHAR_STRINGS = 17;
const PRIVATE = 18;
const FD_ARRAY = 1236;
const FD_SELECT = 1237;

/**
 * Rewrites a CID-keyed CFF with copies of `sources` appended. The charset,
 * FDSelect, CharStrings and FDArray are written again; the header, Name,
 * String and Global Subr INDEXes and the Private DICTs with their local
 * subroutines (which address each other relatively) are copied byte for byte.
 */
function copyCff(cff: Uint8Array, sources: number[]): Uint8Array {
  const name = readIndex(cff, cff[2] ?? 4);
  const top = readIndex(cff, name.end);
  const strings = readIndex(cff, top.end);
  const globalSubrs = readIndex(cff, strings.end);
  const [topDict, ...more] = top.items;
  if (!topDict || more.length > 0) throw new Error('CFF: not one font');
  const dict = readDict(topDict);
  const at = (op: number) => {
    const value = operand(dict, op)?.[0];
    if (value === undefined) throw new Error(`CFF: no operator ${op}`);
    return value;
  };
  if (!operand(dict, ROS)) throw new Error('CFF: not CID-keyed');

  const charStrings = readIndex(cff, at(CHAR_STRINGS));
  const glyphs = charStrings.items.length;
  const cids = readCharset(cff, at(CHARSET), glyphs);
  const fds = readFdSelect(cff, at(FD_SELECT), glyphs);
  const fdArray = readIndex(cff, at(FD_ARRAY));
  const fdDicts = fdArray.items.map(readDict);
  const privates = fdDicts.map(fd => {
    const [size, offset] = operand(fd, PRIVATE) ?? [];
    if (size === undefined || offset === undefined) {
      throw new Error('CFF: FD without a Private DICT');
    }
    return offset;
  });
  // Everything from the first Private DICT on is copied as one block.
  const tail = Math.min(...privates);
  const rewritten = [
    at(CHARSET),
    at(FD_SELECT),
    at(CHAR_STRINGS),
    at(FD_ARRAY),
  ];
  if (
    rewritten.some(offset => offset >= tail) ||
    Math.max(globalSubrs.end, charStrings.end, fdArray.end) > tail
  ) {
    throw new Error('CFF: Private DICTs are not at the end');
  }

  const used = new Set(cids);
  const cidCount = operand(dict, CID_COUNT)?.[0] ?? 8720;
  let next = 1;
  for (const source of sources) {
    while (used.has(next)) next++;
    if (next >= cidCount) throw new Error('CFF: no free CID');
    used.add(next);
    cids.push(next);
    fds.push(fds[source] ?? 0);
  }
  const charset = writeCharset(cids);
  const fdSelect = writeFdSelect(fds);
  const newCharStrings = writeIndex([
    ...charStrings.items,
    ...sources.map(source => charStrings.items[source] ?? new Uint8Array()),
  ]);

  // Offset operands are written as 5-byte integers, so the DICT sizes don't
  // depend on the offsets.
  const fixed = cff.subarray(top.end, globalSubrs.end);
  const topLength = writeIndex([
    writeDict(
      dict,
      new Map(
        [CHARSET, FD_SELECT, CHAR_STRINGS, FD_ARRAY].map(op => [op, [0]]),
      ),
    ),
  ]).length;
  const charsetAt = name.end + topLength + fixed.length;
  const fdSelectAt = charsetAt + charset.length;
  const charStringsAt = fdSelectAt + fdSelect.length;
  const fdArrayAt = charStringsAt + newCharStrings.length;
  const newFdArray = (shift: number) =>
    writeIndex(
      fdDicts.map(fd => {
        const [size = 0, offset = 0] = operand(fd, PRIVATE) ?? [];
        return writeDict(fd, new Map([[PRIVATE, [size, offset + shift]]]));
      }),
    );
  const tailAt = fdArrayAt + newFdArray(0).length;
  const newTop = writeIndex([
    writeDict(
      dict,
      new Map([
        [CHARSET, [charsetAt]],
        [FD_SELECT, [fdSelectAt]],
        [CHAR_STRINGS, [charStringsAt]],
        [FD_ARRAY, [fdArrayAt]],
      ]),
    ),
  ]);
  return concat([
    cff.subarray(0, name.end),
    newTop,
    fixed,
    charset,
    fdSelect,
    newCharStrings,
    newFdArray(tailAt - tail),
    cff.subarray(tail),
  ]);
}

// --- Metrics ----------------------------------------------------------------

/** hmtx or vmtx, written with a full metric for every glyph. */
function copyMetrics(
  header: Uint8Array,
  metrics: Uint8Array,
  glyphs: number,
  sources: number[],
) {
  const v = view(metrics);
  const long = view(header).getUint16(34);
  const advance = (g: number) => v.getUint16(4 * Math.min(g, long - 1));
  const side = (g: number) =>
    g < long ? v.getInt16(4 * g + 2) : v.getInt16(4 * long + 2 * (g - long));
  const all = [...Array.from({ length: glyphs }, (_, g) => g), ...sources];
  const out = new Uint8Array(4 * all.length);
  const ov = view(out);
  all.forEach((g, i) => {
    ov.setUint16(4 * i, advance(g));
    ov.setInt16(4 * i + 2, side(g));
  });
  const newHeader = new Uint8Array(header);
  view(newHeader).setUint16(34, all.length);
  return { header: newHeader, metrics: out };
}

function copyVorg(vorg: Uint8Array, glyphs: number, sources: number[]) {
  const v = view(vorg);
  const count = v.getUint16(6);
  const origins = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    origins.set(v.getUint16(8 + 4 * i), v.getInt16(10 + 4 * i));
  }
  const added: [number, number][] = [];
  sources.forEach((source, i) => {
    const y = origins.get(source);
    if (y !== undefined) added.push([glyphs + i, y]);
  });
  const out = new Uint8Array(8 + 4 * (count + added.length));
  out.set(vorg.subarray(0, 8 + 4 * count));
  const ov = view(out);
  ov.setUint16(6, count + added.length);
  added.forEach(([glyph, y], i) => {
    ov.setUint16(8 + 4 * (count + i), glyph);
    ov.setInt16(10 + 4 * (count + i), y);
  });
  return out;
}

/**
 * Appends a copy of each glyph in `sources`, in order, as glyphs numGlyphs,
 * numGlyphs + 1, …. Returns the font's tables with the glyph and metric
 * tables replaced (tables without per-glyph data are passed through) and the
 * first copy's glyph id.
 */
export function copyGlyphs(
  tables: Table[],
  sources: number[],
): { tables: Table[]; first: number } {
  const get = (tag: string) => tables.find(t => t.tag === tag)?.data;
  const found = unsupported.filter(tag => get(tag));
  if (found.length > 0) {
    throw new Error(`can't copy glyphs of a font with ${found.join(', ')}`);
  }
  const cff = get('CFF ');
  if (!cff) throw new Error('font has no CFF table to copy glyphs in');
  const maxp = get('maxp');
  if (!maxp) throw new Error('font has no maxp table');
  const glyphs = view(maxp).getUint16(4);
  if (glyphs + sources.length > 0xffff) throw new Error('too many glyphs');
  const replaced = new Map<string, Uint8Array>();
  const newMaxp = new Uint8Array(maxp); // a copy: Buffer#slice is a view
  view(newMaxp).setUint16(4, glyphs + sources.length);
  replaced.set('maxp', newMaxp);

  replaced.set('CFF ', copyCff(cff, sources));
  for (const [headerTag, metricsTag] of [
    ['hhea', 'hmtx'],
    ['vhea', 'vmtx'],
  ] as const) {
    const header = get(headerTag);
    const metrics = get(metricsTag);
    if (!header || !metrics) continue;
    const copied = copyMetrics(header, metrics, glyphs, sources);
    replaced.set(headerTag, copied.header);
    replaced.set(metricsTag, copied.metrics);
  }
  const vorg = get('VORG');
  if (vorg) replaced.set('VORG', copyVorg(vorg, glyphs, sources));
  return {
    tables: tables.map(t => ({
      tag: t.tag,
      data: replaced.get(t.tag) ?? t.data,
    })),
    first: glyphs,
  };
}
