import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { expect, test, vi } from 'vitest';
import { checkPdf } from './index.ts';
import * as pdfReader from './pdf.ts';

// The outer tests print real Chromium PDFs. This narrower seam pins both raw
// encodings of a known Chrome ligature: which one Chrome emits depends on
// font/browser version, so an HTML fixture cannot reliably exercise both.
test.each([
  { encoding: 'horizontal bar U+2015', raw: 'A\u2015B', expected: 'A—B' },
  {
    encoding: 'double-em-dash ligature U+0000',
    raw: 'A\u0000B',
    expected: 'A——B',
  },
])(
  'Chrome $encoding compares as em dashes without a false text difference',
  async ({ raw, expected }) => {
    const gt: GroundTruth = gtSchema.parse({
      schemaVersion: 1,
      source: {
        templateId: 'dash-alias',
        templateVersion: 1,
        seed: 'T14',
        index: 0,
      },
      pages: [{ width: 600, height: 800 }],
      blocks: [
        {
          id: 'dash',
          type: 'paragraph',
          page: 1,
          bbox: [50, 50, 300, 80],
          order: 0,
          text: expected,
        },
      ],
    });
    const reader = vi.spyOn(pdfReader, 'readPdf').mockResolvedValue({
      pages: [
        {
          width: 600,
          height: 800,
          items: [
            {
              text: raw,
              x0: 54,
              x1: 100,
              baseline: 68,
              size: 12,
              font: 'FixtureFont',
            },
          ],
        },
      ],
    });
    try {
      expect(await checkPdf(new Uint8Array(), gt)).toEqual({
        ok: true,
        differences: [],
      });
    } finally {
      reader.mockRestore();
    }
  },
);
