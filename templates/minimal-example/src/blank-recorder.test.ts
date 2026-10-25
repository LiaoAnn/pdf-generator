import { gtSchema } from '@pdf-generator/contract';
import { type Box, checkPdf, readPdf } from '@pdf-generator/self-check';
import { checkPack, fill } from '@pdf-generator/template-tools';
import { chromium } from 'playwright-core';
import { expect, test } from 'vitest';
import { packFiles } from './index.ts';

test('the printed recorder field passes text checking when filled and ink checking when null', async () => {
  const files = packFiles();
  const checked = checkPack(files);
  expect(checked.issues).toEqual([]);
  if (!checked.pack) throw new Error('minimal-example must be a valid pack');
  const { manifest } = checked.pack;
  const decoder = new TextDecoder();
  const text = (path: string) => {
    const value = files[path];
    if (value === undefined) throw new Error(`missing pack file: ${path}`);
    return typeof value === 'string' ? value : decoder.decode(value);
  };
  const sample = JSON.parse(text(manifest.files.sample));
  const styles = manifest.files.styles
    .map(path => `<style>${text(path)}</style>`)
    .join('\n');
  const browser = await chromium.launch({ headless: true });
  try {
    // Check the filled control first, so the expected RED is the blank field's ink.
    // Latin text keeps this check independent of the platform's injected TC fonts.
    for (const recorder of ['Recorder Lin', null]) {
      const page = await browser.newPage();
      try {
        const html = fill(text(manifest.files.template), {
          ...sample,
          recorder,
        }).replace('</head>', `${styles}</head>`);
        await page.setContent(html);
        await page.emulateMedia({ media: 'print' });
        // Keep the real recorder element, its .pair parent and pack styles.
        // Other blocks (tables, running footer, etc.) belong to platform acceptance.
        // Zero page margins make DOM coordinates equal PDF coordinates.
        await page.addStyleTag({ content: '@page { margin: 0 }' });
        const measured: { text: string; bbox: Box } = await page.evaluate(`
          (async () => {
            const fields = document.querySelectorAll('.pair [data-gt="field"]');
            if (fields.length !== 4) throw new Error('expected four form fields');
            const field = fields[3];
            const row = field.parentElement;
            row.replaceChildren(field);
            document.body.replaceChildren(row);
            await document.fonts.ready;
            const r = field.getBoundingClientRect();
            return {
              text: field.textContent,
              bbox: [r.left, r.top, r.right, r.bottom].map(n => n * 0.75),
            };
          })()
        `);
        expect(measured.text).toBe(recorder ?? '');
        const pdf = await page.pdf({
          preferCSSPageSize: true,
          printBackground: true,
        });
        const printed = await readPdf(pdf);
        expect(printed.pages).toHaveLength(1);
        const gt = gtSchema.parse({
          schemaVersion: 1,
          source: {
            templateId: manifest.id,
            templateVersion: 1,
            seed: 'T14-6-recorder',
            index: 0,
          },
          pages: printed.pages.map(({ width, height }) => ({ width, height })),
          blocks: [
            {
              id: 'field-4',
              type: 'field',
              page: 1,
              order: 0,
              text: recorder ?? '',
              bbox: measured.bbox,
            },
          ],
        });
        const result = await checkPdf(pdf, gt);
        expect(result, `recorder=${JSON.stringify(recorder)}`).toEqual({
          ok: true,
          differences: [],
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}, 30_000);
