import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type GroundTruth, gtSchema } from '@pdf-generator/contract';
import { chromium } from 'playwright-core';
import { beforeAll, expect, test } from 'vitest';
import { type Box, checkPdf, type Difference, readPdf } from './index.ts';

interface Fixture {
  pdf: Uint8Array;
  gt: GroundTruth;
}
const fixtures = new Map<string, Fixture>();
const ink = new Map<string, Box>();
const polyfill = fileURLToPath(
  new URL('../dist/paged.polyfill.js', import.meta.resolve('pagedjs')),
);

beforeAll(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const name of [
      'monthly-report',
      'incident-form',
      'blank-field',
      'image-text',
      'table-grid',
      'comparison',
    ]) {
      const root = name === 'comparison' ? '..' : '../../ground-truth';
      const base = new URL(`${root}/fixtures/${name}`, import.meta.url);
      const gt = gtSchema.parse(
        JSON.parse(await readFile(`${fileURLToPath(base)}.gt.json`, 'utf8')),
      );
      const page = await browser.newPage();
      try {
        await page.setContent(
          await readFile(`${fileURLToPath(base)}.html`, 'utf8'),
        );
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(`window.__pagedDone = false;
          window.PagedConfig = {
            auto: true,
            before: () => window.registerFixtureHandlers?.(),
            after: () => { window.__pagedDone = true; }
          };`);
        await page.addScriptTag({ path: polyfill });
        await page.waitForFunction('window.__pagedDone === true');
        await page.evaluate('document.fonts.ready');
        expect(await page.locator('.pagedjs_page').count()).toBe(
          gt.pages.length,
        );
        if (name === 'comparison') {
          // CSS spans give independent x extents; zero-height markers give
          // baselines. Never use readPdf to manufacture expected text boxes.
          const boxes: [string, Box][] = await page.evaluate(`(() => {
            return ['alpha', 'multi', 'beta'].map(id => {
              const element = document.querySelector('.pagedjs_pages #' + id);
              const paper = element.closest('.pagedjs_page').getBoundingClientRect();
              const spans = [...element.querySelectorAll('.ink')];
              const rects = spans.map(span => {
                const r = span.getBoundingClientRect();
                const baseline = span.nextElementSibling.getBoundingClientRect();
                const size = parseFloat(getComputedStyle(span).fontSize);
                return [(r.left - paper.left) * .75,
                  (baseline.top - paper.top - .7 * size) * .75,
                  (r.right - paper.left) * .75,
                  (baseline.top - paper.top) * .75];
              });
              return [id, [Math.min(...rects.map(r => r[0])),
                Math.min(...rects.map(r => r[1])),
                Math.max(...rects.map(r => r[2])),
                Math.max(...rects.map(r => r[3]))]];
            });
          })()`);
          for (const [id, box] of boxes) ink.set(id, box);
        }
        const pdf = await page.pdf({
          preferCSSPageSize: true,
          printBackground: true,
        });
        if (name === 'comparison') {
          // Fixture preconditions, not expected checkPdf results. A changed
          // Chrome text-run split must be identified as a setup problem.
          const document = await readPdf(pdf);
          expect(
            document.pages.map(page => page.items.map(item => item.text)),
          ).toEqual([
            ['Alpha', 'ONE', 'LEFT', 'RIGHT'],
            ['Beta', 'TWO'],
          ]);
        }
        fixtures.set(name, { gt, pdf });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

function fixture(name = 'comparison'): Fixture {
  const value = fixtures.get(name);
  if (!value) throw new Error(`fixture not printed: ${name}`);
  return value;
}
function mutate(change: (gt: GroundTruth) => void): GroundTruth {
  const gt = structuredClone(fixture().gt);
  change(gt);
  return gtSchema.parse(gt);
}
function block(gt: GroundTruth, id: string) {
  const value = gt.blocks.find(block => block.id === id);
  if (!value) throw new Error(`missing block: ${id}`);
  return value;
}
function boxOf(id: string): Box {
  const box = ink.get(id);
  if (!box) throw new Error(`missing ink: ${id}`);
  return box;
}
function closeBox(actual: Box, expected: Box) {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs((actual[i] ?? NaN) - (expected[i] ?? NaN))).toBeLessThan(1);
  }
}
async function differences(gt: GroundTruth): Promise<Difference[]> {
  const result = await checkPdf(fixture().pdf, gt);
  expect(result.ok).toBe(false);
  for (const difference of result.differences) {
    expect(difference.message).toEqual(expect.any(String));
    expect(difference.message.length).toBeGreaterThan(0);
  }
  // Wording is deliberately not part of the machine-readable contract.
  return result.differences.map(
    ({ message: _message, ...rest }) => rest,
  ) as Difference[];
}
async function expectBoxDifference(gt: GroundTruth, id: string) {
  const result = await differences(gt);
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({
    kind: 'bbox',
    page: block(gt, id).page,
    blockId: id,
    bbox: block(gt, id).bbox,
    textBox: expect.any(Array),
  });
  if (result[0]?.kind !== 'bbox') throw new Error('expected bbox');
  closeBox(result[0].textBox, boxOf(id));
}

