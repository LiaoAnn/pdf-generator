import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkPack, fill, type PackIssue } from './index.ts';

function readPack(root: URL): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  function visit(directory: URL, prefix: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory())
        visit(new URL(`${entry.name}/`, directory), `${path}/`);
      else files[path] = readFileSync(new URL(entry.name, directory));
    }
  }
  visit(root, '');
  return files;
}
const diagnostic = (result: ReturnType<typeof checkPack>) => ({
  ok: result.ok,
  issues: result.issues.map(
    ({ message: _message, ...issue }: PackIssue) => issue,
  ),
  id: result.pack?.manifest.id,
});

let worker: Miniflare;
beforeAll(async () => {
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import {fill,checkPack,TemplateError} from ${JSON.stringify(entry)};
export default {async fetch(request) {
 const body = await request.json();
 if (body.kind === 'fill') {
   try { return Response.json({html:fill(body.template,body.data,{file:'worker.hbs'})}); }
   catch (error) {
     if (error instanceof TemplateError) return Response.json({issues:error.issues},{status:422});
     throw error;
   }
 }
 const result = checkPack(new Uint8Array(body.zip));
 return Response.json({ok:result.ok,issues:result.issues.map(({message,...issue})=>issue),id:result.pack?.manifest.id});
}};`,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  expect(script).toBeDefined();
  worker = new Miniflare({
    // Miniflare 5 represents an inline ES module with a Worker manifest.
    workers: [
      {
        config: {
          name: 'template-tools-test',
          compatibilityDate: '2026-09-20',
          manifest: {
            mainModule: 'worker.js',
            modules: { 'worker.js': { type: 'esm', contents: script ?? '' } },
          },
        },
      },
    ],
  });
}, 30000);

afterAll(async () => {
  await worker?.dispose();
});

it('runs the public package in workerd without eval or Node compatibility and agrees with Node', async () => {
  const template =
    '{{#each groups}}{{#each rows}}[{{@../index}}:{{@index}}]{{/each}}{{/each}}';
  const data = { groups: [{ rows: ['a', 'b'] }, { rows: ['c'] }] };
  const response = await worker.dispatchFetch('https://worker.test/', {
    method: 'POST',
    body: JSON.stringify({ kind: 'fill', template, data }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    html: fill(template, data, { file: 'worker.hbs' }),
  });
  for (const directory of ['valid/', 'broken/06-field-typo/pack/']) {
    const zip = zipSync(
      readPack(new URL(`../fixtures/${directory}`, import.meta.url)),
    );
    const expected = diagnostic(checkPack(zip));
    expect(expected.ok).toBe(directory === 'valid/');
    const response = await worker.dispatchFetch('https://worker.test/', {
      method: 'POST',
      body: JSON.stringify({ kind: 'check', zip: [...zip] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(expected)));
  }
}, 30000);

it.each([
  ['text', '民國113年12月31日|民國114年1月1日|民國113年2月29日|'],
  ['full', '中華民國113年12月31日|中華民國114年1月1日|中華民國113年2月29日|'],
  [
    'chinese',
    '中華民國一一三年十二月三十一日|中華民國一一四年一月一日|中華民國一一三年二月二十九日|',
  ],
  ['slash', '113/12/31|114/01/01|113/02/29|'],
  ['dot', '113.12.31|114.01.01|113.02.29|'],
  ['year', '113|114|113|'],
  ['month', '12|1|2|'],
  ['day', '31|1|29|'],
])(
  'keeps %s ROC dates literal across year/leap boundaries and null in workerd and Node',
  async (format, expected) => {
    const template = ['yearEnd', 'yearStart', 'leapDay', 'absent']
      .map(field => `{{rocDate ${field} format="${format}"}}`)
      .join('|');
    const data = {
      yearEnd: '2024-12-31',
      yearStart: '2025-01-01',
      leapDay: '2024-02-29',
      absent: null,
    };
    const response = await worker.dispatchFetch('https://worker.test/', {
      method: 'POST',
      body: JSON.stringify({ kind: 'fill', template, data }),
    });
    expect.soft(response.status).toBe(200);
    expect(await response.json()).toEqual({ html: expected });
    expect(fill(template, data, { file: 'worker.hbs' })).toBe(expected);
  },
);

it('surfaces an invalid Chinese ROC date as a located template-render error from workerd', async () => {
  const response = await worker.dispatchFetch('https://worker.test/', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'fill',
      template: '<p>\n  {{rocDate date format="chinese"}}</p>',
      data: { date: '2023-02-29' },
    }),
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    issues: [
      expect.objectContaining({
        code: 'template-render',
        file: 'worker.hbs',
        line: 2,
        column: 3,
      }),
    ],
  });
});
