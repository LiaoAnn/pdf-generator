// What gt.json and the block list share: block types, the coordinate
// convention and the document-wide block rules.
import { z } from 'zod';

/** Block types of gt.json and the block list. */
export const blockTypes = [
  'title',
  'heading',
  'paragraph',
  'list_item',
  'label',
  'field',
  'table',
  'image',
  'caption',
  'formula',
  'checkbox',
  'barcode',
  'page_header',
  'page_footer',
  'page_number',
  'footnote',
  'reference',
] as const;

export type BlockType = (typeof blockTypes)[number];

const coordinate = z.number().min(0);

/** `[x0, y0, x1, y1]` in PDF points from the page's top-left corner. */
export const bboxSchema = z
  .tuple([coordinate, coordinate, coordinate, coordinate])
  .refine(([x0, y0, x1, y1]) => x0 < x1 && y0 < y1, 'needs x0 < x1 and y0 < y1')
  .describe(
    '[x0, y0, x1, y1] in PDF points (1/72 inch), origin at the top-left corner of the page, x to the right, y down; x0 < x1, y0 < y1.',
  );

export const pageSchema = z
  .strictObject({ width: z.number().positive(), height: z.number().positive() })
  .describe(
    'Page size in PDF points (A4 portrait: 595.28 × 841.89). Page n is pages[n - 1].',
  );

/** Keys every block has, in gt.json and in the block list. */
export const blockFields = {
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .describe('Unique within the document.'),
  page: z.int().min(1).describe('Page number, from 1.'),
  bbox: bboxSchema,
  order: z
    .int()
    .min(0)
    .describe(
      'Reading order across the whole document, from 0; the orders of all blocks are 0..n-1.',
    ),
  text: z
    .string()
    .describe(
      'Text of the block (empty for a blank field; for an image, the text inside it).',
    ),
};

/** Description of the rules `checkBlocks` adds, for schema descriptions. */
export const blockRules =
  'ids are unique; the orders are a permutation of 0..n-1; page ≤ number of pages; the bbox lies inside its page (x1 ≤ width, y1 ≤ height)';

type Block = z.infer<z.ZodObject<typeof blockFields>>;

/** Adds an issue for every block that breaks `blockRules`. */
export function checkBlocks(
  document: { pages: { width: number; height: number }[]; blocks: Block[] },
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const orders = new Set<number>();
  document.blocks.forEach((block, i) => {
    const at = (key: string) => ['blocks', i, key];
    if (ids.has(block.id)) {
      ctx.addIssue({ code: 'custom', message: 'duplicate id', path: at('id') });
    }
    ids.add(block.id);
    if (block.order >= document.blocks.length || orders.has(block.order)) {
      ctx.addIssue({
        code: 'custom',
        message: 'orders must be a permutation of 0..n-1',
        path: at('order'),
      });
    }
    orders.add(block.order);
    const page = document.pages[block.page - 1];
    if (page === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'no such page',
        path: at('page'),
      });
    } else if (block.bbox[2] > page.width || block.bbox[3] > page.height) {
      ctx.addIssue({
        code: 'custom',
        message: 'bbox lies outside its page',
        path: at('bbox'),
      });
    }
  });
}
