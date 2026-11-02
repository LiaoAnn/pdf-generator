import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import {
  countOperations,
  maxContentBytes,
  maxNesting,
  maxOperations,
} from './operations.ts';

// Hand-built PDFs: the scan must predict, before pdf.js runs, how many
// operators pdf.js will produce for the whole document (T14-10).

type Body = string | { dict: string; data: string | Uint8Array; raw?: true };

interface Options {
  /** Objects 1 and 2 are the catalog and the page tree; pages list their object numbers. */
  objects: Record<number, Body>;
  pages: number[];
  /** Extra trailer entries. */
  trailer?: string;
  /** Bytes written between the objects and the xref table. */
  tail?: string;
}

const latin1 = (text: string) => Uint8Array.from(text, c => c.charCodeAt(0));

/**
 * A classic PDF with an exact xref table. A stream body is written with its
 * own /Length; `raw: true` keeps the data as given, otherwise it is
 * Flate-compressed when `dict` names /FlateDecode.
 */
function buildPdf({ objects, pages, trailer = '', tail = '' }: Options) {
  const all: Record<number, Body> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${pages.map(n => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    ...objects,
  };
  const chunks: Uint8Array[] = [latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let length = chunks[0]?.length ?? 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const numbers = Object.keys(all)
    .map(Number)
    .sort((a, b) => a - b);
  const size = (numbers.at(-1) ?? 0) + 1;
  const offsets = new Map<number, number>();
  for (const n of numbers) {
    offsets.set(n, length);
    const body = all[n] as Body;
    if (typeof body === 'string') {
      push(latin1(`${n} 0 obj\n${body}\nendobj\n`));
      continue;
    }
    let data = typeof body.data === 'string' ? latin1(body.data) : body.data;
    if (!body.raw && body.dict.includes('/FlateDecode')) {
      data = new Uint8Array(deflateSync(data));
    }
    push(
      latin1(`${n} 0 obj\n<< ${body.dict} /Length ${data.length} >>\nstream\n`),
    );
    push(data);
    push(latin1('\nendstream\nendobj\n'));
  }
  push(latin1(tail));
  const xref = length;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    const offset = offsets.get(n);
    table +=
      offset === undefined
        ? '0000000000 65535 f \n'
        : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  push(
    latin1(
      `${table}trailer\n<< /Size ${size} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const page = (contents: string, resources = '<< >>', extra = '') =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources ${resources} /Contents ${contents} ${extra}>>`;

const content = (data: string, dict = '') => ({ dict, data });

const form = (data: string, resources = '', extra = '') => ({
  dict: `/Type /XObject /Subtype /Form /BBox [0 0 10 10] ${resources ? `/Resources ${resources}` : ''} ${extra}`,
  data,
});

async function counted(options: Options) {
  const result = await countOperations(buildPdf(options));
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result;
}

async function refused(options: Options | Uint8Array) {
  const result = await countOperations(
    options instanceof Uint8Array ? options : buildPdf(options),
  );
  expect(result.ok, JSON.stringify(result)).toBe(false);
  return result as Extract<typeof result, { ok: false }>;
}

test('each content operator counts once; strings, hex strings, comments, names, dictionaries and inline image data hold none', async () => {
  // q cm Tj Tj TJ BDC EMC BI(…EI) Q: 9 operators. The bytes "re f" and
  // "Do" inside strings, comments and the inline image's data are no operators.
  const data = [
    'q 1 0 0 1 0 0 cm',
    '(re f \\) Q q) Tj',
    '<7265206620> Tj',
    '[(a) -5 (b f) 3] TJ',
    '% re f re f re f',
    '/P << /MCID 0 /Alt (S f) >> BDC EMC',
    'BI /W 4 /H 1 /BPC 8 /CS /G ID re f EI',
    'Q',
  ].join('\n');
  const result = await counted({
    pages: [3],
    objects: { 3: page('4 0 R'), 4: content(data) },
  });
  expect(result.operations).toBe(9);
  expect(result.nesting).toBe(0);
});

test('a Flate-compressed content stream counts the same as the raw one and its decoded bytes are reported', async () => {
  const data = 'q 0 0 10 10 re f Q\n'.repeat(50);
  const raw = await counted({
    pages: [3],
    objects: { 3: page('4 0 R'), 4: content(data) },
  });
  const flate = await counted({
    pages: [3],
    objects: { 3: page('4 0 R'), 4: content(data, '/Filter /FlateDecode') },
  });
  expect(raw.operations).toBe(200);
  expect(flate.operations).toBe(200);
  expect(flate.contentBytes).toBe(data.length);
});

test('every Do of a form adds its content again plus four for its begin, end and group operators; an image Do adds one for pdf.js’s dependency operator', async () => {
  const result = await counted({
    pages: [3],
    objects: {
      3: page('4 0 R', '<< /XObject << /F0 5 0 R /Im0 6 0 R >> >>'),
      // 3 Do of the form, 2 Do of the image, q Q: 7 operators, and pdf.js
      // adds a dependency operator before each image it paints.
      4: content('q /F0 Do /F0 Do /Im0 Do /F0 Do /Im0 Do Q'),
      // 3 operators each time.
      5: form('0 0 10 10 re f n', '<< >>', '/Group << /S /Transparency >>'),
      6: {
        dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray',
        data: 'q Q q Q q Q',
        raw: true,
      },
    },
  });
  expect(result.operations).toBe(7 + 2 + 3 * (3 + 4));
  expect(result.nesting).toBe(1);
});

test('a form without its own resources resolves names in its caller’s resources, and pages inherit resources from the page tree', async () => {
  const result = await counted({
    pages: [3],
    objects: {
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /XObject << /A 5 0 R /B 6 0 R >> >> >>',
      3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents [4 0 R 7 0 R] >>',
      4: content('/A Do'),
      // A has no resources: /B is the page's B.
      5: form('/B Do /B Do'),
      6: form('0 0 1 1 re f'),
      7: content('q Q'),
    },
  });
  // Page: 1 + 2; A: 4 + 2; each B: 4 + 2.
  expect(result.operations).toBe(3 + (4 + 2) + 2 * (4 + 2));
  expect(result.nesting).toBe(2);
});

test('soft masks set by gs, tiling patterns set by scn or SCN, and annotation appearances add their content at each use', async () => {
  const result = await counted({
    pages: [3],
    objects: {
      3: page(
        '4 0 R',
        '<< /ExtGState << /G0 << /SMask << /S /Luminosity /G 5 0 R >> >> /G1 << /ca 0.5 >> >> /Pattern << /P0 6 0 R >> >>',
        '/Annots [7 0 R]',
      ),
      // gs ×3, cs, scn ×2, SCN, re, f: 9 operators.
      4: content(
        '/G0 gs /G1 gs /G0 gs /Pattern cs /P0 scn /P0 scn 0.5 /P0 SCN 0 0 1 1 re f',
      ),
      5: form('0 0 1 1 re f', '<< >>', '/Group << /S /Transparency >>'),
      6: {
        dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 2 2] /XStep 2 /YStep 2 /Resources << >>',
        data: 'q 0 0 1 1 re f Q',
      },
      7: '<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /AP << /N 8 0 R >> >>',
      8: form('q 0 0 1 1 re f Q n', '<< >>'),
    },
  });
  // Page 9; mask twice (2 + 4 each); pattern three times (4 + 4 each);
  // the appearance once (5 + 4).
  expect(result.operations).toBe(9 + 2 * 6 + 3 * 8 + 9);
});

test('Tf counts twice (pdf.js’s font dependency), and a Type 3 font’s glyph procedures count once for the document, however often the font is set', async () => {
  const result = await counted({
    pages: [3, 6],
    objects: {
      3: page('4 0 R', '<< /Font << /T3 5 0 R >> >>'),
      4: content('BT /T3 12 Tf (ab) Tj /T3 10 Tf (ba) Tj ET'),
      5: '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] /CharProcs << /a 8 0 R /b 9 0 R >> /Encoding << /Differences [97 /a /b] >> /FirstChar 97 /LastChar 98 /Widths [1 1] >>',
      6: page('7 0 R', '<< /Font << /T3 5 0 R >> >>'),
      7: content('BT /T3 12 Tf (a) Tj ET'),
      8: content('1 0 0 0 1 1 d1 0 0 1 1 re f'),
      9: content('1 0 d0 0 0 m 1 1 l S'),
    },
  });
  // Pages: 6 + 4, each Tf once more; glyph procedures once: 3 + 4.
  expect(result.operations).toBe(10 + 3 + 7);
});

test('the count adds up across pages, and a document whose pages are each under the budget is refused once their sum is over it', async () => {
  const half = Math.floor(maxOperations / 2);
  const ops = (n: number) =>
    content('q Q '.repeat(n / 2), '/Filter /FlateDecode');
  const under = await counted({
    pages: [3, 5],
    objects: {
      3: page('4 0 R'),
      4: ops(half),
      5: page('6 0 R'),
      6: ops(maxOperations - half),
    },
  });
  expect(under.operations).toBe(maxOperations);
  const over = await refused({
    pages: [3, 5],
    objects: {
      3: page('4 0 R'),
      4: ops(half),
      5: page('6 0 R'),
      6: ops(maxOperations - half + 2),
    },
  });
  expect(over.limit).toBe('operations');
});

test('forms nested deeper than the nesting cap are refused; at the cap they are counted', async () => {
  const chain = (depth: number): Options => {
    const objects: Record<number, Body> = {
      3: page('4 0 R', '<< /XObject << /N 10 0 R >> >>'),
      4: content('/N Do'),
    };
    for (let level = 1; level <= depth; level++) {
      const next = 10 + level;
      objects[10 + level - 1] = form(
        level < depth ? '/N Do' : '0 0 1 1 re f',
        level < depth ? `<< /XObject << /N ${next} 0 R >> >>` : '<< >>',
      );
    }
    return { pages: [3], objects };
  };
  const atCap = await counted(chain(maxNesting));
  expect(atCap.nesting).toBe(maxNesting);
  const over = await refused(chain(maxNesting + 1));
  expect(over.limit).toBe('nesting');
});

test('forms that each call the next ten times are refused promptly instead of being expanded', async () => {
  // 10^11 expansions of the innermost form: only a count that reuses each
  // form's total, multiplied by its calls, can finish.
  const objects: Record<number, Body> = {
    3: page('4 0 R', '<< /XObject << /N 10 0 R >> >>'),
    4: content('/N Do'),
  };
  for (let level = 0; level < 12; level++) {
    objects[10 + level] = form(
      level < 11 ? '/N Do '.repeat(10) : '0 0 1 1 re f',
      level < 11 ? `<< /XObject << /N ${11 + level} 0 R >> >>` : '<< >>',
    );
  }
  const result = await refused({ pages: [3], objects });
  expect(result.limit).toBe('operations');
}, 10_000);

test('a form that calls itself, directly or through another form, is refused', async () => {
  const direct = await refused({
    pages: [3],
    objects: {
      3: page('4 0 R', '<< /XObject << /F 5 0 R >> >>'),
      4: content('/F Do'),
      5: form('/F Do', '<< /XObject << /F 5 0 R >> >>'),
    },
  });
  expect(direct.limit).toBe('structure');
  const indirect = await refused({
    pages: [3],
    objects: {
      3: page('4 0 R', '<< /XObject << /F 5 0 R >> >>'),
      4: content('/F Do'),
      5: form('/G Do', '<< /XObject << /G 6 0 R >> >>'),
      6: form('/F Do', '<< /XObject << /F 5 0 R >> >>'),
    },
  });
  expect(indirect.limit).toBe('structure');
});

test('decoded content past the byte cap is refused even when it holds no operator and compresses to almost nothing', async () => {
  const result = await refused({
    pages: [3],
    objects: {
      3: page('4 0 R'),
      4: {
        dict: '/Filter /FlateDecode',
        data: new Uint8Array(maxContentBytes + 1).fill(0x20),
      },
    },
  });
  expect(result.limit).toBe('content');
});

test('object numbers spelled inside another stream’s data are not taken for the document’s objects', async () => {
  // The image's bytes (a pack can embed a JPEG verbatim) spell a second,
  // empty definition of the page's content stream, after the real one.
  const fake =
    '\n4 0 obj\n<< /Length 3 >>\nstream\nq Q\nendstream\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n';
  const result = await counted({
    pages: [3],
    objects: {
      3: page('4 0 R', '<< /XObject << /Im0 5 0 R >> >>'),
      4: content('q 0 0 1 1 re f Q '.repeat(1000), '/Filter /FlateDecode'),
      5: {
        dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /DCTDecode',
        data: `\xff\xd8${fake}\xff\xd9`,
        raw: true,
      },
    },
  });
  expect(result.operations).toBe(4000);
});

test('a stream whose /Length is an indirect reference is read to its real end', async () => {
  const data = 'q 0 0 1 1 re f Q '.repeat(10);
  const pdf = buildPdf({
    pages: [3],
    objects: { 3: page('4 0 R'), 5: String(data.length) },
    // Object 4 is written by hand with an indirect length.
    tail: `4 0 obj\n<< /Length 5 0 R >>\nstream\n${data}\nendstream\nendobj\n`,
  });
  // The hand-written object needs an xref entry: rebuild the table from the
  // real offset of "4 0 obj".
  const text = Buffer.from(pdf).toString('latin1');
  const at = text.indexOf('4 0 obj\n<< /Length 5 0 R');
  const fixed = text.replace(
    /xref\n0 6\n([\s\S]*?)trailer/,
    (_, rows: string) => {
      const lines = rows.split('\n');
      lines[4] = `${String(at).padStart(10, '0')} 00000 n `;
      return `xref\n0 6\n${lines.join('\n')}trailer`;
    },
  );
  const result = await countOperations(latin1(fixed));
  expect(result).toMatchObject({ ok: true, operations: 40 });
});

test('what the scan cannot read is refused, never counted as empty: object streams, other filters, no pages, no xref, not a PDF', async () => {
  const objectStream = await refused({
    pages: [3],
    objects: {
      3: page('4 0 R'),
      4: content('q Q'),
      5: {
        dict: '/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode',
        data: '6 0 << /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
      },
    },
  });
  expect(objectStream.limit).toBe('structure');
  const filter = await refused({
    pages: [3],
    objects: {
      3: page('4 0 R'),
      4: { dict: '/Filter /ASCIIHexDecode', data: '71 20 51>', raw: true },
    },
  });
  expect(filter.limit).toBe('structure');
  const noPages = await refused({ pages: [], objects: {} });
  expect(noPages.limit).toBe('structure');
  const noXref = buildPdf({
    pages: [3],
    objects: { 3: page('4 0 R'), 4: content('q Q') },
  });
  const cut = noXref.subarray(
    0,
    Buffer.from(noXref).toString('latin1').lastIndexOf('xref'),
  );
  expect((await refused(cut)).limit).toBe('structure');
  expect((await refused(latin1('not a pdf at all'))).limit).toBe('structure');
});
