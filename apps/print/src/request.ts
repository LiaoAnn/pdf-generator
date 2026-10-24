import {
  gtSchema,
  manifestSchema,
  relativePathSchema,
} from '@pdf-generator/contract';
import { z } from 'zod';

/** Body of `POST /print`, and the input of `renderPdf`. */
export const printRequestSchema = z.strictObject({
  html: z
    .string()
    .min(1)
    .describe(
      'A complete HTML document that uses the platform fonts by family name, or the files of its pack by relative URL.',
    ),
  page: manifestSchema.shape.page,
  source: gtSchema.shape.source
    .optional()
    .describe(
      'What produced this fixture. With it, /print also reads the ground truth on the printed page and answers JSON.',
    ),
  pack: z
    .strictObject({
      template: relativePathSchema.describe(
        'The pack path html was filled from (manifest files.template). The print browser loads html at this path among the pack files, so its relative URLs resolve as in the pack.',
      ),
      files: z
        .record(relativePathSchema, z.base64())
        .describe(
          'The pack files the page may load (fonts, images, stylesheets), by pack path, as base64. Other files of the pack may be included.',
        ),
    })
    .optional()
    .describe(
      "The template pack's own files. Without it, the page can load only the platform's fonts.",
    ),
});

export type PrintRequest = z.infer<typeof printRequestSchema>;
export type PageSettings = PrintRequest['page'];
