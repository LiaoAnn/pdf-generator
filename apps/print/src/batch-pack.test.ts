// A batch uploads its pack once (PUT /batch/<id>/pack) and prints by
// reference to it ({ template, batch, digest }); the browser loads the files
// at /batch/<id>/<digest>/<path>, the same URL for every print of the batch.
import { URL } from 'node:url';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { apiErrorSchema } from '../../../packages/contract/src/index.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';
import { readValidPack, type ValidPack } from './valid-pack.fixture.ts';

const token = 'batch-pack-local-test';
const batch = '5f0c2a52-8f0e-4c8e-9a51-0d6e3b7a1c01';
const otherBatch = '5f0c2a52-8f0e-4c8e-9a51-0d6e3b7a1c02';
let worker: PrintWorker;
let pack: ValidPack;
let origin: string;

beforeAll(async () => {
  pack = await readValidPack();
  worker = await startPrintWorker(token);
  origin = (await worker.url).origin;
});

afterAll(async () => {
  await worker?.dispose();
});

const auth = { authorization: `Bearer ${token}` };

async function upload(
  id: string,
  files: Record<string, string>,
  headers: Record<string, string> = auth,
) {
  return worker.fetch(new URL(`/batch/${id}/pack`, origin).href, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  });
}

async function digestOf(id: string, files: Record<string, string>) {
  const response = await upload(id, files);
  expect(response.status).toBe(200);
  const { digest } = (await response.json()) as { digest: string };
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  return digest;
}

async function print(body: unknown) {
  return worker.fetch(new URL('/print', origin).href, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const reference = (id: string, digest: string, html = pack.html()) => ({
  html,
  page: pack.page,
  pack: { template: pack.template, batch: id, digest },
});

type Answer = Awaited<ReturnType<PrintWorker['fetch']>>;

async function error(response: Answer, status: number, code: string) {
  expect(response.status).toBe(status);
  const parsed = apiErrorSchema.parse(await response.json()).error;
  expect(parsed.code).toBe(code);
  return parsed;
}

const withCss = (css: string) => ({
  ...pack.files,
  'styles/report.css': Buffer.from(
    `${Buffer.from(pack.files['styles/report.css'] ?? '', 'base64')}\n${css}`,
  ).toString('base64'),
});

// Regression: a reference the Worker can't resolve to the uploaded files
// prints the platform's fallback font or fails on the missing stylesheet.
test('a batch prints by reference to its uploaded pack, with the pack font loaded', async () => {
  const digest = await digestOf(batch, pack.files);
  const response = await print(
    reference(batch, digest, pack.html({ company: '參照印出有限公司' })),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/pdf\b/);
  const document = await getDocumentProxy(
    new Uint8Array(await response.arrayBuffer()),
  );
  const { text } = await extractText(document, { mergePages: true });
  const normalized = text.normalize('NFKC').replace(/\s/gu, '');
  expect(normalized).toContain('公司月報');
  expect(normalized).toContain('參照印出有限公司');
});

// Regression: a digest of the request's encoding or key order uploads the
// same pack twice; one that ignores content lets two template versions share
// one URL, and the browser's copy of the old file.
test('the digest names the content: key order does not change it, one changed byte does', async () => {
  const digest = await digestOf(batch, pack.files);
  const reversed = Object.fromEntries(Object.entries(pack.files).reverse());
  expect(await digestOf(batch, reversed)).toBe(digest);
  expect(await digestOf(otherBatch, pack.files)).toBe(digest);
  expect(await digestOf(batch, withCss('p { color: #000; }'))).not.toBe(digest);
});

// Regression: files looked up by digest alone are shared between batches,
// and a page of one template version could load another version's files.
test('a print reads only its own batch and digest', async () => {
  const version1 = await digestOf(batch, pack.files);
  const version2 = await digestOf(batch, withCss('h1 { color: #333; }'));
  await error(
    // version2 was uploaded to `batch` only.
    await print(reference(otherBatch, version2)),
    409,
    'pack_not_uploaded',
  );
  await error(
    await print(reference(batch, 'f'.repeat(64))),
    409,
    'pack_not_uploaded',
  );

  // Uploaded to the other batch too: still not loadable from this batch.
  await digestOf(otherBatch, pack.files);
  for (const url of [
    `${origin}/batch/${batch}/${version1}/styles/report.css`,
    `${origin}/batch/${otherBatch}/${version1}/styles/report.css`,
  ]) {
    const html = pack
      .html()
      .replace('</head>', `<link rel="stylesheet" href="${url}"></head>`);
    const refused = await error(
      await print(reference(batch, version2, html)),
      422,
      'request_blocked',
    );
    expect(refused.details?.map(detail => detail.message)).toContain(url);
  }
});

// Regression: no-store or a per-print URL makes the browser load every file
// again for every print; serving any other path exposes files nobody printed.
test('batch files are served immutable at their batch path, and nothing else is', async () => {
  const digest = await digestOf(batch, pack.files);
  const css = await worker.fetch(
    `${origin}/batch/${batch}/${digest}/styles/report.css`,
  );
  expect(css.status).toBe(200);
  expect(css.headers.get('content-type')).toMatch(/^text\/css\b/);
  expect(css.headers.get('cache-control')).toMatch(/\bimmutable\b/);
  expect(css.headers.get('cache-control')).toMatch(/\bmax-age=[1-9]\d*/);
  expect(css.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await css.text()).toContain('Report Sans');

  for (const path of [
    `/batch/${batch}/${digest}/styles/missing.css`,
    `/batch/${batch}/${'0'.repeat(64)}/styles/report.css`,
    `/batch/5f0c2a52-8f0e-4c8e-9a51-0d6e3b7a1c09/${digest}/styles/report.css`,
    `/batch/${batch}/${digest}/${pack.template}?print=${crypto.randomUUID()}`,
  ]) {
    const response = await worker.fetch(`${origin}${path}`);
    expect(response.status, path).toBe(404);
  }
});

// Regression: an unchecked upload stores what /print would refuse, under any
// name, for anyone.
test('refuses uploads and references that are not well formed', async () => {
  await error(await upload(batch, pack.files, {}), 401, 'unauthorized');
  await error(await upload('not-a-batch', pack.files), 400, 'invalid_request');
  await error(
    await upload(batch, {
      '../escape.css': pack.files['styles/report.css'] ?? '',
    }),
    400,
    'invalid_request',
  );
  await error(
    await upload(batch, {
      'assets/huge.bin': Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'),
    }),
    413,
    'pack_too_large',
  );
  const digest = await digestOf(batch, pack.files);
  await error(
    await print(reference(batch, 'not-a-digest')),
    400,
    'invalid_request',
  );
  await error(
    await print({
      ...reference(batch, digest),
      pack: { template: pack.template, batch, digest, files: pack.files },
    }),
    400,
    'invalid_request',
  );
});
