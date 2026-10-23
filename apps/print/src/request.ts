import { gtSchema, manifestSchema } from '@pdf-generator/contract';
import { z } from 'zod';

/** Body of `POST /print`, and the input of `renderPdf`. */
export const printRequestSchema = z.strictObject({
  html: z
    .string()
    .min(1)
    .describe(
      'A complete, self-contained HTML document (styles inline) that uses the platform fonts by family name.',
    ),
  page: manifestSchema.shape.page,
  source: gtSchema.shape.source
    .optional()
    .describe(
      'What produced this fixture. With it, /print also reads the ground truth on the printed page and answers JSON.',
    ),
});

export type PrintRequest = z.infer<typeof printRequestSchema>;
export type PageSettings = PrintRequest['page'];
