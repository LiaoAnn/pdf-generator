import { manifestSchema } from '@pdf-generator/contract';
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
});

export type PrintRequest = z.infer<typeof printRequestSchema>;
export type PageSettings = PrintRequest['page'];
