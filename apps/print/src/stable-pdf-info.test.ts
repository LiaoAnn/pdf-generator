import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getDocumentProxy } from 'unpdf';
import { expect, test } from 'vitest';
import { stablePdf } from './stable-pdf.ts';

const urlA =
  'http://127.0.0.1:46341/pack/20b6a469-c5f1-487e-81c8-edc637db5b83/index.html';
const urlB =
  'http://127.0.0.1:46341/pack/02a98cb2-6739-4705-9392-1ca09ff51cdb/index.html';

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./test-fixtures/${name}.pdf`, import.meta.url)),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function withLiteralTitle(title: string): Uint8Array {
  const original = fixture('untitled-print-a');
  const source = Buffer.from(original).toString('latin1');
  const entry = `/Title (${urlA.replace('http://', '')})`;
  expect(source.split(entry)).toHaveLength(2);
  const replacement = `/Title (${title})`;
  expect(replacement.length).toBeLessThanOrEqual(entry.length);
  // Pad outside the string so the parsed title is exact and xref offsets stay valid.
  const changed = source.replace(entry, replacement.padEnd(entry.length, ' '));
  expect(Buffer.byteLength(changed, 'latin1')).toBe(original.length);
  return new Uint8Array(Buffer.from(changed, 'latin1'));
}

async function contents(bytes: Uint8Array) {
  // PDF.js may transfer its input buffer; never let it detach the test input.
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    const { info, metadata } = await pdf.getMetadata();
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
    return {
      pageCount: pdf.numPages,
      pages,
      info: info as Record<string, unknown>,
      metadata: metadata?.getRaw() ?? null,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function otherInfo(info: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(info).filter(
      ([key]) => !['Title', 'CreationDate', 'ModDate'].includes(key),
    ),
  );
}

test('repeat prints with different timestamps and fallback URLs produce the same sha256 without changing pages or other metadata', async () => {
  const a = fixture('untitled-print-a');
  const b = fixture('untitled-print-b');
  expect(sha256(a)).not.toBe(sha256(b));
  const stableA = stablePdf(a.slice(), urlA);
  const stableB = stablePdf(b.slice(), urlB);
  // Hashes avoid a huge binary diff if this regression returns.
  expect(sha256(stableA)).toBe(sha256(stableB));

  for (const [original, normalized] of [
    [a, stableA],
    [b, stableB],
  ] as const) {
    const before = await contents(original);
    const after = await contents(normalized);
    expect(after.pageCount).toBe(before.pageCount);
    expect(after.pages).toEqual(before.pages);
    expect(after.metadata).toEqual(before.metadata);
    expect(otherInfo(after.info)).toEqual(otherInfo(before.info));
    expect(after.info.CreationDate ?? null).toBeNull();
    expect(after.info.ModDate ?? null).toBeNull();
    const raw = Buffer.from(normalized).toString('latin1');
    expect(raw).not.toMatch(/\/(?:CreationDate|ModDate)\b/);
    expect(raw).not.toContain('/pack/20b6a469-c5f1-487e-81c8-edc637db5b83/');
    expect(raw).not.toContain('/pack/02a98cb2-6739-4705-9392-1ca09ff51cdb/');
  }
});

test('removing print dates preserves a template-authored Chinese Title and its other metadata', async () => {
  const original = fixture('titled-print');
  const before = await contents(original);
  expect(before.info.Title).toBe('固定');
  const after = await contents(stablePdf(original.slice(), urlA));
  expect(after.info.Title).toBe('固定');
  expect(after.info.CreationDate ?? null).toBeNull();
  expect(after.info.ModDate ?? null).toBeNull();
  expect(otherInfo(after.info)).toEqual(otherInfo(before.info));
  expect(after.metadata).toEqual(before.metadata);
  expect(after.pages).toEqual(before.pages);
  expect(after.pageCount).toBe(before.pageCount);
});

test('removing print dates preserves a template-authored ASCII literal-string Title', async () => {
  const original = withLiteralTitle('Monthly report');
  expect((await contents(original)).info.Title).toBe('Monthly report');
  const after = await contents(stablePdf(original.slice(), urlA));
  expect(after.info.Title).toBe('Monthly report');
  expect(after.info.CreationDate ?? null).toBeNull();
  expect(after.info.ModDate ?? null).toBeNull();
});

test('removes dates and produces identical sha256 across print seconds when an authored Title contains endobj', async () => {
  const a = withLiteralTitle('Monthly endobj report');
  const source = Buffer.from(a).toString('latin1');
  let datesChanged = 0;
  const changed = source.replace(
    /(\/(?:CreationDate|ModDate)\s*\(D:\d{12})(\d{2})/g,
    (_, prefix: string, seconds: string) => {
      datesChanged++;
      return prefix + String((Number(seconds) + 1) % 60).padStart(2, '0');
    },
  );
  expect(datesChanged).toBe(2);
  expect(Buffer.byteLength(changed, 'latin1')).toBe(a.length);
  const b = new Uint8Array(Buffer.from(changed, 'latin1'));
  expect(sha256(a)).not.toBe(sha256(b));
  const stableA = stablePdf(a.slice(), urlA);
  const stableB = stablePdf(b.slice(), urlA);
  expect.soft(sha256(stableA)).toBe(sha256(stableB));
  for (const [original, normalized] of [
    [a, stableA],
    [b, stableB],
  ] as const) {
    const before = await contents(original);
    expect(before.info.Title).toBe('Monthly endobj report');
    expect(before.info.CreationDate).toBeTruthy();
    expect(before.info.ModDate).toBeTruthy();
    const after = await contents(normalized);
    expect(after.info.Title).toBe('Monthly endobj report');
    expect.soft(after.info.CreationDate ?? null).toBeNull();
    expect.soft(after.info.ModDate ?? null).toBeNull();
  }
});

test('a valid PDF without Info, dates, Title or a structure tree remains readable and unchanged in content', async () => {
  const original = fixture('blank-1-pages');
  const before = await contents(original);
  const after = await contents(stablePdf(original.slice(), urlA));
  expect(after).toEqual(before);
});
