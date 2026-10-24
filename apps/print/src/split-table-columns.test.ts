import { URL } from 'node:url';
import { type GtBlock, gtSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'split-table-columns-local-test-token';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

const cases = [
  {
    name: 'keeps 40/10/20/30 column x ranges on every continued page',
    columns: `<colgroup>
      <col style="width:40%"><col style="width:10%">
      <col style="width:20%"><col style="width:30%">
    </colgroup>`,
    proportions: [0.4, 0.1, 0.2, 0.3],
    caption: '',
    extraHeader: '',
    headers: ['H0', 'H1', 'H2', 'H3'],
  },
  {
    name: 'keeps all colgroups and spanned columns with a caption and repeated two-row header',
    // Catches restoring only the first colgroup, dropping a col span, or
    // inserting column definitions in the wrong place around caption/thead.
    columns: `<colgroup><col span="2" style="width:15%"></colgroup>
      <colgroup><col style="width:25%"><col style="width:45%"></colgroup>`,
    proportions: [0.15, 0.15, 0.25, 0.45],
    caption: '<caption>Column report</caption>',
    extraHeader: '<tr><th colspan="2">LEFT</th><th colspan="2">RIGHT</th></tr>',
    headers: ['LEFT', 'RIGHT', 'H0', 'H1', 'H2', 'H3'],
  },
];

test.for(cases)('POST /print $name', async fixture => {
  const rows = Array.from({ length: 28 }, (_, row) =>
    Array.from({ length: 4 }, (_, col) => `R${row}C${col}`),
  );
  const response = await fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
        <style>
          @page { margin: 20mm; }
          body { margin: 0; font: 12px "Noto Sans TC", sans-serif; }
          table { width: 100%; table-layout: fixed; border-collapse: collapse; }
          th, td { border: 1px solid; padding: 1mm; }
          td { height: 22mm; }
        </style></head><body><table data-gt="table">
        ${fixture.caption}${fixture.columns}
        <thead>${fixture.extraHeader}<tr>
          <th>H0</th><th>H1</th><th>H2</th><th>H3</th>
        </tr></thead><tbody>
        ${rows.map(cells => `<tr>${cells.map(text => `<td>${text}</td>`).join('')}</tr>`).join('')}
        </tbody></table></body></html>`,
      page: { size: 'A4', orientation: 'portrait' },
      source: {
        templateId: 'split-table-columns',
        templateVersion: 1,
        seed: 'column-width-regression',
        index: 0,
      },
    }),
  });
  expect(
    response.status,
    response.status === 200 ? '' : await response.text(),
  ).toBe(200);
  const body = (await response.json()) as { gt: unknown; pageCount: number };
  const gt = gtSchema.parse(body.gt);
  const tables = gt.blocks.filter(
    (block): block is Extract<GtBlock, { type: 'table' }> =>
      block.type === 'table',
  );
  expect(tables.length).toBeGreaterThanOrEqual(3);
  expect(tables.map(table => table.page)).toEqual(
    Array.from({ length: body.pageCount }, (_, i) => i + 1),
  );

  for (const table of tables) {
    expect(table.table.cols).toBe(4);
    expect(
      table.table.cells.filter(cell => cell.header).map(cell => cell.text),
      `full header on page ${table.page}`,
    ).toEqual(fixture.headers);
  }
  // Each complete body row must occur once on one fragment, even after
  // adding column definitions changes pagination and available row space.
  for (const row of rows) {
    const locations = row.map(text => {
      const matches = tables.flatMap(table =>
        table.table.cells
          .filter(cell => !cell.header && cell.text === text)
          .map(cell => ({ page: table.page, row: cell.row })),
      );
      expect(matches, text).toHaveLength(1);
      return matches[0];
    });
    expect(locations).toEqual(Array(4).fill(locations[0]));
  }

  const first = tables[0];
  expect(first).toBeDefined();
  if (!first) return;
  const firstRow = first.table.cells.filter(
    cell =>
      !cell.header && cell.row === first.table.cells.find(c => !c.header)?.row,
  );
  expect(firstRow).toHaveLength(4);
  const left = Math.min(...firstRow.map(cell => cell.bbox[0]));
  const right = Math.max(...firstRow.map(cell => cell.bbox[2]));
  const boundaries = [left];
  for (const proportion of fixture.proportions) {
    boundaries.push((boundaries.at(-1) ?? left) + (right - left) * proportion);
  }

  const firstBoundaries: number[] = [];
  for (const cell of firstRow) {
    firstBoundaries[cell.col] = cell.bbox[0];
    firstBoundaries[cell.col + cell.colSpan] = cell.bbox[2];
  }
  // Independently check page 1 against the requested proportions, so a
  // regression that makes every page equally spaced cannot pass.
  for (const [column, expected] of boundaries.entries()) {
    expect(
      Math.abs((firstBoundaries[column] ?? Number.NaN) - expected),
      `page 1 column boundary ${column} matches declared proportions`,
    ).toBeLessThanOrEqual(1);
  }

  const mismatches: string[] = [];
  for (const table of tables) {
    for (const cell of table.table.cells) {
      // colSpan also checks the full x range of grouped header cells.
      for (const [edge, column] of [
        [0, cell.col],
        [2, cell.col + cell.colSpan],
      ] as const) {
        const expected = firstBoundaries[column];
        expect(expected).toBeDefined();
        if (
          expected !== undefined &&
          Math.abs(cell.bbox[edge] - expected) > 1
        ) {
          mismatches.push(
            `page ${table.page} ${cell.text} x${edge}: ${cell.bbox[edge]} expected ${expected.toFixed(2)}`,
          );
        }
      }
    }
  }
  expect(
    mismatches.slice(0, 8),
    'cell x ranges must match page 1 within 1 pt on every page',
  ).toEqual([]);
});
