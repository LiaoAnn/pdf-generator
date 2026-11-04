// T08-9: Chrome skips the contents of a content-visibility: auto element
// away from the viewport (page 2 onwards of a paginated document): innerText
// leaves out their text and layout gives them their skipped size (zero, or
// contain-intrinsic-size), which also moves every box after them. Printing
// lays all of it out and prints it. Probed on local Chromium (printed PDF,
// pages 1–3, ~/drafts/t08-9-content-visibility-auto/probe/): gt.json lost
// the text ("可見文字戊" where the PDF has "可見文字戊隱藏文字己") and the
// boxes after it, or failed outright on a skipped block of zero height. The
// printed layout of an auto element is that of an element with layout, style
// and paint containment, so a document with `contain: layout style paint` in
// place of `content-visibility: auto` is the control: it is read the same on
// every page and prints the same.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readGroundTruth } from './index.ts';

const source: GroundTruth['source'] = {
  templateId: 'content-visibility-auto',
  templateVersion: 1,
  seed: 'T08-9',
  index: 0,
};
const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await run(page);
  } finally {
    await page.close();
  }
}

// Every structure the probe found read differently from the PDF, on page
// `n`: text in an inline-block auto box inside a block, a block inside an
// auto ancestor, an auto block itself, an auto ancestor whose
// contain-intrinsic-size differs from its content, a block holding an auto
// descendant, an auto ancestor under user-select: none, nested auto
// ancestors, and a plain block after them all (moved by their sizes).
const structures = (n: number) => `
  <p data-gt="paragraph" id="part-${n}">可見文字戊<span class="cv ib">隱藏文字己${n}</span></p>
  <div class="cv"><p data-gt="paragraph" id="anc-${n}">祖先段落丙${n}</p></div>
  <p data-gt="paragraph" class="cv" id="self-${n}">自身段落丁${n}</p>
  <div class="cv cis"><p data-gt="paragraph" id="cis-${n}">尺寸段落戊${n}<br>第二行${n}</p></div>
  <div data-gt="paragraph" id="desc-${n}">外層文字${n}<div class="cv">內層文字${n}</div></div>
  <div class="unselectable"><div class="cv"><p data-gt="paragraph" id="us-${n}">選取無效${n}</p></div></div>
  <div class="cv"><div class="cv"><p data-gt="paragraph" id="nest-${n}">巢狀段落${n}</p></div></div>
  <p data-gt="paragraph" id="after-${n}">後續標記${n}</p>`;

// `cv` is the declaration every `.cv` element gets. Pages 2 and 3 start
// below the 1280x720 viewport.
async function paginate(page: Page, cv: string): Promise<void> {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 60pt 48pt; }
    html, body { margin: 0; padding: 0; }
    body { font: 10pt/12pt sans-serif; }
    p, div { margin: 0 0 6pt; }
    .cv { ${cv} }
    .ib { display: inline-block; }
    .cis { contain-intrinsic-size: auto 40pt; }
    .unselectable { user-select: none; }
    .next { break-before: page; }
    </style></head><body>
    <p data-gt="title" id="title">內容可見性標題</p>
    <section>${structures(1)}</section>
    <section class="next">${structures(2)}</section>
    <section class="next">${structures(3)}</section>
    </body></html>`);
  await page.evaluate(`window.__pagedDone = false;
    window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };`);
  await page.addScriptTag({ path: polyfill });
  await page.waitForFunction('window.__pagedDone === true');
}

async function read(page: Page): Promise<GroundTruth> {
  const result = await readGroundTruth(page, source);
  expect(gtSchema.parse(result)).toEqual(result);
  return result;
}

const innerText = (page: Page, id: string) =>
  page.evaluate(
    `document.querySelector('.pagedjs_page #${id}')?.innerText ?? null`,
  );

const auto = 'content-visibility: auto;';
const contained = 'contain: layout style paint;';

test('off-screen content-visibility: auto content on pages 2 and 3 is read with the text and boxes it prints', async () => {
  let control: GroundTruth | undefined;
  await withPage(async page => {
    await paginate(page, contained);
    control = await read(page);
  });
  await withPage(async page => {
    await paginate(page, auto);
    // The case under test: Chrome skips these right now.
    expect(await innerText(page, 'anc-2')).toBe('');
    expect(await innerText(page, 'part-3')).toBe('可見文字戊');
    const result = await read(page);
    const texts = result.blocks.map(block => `${block.page} ${block.text}`);
    for (const n of [1, 2, 3]) {
      expect(texts).toContain(`${n} 可見文字戊隱藏文字己${n}`);
      expect(texts).toContain(`${n} 祖先段落丙${n}`);
      expect(texts).toContain(`${n} 自身段落丁${n}`);
      expect(texts).toContain(`${n} 尺寸段落戊${n}\n第二行${n}`);
      expect(texts).toContain(`${n} 外層文字${n}\n內層文字${n}`);
      expect(texts).toContain(`${n} 選取無效${n}`);
      expect(texts).toContain(`${n} 巢狀段落${n}`);
    }
    // Every block, its text, page, box and order, as the control prints.
    expect(result.blocks).toEqual(control?.blocks);
  });
});

test('reading restores the selection it found, and an empty one stays empty', async () => {
  await withPage(async page => {
    await paginate(page, auto);
    // A backward selection inside the title's text.
    await page.evaluate(`(() => {
      const text = document.querySelector('.pagedjs_page #title').firstChild;
      getSelection().setBaseAndExtent(text, 4, text, 1);
    })()`);
    const selection = `(() => {
      const s = getSelection();
      return [s.rangeCount, s.anchorNode?.textContent, s.anchorOffset,
        s.focusNode?.textContent, s.focusOffset, s.toString(),
        s.anchorNode === document.querySelector('.pagedjs_page #title').firstChild];
    })()`;
    const before = await page.evaluate(selection);
    expect(before).toEqual([
      1,
      '內容可見性標題',
      4,
      '內容可見性標題',
      1,
      '容可見',
      true,
    ]);
    await read(page);
    expect(await page.evaluate(selection)).toEqual(before);
    // Still skipped once reading is done, as before it.
    expect(await innerText(page, 'anc-2')).toBe('');
  });
  await withPage(async page => {
    await paginate(page, auto);
    await read(page);
    expect(await page.evaluate('getSelection().rangeCount')).toBe(0);
    expect(await innerText(page, 'anc-2')).toBe('');
  });
});

test('reading content-visibility: auto content does not change what prints', async () => {
  await withPage(async page => {
    await paginate(page, auto);
    const print = async () => {
      const pdf = Buffer.from(
        await page.pdf({ preferCSSPageSize: true, printBackground: true }),
      )
        .toString('latin1')
        .replace(/\/(?:CreationDate|ModDate) \(D:[^)]*\)/g, '');
      return createHash('sha256').update(pdf, 'latin1').digest('hex');
    };
    const before = await print();
    await read(page);
    expect(await print()).toBe(before);
  });
});
