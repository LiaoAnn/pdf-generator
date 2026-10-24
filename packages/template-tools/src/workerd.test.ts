import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
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

it('runs the public package in workerd without eval or Node compatibility and agrees with Node', async () => {
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import {fill,checkPack} from ${JSON.stringify(entry)};
export default {async fetch(request) {
 const body = await request.json();
 if (body.kind === 'fill') return Response.json({html:fill(body.template,body.data,{file:'worker.hbs'})});
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
  const worker = new Miniflare({
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
  try {
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
      expect(await response.json()).toEqual(
        JSON.parse(JSON.stringify(expected)),
      );
    }
  } finally {
    await worker.dispose();
  }
}, 30000);
