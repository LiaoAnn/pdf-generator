import { z } from 'zod';
import {
  bboxSchema,
  blockFields,
  blockRules,
  blockTypes,
  checkBlocks,
  pageSchema,
} from './layout.ts';
import { seedSchema, slugSchema } from './primitives.ts';

const common = {
  ...blockFields,
  continues: blockFields.id
    .optional()
    .describe(
      'Id of the block this one continues: the same element on an earlier page, e.g. a table split across pages.',
    ),
};

const detailTypes = ['table', 'checkbox', 'formula'] as const;
const plainTypes = blockTypes.filter(
  (
    type,
  ): type is Exclude<
    (typeof blockTypes)[number],
    (typeof detailTypes)[number]
  > => !(detailTypes as readonly string[]).includes(type),
);

const cellSchema = z.strictObject({
  row: z.int().min(0),
  col: z.int().min(0),
  rowSpan: z.int().min(1),
  colSpan: z.int().min(1),
  header: z
    .boolean()
    .describe('A header cell (repeated on every page it is printed on).'),
  text: z.string(),
  bbox: bboxSchema,
  checkboxes: z
    .array(
      z.strictObject({
        checked: z.boolean(),
        text: z
          .string()
          .describe("The option's label, e.g. 是 for a box printed as □是."),
        bbox: bboxSchema,
      }),
    )
    .optional()
    .describe(
      'Checkboxes printed inside the cell, in the order they appear in it; bbox is the box of the checkbox element itself.',
    ),
});

const gtBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.enum(plainTypes) }),
  z.strictObject({
    ...common,
    type: z.literal('table'),
    table: z
      .strictObject({
        rows: z.int().min(1),
        cols: z.int().min(1),
        cells: z.array(cellSchema),
      })
      .describe("This block's grid: the fragment printed on this page."),
  }),
  z.strictObject({
    ...common,
    type: z.literal('checkbox'),
    checked: z.boolean(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('formula'),
    latex: z.string().min(1),
  }),
]);

export type GtBlock = z.infer<typeof gtBlockSchema>;

/** gt.json: the ground truth of one printed PDF fixture. */
export const gtSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z
      .strictObject({
        templateId: slugSchema,
        templateVersion: z.int().min(1),
        seed: seedSchema,
        index: z.int().min(0).describe('Index of the fixture in its batch.'),
      })
      .describe('What produced this fixture.'),
    pages: z.array(pageSchema).min(1),
    blocks: z.array(gtBlockSchema),
  })
  .superRefine((gt, ctx) => {
    checkBlocks(gt, ctx);
    const byId = new Map(gt.blocks.map(block => [block.id, block]));
    gt.blocks.forEach((block, i) => {
      if (block.continues !== undefined) {
        const target = byId.get(block.continues);
        if (
          target === undefined ||
          target.type !== block.type ||
          target.page >= block.page
        ) {
          ctx.addIssue({
            code: 'custom',
            message:
              'continues must name a block of the same type on an earlier page',
            path: ['blocks', i, 'continues'],
          });
        }
      }
      if (block.type === 'table') {
        const { rows, cols, cells } = block.table;
        const page = gt.pages[block.page - 1];
        cells.forEach((cell, j) => {
          // Checked against the page, not the cell: rounding can push a box
          // a fraction past its cell's edge.
          cell.checkboxes?.forEach((checkbox, k) => {
            if (
              page !== undefined &&
              (checkbox.bbox[2] > page.width || checkbox.bbox[3] > page.height)
            ) {
              ctx.addIssue({
                code: 'custom',
                message: 'checkbox bbox lies outside its page',
                path: [
                  'blocks',
                  i,
                  'table',
                  'cells',
                  j,
                  'checkboxes',
                  k,
                  'bbox',
                ],
              });
            }
          });
          if (
            cell.row + cell.rowSpan > rows ||
            cell.col + cell.colSpan > cols
          ) {
            ctx.addIssue({
              code: 'custom',
              message: 'cell lies outside the grid',
              path: ['blocks', i, 'table', 'cells', j],
            });
          }
        });
      }
    });
  })
  .meta({
    title: 'Ground truth (gt.json)',
    description: `Every data-gt block of one printed PDF fixture. Not expressible in JSON Schema: ${blockRules}; continues names a block of the same type on an earlier page; a table cell's row + rowSpan ≤ rows and col + colSpan ≤ cols; a cell checkbox's bbox lies inside its block's page.`,
  });

export type GroundTruth = z.infer<typeof gtSchema>;
