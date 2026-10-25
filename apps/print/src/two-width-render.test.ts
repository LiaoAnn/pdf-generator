import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

type Size = { width: number; height: number };
const floor = { width: 793, height: 1122 };
const ceil = { width: 794, height: 1123 };
const stable = ['1 72,72,112,112', '2 72,72,112,112'];

function fakeBrowser(
  options: {
    pageSize?: Size;
    pagination?: string[];
    boxes?: (medium: string, viewport: Size) => string[] | undefined;
  } = {},
) {
  let medium = 'screen';
  let viewport = { width: 800, height: 600 };
  const reads: { medium: string; viewport: Size; afterPdf: boolean }[] = [];
  let afterPdf = false;
  const sample = () => {
    reads.push({ medium, viewport: { ...viewport }, afterPdf });
    const boxes = options.boxes ? options.boxes(medium, viewport) : [...stable];
    return boxes === undefined ? {} : { boxes };
  };
  const page = {
    ...fakeFetch(),
    viewport: vi.fn(() => ({ ...viewport })),
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(
      async (fn: unknown, pageWidth?: number): Promise<unknown> => {
        const expression = String(fn);
        if (expression.includes('.ready')) {
          return {
            pageCount: 3,
            pageSize: options.pageSize ?? { width: 793.7, height: 1122.5 },
            unloadedFaces: [],
            boxes: options.pagination ?? [...stable],
          };
        }
        if (pageWidth !== undefined || expression.includes('.boxes('))
          return sample();
        // Permit reading the actual pagination viewport through evaluate as well
        // as through puppeteer's viewport(); neither reports the page size.
        return {
          ...viewport,
          innerWidth: viewport.width,
          innerHeight: viewport.height,
        };
      },
    ),
    pdf: vi.fn(async () => {
      afterPdf = true;
      return new Uint8Array(
        readFileSync(
          new URL('./test-fixtures/blank-3-pages.pdf', import.meta.url),
        ),
      );
    }),
    close: vi.fn(async () => {}),
  };
  page.emulateMediaType.mockImplementation(async type => {
    medium = type ?? 'screen';
  });
  page.setViewport.mockImplementation(async value => {
    viewport = { ...value };
  });
  const context = fakeBrowserContext(page);
  const inspect = vi.fn(async () => ({ medium, viewport }));
  const run = () =>
    renderPdf(
      context.browser,
      {
        html: '<!doctype html><p data-gt="paragraph">PACK</p>',
        page: {
          size: 'A4',
          orientation: 'portrait',
        },
      },
      {
        assetOrigin: 'https://print-assets.example.test',
        store: { put: async () => {}, delete: async () => {} },
        inspect,
      },
    );
  return { ...context, page, reads, inspect, run };
}

test.each([
  {
    name: 'a later-page box moves',
    changed: [stable[0] ?? '', '2 73,72,113,112'],
  },
  { name: 'a box changes page', changed: [stable[0] ?? '', '3 72,72,112,112'] },
  { name: 'a box disappears', changed: stable.slice(0, 1) },
  { name: 'a box appears', changed: [...stable, '3 72,72,112,112'] },
])(
  'print bracket rejects when $name, before PDF and GT, with changed boxes in diagnostics',
  async ({ changed }) => {
    const fake = fakeBrowser({
      boxes: (medium, viewport) =>
        medium === 'print' && viewport.width === ceil.width
          ? changed
          : [...stable],
    });
    const error = await fake.run().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RenderError);
    expect(error).toMatchObject({ code: 'viewport_dependent' });
    const details = (error as RenderError).details.join('\n');
    expect(details).toContain('print media');
    expect(details).toContain('793x1122');
    expect(details).toContain('794x1123');
    for (const box of stable.filter(box => !changed.includes(box)))
      expect(details).toContain(box);
    for (const box of changed.filter(box => !stable.includes(box)))
      expect(details).toContain(box);
    expect(fake.page.pdf).not.toHaveBeenCalled();
    expect(fake.inspect).not.toHaveBeenCalled();
    expect(fake.page.close).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  },
);

test('pagination bracket compares ready screen boxes with screen boxes at the page floor', async () => {
  const changed = ['1 172,72,212,112', stable[1] ?? ''];
  const fake = fakeBrowser({ pagination: changed });
  const error = await fake.run().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(RenderError);
  expect(error).toMatchObject({ code: 'viewport_dependent' });
  const details = (error as RenderError).details.join('\n');
  expect(details).toContain('pagination');
  expect(details).toContain('800x600');
  expect(details).toContain('793x1122');
  expect(details).toContain(changed[0]);
  expect(details).toContain(stable[0]);
  expect(fake.reads).toContainEqual({
    medium: 'screen',
    viewport: floor,
    afterPdf: false,
  });
  expect(fake.page.pdf).not.toHaveBeenCalled();
  expect(fake.inspect).not.toHaveBeenCalled();
  expect(fake.page.close).toHaveBeenCalledTimes(1);
});

test('equal box values at both brackets pass and the floor viewport is restored for PDF and GT', async () => {
  const fake = fakeBrowser();
  fake.page.pdf.mockImplementation(async () => {
    // The floor restoration must precede printing, not merely inspection.
    expect(fake.page.viewport()).toEqual(floor);
    return new Uint8Array(
      readFileSync(
        new URL('./test-fixtures/blank-3-pages.pdf', import.meta.url),
      ),
    );
  });
  const result = await fake.run();
  expect(fake.reads).toEqual(
    expect.arrayContaining([
      { medium: 'screen', viewport: floor, afterPdf: false },
      { medium: 'print', viewport: floor, afterPdf: false },
      { medium: 'print', viewport: ceil, afterPdf: false },
    ]),
  );
  expect(result.inspected).toEqual({ medium: 'print', viewport: floor });
  expect(fake.page.pdf).toHaveBeenCalledTimes(1);
});

test('whole-pixel Letter pages skip the second print sample while retaining the pagination sample', async () => {
  const letter = { width: 816, height: 1056 };
  const fake = fakeBrowser({ pageSize: letter });
  await fake.run();
  expect(fake.reads.filter(read => read.medium === 'screen')).toEqual([
    { medium: 'screen', viewport: letter, afterPdf: false },
  ]);
  // One print read before PDF; no redundant ceil sample at the same size.
  expect(
    fake.reads.filter(read => read.medium === 'print' && !read.afterPdf),
  ).toHaveLength(1);
  expect(fake.page.setViewport).not.toHaveBeenCalledWith({
    width: 817,
    height: 1057,
  });
});

test.each(['screen', 'print'])(
  'a missing boxes array on the %s side skips that bracket for older runtime fakes',
  async missing => {
    const fake = fakeBrowser({
      boxes: (medium, viewport) => {
        if (
          medium === missing &&
          (medium === 'screen' || viewport.width === ceil.width)
        )
          return undefined;
        return [...stable];
      },
    });
    await expect(fake.run()).resolves.toHaveProperty('pageCount', 3);
    expect(fake.inspect).toHaveBeenCalledTimes(1);
    // Make this compatibility test fail if the bracket is simply absent.
    expect(fake.reads).toContainEqual({
      medium: missing,
      viewport: missing === 'screen' ? floor : ceil,
      afterPdf: false,
    });
  },
);
