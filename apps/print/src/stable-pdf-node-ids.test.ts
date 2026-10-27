import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getDocumentProxy } from 'unpdf';
import { expect, test } from 'vitest';
import { stablePdf } from './stable-pdf.ts';

const documentUrl =
  'http://127.0.0.1:46341/pack/20b6a469-c5f1-487e-81c8-edc637db5b83/index.html';

function fixture(name = 'untitled-print-a.pdf'): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url)),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// This Chrome fixture uses ordinary indirect objects, not object streams.
// Exclude compressed data from structural assertions and replacements.
function outsideStreams(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('latin1')
    .replace(/\bstream\r?\n[\s\S]*?endstream/g, match =>
      ' '.repeat(match.length),
    );
}

function withNodeIds(
  bytes: Uint8Array,
  change: (ids: string[]) => string[],
): Uint8Array {
  const source = Buffer.from(bytes).toString('latin1');
  const masked = outsideStreams(bytes);
  const ids = [
    ...new Set(
      [...masked.matchAll(/\/ID\s*\(node(\d{8})\)/g)].map(
        match => match[1] ?? '',
      ),
    ),
  ].sort();
  expect(ids.length).toBeGreaterThan(2);
  const changedIds = change(ids);
  const replacements = new Map(
    ids.map((id, index) => [id, changedIds[index] ?? '']),
  );
  let changed = source;
  // Equal-width replacements preserve xref offsets and leave streams intact.
  for (const match of masked.matchAll(/\(node(\d{8})\)/g)) {
    const id = replacements.get(match[1] ?? '');
    expect(id).toHaveLength(8);
    const start = match.index + '(node'.length;
    changed = changed.slice(0, start) + id + changed.slice(start + 8);
  }
  // This fixture has one name-tree leaf under /Kids. Restore valid sorted
  // names and Limits, keeping each reference attached to its relabelled ID.
  const names = /\/Names\s*\[((?:\(node\d{8}\)\s+\d+ 0 R\s*)+)\]/;
  const entries = [
    ...(changed.match(names)?.[1] ?? '').matchAll(/\(node\d{8}\)\s+\d+ 0 R/g),
  ]
    .map(match => match[0])
    .sort();
  expect(entries).toHaveLength(ids.length);
  changed = changed.replace(names, `/Names [${entries.join(' ')}]`);
  const first = entries[0]?.match(/\(node\d{8}\)/)?.[0];
  const last = entries.at(-1)?.match(/\(node\d{8}\)/)?.[0];
  changed = changed.replace(
    /\/Limits\s*\[\(node\d{8}\)\s*\(node\d{8}\)\]/,
    `/Limits [${first} ${last}]`,
  );
  expect(Buffer.byteLength(changed, 'latin1')).toBe(bytes.length);
  return new Uint8Array(Buffer.from(changed, 'latin1'));
}

async function pageContents(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    const pages = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      pages.push(
        content.items.map(item =>
          Object.fromEntries(
            Object.entries(item).filter(([key]) => key !== 'fontName'),
          ),
        ),
      );
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// Compare entire dictionaries, including object numbers, /S, /P, /K, /Pg,
// MCIDs, /ParentTreeNextKey, /MarkInfo and the catalog's /StructTreeRoot.
// Only the three explicitly removable entries are excluded from this snapshot.
function structure(bytes: Uint8Array) {
  const objects = new Map(
    [
      ...outsideStreams(bytes).matchAll(
        /(?:^|\n)(\d+) 0 obj\b([\s\S]*?)endobj/g,
      ),
    ].map(match => [match[1] ?? '', match[2] ?? ''] as const),
  );
  const selected = new Map(
    [...objects].filter(([, body]) =>
      /\/Type\s*\/(?:StructElem|StructTreeRoot|Catalog)\b/.test(body),
    ),
  );
  expect(
    [...selected.values()].filter(body => /\/Type\s*\/StructElem\b/.test(body))
      .length,
  ).toBeGreaterThan(0);
  const root = [...selected.values()].find(body =>
    /\/Type\s*\/StructTreeRoot\b/.test(body),
  );
  expect(root).toBeDefined();
  expect(
    [...selected.values()].some(body => /\/Type\s*\/Catalog\b/.test(body)),
  ).toBe(true);
  const parentTree = root?.match(/\/ParentTree\s+(\d+) 0 R/)?.[1];
  expect(parentTree).toBeDefined();
  function visitParentTree(ref: string) {
    if (selected.has(ref)) return;
    const body = objects.get(ref);
    expect(body, `missing ParentTree object ${ref}`).toBeDefined();
    selected.set(ref, body ?? '');
    for (const child of (
      body?.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] ?? ''
    ).matchAll(/(\d+) 0 R/g)) {
      visitParentTree(child[1] ?? '');
    }
  }
  visitParentTree(parentTree ?? '');
  return [...selected]
    .map(([ref, body]) => [
      ref,
      body
        .replace(/\/ID\s*\(node\d+\)/g, '')
        .replace(/\/IDTree\s+\d+ 0 R/g, '')
        .replace(/\/Headers\s*\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ])
    .sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''));
}

