import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { checkPack } from '../../../packages/template-tools/src/index.ts';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'import-loop-local-test';
const head = '<link rel="stylesheet" href="../styles/a.css">';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

function html(styles: string) {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">${styles}</head><body><p data-gt="paragraph">公司月報</p></body></html>`;
}

async function print(files: Record<string, string>, styles = head) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html: html(styles),
      page: { size: 'A4', orientation: 'portrait' },
      pack: {
        template: 'templates/report.hbs',
        files: Object.fromEntries(
          Object.entries(files).map(([path, css]) => [
            path,
            Buffer.from(css).toString('base64'),
          ]),
        ),
      },
    }),
  });
}

async function refusesPromptly(
  files: Record<string, string>,
  loop: string[],
  styles = head,
) {
  const started = performance.now();
  const response = await print(files, styles);
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { unexpectedContentType: contentType };
  if (!contentType.includes('application/json')) await response.body?.cancel();
  // Soft assertions retain the actual timeout code and elapsed time in RED.
  expect.soft(response.status, JSON.stringify(body)).toBe(422);
  expect.soft(body).toMatchObject({ error: { code: 'css_import_loop' } });
  expect.soft(performance.now() - started).toBeLessThan(15_000);
  const messages =
    (body as { error?: { details?: { message: string }[] } }).error?.details
      ?.map(detail => detail.message)
      .join('\n') ?? '';
  for (const path of loop) expect.soft(messages).toContain(path);
}

test.each<{
  name: string;
  files: Record<string, string>;
  loop: string[];
  styles?: string;
}>([
  {
    name: 'two sheets importing each other',
    files: {
      'styles/a.css': '@import "b.css";',
      'styles/b.css': '@import "a.css";',
    },
    loop: ['styles/a.css', 'styles/b.css'],
  },
  {
    name: 'a sheet importing itself',
    files: { 'styles/a.css': '@import "a.css";' },
    loop: ['styles/a.css'],
  },
  {
    name: 'a three-sheet loop after an acyclic prefix',
    files: {
      'styles/a.css': '@import "prefix.css";',
      'styles/prefix.css': '@import "b.css";',
      'styles/b.css': '@import "c.css";',
      'styles/c.css': '@import "d.css";',
      'styles/d.css': '@import "b.css";',
    },
    loop: ['styles/b.css', 'styles/c.css', 'styles/d.css'],
  },
  {
    name: 'a loop entered from a head style',
    files: {
      'styles/a.css': '@import "b.css";',
      'styles/b.css': '@import "a.css";',
    },
    loop: ['styles/a.css', 'styles/b.css'],
    styles: '<style>@import "../styles/a.css";</style>',
  },
])(
  'refuses $name with file diagnostics instead of pagination_timeout',
  async ({ files, loop, styles }) => {
    await refusesPromptly(files, loop, styles);
  },
);

// Paged.js Sheet.imports walks every String under the import node, after
// replaceIds and RunningHeaders.beforeTreeParse. The upload scanner does not.
const bypasses: {
  name: string;
  files: Record<string, string>;
  loop: string[];
}[] = [
  {
    name: 'vendor import string after url()',
    files: {
      'styles/a.css': '@-webkit-import url(x) "a.css";',
      'styles/x': '',
    },
    loop: ['styles/a.css'],
  },
  {
    name: 'string inside an import block',
    files: { 'styles/a.css': '@import {p{content:"a.css"}}' },
    loop: ['styles/a.css'],
  },
  {
    name: 'ID selector rewritten into an import string',
    files: { 'styles/a.css': '@import {#a{}}', 'styles/a': '@import "a.css";' },
    loop: ['styles/a.css', 'styles/a'],
  },
  {
    name: 'NUL stripped by URL resolution rather than replaced by U+FFFD',
    files: { 'styles/a.css': '@import "\0a.css";', 'styles/\uFFFDa.css': '' },
    loop: ['styles/a.css'],
  },
  {
    name: 'RunningHeaders rewriting element(a) inside a filename',
    files: {
      'styles/a.css': '@import "element(a).css";',
      'styles/element(a).css': '',
      'styles/element-ident(a).css': '@import "a.css";',
    },
    loop: ['styles/a.css', 'styles/element-ident(a).css'],
  },
];

test.each(bypasses)(
  'refuses the upload-check bypass: $name',
  async ({ files, loop }) => {
    const checked = checkPack({
      'manifest.json': JSON.stringify({
        schemaVersion: 1,
        id: 'import-loop',
        name: '循環引用測試',
        page: { size: 'A4', orientation: 'portrait' },
        files: {
          template: 'templates/report.hbs',
          styles: ['styles/a.css'],
          rules: 'data/rules.json',
          sample: 'data/sample.json',
          assets: Object.keys(files).filter(path => path !== 'styles/a.css'),
        },
      }),
      'templates/report.hbs': html(''),
      'data/rules.json': JSON.stringify({
        schemaVersion: 1,
        fields: { holder: { type: 'name' } },
      }),
      'data/sample.json': JSON.stringify({ holder: '王小明' }),
      ...files,
    });
    expect(
      checked.issues.filter(issue => issue.code === 'css-import-cycle'),
    ).toEqual([]);
    expect(checked.ok, JSON.stringify(checked.issues)).toBe(true);
    await refusesPromptly(files, loop);
  },
);

test('refuses thousands of acyclic imports instead of allowing sheet-load amplification', async () => {
  await refusesPromptly(
    {
      'styles/a.css': '@import "leaf.css";\n'.repeat(4096),
      'styles/leaf.css': 'p { color: black; }',
    },
    [],
  );
});

test.each<{ name: string; files: Record<string, string> }>([
  {
    name: 'nested a → b → c imports',
    files: {
      'styles/a.css': '@import "b.css";',
      'styles/b.css': '@import "c.css";',
      'styles/c.css': '@media print { p { font-family: "Noto Serif TC"; } }',
    },
  },
  {
    name: 'diamond imports sharing a leaf',
    files: {
      'styles/a.css': '@import "b.css"; @import "c.css";',
      'styles/b.css': '@import "d.css";',
      'styles/c.css': '@import "d.css";',
      'styles/d.css': '@media print { p { font-family: "Noto Serif TC"; } }',
    },
  },
])(
  'prints $name and embeds the leaf font rather than treating shared sheets as a loop',
  async ({ files }) => {
    const response = await print(files);
    expect(
      response.status,
      response.status === 200 ? '' : await response.text(),
    ).toBe(200);
    const pdf = await getDocumentProxy(
      new Uint8Array(await response.arrayBuffer()),
    );
    try {
      const raw = Buffer.from(await pdf.getData()).toString('latin1');
      const fonts = [...raw.matchAll(/\/BaseFont\s*\/([^\s/<>]+)/g)].map(
        match => (match[1] ?? '').replace(/^[A-Z]{6}\+/, ''),
      );
      expect(fonts).toContain('NotoSerifTC-Regular');
      expect(raw).toMatch(/\/FontFile[23]?\b/);
      expect(
        (await extractText(pdf, { mergePages: true })).text.replace(/\s/gu, ''),
      ).toContain('公司月報');
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
);