// Acceptance first: real Paged.js documents and independent hand-written GT.
test.each([
  'monthly-report',
  'incident-form',
  'blank-field',
  'image-text',
  'table-grid',
  'comparison',
])(
  'correct %s passes without false text, box, page or order differences',
  async name => {
    const { pdf, gt } = fixture(name);
    expect(await checkPdf(pdf, gt)).toEqual({ ok: true, differences: [] });
  },
);

test('wrong text reports the original expected and raw printed text exactly once', async () => {
  const gt = mutate(gt => {
    block(gt, 'alpha').text = 'Incorrect';
  });
  expect(await differences(gt)).toEqual([
    {
      kind: 'text',
      page: 1,
      blockId: 'alpha',
      expected: 'Incorrect',
      actual: 'AlphaONE',
    },
  ]);
});

test('comparison folds NFKC, whitespace and case without changing printed text', async () => {
  const gt = mutate(gt => {
    block(gt, 'alpha').text = ' ＡＬＰＨＡ\t\nｏｎｅ ';
  });
  expect(await checkPdf(fixture().pdf, gt)).toEqual({
    ok: true,
    differences: [],
  });
});

test('a 30pt relocation consumes the contiguous multiline run and reports only bbox', async () => {
  const gt = mutate(gt => {
    // One line remains owned, the other becomes unclaimed: recovery must
    // consider both rather than searching only wholly unclaimed runs.
    block(gt, 'multi').bbox = [54, 132, 354, 180];
  });
  await expectBoxDifference(gt, 'multi');
});

test('a wholly displaced box recovers its text from unclaimed items', async () => {
  const gt = mutate(gt => {
    block(gt, 'multi').bbox = [54, 300, 354, 348];
  });
  await expectBoxDifference(gt, 'multi');
});

test('anchor ownership still detects a 5pt horizontal ink overflow', async () => {
  const gt = mutate(gt => {
    block(gt, 'alpha').bbox[0] += 5;
  });
  await expectBoxDifference(gt, 'alpha');
});

test('the 0.35em anchor belongs to a box even when baseline and 0.7em ink overflow it', async () => {
  const [x0, y0, x1, y1] = boxOf('alpha');
  const anchorY = (y0 + y1) / 2;
  const gt = mutate(gt => {
    block(gt, 'alpha').bbox = [x0, anchorY - 1, x1, anchorY + 1];
  });
  await expectBoxDifference(gt, 'alpha');
});

test('ink protruding by less than 1pt does not cause a bbox false positive', async () => {
  const [x0, y0, x1, y1] = boxOf('alpha');
  const gt = mutate(gt => {
    block(gt, 'alpha').bbox = [x0 + 0.4, y0 + 0.4, x1 - 0.4, y1 - 0.4];
  });
  expect(await checkPdf(fixture().pdf, gt)).toEqual({
    ok: true,
    differences: [],
  });
});

test('the smallest containing box owns text instead of an enclosing blank block', async () => {
  const gt = mutate(gt => {
    gt.blocks.push({
      id: 'outer',
      type: 'field',
      page: 1,
      bbox: [40, 40, 400, 85],
      order: 3,
      text: '',
    });
    block(gt, 'beta').order = 4;
  });
  expect(await checkPdf(fixture().pdf, gt)).toEqual({
    ok: true,
    differences: [],
  });
});