test.each([
  {
    scenario: 'a browser restart shifts every ID',
    change: (ids: string[]) =>
      ids.map(id => String(Number(id) + 1).padStart(8, '0')),
  },
  {
    scenario: 'two structure elements swap IDs',
    change: (ids: string[]) => [ids[1] ?? '', ids[0] ?? '', ...ids.slice(2)],
  },
  {
    scenario: 'the last element ID moves to the first rank',
    change: (ids: string[]) => [...ids.slice(1), ids[0] ?? ''],
  },
])('normalizes to identical sha256 when $scenario', async ({ change }) => {
  const original = fixture();
  const variant = withNodeIds(original, change);
  expect(sha256(variant)).not.toBe(sha256(original));
  const before = await pageContents(original);
  expect(await pageContents(variant)).toEqual(before);
  expect(structure(variant)).toEqual(structure(original));
  const normalized = stablePdf(original.slice(), documentUrl);
  const normalizedVariant = stablePdf(variant.slice(), documentUrl);
  expect(sha256(normalizedVariant)).toBe(sha256(normalized));
  expect(await pageContents(normalized)).toEqual(before);
  expect(await pageContents(normalizedVariant)).toEqual(before);
});

test('removes StructElem IDs, the root IDTree and all node strings outside streams', () => {
  const original = fixture();
  const before = outsideStreams(original);
  expect(before).toMatch(/\/ID\s*\(node\d+\)/);
  expect(before).toMatch(/\/IDTree\b/);
  expect(before).toMatch(/\/Limits\s*\[\(node\d+\)/);
  const after = outsideStreams(stablePdf(original.slice(), documentUrl));
  expect
    .soft(/\/ID\b/.test(after), 'StructElem /ID entries remain')
    .toBe(false);
  expect
    .soft(/\/IDTree\b/.test(after), 'root /IDTree entry remains')
    .toBe(false);
  // Also catches orphaned name-tree /Names and /Limits strings.
  expect
    .soft(/\(node\d+\)/.test(after), 'DOM node strings remain outside streams')
    .toBe(false);
});

test('preserves the structure elements, root, ParentTree and catalog while removing node IDs', () => {
  const original = fixture();
  expect(structure(stablePdf(original.slice(), documentUrl))).toEqual(
    structure(original),
  );
});

test('normalizes the real monthly-report rerun pair to identical sha256 without changing page count or page text', async () => {
  const originalA = fixture('rerun-0-a.pdf');
  const originalB = fixture('rerun-0-b.pdf');
  expect(sha256(originalA)).not.toBe(sha256(originalB));
  const normalizedA = stablePdf(originalA.slice(), documentUrl);
  const normalizedB = stablePdf(originalB.slice(), documentUrl);
  expect(sha256(normalizedA)).toBe(sha256(normalizedB));
  const beforeA = await pageContents(originalA);
  const beforeB = await pageContents(originalB);
  expect(beforeA.pageCount).toBeGreaterThan(0);
  expect(beforeA.pages.flat().length).toBeGreaterThan(0);
  expect(beforeB).toEqual(beforeA);
  expect(await pageContents(normalizedA)).toEqual(beforeA);
  expect(await pageContents(normalizedB)).toEqual(beforeB);
});

test('removes Headers and node strings from the real rerun fixtures while preserving table roles and attribute owners', () => {
  for (const name of ['rerun-0-a.pdf', 'rerun-0-b.pdf']) {
    const original = fixture(name);
    const before = outsideStreams(original);
    expect([...before.matchAll(/\/Headers\s*\[/g)]).toHaveLength(30);
    const normalized = stablePdf(original.slice(), documentUrl);
    const after = outsideStreams(normalized);
    expect
      .soft(/\/Headers\b/.test(after), `${name}: Headers remain`)
      .toBe(false);
    expect
      .soft(/\(node\d+\)/.test(after), `${name}: node strings remain`)
      .toBe(false);
    expect([...after.matchAll(/\/S\s*\/TH\b/g)], name).toHaveLength(9);
    expect([...after.matchAll(/\/S\s*\/TD\b/g)], name).toHaveLength(30);
    // Compare complete structure dictionaries, so deleting an /A dictionary
    // (including an otherwise empty /O /Table owner) also fails this test.
    expect(structure(normalized), name).toEqual(structure(original));
  }
});
