import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { extractText } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { apiErrorSchema } from '../../../packages/contract/src/index.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'slice-four-local-test-token';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

async function print(html: string, session?: string, landscape = false) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(session ? { 'X-Browser-Session': session } : {}),
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: landscape ? 'landscape' : 'portrait' },
    }),
  });
}

async function close(session: string, authorization = `Bearer ${token}`) {
  return fetch(new URL(`/session/${session}`, (await worker.url).href), {
    method: 'DELETE',
    headers: { Authorization: authorization },
  });
}

// Regression: closing each request's browser prevents batch reuse; retaining a
// deleted id prevents recovery. The three renders also guard against the new
// text check rejecting valid acceptance documents (including repeated headers).
test('acceptance PDFs survive session open, reuse, close and replacement of a deleted session', async () => {
  const sessions = new Set<string>();
  let session = 'new';
  try {
    for (const [i, name] of ['portrait', 'landscape', 'table'].entries()) {
      const html = await readFile(
        new URL(`../acceptance/${name}.html`, import.meta.url),
        'utf8',
      );
      const response = await print(html, session, name === 'landscape');
      expect(response.status).toBe(200);
      const { text, totalPages } = await extractText(
        new Uint8Array(await response.arrayBuffer()),
        { mergePages: false },
      );
      expect(totalPages).toBe([3, 1, 4][i]);
      expect(text.join('').replace(/\s/gu, '')).toContain(
        ['台灣測試股份有限公司', '一一五年第三季各區營收', '三、結語'][i],
      );
      const id = response.headers.get('X-Browser-Session');
      expect
        .soft(id, 'kept sessions must be returned to the caller')
        .toBeTruthy();
      if (id) sessions.add(id);
      if (i === 0) session = id ?? 'missing-session';
      if (i === 1) {
        expect
          .soft(id, 'the second request must reuse the first browser')
          .toBe(session);
        const closed = await close(session);
        expect.soft(closed.status).toBe(204);
        expect.soft(await closed.text()).toBe('');
      }
      if (i === 2) {
        expect.soft(id, 'a deleted browser must be replaced').not.toBe(session);
      }
    }
  } finally {
    for (const id of sessions) await close(id);
  }
});

// Regression: a DOM-only safety check accepts this known Noto text-layer loss.
test('a visible data-gt double em dash returns text_missing instead of a lossy PDF', async () => {
  const response = await print(`<!doctype html><html><head><style>
    body { font-family: "Noto Sans TC"; }
    </style></head><body><p data-gt="punctuation">——</p></body></html>`);
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toMatch(/application\/json/i);
  expect(response.headers.has('x-page-count')).toBe(false);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe('text_missing');
  expect(error.details).toContainEqual({ message: 'page 1: ——' });
});

test.each(['', 'Bearer wrong-token'])(
  'session deletion rejects unauthorized caller %j before accessing a browser',
  async authorization => {
    const response = await close('nonexistent-session', authorization);
    expect(response.status).toBe(401);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      'unauthorized',
    );
  },
);

test('deleting an unavailable session returns a contract session_not_found error', async () => {
  const response = await close('nonexistent-session');
  expect(response.status).toBe(404);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
    'session_not_found',
  );
});