test('wrong page consumes the actual page text without cascading text or unmarked differences', async () => {
  const gt = mutate(gt => {
    // Empty box on page 2 avoids an equal-size ownership tie with Beta.
    block(gt, 'multi').page = 2;
  });
  expect(await differences(gt)).toEqual([
    { kind: 'page', page: 2, blockId: 'multi', actualPage: 1 },
  ]);
});

test('a wrong-page block overlapping a larger matching block reports only the page difference', async () => {
  const gt = mutate(gt => {
    const moved = block(gt, 'beta');
    moved.page = 1;
    // Alpha's box is [54, 54, 354, 78]. This smaller box contains
    // its text anchors, so area-only ownership would steal Alpha's text.
    moved.bbox = [54, 54, 204, 78];
  });
  expect(await differences(gt)).toEqual([
    { kind: 'page', page: 1, blockId: 'beta', actualPage: 2 },
  ]);
});

test('a missing multiline block yields one unmarked run with the union ink box', async () => {
  const gt = mutate(gt => {
    gt.blocks = gt.blocks.filter(block => block.id !== 'multi');
    gt.blocks.forEach((block, order) => {
      block.order = order;
    });
  });
  const result = await differences(gt);
  expect(result).toEqual([
    {
      kind: 'unmarked_text',
      page: 1,
      text: 'LEFTRIGHT',
      textBox: expect.any(Array),
    },
  ]);
  if (result[0]?.kind !== 'unmarked_text')
    throw new Error('expected unmarked_text');
  closeBox(result[0].textBox, boxOf('multi'));
});

test('consecutive unclaimed items coalesce despite a visual gap between blocks', async () => {
  const gt = mutate(gt => {
    gt.blocks = gt.blocks.filter(
      block => block.id !== 'alpha' && block.id !== 'multi',
    );
    gt.blocks.forEach((block, order) => {
      block.order = order;
    });
  });
  const result = await differences(gt);
  expect(result).toEqual([
    {
      kind: 'unmarked_text',
      page: 1,
      text: 'AlphaONELEFTRIGHT',
      textBox: expect.any(Array),
    },
  ]);
  if (result[0]?.kind !== 'unmarked_text')
    throw new Error('expected unmarked_text');
  const a = boxOf('alpha');
  const b = boxOf('multi');
  closeBox(result[0].textBox, [
    Math.min(a[0], b[0]),
    a[1],
    Math.max(a[2], b[2]),
    b[3],
  ]);
});

test('an extra nonempty block in blank space reports actual empty text', async () => {
  // An extra empty block cannot be revealed by the PDF's text layer.
  const gt = mutate(gt => {
    gt.blocks.push({
      id: 'extra',
      type: 'field',
      page: 1,
      bbox: [54, 300, 354, 324],
      order: 3,
      text: 'Invented field',
    });
    block(gt, 'beta').order = 4;
  });
  expect(await differences(gt)).toEqual([
    {
      kind: 'text',
      page: 1,
      blockId: 'extra',
      expected: 'Invented field',
      actual: '',
    },
  ]);
});

test('claimed text separates unmarked runs and preserves their stream order', async () => {
  const gt = mutate(gt => {
    gt.blocks = gt.blocks.filter(block => block.id !== 'alpha');
    const multi = block(gt, 'multi');
    multi.text = 'LEFT';
    multi.bbox[3] = 126;
    gt.blocks.forEach((block, order) => {
      block.order = order;
    });
  });
  const result = await differences(gt);
  expect(result).toEqual([
    {
      kind: 'unmarked_text',
      page: 1,
      text: 'AlphaONE',
      textBox: expect.any(Array),
    },
    {
      kind: 'unmarked_text',
      page: 1,
      text: 'RIGHT',
      textBox: expect.any(Array),
    },
  ]);
  const first = result[0];
  const second = result[1];
  if (first?.kind !== 'unmarked_text' || second?.kind !== 'unmarked_text') {
    throw new Error('expected two unmarked runs');
  }
  closeBox(first.textBox, boxOf('alpha'));
  const [x0, y0, x1, y1] = boxOf('multi');
  closeBox(second.textBox, [x0, y0 + 24, x1, y1]);
});

