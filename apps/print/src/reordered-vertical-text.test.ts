// T07-35: data-gt text that CSS lays out out of DOM order (flex `order`,
// `row-reverse`) or in vertical writing (`writing-mode: vertical-*`, every
// `text-orientation`) prints and passes the text check (missingText), and
// such text that is laid out but not printed is still refused. Nothing had
// to change for it: Chrome prints each flex item as its own PDF item inside
// its own box, and vertical text as upright glyphs stacked in reading order
// (one item per glyph) or as sideways runs that readPdf reports with a `dir`
// (T07-19). This file keeps it that way.
import { apiErrorSchema } from '@pdf-generator/contract';
import { type PdfTextItem, readPdf } from '@pdf-generator/self-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type PrintWorker, startPrintWorker } from './test-worker.ts';

const token = 'reordered-vertical-text-local-test';
let worker: PrintWorker;

beforeAll(async () => {
  worker = await startPrintWorker(token);
  await worker.url;
});

afterAll(async () => {
  await worker?.dispose();
});

function document(body: string) {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<style>
@page { size: A4; margin: 20mm; }
body { margin: 0; font: 16px/24px "Noto Sans TC"; }
.box { margin: 40px; }
.flex { display: flex; }
.reverse { display: flex; flex-direction: row-reverse; justify-content: flex-end; }
.v { writing-mode: vertical-rl; height: 10em; }
</style></head><body><p data-gt="paragraph">前文照常印出。</p>${body}</body></html>`;
}

async function print(html: string) {
  return fetch(new URL('/print', (await worker.url).href), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      html,
      page: { size: 'A4', orientation: 'portrait' },
    }),
  });
}

async function printed(body: string): Promise<PdfTextItem[]> {
  const response = await print(document(body));
  expect(response.status, await response.clone().text()).toBe(200);
  const { pages } = await readPdf(new Uint8Array(await response.arrayBuffer()));
  return pages[0]?.items ?? [];
}

// A direction rounded to whole units (no -0), for comparing.
const direction = (each: PdfTextItem) =>
  each.dir?.map(value => Math.round(value) + 0);

const item = (items: PdfTextItem[], text: string) => {
  const found = items.find(each => each.text === text);
  expect(found, `no PDF item "${text}"`).toBeDefined();
  return found as PdfTextItem;
};

test('prints flex items reversed by row-reverse, one block and two', async () => {
  const items = await printed(
    `<div class="box reverse" data-gt="paragraph"><span>甲乙丙</span><span>丁戊己</span></div>
     <div class="box reverse"><span data-gt="label">Meeting date:</span><span data-gt="field">2026-10-24</span></div>`,
  );
  // Laid out reversed: the later span prints to the left of the earlier one.
  expect(item(items, '丁戊己').x0).toBeLessThan(item(items, '甲乙丙').x0);
  expect(item(items, '2026-10-24').x0).toBeLessThan(
    item(items, 'Meeting date:').x0,
  );
});

test('prints flex items reordered by order', async () => {
  const items = await printed(
    `<div class="box flex" data-gt="paragraph"><span style="order:3">甲乙丙</span><span style="order:1">丁戊己</span><span style="order:2">庚辛壬</span></div>
     <div class="box flex"><span data-gt="field" style="order:2">2026-10-24</span><span data-gt="label" style="order:1">Meeting date:</span></div>`,
  );
  const x = (text: string) => item(items, text).x0;
  expect(x('丁戊己')).toBeLessThan(x('庚辛壬'));
  expect(x('庚辛壬')).toBeLessThan(x('甲乙丙'));
  expect(x('Meeting date:')).toBeLessThan(x('2026-10-24'));
});

test('prints vertical-rl text wrapped into columns', async () => {
  const items = await printed(
    `<div class="box v" style="height:4em"><p data-gt="paragraph">第一行文字第二行文字第三</p></div>`,
  );
  // Upright glyphs, one item each, in three columns from right to left.
  const columns = [
    ...new Set(
      items
        .filter(each => each.text !== '前文照常印出。')
        .map(each => Math.round(each.x0)),
    ),
  ];
  expect(columns).toHaveLength(3);
  expect(columns).toEqual([...columns].sort((a, b) => b - a));
});

test('prints vertical-rl text in neighbouring columns as separate blocks', async () => {
  await printed(
    `<div class="box v" style="height:6em"><p data-gt="paragraph">甲乙丙丁</p><p data-gt="paragraph">戊己庚辛</p></div>`,
  );
});

test.each([
  { orientation: 'mixed', sideways: ['2026', 'ABC'] },
  { orientation: 'upright', sideways: [] },
])(
  'prints vertical-rl text with Latin, text-orientation $orientation',
  async ({ orientation, sideways }) => {
    const items = await printed(
      `<div class="box v" style="text-orientation:${orientation}"><p data-gt="paragraph">公元2026年ABC號</p></div>`,
    );
    // mixed turns Latin runs sideways (a dir down the column); upright stacks
    // every letter as its own upright item.
    expect(
      items.filter(each => each.dir).map(each => [each.text, direction(each)]),
    ).toEqual(sideways.map(text => [text, [0, 1]]));
    expect(item(items, '公').baseline).toBeLessThan(item(items, '年').baseline);
  },
);

test('prints vertical-rl text with text-orientation sideways', async () => {
  const items = await printed(
    `<div class="box v" style="text-orientation:sideways"><p data-gt="paragraph">直書ABC</p></div>`,
  );
  expect(direction(item(items, '直書ABC'))).toEqual([0, 1]);
});

test('prints vertical-rl text with text-combine-upright and vertical-lr text', async () => {
  await printed(
    `<div class="box v"><p data-gt="paragraph">民國<span style="text-combine-upright:all">115</span>年</p></div>
     <div class="box" style="writing-mode:vertical-lr;height:10em"><p data-gt="paragraph">左起直書</p></div>`,
  );
});

// The control: reordered or vertical text that is laid out but not printed
// is still missing, and nothing else is.
test.each([
  {
    name: 'row-reverse',
    hidden: '藏起',
    body: `<div class="box reverse" data-gt="paragraph"><span>甲乙丙</span><span>印出<span style="visibility:hidden">藏起</span></span></div>`,
  },
  {
    name: 'order',
    hidden: '藏起',
    body: `<div class="box flex" data-gt="paragraph"><span style="order:2">甲乙丙</span><span style="order:1">印出<span style="visibility:hidden">藏起</span></span></div>`,
  },
  {
    name: 'vertical-rl',
    hidden: '藏起',
    body: `<div class="box v"><p data-gt="paragraph">直書印出<span style="visibility:hidden">藏起</span></p></div>`,
  },
  {
    name: 'vertical-rl mixed Latin',
    hidden: 'ABC',
    body: `<div class="box v" style="text-orientation:mixed"><p data-gt="paragraph">公元<span style="visibility:hidden">ABC</span>年</p></div>`,
  },
  {
    name: 'vertical-rl upright Latin',
    hidden: 'ABC',
    body: `<div class="box v" style="text-orientation:upright"><p data-gt="paragraph">公元<span style="visibility:hidden">ABC</span>年</p></div>`,
  },
])(
  'refuses unprinted $name data-gt text as text_missing',
  async ({ hidden, body }) => {
    const response = await print(document(body));
    expect(
      response.status,
      response.status === 200
        ? 'unexpected PDF success: unprinted text was not missed'
        : await response.clone().text(),
    ).toBe(422);
    const { error } = apiErrorSchema.parse(await response.json());
    expect(error.code).toBe('text_missing');
    expect(error.details?.map(each => each.message)).toEqual([
      `page 1: ${hidden}`,
    ]);
  },
);
