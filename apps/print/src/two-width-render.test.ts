import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { fakeBrowserContext, fakeFetch } from './fake-fetch.ts';
import { RenderError, renderPdf } from './lib.ts';

type Size = { width: number; height: number };
const floor = { width: 793, height: 1122 };
const ceil = { width: 794, height: 1123 };
const mixedCorners = [
  { width: 794, height: 1122 },
  { width: 793, height: 1123 },
];
const stable = ['1 72,72,112,112', '2 72,72,112,112'];

function fakeBrowser(
  options: {
    pageSize?: Size;
    pagination?: string[];
    boxes?: (medium: string, viewport: Size) => string[] | undefined;
    movedBoxes?: (medium: string, viewport: Size) => string[];
    animations?: (medium: string, viewport: Size) => string[];
    viewportDependent?: (medium: string, viewport: Size) => string[];
  } = {},
) {
  let medium = 'screen';
  let viewport = { width: 800, height: 600 };
  const reads: { medium: string; viewport: Size; afterPdf: boolean }[] = [];
  const boxReads: typeof reads = [];
  let afterPdf = false;
  const sample = (isBoxes: boolean) => {
    reads.push({ medium, viewport: { ...viewport }, afterPdf });
    if (isBoxes) boxReads.push({ medium, viewport: { ...viewport }, afterPdf });
    const boxes = options.boxes ? options.boxes(medium, viewport) : [...stable];
    return {
      ...(boxes === undefined ? {} : { boxes }),
      ...(options.movedBoxes
        ? { movedBoxes: options.movedBoxes(medium, viewport) }
        : {}),
      ...(options.animations
        ? { animations: options.animations(medium, viewport) }
        : {}),
      ...(options.viewportDependent
        ? { viewportDependent: options.viewportDependent(medium, viewport) }
        : {}),
    };
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
          return sample(expression.includes('.boxes('));
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
  return { ...context, page, reads, boxReads, inspect, run };
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

test('ceil-only moved page diagnostics reject before PDF and GT despite identical page-relative boxes', async () => {
  const movedBoxes = [
    'page 1 .pagedjs_page transform: matrix(1, 0, 0, 1, -40, 0)',
  ];
  const fake = fakeBrowser({
    movedBoxes: (medium, viewport) =>
      medium === 'print' &&
      viewport.width === ceil.width &&
      viewport.height === ceil.height
        ? movedBoxes
        : [],
  });
  const error = await fake.run().catch((error: unknown) => error);
  expect.soft(error).toBeInstanceOf(RenderError);
  expect
    .soft(error)
    .toMatchObject({ code: 'page_box_moved', details: movedBoxes });
  expect(fake.reads).toContainEqual({
    medium: 'print',
    viewport: ceil,
    afterPdf: false,
  });
  expect.soft(fake.page.pdf).not.toHaveBeenCalled();
  expect.soft(fake.inspect).not.toHaveBeenCalled();
  expect(fake.page.close).toHaveBeenCalledTimes(1);
  expect(fake.context.close).toHaveBeenCalledTimes(1);
});

test.each(mixedCorners)(
  'print bracket compares mixed corner $width x $height boxes entry by entry with the floor',
  async corner => {
    // Swapping entries preserves the multiset, but changes each block's box.
    const changed = [...stable].reverse();
    const fake = fakeBrowser({
      boxes: (medium, viewport) =>
        medium === 'print' &&
        viewport.width === corner.width &&
        viewport.height === corner.height
          ? changed
          : [...stable],
    });
    const error = await fake.run().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RenderError);
    expect(error).toMatchObject({ code: 'viewport_dependent' });
    const details = (error as RenderError).details.join('\n');
    expect(details).toContain('print media');
    expect(details).toContain('793x1122');
    expect(details).toContain(`${corner.width}x${corner.height}`);
    for (const box of stable) expect(details).toContain(box);
    expect(fake.page.pdf).not.toHaveBeenCalled();
    expect(fake.inspect).not.toHaveBeenCalled();
    expect(fake.page.close).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  },
);

test.each(mixedCorners)(
  'mixed corner $width x $height retains the moved-page guard with identical relative boxes',
  async corner => {
    const movedBoxes = [
      'page 1 .pagedjs_page transform: matrix(1, 0, 0, 1, -40, 0)',
    ];
    const fake = fakeBrowser({
      movedBoxes: (medium, viewport) =>
        medium === 'print' &&
        viewport.width === corner.width &&
        viewport.height === corner.height
          ? movedBoxes
          : [],
    });
    const error = await fake.run().catch((error: unknown) => error);
    expect.soft(error).toBeInstanceOf(RenderError);
    expect
      .soft(error)
      .toMatchObject({ code: 'page_box_moved', details: movedBoxes });
    expect.soft(fake.page.pdf).not.toHaveBeenCalled();
    expect.soft(fake.inspect).not.toHaveBeenCalled();
    expect(fake.page.close).toHaveBeenCalledTimes(1);
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  },
);

test.each(
  mixedCorners.flatMap(corner => [
    { ...corner, guard: 'animations' as const, code: 'css_animation' },
    {
      ...corner,
      guard: 'viewportDependent' as const,
      code: 'viewport_dependent',
    },
  ]),
)(
  'mixed corner $width x $height retains the $guard guard with identical boxes',
  async ({ width, height, guard, code }) => {
    const details = [
      guard === 'animations'
        ? 'page 1 div.target::before: animation-name: move'
        : 'page 1 div.target::before: position: fixed',
    ];
    const fake = fakeBrowser({
      [guard]: (medium: string, viewport: Size) =>
        medium === 'print' &&
        viewport.width === width &&
        viewport.height === height
          ? details
          : [],
    });
    const error = await fake.run().catch((error: unknown) => error);
    expect.soft(error).toBeInstanceOf(RenderError);
    expect.soft(error).toMatchObject({ code, details });
    expect.soft(fake.page.pdf).not.toHaveBeenCalled();
    expect.soft(fake.inspect).not.toHaveBeenCalled();
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

test('whole-pixel width with fractional height samples only the two distinct height corners', async () => {
  const fake = fakeBrowser({ pageSize: { width: 793, height: 1122.5 } });
  await fake.run();
  expect(
    fake.boxReads
      .filter(read => read.medium === 'print' && !read.afterPdf)
      .map(read => read.viewport),
  ).toEqual([floor, { width: 793, height: 1123 }]);
  expect(fake.reads.filter(read => read.medium === 'screen')).toEqual([
    { medium: 'screen', viewport: floor, afterPdf: false },
  ]);
  expect(fake.page.viewport()).toEqual(floor);
  expect(fake.inspect).toHaveBeenCalledTimes(1);
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
