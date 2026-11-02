import {
  gtSchema,
  manifestSchema,
  relativePathSchema,
} from '@pdf-generator/contract';
import { z } from 'zod';

const packFilesSchema = z
  .record(relativePathSchema, z.base64())
  .describe(
    'The pack files the page may load (fonts, images, stylesheets), by pack path, as base64. Other files of the pack may be included.',
  );

const templatePathSchema = relativePathSchema.describe(
  'The pack path html was filled from (manifest files.template). The print browser loads html at this path among the pack files, so its relative URLs resolve as in the pack.',
);

/** A batch id: a lower-case UUID, it scopes an uploaded pack to its batch. */
export const batchIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/,
  )
  .describe('A batch id: a lower-case UUID.');

const digestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}(?![\s\S])/)
  .describe('The lower-case hex SHA-256 of the uploaded pack files.');

/** Body of `PUT /batch/<batch>/pack`: the batch's pack files, sent once. */
export const packUploadSchema = z.strictObject({
  files: packFilesSchema,
});

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
    .union([
      z.strictObject({ template: templatePathSchema, files: packFilesSchema }),
      z.strictObject({
        template: templatePathSchema,
        batch: batchIdSchema,
        digest: digestSchema,
      }),
    ])
    .optional()
    .describe(
      "The template pack's own files: inline as `files`, or by reference to the pack a batch uploaded with PUT /batch/<batch>/pack (never both). Without it, the page can load only the platform's fonts.",
    ),
});

export type PrintRequest = z.infer<typeof printRequestSchema>;
export type PageSettings = PrintRequest['page'];
