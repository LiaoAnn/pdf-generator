import { z } from 'zod';
import { relativePathSchema, slugSchema } from './primitives.ts';

const pathWithExtension = (extension: string) =>
  relativePathSchema.regex(
    new RegExp(String.raw`\.${extension}(?![\s\S])`),
    `must end in .${extension}`,
  );

const filesSchema = z
  .strictObject({
    template: pathWithExtension('hbs').describe(
      'Handlebars template that renders the whole document.',
    ),
    styles: z
      .array(pathWithExtension('css'))
      .describe('Stylesheets, applied in this order.'),
    rules: pathWithExtension('json').describe(
      'Fake-data rule file (the `rules` contract).',
    ),
    sample: pathWithExtension('json').describe(
      'Sample record the template renders without the fake-data engine.',
    ),
    assets: z
      .array(relativePathSchema)
      .optional()
      .describe('Other files the template references: images, fonts.'),
  })
  .describe('Files of the pack, as paths relative to the pack root.');

/** `manifest.json` at the root of a template pack zip. */
export const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: slugSchema.describe('Stable identifier of the template.'),
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(/\S/)
      .describe('Display name, e.g. 公司月報.'),
    description: z.string().max(2000).optional(),
    page: z.strictObject({
      size: z.literal('A4'),
      orientation: z.enum(['portrait', 'landscape']),
    }),
    files: filesSchema,
  })
  .superRefine((manifest, ctx) => {
    const { template, styles, rules, sample, assets = [] } = manifest.files;
    const entries: [string, (string | number)[]][] = [
      [template, ['template']],
      ...styles.map((path, i): [string, (string | number)[]] => [
        path,
        ['styles', i],
      ]),
      [rules, ['rules']],
      [sample, ['sample']],
      ...assets.map((path, i): [string, (string | number)[]] => [
        path,
        ['assets', i],
      ]),
    ];
    const seen = new Set<string>();
    for (const [path, at] of entries) {
      if (seen.has(path)) {
        ctx.addIssue({
          code: 'custom',
          message: `${path} is listed more than once`,
          path: ['files', ...at],
        });
      }
      seen.add(path);
    }
  })
  .meta({
    title: 'Template pack manifest',
    description:
      'manifest.json at the root of a template pack zip. Not expressible in JSON Schema: no file path may be listed twice.',
  });

export type Manifest = z.infer<typeof manifestSchema>;
