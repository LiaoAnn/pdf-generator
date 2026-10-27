import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getDocumentProxy } from 'unpdf';
import { expect, test } from 'vitest';
import { stablePdf } from './stable-pdf.ts';

const documentUrl =
  'http://127.0.0.1:46341/pack/20b6a469-c5f1-487e-81c8-edc637db5b83/index.html';

function fixture(): Uint8Array {
  return new Uint8Array(
    readFileSync(
      new URL('./test-fixtures/untitled-print-a.pdf', import.meta.url),
    ),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function shiftedIds(bytes: Uint8Array): Uint8Array {
  // Equal-width replacements keep every xref offset valid in this real PDF.
  const source = Buffer.from(bytes).toString('latin1');
  expect(source).toMatch(/node\d{8}/);
  return new Uint8Array(
    Buffer.from(
      source.replace(
        /node(\d{8})/g,
        (_, digits: string) =>
          `node${String(Number(digits) + 1).padStart(8, '0')}`,
      ),
      'latin1',
    ),
  );
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
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// These Chrome fixtures use ordinary indirect dictionaries, not object streams.
// Inspect the IDTree itself: PDF.js text extraction cannot detect broken names.
function structure(bytes: Uint8Array) {
  const source = Buffer.from(bytes).toString('latin1');
  const objects = new Map(
    [...source.matchAll(/(?:^|\n)(\d+) 0 obj\b([\s\S]*?)endobj/g)].map(
      match => [match[1] ?? '', match[2] ?? ''] as const,
    ),
  );
  const elements = new Map(
    [...objects].filter(([, body]) => /\/Type\s*\/StructElem\b/.test(body)),
  );
  expect(elements.size).toBeGreaterThan(0);
  const root = [...objects.values()].find(body =>
    /\/Type\s*\/StructTreeRoot\b/.test(body),
  );
  const tree = root?.match(/\/IDTree\s+(\d+) 0 R/)?.[1];
  expect(tree).toBeDefined();
  const entries: { name: string; ref: string }[] = [];
  const visited = new Set<string>();

  function visit(ref: string): string[] {
    expect(visited.has(ref), 'IDTree must not contain a cycle').toBe(false);
    visited.add(ref);
    const body = objects.get(ref);
    expect(body, `missing IDTree object ${ref}`).toBeDefined();
    const names = body?.match(/\/Names\s*\[([\s\S]*?)\]/)?.[1];
    const kids = body?.match(/\/Kids\s*\[([\s\S]*?)\]/)?.[1];
    expect(names !== undefined || kids !== undefined).toBe(true);
    const localNames: string[] = [];
    if (names !== undefined) {
      for (const entry of names.matchAll(/\(([^()]*)\)\s+(\d+) 0 R/g)) {
        const name = entry[1] ?? '';
        const target = entry[2] ?? '';
        localNames.push(name);
        entries.push({ name, ref: target });
        expect(elements.has(target), 'name must point to a StructElem').toBe(
          true,
        );
        expect(elements.get(target)?.match(/\/ID\s*\(([^()]*)\)/)?.[1]).toBe(
          name,
        );
      }
    }
    if (kids !== undefined) {
      for (const child of kids.matchAll(/(\d+) 0 R/g)) {
        localNames.push(...visit(child[1] ?? ''));
      }
    }
    expect(localNames).toEqual([...localNames].sort());
    const limits = body?.match(/\/Limits\s*\[\(([^()]*)\)\s*\(([^()]*)\)\]/);
    if (limits) {
      expect(limits[1]).toBe(localNames[0]);
      expect(limits[2]).toBe(localNames.at(-1));
    }
    return localNames;
  }

  visit(tree ?? '');
  expect(entries.length).toBe(elements.size);
  expect(new Set(entries.map(entry => entry.name)).size).toBe(elements.size);
  expect(new Set(entries.map(entry => entry.ref)).size).toBe(elements.size);
  // Compare roles, child links and marked-content IDs without prescribing
  // canonical node IDs or indirect-object numbers chosen by a PDF writer.
  function elementContents(ref: string, ancestors = new Set<string>()): string {
    expect(ancestors.has(ref), 'StructElem children must not cycle').toBe(
      false,
    );
    const path = new Set([...ancestors, ref]);
    return (elements.get(ref) ?? '')
      .replace(/\/ID\s*\([^()]*\)/, '')
      .replace(/\/P\s+\d+ 0 R/, '')
      .replace(/\/Pg\s+\d+ 0 R/g, '/Pg PAGE')
      .replace(/(\d+) 0 R/g, (_, child: string) => elementContents(child, path))
      .replace(/\s+/g, ' ')
      .trim();
  }
  return entries.map(entry => elementContents(entry.ref)).sort();
}

test('a browser restart shifting every DOM node ID still produces identical PDF bytes and readable page content', async () => {
  const original = fixture();
  const shifted = shiftedIds(original);
  expect(sha256(shifted)).not.toBe(sha256(original));
  const before = await pageContents(original);
  expect(await pageContents(shifted)).toEqual(before);
  const normalized = stablePdf(original.slice(), documentUrl);
  const normalizedShifted = stablePdf(shifted.slice(), documentUrl);
  expect(sha256(normalizedShifted)).toBe(sha256(normalized));
  expect(await pageContents(normalized)).toEqual(before);
  expect(await pageContents(normalizedShifted)).toEqual(before);
});

test('normalization keeps every StructElem linked through sorted IDTree names and correct Limits', () => {
  const original = fixture();
  const before = structure(original);
  for (const input of [original, shiftedIds(original)]) {
    expect(structure(stablePdf(input.slice(), documentUrl))).toEqual(before);
  }
});
