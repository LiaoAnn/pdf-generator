// Independent test decoder for CFF1 data; deliberately does not use the builder.
// Only reads the INDEX, DICT, charset and FDSelect encodings used by Noto TC.
export function fontTables(input: Uint8Array) {
  const font = Buffer.from(input);
  return new Map(
    Array.from({ length: font.readUInt16BE(4) }, (_, i) => {
      const at = 12 + 16 * i;
      const offset = font.readUInt32BE(at + 8);
      return [
        font.toString('ascii', at, at + 4),
        {
          offset,
          checksum: font.readUInt32BE(at + 4),
          bytes: font.subarray(offset, offset + font.readUInt32BE(at + 12)),
        },
      ] as const;
    }),
  );
}

export function sum32(bytes: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum =
      (sum +
        (bytes[i] ?? 0) * 0x1000000 +
        (bytes[i + 1] ?? 0) * 0x10000 +
        (bytes[i + 2] ?? 0) * 0x100 +
        (bytes[i + 3] ?? 0)) >>>
      0;
  }
  return sum;
}

function index(data: Buffer, at: number) {
  const count = data.readUInt16BE(at);
  if (count === 0) return { end: at + 2, items: [] as Buffer[] };
  const size = data[at + 2] as number;
  const base = at + 3 + (count + 1) * size;
  const offsets = Array.from({ length: count + 1 }, (_, i) =>
    data.readUIntBE(at + 3 + i * size, size),
  );
  return {
    end: base + (offsets[count] as number) - 1,
    items: Array.from({ length: count }, (_, i) =>
      data.subarray(
        base + (offsets[i] as number) - 1,
        base + (offsets[i + 1] as number) - 1,
      ),
    ),
  };
}

function dict(data: Buffer) {
  const values = new Map<number, number[]>();
  let stack: number[] = [];
  for (let i = 0; i < data.length; ) {
    const b = data[i++] as number;
    if (b <= 21) {
      const op = b === 12 ? 1200 + (data[i++] as number) : b;
      values.set(op, stack);
      stack = [];
    } else if (b === 28) {
      stack.push(data.readInt16BE(i));
      i += 2;
    } else if (b === 29) {
      stack.push(data.readInt32BE(i));
      i += 4;
    } else if (b === 30) {
      // None of the offsets we read are reals; consume FontMatrix etc.
      while (i < data.length) {
        const byte = data[i++] as number;
        if ((byte & 15) === 15 || byte >> 4 === 15) break;
      }
      stack.push(Number.NaN);
    } else if (b <= 246) stack.push(b - 139);
    else if (b <= 250)
      stack.push((b - 247) * 256 + (data[i++] as number) + 108);
    else stack.push(-(b - 251) * 256 - (data[i++] as number) - 108);
  }
  return values;
}

export function readCff(data: Buffer) {
  const names = index(data, data[2] as number);
  const top = dict(index(data, names.end).items[0] as Buffer);
  const offset = (op: number) => {
    const value = top.get(op)?.[0];
    if (value === undefined) throw new Error(`CFF lacks operator ${op}`);
    return value;
  };
  const charstrings = index(data, offset(17)).items;
  const count = charstrings.length;
  const cids = [0];
  let at = offset(15);
  const charsetFormat = data[at++];
  if (charsetFormat === 0) {
    while (cids.length < count) {
      cids.push(data.readUInt16BE(at));
      at += 2;
    }
  } else if (charsetFormat === 1 || charsetFormat === 2) {
    while (cids.length < count) {
      const first = data.readUInt16BE(at);
      at += 2;
      const left =
        charsetFormat === 1 ? (data[at++] as number) : data.readUInt16BE(at);
      if (charsetFormat === 2) at += 2;
      for (let i = 0; i <= left; i++) cids.push(first + i);
    }
  } else throw new Error(`unsupported charset ${charsetFormat}`);
  const fds: number[] = [];
  at = offset(1237);
  const selectFormat = data[at++];
  if (selectFormat === 0) {
    for (let i = 0; i < count; i++) fds.push(data[at++] as number);
  } else if (selectFormat === 3) {
    const ranges = data.readUInt16BE(at);
    at += 2;
    for (let r = 0; r < ranges; r++) {
      const first = data.readUInt16BE(at);
      const fd = data[at + 2] as number;
      const next = data.readUInt16BE(at + 3);
      for (let i = first; i < next; i++) fds[i] = fd;
      at += 3;
    }
  } else throw new Error(`unsupported FDSelect ${selectFormat}`);
  return { charstrings, cids, fds };
}

export function metrics(table: Buffer, header: Buffer, count: number) {
  const longCount = header.readUInt16BE(34);
  return Array.from({ length: count }, (_, gid) => [
    table.readUInt16BE(4 * Math.min(gid, longCount - 1)),
    table.readInt16BE(
      gid < longCount ? 4 * gid + 2 : 4 * longCount + 2 * (gid - longCount),
    ),
  ]);
}

export function origins(table: Buffer, count: number) {
  const origins = Array<number>(count).fill(table.readInt16BE(4));
  for (let i = 0; i < table.readUInt16BE(6); i++) {
    origins[table.readUInt16BE(8 + 4 * i)] = table.readInt16BE(10 + 4 * i);
  }
  return origins;
}