test('relocation cannot steal text already owned by a different block', async () => {
  const gt = mutate(gt => {
    block(gt, 'alpha').text = 'Alpha ONELEFT';
  });
  expect(await differences(gt)).toEqual([
    {
      kind: 'text',
      page: 1,
      blockId: 'alpha',
      expected: 'Alpha ONELEFT',
      actual: 'AlphaONE',
    },
  ]);
});

test('image blocks with printable text are compared instead of skipped', async () => {
  const gt = mutate(gt => {
    const a = block(gt, 'alpha');
    a.type = 'image';
    a.text = 'Wrong image text';
  });
  expect(await differences(gt)).toEqual([
    {
      kind: 'text',
      page: 1,
      blockId: 'alpha',
      expected: 'Wrong image text',
      actual: 'AlphaONE',
    },
  ]);
});

test('swapping orders across pages reports each block outside its actual page range', async () => {
  const gt = mutate(gt => {
    block(gt, 'alpha').order = 3;
    block(gt, 'beta').order = 0;
  });
  expect(await differences(gt)).toEqual([
    { kind: 'order', page: 1, blockId: 'alpha', order: 3 },
    { kind: 'order', page: 2, blockId: 'beta', order: 0 },
  ]);
});

test('swapping two orders within one page is allowed regardless of paint order', async () => {
  const gt = mutate(gt => {
    block(gt, 'alpha').order = 1;
    block(gt, 'multi').order = 0;
  });
  expect(await checkPdf(fixture().pdf, gt)).toEqual({
    ok: true,
    differences: [],
  });
});

test('an extra declared blank page reports one page_count difference', async () => {
  const gt = mutate(gt => {
    gt.pages.push({ width: 595.28, height: 841.89 });
  });
  expect(await differences(gt)).toEqual([
    { kind: 'page_count', expected: 3, actual: 2 },
  ]);
});

test.each(['width', 'height'] as const)(
  'a page %s error above 1pt reports expected and actual MediaBox sizes',
  async dimension => {
    const gt = mutate(gt => {
      const page = gt.pages[0];
      if (page) page[dimension] += 10;
    });
    const result = await differences(gt);
    expect(result).toEqual([
      {
        kind: 'page_size',
        page: 1,
        expected: [gt.pages[0]?.width, gt.pages[0]?.height],
        actual: expect.any(Array),
      },
    ]);
    if (result[0]?.kind !== 'page_size') throw new Error('expected page_size');
    expect(Math.abs(result[0].actual[0] - 594.96)).toBeLessThan(1);
    expect(Math.abs(result[0].actual[1] - 841.92)).toBeLessThan(1);
  },
);

test('combined failures are deterministic: document first, then page, reading order, unmarked runs', async () => {
  const gt = mutate(gt => {
    gt.pages.push({ width: 595.28, height: 841.89 });
    const page = gt.pages[0];
    if (page) page.width += 10;
    block(gt, 'alpha').text = 'Wrong alpha';
    block(gt, 'blank').text = 'Wrong blank';
    block(gt, 'alpha').order = 2;
    block(gt, 'blank').order = 0;
    block(gt, 'beta').text = 'Wrong beta';
    gt.blocks = gt.blocks.filter(block => block.id !== 'multi');
    block(gt, 'alpha').order = 1;
    block(gt, 'beta').order = 2;
    gt.blocks.reverse(); // Storage order must not control diagnostic order.
  });
  const first = await differences(gt);
  expect(first).toEqual([
    { kind: 'page_count', expected: 3, actual: 2 },
    {
      kind: 'page_size',
      page: 1,
      expected: [605.28, 841.89],
      actual: expect.any(Array),
    },
    {
      kind: 'text',
      page: 1,
      blockId: 'blank',
      expected: 'Wrong blank',
      actual: '',
    },
    {
      kind: 'text',
      page: 1,
      blockId: 'alpha',
      expected: 'Wrong alpha',
      actual: 'AlphaONE',
    },
    {
      kind: 'unmarked_text',
      page: 1,
      text: 'LEFTRIGHT',
      textBox: expect.any(Array),
    },
    {
      kind: 'text',
      page: 2,
      blockId: 'beta',
      expected: 'Wrong beta',
      actual: 'BetaTWO',
    },
  ]);
  expect(await differences(gt)).toEqual(first);
});
