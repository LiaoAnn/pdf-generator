import { z } from 'zod';
import {
  blockFields,
  blockRules,
  blockTypes,
  checkBlocks,
  pageSchema,
} from './layout.ts';

const listedBlockSchema = z.strictObject({
  ...blockFields,
  type: z.enum(blockTypes),
  confidence: z.number().min(0).max(1).optional(),
  latex: z.string().optional().describe('A formula as LaTeX.'),
  checked: z.boolean().optional().describe("A checkbox's state."),
  html: z.string().optional().describe("A table's structure as HTML."),
});

export type ListedBlock = z.infer<typeof listedBlockSchema>;

/** The block list: blocks a layout model (MinerU, …) found in a real PDF. */
export const blockListSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z.strictObject({
      file: z.string().min(1).max(255).describe("The PDF's file name."),
      tool: z
        .strictObject({ name: z.string().min(1), version: z.string().min(1) })
        .describe('The model that found the blocks, e.g. mineru 2.5.4.'),
    }),
    pages: z.array(pageSchema).min(1),
    blocks: z.array(listedBlockSchema),
  })
  .superRefine(checkBlocks)
  .meta({
    title: 'Block list',
    description: `Blocks found in a real PDF by the local layout tooling, in the coordinates of gt.json. Not expressible in JSON Schema: ${blockRules}.`,
  });

export type BlockList = z.infer<typeof blockListSchema>;
